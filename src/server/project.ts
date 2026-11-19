/**
 * A Luna Studio project: a folder with `lunastudio.json` (where the site
 * is, the port, Claude's MCP), a `package.json` whose scripts call
 * `lunastudio`, and the site folder. `lunastudio new` makes one; the other
 * commands find the nearest `lunastudio.json` upwards from the working
 * directory.
 */
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { SiteStore } from './siteStore';

export const CONFIG_FILE = 'lunastudio.json';

export interface ProjectConfig {
  /** The site folder, relative to the config (default `site`). */
  site?: string;
  /** The studio's port (default 5174; the next free one if taken). */
  port?: number;
  /** The interface to listen on (default 127.0.0.1). */
  host?: string;
  /** The dashboard to sign in to. */
  dashboard?: string;
  /** Open the browser on `start`. */
  open?: boolean;
  /** Claude's MCP server: `true` for port 8765, or its port and token. Both `start` and `mcp` read it. */
  mcp?: boolean | { port?: number; token?: string };
}

export interface Project {
  /** The folder of `lunastudio.json`. */
  root: string;
  file: string;
  config: ProjectConfig;
}

/** The nearest `lunastudio.json` from `dir` upwards, or null. */
export async function findProject(dir: string = process.cwd()): Promise<Project | null> {
  let d = path.resolve(dir);
  for (;;) {
    const file = path.join(d, CONFIG_FILE);
    if (existsSync(file)) {
      let config: ProjectConfig;
      try {
        config = JSON.parse(await fs.readFile(file, 'utf8'));
      } catch (e) {
        throw new Error(`${file}: ${(e as Error).message}`);
      }
      if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error(`${file}: an object is expected`);
      return { root: d, file, config };
    }
    const up = path.dirname(d);
    if (up === d) return null;
    d = up;
  }
}

/** The site folder of a project. */
export const siteDir = (p: Project): string => path.resolve(p.root, p.config.site || 'site');

/** An npm package name from a folder name. */
export function packageName(name: string): string {
  const n = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[._-]+|[-]+$/g, '')
    .slice(0, 214);
  return n || 'luna-site';
}

export interface NewOptions {
  /** The site's name (default: the folder's). */
  title?: string;
  /** The luna-studio range in devDependencies (default `^<this version>`). */
  version: string;
  /** Claude's MCP port (default 8765). */
  mcpPort?: number;
  /** The studio's port (default 5174). */
  port?: number;
}

const BIN = 'node_modules/luna-studio/bin/lunastudio.js';

/** Writes a new project into `dir` (which must be missing or empty). Returns the files written. */
export async function createProject(dir: string, opts: NewOptions): Promise<string[]> {
  const root = path.resolve(dir);
  if (existsSync(root)) {
    const st = await fs.stat(root);
    if (!st.isDirectory()) throw new Error(`${root} is a file`);
    const left = (await fs.readdir(root)).filter((f) => f !== '.git');
    if (left.length) throw new Error(`${root} is not empty`);
  }
  const folder = path.basename(root);
  const title = (opts.title || folder).trim() || 'Site';
  const written: string[] = [];
  const write = async (rel: string, text: string) => {
    await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await fs.writeFile(path.join(root, rel), text);
    written.push(rel);
  };

  const config: ProjectConfig = { site: 'site', port: opts.port ?? 5174, mcp: opts.mcpPort ? { port: opts.mcpPort } : true };
  await write(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n');
  await write(
    'package.json',
    JSON.stringify(
      {
        name: packageName(folder),
        version: '0.1.0',
        private: true,
        description: `${title}: a site made with Luna Studio`,
        scripts: {
          start: 'lunastudio start --open',
          studio: 'lunastudio start',
          mcp: 'lunastudio mcp',
          export: 'lunastudio export',
          import: 'lunastudio import',
        },
        devDependencies: { 'luna-studio': opts.version },
      },
      null,
      2
    ) + '\n'
  );
  // Claude Code starts the MCP server itself: node and a path work the same on every OS (npx needs `cmd /c` on Windows).
  await write('.mcp.json', JSON.stringify({ mcpServers: { 'luna-studio': { command: 'node', args: [BIN, 'mcp'] } } }, null, 2) + '\n');
  await write('.gitignore', 'node_modules/\n*.zip\n*.log\n');
  await write(
    'CLAUDE.md',
    `# ${title}

A site made with Luna Studio. The site lives in \`site/\`: a grapesjs-pages
site archive (\`manifest.json\`, \`site/\`, \`layouts/\`, \`templates/\`,
\`pages/\`) plus the studio's own \`.studio/\`.

- Build and change the site through the \`luna-studio\` MCP tools, in the
  running editor (\`npm start\`), not by editing files under \`site/\`: the
  studio holds the site in memory and writes those files itself.
- Start with \`editor_status\`; if the editor is not connected, ask the user
  to run \`npm start\` and keep the studio's tab open.
- Shared styles go in the site record, the header and footer in a layout
  with \`<page-slot></page-slot>\`, content in pages. Check pages with
  \`screenshot\` on desktop and mobile; \`publish\` writes the HTML.
- \`npm run export\` packs the site as a ZIP that a Luna dashboard imports.
`
  );
  await write(
    'README.md',
    `# ${title}

A site made with [Luna Studio](https://www.npmjs.com/package/luna-studio).

\`\`\`
npm install
npm start               # the editor at http://localhost:${config.port}
npm run export          # the site as a ZIP for a Luna dashboard
\`\`\`

With Claude Code: run \`claude\` in this folder while the studio is open
and ask for a page; it works in the editor through the \`luna-studio\` MCP
server (\`.mcp.json\`).
`
  );

  // The site: its name and an empty home page.
  const store = new SiteStore(path.join(root, config.site!), { saveDelay: 0 });
  await store.load();
  store.putSite({ name: title }, null);
  store.put('page', randomUUID(), { name: 'Home', slug: '/', data: { assets: [], styles: [], pages: [{ frames: [{ component: { type: 'wrapper', components: [] } }] }] } }, null);
  await store.flush();
  written.push(`${config.site}/`);
  return written;
}
