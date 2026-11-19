/**
 * The editor's end of Luna Studio's MCP server (src/mcp): a GrapesJS plugin
 * that connects to the server's WebSocket on 127.0.0.1 and runs what Claude
 * asks for through the GrapesJS and grapesjs-pages APIs. Based on
 * grapesjs-mcp's grapesjs-mcp-bridge.js.
 *
 * There is no "run any JavaScript" method, on purpose.
 */
import { toJpeg, toPng } from 'html-to-image';

type AnyEditor = any;

export interface McpBridgeOptions {
  /** The server's WebSocket (default `ws://127.0.0.1:8765`). */
  url?: string;
  /** The server's GJS_MCP_TOKEN, if it has one. */
  token?: string;
  /** Reconnect when the server is not there or goes away (default true): 1 s, doubling up to 10 s. */
  autoReconnect?: boolean;
  /** Connected or not. */
  onStatus?: (connected: boolean) => void;
  /** A dot in the corner showing the connection (default false). */
  badge?: boolean;
}

export const DEFAULT_MCP_URL = 'ws://127.0.0.1:8765';

const DEVICES = ['desktop', 'tablet', 'mobile'];

export function mcpBridge(opts: McpBridgeOptions = {}) {
  const o = { url: DEFAULT_MCP_URL, token: '', autoReconnect: true, badge: false, ...opts };

  return (editor: AnyEditor) => {
    const wrapper = () => editor.getWrapper();
    const pm = () => editor.PagesManager || null;
    const esc = (s: string) => (window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/[^\w-]/g, '\\$&'));

    function findComp(id?: string): any {
      if (!id || id === 'root' || id === 'wrapper') return wrapper();
      const map = editor.Components.allById ? editor.Components.allById() : null;
      if (map && map[id]) return map[id];
      const sel = /^[#.]/.test(id) ? id : '#' + esc(id);
      try {
        const r = wrapper().find(sel)[0];
        if (r) return r;
      } catch {
        /* not a selector */
      }
      throw new Error('Component not found: ' + id);
    }

    function ser(c: any, depth: number): any {
      if (c.get('type') === 'textnode') {
        const t = String(c.get('content') || '');
        return { type: 'textnode', text: t.length > 200 ? t.slice(0, 200) + '…' : t };
      }
      const out: any = { id: c === wrapper() ? 'root' : c.getId(), type: c.get('type') || 'default', tag: c.get('tagName') || 'div' };
      const classes = c.getClasses ? c.getClasses() : [];
      if (classes.length) out.classes = classes;
      const attrs = { ...(c.getAttributes ? c.getAttributes() : {}) };
      delete attrs.id;
      delete attrs.class;
      if (Object.keys(attrs).length) out.attributes = attrs;
      const kids = c.components();
      if (!kids.length && c.get('type') === 'text') {
        const t = String(c.getInnerHTML ? c.getInnerHTML() : '');
        if (t) out.text = t.length > 200 ? t.slice(0, 200) + '…' : t;
      }
      if (kids.length) {
        if (depth > 0) out.children = kids.map((k: any) => ser(k, depth - 1));
        else out.childCount = kids.length;
      }
      return out;
    }

    function insert(target: any, content: unknown, pos = 'append'): any {
      if (pos === 'append') return target.append(content);
      if (pos === 'prepend') return target.append(content, { at: 0 });
      const parent = target.parent();
      if (!parent) throw new Error(`Cannot insert "${pos}" the root`);
      const idx = parent.components().indexOf(target);
      return parent.append(content, { at: pos === 'before' ? idx : idx + 1 });
    }
    const ids = (added: any) => (Array.isArray(added) ? added : [added]).map((c: any) => c.getId());
    const plain = (s: unknown) => String(s == null ? '' : s).replace(/<[^>]*>/g, '').trim().slice(0, 80);

    const summary = (r: any, active?: string | null) => ({
      id: r.id,
      kind: r.kind || 'page',
      name: r.name,
      ...(r.slug != null ? { slug: r.slug } : {}),
      ...(r.layoutId ? { layoutId: r.layoutId } : {}),
      ...(r.parentId ? { parentId: r.parentId } : {}),
      ...(r.position != null ? { position: r.position } : {}),
      ...(r.status ? { status: r.status } : {}),
      ...(r.values && Object.keys(r.values).length ? { values: r.values } : {}),
      ...(r.conflict ? { conflict: true } : {}),
      ...(active !== undefined && r.id === active ? { open: true } : {}),
    });
    const needPages = () => {
      const p = pm();
      if (!p) throw new Error('grapesjs-pages is not in this editor.');
      return p;
    };
    const record = async (id: string) => {
      const r = (await needPages().list()).find((x: any) => x.id === id);
      if (!r) throw new Error('Record not found: ' + id + ' (see list_records)');
      return r;
    };
    // An undo or redo still running (the user's Ctrl+Z) must finish before another record opens.
    const historySettled = async (p: any) => {
      try {
        await p.queue;
      } catch {
        /* its own error */
      }
    };
    const current = async () => {
      const p = pm();
      const id = p && p.getActiveId();
      if (!id) return null;
      const r = (await p.list()).find((x: any) => x.id === id);
      return r ? summary(r) : { id };
    };
    const history = () => {
      const p = pm();
      return p ? { canUndo: p.canUndo(), canRedo: p.canRedo() } : { canUndo: editor.UndoManager.hasUndo(), canRedo: editor.UndoManager.hasRedo() };
    };
    const deviceId = () => {
      const d = editor.Devices.getSelected();
      return d ? d.id : null;
    };
    const frameSettled = () => new Promise((r) => setTimeout(r, 350));

    const handlers: Record<string, (p: any) => unknown> = {
      async info() {
        const p = pm();
        const all = p ? await p.list() : [];
        const site = all.find((r: any) => r.kind === 'site');
        return {
          grapesjsVersion: (window as any).grapesjs?.version,
          site: site ? site.name : undefined,
          open: await current(),
          records: p ? all.filter((r: any) => !r.templateId).length : undefined,
          device: deviceId(),
          selected: editor.getSelectedAll().map((c: any) => c.getId()),
          componentCount: wrapper().find('*').length,
          ...history(),
        };
      },

      async list_records() {
        const p = needPages();
        const active = p.getActiveId();
        const order: Record<string, number> = { site: 0, layout: 1, template: 2, page: 3 };
        return (await p.list())
          .filter((r: any) => !r.templateId)
          .sort((a: any, b: any) => (order[a.kind || 'page'] - order[b.kind || 'page']) || (a.position ?? 0) - (b.position ?? 0))
          .map((r: any) => summary(r, active));
      },
      async open_record(q) {
        const p = needPages();
        await record(q.id);
        await historySettled(p);
        await p.open(q.id);
        return { open: await current(), componentCount: wrapper().find('*').length };
      },
      async create_record(q) {
        const p = needPages();
        const kind = q.kind || 'page';
        if (kind !== 'page' && !(p.isRemote && p.isRemote())) throw new Error('Layouts and templates need the remote mode.');
        const init: any = { name: q.name };
        if (p.isRemote && p.isRemote()) {
          init.kind = kind;
          if (q.slug != null) init.slug = q.slug;
          if (q.parentId !== undefined) init.parentId = q.parentId;
          if (q.layoutId !== undefined) init.layoutId = q.layoutId;
        }
        await historySettled(p);
        const rec = await p.create(init);
        if (p.getActiveId() !== rec.id) await p.open(rec.id);
        if (q.html != null) editor.setComponents(q.html);
        if (q.css != null) editor.Css.addRules(q.css);
        return summary((await p.list()).find((x: any) => x.id === rec.id) || rec);
      },
      async update_record(q) {
        const p = needPages();
        await record(q.id);
        const patch: any = {};
        ['name', 'slug', 'parentId', 'layoutId', 'values'].forEach((k) => q[k] !== undefined && (patch[k] = q[k]));
        if (p.isRemote && p.isRemote()) await p.update(q.id, patch);
        else if (patch.name) await p.rename(q.id, patch.name);
        else throw new Error('Only the name can change outside the remote mode.');
        return summary(await record(q.id));
      },
      async publish(q) {
        const p = needPages();
        if (!(p.isRemote && p.isRemote())) throw new Error('Publishing needs the remote mode.');
        const was = p.getActiveId();
        const id = q.id || was;
        let warnings: string[] = [];
        const on = (e: any) => (warnings = (e && e.warnings) || []);
        editor.on('pages-manager:published', on);
        try {
          // grapesjs-pages opens the record to publish it; the open one comes back after.
          await historySettled(p);
          const r = await p.publish(id);
          if (was && p.getActiveId() !== was) await p.open(was);
          return { ...summary(r), publishedAt: r.publishedAt, warnings };
        } finally {
          editor.off('pages-manager:published', on);
        }
      },

      get_page() {
        return { html: editor.getHtml(), css: editor.getCss() };
      },
      get_tree(q) {
        return ser(findComp(q.root), q.depth == null ? 4 : q.depth);
      },
      add_html(q) {
        const added = insert(findComp(q.target), q.html, q.position);
        if (q.css) editor.Css.addRules(q.css);
        return { added: ids(added) };
      },
      update_component(q) {
        const c = findComp(q.id);
        if (q.attributes) c.addAttributes(q.attributes);
        if (q.removeAttributes) c.removeAttributes(q.removeAttributes);
        if (q.style) c.addStyle(q.style);
        if (q.addClasses) c.addClass(q.addClasses);
        if (q.removeClasses) c.removeClass(q.removeClasses);
        if (q.tagName) c.set('tagName', q.tagName);
        if (q.content !== undefined) c.components(q.content);
        return ser(c, 1);
      },
      remove_component(q) {
        const c = findComp(q.id);
        if (c === wrapper()) throw new Error('Cannot remove the root');
        c.remove();
        return { ok: true };
      },
      move_component(q) {
        const c = findComp(q.id);
        if (c === wrapper()) throw new Error('Cannot move the root');
        c.move(findComp(q.target), q.index == null ? {} : { at: q.index });
        return { ok: true };
      },
      set_page(q) {
        editor.setComponents(q.html);
        if (q.css !== undefined) editor.setStyle(q.css);
        return { ok: true, componentCount: wrapper().find('*').length };
      },
      add_css(q) {
        editor.Css.addRules(q.css);
        return { ok: true };
      },
      select_component(q) {
        editor.select(findComp(q.id));
        return { ok: true };
      },
      get_selected() {
        return editor.getSelectedAll().map((c: any) => ser(c, 1));
      },
      list_blocks() {
        return editor.Blocks.getAll().map((b: any) => {
          const cat = b.get('category');
          return {
            id: b.get('id') || b.id,
            label: plain(b.get('label')),
            category: cat && typeof cat === 'object' ? (cat.get ? cat.get('label') : cat.label) : cat,
          };
        });
      },
      add_block(q) {
        const b = editor.Blocks.get(q.blockId);
        if (!b) throw new Error('Block not found: ' + q.blockId);
        return { added: ids(insert(findComp(q.target), b.get('content'), q.position)) };
      },
      async set_device(q) {
        if (!DEVICES.includes(q.device)) throw new Error('Unknown device: ' + q.device);
        editor.setDevice(q.device);
        await frameSettled();
        return { device: deviceId() };
      },
      get_project_data() {
        return editor.getProjectData();
      },
      load_project_data(q) {
        editor.loadProjectData(q.data);
        return { ok: true };
      },
      // grapesjs-pages' per-record history; its steps are queued, so wait for
      // this one: a record opened while a step is still loading gets mixed up.
      async undo() {
        const p = pm();
        const done = p ? await p.undo() : (editor.UndoManager.undo(), true);
        return { done, ...history() };
      },
      async redo() {
        const p = pm();
        const done = p ? await p.redo() : (editor.UndoManager.redo(), true);
        return { done, ...history() };
      },
      async screenshot(q) {
        if (q.device && q.device !== deviceId()) {
          editor.setDevice(q.device);
          await frameSettled();
        }
        const doc = editor.Canvas.getDocument();
        const node: HTMLElement = q.target ? findComp(q.target).getEl() : editor.Canvas.getBody();
        if (!node) throw new Error('The component is not on the canvas.');
        // No selection outline or badges on the picture.
        const selected = editor.getSelectedAll();
        if (selected.length) editor.select(null);
        try {
          const maxHeight = q.maxHeight || 4000;
          const width = Math.max(node.scrollWidth, node.offsetWidth) || doc.documentElement.clientWidth;
          const full = Math.max(node.scrollHeight, node.offsetHeight);
          const height = Math.min(full, maxHeight);
          const png = q.format === 'png';
          const o = { backgroundColor: '#ffffff', pixelRatio: 1, width, height, cacheBust: true, quality: 0.85, style: { margin: '0' } };
          const url = png ? await toPng(node, o) : await toJpeg(node, o);
          return { imageBase64: url.slice(url.indexOf(',') + 1), mimeType: png ? 'image/png' : 'image/jpeg', width, height, fullHeight: full, device: deviceId() };
        } finally {
          if (selected.length) editor.select(selected);
        }
      },
    };

    // ---------- the connection ----------
    let ws: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    let delay = 1000;
    let dot: HTMLElement | null = null;
    let up = false;

    const setStatus = (on: boolean) => {
      if (on === up) return;
      up = on;
      if (dot) {
        dot.style.background = on ? '#22c55e' : '#ef4444';
        dot.title = on ? 'MCP: connected' : 'MCP: not connected';
      }
      o.onStatus?.(on);
    };
    if (o.badge) {
      dot = document.createElement('div');
      dot.style.cssText = 'position:fixed;right:10px;bottom:10px;width:12px;height:12px;border-radius:50%;z-index:99999;box-shadow:0 0 0 2px #fff;background:#ef4444';
      dot.title = 'MCP: not connected';
      document.body.appendChild(dot);
    }
    o.onStatus?.(false);

    const send = (m: unknown) => ws && ws.readyState === 1 && ws.send(JSON.stringify(m));

    function connect() {
      if (stopped) return;
      const url = o.url + (o.token ? (o.url.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(o.token) : '');
      const sock = new WebSocket(url);
      ws = sock;
      sock.onopen = () => {
        delay = 1000;
        send({ type: 'hello', info: { title: document.title, url: location.href } });
        setStatus(true);
      };
      sock.onmessage = async (ev) => {
        let msg: any;
        try {
          msg = JSON.parse(String(ev.data));
        } catch {
          return;
        }
        if (!msg.method) return;
        try {
          const h = handlers[msg.method];
          if (!h) throw new Error('Unknown method: ' + msg.method);
          const result = await h(msg.params || {});
          send({ id: msg.id, result: result === undefined ? { ok: true } : result });
        } catch (e) {
          send({ id: msg.id, error: String((e as Error)?.message || e) });
        }
      };
      sock.onclose = () => {
        if (ws !== sock) return;
        setStatus(false);
        if (o.autoReconnect && !stopped) {
          timer = setTimeout(connect, delay);
          delay = Math.min(delay * 2, 10000);
        }
      };
      sock.onerror = () => {
        try {
          sock.close();
        } catch {
          /* closed */
        }
      };
    }

    // After grapesjs-pages has opened the first record.
    editor.onReady(() => {
      const p = pm();
      if (p && p.whenReady) p.whenReady().catch(() => undefined).then(connect);
      else connect();
    });
    editor.mcpBridge = {
      get connected() {
        return !!ws && ws.readyState === 1;
      },
      disconnect() {
        stopped = true;
        clearTimeout(timer);
        if (ws) ws.close();
        dot?.remove();
      },
    };
    editor.on('destroy', () => editor.mcpBridge.disconnect());
  };
}
