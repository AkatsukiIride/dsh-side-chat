/**
 * Extract files from an Electron `app.asar` to a real directory.
 *
 * The desktop ships its DSH tree inside `resources/app.asar`, and Electron
 * resolves module specifiers inside that archive. A plain Node process cannot,
 * so any offline check that needs the SHIPPED packages (replaying the profile
 * composition, reading an official package's manifest, diffing host API surface
 * between releases) needs them on a real filesystem first. That is what this
 * does — and nothing here writes to the installation: the archive is only read.
 *
 * The header format, verified against the real file rather than assumed:
 *   u32 @0  = 4                     (first pickle's payload size)
 *   u32 @4  = header pickle payload size
 *   u32 @8  = JSON string length
 *   @16     = the JSON file table
 * The declared JSON length is PADDED (4 extra NUL bytes on this build), so the
 * table is cut at its final `}` instead of trusting the length.
 *
 * Usage:
 *   node scripts/extract-asar.mjs <app.asar> <outDir> [filter] [--limit N]
 *
 *   filter   optional regular expression tested against each in-archive path
 *            (e.g. `dsh/node_modules/@deepseek-ai/dsh-base/`)
 *   --limit  stop after N files, for a quick look
 *
 * Entries flagged `unpacked` live in `app.asar.unpacked` and are reported, not
 * extracted: they are already on disk next to the archive.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const argv = process.argv.slice(2);
const positional = [];
let limit = Number.POSITIVE_INFINITY;
for (let index = 0; index < argv.length; index += 1) {
  const token = argv[index];
  if (token === '--limit') {
    const value = Number(argv[index + 1]);
    if (!Number.isSafeInteger(value) || value <= 0) {
      console.error('--limit needs a positive integer');
      process.exit(2);
    }
    limit = value;
    index += 1;
    continue;
  }
  positional.push(token);
}
const [asarPath, outDir, filter] = positional;

if (asarPath === undefined || outDir === undefined) {
  console.error('usage: node scripts/extract-asar.mjs <app.asar> <outDir> [filterRegex] [--limit N]');
  process.exit(2);
}
const archive = resolve(asarPath);
const target = resolve(outDir);
if (!existsSync(archive)) {
  console.error(`no such archive: ${archive}`);
  process.exit(2);
}

// ── read the file table ─────────────────────────────────────────────────────
const blob = readFileSync(archive);
const headerSize = blob.readUInt32LE(4);
const jsonSize = blob.readUInt32LE(8);
const tail = blob.subarray(16, 16 + jsonSize + 16).toString('utf8');
const header = JSON.parse(tail.slice(0, tail.lastIndexOf('}') + 1));
const base = 8 + headerSize;

const files = [];
const walk = (node, prefix) => {
  for (const [name, entry] of Object.entries(node.files ?? {})) {
    const path = prefix === '' ? name : `${prefix}/${name}`;
    if (entry.files !== undefined) walk(entry, path);
    else files.push({ path, size: entry.size ?? 0, offset: Number(entry.offset ?? 0), unpacked: entry.unpacked === true });
  }
};
walk(header, '');

const matcher = filter === undefined ? undefined : new RegExp(filter);
const selected = files.filter((entry) => matcher === undefined || matcher.test(entry.path));
if (selected.length === 0) {
  console.error(`no entries matched ${filter === undefined ? '(no filter)' : JSON.stringify(filter)} (archive holds ${String(files.length)} files)`);
  process.exit(2);
}

let written = 0;
let bytes = 0;
const skipped = [];
for (const entry of selected) {
  if (written >= limit) break;
  if (entry.unpacked) { skipped.push(entry.path); continue; }
  const destination = join(target, entry.path.replaceAll('/', '\\'));
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, blob.subarray(base + entry.offset, base + entry.offset + entry.size));
  written += 1;
  bytes += entry.size;
}

console.log(`archive : ${archive}`);
console.log(`table   : ${String(files.length)} files, header ${String(headerSize)} bytes`);
console.log(`filter  : ${filter ?? '(none)'}`);
console.log(`out     : ${target}`);
console.log(`written : ${String(written)} files, ${String(bytes)} bytes`);
if (skipped.length > 0) {
  console.log(`skipped : ${String(skipped.length)} unpacked entries (already on disk in app.asar.unpacked)`);
  for (const path of skipped.slice(0, 5)) console.log(`          ${path}`);
}
