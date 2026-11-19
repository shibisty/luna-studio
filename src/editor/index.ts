/**
 * Luna's site editor: GrapesJS with the plugins and the settings
 * luna-dashboard uses, as one function. The dashboard's editor page and
 * luna-studio both call `mount()`; the plugins' scripts must be loaded
 * first (`loadBundle`, or the dashboard's <script> tags), as they set the
 * globals read here (`grapesjs`, `grapesjsPages`, `grapesjsStorage`…).
 *
 * Built as `luna-editor.js` (global `LunaEditor`) for the dashboard.
 */
import { localized, RU, WORDS, type Words } from './words';
import { uploader, type FilesConfig } from './uploads';
import { mcpBridge, type McpBridgeOptions } from './mcpBridge';

export { loadBundle, SCRIPTS, STYLES, TUI_SCRIPTS, TUI_STYLES } from './bundle';
export { WORDS, RU, BLOCK_LABELS, BUTTON_TITLES, localized } from './words';
export type { Words } from './words';
export type { FilesConfig } from './uploads';
export { mcpBridge, DEFAULT_MCP_URL } from './mcpBridge';
export type { McpBridgeOptions } from './mcpBridge';

type AnyEditor = any;
declare const window: Window & Record<string, any>;

export interface MountConfig {
  /** Where the editor goes (`#gjs`). */
  container: string | HTMLElement;
  /** Base URL of the editor contract (grapesjs-pages remote mode), e.g. `/apps/x/pages/api/editor`. */
  pagesApi: string;
  /** Base URL of the content API (grapesjs-storage), e.g. `/apps/x/pages/api/content`. */
  contentApi: string;
  /** Headers for every call to both APIs (a CSRF token). */
  headers?: () => Record<string, string>;
  /** IndexedDB cache name of grapesjs-pages (one per server URL by default). */
  cacheDbName?: string;
  /** The application's images in luna-files; without it images are embedded as base64. */
  files?: FilesConfig | null;
  /** The editor's language: `en` or one GrapesJS has a locale for (`ru`…). */
  lang?: string;
  /** Base URL of the fonts catalogues proxy (luna-dashboard's `/editor/fonts`). */
  fonts?: string;
  /** Font Awesome 4.7's CSS (GrapesJS fetches it from cdnjs otherwise). */
  icons: string;
  /** The TOAST UI image editor's files. */
  tui: { script: string[]; style: string[] };
  /** Where grapesjs-cloud-assets' sign-in popups come back (absolute or root-relative). */
  callbacks?: { dropbox: string; microsoft: string };
  /** Texts, block labels and button titles; default: English, or Russian with `lang: 'ru'`. */
  words?: Partial<Words>;
  labels?: Record<string, string>;
  titles?: Record<string, string>;
  /** Where the status and the plugins' messages go. */
  status?: (text: string, isError: boolean) => void;
  /** Extra GrapesJS config (merged over the built one) and plugins (after Luna's). */
  config?: Record<string, unknown>;
  plugins?: Array<(editor: AnyEditor) => void>;
  /** grapesjs-pages options added to the remote ones (e.g. `archiveName`). */
  pagesOptions?: Record<string, unknown>;
  /** Connect to Luna Studio's MCP server (`luna-studio-mcp`), so Claude can edit the site. */
  mcp?: McpBridgeOptions | null;
}

/** The record being edited, for a preview: an entry or a page; null with a reason. */
export async function previewTarget(editor: AnyEditor, words: Words = WORDS): Promise<{ id: string } | { error: string }> {
  const st = editor.ContentStorage && editor.ContentStorage.current();
  if (st) return { id: st.entry.id };
  const pm = editor.PagesManager;
  const id = pm && pm.getActiveId();
  if (!id) return { error: words.openFirst };
  const list = await pm.list();
  const rec = list.filter((r: any) => r.id === id)[0];
  if (!rec || (rec.kind && rec.kind !== 'page')) return { error: words.noPreview };
  return { id };
}

