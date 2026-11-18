import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { preview } from 'vite';
import { createStudio, studioPlugin, type StudioOptions } from './studio';

export { createStudio, studioPlugin, DEFAULT_DASHBOARD, STUDIO_HEADER } from './studio';
export type { Studio, StudioOptions } from './studio';
export { SiteStore } from './siteStore';
export { Remote, normalizeDashboard, CLIENT_ID } from './remote';

export interface StartOptions extends StudioOptions {
  port?: number;
  host?: string;
  open?: boolean;
  /** The built app (default: dist/app next to this file). */
  appDir?: string;
}

/** Starts the studio: the built app and the API on a Vite preview server. Resolves to its URL. */
export async function start(opts: StartOptions): Promise<{ url: string; close: () => Promise<void> }> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const appDir = opts.appDir || path.resolve(here, '../app');
  const studio = createStudio(opts);
  await studio.ready;
  const server = await preview({
    configFile: false,
    root: path.dirname(appDir),
    logLevel: 'warn',
    build: { outDir: path.basename(appDir) },
    preview: { port: opts.port ?? 5174, host: opts.host || '127.0.0.1', strictPort: false, open: opts.open ?? false },
    plugins: [studioPlugin({ ...opts, studio })],
  });
  const addr = server.httpServer.address();
  const port = typeof addr === 'object' && addr ? addr.port : opts.port ?? 5174;
  const host = !opts.host || opts.host === '127.0.0.1' || opts.host === '0.0.0.0' ? 'localhost' : opts.host;
  return {
    url: `http://${host}:${port}/`,
    close: async () => {
      await studio.store.flush();
      await new Promise<void>((r) => server.httpServer.close(() => r()));
    },
  };
}
