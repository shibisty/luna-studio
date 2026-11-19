/**
 * `lunastudio`: the command line. `lunastudio <command> [options]`; a first
 * argument that is no command is a folder for `start` (as `luna-studio
 * <folder>` always worked).
 */
import { spawn } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { readArchive } from 'grapesjs-site-pages/archive';
import { SiteStore } from './siteStore';
import { mcpConfig, type StudioOptions } from './studio';
import { createProject, findProject, siteDir, type Project, CONFIG_FILE } from './project';

declare const __STUDIO_VERSION__: string;
export const VERSION = typeof __STUDIO_VERSION__ === 'string' ? __STUDIO_VERSION__ : '0.0.0';

const out = (s: string) => process.stdout.write(s);

const HELP = `lunastudio ${VERSION}: the Luna site editor on your computer

Usage
  lunastudio new <name> [options]    a new site project in the folder <name>
  lunastudio start [folder] [opts]   the editor at http://localhost:5174
  lunastudio mcp [options]           Claude's MCP server on stdio (Claude Code starts it)
  lunastudio export [file.zip]       the site as an archive a Luna dashboard imports
  lunastudio import <file.zip>       replace the site's designs with an archive's
  lunastudio help [command]          more about a command

In a project (a folder with ${CONFIG_FILE}, upwards from here) the
commands use its site folder, ports and settings; elsewhere the site is
./site, or the folder given. Options on the command line win.

  -v, --version   the version
  -h, --help      this help
`;

const COMMAND_HELP: Record<string, string> = {
  new: `lunastudio new <name> [options]

Makes the folder <name> (missing or empty) with:
  ${CONFIG_FILE}   the site folder, the port, Claude's MCP
  package.json      scripts start, studio, mcp, export, import; luna-studio in devDependencies
  site/             the site: an empty home page
  .mcp.json         the MCP server for Claude Code; CLAUDE.md, README.md, .gitignore
then runs npm install.

Options
  --title <text>       the site's name (default: <name>)
  --port <n>           the studio's port (default 5174)
  --mcp-port <n>       Claude's MCP port (default 8765); give each project its own to run them together
  --no-install         do not run npm install
  --git                git init and a first commit
  --from <spec>        the luna-studio dependency (default ^${VERSION}; a .tgz path or a git URL works too)
`,
  start: `lunastudio start [folder] [options]

Edits the site in the browser. The folder is a grapesjs-pages site archive
(created when missing). Sign in to a Luna dashboard from the studio to edit
an application's site directly. Stops with Ctrl+C.

Options
  --port <n>          port (default 5174; the next free one if taken)
  --host <name>       interface to listen on (default 127.0.0.1)
  --dashboard <url>   the Luna dashboard to sign in to (default https://dashboard.shibisty.com)
  --open              open the browser
  --mcp               connect the editor to Claude's MCP server (lunastudio mcp)
  --mcp-port <n>      its port (default 8765); implies --mcp
  --no-mcp            not even when ${CONFIG_FILE} says so
`,
  mcp: `lunastudio mcp [options]

The MCP server on stdio, for Claude Code or Claude Desktop to start:
  claude mcp add luna-studio -- lunastudio mcp
(a project made by lunastudio new has it in .mcp.json). The editor of
\`lunastudio start --mcp\` connects to it over ws://127.0.0.1:<port>.

Options
  --port <n>     the WebSocket port (default: the project's, GJS_MCP_PORT or 8765)
  --token <t>    a token the editor must send (default: the project's or GJS_MCP_TOKEN)
`,
  export: `lunastudio export [file.zip] [--site <folder>]

Writes the site as a grapesjs-pages archive (default <site name>-<date>.zip
here); "-" writes it to stdout. A Luna dashboard imports it (Export / Import
ZIP in the editor), and so does lunastudio import.
`,
  import: `lunastudio import <file.zip> [--site <folder>]

Replaces the site's designs (site, layouts, templates, pages) with the
archive's; entries of templates stay. Stop the studio first.
`,
};

/* ---------------- arguments ---------------- */

interface Parsed {
  args: string[];
  opts: Record<string, string | boolean>;
}

