import { compose } from 'grapesjs-site-pages/archive';
import { fail, HttpError, ifMatch, json, readJson, type Req, type Res } from './http';
import { type Kind, type Rec, SiteStore } from './siteStore';

/**
 * The local folder over HTTP, as luna-pages offers it to the editor:
 * the editor contract (grapesjs-pages remote mode, `…/editor`). The content
 * API (grapesjs-storage, `…/content`) is contentStore.ts. Mounted at `/studio/local`.
 */

const COLL: Record<string, Exclude<Kind, 'site'>> = { pages: 'page', layouts: 'layout', templates: 'template', components: 'component' };

/** A record's header (lists) or the whole record (`full`). */
export function wire(r: Rec, full = false): Record<string, unknown> {
  if (r.kind === 'site') {
    return { name: r.name, settings: r.settings || {}, version: r.version, updated_at: r.updated_at, ...(full ? { data: r.data ?? null } : {}) };
  }
  const w: Record<string, unknown> = { kind: r.kind, id: r.id, name: r.name, version: r.version, created_at: r.created_at, updated_at: r.updated_at };
  if (r.kind === 'page') {
    Object.assign(w, {
      slug: r.slug,
      page_kind: r.template_id ? 'entry' : 'free',
      status: r.status || 'draft',
      published_at: r.published_at ?? null,
      layout_id: r.layout_id ?? null,
      template_id: r.template_id ?? null,
      parent_id: r.parent_id ?? null,
      data_of: r.data_of ?? null,
      position: r.position ?? 0,
    });
  }
  if (r.kind === 'template') w.fields = r.fields || [];
  if (full) {
    w.data = r.data ?? null;
    if (r.kind === 'page') w.values = r.values || {};
  }
  return w;
}

const etag = (r: Rec) => ({ ETag: `"${r.version}"` });

/** The editor contract: `/site`, `/{pages|layouts|templates|components}[/{id}[/publish|unpublish|revisions[/{n}/restore]]]`. */
export async function editorApi(store: SiteStore, req: Req, res: Res, path: string): Promise<void> {
  const method = (req.method || 'GET').toUpperCase();
  try {
    if (path === '/site' || path.startsWith('/site/')) {
      const rest = path.slice('/site'.length);
      if (rest === '' && method === 'GET') return json(res, 200, wire(store.get('site', 'site'), true), etag(store.get('site', 'site')));
      if (rest === '' && method === 'PUT') {
        const r = store.putSite(await readJson(req), ifMatch(req));
        return json(res, 200, wire(r, true), etag(r));
      }
      if (rest === '/publish' && method === 'POST') {
        const out = store.publish('site', 'site', (await readJson(req)) || {}, ifMatch(req));
        return json(res, 200, { record: wire(out.rec), revision: out.revision, warnings: out.warnings }, etag(out.rec));
      }
      if (rest === '/revisions' && method === 'GET') return json(res, 200, { items: store.revisionList('site', 'site') });
      throw new HttpError(404, 'Not found.');
    }
    const m = path.match(/^\/(pages|layouts|templates|components)(?:\/([^/]+))?(?:\/(publish|unpublish|revisions)(?:\/(\d+)\/restore)?)?\/?$/);
    if (!m) throw new HttpError(404, 'Not found.');
    const kind = COLL[m[1]];
    const id = m[2] ? decodeURIComponent(m[2]) : '';
    const action = m[3];
    if (!id) {
      if (method !== 'GET') throw new HttpError(405, 'Method not allowed.');
      return json(res, 200, { items: store.list(kind).map((r) => wire(r)) });
    }
    if (!action) {
      if (method === 'GET') {
        const r = store.get(kind, id);
        return json(res, 200, wire(r, true), etag(r));
      }
      if (method === 'PUT') {
        const { rec, created } = store.put(kind, id, (await readJson(req)) || {}, ifMatch(req));
        return json(res, created ? 201 : 200, wire(rec, true), etag(rec));
      }
      if (method === 'DELETE') {
        store.delete(kind, id, ifMatch(req));
        return json(res, 204);
      }
      throw new HttpError(405, 'Method not allowed.');
    }
    if (action === 'publish' && method === 'POST') {
      const out = store.publish(kind, id, (await readJson(req)) || {}, ifMatch(req));
      return json(res, 200, { record: wire(out.rec), revision: out.revision, warnings: out.warnings }, etag(out.rec));
    }
    if (action === 'unpublish' && method === 'POST' && kind === 'page') {
      const r = store.unpublish(id, ifMatch(req));
      return json(res, 200, wire(r), etag(r));
    }
    if (action === 'revisions' && !m[4] && method === 'GET') return json(res, 200, { items: store.revisionList(kind, id) });
    if (action === 'revisions' && m[4] && method === 'POST') {
      const r = store.restore(kind, id, Number(m[4]), ifMatch(req));
      return json(res, 200, wire(r, true), etag(r));
    }
    throw new HttpError(405, 'Method not allowed.');
  } catch (e) {
    fail(res, e);
  }
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/**
 * A page as the site would show it, from what was published here: the
 * site's CSS, the layout's, the page's; the page in its layout's slot.
 * Field values of entries are not filled in (that is luna-pages' work).
 */
export function previewHtml(store: SiteStore, id: string): { status: number; html: string } {
  let page: Rec;
  try {
    page = store.get('page', id);
  } catch {
    return { status: 404, html: '<!doctype html><p>No such page.</p>' };
  }
  const design = page.template_id ? store.records.get(page.template_id) : page;
  if (!design?.published) return { status: 404, html: '<!doctype html><meta charset="utf-8"><p>Nothing to preview yet: publish it first.</p>' };
  const layout = page.layout_id ? store.records.get(page.layout_id) : undefined;
  const site = store.records.get('site');
  const css = [site?.published?.css, layout?.published?.css, design.published.css].filter(Boolean).join('\n');
  const title = String(page.values?.['seo.title'] || page.name);
  const body = compose(layout?.published?.html, design.published.html || '');
  return {
    status: 200,
    html: `<!doctype html>\n<html>\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>${esc(title)}</title>\n<style>${css.replace(/<\/style/gi, '<\\/style')}</style>\n</head>\n<body>\n${body}\n</body>\n</html>\n`,
  };
}
