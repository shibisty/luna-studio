// Copies the editor bundle (public/editor + dist/editor/luna-editor.js) into
// luna-dashboard's resources/editor, which the dashboard embeds and serves at
// /assets/editor. The studio is the source of the bundle; the dashboard's
// test checks every file against manifest.json.
//   node scripts/sync-dashboard.mjs [path to luna-dashboard]   (default ../../luna/luna-dashboard)
import { copyFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readManifest, setEntry, sha256, writeManifest } from './manifest.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dash = resolve(process.argv[2] || resolve(root, '../../luna/luna-dashboard'));
const target = resolve(dash, 'resources/editor');
if (!existsSync(target)) throw new Error(`no ${target}`);
const src = resolve(root, 'public/editor');
const built = resolve(root, 'dist/editor/luna-editor.js');
if (!existsSync(built)) throw new Error('build first: npm run build:editor');

const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const m = readManifest(resolve(src, 'manifest.json'));
const editor = readFileSync(built);
setEntry(m, { file: 'luna-editor.js', package: 'luna-studio', version: pkg.version, source: 'ours: luna-studio (src/editor), npm run build:editor', sha256: sha256(editor) });
let n = 0;
for (const f of readdirSync(src)) {
  if (f === 'manifest.json') continue;
  copyFileSync(resolve(src, f), resolve(target, f));
  n++;
}
writeFileSync(resolve(target, 'luna-editor.js'), editor);
// Every listed file must be there with its hash.
for (const e of m.files) {
  const b = readFileSync(resolve(target, e.file));
  if (sha256(b) !== e.sha256) throw new Error(`${e.file}: the hash in manifest.json is wrong`);
}
writeManifest(resolve(target, 'manifest.json'), m);
console.log(`${n + 1} files → ${target}`);
