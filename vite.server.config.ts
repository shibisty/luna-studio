import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8'));

/** dist/server: the CLI, the API and the MCP server for Node; vite and the MCP SDK stay dependencies, the archive format is bundled. */
export default defineConfig({
  define: { __STUDIO_VERSION__: JSON.stringify(pkg.version) },
  build: {
    ssr: true,
    outDir: 'dist/server',
    emptyOutDir: true,
    target: 'node20',
    rollupOptions: {
      input: {
        index: resolve(__dirname, 'src/server/index.ts'),
        cli: resolve(__dirname, 'src/server/cli.ts'),
        mcp: resolve(__dirname, 'src/mcp/index.ts'),
        'mcp-cli': resolve(__dirname, 'src/mcp/cli.ts'),
      },
      output: { format: 'es', entryFileNames: '[name].js', chunkFileNames: 'chunks/[name]-[hash].js' },
      external: ['vite', /^@modelcontextprotocol\/sdk/, 'ws', 'zod', /^node:/],
    },
  },
  ssr: { noExternal: ['grapesjs-site-pages', 'fflate'] },
});
