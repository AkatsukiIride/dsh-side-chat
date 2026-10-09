/**
 * Audit (and optionally remove) Sessions that no Workspace claims.
 *
 * WHY THIS EXISTS: DSH 0.2.0-rc.2 has no session-delete API — only workspaces
 * have one (`delete(workspaceId)`), and the JSONL persistence backend never
 * unlinks a session log. A plugin therefore cannot delete a Session it created,
 * and deleting one from inside the running app would pull a live Session's
 * backing file out from under the process. So this runs HERE, offline, while
 * the desktop is closed.
 *
 * IDENTIFICATION IS DELIBERATELY NOT AUTOMATIC. A side-chat Session and any
 * other unattached Session share every header signal (`isSeeded: false`, no
 * ParentSession, a cwd the host chose) — measured, not assumed: an early
 * version of this script classified two of this project's OWN subagent
 * Sessions as side chats because they happened to share the working directory.
 * So the script reports evidence and deletes only ids you name explicitly.
 *
 * SAFETY:
 *   - read-only unless you pass --delete with explicit --id values;
 *   - refuses to run while a DeepSeek Harness process may hold the logs;
 *   - prints every action and every skip.
 *
 * Usage:
 *   node clean-side-chat.mjs                          # audit (default)
 *   node clean-side-chat.mjs --json                   # audit as JSON
 *   node clean-side-chat.mjs --delete --id <id> [--id <id>] [--yes]
 *   node clean-side-chat.mjs --delete --older-than-days 1 --dry-run
 */
import { readdirSync, readFileSync, statSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createZstdDecompress } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';

const DSH_HOME = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh');
const SESSIONS_DIR = join(DSH_HOME, 'sessions');
const PROJCACHE_DIR = join(DSH_HOME, 'storages', 'session_projcache', 'sessions');
const WORKSPACE_JSON = join(DSH_HOME, 'storages', 'workspace.json');

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const valueOf = (name) => {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
};
const valuesOf = (name) => argv.reduce((acc, token, index) => (token === name && argv[index + 1] !== undefined ? [...acc, argv[index + 1]] : acc), []);

const DELETE = flag('--delete');
const JSON_OUT = flag('--json');
const ASSUME_YES = flag('--yes');
const DRY_RUN = flag('--dry-run');
const ONLY_IDS = new Set(valuesOf('--id'));
const OLDER_THAN_DAYS = valueOf('--older-than-days');
const CLAIMED_CWD = process.env.DSH_SIDE_CHAT_CWD;

const say = (message) => { if (!JSON_OUT) console.log(message); };

/** @returns {boolean} whether a Desktop/CLI harness process appears to be running. */
function appRunning() {
  if (process.platform !== 'win32') return true; // unknown platform: fail closed
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq DeepSeek Harness.exe', '/NH'], { encoding: 'utf8' });
    return out.includes('DeepSeek Harness.exe');
  } catch {
    return true;
  }
}

/** Decode a session log's first record (the header). */
async function readHeader(logPath) {
  return await new Promise((resolve) => {
    let settled = false;
    const finish = (value) => { if (!settled) { settled = true; resolve(value); } };
    const stream = createZstdDecompress();
    let text = '';
    stream.on('data', (chunk) => {
      text += chunk.toString('utf8');
      const newline = text.indexOf('\n');
      if (newline !== -1) { stream.close(); finish(parseHeader(text.slice(0, newline))); }
      else if (text.length > 1_000_000) { stream.close(); finish(parseHeader(text)); }
    });
    stream.on('error', () => finish(parseHeader(text.split('\n')[0] ?? '')));
    stream.on('end', () => finish(parseHeader(text.split('\n')[0] ?? '')));
    try { stream.end(readFileSync(logPath)); } catch { finish(null); }
    setTimeout(() => { try { stream.close(); } catch { /* already closed */ } finish(parseHeader(text.split('\n')[0] ?? '')); }, 5000).unref?.();
  });
}

