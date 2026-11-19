/**
 * Luna Studio's MCP server: lets Claude (Claude Code, Claude Desktop) build
 * and edit sites in a running Luna editor.
 *
 *   Claude ──MCP (stdio)──► this process ──WebSocket (127.0.0.1)──► the editor page (mcpBridge plugin)
 *
 * Every change goes through the GrapesJS and grapesjs-pages APIs in the
 * page, so it shows at once, autosaves like a change by hand and is undone
 * with the editor's undo. Based on grapesjs-mcp 0.1.0.
 *
 * stdout belongs to the MCP protocol: log only to stderr.
 */
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebSocketServer, type WebSocket } from 'ws';
import { z } from 'zod';

export interface McpOptions {
  /** WebSocket port for the editor (default `GJS_MCP_PORT` or 8765; 0: any free one). */
  port?: number;
  /** When set, the page must connect with `?token=<it>` (default `GJS_MCP_TOKEN`). */
  token?: string;
  /** Allowed page origins; an entry without a port allows any port, `*` any origin (default `GJS_MCP_ORIGINS` or localhost and 127.0.0.1). */
  origins?: string[];
  /** How long to wait for the editor's answer, ms (default `GJS_MCP_TIMEOUT_MS` or 20000). */
  timeoutMs?: number;
  /** Logger (default: stderr). */
  log?: (...a: unknown[]) => void;
}

export const HOST = '127.0.0.1';
export const DEFAULT_PORT = 8765;
const DEFAULT_ORIGINS = ['http://localhost', 'http://127.0.0.1', 'http://[::1]'];

declare const __STUDIO_VERSION__: string;
const VERSION = typeof __STUDIO_VERSION__ === 'string' ? __STUDIO_VERSION__ : '0.0.0';

/** What Claude is told about the editor and how to work in it. */
export const INSTRUCTIONS = `Tools of a running Luna Studio editor (GrapesJS with Luna's plugins). Changes appear in the user's editor at once and autosave; undo works.

Start with editor_status. If it is not connected, ask the user to start the studio with \`luna-studio <folder> --mcp\` (or \`npm run dev\` with STUDIO_MCP=1) and open it in the browser.

A Luna site is a set of records, each a GrapesJS project of its own, and the editor shows one at a time (list_records, open_record):
- site: the global CSS of the whole site (variables, typography, buttons, utilities). Put shared styles here.
- layout: the frame around pages (header, footer). It must contain one <page-slot></page-slot> where the page goes.
- template: a design whose entries are content; leave templates alone unless asked.
- page: a page with an address (slug, "/" is the home page), a layout, SEO values.

Working on a page:
1. get_tree / get_page to see what is there; get_selected for what the user points at.
2. add_html (with css) to build sections, update_component / move_component / remove_component to change them, set_page to replace everything. Use semantic HTML with classes and put the rules in css or add_css; avoid inline styles. Responsive rules go in @media queries.
3. screenshot (device desktop / tablet / mobile) to look at the result, then fix what is off.
4. publish when the user wants it live (in a local folder it writes body.html and index.html). The site record and layouts are published on their own: publish them too after changing them.

The canvas and screenshot show only the open record: a page is drawn without its layout and without the site CSS, which are put together when the site is served. So a page should look right on its own (give it its own section styles), and the site record holds what every page shares. CSS added with add_html / add_css goes to the open record.

Images: use absolute URLs (or data: URIs); there is no upload tool.`;

function originAllowed(origins: string[], origin: string | undefined): boolean {
  if (origins.includes('*')) return true;
  if (!origin) return false;
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return false;
  }
  return origins.some((o) => {
    try {
      const x = new URL(o);
      return x.protocol === u.protocol && x.hostname === u.hostname && (!x.port || x.port === u.port);
    } catch {
      return false;
    }
  });
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

/** The editor tab on the other end of the WebSocket (one at a time: a newer tab takes over). */
export class Bridge {
  client: WebSocket | null = null;
  hello: Record<string, unknown> | null = null;
  private pending = new Map<string, Pending>();

  constructor(
    private timeoutMs: number,
    private log: (...a: unknown[]) => void,
    private hint: () => string
  ) {}

  get connected(): boolean {
    return !!this.client && this.client.readyState === 1;
  }

  attach(ws: WebSocket): void {
    if (this.client && this.client !== ws) this.client.close(1000, 'replaced by a newer editor tab');
    this.client = ws;
    this.hello = null;
    this.log('editor connected');
    ws.on('message', (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.type === 'hello') {
        this.hello = msg.info || null;
        return;
      }
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error));
      else p.resolve(msg.result);
    });
    ws.on('close', () => {
      if (this.client !== ws) return;
      this.client = null;
      this.log('editor disconnected');
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error('The editor disconnected.'));
        this.pending.delete(id);
      }
    });
    ws.on('error', (e) => this.log('ws error:', e.message));
  }

  call(method: string, params: unknown = {}): Promise<any> {
    if (!this.connected) return Promise.reject(new Error(`The Luna editor is not connected. ${this.hint()}`));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`The editor did not answer "${method}" within ${this.timeoutMs} ms.`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.client!.send(JSON.stringify({ id, method, params }));
    });
  }
}

