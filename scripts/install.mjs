/**
 * Install (or remove) dsh-side-chat in a DSH profile.
 *
 * Performs exactly three changes, all inside the profile directory:
 *   1. `pnpm add <spec>`  -> dependency + node_modules + lockfile entry
 *   2. registers "dsh-side-chat" in `dsh.profile.bundles` of the profile manifest
 *   3. nothing else (the bundle patch ships inside this package)
 *
 * Backs up package.json and pnpm-lock.yaml first and prints the rollback.
 * Idempotent: re-running after a successful install reports it and changes nothing.
 *
 * Usage:
 *   node scripts/install.mjs --profile <dir> [--spec <specifier>] [--dry-run]
 *   node scripts/install.mjs --profile <dir> --uninstall
 *
 * --spec selects what the profile depends on, and defaults to a `file:` path to
 * THIS checkout, which is the most reproducible choice on one machine:
 *   file:  (default)  this repository directory
 *   gh:               the GitHub repository, resolved by pnpm
 *   anything else     passed through verbatim (a tarball or a version range)
 *
 * The desktop installation directory is only ever READ (to find the bundled
 * pnpm); nothing outside the profile is written.
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const PACKAGE_NAME = 'dsh-side-chat';

// ── arguments ───────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const valueOf = (name) => {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
};
const uninstall = argv.includes('--uninstall');
const dryRun = argv.includes('--dry-run');

const fail = (message) => { console.error(`FAIL: ${message}`); process.exit(1); };
const step = (message) => { console.log(`\n== ${message}`); };

/** Default profile directory: the Desktop profile under DSH_HOME. */
function defaultProfileDir() {
  const home = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh');
  return join(home, 'profiles', 'desktop');
}

const profileDir = resolve(valueOf('--profile') ?? defaultProfileDir());
const nodeBin = process.execPath;

/**
 * Locate the pnpm the desktop carries, by scanning a DSH installation directory.
 * @param installDir - candidate installation root.
 * @returns the pnpm entry script, or undefined.
 */
function findPnpm(installDir) {
  const candidates = [
    join(installDir, 'resources', 'runtime', 'pnpm', 'bin', 'pnpm.cjs'),
    join(installDir, 'resources', 'runtime', 'primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.cjs'),
  ];
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  return undefined;
}

/**
 * Find a DSH installation carrying pnpm: an explicit flag wins, then well-known
 * locations, then the siblings of the profile's own runtime.
 * @returns the pnpm entry script.
 */
function resolvePnpm() {
  const explicit = valueOf('--dsh-dir');
  if (explicit !== undefined) {
    const found = findPnpm(resolve(explicit));
    if (found === undefined) fail(`no bundled pnpm under --dsh-dir ${resolve(explicit)}`);
    return found;
  }
  const guesses = [
    process.env.DSH_DESKTOP_DIR,
    join(process.env.LOCALAPPDATA ?? '', 'Programs', 'DeepSeek Harness'),
    join(process.env.ProgramFiles ?? '', 'DeepSeek Harness'),
    'G:\\Program\\Dsh',
  ].filter((entry) => typeof entry === 'string' && entry !== '');
  for (const guess of guesses) {
    const found = findPnpm(guess);
    if (found !== undefined) return found;
  }
  fail('could not find the desktop\'s bundled pnpm; pass --dsh-dir <installation root>');
}

// ── the dependency specifier ────────────────────────────────────────────────
const spec = valueOf('--spec') ?? `file:${REPO.replaceAll('\\', '/')}`;

// ── preflight ───────────────────────────────────────────────────────────────
step('preflight');
const manifestPath = join(profileDir, 'package.json');
const lockPath = join(profileDir, 'pnpm-lock.yaml');
if (!existsSync(manifestPath)) fail(`no profile package.json at ${profileDir}`);
if (!existsSync(join(profileDir, 'pnpm-workspace.yaml'))) fail('no pnpm-workspace.yaml — this is not a pnpm profile');
const pnpm = resolvePnpm();
if (!uninstall && /^(?:file:|gh:|github:|https?:)/u.test(spec) && spec.startsWith('file:')) {
  const target = spec.slice('file:'.length);
  if (!existsSync(target)) fail(`--spec points at a path that does not exist: ${target}`);
}
console.log(`profile : ${profileDir}`);
console.log(`package : ${PACKAGE_NAME}`);
console.log(`source  : ${uninstall ? '(removing)' : spec}`);
console.log(`pnpm    : ${pnpm}`);
if (dryRun) console.log('mode    : DRY RUN — nothing will be written');

