/**
 * Verify every text file in the repository is intact UTF-8.
 *
 * WHY THIS EXISTS: one editing route damages these files silently. PowerShell's
 * `Set-Content` decodes UTF-8 through the console code page, so an em dash (or
 * any non-ASCII character) in a file becomes the two-code-point artefact
 * U+9225 + '?'. The file still reads as valid UTF-8 and still parses as
 * JavaScript, so nothing complains — the text is simply wrong. This repository's
 * documents are largely Chinese, so that route is not usable here at all.
 *
 * Detection is deliberately narrow. A bare U+9225 is NOT evidence: these very
 * documents quote the corrupt form when explaining it. Only the artefact (U+9225
 * followed by '?' or U+FFFD), a U+FFFD, or a failed round-trip is reported.
 *
 * Usage: node scripts/check-encoding.mjs
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['.git', 'node_modules', '.tmp-asar', 'dist']);

/** Every candidate text file, excluding build and dependency directories. */
function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}

const files = walk(ROOT);
let damaged = 0;
for (const path of files) {
  const buffer = readFileSync(path);
  // A binary file is out of scope for a text-integrity check.
  if (buffer.includes(0)) continue;
  const text = buffer.toString('utf8');
  const lossless = Buffer.from(text, 'utf8').equals(buffer);
  const replacements = (text.match(/\uFFFD/g) ?? []).length;
  const artefact = (text.match(/\u9225[?\uFFFD]/g) ?? []).length;
  if (lossless && replacements === 0 && artefact === 0) continue;
  damaged += 1;
  console.log(`DAMAGED ${path.slice(ROOT.length + 1)}`);
  console.log(`  round-trip lossless: ${String(lossless)}  U+FFFD: ${String(replacements)}  corrupt artefact: ${String(artefact)}`);
}

console.log(`\nscanned ${String(files.length)} files`);
if (damaged === 0) {
  console.log('PASS: every text file is intact, valid UTF-8.');
} else {
  console.log(`FAIL: ${String(damaged)} file(s) damaged. Repair by rewriting the file with a UTF-8-faithful writer (Node, or the edit tool) — never PowerShell Set-Content.`);
  process.exitCode = 1;
}
