/**
 * Offline verification harness for the dsh-side-chat HOST half.
 *
 * The host half has exactly one job — turn a conversation into a bounded,
 * model-written briefing — and exactly one thing it must never do: create a
 * Session. This harness drives the real route handler against a stubbed
 * webserver and a stubbed LLM runtime, so the request validation, the input
 * bound, the output bound, and every failure mode are all exercised offline.
 * No model is called.
 *
 * Run: node test/host-harness.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ── stub the LLM package the host half imports ──────────────────────────────
// A minimal BlockAssembler faithful to the shipped one's chunk vocabulary, so
// the host half's assembly and finish-reason handling are really exercised.
class FakeBlockAssembler {
  constructor() { this.partials = new Map(); this.order = []; this._finish = { kind: 'stop' }; }
  push(chunk) {
    if (chunk.type === 'block-start') {
      if (!this.partials.has(chunk.index)) {
        this.order.push(chunk.index);
        this.partials.set(chunk.index, { blockType: chunk.blockType, text: '' });
      }
      return;
    }
    if (chunk.type === 'text-delta') {
      if (!this.partials.has(chunk.index)) {
        this.order.push(chunk.index);
        this.partials.set(chunk.index, { blockType: 'text', text: '' });
      }
      this.partials.get(chunk.index).text += chunk.text;
      return;
    }
    if (chunk.type === 'finish') { this._finish = chunk.reason; return; }
    if (chunk.type === 'tool-call-delta') {
      if (!this.partials.has(chunk.index)) {
        this.order.push(chunk.index);
        this.partials.set(chunk.index, { blockType: 'tool-call', text: '' });
      }
    }
  }
  get finish() { return this._finish; }
  blocks() {
    return this.order.map((index) => {
      const partial = this.partials.get(index);
      return partial.blockType === 'tool-call'
        ? { type: 'tool-call', id: 'c', name: 'x', arguments: '{}' }
        : { type: 'text', text: partial.text };
    });
  }
}
const fakeLlmPackage = {
  BlockAssembler: FakeBlockAssembler,
  createUserMessage: ({ content, source }) => ({ role: 'user', content, source }),
};

// ── stub webserver + context ────────────────────────────────────────────────
let registeredRoute;
const registered = [];
const warned = [];
const llmCalls = [];

/** Scripted LLM behaviour for the next call. */
let llmMode = 'text';
let llmText = 'BRIEFING: the project is about X and Y.';
let llmFinish = { kind: 'stop' };
let llmThrow;

const ctx = {
  webServer: {
    register(route) { registeredRoute = route; registered.push(route.path); return () => {}; },
  },
  agentDefaultModel: {
    currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' }),
  },
  llm: {
    stream(options) {
      llmCalls.push(options);
      if (llmThrow !== undefined) throw llmThrow;
      async function* generate() {
        const streamText = llmMode === 'tool-call' ? '' : llmText;
        if (streamText !== '') {
          yield { type: 'block-start', index: 0, blockType: 'text' };
          yield { type: 'text-delta', index: 0, text: streamText };
        }
        if (llmMode === 'tool-call') yield { type: 'tool-call-delta', index: 1, id: 'c', name: 'x', argumentsDelta: '{}' };
        if (llmMode === 'throw-mid-stream') throw new Error('adapter exploded mid-stream');
        yield { type: 'finish', reason: llmFinish };
      }
      return generate();
    },
  },
  effect(fn) { fn(); return () => {}; },
  logger: { warn: (message) => warned.push(message) },
};

