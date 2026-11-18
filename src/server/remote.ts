import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HttpError, readBody, type Req, type Res } from './http';

/**
 * Signing in to a Luna dashboard: OAuth 2.0 authorization code with PKCE
 * (RFC 7636). The browser goes to the dashboard's `/studio/authorize`,
 * the developer signs in there and allows the studio, the dashboard sends
 * the browser back to this server's callback with a code, and the code is
 * exchanged here for a token. The token stays in this process and in the
 * credentials file; the browser never sees it: the editor's calls go
 * through `proxy()`, which adds it.
 *
 * Dashboard endpoints (luna-dashboard, app/studio):
 *   GET  /studio/authorize?response_type=code&client_id&redirect_uri&state&code_challenge&code_challenge_method=S256&name
 *   POST /studio/token   {grant_type: authorization_code, code, code_verifier, redirect_uri} → {access_token, expires_in, developer}
 *   POST /studio/revoke  (Bearer) — signs this token out
 *   GET  /studio/v1/me, /studio/v1/apps
 *   ANY  /studio/v1/apps/{app}/pages/api/{path...}, /studio/v1/apps/{app}/files/api/{path...}
 */

export interface Account {
  url: string;
  token: string;
  developer: { name?: string; email?: string };
  created_at: string;
  expires_at?: string | null;
}

interface Credentials {
  accounts: Account[];
  /** The dashboard last used. */
  current?: string;
}

export const CLIENT_ID = 'luna-studio';

