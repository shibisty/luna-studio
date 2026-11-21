import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import { fail, HttpError, ifMatch, json, queryOf, readJson, type Req, type Res } from './http';

/**
 * grapesjs-storage 1.x's content over the site folder, as luna-pages keeps
 * it on a server (the plugin's openapi.yaml):
 *
 *   content/templates/<id>.json   a template: a group of fields { name, fields }
 *   content/entries/<id>.json     the data of a page (id = the page's id) or of a
 *                                 standalone entry: { template_id, name, slug, values, published }
 *   content/languages.json        { default, enabled }
 *
 * In git with the rest of the site; versions and times in `.studio/content.json`.
 */

export const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const LANG_RE = /^[a-z]{2,3}-[a-z0-9]{2,4}$/;

interface Meta {
  version: number;
  updated_at: string;
  published_at?: string | null;
}

export interface Template {
  id: string;
  name: string;
  fields: unknown[];
  data?: unknown;
}

export interface Entry {
  id: string;
  template_id: string;
  name: string;
  slug: string;
  values: Record<string, unknown>;
  /** The values as last published (luna-pages' public read API serves these). */
  published?: Record<string, unknown> | null;
}

export interface Languages {
  default: string;
  enabled: string[];
}

type State = { templates: Record<string, Meta>; entries: Record<string, Meta>; languages?: Meta };

export class ContentStore {
  templates = new Map<string, Template>();
  entries = new Map<string, Entry>();
  languages: Languages | null = null;
  private state: State = { templates: {}, entries: {} };
  private loaded: Promise<void> | null = null;

  constructor(readonly dir: string) {}

  private p(...parts: string[]): string {
    return path.join(this.dir, ...parts);
  }

  load(): Promise<void> {
    if (!this.loaded) this.loaded = this.read();
    return this.loaded;
  }

  /** Read the folder again (after an import or edits outside). */
  reload(): Promise<void> {
    this.templates.clear();
    this.entries.clear();
    this.languages = null;
    this.loaded = this.read();
    return this.loaded;
  }

  private async read(): Promise<void> {
    this.state = (await readJsonFile<State>(this.p('.studio', 'content.json'))) || { templates: {}, entries: {} };
    this.state.templates ||= {};
    this.state.entries ||= {};
    for (const [dir, into] of [
      ['templates', this.templates],
      ['entries', this.entries],
    ] as const) {
      const d = this.p('content', dir);
      if (!existsSync(d)) continue;
      for (const f of await fs.readdir(d)) {
        const id = f.replace(/\.json$/, '');
        if (!f.endsWith('.json') || !ID_RE.test(id)) continue;
        const raw = await readJsonFile<Record<string, unknown>>(path.join(d, f));
        if (raw && typeof raw === 'object') (into as Map<string, unknown>).set(id, { ...raw, id });
      }
    }
    const l = await readJsonFile<Languages>(this.p('content', 'languages.json'));
    this.languages = l && checkLanguages(l, false) ? l : null;
  }

  private meta(kind: 'templates' | 'entries', id: string): Meta {
    return this.state[kind][id] || (this.state[kind][id] = { version: 1, updated_at: new Date().toISOString() });
  }

  private bump(m: Meta): void {
    m.version++;
    m.updated_at = new Date().toISOString();
  }

  private async save(rel: string[], value: unknown): Promise<void> {
    const f = this.p(...rel);
    if (value === undefined) await fs.rm(f, { force: true });
    else {
      await fs.mkdir(path.dirname(f), { recursive: true });
      await fs.writeFile(f, JSON.stringify(value, null, 2) + '\n');
    }
    await fs.mkdir(this.p('.studio'), { recursive: true });
    await fs.writeFile(this.p('.studio', 'content.json'), JSON.stringify(this.state, null, 2) + '\n');
  }

  /* ---------------- templates ---------------- */

  templateJSON(t: Template, withData = false): Record<string, unknown> {
    const m = this.meta('templates', t.id);
    return { id: t.id, name: t.name, fields: t.fields || [], version: m.version, updated_at: m.updated_at, ...(withData ? { data: t.data ?? null } : {}) };
  }

  getTemplate(id: string): Template {
    const t = this.templates.get(id);
    if (!t) throw new HttpError(404, 'No such template.');
    return t;
  }

