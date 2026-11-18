import { promises as fs, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { archiveFiles, packArchive, readArchiveFiles, type ArchiveRecord } from 'grapesjs-site-pages/archive';

/**
 * A site kept as a folder: the layout of a grapesjs-pages archive
 * (manifest.json, site/, layouts/, templates/, pages/), so the folder can
 * be zipped and imported anywhere, opened in other tools and put in git.
 * What the archive has no place for lives in `.studio/`: versions and
 * publish state (state.json), entries of templates (entries.json),
 * published revisions (revisions/<id>.json).
 *
 * Everything is held in memory; changes are written back (debounced),
 * only the files whose contents changed.
 */

export type Kind = 'site' | 'layout' | 'template' | 'page';

export interface Rec {
  kind: Kind;
  id: string;
  name: string;
  version: number;
  created_at: string;
  updated_at: string;
  data: unknown;
  /* pages */
  slug?: string;
  layout_id?: string | null;
  template_id?: string | null;
  parent_id?: string | null;
  position?: number;
  status?: 'draft' | 'published' | 'archived';
  published_at?: string | null;
  values?: Record<string, unknown>;
  /** An entry's published values. */
  live_values?: Record<string, unknown>;
  /* templates */
  fields?: unknown[];
  /* the site */
  settings?: Record<string, unknown>;
  /** What the last publish sent (pages, layouts, templates: html + css; the site: css). */
  published?: { html?: string; css: string } | null;
}

export interface Revision {
  revision: number;
  created_at: string;
  created_by: string;
  html?: string;
  css: string;
  data: unknown;
}

interface State {
  records: Record<string, { version: number; created_at: string; updated_at: string; status?: string; published_at?: string | null }>;
}

const KEEP_REVISIONS = 20;
const now = () => new Date().toISOString();
const SITE_ID = 'site';

export class StoreError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly errors?: Record<string, string[]>
  ) {
    super(message);
  }
}

const invalid = (field: string, msg: string) => new StoreError(422, 'The given data was invalid.', { [field]: [msg] });

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `/` or `/a/b-c`; throws on anything else. */
export function normalizeSlug(raw: string): string {
  const parts = String(raw || '')
    .toLowerCase()
    .split('/')
    .map((p) =>
      p
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
    )
    .filter(Boolean);
  return '/' + parts.join('/');
}

/** The files a record of the archive layout owns in its folder. */
const OWNED = new Set(['project.json', 'body.html', 'style.css', 'index.html', 'fields.json', 'settings.json']);

export class SiteStore {
  readonly records = new Map<string, Rec>();
  private revisions = new Map<string, Revision[]>();
  private written = new Map<string, string>();
  private timer: NodeJS.Timeout | null = null;
  private saving: Promise<void> = Promise.resolve();
  private dirtyRevisions = new Set<string>();
  /** Records that were taken from HTML edited outside, at the last load. */
  edited: string[] = [];

  constructor(
    readonly dir: string,
    private readonly opts: { saveDelay?: number } = {}
  ) {}

  /* ------------------------- disk ------------------------- */

  private get studioDir(): string {
    return path.join(this.dir, '.studio');
  }