const b64url = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** A dashboard URL as given: https unless it is a local address; no trailing slash. */
export function normalizeDashboard(raw: string): string {
  let s = String(raw || '').trim();
  if (!s) throw new HttpError(422, 'Enter the dashboard address.');
  if (!/^https?:\/\//i.test(s)) s = (/^(localhost|127\.|\[::1\])/i.test(s) ? 'http://' : 'https://') + s;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new HttpError(422, 'Not an address.');
  }
  if (u.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) {
    throw new HttpError(422, 'Use https (plain http only for localhost).');
  }
  return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`;
}

export class Remote {
  private creds: Credentials = { accounts: [] };
  private pending = new Map<string, { url: string; verifier: string; redirect: string; at: number; back: string }>();
  private loaded = false;

  constructor(
    /** Where the token is kept (`~/.luna-studio/credentials.json`). */
    readonly file = path.join(os.homedir(), '.luna-studio', 'credentials.json'),
    private readonly fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis)
  ) {}

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const c = JSON.parse(await fs.readFile(this.file, 'utf8')) as Credentials;
      if (Array.isArray(c.accounts)) this.creds = c;
    } catch {
      /* none yet */
    }
  }

  private async save(): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(this.file, JSON.stringify(this.creds, null, 2) + '\n', { mode: 0o600 });
  }

  async account(url?: string): Promise<Account | undefined> {
    await this.load();
    const u = url || this.creds.current;
    const a = this.creds.accounts.find((x) => x.url === u);
    if (a?.expires_at && Date.parse(a.expires_at) < Date.now()) return undefined;
    return a;
  }

  async accounts(): Promise<Account[]> {
    await this.load();
    return this.creds.accounts;
  }

  /** Starts a sign-in: the address to send the browser to. */
  async begin(dashboard: string, origin: string, back = '/'): Promise<string> {
    const url = normalizeDashboard(dashboard);
    const verifier = b64url(randomBytes(32));
    const challenge = b64url(createHash('sha256').update(verifier).digest());
    const state = b64url(randomBytes(16));
    const redirect = `${origin.replace(/\/+$/, '')}/studio/auth/callback`;
    // Old attempts expire after 10 minutes.
    for (const [k, v] of this.pending) if (Date.now() - v.at > 600_000) this.pending.delete(k);
    this.pending.set(state, { url, verifier, redirect, at: Date.now(), back });
    const q = new URLSearchParams({
      response_type: 'code',
      client_id: CLIENT_ID,
      redirect_uri: redirect,
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      name: `Luna Studio (${os.hostname()})`,
    });
    return `${url}/studio/authorize?${q}`;
  }

  /** The callback: exchanges the code; returns where to send the browser. */
  async finish(params: URLSearchParams): Promise<string> {
    const state = params.get('state') || '';
    const p = this.pending.get(state);
    if (!p) throw new HttpError(400, 'This sign-in expired or was not started here. Try again.');
    this.pending.delete(state);
    if (params.get('error')) throw new HttpError(403, params.get('error_description') || 'The dashboard did not allow the sign-in.');
    const code = params.get('code');
    if (!code) throw new HttpError(400, 'No code from the dashboard.');
    const r = await this.fetchImpl(`${p.url}/studio/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ grant_type: 'authorization_code', code, code_verifier: p.verifier, redirect_uri: p.redirect, client_id: CLIENT_ID }),
    });
    const body = (await r.json().catch(() => ({}))) as any;
    if (!r.ok || !body.access_token) throw new HttpError(502, body.error_description || body.error || `The dashboard answered ${r.status}.`);
    await this.load();
    const acc: Account = {
      url: p.url,
      token: body.access_token,
      developer: body.developer || {},
      created_at: new Date().toISOString(),
      expires_at: body.expires_in ? new Date(Date.now() + Number(body.expires_in) * 1000).toISOString() : null,
    };
    this.creds.accounts = [...this.creds.accounts.filter((a) => a.url !== p.url), acc];
    this.creds.current = p.url;
    await this.save();
    return p.back || '/';
  }

  /** Signs out: the dashboard revokes the token, this file forgets it. */
  async signOut(url?: string): Promise<void> {
    const a = await this.account(url);
    if (!a) return;
    await this.fetchImpl(`${a.url}/studio/revoke`, { method: 'POST', headers: { Authorization: `Bearer ${a.token}` } }).catch(() => undefined);
    this.creds.accounts = this.creds.accounts.filter((x) => x.url !== a.url);
    if (this.creds.current === a.url) this.creds.current = this.creds.accounts[0]?.url;
    await this.save();
  }

  async use(url: string): Promise<void> {
    await this.load();
    if (!this.creds.accounts.some((a) => a.url === url)) throw new HttpError(404, 'Not signed in there.');
    this.creds.current = url;
    await this.save();
  }

  /** A JSON call to the dashboard's studio API with the token. */
  async call<T>(pathname: string, url?: string): Promise<T> {
    const a = await this.account(url);
    if (!a) throw new HttpError(401, 'Sign in to a Luna dashboard first.');
    const r = await this.fetchImpl(`${a.url}${pathname}`, { headers: { Authorization: `Bearer ${a.token}`, Accept: 'application/json' } });
    if (r.status === 401) {
      // Revoked or expired there: forget it here.
      this.creds.accounts = this.creds.accounts.filter((x) => x.url !== a.url);
      await this.save();
      throw new HttpError(401, 'The dashboard signed this studio out. Sign in again.');
    }
    const body = (await r.json().catch(() => ({}))) as any;
    if (!r.ok) throw new HttpError(r.status, body.error || `The dashboard answered ${r.status}.`);
    return body as T;
  }

  /**
   * Forwards an editor call to the dashboard: `service` is `pages` or
   * `files`, `rest` the path after `/api`. Bodies are passed through as
   * bytes (JSON, multipart uploads); the validators and the version
   * headers both ways.
   */
  async proxy(req: Req, res: Res, app: string, service: 'pages' | 'files', rest: string, query: string): Promise<void> {
    const a = await this.account();
    if (!a) throw new HttpError(401, 'Sign in to a Luna dashboard first.');
    // Only paths below the application's API: no dot segments (fetch would resolve them).
    if (/(^|\/)(\.|%2e){1,2}(\/|$)/i.test(rest) || /%2f|%5c|\\/i.test(rest) || !/^[a-z0-9-]{1,64}$/i.test(app)) {
      throw new HttpError(400, 'Bad path.');
    }
    const method = (req.method || 'GET').toUpperCase();
    const headers: Record<string, string> = { Authorization: `Bearer ${a.token}` };
    for (const h of ['content-type', 'accept', 'if-match', 'if-none-match']) {
      const v = req.headers[h];
      if (v) headers[h] = String(v);
    }
    const body = method === 'GET' || method === 'HEAD' ? undefined : await readBody(req, 64 * 1024 * 1024);
    const target = `${a.url}/studio/v1/apps/${encodeURIComponent(app)}/${service}/api${rest}${query ? `?${query}` : ''}`;
    const r = await this.fetchImpl(target, { method, headers, body: body as BodyInit | undefined, redirect: 'manual' });
    res.statusCode = r.status;
    for (const h of ['content-type', 'etag', 'location', 'cache-control']) {
      const v = r.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    res.end(Buffer.from(await r.arrayBuffer()));
  }
}
