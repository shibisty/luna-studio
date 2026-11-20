import { promises as fs, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { normalizeForm, validateSubmission } from 'grapesjs-forms';
import { HttpError, ifMatch, json, queryOf, readBody, readJson, type Req, type Res } from './http';

/**
 * The site folder's forms (grapesjs-forms), as luna-forms keeps them on a
 * server: `forms/<id>.json` (the form as the editor writes it, so it goes
 * into git and is uploaded with the folder), versions in
 * `.studio/forms.json`, and what the editor's preview sends in
 * `.studio/submissions/<id>.json` (files under `.studio/uploads/`).
 */

export const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export interface FormRec {
  id: string;
  name: string;
  fields: unknown[];
  settings?: Record<string, unknown>;
  attrs?: Record<string, string>;
  version: number;
  created_at: string;
  updated_at: string;
}

interface Meta {
  version: number;
  created_at: string;
  updated_at: string;
}

export interface SubmissionRec {
  id: string;
  form_id: string;
  data: Record<string, unknown>;
  meta: Record<string, unknown>;
  created_at: string;
}

/** Submissions kept per form (the preview's; the oldest go). */
const KEEP = 500;

export class FormsStore {
  readonly forms = new Map<string, FormRec>();
  private loaded: Promise<void> | null = null;

  constructor(readonly dir: string) {}

  private get formsDir(): string {
    return path.join(this.dir, 'forms');
  }
  private get studioDir(): string {
    return path.join(this.dir, '.studio');
  }

  load(): Promise<void> {
    if (!this.loaded) this.loaded = this.read();
    return this.loaded;
  }

  private async read(): Promise<void> {
    const meta: Record<string, Meta> = (await readJsonFile(path.join(this.studioDir, 'forms.json'))) || {};
    if (!existsSync(this.formsDir)) return;
    for (const f of await fs.readdir(this.formsDir)) {
      const id = f.replace(/\.json$/, '');
      if (!f.endsWith('.json') || !ID_RE.test(id)) continue;
      const raw = await readJsonFile<Record<string, unknown>>(path.join(this.formsDir, f));
      if (!raw || typeof raw !== 'object') continue;
      const st = await fs.stat(path.join(this.formsDir, f));
      const m = meta[id] || { version: 1, created_at: st.birthtime.toISOString(), updated_at: st.mtime.toISOString() };
      this.forms.set(id, { ...toWrite(raw), id, ...m });
    }
  }

  list(): FormRec[] {
    return [...this.forms.values()].sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
  }

  get(id: string): FormRec {
    const f = this.forms.get(id);
    if (!f) throw new HttpError(404, 'No such form.');
    return f;
  }

  async put(id: string, body: unknown, version: number | null): Promise<{ form: FormRec; created: boolean }> {
    if (!ID_RE.test(id)) throw new HttpError(422, 'The id may have letters, digits, "-" and "_" (64 at most).', { id: ['invalid'] });
    if (!body || typeof body !== 'object' || !Array.isArray((body as any).fields)) throw new HttpError(422, 'A form has a name and fields.', { fields: ['required'] });
    const cur = this.forms.get(id);
    if (version !== null && (!cur || cur.version !== version)) throw new HttpError(412, 'The form was changed in the meantime.');
    const now = new Date().toISOString();
    const form: FormRec = {
      ...toWrite(body as Record<string, unknown>),
      id,
      version: cur ? cur.version + 1 : 1,
      created_at: cur ? cur.created_at : now,
      updated_at: now,
    };
    this.forms.set(id, form);
    await fs.mkdir(this.formsDir, { recursive: true });
    await fs.writeFile(path.join(this.formsDir, `${id}.json`), JSON.stringify(toWrite(form as unknown as Record<string, unknown>), null, 2) + '\n');
    await this.saveMeta();
    return { form, created: !cur };
  }

  async remove(id: string): Promise<void> {
    this.get(id);
    this.forms.delete(id);
    await fs.rm(path.join(this.formsDir, `${id}.json`), { force: true });
    await fs.rm(this.submissionsFile(id), { force: true });
    await fs.rm(path.join(this.studioDir, 'uploads', id), { recursive: true, force: true });
    await this.saveMeta();
  }

  private async saveMeta(): Promise<void> {
    const meta: Record<string, Meta> = {};
    for (const f of this.forms.values()) meta[f.id] = { version: f.version, created_at: f.created_at, updated_at: f.updated_at };
    await fs.mkdir(this.studioDir, { recursive: true });
    await fs.writeFile(path.join(this.studioDir, 'forms.json'), JSON.stringify(meta, null, 2) + '\n');
  }

  private submissionsFile(id: string): string {
    return path.join(this.studioDir, 'submissions', `${id}.json`);
  }

  async submissions(id: string): Promise<SubmissionRec[]> {
    this.get(id);
    return (await readJsonFile<SubmissionRec[]>(this.submissionsFile(id))) || [];
  }

  /**
   * A submission, checked by the plugin's own rules. Files are kept next
   * to it; a filled honeypot is answered like a success and not kept.
   */
  async submit(id: string, data: Record<string, unknown>, meta: Record<string, unknown>, files: Array<{ field: string; name: string; type: string; bytes: Buffer }>): Promise<SubmissionRec | null> {
    const form = this.get(id);
    const def = normalizeForm(form as any);
    const byField = new Map<string, Array<{ name: string; size: number; type: string }>>();
    files.forEach((f) => byField.set(f.field, [...(byField.get(f.field) || []), { name: f.name, size: f.bytes.length, type: f.type }]));
    const raw: Record<string, unknown> = { ...data };
    byField.forEach((list, field) => (raw[field] = list.map((x) => x.name)));
    const r = validateSubmission(def, raw);
    if (r.spam) return null;
    if (!r.ok) throw new HttpError(422, 'Check the highlighted fields.', r.errors as Record<string, string[]>);
    const sid = randomUUID();
    const clean: Record<string, unknown> = { ...r.data };
    byField.forEach((list, field) => (clean[field] = list));
    if (files.length) {
      const dir = path.join(this.studioDir, 'uploads', id, sid);
      await fs.mkdir(dir, { recursive: true });
      for (const f of files) await fs.writeFile(path.join(dir, path.basename(f.name).replace(/[\\/:*?"<>|]/g, '_') || 'file'), f.bytes);
    }
    const sub: SubmissionRec = { id: sid, form_id: id, data: clean, meta: { ...pick(meta, ['url', 'referrer', 'lang', 'page_id']), preview: true }, created_at: new Date().toISOString() };
    const list = [sub, ...(await this.submissions(id))].slice(0, KEEP);
    await fs.mkdir(path.dirname(this.submissionsFile(id)), { recursive: true });
    await fs.writeFile(this.submissionsFile(id), JSON.stringify(list) + '\n');
    return sub;
  }

  async deleteSubmission(id: string, sid: string): Promise<void> {
    const list = await this.submissions(id);
    const next = list.filter((s) => s.id !== sid);
    if (next.length === list.length) throw new HttpError(404, 'No such submission.');
    await fs.writeFile(this.submissionsFile(id), JSON.stringify(next) + '\n');
    await fs.rm(path.join(this.studioDir, 'uploads', id, sid), { recursive: true, force: true });
  }
}

/** What a form file holds: the editor's JSON without the server's fields. */
function toWrite(raw: Record<string, unknown>): Pick<FormRec, 'name' | 'fields' | 'settings' | 'attrs'> {
  const out: Pick<FormRec, 'name' | 'fields' | 'settings' | 'attrs'> = {
    name: typeof raw.name === 'string' ? raw.name : '',
    fields: Array.isArray(raw.fields) ? raw.fields : [],
  };
  if (raw.settings && typeof raw.settings === 'object') out.settings = raw.settings as Record<string, unknown>;
  if (raw.attrs && typeof raw.attrs === 'object') out.attrs = raw.attrs as Record<string, string>;
  return out;
}

function pick(o: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  keys.forEach((k) => {
    if (typeof o[k] === 'string') out[k] = String(o[k]).slice(0, 2048);
  });
  return out;
}

async function readJsonFile<T>(f: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(f, 'utf8')) as T;
  } catch {
    return null;
  }
}

/**
 * grapesjs-forms' REST contract (its openapi.yaml) over the folder:
 * `/forms`, `/forms/{id}`, `/forms/{id}/submissions[/{sid}]`, and `/info`.
 * Mounted at `/studio/local/forms`.
 */
export async function formsApi(store: FormsStore, req: Req, res: Res, p: string): Promise<void> {
  await store.load();
  const method = (req.method || 'GET').toUpperCase();
  const etag = (f: FormRec) => ({ ETag: `"${f.version}"` });
  if (p === '/info' && method === 'GET') return json(res, 200, { submit_url: '/studio/local/forms', runtime_url: '/editor/grapesjs-forms-runtime.js', files: true });
  if ((p === '/forms' || p === '/forms/') && method === 'GET') return json(res, 200, { items: store.list() });
  let m = p.match(/^\/forms\/([^/]+)\/?$/);
  if (m) {
    const id = decodeURIComponent(m[1]);
    if (method === 'GET') {
      const f = store.get(id);
      return json(res, 200, f, etag(f));
    }
    if (method === 'PUT') {
      const { form, created } = await store.put(id, await readJson(req), ifMatch(req));
      return json(res, created ? 201 : 200, form, etag(form));
    }
    if (method === 'DELETE') {
      await store.remove(id);
      return json(res, 204);
    }
    throw new HttpError(405, 'Method not allowed.');
  }
  m = p.match(/^\/forms\/([^/]+)\/submissions(?:\/([^/]+))?\/?$/);
  if (m) {
    const id = decodeURIComponent(m[1]);
    if (m[2]) {
      if (method !== 'DELETE') throw new HttpError(405, 'Method not allowed.');
      await store.deleteSubmission(id, decodeURIComponent(m[2]));
      return json(res, 204);
    }
    if (method === 'GET') {
      const q = queryOf(req);
      const limit = Math.min(Math.max(Number(q.get('limit')) || 50, 1), 200);
      const offset = Math.max(Number(q.get('offset')) || 0, 0);
      const all = await store.submissions(id);
      return json(res, 200, { items: all.slice(offset, offset + limit), total: all.length });
    }
    if (method === 'POST') {
      const { data, meta, files } = await readSubmission(req);
      const sub = await store.submit(id, data, meta, files);
      return json(res, 201, { id: sub ? sub.id : randomUUID() });
    }
    throw new HttpError(405, 'Method not allowed.');
  }
  throw new HttpError(404, 'Not found.');
}

/** `{ data, meta }` JSON, or multipart with `_meta` and files. */
async function readSubmission(req: Req): Promise<{ data: Record<string, unknown>; meta: Record<string, unknown>; files: Array<{ field: string; name: string; type: string; bytes: Buffer }> }> {
  const ct = String(req.headers['content-type'] || '');
  if (!/^multipart\/form-data/i.test(ct)) {
    const b = (await readJson(req)) || {};
    return { data: obj(b.data), meta: obj(b.meta), files: [] };
  }
  const body = await readBody(req, 64 * 1024 * 1024);
  const fd = await new Response(body, { headers: { 'content-type': ct } }).formData();
  const data: Record<string, unknown> = {};
  const files: Array<{ field: string; name: string; type: string; bytes: Buffer }> = [];
  let meta: Record<string, unknown> = {};
  for (const [k, v] of fd.entries()) {
    if (typeof v !== 'string') {
      if (v.size) files.push({ field: k, name: v.name, type: v.type, bytes: Buffer.from(await v.arrayBuffer()) });
      continue;
    }
    if (k === '_meta') {
      try {
        meta = obj(JSON.parse(v));
      } catch {
        meta = {};
      }
      continue;
    }
    const prev = data[k];
    data[k] = prev === undefined ? v : Array.isArray(prev) ? [...prev, v] : [prev, v];
  }
  return { data, meta, files };
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