/** `--x v`, `--x=v`, `--flag`, `--no-flag`; `values` lists the options that take a value. */
export function parseArgs(argv: string[], values: string[], flags: string[]): Parsed {
  const args: string[] = [];
  const opts: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      args.push(...argv.slice(i + 1));
      break;
    }
    if (a === '-h') opts.help = true;
    else if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = a.slice(2, eq < 0 ? undefined : eq);
      if (values.includes(name)) {
        const v = eq < 0 ? argv[++i] : a.slice(eq + 1);
        if (v == null || (eq < 0 && v.startsWith('--'))) throw new Error(`--${name} needs a value`);
        opts[name] = v;
      } else if (flags.includes(name) && eq < 0) opts[name] = true;
      else if (name.startsWith('no-') && flags.includes(name.slice(3)) && eq < 0) opts[name.slice(3)] = false;
      else if (name === 'help') opts.help = true;
      else throw new Error(`unknown option ${a} (see lunastudio help)`);
    } else if (a.startsWith('-') && a !== '-') throw new Error(`unknown option ${a} (see lunastudio help)`);
    else args.push(a);
  }
  return { args, opts };
}

const portOf = (v: unknown, name: string, min = 0): number | undefined => {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > 65535) throw new Error(`--${name}: a port number`);
  return n;
};

/* ---------------- the running studio ---------------- */

const serverFile = (site: string) => path.join(site, '.studio', 'server.json');

/** The studio serving this site folder now, if any. */
export async function runningStudio(site: string): Promise<{ pid: number; url: string } | null> {
  try {
    const s = JSON.parse(await fs.readFile(serverFile(site), 'utf8'));
    process.kill(s.pid, 0);
    return s;
  } catch {
    return null;
  }
}

/* ---------------- commands ---------------- */

async function cmdStart(argv: string[], project: Project | null): Promise<void> {
  const { args, opts } = parseArgs(argv, ['port', 'host', 'dashboard', 'mcp-port'], ['open', 'mcp']);
  if (opts.help) return void out(COMMAND_HELP.start);
  if (args.length > 1) throw new Error('start takes one folder');
  const c = project?.config || {};
  const dir = args[0] ? path.resolve(args[0]) : project ? siteDir(project) : path.resolve('site');
  let mcp: StudioOptions['mcp'] = c.mcp ?? null;
  if (opts['mcp-port'] !== undefined) mcp = { ...(typeof mcp === 'object' && mcp ? mcp : {}), port: portOf(opts['mcp-port'], 'mcp-port', 1) };
  else if (opts.mcp === true) mcp = mcp || true;
  if (opts.mcp === false) mcp = null;

  const other = await runningStudio(dir);
  if (other) throw new Error(`a studio already serves ${dir} at ${other.url} (pid ${other.pid})`);

  const { start } = await import('./index');
  const s = await start({
    dir,
    port: portOf(opts.port, 'port') ?? c.port,
    host: (opts.host as string) ?? c.host,
    dashboard: (opts.dashboard as string) ?? c.dashboard,
    open: (opts.open as boolean | undefined) ?? c.open ?? false,
    mcp,
  });
  await fs.mkdir(path.dirname(serverFile(dir)), { recursive: true });
  await fs.writeFile(serverFile(dir), JSON.stringify({ pid: process.pid, url: s.url }) + '\n');
  const m = mcpConfig(mcp);
  out(`luna-studio ${VERSION}\n  site    ${dir}\n  editor  ${s.url}\n${m ? `  mcp     ${m.url}\n` : ''}`);
  // Vite's preview server exits on SIGTERM by itself: forget the server file on any exit.
  process.on('exit', () => rmSync(serverFile(dir), { force: true }));
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void s.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  process.on('SIGHUP', stop);
}

async function cmdMcp(argv: string[], project: Project | null): Promise<void> {
  const { opts } = parseArgs(argv, ['port', 'token'], []);
  if (opts.help) return void process.stderr.write(COMMAND_HELP.mcp);
  const pm = project?.config.mcp;
  const fromProject = typeof pm === 'object' && pm ? pm : {};
  const { serveMcp } = await import('../mcp/stdio');
  await serveMcp({
    port: portOf(opts.port, 'port') ?? fromProject.port ?? undefined,
    token: (opts.token as string) ?? fromProject.token ?? undefined,
  });
}

async function siteFor(opts: Record<string, string | boolean>, project: Project | null): Promise<string> {
  const dir = typeof opts.site === 'string' ? path.resolve(opts.site) : project ? siteDir(project) : path.resolve('site');
  if (!existsSync(path.join(dir, 'manifest.json'))) throw new Error(`${dir} is not a site folder (no manifest.json)`);
  return dir;
}

