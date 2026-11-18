import path from 'node:path';
import { start } from './index';

const HELP = `luna-studio [folder] [options]

Edits a site kept in a folder (default: ./site) in the browser, with the
editor and plugins of luna-dashboard. The folder is a grapesjs-pages site
archive: zip it, or export it from the studio, and import it into Luna.
Sign in to a dashboard from the studio to edit an application's site
directly.

Options
  --port <n>         port (default 5174; the next free one if taken)
  --host <name>      interface to listen on (default 127.0.0.1)
  --dashboard <url>  the Luna dashboard to sign in to (default https://dashboard.shibisty.com)
  --open             open the browser
  -h, --help         this help
  -v, --version      the version
`;

async function main(argv: string[]): Promise<void> {
  const opts: { dir: string; port?: number; host?: string; dashboard?: string; open?: boolean } = { dir: 'site' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v == null) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '-h' || a === '--help') return void process.stdout.write(HELP);
    else if (a === '-v' || a === '--version') return void process.stdout.write(`${__STUDIO_VERSION__}\n`);
    else if (a === '--port') opts.port = Number(val());
    else if (a.startsWith('--port=')) opts.port = Number(a.slice(7));
    else if (a === '--host') opts.host = val();
    else if (a === '--dashboard') opts.dashboard = val();
    else if (a.startsWith('--dashboard=')) opts.dashboard = a.slice(12);
    else if (a === '--open') opts.open = true;
    else if (a.startsWith('-')) throw new Error(`unknown option ${a} (see --help)`);
    else opts.dir = a;
  }
  if (opts.port != null && !(opts.port >= 0 && opts.port < 65536)) throw new Error('--port: a number from 0 to 65535');
  const s = await start(opts);
  process.stdout.write(`luna-studio ${__STUDIO_VERSION__}\n  site    ${path.resolve(opts.dir)}\n  editor  ${s.url}\n`);
  const stop = () => {
    void s.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

declare const __STUDIO_VERSION__: string;

main(process.argv.slice(2)).catch((e) => {
  process.stderr.write(`luna-studio: ${(e as Error).message}\n`);
  process.exit(1);
});