  async putTemplate(id: string, body: any): Promise<{ t: Template; created: boolean }> {
    if (!ID_RE.test(id)) throw new HttpError(422, 'Invalid id.', { id: ['invalid'] });
    if (!body || typeof body !== 'object' || !Array.isArray(body.fields)) throw new HttpError(422, 'A template has a list of fields.', { fields: ['required'] });
    const cur = this.templates.get(id);
    const t: Template = { id, name: String(body.name ?? cur?.name ?? '').slice(0, 200) || 'Template', fields: body.fields };
    if (body.data !== undefined) t.data = body.data;
    else if (cur && cur.data !== undefined) t.data = cur.data;
    const m = this.meta('templates', id);
    if (cur) this.bump(m);
    this.templates.set(id, t);
    const { id: _id, ...file } = t;
    await this.save(['content', 'templates', `${id}.json`], file);
    return { t, created: !cur };
  }

  /** Deletes a template; its entries stay (their template_id points nowhere, as the plugin allows). */
  async deleteTemplate(id: string): Promise<void> {
    this.getTemplate(id);
    this.templates.delete(id);
    delete this.state.templates[id];
    await this.save(['content', 'templates', `${id}.json`], undefined);
  }

  /* ---------------- entries ---------------- */

  entryJSON(e: Entry): Record<string, unknown> {
    const m = this.meta('entries', e.id);
    return {
      id: e.id,
      template_id: e.template_id,
      name: e.name,
      slug: e.slug,
      status: m.published_at ? 'published' : 'draft',
      values: e.values || {},
      version: m.version,
      updated_at: m.updated_at,
      published_at: m.published_at ?? null,
    };
  }

  getEntry(id: string): Entry {
    const e = this.entries.get(id);
    if (!e) throw new HttpError(404, 'No such entry.');
    return e;
  }

  private check(id: string, ifVersion: number | null): void {
    if (ifVersion === null) return;
    if (!this.entries.has(id) || this.meta('entries', id).version !== ifVersion) throw new HttpError(412, 'The entry was changed in the meantime.');
  }

  /** Values merge; null deletes a key. */
  async putEntry(id: string, body: any, ifVersion: number | null): Promise<{ e: Entry; created: boolean }> {
    if (!ID_RE.test(id)) throw new HttpError(422, 'Invalid id.', { id: ['invalid'] });
    this.check(id, ifVersion);
    const cur = this.entries.get(id);
    const template = String(body?.template_id ?? cur?.template_id ?? '');
    if (!template) throw new HttpError(422, 'An entry has a template.', { template_id: ['required'] });
    const values: Record<string, unknown> = { ...(cur?.values || {}) };
    if (body?.values && typeof body.values === 'object') {
      for (const [k, v] of Object.entries(body.values as Record<string, unknown>)) {
        if (v === null) delete values[k];
        else values[k] = v;
      }
    }
    const e: Entry = {
      id,
      template_id: template,
      name: String(body?.name ?? cur?.name ?? '').slice(0, 200),
      slug: String(body?.slug ?? cur?.slug ?? '').slice(0, 200),
      values,
      published: cur?.published ?? null,
    };
    const m = this.meta('entries', id);
    if (cur) this.bump(m);
    this.entries.set(id, e);
    const { id: _id, ...file } = e;
    await this.save(['content', 'entries', `${id}.json`], file);
    return { e, created: !cur };
  }

  async deleteEntry(id: string, ifVersion: number | null): Promise<void> {
    this.getEntry(id);
    this.check(id, ifVersion);
    this.entries.delete(id);
    delete this.state.entries[id];
    await this.save(['content', 'entries', `${id}.json`], undefined);
  }

  async publishEntry(id: string, ifVersion: number | null): Promise<Entry> {
    const e = this.getEntry(id);
    this.check(id, ifVersion);
    e.published = { ...e.values };
    const m = this.meta('entries', id);
    this.bump(m);
    m.published_at = m.updated_at;
    const { id: _id, ...file } = e;
    await this.save(['content', 'entries', `${id}.json`], file);
    return e;
  }

  /* ---------------- languages ---------------- */

