# luna-studio

The Luna site editor on your computer: GrapesJS with every plugin and
setting luna-dashboard's editor has (grapesjs-pages, grapesjs-storage,
grapesjs-fonts, grapesjs-scripts, sidebar-tools, the official plugins, Luna's
theme), served by a small Vite server at `http://localhost:<port>`.

- **Local folder.** The site lives in a folder on disk. The folder *is* a
  grapesjs-pages site archive (see below), so you can zip it, keep it in git,
  open its HTML in other tools and import it into any Luna application.
- **Signed in to a dashboard.** Sign in to your Luna dashboard from the
  studio and pick an application: the editor then works on that
  application's site in luna-pages directly, as the dashboard's editor does
  (publishing, revisions, images in luna-files).
- **Between the two.** *Upload the folder here* writes the folder's designs
  into the open application; *Save to the folder* replaces the folder's
  designs with the application's. *Export ZIP* / *Import ZIP* work in both
  modes (also in the dashboard's own editor).

```
npx luna-studio ./my-site --open
```

```
luna-studio [folder] [options]

  --port <n>         port (default 5174; the next free one if taken)
  --host <name>      interface to listen on (default 127.0.0.1)
  --dashboard <url>  the Luna dashboard to sign in to (default https://dashboard.shibisty.com)
  --open             open the browser
```

Node 20 or newer. The editor's files are in the package; nothing is fetched
from CDNs except what a site itself uses (web fonts, typed.js).

## The folder

```
my-site/
  manifest.json            the records and their header fields (format grapesjs-pages-archive, version 1)
  site/                    project.json, style.css, settings.json
  layouts/<name>/          project.json, body.html, style.css
  templates/<name>/        project.json, body.html, style.css, index.html, fields.json
  pages/<address>/         project.json, body.html, style.css, index.html   (/ → pages/index)
  .studio/                 versions, publish state, entries of templates, revisions (the studio's own)
```

`project.json` is the GrapesJS project and is what the editor loads.
`body.html` and `style.css` are what the last *Publish* produced and
`index.html` a standalone preview (the site's CSS, the page in its layout):
open it in a browser, or edit `body.html` / `style.css` in another tool.
When the studio starts (or on *reload*, `POST /studio/api/reload`), a
`body.html` or `style.css` that changed outside is taken into the record
(GrapesJS parses it; settings of components plain HTML cannot carry are
lost) and the record gets a new version.

Entries of templates and their values are content, not design: they stay in
`.studio/entries.json` and are not part of the archive.

## Signing in

The studio uses OAuth 2.0's authorization code flow with PKCE against the
dashboard (`/studio/authorize`, `/studio/token`): the browser goes to the
dashboard, you sign in there as usual and allow the studio, and the
dashboard sends the browser back to the studio. The token stays in the
studio's server process and in `~/.luna-studio/credentials.json` (mode 600);
the browser never sees it: the editor's calls go through the studio
(`/studio/remote/<app>/pages|files/…`), which adds it. The dashboard lists
signed-in studios at *Studios* (`/studio/tokens`), where you sign them out;
a sign-in lapses after 30 days without use.

The dashboard accepts callbacks only on your own machine
(`http://localhost:<port>`, `127.0.0.1`, `[::1]`) or the desktop app's scheme
`luna-studio:` (for an Electron build).

## Embedding and the desktop app

The server is a library too:

```js
import { start, createStudio, studioPlugin } from 'luna-studio';

const { url, close } = await start({ dir: './site', port: 0 });   // the app + the API
// or: createStudio({ dir }).handle as Connect middleware, studioPlugin({ dir }) in a Vite config
```

An Electron shell runs `start()` in its main process, opens `url` in a
`BrowserWindow`, and registers the `luna-studio:` scheme for the sign-in
callback (then it calls `studio.remote.finish(params)` itself).

The editor setup alone is `luna-studio/editor` (`dist/editor/luna-editor.js`,
global `LunaEditor`): `LunaEditor.mount({ container, pagesApi, contentApi, … })`
after the bundle's scripts. luna-dashboard serves the same file.

## The API (under `/studio/`)

| | |
| --- | --- |
| `GET api/state` | the folder, the signed-in dashboards |
| `POST api/sign-in` `{url}` → `{location}`, `GET auth/callback`, `POST api/sign-out`, `POST api/use` | signing in |
| `GET api/apps`, `GET api/me` | the dashboard's applications, the developer |
| `GET api/export.zip` | the folder as an archive |
| `POST api/import` (a ZIP) | replace the folder's designs (entries stay) |
| `POST api/reload` | read the folder again |
| `local/editor/…`, `local/content/…` | the folder as luna-pages offers it: grapesjs-pages' contract v2 and grapesjs-storage's content API |
| `remote/<app>/pages/…`, `remote/<app>/files/…` | the dashboard's editor and files APIs, with the token |
| `GET preview/<id>` | a published page in its layout (sandboxed) |
| `GET fonts/…` | the font catalogues (through the dashboard's public proxy) |

Requests that change something need the header `X-Luna-Studio: 1`, and every
request a `localhost` Host: a web page elsewhere cannot add the header
without a CORS preflight (never answered) and DNS rebinding gets 403.

## Development

```
npm install
npm run dev                 # Vite with hot reload; the site in ./site (STUDIO_DIR), STUDIO_DASHBOARD
npm test                    # vitest: the folder store, the API, the sign-in
npm run build               # dist/editor, dist/app, dist/server
npm run vendor:plugins [name]   # our plugins' builds (../plugins/<name>/dist) into public/editor
npm run sync:dashboard [path]   # the bundle + luna-editor.js into luna-dashboard's resources/editor
```

`grapesjs-site-pages` (the grapesjs-pages plugin's npm name) is a dev
dependency from `../plugins/grapesjs-pages` (its `grapesjs-site-pages/archive`
export is bundled into the server). `public/editor`
is the editor bundle with its `manifest.json` (see its README); luna-dashboard
keeps a copy, so update it here and sync.

## License

MIT
