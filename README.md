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
  --mcp              connect the editor to Claude's MCP server (see below)
  --mcp-port <n>     its port (default 8765)
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

## Claude (MCP)

Claude can build and change the site in the open editor: a page from a
description, a section moved, buttons made rounder, a layout with a header
and a footer, a mobile version checked on a screenshot. The studio comes
with an MCP server for that, `luna-studio-mcp` (based on grapesjs-mcp):

```
Claude Code ──MCP (stdio)──► luna-studio-mcp ──WebSocket (127.0.0.1:8765)──► the studio's editor
```

1. Add the server to Claude Code. In this repository `.mcp.json` already
   does (after `npm run build`); elsewhere:
   ```
   claude mcp add luna-studio -- node /path/to/luna-studio/bin/luna-studio-mcp.js
   ```
   Claude Desktop: the same command and argument under `mcpServers` in
   `claude_desktop_config.json`.
2. Start the studio with `--mcp` and open it: `luna-studio ./my-site --mcp --open`
   (in development `STUDIO_MCP=1 npm run dev`). The **MCP** chip in the bar
   turns green when Claude's server is there.
3. Ask Claude: *"make a landing page for a coffee shop: hero, three cards,
   a footer"*, *"put the prices above the reviews"*, *"check it on mobile"*.

Changes go through the GrapesJS and grapesjs-pages APIs in the page: they
show at once, autosave like changes by hand, and Ctrl+Z undoes them. It
works the same on a local folder and on a dashboard's application.

The tools: `editor_status`; the records: `list_records`, `open_record`,
`create_record`, `update_record`, `publish`; the open record: `get_page`,
`get_tree`, `add_html`, `update_component`, `remove_component`,
`move_component`, `set_page`, `add_css`, `select_component`, `get_selected`,
`list_blocks`, `add_block`, `set_device`, `get_project_data`,
`load_project_data`, `undo`, `redo`, `screenshot` (desktop, tablet, mobile).
The server also tells Claude how a Luna site is built (the site's CSS,
layouts with `<page-slot>`, pages). There is no tool that runs arbitrary
JavaScript.

| | Server (environment / option) | Studio |
| --- | --- | --- |
| port | `GJS_MCP_PORT`, `--port` (default 8765) | `--mcp-port <n>`, `STUDIO_MCP=<n>` in dev |
| token | `GJS_MCP_TOKEN`, `--token` | `GJS_MCP_TOKEN` |
| page origins | `GJS_MCP_ORIGINS` (default localhost, 127.0.0.1, [::1], any port; `*` any) | |
| answer timeout | `GJS_MCP_TIMEOUT_MS` (default 20000) | |

The WebSocket listens on 127.0.0.1 only and checks the page's `Origin`.
One editor tab at a time is connected (a newer one takes over), and one
server per port: give two Claude sessions different ports. The editor's
canvas shows the open record alone (a page without its layout and the
site's CSS); the preview shows them together.

In other pages the bridge is `LunaEditor.mount({ …, mcp: { url, token, onStatus } })`
or the plugin `mcpBridge(options)` from `src/editor/mcpBridge.ts`.

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
npm test                    # vitest: the folder store, the API, the sign-in, the MCP server
npm run build               # the bundle, dist/editor, dist/app, dist/server
npm run bundle              # only the editor bundle: public/editor from node_modules
npm run sync:dashboard [path]   # the bundle + luna-editor.js into luna-dashboard's resources/editor
```

Every editor file comes from npm: GrapesJS, the official plugins and ours
(`grapesjs-site-pages` — grapesjs-pages' npm name —, `grapesjs-storage`,
`grapesjs-blueprints`, `grapesjs-fonts`, `grapesjs-sidebar-tools`,
`grapesjs-context-menu`, `grapesjs-cloud-assets`), pinned in `devDependencies`.
`npm run bundle` puts them in `public/editor` (git-ignored) with a
`manifest.json` of versions and hashes; see [editor/README.md](editor/README.md).
The server bundles `grapesjs-site-pages/archive` (the archive format). The
published package carries the built app, so it needs only `vite` at run time.

## License

MIT
