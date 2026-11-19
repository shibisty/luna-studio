// Builds the editor bundle (public/editor) from the npm packages in
// node_modules: GrapesJS, the official plugins, ours (grapesjs-site-pages,
// grapesjs-storage, grapesjs-blueprints, grapesjs-fonts…), the TOAST UI image
// editor, Font Awesome, Roboto. Our own files (luna-theme.css, README.md)
// come from editor/. Every file is listed in manifest.json with its package,
// version and SHA-256; luna-dashboard keeps a copy (npm run sync:dashboard).
//
//   node scripts/bundle.mjs           write public/editor
//   node scripts/bundle.mjs --check   fail if public/editor differs (CI)
//
// The versions are the ones in package.json (exact pins): update a package
// there, `npm install`, `npm run bundle`.
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256, stripMap } from './manifest.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(root, 'public/editor');
const own = resolve(root, 'editor');
const require = createRequire(join(root, 'package.json'));
const check = process.argv.includes('--check');

/** The package's folder (works for packages whose exports hide package.json too). */
function pkgDir(name) {
  let dir = dirname(require.resolve(name, { paths: [root] }));
  while (!existsSync(join(dir, 'package.json')) || JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).name !== name) {
    const up = dirname(dir);
    if (up === dir) throw new Error(`cannot find the folder of ${name}`);
    dir = up;
  }
  return dir;
}
const dirs = new Map();
const dirOf = (name) => {
  if (!dirs.has(name)) {
    const nm = join(root, 'node_modules', name);
    dirs.set(name, existsSync(join(nm, 'package.json')) ? nm : pkgDir(name));
  }
  return dirs.get(name);
};
const versionOf = (name) => JSON.parse(readFileSync(join(dirOf(name), 'package.json'), 'utf8')).version;

const js = (buf) => stripMap(buf);
const LOCALE_HEAD = (v) =>
  `/* GrapesJS ${v} locale/ru.js (BSD-3-Clause, github.com/GrapesJS/grapesjs), wrapped for a <script> tag: window.grapesjsLocales.ru */\n(function () { var exports = {};\n`;
const LOCALE_TAIL = '\nwindow.grapesjsLocales = window.grapesjsLocales || {}; window.grapesjsLocales.ru = exports.default; })();\n';

/** Font Awesome's CSS with its @font-face pointing at the two files next to it. */
function fontAwesomeCss(buf) {
  const face =
    "@font-face{font-family:'FontAwesome';src:url('fontawesome-webfont.woff2?v=4.7.0') format('woff2'),url('fontawesome-webfont.woff?v=4.7.0') format('woff');font-weight:normal;font-style:normal}";
  const s = buf.toString('utf8');
  const next = s.replace(/@font-face\{[^}]*\}/, face);
  if (next === s) throw new Error('font-awesome.min.css: no @font-face to rewrite');
  return Buffer.from(next);
}

/**
 * [file, package, path in the package, transform?, note?]. The order is the
 * manifest's; the load order is src/editor/bundle.ts (and the dashboard's
 * editorScripts).
 */
