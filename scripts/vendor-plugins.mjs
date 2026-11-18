// Takes our plugins' builds (../plugins/<name>/dist) into public/editor and
// updates manifest.json. Build the plugins first (npm run build in each).
//   node scripts/vendor-plugins.mjs [name ...]   (default: all of them)
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readManifest, setEntry, sha256, stripMap, writeManifest } from './manifest.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const plugins = resolve(root, process.env.STUDIO_PLUGINS || '../plugins');
const out = resolve(root, 'public/editor');
const ALL = ['grapesjs-pages', 'grapesjs-storage', 'grapesjs-sidebar-tools', 'grapesjs-context-menu', 'grapesjs-fonts', 'grapesjs-scripts'];
const names = process.argv.slice(2).length ? process.argv.slice(2) : ALL;
const manifestFile = resolve(out, 'manifest.json');
const m = readManifest(manifestFile);
for (const name of names) {
  const dir = resolve(plugins, name);
  const file = resolve(dir, 'dist', `${name}.umd.cjs`);
  if (!existsSync(file)) {
    console.warn(`skip ${name}: no ${file} (npm run build there)`);
    continue;
  }
  const pkg = JSON.parse(readFileSync(resolve(dir, 'package.json'), 'utf8'));
  const buf = stripMap(readFileSync(file));
  writeFileSync(resolve(out, `${name}.js`), buf);
  setEntry(m, { file: `${name}.js`, package: name, version: pkg.version, sha256: sha256(buf) });
  console.log(`${name}.js  ${pkg.version}`);
}
writeManifest(manifestFile, m);