// ── back up ─────────────────────────────────────────────────────────────────
step('backup');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupManifest = `${manifestPath}.bak-${stamp}`;
const backupLock = `${lockPath}.bak-${stamp}`;
if (dryRun) console.log(`would save ${backupManifest}`);
else {
  copyFileSync(manifestPath, backupManifest);
  console.log(`saved ${backupManifest}`);
  if (existsSync(lockPath)) {
    copyFileSync(lockPath, backupLock);
    console.log(`saved ${backupLock}`);
  }
}

// ── run pnpm ────────────────────────────────────────────────────────────────
step(uninstall ? `pnpm remove ${PACKAGE_NAME}` : `pnpm add ${PACKAGE_NAME}`);
const pnpmArgs = uninstall
  ? [pnpm, 'remove', PACKAGE_NAME]
  : [pnpm, 'add', spec];
if (!uninstall) {
  // A `file:` dependency is COPIED, not linked, and pnpm keys it by the recorded
  // specifier — so editing the source alone leaves the profile running the old
  // build. Drop the entry whenever a `file:` spec is involved, making a re-run a
  // genuine upgrade; a changed specifier also has to go, or the profile would
  // depend on two builds at once.
  const before = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const recorded = before.dependencies?.[PACKAGE_NAME];
  const sameFileSpec = typeof recorded === 'string' && recorded === spec && spec.startsWith('file:');
  if (typeof recorded === 'string' && (recorded !== spec || sameFileSpec)) {
    console.log(sameFileSpec
      ? `refreshing the installed copy (a file: dependency is copied, not linked)`
      : `removing the previously installed spec first: ${recorded}`);
    if (dryRun) console.log(`$ node ${pnpm} remove ${PACKAGE_NAME}`);
    else {
      try {
        execFileSync(nodeBin, [pnpm, 'remove', PACKAGE_NAME], { cwd: profileDir, stdio: 'inherit' });
      } catch (error) {
        fail(`could not remove the previous ${PACKAGE_NAME}: ${String(error.status)}; backups are at ${backupManifest}`);
      }
    }
  }
}
console.log(`$ node ${pnpmArgs.join(' ')}`);
if (dryRun) {
  console.log('(dry run: skipped)');
} else {
  // stdio is inherited rather than piped: a piped grandchild is blocked in
  // confined environments, and the user should see pnpm's own output verbatim.
  try {
    execFileSync(nodeBin, pnpmArgs, { cwd: profileDir, stdio: 'inherit' });
  } catch (error) {
    fail(`pnpm exited with ${String(error.status)}; package.json/lockfile backups are at ${backupManifest}`);
  }
}

// ── register / unregister the bundle row ────────────────────────────────────
step(uninstall ? 'remove from dsh.profile.bundles' : 'register in dsh.profile.bundles');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
manifest.dsh ??= {};
manifest.dsh.profile ??= {};
const bundles = Array.isArray(manifest.dsh.profile.bundles) ? manifest.dsh.profile.bundles : [];
const wasRegistered = bundles.includes(PACKAGE_NAME);
manifest.dsh.profile.bundles = uninstall
  ? bundles.filter((name) => name !== PACKAGE_NAME)
  : (wasRegistered ? bundles : [...bundles, PACKAGE_NAME]);
if (dryRun) {
  console.log(`would write bundles: ${JSON.stringify(manifest.dsh.profile.bundles)}`);
} else {
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(uninstall
    ? (wasRegistered ? `removed ${PACKAGE_NAME}` : `${PACKAGE_NAME} was not registered`)
    : (wasRegistered ? 'already registered (no change)' : `added ${PACKAGE_NAME}`));
}

// ── verify ──────────────────────────────────────────────────────────────────
step('verify');
const installed = join(profileDir, 'node_modules', PACKAGE_NAME);
console.log(`  ${existsSync(installed) ? 'ok  ' : 'MISS'} installed package dir exists`);
const finalManifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
console.log('  bundles now:', JSON.stringify(finalManifest.dsh.profile.bundles));
console.log('  dependencies:', JSON.stringify(Object.keys(finalManifest.dependencies ?? {})));

// ── rollback instructions ───────────────────────────────────────────────────
step('rollback');
console.log('To undo this exact change set:');
if (dryRun) console.log('  (dry run: nothing was changed)');
else {
  console.log(`  copy "${backupManifest}" "${manifestPath}"`);
  console.log(`  copy "${backupLock}" "${lockPath}"`);
  console.log(`  node ${pnpm} install   # in ${profileDir}`);
  console.log('  (or run this script with --uninstall)');
}
console.log('\nRestart the desktop to load the change: the desktop profile applies patches only at startup.');
console.log('DONE');