// ── load the host half ──────────────────────────────────────────────────────
// The real file is ESM with a static import, so it is evaluated as ESM (not via
// `new Function`, which cannot parse import syntax). Only the import specifier
// is redirected to the stub above; every other line is the shipped code.
// Paths resolve from this file, so the harness runs from any working directory.
const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')
const source = readFileSync(join(REPO, 'lib', 'index.js'), 'utf8');
const IMPORT_LINE = "import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'";
if (!source.includes(IMPORT_LINE)) {
  console.error('the host half no longer imports what this harness redirects; update the redirect');
  process.exit(2);
}
globalThis.__DSH_LLM_STUB__ = fakeLlmPackage;
const redirected = source.replace(
  IMPORT_LINE,
  'const { BlockAssembler, createUserMessage } = globalThis.__DSH_LLM_STUB__;',
);
const host = await import(`data:text/javascript;base64,${Buffer.from(redirected, 'utf8').toString('base64')}`);

// ── request/response stubs ──────────────────────────────────────────────────
/** Build a fake IncomingMessage carrying one body, async-iterable like a real stream. */
function makeRequest(method, body) {
  const chunks = body === undefined ? [] : [Buffer.from(body)];
  return {
    method,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  };
}

/** Build a fake ServerResponse that records what was written. */
function makeResponse() {
  const captured = { status: 0, headers: {}, body: '' };
  return {
    captured,
    writeHead(status, headers) { captured.status = status; captured.headers = headers ?? {}; },
    end(chunk) { if (chunk !== undefined) captured.body += chunk.toString(); },
  };
}

/** Invoke the registered route once. */
async function call(method, body) {
  const res = makeResponse();
  await registeredRoute.handler(makeRequest(method, body), res);
  let parsed;
  try { parsed = JSON.parse(res.captured.body); } catch { parsed = res.captured.body; }
  return { status: res.captured.status, payload: parsed };
}

