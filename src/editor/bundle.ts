import load from './load.json';

/**
 * The editor's files (public/editor, served at `<base>/<file>`) in load
 * order, from load.json: GrapesJS, the official plugins, ours.
 * grapesjs-pages comes before grapesjs-storage, which then leaves the
 * templates' designs to it; grapesjs-ruler after grapesjs-sidebar-tools
 * (it follows its zoom and devices). `npm run bundle` writes the same
 * lists into manifest.json as `load`, and luna-dashboard loads the bundle
 * in that order (then its luna-editor.js).
 */
export const SCRIPTS: string[] = load.scripts;

/** Luna's theme last: over GrapesJS' dark look. */
export const STYLES: string[] = load.styles;

/** The TOAST UI image editor, loaded when it is first opened. */
export const TUI_SCRIPTS: string[] = load.tuiScripts;
export const TUI_STYLES: string[] = load.tuiStyles;

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