async function cmdExport(argv: string[], project: Project | null): Promise<void> {
  const { args, opts } = parseArgs(argv, ['site'], []);
  if (opts.help) return void out(COMMAND_HELP.export);
  const store = new SiteStore(await siteFor(opts, project));
  await store.load();
  const bytes = store.zip();
  if (args[0] === '-') return void process.stdout.write(Buffer.from(bytes));
  const name = (store.records.get('site')?.name || 'site').replace(/[^\p{L}\p{N}._-]+/gu, '-') || 'site';
  const file = path.resolve(args[0] || `${name}-${new Date().toISOString().slice(0, 10)}.zip`);
  await fs.writeFile(file, bytes);
  out(`${file} (${store.archiveRecords().length} records, ${bytes.length} bytes)\n`);
}

async function cmdImport(argv: string[], project: Project | null): Promise<void> {
  const { args, opts } = parseArgs(argv, ['site'], []);
  if (opts.help) return void out(COMMAND_HELP.import);
  if (args.length !== 1) throw new Error('import takes one archive (see lunastudio help import)');
  const dir = typeof opts.site === 'string' ? path.resolve(opts.site) : project ? siteDir(project) : path.resolve('site');
  const running = await runningStudio(dir);
  if (running) throw new Error(`the studio at ${running.url} has this site open: stop it first, or use Import ZIP in the editor`);
  let arc;
  try {
    arc = readArchive(new Uint8Array(await fs.readFile(args[0])));
  } catch (e) {
    throw new Error(`${args[0]}: not a site archive (${(e as Error).message})`);
  }
  const store = new SiteStore(dir, { saveDelay: 0 });
  await store.load();
  const n = store.replaceAll(arc);
  await store.flush();
  out(`${dir}: ${n} records from ${path.basename(args[0])}\n`);
}

function run(cmd: string, args: string[], cwd: string): Promise<number> {
  return new Promise((resolve) => {
    // npm is npm.cmd on Windows: through the shell there.
    const p = spawn(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
    p.on('error', () => resolve(-1));
    p.on('exit', (code) => resolve(code ?? 1));
  });
}

async function cmdNew(argv: string[]): Promise<void> {
  const { args, opts } = parseArgs(argv, ['title', 'port', 'mcp-port', 'from'], ['install', 'git']);
  if (opts.help) return void out(COMMAND_HELP.new);
  if (args.length !== 1) throw new Error('new takes the project name (see lunastudio help new)');
  const dir = path.resolve(args[0]);
  const shown = path.relative(process.cwd(), dir) || '.';
  const files = await createProject(dir, {
    title: opts.title as string | undefined,
    version: (opts.from as string) || `^${VERSION}`,
    port: portOf(opts.port, 'port', 1),
    mcpPort: portOf(opts['mcp-port'], 'mcp-port', 1),
  });
  out(`Created ${dir}\n${files.map((f) => `  ${f}\n`).join('')}`);
  let installed = opts.install !== false;
  if (installed) {
    out('\nnpm install\n');
    installed = (await run('npm', ['install'], dir)) === 0;
    if (!installed) out('npm install failed: run it in the folder yourself.\n');
  }
  if (opts.git) {
    const ok = (await run('git', ['init', '-q'], dir)) === 0 && (await run('git', ['add', '-A'], dir)) === 0 && (await run('git', ['commit', '-q', '-m', 'A new Luna Studio site'], dir)) === 0;
    if (!ok) out('git: could not make the first commit (is git installed and your name set?).\n');
  }
  out(`
Next:
  cd ${shown.includes(' ') ? JSON.stringify(shown) : shown}
${installed ? '' : '  npm install\n'}  npm start            the editor
  claude               Claude Code, with the luna-studio MCP server of .mcp.json
`);
}

const COMMANDS: Record<string, (argv: string[], project: Project | null) => Promise<void>> = {
  start: cmdStart,
  mcp: cmdMcp,
  export: cmdExport,
  import: cmdImport,
  new: (argv) => cmdNew(argv),
};

export async function main(argv: string[]): Promise<void> {
  const [first, ...rest] = argv;
  if (first === '-v' || first === '--version' || first === 'version') return void out(`${VERSION}\n`);
  // Bare `lunastudio`: start a project or ./site as before; elsewhere the help.
  if (first === undefined && !(await findProject()) && !existsSync(path.resolve('site'))) return void out(HELP);
  if (first === '-h' || first === '--help' || first === 'help') {
    const c = rest[0];
    return void out(c && COMMAND_HELP[c] ? COMMAND_HELP[c] : HELP);
  }
  const cmd = first && COMMANDS[first] ? first : 'start';
  const cmdArgs = first && COMMANDS[first] ? rest : argv;
  const project = cmd === 'new' ? null : await findProject();
  await COMMANDS[cmd](cmdArgs, project);
}
