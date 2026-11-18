import type { IncomingMessage, ServerResponse } from 'node:http';

export type Req = IncomingMessage;
export type Res = ServerResponse;
export type Next = (err?: unknown) => void;

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly errors?: Record<string, string[]>
  ) {
    super(message);
  }
}

export function json(res: Res, status: number, data?: unknown, headers: Record<string, string> = {}): void {
  res.statusCode = status;
  res.setHeader('Cache-Control', 'no-store');
  Object.entries(headers).forEach(([k, v]) => res.setHeader(k, v));
  if (data === undefined || status === 204) {
    res.end();
    return;
  }
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(data));
}

export function fail(res: Res, e: unknown): void {
  const err = e as { status?: number; message?: string; errors?: Record<string, string[]> };
  const status = typeof err?.status === 'number' ? err.status : 500;
  // Unexpected failures only: a 502 (a dashboard that does not answer) is the message itself.
  if (status === 500) console.error('[luna-studio]', e);
  json(res, status, { error: err?.message || 'Internal error', ...(err?.errors ? { errors: err.errors } : {}) });
}

/** The request body (limited), as bytes. */
export function readBody(req: Req, limit = 16 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, 'The request body is too large.'));
        req.destroy();
        return;
      }
      parts.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });
}

export async function readJson(req: Req): Promise<any> {
  const b = await readBody(req);
  if (!b.length) return undefined;
  try {
    return JSON.parse(b.toString('utf8'));
  } catch {
    throw new HttpError(400, 'The body is not JSON.');
  }
}

/** `If-Match: "7"` → 7; none → null; anything else is a 400. */
export function ifMatch(req: Req): number | null {
  const h = req.headers['if-match'];
  if (!h) return null;
  const v = Number(String(h).trim().replace(/^W\//, '').replace(/"/g, ''));
  if (!Number.isInteger(v) || v < 1) throw new HttpError(400, 'If-Match must be a version, e.g. "7".');
  return v;
}

export const pathOf = (req: Req): string => (req.url || '/').split('?')[0];
export const queryOf = (req: Req): URLSearchParams => new URLSearchParams((req.url || '').split('?')[1] || '');