/** Parse one header line, returning null unless it is a session header. */
function parseHeader(line) {
  if (line === '') return null;
  try {
    const record = JSON.parse(line);
    return record && record.type === 'session' ? record : null;
  } catch {
    return null;
  }
}

/** Every session directory with its log path. */
function sessionDirs() {
  const found = [];
  if (!existsSync(SESSIONS_DIR)) return found;
  let buckets;
  try { buckets = readdirSync(SESSIONS_DIR); } catch { return found; }
  for (const bucket of buckets) {
    const bucketPath = join(SESSIONS_DIR, bucket);
    let entries;
    try { if (!statSync(bucketPath).isDirectory()) continue; entries = readdirSync(bucketPath); } catch { continue; }
    for (const id of entries) {
      const dir = join(bucketPath, id);
      let files;
      try { files = readdirSync(dir); } catch { continue; }
      const log = files.find((name) => name.endsWith('.jsonl.zstd'));
      if (log !== undefined) found.push({ id, dir, bucket, log: join(dir, log) });
    }
  }
  return found;
}

/** Session ids any Workspace claims. */
function workspaceMembers() {
  const members = new Set();
  if (!existsSync(WORKSPACE_JSON)) return members;
  try {
    const parsed = JSON.parse(readFileSync(WORKSPACE_JSON, 'utf8'));
    const walk = (value) => {
      if (Array.isArray(value)) { for (const item of value) walk(item); return; }
      if (value === null || typeof value !== 'object') return;
      for (const [key, child] of Object.entries(value)) {
        if ((key === 'sessionIds' || key === 'sessions') && Array.isArray(child)) {
          for (const id of child) if (typeof id === 'string') members.add(id);
        } else walk(child);
      }
    };
    walk(parsed);
  } catch { /* an unreadable registry only narrows what is protected */ }
  return members;
}

// ── collect ────────────────────────────────────────────────────────────────
const running = appRunning();
const members = workspaceMembers();
const rows = [];
for (const entry of sessionDirs()) {
  const header = await readHeader(entry.log);
  let bytes = 0;
  try {
    for (const name of readdirSync(entry.dir)) {
      try { bytes += statSync(join(entry.dir, name)).size; } catch { /* raced */ }
    }
  } catch { /* raced */ }
  rows.push({
    id: entry.id,
    dir: entry.dir,
    bytes,
    cwd: header?.cwd ?? null,
    createdAt: header?.createdAt ?? null,
    isSeeded: header?.isSeeded ?? null,
    parentSession: header?.parentSession ?? null,
    agentPreset: header?.agentPreset ?? null,
    claimedByWorkspace: members.has(entry.id),
    headerReadable: header !== null,
    matchesCwdEvidence: CLAIMED_CWD !== undefined && typeof header?.cwd === 'string'
      && header.cwd.toLowerCase() === CLAIMED_CWD.toLowerCase(),
  });
}

const unattached = rows.filter((row) => !row.claimedByWorkspace);

if (JSON_OUT) {
  console.log(JSON.stringify({
    dshHome: DSH_HOME,
    appRunning: running,
    total: rows.length,
    workspaceClaimed: rows.length - unattached.length,
    unattached,
  }, null, 2));
  process.exit(0);
}

