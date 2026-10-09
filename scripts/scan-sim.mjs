/**
 * Simulate the client-modules node half's discovery of a browser bundle.
 *
 * Mirrors the shipped resolution rules read from
 * @deepseek-ai/dsh-client-modules/lib/index.js:
 *   - parseDshClient: dsh.client must be an object with a string `platform`
 *     (lines 39-72)
 *   - resolveMeta: platform must be "web", and a "./client" export must exist,
 *     otherwise the package is rejected or throws (lines 701-731)
 *   - clientPath = <pkg dir>/<clientRel> (line 723)
 *
 * Usage: node scripts/scan-sim.mjs [path-to-package-dir]
 *        (defaults to this repository, i.e. the package itself)
 */
import { readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** This repository, used when no directory is named. */
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkgDir = resolve(process.argv[2] ?? REPO);
const pkgPath = join(pkgDir, 'package.json');
if (!existsSync(pkgPath)) {
  console.error(`no package.json at ${pkgPath}`);
  process.exit(2);
}

const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const problems = [];
const notes = [];

// ── parseDshClient (client-modules:39-72) ───────────────────────────────────
const decl = pkg.dsh && typeof pkg.dsh === 'object' ? pkg.dsh.client : undefined;
if (decl === undefined) {
  console.log('REJECTED: no dsh.client declaration — the node half would not see a client bundle');
  process.exit(1);
}
if (typeof decl !== 'object' || decl === null) problems.push('dsh.client must be an object');
else {
  if (typeof decl.platform !== 'string') problems.push('dsh.client.platform must be a string');
  if (decl.inject !== undefined && (!Array.isArray(decl.inject) || decl.inject.some((x) => typeof x !== 'string'))) {
    problems.push('dsh.client.inject must be a string array');
  }
  if (decl.external !== undefined && (!Array.isArray(decl.external) || decl.external.some((x) => typeof x !== 'string'))) {
    problems.push('dsh.client.external must be a string array');
  }
  if (decl.immediately !== undefined && typeof decl.immediately !== 'boolean') problems.push('dsh.client.immediately must be a boolean');
}
if (decl.platform !== 'web') problems.push(`dsh.client.platform is "${String(decl.platform)}", not "web" — the bundle would never be served`);

// ── clientExportOf (client-modules:718-719) ─────────────────────────────────
const exportsField = pkg.exports;
let clientRel;
if (typeof exportsField === 'string') clientRel = exportsField;
else if (exportsField && typeof exportsField === 'object') {
  const sub = exportsField['./client'];
  if (typeof sub === 'string') clientRel = sub;
  else if (sub && typeof sub === 'object') clientRel = sub.default ?? sub.import ?? sub.require;
}
if (clientRel === undefined) problems.push('no "./client" export — resolveMeta throws "declares dsh.client but exports no \'./client\' bundle"');

// ── the resolved client path must exist and look like a browser bundle ──────
let clientPath;
if (clientRel !== undefined) {
  clientPath = join(dirname(pkgPath), clientRel);
  if (!existsSync(clientPath)) problems.push(`./client export points at a missing file: ${clientPath}`);
  else {
    const size = statSync(clientPath).size;
    notes.push(`client bundle: ${clientPath} (${String(size)} bytes)`);
    const source = readFileSync(clientPath, 'utf8');
    if (!source.includes('__ModuleLoader__.load')) {
      problems.push('the client bundle never calls window.__ModuleLoader__.load — the shell would load an inert file');
    } else {
      const idMatch = /__ModuleLoader__\.load\(\{\s*id:\s*'([^']+)'/.exec(source);
      if (idMatch === null) problems.push('could not read the module id from the __ModuleLoader__.load call');
      else if (idMatch[1] !== pkg.name) problems.push(`module id "${idMatch[1]}" does not match the package name "${pkg.name}"`);
      else notes.push(`module id: ${idMatch[1]}`);
    }
  }
}

// ── the host half the Loader mounts must exist ──────────────────────────────
const main = pkg.main ?? 'index.js';
if (!existsSync(join(pkgDir, main))) problems.push(`"main" points at a missing file: ${main}`);
else notes.push(`host half: ${main}`);

// ── the bundle patch the row composition needs ──────────────────────────────
const patch = pkg.dsh && pkg.dsh.bundle ? pkg.dsh.bundle.patch : undefined;
if (patch !== undefined) {
  if (!existsSync(join(pkgDir, patch))) problems.push(`dsh.bundle.patch points at a missing file: ${patch}`);
  else notes.push(`bundle patch: ${patch}`);
} else notes.push('bundle patch: none declared (installer must add the row itself)');

console.log(`package: ${pkg.name}@${pkg.version}`);
for (const note of notes) console.log(`  ok   ${note}`);
if (problems.length === 0) {
  console.log('ACCEPTED: the client-modules node half would discover and serve this bundle.');
} else {
  console.log('PROBLEMS:');
  for (const problem of problems) console.log(`  - ${problem}`);
  process.exitCode = 1;
}
