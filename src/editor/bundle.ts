/**
 * The editor's files (public/editor, served at `<base>/<file>`) in load
 * order: GrapesJS, the official plugins, ours. grapesjs-pages comes before
 * grapesjs-storage, which then leaves the templates' designs to it.
 * luna-dashboard serves the same files (resources/editor) and lists them
 * in app/http/controllers/pages.go: keep both lists in step.
 */
export const SCRIPTS = [
  'grapes.min.js',
  'grapesjs-locale-ru.js',
  'grapesjs-preset-webpage.js',
  'grapesjs-blocks-basic.js',
  'grapesjs-plugin-forms.js',
  'grapesjs-navbar.js',
  'grapesjs-tabs.js',
  'grapesjs-component-countdown.js',
  'grapesjs-custom-code.js',
  'grapesjs-tooltip.js',
  'grapesjs-typed.js',
  'grapesjs-parser-postcss.js',
  'grapesjs-style-gradient.js',
  'grapesjs-style-bg.js',
  'grapesjs-style-filter.js',
  'grapesjs-plugin-export.js',
  'grapesjs-tui-image-editor.js',
  'grapesjs-cloud-assets.js',
  'grapesjs-sidebar-tools.js',
  // Rulers, crosshair and guides around the canvas (follows sidebar-tools' zoom and devices).
  'grapesjs-ruler.js',
  'grapesjs-context-menu.js',
  'grapesjs-fonts.js',
  'grapesjs-scripts.js',
  'grapesjs-pages.js',
  'grapesjs-storage.js',
];

/** Luna's theme last: over GrapesJS' dark look. */
export const STYLES = ['grapes.min.css', 'grapick.min.css', 'luna-theme.css'];

/** The TOAST UI image editor, loaded when it is first opened. */
export const TUI_SCRIPTS = ['tui-code-snippet.min.js', 'tui-color-picker.min.js', 'tui-image-editor.min.js'];
export const TUI_STYLES = ['tui-color-picker.min.css', 'tui-image-editor.min.css'];

/** Loads the styles and then the scripts one after another (they set globals). */
export async function loadBundle(base: string, doc: Document = document): Promise<void> {
  const url = (f: string) => `${base.replace(/\/+$/, '')}/${f}`;
  STYLES.forEach((f) => {
    const l = doc.createElement('link');
    l.rel = 'stylesheet';
    l.href = url(f);
    doc.head.appendChild(l);
  });
  for (const f of SCRIPTS) {
    await new Promise<void>((resolve, reject) => {
      const s = doc.createElement('script');
      s.src = url(f);
      s.async = false;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error(`cannot load ${f}`));
      doc.head.appendChild(s);
    });
  }
}