// ── assertions ──────────────────────────────────────────────────────────────
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `  — ${detail}`}`);
};

check('host half exports apply and inject', typeof host.apply === 'function' && Array.isArray(host.inject));
check('inject roster is webserver + llm + default model', JSON.stringify(host.inject) === JSON.stringify(['webServer', 'llm', 'agentDefaultModel']), JSON.stringify(host.inject));

host.apply(ctx);
check('apply registers exactly one route', registered.length === 1, JSON.stringify(registered));
check('the route is the path the browser half calls', registeredRoute.path === '/side-chat/summarize', registeredRoute.path);
check('the route is exact (not a prefix)', registeredRoute.kind === 'exact', registeredRoute.kind);

// ── the happy path ──────────────────────────────────────────────────────────
let result = await call('POST', JSON.stringify({ text: 'user: hello\nassistant: hi' }));
check('a valid request answers 200', result.status === 200, String(result.status));
check('a valid request returns the briefing', result.payload.summary === 'BRIEFING: the project is about X and Y.', JSON.stringify(result.payload));
check('no LLM call happens at registration time', llmCalls.length === 1, String(llmCalls.length));
check('the call uses the configured default route', llmCalls[0].provider === 'deepseek-official' && llmCalls[0].model === 'deepseek-flash', JSON.stringify({ p: llmCalls[0].provider, m: llmCalls[0].model }));
check('the output is bounded by maxTokens', llmCalls[0].maxTokens === 2000, String(llmCalls[0].maxTokens));
check('the call carries a system instruction', typeof llmCalls[0].system === 'string' && llmCalls[0].system.length > 50);
check('the call is attributed to this feature', llmCalls[0].purpose === 'side-chat-summary', String(llmCalls[0].purpose));
check('the call carries the conversation as one user message', llmCalls[0].messages.length === 1 && llmCalls[0].messages[0].content[0].text.includes('hello'), JSON.stringify(llmCalls[0].messages[0].content[0].text));
check('the call is cancellable', llmCalls[0].signal !== undefined);
check('NO Session is ever created (the plugin has no session dependency)', !host.inject.includes('sessions') && !host.inject.includes('agents'), JSON.stringify(host.inject));

// ── input bounding ──────────────────────────────────────────────────────────
llmCalls.length = 0;
const huge = 'x'.repeat(60000);
await call('POST', JSON.stringify({ text: huge }));
const bounded = llmCalls[0].messages[0].content[0].text;
check('an oversized input is truncated to the default ceiling', bounded.length <= 24000, String(bounded.length));
check('truncation keeps the TAIL of the conversation', bounded.endsWith('x') && bounded.length > 20000, `${String(bounded.length)} chars`);

llmCalls.length = 0;
await call('POST', JSON.stringify({ text: huge, maxChars: 1000 }));
check('a caller-supplied ceiling is honoured', llmCalls[0].messages[0].content[0].text.length <= 1000, String(llmCalls[0].messages[0].content[0].text.length));

llmCalls.length = 0;
await call('POST', JSON.stringify({ text: huge, maxChars: 999999 }));
check('the hard ceiling beats a greedy caller', llmCalls[0].messages[0].content[0].text.length <= 48000, String(llmCalls[0].messages[0].content[0].text.length));

llmCalls.length = 0;
await call('POST', JSON.stringify({ text: huge, maxChars: -5 }));
check('a nonsense ceiling falls back to the default', llmCalls[0].messages[0].content[0].text.length <= 24000, String(llmCalls[0].messages[0].content[0].text.length));

// ── request validation ──────────────────────────────────────────────────────
check('GET is refused', (await call('GET')).status === 405);
check('missing text is refused', (await call('POST', JSON.stringify({}))).status === 400);
check('blank text is refused', (await call('POST', JSON.stringify({ text: '   ' }))).status === 400);
check('non-string text is refused', (await call('POST', JSON.stringify({ text: 42 }))).status === 400);
check('invalid JSON is refused', (await call('POST', '{not json')).status === 400);

// ── failure containment: the browser half must always get an answer ─────────
llmMode = 'text';
llmText = '';
result = await call('POST', JSON.stringify({ text: 'hello' }));
check('an empty model answer reports a reason, not a crash', result.status === 200 && result.payload.summary === '' && typeof result.payload.error === 'string', JSON.stringify(result.payload));

llmText = 'BRIEFING: ok.';
llmFinish = { kind: 'max-tokens' };
result = await call('POST', JSON.stringify({ text: 'hello' }));
check('a max-tokens finish is reported as a failure', result.status === 200 && result.payload.summary === '' && /max-tokens/.test(result.payload.error), JSON.stringify(result.payload));

llmFinish = { kind: 'error', failure: { message: 'provider refused', code: 'X' } };
result = await call('POST', JSON.stringify({ text: 'hello' }));
check('an adapter error is reported as a failure', result.payload.summary === '' && /provider refused/.test(result.payload.error), JSON.stringify(result.payload));

llmFinish = { kind: 'stop' };
llmMode = 'tool-call';
result = await call('POST', JSON.stringify({ text: 'hello' }));
check('a tool call in the summary is refused', result.payload.summary === '' && /tool call/.test(result.payload.error), JSON.stringify(result.payload));

llmMode = 'throw-mid-stream';
result = await call('POST', JSON.stringify({ text: 'hello' }));
check('a mid-stream throw is contained', result.status === 200 && result.payload.summary === '' && result.payload.error !== undefined, JSON.stringify(result.payload));
check('contained failures are logged', warned.length > 0, String(warned.length));

llmMode = 'text';
llmThrow = new Error('no adapter registered');
result = await call('POST', JSON.stringify({ text: 'hello' }));
check('a synchronous throw is contained', result.status === 200 && result.payload.summary === '' && /no adapter/.test(result.payload.error), JSON.stringify(result.payload));
llmThrow = undefined;

// A failure must never leave the response hanging.
result = await call('POST', JSON.stringify({ text: 'hello' }));
check('the endpoint recovers after failures', result.payload.summary === 'BRIEFING: ok.', JSON.stringify(result.payload));

const failures = results.filter((r) => !r.ok);
console.log(`\n${String(results.length - failures.length)}/${String(results.length)} checks passed`);
console.log('MODEL CALLS: 0 (the LLM runtime is stubbed)');
if (failures.length > 0) {
  console.log('\nFAILURES:');
  for (const f of failures) console.log(`  - ${f.name} ${f.detail}`);
  process.exitCode = 1;
}
