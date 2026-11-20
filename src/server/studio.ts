import path from 'node:path';
import type { Plugin } from 'vite';
import { readArchive } from 'grapesjs-site-pages/archive';
import { fail, HttpError, json, pathOf, queryOf, readBody, readJson, type Next, type Req, type Res } from './http';
import { contentApi, editorApi, previewHtml } from './localApi';
import { FormsStore, formsApi } from './formsStore';
import { normalizeDashboard, Remote } from './remote';
import { SiteStore } from './siteStore';

export interface StudioOptions {
  /** The site's folder (created when missing). */
  dir: string;
  /** The dashboard offered for signing in, and the fonts catalogues' source. */
  dashboard?: string;
  /** Where the sign-in tokens are kept (default `~/.luna-studio/credentials.json`). */
  credentials?: string;
  /** `fetch` for the calls to the dashboard (tests). */
  fetch?: typeof fetch;
  /** Debounce of folder writes, ms. */
  saveDelay?: number;
  /**
   * Connect the editor to Luna Studio's MCP server (`lunastudio mcp`):
   * `true` for its default port (GJS_MCP_PORT or 8765), or the port, and
   * the server's token (GJS_MCP_TOKEN) if it has one.
   */
  mcp?: boolean | { port?: number; token?: string } | null;
}

/** The editor's MCP settings for the page, or null. */
export function mcpConfig(o: StudioOptions['mcp']): { url: string; token: string } | null {
  if (!o) return null;
  const c = o === true ? {} : o;
  const port = c.port || Number(process.env.GJS_MCP_PORT) || 8765;
  return { url: `ws://127.0.0.1:${port}`, token: c.token ?? process.env.GJS_MCP_TOKEN ?? '' };
}

export const DEFAULT_DASHBOARD = 'https://dashboard.shibisty.com';

/** Requests that change something must carry it: a page on another site cannot add it without a CORS preflight, which is never answered. */
export const STUDIO_HEADER = 'x-luna-studio';

const LOCAL_HOSTS = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

export interface Studio {
  store: SiteStore;
  forms: FormsStore;
  remote: Remote;
  /** Connect-style middleware for everything under `/studio/`. */
  handle(req: Req, res: Res, next: Next): void;
  ready: Promise<void>;
}

