import { defineConfig } from 'vite';
import { studioPlugin } from './src/server/studio';

/**
 * `npm run dev`: the studio with hot reload, the API in the dev server.
 * `npm run build:app`: the app into dist/app (the CLI serves it).
 * The site folder in dev: STUDIO_DIR (default ./site).
 */
export default defineConfig(({ command }) => ({
  publicDir: 'public',
  build: { outDir: 'dist/app', emptyOutDir: true },
  server: { port: 5174, host: '127.0.0.1' },
  plugins: command === 'serve' ? [studioPlugin({ dir: process.env.STUDIO_DIR || 'site', dashboard: process.env.STUDIO_DASHBOARD })] : [],
}));