const FILES = [
  ['grapes.min.js', 'grapesjs', 'dist/grapes.min.js', js],
  ['grapes.min.css', 'grapesjs', 'dist/css/grapes.min.css'],
  ['grapesjs-locale-ru.js', 'grapesjs', 'locale/ru.js', (b) => Buffer.from(LOCALE_HEAD(versionOf('grapesjs')) + js(b).toString('utf8') + LOCALE_TAIL), 'locale/ru.js wrapped for a <script> tag'],
  ['grapesjs-preset-webpage.js', 'grapesjs-preset-webpage', 'dist/index.js', js],
  ['grapesjs-blocks-basic.js', 'grapesjs-blocks-basic', 'dist/index.js', js],
  ['grapesjs-plugin-forms.js', 'grapesjs-plugin-forms', 'dist/index.js', js],
  ['grapesjs-navbar.js', 'grapesjs-navbar', 'dist/index.js', js],
  ['grapesjs-tabs.js', 'grapesjs-tabs', 'dist/grapesjs-tabs.min.js', js],
  ['grapesjs-component-countdown.js', 'grapesjs-component-countdown', 'dist/index.js', js],
  ['grapesjs-custom-code.js', 'grapesjs-custom-code', 'dist/index.js', js],
  ['grapesjs-tooltip.js', 'grapesjs-tooltip', 'dist/index.js', js],
  ['grapesjs-typed.js', 'grapesjs-typed', 'dist/index.js', js],
  ['grapesjs-parser-postcss.js', 'grapesjs-parser-postcss', 'dist/index.js', js],
  ['grapesjs-style-gradient.js', 'grapesjs-style-gradient', 'dist/index.js', js],
  ['grapesjs-style-bg.js', 'grapesjs-style-bg', 'dist/index.js', js],
  ['grapesjs-style-filter.js', 'grapesjs-style-filter', 'dist/index.js', js],
  ['grapesjs-plugin-export.js', 'grapesjs-plugin-export', 'dist/index.js', js],
  ['grapesjs-tui-image-editor.js', 'grapesjs-tui-image-editor', 'dist/index.js', js],
  ['grapick.min.css', 'grapick', 'dist/grapick.min.css'],
  ['tui-code-snippet.min.js', 'tui-code-snippet', 'dist/tui-code-snippet.min.js', js],
  ['tui-color-picker.min.js', 'tui-color-picker', 'dist/tui-color-picker.min.js', js],
  ['tui-color-picker.min.css', 'tui-color-picker', 'dist/tui-color-picker.min.css'],
  ['tui-image-editor.min.js', 'tui-image-editor', 'dist/tui-image-editor.min.js', js, 'Fabric.js inside'],
  ['tui-image-editor.min.css', 'tui-image-editor', 'dist/tui-image-editor.min.css'],
  ['font-awesome.min.css', 'font-awesome', 'css/font-awesome.min.css', fontAwesomeCss, '@font-face rewritten to the two files below'],
  ['fontawesome-webfont.woff2', 'font-awesome', 'fonts/fontawesome-webfont.woff2'],
  ['fontawesome-webfont.woff', 'font-awesome', 'fonts/fontawesome-webfont.woff'],
  ['roboto-latin-400-normal.woff2', '@fontsource/roboto', 'files/roboto-latin-400-normal.woff2'],
  ['roboto-latin-500-normal.woff2', '@fontsource/roboto', 'files/roboto-latin-500-normal.woff2'],
  ['roboto-cyrillic-400-normal.woff2', '@fontsource/roboto', 'files/roboto-cyrillic-400-normal.woff2'],
  ['roboto-cyrillic-500-normal.woff2', '@fontsource/roboto', 'files/roboto-cyrillic-500-normal.woff2'],
  // Ours, from npm.
  ['grapesjs-cloud-assets.js', 'grapesjs-cloud-assets', 'dist/grapesjs-cloud-assets.umd.cjs', js],
  ['dropbox-callback.html', 'grapesjs-cloud-assets', 'dist/dropbox-callback.html'],
  ['microsoft-callback.html', 'grapesjs-cloud-assets', 'dist/microsoft-callback.html'],
  ['grapesjs-sidebar-tools.js', 'grapesjs-sidebar-tools', 'dist/grapesjs-sidebar-tools.umd.cjs', js],
  ['grapesjs-ruler.js', 'grapesjs-ruler', 'dist/grapesjs-ruler.umd.cjs', js],
  ['grapesjs-context-menu.js', 'grapesjs-context-menu', 'dist/grapesjs-context-menu.umd.cjs', js],
  ['grapesjs-fonts.js', 'grapesjs-fonts', 'dist/grapesjs-fonts.umd.cjs', js],
  ['grapesjs-scripts.js', 'grapesjs-blueprints', 'dist/grapesjs-scripts.umd.cjs', js, 'blueprintsjs bundled in'],
  ['grapesjs-pages.js', 'grapesjs-site-pages', 'dist/grapesjs-pages.umd.cjs', js],
  ['grapesjs-storage.js', 'grapesjs-storage', 'dist/grapesjs-storage.umd.cjs', js],
];

/** Ours, kept in this repository (editor/). */
const OWN = [['luna-theme.css', 'luna-theme', '1.0.0', "ours: Luna's theme for GrapesJS (light and dark, after MUI)"]];

const files = new Map();
const entries = [];
for (const [file, pkg, rel, transform, note] of FILES) {
  const src = join(dirOf(pkg), rel);
  if (!existsSync(src)) throw new Error(`${file}: ${pkg} has no ${rel}`);
  const buf = transform ? transform(readFileSync(src)) : readFileSync(src);
  files.set(file, buf);
  entries.push({ file, package: pkg, version: versionOf(pkg), source: `npm ${pkg} ${rel}${note ? `; ${note}` : ''}`, sha256: sha256(buf) });
}
for (const [file, pkg, version, source] of OWN) {
  const buf = readFileSync(join(own, file));
  files.set(file, buf);
  entries.push({ file, package: pkg, version, source, sha256: sha256(buf) });
}
files.set('README.md', readFileSync(join(own, 'README.md')));
entries.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
// What loads the bundle needs: the load order (src/editor/load.json) and
// which luna-studio made it. luna-dashboard reads both.
const load = JSON.parse(readFileSync(join(root, 'src/editor/load.json'), 'utf8'));
delete load['//'];
for (const f of [...load.scripts, ...load.styles, ...load.tuiScripts, ...load.tuiStyles]) {
  if (!files.has(f)) throw new Error(`src/editor/load.json lists ${f}, which the bundle does not have`);
}
const studio = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const manifest = Buffer.from(JSON.stringify({ studio, load, files: entries }, null, 2) + '\n');
files.set('manifest.json', manifest);

if (check) {
  const bad = [...files].filter(([f, b]) => !existsSync(join(out, f)) || !readFileSync(join(out, f)).equals(b)).map(([f]) => f);
  const extra = existsSync(out) ? readdirSync(out).filter((f) => !files.has(f)) : [];
  if (bad.length || extra.length) {
    console.error(`public/editor is not what the packages give: ${[...bad, ...extra.map((f) => `${f} (extra)`)].join(', ')}\nRun npm run bundle.`);
    process.exit(1);
  }
  console.log(`public/editor matches the packages (${files.size} files)`);
} else {
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  for (const [f, b] of files) writeFileSync(join(out, f), b);
  console.log(`${files.size} files → public/editor`);
  for (const e of entries) console.log(`  ${e.file.padEnd(34)} ${e.package}@${e.version}`);
}
