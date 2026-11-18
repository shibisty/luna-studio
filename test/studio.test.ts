import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readArchive } from 'grapesjs-pages/archive';
import { createStudio, type Studio } from '../src/server/studio';

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const project = (html: string) => ({ assets: [], styles: [], pages: [{ frames: [{ component: { type: 'wrapper', components: html } }] }] });

let dir: string;
let server: Server;
let base: string;
let studio: Studio;
let dashboardCalls: Array<{ url: string; init?: RequestInit }> = [];

/** A fake dashboard for the sign-in and the proxy. */
const fakeDashboard: typeof fetch = async (input, init) => {
  const url = String(input);
  dashboardCalls.push({ url, init });
  const j = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ETag: '"3"' } });
  if (url === 'https://dash.test/studio/token') {
    const b = JSON.parse(String(init?.body));
    if (b.code !== 'good-code' || !b.code_verifier) return j(400, { error: 'invalid_grant' });
    return j(200, { access_token: 'lst_secret', token_type: 'Bearer', expires_in: 3600, developer: { name: 'Alex', email: 'a@x' } });
  }
  const auth = new Headers(init?.headers as HeadersInit).get('authorization');
  if (auth !== 'Bearer lst_secret') return j(401, { error: 'unauthorized' });
  if (url === 'https://dash.test/studio/v1/apps') return j(200, { items: [{ id: 'app1', name: 'Shop' }] });
  if (url === 'https://dash.test/studio/revoke') return new Response(null, { status: 204 });
  if (url.startsWith('https://dash.test/studio/v1/apps/app1/pages/api/editor/pages')) return j(200, { items: [], echo: { method: init?.method, ifMatch: new Headers(init?.headers as HeadersInit).get('if-match') } });
  return j(404, { error: 'not found' });
};

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'studio-'));
  dashboardCalls = [];
  studio = createStudio({ dir: path.join(dir, 'site'), saveDelay: 0, credentials: path.join(dir, 'creds.json'), fetch: fakeDashboard, dashboard: 'https://dash.test' });
  await studio.ready;
  server = createServer((req, res) => studio.handle(req, res, () => ((res.statusCode = 404), res.end('next'))));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const a = server.address() as { port: number };
  base = `http://localhost:${a.port}`;
});
afterEach(async () => {
  await studio.store.flush();
  await new Promise<void>((r) => server.close(() => r()));
  await rm(dir, { recursive: true, force: true });
});