  async putLanguages(body: unknown): Promise<Languages> {
    // { default: '', enabled: [] }: the site has no languages (grapesjs-storage's way to clear them).
    const b = body as Partial<Languages> | null;
    if (!b || (!b.default && (!Array.isArray(b.enabled) || !b.enabled.length))) {
      this.languages = null;
      this.state.languages = { version: (this.state.languages?.version || 0) + 1, updated_at: new Date().toISOString() };
      await this.save(['content', 'languages.json'], undefined);
      return { default: '', enabled: [] };
    }
    const l = checkLanguages(body, true) as Languages;
    const out: Languages = { default: l.default, enabled: [l.default, ...l.enabled.filter((c) => c !== l.default)] };
    this.languages = out;
    this.state.languages = { version: (this.state.languages?.version || 0) + 1, updated_at: new Date().toISOString() };
    await this.save(['content', 'languages.json'], out);
    return out;
  }
}

function checkLanguages(v: unknown, strict: boolean): Languages | null {
  const l = v as Languages;
  const ok = !!l && typeof l === 'object' && typeof l.default === 'string' && LANG_RE.test(l.default) && Array.isArray(l.enabled) && l.enabled.every((c) => typeof c === 'string' && LANG_RE.test(c)) && l.enabled.length <= 200;
  if (!ok && strict) throw new HttpError(422, 'Languages: { default, enabled } with codes like uk-ua.', { default: ['invalid'] });
  return ok ? l : null;
}

async function readJsonFile<T>(f: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(f, 'utf8')) as T;
  } catch {
    return null;
  }
}

/**
 * The content API (grapesjs-storage 1.x's openapi.yaml): `/templates[/{id}]`,
 * `/entries[/{id}[/publish]]`, `/languages`. Mounted at `/studio/local/content`.
 */
export async function contentApi(store: ContentStore, req: Req, res: Res, p: string): Promise<void> {
  try {
    await store.load();
    const method = (req.method || 'GET').toUpperCase();
    if (p === '/languages' || p === '/languages/') {
      if (method === 'GET') {
        if (!store.languages) throw new HttpError(404, 'The site has no languages.');
        return json(res, 200, store.languages);
      }
      if (method === 'PUT') return json(res, 200, await store.putLanguages(await readJson(req)));
      throw new HttpError(405, 'Method not allowed.');
    }
    let m = p.match(/^\/templates(?:\/([^/]+))?\/?$/);
    if (m) {
      if (!m[1]) {
        if (method !== 'GET') throw new HttpError(405, 'Method not allowed.');
        return json(res, 200, { items: [...store.templates.values()].map((t) => store.templateJSON(t)) });
      }
      const id = decodeURIComponent(m[1]);
      if (method === 'GET') return json(res, 200, store.templateJSON(store.getTemplate(id), true));
      if (method === 'PUT') {
        const { t, created } = await store.putTemplate(id, await readJson(req));
        return json(res, created ? 201 : 200, store.templateJSON(t));
      }
      if (method === 'DELETE') {
        await store.deleteTemplate(id);
        return json(res, 204);
      }
      throw new HttpError(405, 'Method not allowed.');
    }
    m = p.match(/^\/entries(?:\/([^/]+))?(?:\/(publish))?\/?$/);
    if (m) {
      if (!m[1]) {
        if (method !== 'GET') throw new HttpError(405, 'Method not allowed.');
        const t = queryOf(req).get('template');
        return json(res, 200, { items: [...store.entries.values()].filter((e) => !t || e.template_id === t).map((e) => store.entryJSON(e)) });
      }
      const id = decodeURIComponent(m[1]);
      const tag = (e: Entry) => ({ ETag: `"${store.entryJSON(e).version}"` });
      if (m[2]) {
        if (method !== 'POST') throw new HttpError(405, 'Method not allowed.');
        const e = await store.publishEntry(id, ifMatch(req));
        return json(res, 200, store.entryJSON(e), tag(e));
      }
      if (method === 'GET') {
        const e = store.getEntry(id);
        return json(res, 200, store.entryJSON(e), tag(e));
      }
      if (method === 'PUT') {
        const { e, created } = await store.putEntry(id, await readJson(req), ifMatch(req));
        return json(res, created ? 201 : 200, store.entryJSON(e), tag(e));
      }
      if (method === 'DELETE') {
        await store.deleteEntry(id, ifMatch(req));
        return json(res, 204);
      }
      throw new HttpError(405, 'Method not allowed.');
    }
    throw new HttpError(404, 'Not found.');
  } catch (e) {
    fail(res, e);
  }
}
