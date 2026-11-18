# The page editor's bundle

GrapesJS, its plugins and Luna's setup of them. **luna-studio is the source**
(`C:\OSPanel6\home\grapesjs\luna-studio`, `public/editor`): it serves these
files at `localhost`, and `npm run sync:dashboard` there copies them into
luna-dashboard's `resources/editor`, which the dashboard serves at
`/assets/editor/<file>` (embedded into the binary; no Node on the servers, no
CDN at runtime). Every file is listed in `manifest.json` with its package,
version and SHA-256; the dashboard's test checks the files against it, so a
file changes only together with its entry (the scripts below keep them in step).

| File | From |
|---|---|
| `grapes.min.js`, `grapes.min.css` | npm `grapesjs` (`dist/`, `dist/css/`) |
| `grapesjs-locale-ru.js` | npm `grapesjs` `locale/ru.js` (CommonJS), wrapped in `(function () { var exports = {}; … window.grapesjsLocales.ru = exports.default; })();` so the editor can pass it to `i18n.messagesAdd` |
| `grapick.min.css` | npm `grapick` (`dist/`); the gradient picker of grapesjs-style-bg |
| `grapesjs-preset-webpage.js`, `grapesjs-blocks-basic.js`, `grapesjs-style-bg.js`, `grapesjs-parser-postcss.js` | npm, `dist/index.js` |
| `font-awesome.min.css`, `fontawesome-webfont.woff2`, `fontawesome-webfont.woff` | npm `font-awesome@4.7.0` (`css/`, `fonts/`): GrapesJS' icon font, which it would otherwise load from cdnjs (`cssIcons`). The CSS's `@font-face` is rewritten to these two files in the same folder (`url('fontawesome-webfont.woff2?v=4.7.0')`, then the `.woff`) |
| `grapesjs-plugin-forms.js`, `grapesjs-navbar.js`, `grapesjs-component-countdown.js`, `grapesjs-custom-code.js`, `grapesjs-tooltip.js`, `grapesjs-typed.js`, `grapesjs-style-gradient.js`, `grapesjs-style-filter.js`, `grapesjs-plugin-export.js`, `grapesjs-tui-image-editor.js` | npm, `dist/index.js` |
| `grapesjs-tabs.js` | npm `grapesjs-tabs`, `dist/grapesjs-tabs.min.js` |
| `tui-code-snippet.min.js`, `tui-color-picker.min.js`, `tui-color-picker.min.css`, `tui-image-editor.min.js`, `tui-image-editor.min.css` | npm (`dist/`): what grapesjs-tui-image-editor would load from uicdn.toast.com |
| `grapesjs-cloud-assets.js`, `dropbox-callback.html`, `microsoft-callback.html` | [grapes-cloud](https://github.com/shibisty/grapes-cloud): `npm run build`, and `public/` (the sign-in popups return there) |
| `luna-theme.css` | **ours**: Luna's theme, light and dark after MUI (dark with `<html data-theme="dark">`, or `system` and a dark OS) (palette, Roboto, radii, elevations), sizes in px so the sidebar (320px) and the block tiles look the same on 4K; it also restyles the plugins written for the dark theme. Edit it here (then its hash) |
| `roboto-{latin,cyrillic}-{400,500}-normal.woff2` | npm `@fontsource/roboto@5.3.0` (`files/`), for the theme |
| `grapesjs-sidebar-tools.js`, `grapesjs-context-menu.js`, `grapesjs-pages.js`, `grapesjs-storage.js`, `grapesjs-fonts.js`, `grapesjs-scripts.js` | our plugins: `npm run build` in the plugin, then `npm run vendor:plugins [name]` in luna-studio (takes `dist/<name>.umd.cjs`, drops the source map line, updates the manifest) |
| `luna-editor.js` | **ours**: luna-studio's `src/editor` (`npm run build:editor`): the plugins' settings, uploads to luna-files, the status texts. Only in the dashboard's copy (`sync:dashboard` adds it); luna-studio bundles the same code into its app |

The trailing `//# sourceMappingURL=` line is removed from each file (the maps
are not shipped).

## Updating

In luna-studio:

1. Our plugins: build the plugin, then `npm run vendor:plugins <name>`.
   Others: `npm pack <package>@<version>`, take the file from the tarball's
   `package/dist`, copy it into `public/editor` under the name above, drop its
   last line if it is a `//# sourceMappingURL=` comment, and put the version
   and the new hash into `manifest.json` (`sha256sum <file>`, or
   `certutil -hashfile <file> SHA256` on Windows).
2. A new script: add it to `src/editor/bundle.ts` (`SCRIPTS`) and to
   `editorScripts` in luna-dashboard's `app/http/controllers/pages.go`.
3. `npm test`, `npm run build`, try it (`npm start -- ./site`).
4. `npm run sync:dashboard`, then in luna-dashboard
   `go test ./tests/ -run Editor` and open an application's Pages.

Our plugins are tested against the pinned GrapesJS too (their suites pass on
0.21.13 and 0.23.9).