const H = { 'X-Luna-Studio': '1', 'Content-Type': 'application/json' };
const call = async (method: string, p: string, body?: unknown, headers: Record<string, string> = {}) => {
  const r = await fetch(base + p, { method, headers: { ...H, ...headers }, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
  const text = await r.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: r.status, json, headers: r.headers };
};

describe('the editor contract over a folder', () => {
  it('creates, versions, lists and refuses stale writes', async () => {
    let r = await call('PUT', `/studio/local/editor/layouts/${ID(1)}`, { name: 'Main', data: project('<header>H</header><page-slot></page-slot>') });
    expect(r.status).toBe(201);
    expect(r.json.version).toBe(1);
    r = await call('PUT', `/studio/local/editor/pages/${ID(2)}`, { name: 'Home', slug: '/', layout_id: ID(1), data: project('<p>home</p>'), values: { 'seo.title': 'Hi' } });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ slug: '/', layout_id: ID(1), page_kind: 'free', status: 'draft', values: { 'seo.title': 'Hi' } });
    r = await call('PUT', `/studio/local/editor/pages/${ID(3)}`, { name: 'About us' });
    expect(r.json.slug).toBe('/about-us');
    // Stale.
    r = await call('PUT', `/studio/local/editor/pages/${ID(2)}`, { name: 'Home' }, { 'If-Match': '"7"' });
    expect(r.status).toBe(412);
    r = await call('PUT', `/studio/local/editor/pages/${ID(2)}`, { name: 'Home!', values: { 'seo.title': null } }, { 'If-Match': '"1"' });
    expect(r.status).toBe(200);
    expect(r.json.version).toBe(2);
    expect(r.json.values).toEqual({});
    expect(r.json.data).toEqual(project('<p>home</p>')); // kept
    // Taken slug, bad refs, bad ids.
    expect((await call('PUT', `/studio/local/editor/pages/${ID(4)}`, { name: 'X', slug: '/' })).status).toBe(422);
    expect((await call('PUT', `/studio/local/editor/pages/${ID(4)}`, { name: 'X', layout_id: ID(9) })).status).toBe(422);
    expect((await call('PUT', `/studio/local/editor/pages/nope`, { name: 'X' })).status).toBe(422);
    r = await call('GET', '/studio/local/editor/pages');
    expect(r.json.items.map((p: any) => p.name)).toEqual(['Home!', 'About us']);
    expect(r.json.items[0].data).toBeUndefined();
    expect((await call('GET', '/studio/local/editor/site')).json).toMatchObject({ name: 'site', settings: {}, version: 1 });
  });

  it('publishes, keeps revisions, restores, unpublishes, deletes', async () => {
    await call('PUT', `/studio/local/editor/pages/${ID(2)}`, { name: 'Home', slug: '/', data: project('<p>v1</p>') });
    let r = await call('POST', `/studio/local/editor/pages/${ID(2)}/publish`, { html: '<p>v1</p>', css: 'p{color:red}' }, { 'If-Match': '"1"' });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ revision: 1, warnings: [], record: { status: 'published', version: 2 } });
    await call('PUT', `/studio/local/editor/pages/${ID(2)}`, { name: 'Home', data: project('<p>v2</p>') });
    r = await call('GET', `/studio/local/editor/pages/${ID(2)}/revisions`);
    expect(r.json.items).toHaveLength(1);
    expect(r.json.items[0]).toMatchObject({ revision: 1, live: true });
    r = await call('POST', `/studio/local/editor/pages/${ID(2)}/revisions/1/restore`);
    expect(r.json.data).toEqual(project('<p>v1</p>'));
    // A layout needs a slot.
    await call('PUT', `/studio/local/editor/layouts/${ID(1)}`, { name: 'L' });
    expect((await call('POST', `/studio/local/editor/layouts/${ID(1)}/publish`, { html: '<p>no slot</p>' })).status).toBe(422);
    r = await call('POST', `/studio/local/editor/pages/${ID(2)}/unpublish`);
    expect(r.json.status).toBe('draft');
    expect((await call('DELETE', `/studio/local/editor/pages/${ID(2)}`)).status).toBe(204);
    expect((await call('GET', `/studio/local/editor/pages/${ID(2)}`)).status).toBe(404);
  });

  it('keeps the site as an archive folder that reads back', async () => {
    await call('PUT', '/studio/local/editor/site', { name: 'Acme', settings: { custom_code: true }, data: project('') });
    await call('POST', '/studio/local/editor/site/publish', { css: 'body{margin:0}' });
    await call('PUT', `/studio/local/editor/layouts/${ID(1)}`, { name: 'Main', data: project('<page-slot></page-slot>') });
    await call('POST', `/studio/local/editor/layouts/${ID(1)}/publish`, { html: '<header>H</header><page-slot></page-slot>', css: 'header{x:y}' });
    await call('PUT', `/studio/local/editor/templates/${ID(5)}`, { name: 'Product', data: project('<h1 data-field="title">T</h1>') });
    await call('PUT', `/studio/local/content/templates/${ID(5)}`, { fields: [{ name: 'title', type: 'text' }] });
    await call('PUT', `/studio/local/editor/pages/${ID(2)}`, { name: 'Home', slug: '/', layout_id: ID(1), data: project('<p>home</p>') });
    await call('POST', `/studio/local/editor/pages/${ID(2)}/publish`, { html: '<p>home</p>', css: '' });
    await call('PUT', `/studio/local/editor/pages/${ID(3)}`, { name: 'Post', slug: '/blog/post', data: project('<p>post</p>') });
    await studio.store.flush();

    const root = path.join(dir, 'site');
    const m = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
    expect(m.format).toBe('grapesjs-pages-archive');
    expect(m.records.map((r: any) => r.dir).sort()).toEqual(['layouts/main', 'pages/blog/post', 'pages/index', 'site', 'templates/product']);
    expect(await readFile(path.join(root, 'pages/index/body.html'), 'utf8')).toBe('<p>home</p>');
    expect(await readFile(path.join(root, 'pages/index/index.html'), 'utf8')).toContain('<header>H</header><p>home</p>');
    expect(JSON.parse(await readFile(path.join(root, 'templates/product/fields.json'), 'utf8'))).toEqual([{ name: 'title', type: 'text' }]);
    expect(JSON.parse(await readFile(path.join(root, 'site/settings.json'), 'utf8'))).toEqual({ custom_code: true });
    expect(existsSync(path.join(root, '.studio/state.json'))).toBe(true);

    // A rename moves the folder; the old one goes when it is empty.
    await call('PUT', `/studio/local/editor/pages/${ID(3)}`, { name: 'Post', slug: '/news/post' });
    await studio.store.flush();
    expect(existsSync(path.join(root, 'pages/news/post/project.json'))).toBe(true);
    expect(existsSync(path.join(root, 'pages/blog'))).toBe(false);

    // The export is the same archive.
    const zip = await fetch(base + '/studio/api/export.zip');
    expect(zip.headers.get('content-type')).toBe('application/zip');
    const arc = readArchive(new Uint8Array(await zip.arrayBuffer()));
    expect(arc.records.map((r) => r.kind).sort()).toEqual(['layout', 'page', 'page', 'site', 'template']);

    // Edited in another tool, then read again: the record follows the HTML, with a new version.
    await writeFile(path.join(root, 'pages/index/body.html'), '<p>edited</p>');
    const r = await call('POST', '/studio/api/reload');
    expect(r.json.edited).toEqual([ID(2)]);
    const home = (await call('GET', `/studio/local/editor/pages/${ID(2)}`)).json;
    expect(home.data.pages[0].frames[0].component).toBe('<p>edited</p>');
    expect(home.version).toBe(3);
    expect(home.layout_id).toBe(ID(1));
    expect(home.status).toBe('published');
    // Versions survive a restart.
    const again = createStudio({ dir: root, saveDelay: 0, credentials: path.join(dir, 'creds.json') });
    await again.ready;
    expect(again.store.get('page', ID(3)).version).toBe(2);
  });

  it('serves the content API: template fields without a new version, entries with plain keys', async () => {
    await call('PUT', `/studio/local/editor/templates/${ID(5)}`, { name: 'Product', data: project('<h1 data-field="title">T</h1>') });
    let r = await call('PUT', `/studio/local/content/templates/${ID(5)}`, { fields: [{ name: 'title', type: 'text' }] });
    expect(r.json).toMatchObject({ id: ID(5), version: 1, fields: [{ name: 'title' }] });
    r = await call('PUT', `/studio/local/content/entries/${ID(6)}`, { template_id: ID(5), name: 'Phone', values: { title: 'Phone X' } });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ template_id: ID(5), slug: '/phone', values: { title: 'Phone X' }, version: 1 });
    r = await call('GET', `/studio/local/content/entries?template=${ID(5)}`);
    expect(r.json.items).toHaveLength(1);
    r = await call('POST', `/studio/local/content/entries/${ID(6)}/publish`, undefined, { 'If-Match': '"1"' });
    expect(r.json.status).toBe('published');
    expect((await call('DELETE', `/studio/local/editor/templates/${ID(5)}`)).status).toBe(409);
    // Entries are not designs: not in the folder's archive.
    await studio.store.flush();
    const m = JSON.parse(await readFile(path.join(dir, 'site/manifest.json'), 'utf8'));
    expect(m.records.some((x: any) => x.id === ID(6))).toBe(false);
    expect(JSON.parse(await readFile(path.join(dir, 'site/.studio/entries.json'), 'utf8'))[0].id).toBe(ID(6));
  });

  it('previews a published page in its layout', async () => {
    await call('PUT', `/studio/local/editor/layouts/${ID(1)}`, { name: 'Main' });
    await call('POST', `/studio/local/editor/layouts/${ID(1)}/publish`, { html: '<main><page-slot></page-slot></main>', css: 'main{a:b}' });
    await call('PUT', `/studio/local/editor/pages/${ID(2)}`, { name: 'Home', slug: '/', layout_id: ID(1) });
    let r = await fetch(`${base}/studio/preview/${ID(2)}`);
    expect(r.status).toBe(404);
    await call('POST', `/studio/local/editor/pages/${ID(2)}/publish`, { html: '<p>x</p>', css: 'p{c:d}' });
    r = await fetch(`${base}/studio/preview/${ID(2)}`);
    const html = await r.text();
    expect(html).toContain('<main><p>x</p></main>');
    expect(html).toContain('main{a:b}');
    expect(r.headers.get('content-security-policy')).toContain('sandbox');
  });

  it('replaces the folder designs with an archive (a pull), entries stay', async () => {
    await call('PUT', `/studio/local/editor/pages/${ID(2)}`, { name: 'Old', slug: '/' });
    await call('PUT', `/studio/local/editor/templates/${ID(5)}`, { name: 'Product' });
    await call('PUT', `/studio/local/content/entries/${ID(6)}`, { template_id: ID(5), name: 'Phone' });
    const zip = new Uint8Array(await (await fetch(base + '/studio/api/export.zip')).arrayBuffer());
    await call('PUT', `/studio/local/editor/pages/${ID(3)}`, { name: 'Extra' });
    const r = await fetch(base + '/studio/api/import', { method: 'POST', headers: { 'X-Luna-Studio': '1' }, body: zip });
    expect((await r.json()).records).toBe(3);
    const pages = (await call('GET', '/studio/local/editor/pages')).json.items.map((p: any) => p.name).sort();
    expect(pages).toEqual(['Old', 'Phone']);
    expect((await fetch(base + '/studio/api/import', { method: 'POST', headers: { 'X-Luna-Studio': '1' }, body: 'junk' })).status).toBe(422);
  });
});