/**
 * The blueprint scripts of the open record (grapesjs-scripts), as tags at
 * the end of the published HTML. luna-pages has no files: a script the
 * settings put in a separate file goes inline.
 */
async function scriptsMarkup(out: { html: string; css: string; kind: string }): Promise<{ html: string; css: string } | void> {
  const sc = window.editor && window.editor.Scripts;
  if (!sc || out.kind === 'site') return;
  const e = await sc.exportPage();
  const tags: string[] = [];
  if (e.libraries) tags.push(e.libraries);
  if (e.files && e.files.length) {
    e.files.forEach((f: { code: string }) => tags.push('<script>' + String(f.code).replace(/<\/(script)/gi, '<\\/$1') + '<\/script>'));
  } else if (e.scripts) {
    tags.push(e.scripts);
  }
  if (!tags.length) return;
  return { html: out.html + '\n' + tags.join('\n'), css: out.css };
}

/** Starts the editor; resolves to the GrapesJS editor (also `window.editor`). */
export function mount(cfg: MountConfig): AnyEditor {
  const grapesjs = window.grapesjs;
  if (!grapesjs) throw new Error('luna-editor: load the editor bundle first (grapesjs is not there)');
  const lang = cfg.lang || 'en';
  const builtIn = lang === 'ru' ? localized(RU) : localized();
  const words: Words = { ...builtIn.words, ...(cfg.words || {}) };
  const labels = cfg.labels || builtIn.labels;
  const titles = cfg.titles || builtIn.titles;
  const say = cfg.status || (() => undefined);
  const headers = cfg.headers || (() => ({}));
  const pages = window.grapesjsPages.default;
  const storage = window.grapesjsStorage;
  const files = cfg.files || null;
  const up = files ? uploader(files, words, say) : null;

  const plugins: Array<string | ((ed: AnyEditor) => void)> = [
    'grapesjs-preset-webpage',
    'gjs-blocks-basic',
    'grapesjs-plugin-forms',
    'grapesjs-navbar',
    'grapesjs-tabs',
    'grapesjs-component-countdown',
    'grapesjs-custom-code',
    'grapesjs-tooltip',
    'grapesjs-typed',
    'grapesjs-parser-postcss',
    'grapesjs-style-gradient',
    'grapesjs-style-bg',
    'grapesjs-style-filter',
    'grapesjs-plugin-export',
    'grapesjs-tui-image-editor',
  ];
  // Dropbox, Google Drive, OneDrive in the asset manager; each asks for its
  // app key once (kept in this browser). Box needs a token server.
  if (cfg.callbacks && window.grapesjsCloudAssets) {
    const cb = cfg.callbacks;
    plugins.push((ed) => {
      const ca = window.grapesjsCloudAssets;
      const back = (p: string) => (/^[a-z]+:/i.test(p) ? p : location.origin + p);
      return ca.default(ed, {
        providers: [
          new ca.DropboxProvider({ redirectUri: back(cb.dropbox) }),
          new ca.GoogleDriveProvider(),
          new ca.OneDriveProvider({ redirectUri: back(cb.microsoft) }),
        ],
      });
    });
  }
  plugins.push(
    // Every view is a tab the user can dock left, right or at the bottom.
    (ed) => window.grapesjsSidebarTools(ed, { sizes: { right: 320 } }),
    window.grapesjsContextMenu.default,
    // Web fonts; their catalogues through a proxy (the APIs send no CORS headers).
    (ed) => window.grapesjsFonts.default(ed, cfg.fonts ? { proxy: cfg.fonts } : {}),
    // Blueprints: page behaviour as node graphs, compiled to JavaScript.
    window.grapesjsScripts.default,
    // grapesjs-pages first: grapesjs-storage then leaves the templates' designs to it.
    (ed) =>
      pages(ed, {
        ...(cfg.pagesOptions || {}),
        remote: { url: cfg.pagesApi, headers, markup: scriptsMarkup, ...(cfg.cacheDbName ? { cacheDbName: cfg.cacheDbName } : {}) },
      }),
    (ed) => storage.default(ed, { rest: { url: cfg.contentApi, headers } }),
    ...(cfg.mcp ? [mcpBridge(cfg.mcp)] : []),
    ...(cfg.plugins || [])
  );

  const editor = grapesjs.init({
    container: cfg.container,
    height: '100%',
    width: 'auto',
    storageManager: false,
    telemetry: false,
    assetManager: up ? { upload: files!.api + '/files', uploadFile: up.uploadFiles, multiUpload: true, embedAsBase64: false } : {},
    cssIcons: cfg.icons,
    i18n: { locale: lang, detectLocale: false, messagesAdd: window.grapesjsLocales || {} },
    deviceManager: {
      devices: [
        { id: 'desktop', name: words.desktop, width: '' },
        { id: 'tablet', name: words.tablet, width: '768px', widthMedia: '992px' },
        { id: 'mobile', name: words.mobile, width: '375px', widthMedia: '767px' },
      ],
    },
    plugins,
    pluginsOpts: {
      // No jumping to the style manager on every selection; Luna's theme, not the preset's colors.
      'grapesjs-preset-webpage': { blocks: ['link-block', 'quote', 'text-basic'], showStylesOnChange: false, useCustomTheme: false },
      'gjs-blocks-basic': { flexGrid: true },
      'grapesjs-plugin-forms': { blocks: ['form', 'input', 'textarea', 'select', 'checkbox', 'radio', 'button'] },
      'grapesjs-plugin-export': { btnLabel: words.exportZip },
      // The image editor's files from our bundle, not uicdn.toast.com; no
      // usage statistics to Google Analytics, no logo from uicdn.
      'grapesjs-tui-image-editor': {
        script: cfg.tui.script,
        style: cfg.tui.style,
        config: {
          usageStatistics: false,
          includeUI: { theme: { 'common.bi.image': 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==' } },
        },
      },
    },
    ...(cfg.config || {}),
  });
  window.editor = editor;
  if (up) editor.onReady(() => up.loadImages(editor));
  editor.onReady(() => {
    // Plugins add their CSS as they start: the theme goes after it.
    document.querySelectorAll('link[href*="luna-theme.css"]').forEach((l) => document.head.appendChild(l));
    const bm = editor.Blocks;
    bm.getAll().forEach((b: any) => {
      const t = labels[b.get('label')];
      if (t) b.set('label', t);
    });
    bm.getCategories().forEach((c: any) => {
      const t = labels[c.get('label') || c.id];
      if (t) c.set('label', t);
    });
    bm.render();
    editor.Panels.getPanels().forEach((pn: any) => {
      pn.get('buttons').forEach((bt: any) => {
        const t = titles[bt.id];
        if (t) bt.set('attributes', Object.assign({}, bt.get('attributes'), { title: t }));
      });
    });
  });

  // What the plugins report.
  const state = (s: string) => {
    if (s === 'idle') say(words.saved, false);
    else if (s === 'saving') say(words.saving, false);
    else if (s === 'offline') say(words.offline, true);
    else if (s === 'error') say(words.error, true);
    else if (s === 'conflict') say(words.conflict, true);
  };
  editor.on('pages-manager:remote', state);
  editor.on('storage:state', state);
  editor.on('pages-manager:conflict', () => state('conflict'));
  // luna-pages' warnings (fields without an element, scripts a site without custom code leaves out).
  const warning = (m: string) => {
    if (/does not allow custom code/.test(m)) return words.noCustomCode;
    const f = /^The field (.+) has no element in the template/.exec(m);
    return f ? words.fieldNoElement.replace('{name}', f[1]) : m;
  };
  editor.on('pages-manager:published', (e: { warnings?: string[] }) => {
    const w = (e && e.warnings) || [];
    if (w.length) say(words.publishedWarnings + ' ' + w.map(warning).join(' '), true);
    else say(words.published, false);
  });
  return editor;
}
