import { defineConfig } from 'vite';
import { resolve } from 'node:path';

/** dist/editor/luna-editor.js: the editor setup for luna-dashboard (global `LunaEditor`). */
export default defineConfig({
  publicDir: false,
  build: {
    outDir: 'dist/editor',
    emptyOutDir: true,
    sourcemap: false,
    lib: { entry: resolve(__dirname, 'src/editor/index.ts'), name: 'LunaEditor', formats: ['iife'], fileName: () => 'luna-editor.js' },
  },
});