describe('guards', () => {
  it('needs the studio header to change anything, and a local Host', async () => {
    const r = await fetch(`${base}/studio/local/editor/pages/${ID(1)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{"name":"x"}' });
    expect(r.status).toBe(403);
    const port = (server.address() as { port: number }).port;
    const other = await new Promise<number>((resolve) => {
      const req = require('node:http').request({ host: '127.0.0.1', port, path: '/studio/api/state', headers: { Host: 'evil.test' } }, (res: any) => resolve(res.statusCode));
      req.end();
    });
    expect(other).toBe(403);
    // Not ours: passed on.
    expect((await fetch(`${base}/index.html`)).status).toBe(404);
  });
});

describe('signing in to a dashboard', () => {
  it('runs the code flow with PKCE, keeps the token server-side and proxies with it', async () => {
    let r = await call('POST', '/studio/api/sign-in', { url: 'dash.test' });
    const loc = new URL(r.json.location);
    expect(loc.origin + loc.pathname).toBe('https://dash.test/studio/authorize');
    expect(loc.searchParams.get('code_challenge_method')).toBe('S256');
    expect(loc.searchParams.get('redirect_uri')).toBe(`${base}/studio/auth/callback`);
    expect(loc.searchParams.get('client_id')).toBe('luna-studio');
    const state = loc.searchParams.get('state')!;

    // A wrong state is refused.
    r = await call('GET', `/studio/auth/callback?code=good-code&state=nope`);
    expect(r.status).toBe(400);
    r = await call('GET', `/studio/auth/callback?code=good-code&state=${state}`);
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe('/');
    const tokenCall = dashboardCalls.find((c) => c.url.endsWith('/studio/token'))!;
    const sent = JSON.parse(String(tokenCall.init!.body));
    // The verifier hashes to the challenge.
    const { createHash } = await import('node:crypto');
    const challenge = createHash('sha256').update(sent.code_verifier).digest('base64url');
    expect(challenge).toBe(loc.searchParams.get('code_challenge'));
    // A state works once.
    expect((await call('GET', `/studio/auth/callback?code=good-code&state=${state}`)).status).toBe(400);

    r = await call('GET', '/studio/api/state');
    expect(r.json.current).toBe('https://dash.test');
    expect(JSON.stringify(r.json)).not.toContain('lst_secret');
    expect(r.json.accounts[0].developer).toEqual({ name: 'Alex', email: 'a@x' });
    expect((await call('GET', '/studio/api/apps')).json.items).toEqual([{ id: 'app1', name: 'Shop' }]);

    r = await call('GET', '/studio/remote/app1/pages/editor/pages', undefined, { 'If-Match': '"2"' });
    expect(r.status).toBe(200);
    expect(r.json.echo).toEqual({ method: 'GET', ifMatch: '"2"' });
    expect(r.headers.get('etag')).toBe('"3"');
    const creds = JSON.parse(await readFile(path.join(dir, 'creds.json'), 'utf8'));
    expect(creds.accounts[0].token).toBe('lst_secret');

    // Nothing outside the application's API.
    const raw = (p: string) =>
      new Promise<number>((resolve) => {
        const port = (server.address() as { port: number }).port;
        const r = require('node:http').request({ host: '127.0.0.1', port, path: p, headers: { Host: `localhost:${port}` } }, (res: any) => resolve(res.statusCode));
        r.end();
      });
    expect(await raw('/studio/remote/app1/pages/editor/../../../../revoke')).toBe(400);
    expect(await raw('/studio/remote/app1/pages/editor/%2e%2e/x')).toBe(400);
    expect(await raw('/studio/remote/app1/pages/editor%2f..%2fx')).toBe(400);

    await call('POST', '/studio/api/sign-out');
    expect(dashboardCalls.some((c) => c.url.endsWith('/studio/revoke'))).toBe(true);
    expect((await call('GET', '/studio/api/apps')).status).toBe(401);
  });

  it('refuses plain http to a remote dashboard', async () => {
    const r = await call('POST', '/studio/api/sign-in', { url: 'http://dash.test' });
    expect(r.status).toBe(422);
  });
});

it('keeps only its own files in the folder', async () => {
  await call('PUT', `/studio/local/editor/pages/${ID(2)}`, { name: 'Home', slug: '/' });
  await studio.store.flush();
  const top = (await readdir(path.join(dir, 'site'))).sort();
  expect(top).toEqual(['.studio', 'manifest.json', 'pages', 'site']);
});