  /** Reads the folder (creates an empty site when there is none). */
  async load(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    this.records.clear();
    this.revisions.clear();
    this.written.clear();
    const files: Record<string, string> = {};
    const walk = async (rel: string): Promise<void> => {
      const abs = path.join(this.dir, rel);
      for (const e of await fs.readdir(abs, { withFileTypes: true })) {
        if (e.name.startsWith('.') || e.name === 'node_modules') continue;
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) await walk(r);
        else if (rel === '' ? e.name === 'manifest.json' : OWNED.has(e.name)) files[r] = await fs.readFile(path.join(abs, e.name), 'utf8');
      }
    };
    await walk('');
    const state = (await this.readJson<State>(path.join(this.studioDir, 'state.json'))) || { records: {} };
    const t = now();
    if (files['manifest.json']) {
      const arc = readArchiveFiles(files);
      this.edited = arc.edited;
      for (const a of arc.records) {
        const st = state.records[a.id] || { version: 1, created_at: t, updated_at: t };
        const rec: Rec = { kind: a.kind, id: a.id, name: a.name, version: st.version, created_at: st.created_at, updated_at: st.updated_at, data: a.data };
        if (a.kind === 'page') {
          rec.slug = a.slug ? normalizeSlug(a.slug) : '/' + (a.name || 'page');
          rec.parent_id = a.parentId ?? null;
          rec.layout_id = a.layoutId ?? null;
          rec.template_id = null;
          rec.position = a.position ?? 0;
          rec.values = a.values || {};
          rec.status = (st.status as Rec['status']) || 'draft';
          rec.published_at = st.published_at ?? null;
        }
        if (a.kind === 'template') rec.fields = a.fields || [];
        if (a.kind === 'site') rec.settings = a.values || {};
        if (a.html != null || a.css != null) rec.published = { ...(a.kind === 'site' ? {} : { html: a.html ?? '' }), css: a.css ?? '' };
        // Edited outside: a new version, so open editors take it.
        if (arc.edited.includes(a.id)) rec.version++;
        this.records.set(rec.id, rec);
      }
      // What is on disk now is what was written.
      Object.entries(files).forEach(([p, s]) => this.written.set(p, s));
    }
    for (const e of (await this.readJson<Rec[]>(path.join(this.studioDir, 'entries.json'))) || []) {
      if (e && e.id && e.template_id) this.records.set(e.id, { ...e, kind: 'page' });
    }
    if (!this.records.has(SITE_ID)) {
      this.records.set(SITE_ID, { kind: 'site', id: SITE_ID, name: path.basename(path.resolve(this.dir)), version: 1, created_at: t, updated_at: t, data: null, settings: {} });
    }
    const revDir = path.join(this.studioDir, 'revisions');
    if (existsSync(revDir)) {
      for (const f of await fs.readdir(revDir)) {
        if (!f.endsWith('.json')) continue;
        const list = await this.readJson<Revision[]>(path.join(revDir, f));
        if (Array.isArray(list)) this.revisions.set(f.slice(0, -5), list);
      }
    }
    if (!files['manifest.json'] || this.edited.length) this.changed();
  }

  private async readJson<T>(file: string): Promise<T | undefined> {
    try {
      return JSON.parse(await fs.readFile(file, 'utf8')) as T;
    } catch {
      return undefined;
    }
  }

  /** The designs as archive records (no entries). */
  archiveRecords(): ArchiveRecord[] {
    const out: ArchiveRecord[] = [];
    const order: Kind[] = ['site', 'layout', 'template', 'page'];
    const recs = [...this.records.values()]
      .filter((r) => !(r.kind === 'page' && r.template_id))
      .sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || a.created_at.localeCompare(b.created_at));
    for (const r of recs) {
      const a: ArchiveRecord = { id: r.id, kind: r.kind, name: r.name, data: (r.data ?? null) as any };
      if (r.kind === 'page') {
        a.slug = r.slug;
        a.parentId = r.parent_id ?? null;
        a.layoutId = r.layout_id ?? null;
        a.position = r.position ?? 0;
        if (r.values && Object.keys(r.values).length) a.values = r.values;
      }
      if (r.kind === 'template') a.fields = r.fields || [];
      if (r.kind === 'site') a.values = r.settings || {};
      if (r.published) {
        if (r.kind !== 'site') a.html = r.published.html ?? '';
        a.css = r.published.css;
      }
      out.push(a);
    }
    return out;
  }

  /** The site as a ZIP (what the folder holds, without `.studio`). */
  zip(): Uint8Array {
    const site = this.records.get(SITE_ID);
    return packArchive(this.archiveRecords(), { generator: 'luna-studio', source: 'local', name: site?.name || undefined });
  }

  /** Something changed: write soon. */
  changed(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.opts.saveDelay ?? 200);
  }

  /** Writes what changed now. */
  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.saving = this.saving.then(() => this.write()).catch((e) => console.error('[luna-studio] cannot save the site:', e));
    return this.saving;
  }

  private async write(): Promise<void> {
    const site = this.records.get(SITE_ID);
    const files = archiveFiles(this.archiveRecords(), { generator: 'luna-studio', name: site?.name || undefined });
    // createdAt changes every time: keep the manifest's date unless something else changed.
    const prev = this.written.get('manifest.json');
    if (prev) {
      const strip = (s: string) => s.replace(/"createdAt": "[^"]*",/, '');
      if (strip(prev) === strip(files['manifest.json'])) files['manifest.json'] = prev;
    }
    for (const [p, s] of Object.entries(files)) {
      if (this.written.get(p) === s) continue;
      const abs = path.join(this.dir, p);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, s);
      this.written.set(p, s);
    }
    // Files of records that moved or are gone; then their folders, when empty.
    for (const p of [...this.written.keys()]) {
      if (p in files) continue;
      this.written.delete(p);
      await fs.rm(path.join(this.dir, p), { force: true });
      let d = path.dirname(path.join(this.dir, p));
      while (d.startsWith(path.resolve(this.dir) + path.sep)) {
        try {
          await fs.rmdir(d);
        } catch {
          break; // not empty
        }
        d = path.dirname(d);
      }
    }
    await fs.mkdir(path.join(this.studioDir, 'revisions'), { recursive: true });
    const state: State = { records: {} };
    for (const r of this.records.values()) {
      if (r.kind === 'page' && r.template_id) continue;
      state.records[r.id] = { version: r.version, created_at: r.created_at, updated_at: r.updated_at, ...(r.kind === 'page' ? { status: r.status, published_at: r.published_at ?? null } : {}) };
    }
    await this.writeIfChanged('.studio/state.json', JSON.stringify(state, null, 2) + '\n');
    const entries = [...this.records.values()].filter((r) => r.kind === 'page' && r.template_id);
    await this.writeIfChanged('.studio/entries.json', JSON.stringify(entries, null, 2) + '\n');
    for (const id of this.dirtyRevisions) {
      const list = this.revisions.get(id);
      const f = path.join(this.studioDir, 'revisions', `${id}.json`);
      if (list && list.length) await fs.writeFile(f, JSON.stringify(list) + '\n');
      else await fs.rm(f, { force: true });
    }
    this.dirtyRevisions.clear();
    await this.writeIfChanged('.studio/README.txt', 'luna-studio keeps versions, publish state, entries and revisions here.\nThe rest of the folder is a grapesjs-pages site archive.\n');
  }

  private async writeIfChanged(rel: string, s: string): Promise<void> {
    if (this.written.get(rel) === s) return;
    await fs.writeFile(path.join(this.dir, rel), s);
    this.written.set(rel, s);
  }

  /* ------------------------- records ------------------------- */

  get(kind: Kind, id: string): Rec {
    const r = this.records.get(kind === 'site' ? SITE_ID : id.toLowerCase());
    if (!r || r.kind !== kind) throw new StoreError(404, 'Not found.');
    return r;
  }

  list(kind: Exclude<Kind, 'site'>): Rec[] {
    return [...this.records.values()]
      .filter((r) => r.kind === kind)
      .sort((a, b) => (kind === 'page' ? (a.position ?? 0) - (b.position ?? 0) : 0) || a.created_at.localeCompare(b.created_at));
  }

  private check(rec: Rec | undefined, ifMatch: number | null): void {
    if (ifMatch == null) return;
    if (!rec || rec.version !== ifMatch) throw new StoreError(412, 'Changed since you loaded it (If-Match does not match the current version).');
  }

  private bump(rec: Rec): void {
    rec.version++;
    rec.updated_at = now();
  }

  private freeSlug(base: string, self: string): string {
    const taken = (s: string) => [...this.records.values()].some((r) => r.kind === 'page' && r.id !== self && r.slug === s);
    if (!taken(base)) return base;
    for (let n = 2; n < 1000; n++) if (!taken(`${base}-${n}`)) return `${base}-${n}`;
    throw invalid('slug', `Choose a slug: ${base} is taken.`);
  }

  private ref(field: string, value: unknown, kind: Kind, self?: string): string | null | undefined {
    if (value === undefined) return undefined;
    if (value === null || value === '') return null;
    const id = String(value).toLowerCase();
    if (!UUID_RE.test(id)) throw invalid(field, 'Not an id.');
    if (self && id === self) throw invalid(field, 'A page cannot be its own parent.');
    const r = this.records.get(id);
    if (!r || r.kind !== kind) throw invalid(field, `No such ${kind}.`);
    return id;
  }

  /** PUT of a layout, template or page (contract v2). Returns the record and whether it was created. */
  put(kind: Exclude<Kind, 'site'>, rawId: string, body: any, ifMatch: number | null): { rec: Rec; created: boolean } {
    const id = rawId.toLowerCase();
    if (!UUID_RE.test(id)) throw invalid('id', 'The id must be a UUID the editor generates.');
    const cur = this.records.get(id);
    if (cur && cur.kind !== kind) throw invalid('id', 'This id belongs to another kind of record.');
    this.check(cur, ifMatch);
    if (!cur && ifMatch != null) throw new StoreError(412, 'Gone.');
    const name = String(body?.name ?? '').trim();
    if (!name) throw invalid('name', 'The name is required.');
    if (name.length > 200) throw invalid('name', 'At most 200 characters.');
    const t = now();
    const rec: Rec = cur ? { ...cur } : { kind, id, name, version: 0, created_at: t, updated_at: t, data: null };
    rec.name = name;
    if (body.data !== undefined && body.data !== null) rec.data = body.data;
    if (kind === 'template') {
      if (body.fields !== undefined) {
        if (!Array.isArray(body.fields)) throw invalid('fields', 'A list of fields.');
        rec.fields = body.fields;
      } else rec.fields = rec.fields || [];
    }
    if (kind === 'page') {
      const layout = this.ref('layout_id', body.layout_id, 'layout');
      const template = this.ref('template_id', body.template_id, 'template');
      const parent = this.ref('parent_id', body.parent_id, 'page', id);
      if (layout !== undefined) rec.layout_id = layout;
      if (template !== undefined) rec.template_id = template;
      if (parent !== undefined) rec.parent_id = parent;
      rec.layout_id ??= null;
      rec.template_id ??= null;
      rec.parent_id ??= null;
      if (body.position !== undefined) rec.position = Math.trunc(Number(body.position) || 0);
      rec.position ??= 0;
      if (body.slug !== undefined) {
        const s = normalizeSlug(body.slug);
        if ([...this.records.values()].some((r) => r.kind === 'page' && r.id !== id && r.slug === s)) {
          throw invalid('slug', `Another page already has the slug ${s}.`);
        }
        rec.slug = s;
      } else if (!rec.slug) rec.slug = this.freeSlug(normalizeSlug(name) === '/' ? '/page' : normalizeSlug(name), id);
      rec.values = { ...(rec.values || {}) };
      if (body.values && typeof body.values === 'object') {
        Object.entries(body.values as Record<string, unknown>).forEach(([k, v]) => {
          if (v === null) delete rec.values![k];
          else rec.values![k] = v;
        });
      }
      rec.status ??= 'draft';
      rec.published_at ??= null;
    }
    this.bump(rec);
    this.records.set(id, rec);
    this.changed();
    return { rec, created: !cur };
  }

  putSite(body: any, ifMatch: number | null): Rec {
    const site = this.records.get(SITE_ID)!;
    this.check(site, ifMatch);
    if (body?.name !== undefined) site.name = String(body.name).slice(0, 200);
    if (body?.settings && typeof body.settings === 'object') site.settings = body.settings;
    if (body?.data) site.data = body.data;
    this.bump(site);
    this.changed();
    return site;
  }

  delete(kind: Exclude<Kind, 'site'>, id: string, ifMatch: number | null): void {
    const rec = this.get(kind, id);
    this.check(rec, ifMatch);
    if (kind === 'template' && [...this.records.values()].some((r) => r.template_id === rec.id)) {
      throw new StoreError(409, 'Pages still use this template.');
    }
    this.records.delete(rec.id);
    for (const r of this.records.values()) {
      if (r.layout_id === rec.id) r.layout_id = null;
      if (r.parent_id === rec.id) r.parent_id = null;
    }
    this.revisions.delete(rec.id);
    this.dirtyRevisions.add(rec.id);
    this.changed();
  }

  /** Makes a record live: its markup (a page, layout, template), the site's CSS, an entry's values. */
  publish(kind: Kind, id: string, body: any, ifMatch: number | null, by = 'studio'): { rec: Rec; revision: number; warnings: string[] } {
    const rec = this.get(kind, id);
    this.check(rec, ifMatch);
    if (body?.data) rec.data = body.data;
    const warnings: string[] = [];
    const entry = kind === 'page' && !!rec.template_id;
    let revision = 0;
    if (entry) {
      rec.live_values = { ...(rec.values || {}) };
    } else {
      if (kind !== 'site' && typeof body?.html !== 'string') throw invalid('html', 'Send the HTML.');
      const html = kind === 'site' ? undefined : String(body.html);
      const css = String(body?.css ?? '');
      if (kind === 'layout' && !/<(page-slot|luna-slot)\b|data-(page|luna)-slot/.test(html!)) throw invalid('html', 'A layout needs a <page-slot> where the page goes.');
      if (kind === 'template') {
        for (const f of (rec.fields || []) as Array<{ name?: string }>) {
          if (f?.name && !new RegExp(`data-field=["']${f.name}["']|\\{\\{\\s*${f.name}\\s*\\}\\}`).test(html!)) {
            warnings.push(`The field ${f.name} has no element in the template.`);
          }
        }
      }
      rec.published = kind === 'site' ? { css } : { html, css };
      const list = this.revisions.get(rec.id) || [];
      revision = (list[0]?.revision || 0) + 1;
      list.unshift({ revision, created_at: now(), created_by: by, ...(html !== undefined ? { html } : {}), css, data: rec.data });
      this.revisions.set(rec.id, list.slice(0, KEEP_REVISIONS));
      this.dirtyRevisions.add(rec.id);
    }
    if (kind === 'page') {
      rec.status = 'published';
      rec.published_at = now();
    }
    this.bump(rec);
    this.changed();
    return { rec, revision, warnings };
  }

  unpublish(id: string, ifMatch: number | null): Rec {
    const rec = this.get('page', id);
    this.check(rec, ifMatch);
    rec.status = 'draft';
    this.bump(rec);
    this.changed();
    return rec;
  }

  revisionList(kind: Kind, id: string): Array<{ revision: number; created_at: string; created_by: string; live: boolean }> {
    const rec = this.get(kind, id);
    return (this.revisions.get(rec.id) || []).map((r, i) => ({ revision: r.revision, created_at: r.created_at, created_by: r.created_by, live: i === 0 }));
  }

  restore(kind: Exclude<Kind, 'site'>, id: string, revision: number, ifMatch: number | null): Rec {
    const rec = this.get(kind, id);
    this.check(rec, ifMatch);
    const r = (this.revisions.get(rec.id) || []).find((x) => x.revision === revision);
    if (!r) throw new StoreError(404, 'No such revision.');
    rec.data = r.data;
    this.bump(rec);
    this.changed();
    return rec;
  }

  /* ------------------------- content API (grapesjs-storage) ------------------------- */

  /** Saves a template's fields (no new version: grapesjs-pages keeps its If-Match). */
  putTemplateFields(rawId: string, body: any): { rec: Rec; created: boolean } {
    const id = rawId.toLowerCase();
    const cur = this.records.get(id);
    if (!Array.isArray(body?.fields)) throw invalid('fields', 'A list of fields.');
    if (!cur) {
      const { rec } = this.put('template', id, { name: body.name, fields: body.fields, data: body.data }, null);
      return { rec, created: true };
    }
    if (cur.kind !== 'template') throw new StoreError(404, 'Not found.');
    cur.fields = body.fields;
    if (body.name) cur.name = String(body.name).trim() || cur.name;
    if (body.data) {
      cur.data = body.data;
      this.bump(cur);
    }
    this.changed();
    return { rec: cur, created: false };
  }

  entries(template?: string): Rec[] {
    return [...this.records.values()].filter((r) => r.kind === 'page' && r.template_id && (!template || r.template_id === template));
  }

  putEntry(rawId: string, body: any, ifMatch: number | null): { rec: Rec; created: boolean } {
    const id = rawId.toLowerCase();
    const cur = this.records.get(id);
    if (cur && !(cur.kind === 'page' && cur.template_id)) throw invalid('id', 'Not an entry.');
    const values: Record<string, unknown> = {};
    if (body?.values && typeof body.values === 'object') {
      Object.entries(body.values as Record<string, unknown>).forEach(([k, v]) => (values[`field.${k}`] = v));
    }
    return this.put('page', id, {
      name: body?.name,
      ...(body?.slug !== undefined ? { slug: body.slug } : {}),
      template_id: body?.template_id ?? cur?.template_id,
      values,
    }, ifMatch);
  }

  /**
   * Replaces the designs with an archive's (a "pull" of another site into
   * this folder). Entries stay. Versions move on, so open editors reload.
   */
  replaceAll(arc: { records: ArchiveRecord[] }): number {
    const old = this.records;
    const t = now();
    for (const [id, r] of [...old]) if (!(r.kind === 'page' && r.template_id)) old.delete(id);
    for (const a of arc.records) {
      const rec: Rec = { kind: a.kind, id: a.kind === 'site' ? SITE_ID : a.id.toLowerCase(), name: a.name, version: 1, created_at: t, updated_at: t, data: a.data ?? null };
      if (a.kind === 'page') {
        rec.slug = a.slug ? normalizeSlug(a.slug) : normalizeSlug(a.name);
        rec.parent_id = a.parentId ?? null;
        rec.layout_id = a.layoutId ?? null;
        rec.template_id = null;
        rec.position = a.position ?? 0;
        rec.values = a.values || {};
        rec.status = a.html != null ? 'published' : 'draft';
        rec.published_at = a.html != null ? t : null;
      }
      if (a.kind === 'template') rec.fields = a.fields || [];
      if (a.kind === 'site') rec.settings = a.values || {};
      if (a.html != null || a.css != null) rec.published = { ...(a.kind === 'site' ? {} : { html: a.html ?? '' }), css: a.css ?? '' };
      old.set(rec.id, rec);
    }
    if (!old.has(SITE_ID)) old.set(SITE_ID, { kind: 'site', id: SITE_ID, name: path.basename(path.resolve(this.dir)), version: 1, created_at: t, updated_at: t, data: null, settings: {} });
    // Versions above anything an open editor has seen.
    const top = Math.max(0, ...[...old.values()].map((r) => r.version));
    for (const r of old.values()) if (!(r.kind === 'page' && r.template_id)) r.version = top + 1;
    this.changed();
    return arc.records.length;
  }

  newId(): string {
    return randomUUID();
  }
}

/** An entry as the content API shows it (plain value keys). */
export function entryJSON(r: Rec, live = false) {
  const src = (live ? r.live_values : r.values) || {};
  const values: Record<string, unknown> = {};
  Object.entries(src).forEach(([k, v]) => {
    if (k.startsWith('field.')) values[k.slice(6)] = v;
  });
  return { id: r.id, template_id: r.template_id, name: r.name, slug: r.slug, status: r.status, values, version: r.version, updated_at: r.updated_at, published_at: r.published_at ?? null };
}
