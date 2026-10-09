# dsh-side-chat

Select text in the transcript, click **问一下 / Ask about this**, and a panel opens
on the right with that passage quoted and ready to ask about — so a quick
question does not derail the conversation you are reading.

This is the desktop port of the in-repo `@deepseek-ai/dsh-client-ui-side-chat`
package (DSH source checkout `0.1.3-alpha.2`), repackaged as a standalone plugin
installed into a DSH profile so it survives desktop updates.

## How it is put together

Both halves matter, for different reasons.

### Browser half (`lib/client.js`)

Registered into `shell.overlay`, exactly like the in-repo package. It owns the
selection gesture, the panel, and the side conversation:

**The side conversation runs in a DETACHED BLANK SESSION**, created through
`sessions.create({})`:

- **no `workspaceId`** — the host only calls `workspace.attachSession()` when a
  Workspace is named explicitly, so the side Session belongs to no Workspace and
  never joins your project's session group;
- **no `cwd`** — it lands in the host process's own directory, not your project;
- **no seed** — it inherits nothing, so a question never re-sends the parent
  transcript to the model.

Because a created Session is blank until its first turn starts, it also stays
out of the session list until you actually ask something.

### Host half (`lib/index.js`)

Serves exactly one route, `POST /side-chat/summarize`. It exists because a
**browser plugin cannot call the model**: `ctx.llm` is a host-plane service. So
the briefing below has to be written host-side.

It follows the shipped `dsh-session-title-llm` auxiliary-call shape — read the
default route from `ctx.agentDefaultModel`, stream with an explicit `maxTokens`,
assemble with `BlockAssembler`, and treat any non-`stop` finish as a failure.

**It creates no Session**, which is the whole point: the briefing must not
reintroduce the pollution the browser half exists to avoid.

## The context the question carries

Nothing is inherited, so the first question carries a **model-written briefing**
of the conversation you are looking at:

1. the browser half reads the visible transcript (`[data-chat-turn]`) at the
   moment you click, bounded to 24 000 code points;