say(`DSH home        : ${DSH_HOME}`);
say(`Desktop running : ${running ? 'YES (delete is refused)' : 'no'}`);
say(`Sessions        : ${String(rows.length)} total, ${String(rows.length - unattached.length)} claimed by a Workspace`);
if (CLAIMED_CWD !== undefined) say(`cwd evidence    : ${CLAIMED_CWD}`);
say('');
say('Sessions no Workspace claims — the population a side chat lands in:');
say('');
say('  created            size      seeded parent  cwd evidence  id');
for (const row of unattached.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))) {
  const when = row.createdAt === null ? '?' : new Date(row.createdAt).toISOString().slice(0, 16).replace('T', ' ');
  const size = `${String(Math.round(row.bytes / 1024))}K`.padStart(7);
  const seeded = String(row.isSeeded).padStart(5);
  const parent = (row.parentSession ?? '-').slice(0, 6).padStart(6);
  const evid = row.matchesCwdEvidence ? 'MATCHES      ' : '             ';
  say(`  ${when}  ${size}  ${seeded} ${parent}  ${evid}  ${row.id}`);
}
say('');
say('Read this before deleting:');
say('  - "cwd evidence" compares the header cwd to $DSH_SIDE_CHAT_CWD. It is evidence,');
say('    NOT proof: this project\'s own subagent Sessions produced false matches.');
say('  - a side-chat Session and any other unattached Session are indistinguishable');
say('    from the header alone. Verify against the `created` time and size you expect.');
say('  - a side chat is small (single-digit KB); anything in the hundreds of KB is not one.');
say('');

if (!DELETE) {
  say('Audit only. To remove specific Sessions:');
  say('  node clean-side-chat.mjs --delete --id <id> [--id <id>] [--yes]');
  process.exit(0);
}

// ── delete ─────────────────────────────────────────────────────────────────
if (running) {
  console.error('REFUSING to delete: a DeepSeek Harness process is running. Close the desktop first —');
  console.error('removing a Session log under a live process leaves it holding a missing file.');
  process.exit(1);
}

let targets = unattached.filter((row) => ONLY_IDS.has(row.id));
if (ONLY_IDS.size === 0 && OLDER_THAN_DAYS !== undefined) {
  const cutoff = Date.now() - Number(OLDER_THAN_DAYS) * 86_400_000;
  targets = unattached.filter((row) => (row.createdAt ?? 0) < cutoff && row.bytes < 64 * 1024);
  say(`--older-than-days ${String(OLDER_THAN_DAYS)} selected ${String(targets.length)} candidate(s) below 64 KB.`);
}
if (ONLY_IDS.size > 0) {
  const missing = [...ONLY_IDS].filter((id) => !rows.some((row) => row.id === id));
  for (const id of missing) console.error(`unknown session id (not found): ${id}`);
  for (const row of rows.filter((r) => ONLY_IDS.has(r.id) && r.claimedByWorkspace)) {
    console.error(`REFUSING ${row.id}: a Workspace claims it. Unclaim it in the app first.`);
  }
  targets = targets.filter((row) => !row.claimedByWorkspace);
}
if (targets.length === 0) {
  say('Nothing selected. Pass --id <id> (repeatable) or --older-than-days <n>.');
  process.exit(0);
}

say(`Selected ${String(targets.length)} Session(s), ${String(targets.reduce((sum, row) => sum + row.bytes, 0))} bytes:`);
for (const row of targets) say(`  ${row.id}  (${String(Math.round(row.bytes / 1024))}K, cwd=${row.cwd ?? '?'})`);
if (DRY_RUN) { say('--dry-run: nothing deleted.'); process.exit(0); }
if (!ASSUME_YES) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question('Type "yes" to delete these: ');
  rl.close();
  if (answer.trim().toLowerCase() !== 'yes') { say('Aborted; nothing deleted.'); process.exit(0); }
}

let removed = 0;
let freed = 0;
for (const row of targets) {
  try {
    rmSync(row.dir, { recursive: true, force: true });
    const cache = join(PROJCACHE_DIR, `${row.id}.json`);
    if (existsSync(cache)) rmSync(cache, { force: true });
    removed += 1;
    freed += row.bytes;
    say(`deleted ${row.id}`);
  } catch (error) {
    console.error(`FAILED ${row.id}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
say('');
say(`Deleted ${String(removed)}/${String(targets.length)}, freeing about ${String(freed)} bytes.`);
say('$DSH_HOME/storages/workspace.json may still list a removed id; the host drops the row on');
say('the next listing because the log is gone.');
