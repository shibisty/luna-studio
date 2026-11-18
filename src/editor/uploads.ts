import type { Words } from './words';

type AnyEditor = any;

/** The application's luna-files drive, as the dashboard (or the studio's proxy) offers it. */
export interface FilesConfig {
  /** Base URL of the files API proxy (`/apps/x/files/api`). */
  api: string;
  /** Largest file sent through the proxy; bigger ones go straight to the storage (presigned). */
  max: number;
  /** Headers for every call (a CSRF token). */
  headers?: () => Record<string, string>;
  /** `fetch` credentials (`same-origin` by default). */
  credentials?: RequestCredentials;
}

/**
 * Images in luna-files: the asset manager lists the application's public
 * images and uploads new ones there (public, a free name when one is
 * taken, the same content again is the file already there).
 */
export function uploader(files: FilesConfig, words: Words, say: (text: string, isError: boolean) => void) {
  const call = (method: string, path: string, body?: BodyInit, extra: Record<string, string> = {}) => {
    const h = { Accept: 'application/json', ...(files.headers ? files.headers() : {}), ...extra };
    return fetch(files.api + path, { method, credentials: files.credentials || 'same-origin', headers: h, body }).then((r) =>
      r
        .json()
        .catch(() => ({}))
        .then((b: any) => {
          if (!r.ok) throw new Error(b.error || r.statusText);
          return b;
        })
    );
  };
  const asset = (f: any) => ({ type: 'image', src: f.url, name: f.name, width: f.width, height: f.height, luna_file: f.id });
  const sha256 = async (file: File): Promise<string> => {
    if (!globalThis.crypto || !crypto.subtle || file.size > 64 * 1024 * 1024) return '';
    try {
      const d = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
      return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, '0')).join('');
    } catch {
      return '';
    }
  };
  const uploadOne = async (file: File): Promise<any> => {
    if (file.size <= files.max) {
      const fd = new FormData();
      fd.append('visibility', 'public');
      fd.append('rename', '1');
      fd.append('dedupe', '1');
      fd.append('file', file, file.name);
      return call('POST', '/files', fd);
    }
    const json = { 'Content-Type': 'application/json' };
    const sum = await sha256(file);
    const meta: Record<string, unknown> = { name: file.name, size: file.size, mime: file.type, visibility: 'public', rename: true, dedupe: !!sum };
    if (sum) meta.sha256 = sum;
    const s = await call('POST', '/uploads', JSON.stringify(meta), json);
    if (!s.upload) return s.file; // already there
    const r = await fetch(s.upload.url, { method: s.upload.method, headers: s.upload.headers || {}, body: file });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return call('POST', '/files/' + s.file.id + '/complete', '{}', json);
  };
  /** GrapesJS calls it as the uploader (`this`), with the input's or a drop's event. */
  function uploadFiles(this: any, ev: any, clb?: (res: unknown) => void): void {
    const self = this;
    const dt = ev.dataTransfer;
    const list: File[] = [].slice.call((dt ? dt.files : ev.target.files) || []);
    const images = list.filter((f) => /^image\//.test(f.type));
    if (!images.length) {
      if (list.length) say(words.imagesOnly, true);
      return;
    }
    self.onUploadStart && self.onUploadStart();
    images
      .reduce<Promise<any[]>>((p, f) => p.then((out) => uploadOne(f).then((r) => (out.push(asset(r)), out))), Promise.resolve([]))
      .then(
        (out) => {
          const res = { data: out };
          const ed = self.em ? self.em.getEditor() : (window as any).editor;
          const have: Record<string, boolean> = {};
          ed.AssetManager.getAll().forEach((x: any) => (have[x.get('src')] = true));
          ed.AssetManager.add(out.filter((x) => !have[x.src]));
          self.onUploadEnd && self.onUploadEnd(res);
          clb && clb(res);
        },
        (e) => {
          say(words.uploadFailed + ' ' + e.message, true);
          self.onUploadError && self.onUploadError(e);
        }
      );
  }
  const loadImages = (ed: AnyEditor): void => {
    call('GET', '/files?images=1&all=1&limit=500').then(
      (p) => {
        const have: Record<string, boolean> = {};
        ed.AssetManager.getAll().forEach((a: any) => (have[a.get('src')] = true));
        ed.AssetManager.add((p.data || []).filter((f: any) => f.url && !have[f.url]).map(asset));
      },
      (e) => say(words.uploadFailed + ' ' + e.message, true)
    );
  };
  return { uploadFiles, loadImages };
}
