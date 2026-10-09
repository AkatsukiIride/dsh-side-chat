/**
 * Replay the profile composition over the REAL desktop profile and prove the
 * dsh-side-chat row lands in the composed entry list.
 *
 * Implements the normative rules read from
 * @deepseek-ai/dsh-app-boot/lib/index.js:466-509:
 *   - a profile is $DSH_HOME/profiles/<name> with package.json (dsh.profile.bundles)
 *   - each bundle resolves to a package dir and declares dsh.bundle.patch
 *     (one file, or an ordered list)
 *   - the tree is composed by applying each bundle's patch lists in
 *     `dsh.profile.bundles` order over an empty entry list, then the profile's
 *     own cordis.patch.yml
 *   - module resolution is two-anchor: the dsh installation first, then the
 *     profile directory (pnpm-managed entries in the profile resolve first)
 *
 * It reads the top-level `- insert:` lists and `- id:` overrides with a small
 * line scanner rather than a YAML parser, because only row identity matters
 * here. It never boots anything.
 *
 * Usage: node scripts/compose-check.mjs <profileDir> <extractedDshTree>
 *
 * <extractedDshTree> is the `dsh/` directory INSIDE the desktop's
 * `resources/app.asar`, extracted to a real directory — it is not a filesystem
 * path within the installation, because Electron resolves inside the archive.
 * `scripts/extract-asar.mjs` produces it:
 *
 *   node scripts/extract-asar.mjs "<install>/resources/app.asar" <outDir> dsh
 *
 * The profile half needs no extraction: it is read straight from disk.
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';

const profileDir = resolve(process.argv[2] ?? '');
const installDir = resolve(process.argv[3] ?? '');
const TARGET = 'dsh-side-chat';

const problems = [];
const notes = [];
const fail = (message) => problems.push(message);

// ── 1. profile manifest ─────────────────────────────────────────────────────
const manifestPath = join(profileDir, 'package.json');
if (!existsSync(manifestPath)) {
  console.error(`FAIL: no profile package.json at ${manifestPath}`);
  process.exit(1);
}
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const bundles = manifest.dsh?.profile?.bundles;
if (!Array.isArray(bundles) || bundles.length === 0) {
  console.error('FAIL: dsh.profile.bundles is missing or empty');
  process.exit(1);
}
notes.push(`profile: ${profileDir}`);
notes.push(`bundles in order: ${bundles.join(', ')}`);

// ── 2. resolve each bundle, two-anchor (profile first, then installation) ───
/** Resolve a package name to a directory the way the launcher does. */
function resolvePackageDir(name, fromDir) {
  const candidates = [];
  // pnpm-managed entries in the profile node_modules resolve first
  candidates.push(join(profileDir, 'node_modules', ...name.split('/')));
  // the dsh installation carries the shipped bundles
  candidates.push(join(installDir, 'node_modules', ...name.split('/')));
  // walk up from the profile as a last resort (hoisted trees)
  let dir = fromDir;
  for (let i = 0; i < 6; i += 1) {
    candidates.push(join(dir, 'node_modules', ...name.split('/')));
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'package.json'))) return candidate;
  }
  return undefined;
}

/** The patch files a bundle declares, as written (app-boot bundlePatchFiles). */
function bundlePatchFiles(bundle) {
  const declared = typeof bundle.patch === 'string' ? [bundle.patch] : bundle.patch;
  if (!Array.isArray(declared) || !declared.every((file) => typeof file === 'string')) {
    throw new Error('dsh.bundle.patch must be a file path or a list of file paths');
  }
  return declared;
}

const patchFilesInOrder = [];
for (const name of bundles) {
  const packageDir = resolvePackageDir(name, profileDir);
  if (packageDir === undefined) {
    fail(`bundle "${name}" does not resolve from the profile or the installation (it would be skipped)`);
    continue;
  }
  const pkg = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
  const bundleDecl = pkg.dsh?.bundle;
  if (bundleDecl === undefined) {
    notes.push(`bundle ${name}: no dsh.bundle.patch (installed dependency only)`);
    continue;
  }
  let files;
  try {
    files = bundlePatchFiles(bundleDecl);
  } catch (error) {
    fail(`bundle "${name}": ${String(error.message)} (it would be skipped)`);
    continue;
  }
  for (const file of files) {
    const absolute = join(packageDir, file);
    if (!existsSync(absolute)) {
      fail(`bundle "${name}" declares patch ${file} but ${absolute} does not exist (it would be skipped)`);
      continue;
    }
    patchFilesInOrder.push({ bundle: name, path: absolute });
  }
  notes.push(`bundle ${name}: patch ${files.join(', ')}`);
}
// the profile's own patch layer is applied after every bundle layer
const profilePatch = join(profileDir, 'cordis.patch.yml');
if (existsSync(profilePatch)) patchFilesInOrder.push({ bundle: '<profile>', path: profilePatch });
else notes.push('profile: no cordis.patch.yml (no user layer)');