2. the host half truncates to its own ceiling (24 000, hard cap 48 000, keeping
   the **tail** because that is where the conversation's current state lives),
   and asks for a briefing in at most **400 output tokens**;
3. the briefing, the quoted passage, and your question are sent as one message.

The panel shows which payload it will send — **"a model briefing"**, or
**"a transcript excerpt (no briefing available)"** with the reason — before you
send it. The context rides the **first question only**; re-sending it on every
follow-up would multiply the cost.

### Fallback

Every summarization failure path lands on a local transcript excerpt instead:

| failure | behaviour |
|---|---|
| route not mounted (host half absent) | HTTP error → excerpt |
| provider/credential failure | `{ summary: '', error }` → excerpt |
| `max-tokens` or tool-call finish | reported as a failure → excerpt |
| mid-stream throw | contained and logged → excerpt |
| timeout (70 s) | aborted → excerpt |
| unparseable reply | caught → excerpt |

The panel always states which one it is using and why. The excerpt is bounded to
4 000 code points and at most 2 preceding turns, and a turn too large to fit is
left out **whole**, never truncated.

## What it does NOT do (read this before relying on it)

The in-repo original seeds a **host-side ephemeral fork**: an in-process session
that never takes a persistent write handle, never appears in the session list,
and is discarded on close.

**DSH 0.2.0-rc.2 has no such host API.** Verified by extracting
`resources/app.asar` and searching every shipped host package:

- `closeEphemeral` — 0 occurrences.
- `ephemeral` as a session concept — 0 occurrences.
- `session.fork` exists, but `SessionForkRequest` is exactly `{ sessionId, atSeq? }`,
  and the host implementation creates an **ordinary persistent session**, then
  attaches it to the source's Workspace.

Consequences:

1. **The side Session is still persisted** — a header and a log under
   `$DSH_HOME/sessions`. It is small (single-digit KB, because nothing is
   inherited), but **closing the panel does not delete it**, and there is no
   session-delete API to call: only workspaces have `delete(workspaceId)`.
2. **It appears in the session list once you ask the first question.** Before
   that it is blank, and blankness hides it. Archiving would hide it too, but
   the shipped `archived-session-gate` rejects model steps for an archived
   Session, so an archived side chat could not answer.
3. **It costs one extra model call per side conversation** — input bounded by
   the truncation above, output by 400 tokens — on top of the side
   conversation's own turns.

Deleting the log from a plugin would leave a live Session whose backing file is
gone, which is why this plugin does not do it. See `scripts/clean-side-chat.mjs`
and `MIGRATION-REPORT.zh.md` in this repository; both gaps need host-side work.

## Repository layout

```
dsh-side-chat/
  package.json            the plugin manifest (dsh.client + dsh.bundle.patch)
  cordis.patch.yml        mounts the host row into a profile's tree
  lib/index.js            HOST half: POST /side-chat/summarize
  lib/client.js           BROWSER half: the launcher and panel
  README.md               this file
  MIGRATION-REPORT.zh.md  desktop feasibility study + the must-upstream list
  LICENSE
  test/                   offline harnesses for both halves (no model calls)
  scripts/                tooling: install, validate, clean up, asar extract
  dist/                   `npm run pack` output (git-ignored)
```

`lib/` stays at the repository root on purpose: **there is no build step** (the
browser bundle is hand-written in the shell's module convention), so a plain
`git clone` yields a directly installable plugin with no `prepare` hook. That is
what makes installing straight from the git URL work.

## Install

The official route is the sidebar **Plugins → 添加插件** page, which accepts a
local directory path, runs `pnpm add` in the profile, and registers the bundle.

By hand, from a clone:

```powershell
# 1. clone OUTSIDE the DSH installation directory
git clone https://github.com/AkatsukiIride/dsh-side-chat.git G:\Program\SoftProgram\dsh-side-chat

# 2. install into the desktop profile
#    (the installer only ever READS the desktop, to find its bundled pnpm)
node G:\Program\SoftProgram\dsh-side-chat\scripts\install.mjs `
  --profile "$env:USERPROFILE\.dsh\profiles\desktop"

# 3. restart the desktop: the desktop profile applies patches only at startup
```

The installer defaults the profile dependency to a `file:` path to the clone,
which is the most reproducible choice on one machine. `--spec` makes the profile
self-contained instead:

```powershell
node scripts/install.mjs --spec github:AkatsukiIride/dsh-side-chat
```

It backs up `package.json` and `pnpm-lock.yaml`, prints the rollback, is
idempotent, and writes nothing outside the profile. `--dry-run` shows the plan
first.

> **Never point the profile dependency at a tarball inside the DSH installation
> directory.** A desktop update replaces that directory wholesale, leaving the
> profile depending on a file that no longer exists — and every later
> `pnpm install` fails.

## Rollback

Everything lives in the profile:

1. `node scripts/install.mjs --profile <dir> --uninstall`, or **Plugins → 卸载**,
2. restart the desktop.

Side Sessions the plugin created in the past are **not** removed by
uninstalling — they are ordinary Sessions.

## Updating

A `file:`/git dependency is a pinned reference, so updating is explicit:

```powershell
git -C G:\Program\SoftProgram\dsh-side-chat pull
node G:\Program\SoftProgram\dsh-side-chat\scripts\install.mjs --profile <dir>
```

then restart the desktop.

## Cleaning up side Sessions

`scripts/clean-side-chat.mjs` audits and, on request, removes Sessions no
Workspace claims. It runs **offline**: it refuses to start while a DeepSeek
Harness process is running, because removing a log under a live process would
leave that process holding a missing file.

```powershell
# audit only (default); set the host working directory to tighten the evidence
$env:DSH_SIDE_CHAT_CWD = '<the desktop process working directory>'
node scripts/clean-side-chat.mjs

# remove specific Sessions by id
node scripts/clean-side-chat.mjs --delete --id <session-id> [--id <session-id>] --yes
```

**Identification is deliberately not automatic, and you should not expect it to
be.** A side-chat Session and any other unattached Session are identical in the
header: `isSeeded: false`, no `parentSession`, and a host-chosen `cwd`. An
earlier version of this script classified by `cwd` and immediately mis-flagged
two of this project's own **subagent** Sessions as side chats. So it prints the
evidence (creation time, size, cwd match) and deletes only ids you name.
Heuristics when reading the table:

- a side chat is **small** — single-digit KB, because it inherits nothing;
- anything in the hundreds of KB is a real conversation, not a side chat;
- the desktop must be closed.

## Verification

Both halves have an offline harness that drives the real code — no model calls.

```powershell
npm test              # both halves: 107 + 33 checks
npm run test:client   #  107 checks: the browser bundle
npm run test:host     #   33 checks: the route handler
npm run scan          # the client-modules discovery rules
```

`test/client-harness.mjs` stands in for the shell (a `window.__ModuleLoader__`, a
working minimal React, a fake transcript DOM, fake `sessions` / `slots` services,
and a scripted `/side-chat/summarize` endpoint). It asserts the registration
contract, the fold rules, the whole create/retain/prompt/cancel/close lifecycle,
the detached-session guarantees (never forks, no workspace, no cwd), the briefing
path, all seven fallback modes, the excerpt bounds, and the rendered panel.

`test/host-harness.mjs` loads the host half as ESM with only its one import
redirected to a stub, and drives the real route handler: request validation,
input truncation (including the tail-keeping rule and the hard ceiling), the
output bound, the default-route lookup, and every failure mode.

Two further checks need the shipped app, so they take arguments:

```powershell
# The dsh tree lives INSIDE resources/app.asar, and Electron resolves within the
# archive, so it must be extracted to a real directory first:
node scripts/extract-asar.mjs `
  "$env:ProgramFiles\DeepSeek Harness\resources\app.asar" .tmp-asar dsh
node scripts/compose-check.mjs `
  "$env:USERPROFILE\.dsh\profiles\desktop" .tmp-asar\dsh
```