export interface Mcp {
  server: McpServer;
  bridge: Bridge;
  /** Resolves to the WebSocket port once it listens (rejects when it cannot, e.g. the port is taken). */
  listening: Promise<number>;
  close(): Promise<void>;
}

const env = process.env;

/** The MCP server and the WebSocket the editor connects to. Connect `server` to a transport. */
export function createMcp(opts: McpOptions = {}): Mcp {
  const port = opts.port ?? Number(env.GJS_MCP_PORT || DEFAULT_PORT);
  const token = opts.token ?? env.GJS_MCP_TOKEN ?? '';
  const origins = opts.origins ?? (env.GJS_MCP_ORIGINS ? env.GJS_MCP_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean) : DEFAULT_ORIGINS);
  const timeoutMs = opts.timeoutMs ?? Number(env.GJS_MCP_TIMEOUT_MS || 20000);
  const log = opts.log ?? ((...a: unknown[]) => console.error('[luna-studio-mcp]', ...a));

  let actualPort = port;
  const hint = () =>
    `Start the studio with \`luna-studio <folder> --mcp\`${actualPort !== DEFAULT_PORT ? ` --mcp-port ${actualPort}` : ''} and open it in the browser; the editor connects to ws://${HOST}:${actualPort}.`;
  const bridge = new Bridge(timeoutMs, log, hint);

  const wss = new WebSocketServer({
    host: HOST,
    port,
    maxPayload: 64 * 1024 * 1024,
    verifyClient: ({ origin, req }, cb) => {
      if (!originAllowed(origins, origin)) {
        log('rejected origin:', origin);
        return cb(false, 403, 'Origin not allowed');
      }
      if (token && new URL(req.url || '/', 'http://localhost').searchParams.get('token') !== token) return cb(false, 401, 'Bad token');
      cb(true);
    },
  });
  wss.on('connection', (ws) => bridge.attach(ws));
  const listening = new Promise<number>((resolve, reject) => {
    wss.once('listening', () => {
      actualPort = (wss.address() as AddressInfo).port;
      log(`listening on ws://${HOST}:${actualPort}`);
      resolve(actualPort);
    });
    wss.once('error', (e: NodeJS.ErrnoException) => {
      log(`WebSocket server error: ${e.message}` + (e.code === 'EADDRINUSE' ? ` (port ${port} is taken: set GJS_MCP_PORT, and --mcp-port in the studio)` : ''));
      reject(e);
    });
  });
  listening.catch(() => undefined);

  const server = new McpServer({ name: 'luna-studio', version: VERSION }, { instructions: INSTRUCTIONS });

  const text = (v: unknown) => ({ content: [{ type: 'text' as const, text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }] });
  const failure = (e: unknown) => ({ isError: true, content: [{ type: 'text' as const, text: String((e as Error)?.message || e) }] });

  const tool = (name: string, description: string, shape: z.ZodRawShape = {}, method = name) => {
    const hasInput = Object.keys(shape).length > 0;
    const run = async (args: Record<string, unknown>) => {
      try {
        const result = await bridge.call(method, args);
        if (result && typeof result === 'object' && typeof result.imageBase64 === 'string') {
          const { imageBase64, mimeType, ...rest } = result;
          return {
            content: [
              { type: 'image' as const, data: imageBase64, mimeType: mimeType || 'image/png' },
              ...(Object.keys(rest).length ? [{ type: 'text' as const, text: JSON.stringify(rest) }] : []),
            ],
          };
        }
        return text(result ?? { ok: true });
      } catch (e) {
        return failure(e);
      }
    };
    if (hasInput) server.registerTool(name, { description, inputSchema: shape }, (args: any) => run(args));
    else server.registerTool(name, { description }, () => run({}));
  };

  const id = z.string().describe('Component id from get_tree / add_html, "root" for the wrapper, or a CSS selector starting with # or .');
  const position = z.enum(['append', 'prepend', 'before', 'after']).optional().describe('Where to insert relative to the target (default append: the last child)');
  const device = z.enum(['desktop', 'tablet', 'mobile']);

  server.registerTool(
    'editor_status',
    { description: 'Is a Luna editor connected? The open record, the site, the selection, the device. Call this first.' },
    async () => {
      if (!bridge.connected) return text({ connected: false, hint: hint() });
      try {
        return text({ connected: true, page: bridge.hello, ...(await bridge.call('info')) });
      } catch (e) {
        return failure(e);
      }
    }
  );

  // The site's records (grapesjs-pages).
  tool('list_records', 'List the site, its layouts, templates and pages (id, kind, name, slug, layout, parent, status); marks the open one.');
  tool('open_record', 'Open a record (page, layout, template or the site) in the editor. The other tools work on the open record.', {
    id: z.string().describe('Record id from list_records'),
  });
  tool('create_record', 'Create a page, a layout or a template and open it. Optionally fill it with HTML and CSS at once.', {
    kind: z.enum(['page', 'layout', 'template']).optional().describe('Default page'),
    name: z.string(),
    slug: z.string().optional().describe('A page\'s address: "/" or "/about" or "/blog/post" (default: from the name)'),
    parentId: z.string().nullable().optional().describe('Parent page id'),
    layoutId: z.string().nullable().optional().describe('Layout id for a page'),
    html: z.string().optional().describe('The content; a layout needs a <page-slot></page-slot>'),
    css: z.string().optional(),
  });
  tool('update_record', 'Change a record\'s header: name, address, parent, layout, SEO and menu values.', {
    id: z.string(),
    name: z.string().optional(),
    slug: z.string().optional(),
    parentId: z.string().nullable().optional(),
    layoutId: z.string().nullable().optional(),
    values: z
      .record(z.unknown())
      .optional()
      .describe('e.g. {"seo.title": "…", "seo.description": "…", "in_menu": true}; null deletes a key'),
  });
  tool('publish', 'Publish a record (default: the open one); the open record stays open. In a local folder this writes its body.html, style.css and index.html.', {
    id: z.string().optional(),
  });

  // The open record's content (GrapesJS).
  tool('get_page', 'The open record as HTML and CSS (editor.getHtml() / getCss()).');
  tool('get_tree', 'The component tree (ids, types, tags, classes, attributes, text). Use the ids to edit components.', {
    root: id.optional(),
    depth: z.number().int().min(0).max(12).optional().describe('Max depth, default 4'),
  });
  tool('add_html', 'Insert HTML (optionally with CSS) into the open record. Returns the ids of the new components.', {
    target: id.optional().describe('Default "root"'),
    html: z.string().describe('HTML to insert: semantic markup with classes'),
    css: z.string().optional().describe('CSS rules that go with it'),
    position,
  });
  tool('update_component', 'Change a component: attributes, inline style, classes, tag name or its content (HTML).', {
    id,
    attributes: z.record(z.string()).optional(),
    removeAttributes: z.array(z.string()).optional(),
    style: z.record(z.string()).optional().describe('CSS properties, e.g. {"background-color":"#fff"}; prefer classes and add_css'),
    addClasses: z.array(z.string()).optional(),
    removeClasses: z.array(z.string()).optional(),
    tagName: z.string().optional(),
    content: z.string().optional().describe("Replaces the component's children with this HTML or text"),
  });
  tool('remove_component', 'Delete a component.', { id });
  tool('move_component', 'Move a component into another one.', {
    id,
    target: id,
    index: z.number().int().min(0).optional().describe('Child index in the target (default: the end)'),
  });
  tool('set_page', "Replace the open record's whole content. Without css the CSS stays. Undoable.", {
    html: z.string(),
    css: z.string().optional(),
  });
  tool('add_css', 'Add CSS rules to the open record (media queries, pseudo-classes, keyframes, custom properties).', { css: z.string() });
  tool('select_component', 'Select a component in the editor, for the user to see.', { id });
  tool('get_selected', 'The component(s) the user has selected in the editor.');
  tool('list_blocks', "The blocks of the editor's block manager.");
  tool('add_block', 'Insert a block from the block manager.', { blockId: z.string(), target: id.optional(), position });
  tool('set_device', 'Switch the canvas to desktop, tablet (768px) or mobile (375px).', { device });
  tool('get_project_data', "The open record's GrapesJS project JSON (can be large).");
  tool('load_project_data', 'Load a GrapesJS project JSON into the open record (replaces its content).', { data: z.record(z.any()) });
  tool('undo', 'Undo the last change of the open record (its own history; switching records keeps each history).');
  tool('redo', 'Redo the last undone change.');
  tool('screenshot', 'A picture of the canvas, to check the result. JPEG by default.', {
    device: device.optional().describe('Switch to this device first (it stays switched)'),
    target: id.optional().describe('Only this component (default: the whole page)'),
    maxHeight: z.number().int().min(200).max(20000).optional().describe('Crop the page at this height, px (default 4000)'),
    format: z.enum(['jpeg', 'png']).optional(),
  });

  return {
    server,
    bridge,
    listening,
    close: async () => {
      await server.close().catch(() => undefined);
      for (const c of wss.clients) c.terminate();
      await new Promise<void>((r) => wss.close(() => r()));
    },
  };
}
