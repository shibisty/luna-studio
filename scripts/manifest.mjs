// Shared by the vendor scripts: public/editor/manifest.json entries with sha256.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** A built file as the bundle keeps it: without the trailing sourceMappingURL line. */
export function stripMap(buf) {
  const s = buf.toString('utf8');
  const out = s.replace(/\n?\/\/# sourceMappingURL=[^\n]*\s*$/, '\n').replace(/\n\n$/, '\n');
  return Buffer.from(out);
}

export function readManifest(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** Sets (or adds) a file's entry; keeps the list sorted by file name. */
export function setEntry(m, entry) {
  const i = m.files.findIndex((f) => f.file === entry.file);
  if (i >= 0) m.files[i] = { ...m.files[i], ...entry };
  else m.files.push(entry);
  m.files.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
}

export function writeManifest(file, m) {
  writeFileSync(file, JSON.stringify(m, null, 2) + '\n');
}
