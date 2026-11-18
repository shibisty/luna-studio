# The page editor's bundle

GrapesJS, its plugins and Luna's setup of them. **luna-studio builds it from
npm** (`C:\OSPanel6\home\grapesjs\luna-studio`): `npm run bundle` (it also runs
before `dev` and `build`) takes every file from `node_modules` into
`public/editor` (git-ignored) and writes `manifest.json` with each file's
package, version and SHA-256. Only `luna-theme.css` and this README live in the
repository, in `editor/`. `npm run sync:dashboard` copies the bundle and
`luna-editor.js` into luna-dashboard's `resources/editor`, which the dashboard
serves at `/assets/editor/<file>` (embedded into the binary; no Node on the
servers, no CDN at runtime); the dashboard's test checks the files against the
manifest.

| File | From |
|---|---|
| `grapes.min.js`, `grapes.min.css` | npm `grapesjs` (`dist/`, `dist/css/`) |
| `grapesjs-locale-ru.js` | npm `grapesjs` `locale/ru.js` (CommonJS), wrapped in `(function () { var exports = {}; … window.grapesjsLocales.ru = exports.default; })();` so the editor can pass it to `i18n.messagesAdd` |
| `grapick.min.css` | npm `grapick` (`dist/`); the gradient picker of grapesjs-style-bg |
| `grapesjs-preset-webpage.js`, `grapesjs-blocks-basic.js`, `grapesjs-style-bg.js`, `grapesjs-parser-postcss.js`, `grapesjs-plugin-forms.js`, `grapesjs-navbar.js`, `grapesjs-component-countdown.js`, `grapesjs-custom-code.js`, `grapesjs-tooltip.js`, `grapesjs-typed.js`, `grapesjs-style-gradient.js`, `grapesjs-style-filter.js`, `grapesjs-plugin-export.js`, `grapesjs-tui-image-editor.js` | npm, `dist/index.js` |
| `grapesjs-tabs.js` | npm `grapesjs-tabs`, `dist/grapesjs-tabs.min.js` |
| `font-awesome.min.css`, `fontawesome-webfont.woff2`, `fontawesome-webfont.woff` | npm `font-awesome@4.7.0` (`css/`, `fonts/`): GrapesJS' icon font, which it would otherwise load from cdnjs (`cssIcons`). The CSS's `@font-face` is rewritten to these two files in the same folder (`url('fontawesome-webfont.woff2?v=4.7.0')`, then the `.woff`) |
| `tui-code-snippet.min.js`, `tui-color-picker.min.js`, `tui-color-picker.min.css`, `tui-image-editor.min.js`, `tui-image-editor.min.css` | npm (`dist/`): what grapesjs-tui-image-editor would load from uicdn.toast.com |
| `roboto-{latin,cyrillic}-{400,500}-normal.woff2` | npm `@fontsource/roboto@5.3.0` (`files/`), for the theme |
| `grapesjs-cloud-assets.js`, `dropbox-callback.html`, `microsoft-callback.html` | npm `grapesjs-cloud-assets` (`dist/`; the sign-in popups return to the two pages) |
| `grapesjs-sidebar-tools.js`, `grapesjs-context-menu.js`, `grapesjs-fonts.js`, `grapesjs-storage.js` | our plugins, npm, `dist/<name>.umd.cjs` |
| `grapesjs-pages.js` | our grapesjs-pages, published as npm `grapesjs-site-pages`, `dist/grapesjs-pages.umd.cjs` |
| `grapesjs-scripts.js` | our blueprints plugin, npm `grapesjs-blueprints`, `dist/grapesjs-scripts.umd.cjs` (blueprintsjs bundled in) |
| `luna-theme.css` | **ours**, `editor/luna-theme.css`: Luna's theme, light and dark after MUI (dark with `<html data-theme="dark">`, or `system` and a dark OS) (palette, Roboto, radii, elevations), sizes in px so the sidebar (320px) and the block tiles look the same on 4K; it also restyles the plugins written for the dark theme |
| `luna-editor.js` | **ours**: luna-studio's `src/editor` (`npm run build:editor`): the plugins' settings, uploads to luna-files, the status texts. Only in the dashboard's copy (`sync:dashboard` adds it); luna-studio bundles the same code into its app |

The trailing `//# sourceMappingURL=` line is removed from each script (the
maps are not shipped).

## Updating

In luna-studio:

1. Change the version in `package.json` (`devDependencies`, exact pins) and
   `npm install`.
2. `npm run bundle`. The files are taken as the table in
   `scripts/bundle.mjs` says (package, path, transform). A new file: a row
   there; a new script also in `src/editor/bundle.ts` (`SCRIPTS`, the load
   order) and in `editorScripts` in luna-dashboard's
   `app/http/controllers/pages.go`. `node scripts/bundle.mjs --check` fails
   when `public/editor` is not what the packages give.
3. `npm test`, `npm run build`, try it (`npm start -- ./site`).
4. `npm run sync:dashboard`, then in luna-dashboard
   `go test ./tests/ -run Editor` and open an application's Pages.

Our plugins are tested against the pinned GrapesJS too (their suites pass on
0.21.13 and 0.23.9).
