/**
 * Verify that every design token the browser bundle references actually exists
 * in the shipped design system.
 *
 * WHY: the bundle styles itself with the shell's CSS custom properties, and a
 * mistyped name is invisible in review — CSS silently uses the fallback, so a
 * `--dsh-*` guess renders as whatever the author wrote as a fallback in EVERY
 * theme. That is how an earlier build drew a near-black card on a light page.
 * This check turns that silence into a failure.
 *
 * Usage:
 *   node scripts/extract-asar.mjs "<install>/resources/app.asar" .tmp-asar \
 *     "dsh/node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js"
 *   node scripts/check-tokens.mjs .tmp-asar/dsh/node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js
 *
 * With no argument it looks for the theme file under the usual extraction
 * directories, so it is safe to wire into `npm test` where the app may be absent.
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BUNDLE = join(REPO, 'lib', 'client.js')

/** Where an extraction may have put the theme file. */
const CANDIDATES = [
  process.argv[2],
  join(REPO, '.tmp-asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-client-ui-theme', 'lib', 'client.js'),
].filter((entry) => typeof entry === 'string' && entry !== '')

const themePath = CANDIDATES.find((candidate) => existsSync(candidate))
if (themePath === undefined) {
  console.log('SKIP: no extracted theme file found, so token existence cannot be checked.')
  console.log('      Extract it first:')
  console.log('        node scripts/extract-asar.mjs "<install>/resources/app.asar" .tmp-asar \\')
  console.log('          "dsh/node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js"')
  process.exit(0)
}

// ── what the bundle references ──────────────────────────────────────────────
const bundle = readFileSync(BUNDLE, 'utf8')
const referenced = [...new Set([...bundle.matchAll(/var\((--[a-zA-Z0-9-]+)/g)].map((match) => match[1]))].sort();

// ── what the design system defines ──────────────────────────────────────────
const theme = readFileSync(themePath, 'utf8')
const defined = new Set([...theme.matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)].map((match) => match[1]))

console.log(`bundle    : ${BUNDLE}`);
console.log(`theme     : ${themePath}`);
console.log(`referenced: ${String(referenced.length)} custom properties`);
console.log(`defined   : ${String(defined.size)} in the design system`);
console.log('');

const missing = referenced.filter((token) => !defined.has(token))
for (const token of referenced) {
  console.log(`  ${missing.includes(token) ? 'MISSING' : 'ok     '} ${token}`);
}

// A referenced token with no fallback is worse: it renders as nothing at all.
const bare = [...new Set([...bundle.matchAll(/var\((--[a-zA-Z0-9-]+)\)/g)].map((match) => match[1]))];
const bareMissing = bare.filter((token) => !defined.has(token))
if (bareMissing.length > 0) {
  console.log('\nReferenced WITHOUT a fallback (would render as nothing):');
  for (const token of bareMissing) console.log(`  - ${token}`);
}

console.log('');
if (missing.length === 0) {
  console.log(`PASS: all ${String(referenced.length)} referenced tokens exist in the shipped design system.`);
} else {
  console.log(`FAIL: ${String(missing.length)} referenced token(s) do not exist: ${missing.join(', ')}`);
  console.log('Their fallbacks are what every theme renders. Use a real --dsw-alias-* token.');
  process.exitCode = 1;
}