export function createStudio(opts: StudioOptions): Studio {
  const store = new SiteStore(path.resolve(opts.dir), { saveDelay: opts.saveDelay });
  const forms = new FormsStore(path.resolve(opts.dir));
  const remote = new Remote(opts.credentials, opts.fetch);
  const dashboard = opts.dashboard ? normalizeDashboard(opts.dashboard) : DEFAULT_DASHBOARD;
  const doFetch = opts.fetch || globalThis.fetch.bind(globalThis);
  const ready = store.load();
  const mcp = mcpConfig(opts.mcp);

  const origin = (req: Req): string => `http://${req.headers.host}`;

  const route = async (req: Req, res: Res, p: string): Promise<void> => {
    await ready;
    const method = (req.method || 'GET').toUpperCase();
    if (!LOCAL_HOSTS.test(String(req.headers.host || ''))) throw new HttpError(403, 'Open the studio at localhost.');
    if (method !== 'GET' && method !== 'HEAD' && req.headers[STUDIO_HEADER] !== '1') throw new HttpError(403, 'Missing the X-Luna-Studio header.');
    let m: RegExpMatchArray | null;

    if (p === '/studio/api/state' && method === 'GET') {
      const accounts = (await remote.accounts()).map((a) => ({ url: a.url, developer: a.developer, expires_at: a.expires_at ?? null }));
      const cur = await remote.account();
      return json(res, 200, {
        dir: store.dir,
        site: store.records.get('site')?.name || '',
        edited: store.edited,
        dashboard,
        accounts,
        current: cur?.url || null,
        mcp,
      });
    }
    if (p === '/studio/api/sign-in' && method === 'POST') {
      const b = (await readJson(req)) || {};
      const location = await remote.begin(b.url || dashboard, origin(req), typeof b.back === 'string' && b.back.startsWith('/') ? b.back : '/');
      return json(res, 200, { location });
    }
    if (p === '/studio/auth/callback' && method === 'GET') {
      try {
        const back = await remote.finish(queryOf(req));
        res.statusCode = 302;
        res.setHeader('Location', back);
        return void res.end();
      } catch (e) {
        res.statusCode = (e as HttpError).status || 500;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        const msg = String((e as Error).message).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
        return void res.end(`<!doctype html><meta charset="utf-8"><title>Luna Studio</title><p>${msg}</p><p><a href="/">Back to the studio</a></p>`);
      }
    }
    if (p === '/studio/api/sign-out' && method === 'POST') {
      const b = (await readJson(req)) || {};
      await remote.signOut(b.url);
      return json(res, 204);
    }
    if (p === '/studio/api/use' && method === 'POST') {
      const b = (await readJson(req)) || {};
      await remote.use(normalizeDashboard(b.url));
      return json(res, 204);
    }
    if (p === '/studio/api/apps' && method === 'GET') return json(res, 200, await remote.call('/studio/v1/apps'));
    if (p === '/studio/api/me' && method === 'GET') return json(res, 200, await remote.call('/studio/v1/me'));
    if (p === '/studio/api/export.zip' && method === 'GET') {
      await store.flush();
      const name = (store.records.get('site')?.name || 'site').replace(/[^\w.-]+/g, '-') || 'site';
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${name}.zip"`);
      res.setHeader('Cache-Control', 'no-store');
      return void res.end(Buffer.from(store.zip()));
    }
    if (p === '/studio/api/import' && method === 'POST') {
      // A site archive replaces the folder's designs (entries stay).
      let arc;
      try {
        arc = readArchive(new Uint8Array(await readBody(req, 256 * 1024 * 1024)));
      } catch (e) {
        if (e instanceof HttpError) throw e;
        throw new HttpError(422, `Not a site archive: ${(e as Error).message}`);
      }
      const n = store.replaceAll(arc);
      await store.flush();
      return json(res, 200, { records: n });
    }
    if (p === '/studio/api/reload' && method === 'POST') {
      await store.flush();
      await store.load();
      return json(res, 200, { edited: store.edited });
    }
    if ((m = p.match(/^\/studio\/preview\/([^/]+)$/)) && method === 'GET') {
      const out = previewHtml(store, decodeURIComponent(m[1]));
      res.statusCode = out.status;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      // The page's own scripts run in an opaque origin, away from the studio's API.
      res.setHeader('Content-Security-Policy', 'sandbox allow-scripts allow-popups allow-forms');
      res.setHeader('Cache-Control', 'no-store');
      return void res.end(out.html);
    }
    if (p.startsWith('/studio/local/editor/') || p === '/studio/local/editor') return editorApi(store, req, res, p.slice('/studio/local/editor'.length) || '/');
    if (p.startsWith('/studio/local/content/')) return contentApi(store, req, res, p.slice('/studio/local/content'.length));
    if (p === '/studio/local/forms' || p.startsWith('/studio/local/forms/')) return formsApi(forms, req, res, p.slice('/studio/local/forms'.length) || '/');
    if ((m = p.match(/^\/studio\/remote\/([^/]+)\/(pages|files|forms)(\/.*)?$/))) {
      return remote.proxy(req, res, decodeURIComponent(m[1]), m[2] as 'pages' | 'files' | 'forms', m[3] || '', (req.url || '').split('?')[1] || '');
    }
    // The fonts catalogues (grapesjs-fonts): the dashboard's public proxy.
    if ((m = p.match(/^\/studio\/fonts\/(.+)$/)) && method === 'GET') {
      const src = (await remote.account())?.url || dashboard;
      const q = (req.url || '').split('?')[1];
      let r: Response;
      try {
        r = await doFetch(`${src}/editor/fonts/${m[1]}${q ? `?${q}` : ''}`, { headers: { Accept: 'application/json' } });
      } catch {
        // The dashboard is not reachable: the fonts panel shows its own error.
        throw new HttpError(502, `The font catalogues come through ${src}, which does not answer.`);
      }
      res.statusCode = r.status;
      res.setHeader('Content-Type', r.headers.get('content-type') || 'application/json');
      res.setHeader('Cache-Control', 'public, max-age=3600');
      return void res.end(Buffer.from(await r.arrayBuffer()));
    }
    throw new HttpError(404, 'Not found.');
  };

  return {
    store,
    forms,
    remote,
    ready,
    handle(req, res, next) {
      const p = pathOf(req);
      if (!p.startsWith('/studio/')) return next();
      route(req, res, p).catch((e) => {
        if (res.headersSent) {
          console.error('[luna-studio]', e);
          res.end();
        } else fail(res, e);
      });
    },
  };
}

/** The studio's API as a Vite plugin (dev server and preview server). */
export function studioPlugin(opts: StudioOptions & { studio?: Studio }): Plugin {
  let studio: Studio | null = opts.studio || null;
  const get = () => (studio ||= createStudio(opts));
  return {
    name: 'luna-studio',
    configureServer(server) {
      server.middlewares.use((req, res, next) => get().handle(req, res, next));
    },
    configurePreviewServer(server) {
      server.middlewares.use((req, res, next) => get().handle(req, res, next));
    },
  };
}