// ── 3. scan each patch for inserted rows and id overrides ───────────────────
/**
 * Read the row identities a patch declares.
 * @param text - patch YAML.
 * @returns inserted row ids and overridden row ids, in file order.
 */
function scanPatch(text) {
  const inserted = [];
  const overridden = [];
  let inInsert = false;
  let insertIndent = -1;
  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.replace(/#.*$/u, '');
    if (line.trim() === '') continue;
    const indent = line.length - line.trimStart().length;
    const trimmed = line.trim();
    if (/^-\s*insert:\s*$/u.test(trimmed)) {
      inInsert = true;
      insertIndent = indent;
      continue;
    }
    if (/^-\s+id:\s*/u.test(trimmed)) {
      const id = trimmed.replace(/^-\s+id:\s*/u, '').trim().replace(/^["']|["']$/gu, '');
      if (inInsert && indent > insertIndent) inserted.push(id);
      else {
        inInsert = false;
        overridden.push(id);
      }
    }
  }
  return { inserted, overridden };
}

const insertedRows = [];
const overriddenRows = [];
for (const patch of patchFilesInOrder) {
  const { inserted, overridden } = scanPatch(readFileSync(patch.path, 'utf8'));
  for (const id of inserted) insertedRows.push({ id, from: patch.bundle });
  for (const id of overridden) overriddenRows.push({ id, from: patch.bundle });
}

// ── 4. assertions ───────────────────────────────────────────────────────────
const row = insertedRows.find((entry) => entry.id === TARGET);
if (row === undefined) {
  fail(`the composed tree has no inserted row with id "${TARGET}"`);
} else {
  notes.push(`row "${TARGET}" inserted by: ${row.from}`);
}

const pluginDir = join(profileDir, 'node_modules', TARGET);
if (!existsSync(pluginDir)) fail(`the profile's node_modules has no ${TARGET} package`);
else {
  const pkg = JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8'));
  // the row names the package, so the Loader resolves it from the profile
  const declared = JSON.stringify(pkg.dsh ?? {});
  if (!declared.includes('"platform":"web"')) fail(`${TARGET}: dsh.client.platform is not "web" — no browser bundle would be served`);
  else notes.push(`${TARGET}: dsh.client.platform = web`);
  if (!existsSync(join(pluginDir, 'lib', 'client.js'))) fail(`${TARGET}: lib/client.js is missing`);
  else notes.push(`${TARGET}: lib/client.js present`);
  if (!existsSync(join(pluginDir, 'lib', 'index.js'))) fail(`${TARGET}: lib/index.js (host half) is missing`);
  else notes.push(`${TARGET}: lib/index.js present`);
}

// the row must be inserted, never disabled by a later override
const disabling = overriddenRows.filter((entry) => entry.id === TARGET);
if (disabling.length > 0) fail(`a later patch overrides row "${TARGET}" (from ${disabling.map((d) => d.from).join(', ')}) — it may be disabled`);

// ── report ──────────────────────────────────────────────────────────────────
console.log('patch layers applied in order:');
for (const patch of patchFilesInOrder) console.log(`  ${patch.bundle.padEnd(34)} ${patch.path}`);
console.log('\nnotes:');
for (const note of notes) console.log(`  ok   ${note}`);
console.log(`\nrows inserted by the composed layers: ${String(insertedRows.length)}`);
if (problems.length === 0) {
  console.log(`\nPASS: the composed profile tree carries the "${TARGET}" row and the browser bundle it names.`);
} else {
  console.log('\nPROBLEMS:');
  for (const problem of problems) console.log(`  - ${problem}`);
  process.exitCode = 1;
}
