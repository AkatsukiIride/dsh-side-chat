/**
 * Offline verification harness for the dsh-side-chat browser bundle.
 *
 * It stands in for the shell: it provides the `window.__ModuleLoader__` the
 * bundle registers with, a minimal React, and fake `sessions` / `slots` /
 * `uiSession` services. Then it drives the plugin through the real gesture
 * sequence (select text -> launcher -> open -> prompt -> close) and asserts the
 * public contract, so a defect shows up here instead of in the desktop app.
 *
 * Run: node test/client-harness.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ── a minimal DOM good enough for the plugin's code paths ────────────────────
class FakeNode {
  constructor(type, attrs = {}, children = []) {
    this.type = type;
    this.attrs = attrs;
    this.children = children;
    this.nodeType = 1;
    this.parentElement = null;
    this.listeners = new Map();
  }
  closest(selector) {
    if (selector === '[data-chat-turn]') {
      let node = this;
      while (node) {
        if (node.attrs && node.attrs['data-chat-turn'] !== undefined) return node;
        node = node.parentElement;
      }
      return null;
    }
    return null;
  }
}

/**
 * Walk a rendered React tree and report every node once, rendering function
 * components and descending through host elements, arrays and Fragments alike.
 * @param node - a React element, array, or leaf.
 * @param visit - called with `{ tag, props }` for host elements and `{ text }` for leaves.
 */
function walk(node, visit) {
  if (node === null || node === undefined || node === false || node === true) return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  if (typeof node !== 'object' || node.type === undefined) {
    visit({ text: String(node) });
    return;
  }
  const { type, props } = node;
  if (typeof type === 'function') {
    walk(type(props ?? {}), visit);
    return;
  }
  if (typeof type === 'string') visit({ tag: type, props: props ?? {} });
  walk(props && props.children, visit);
}

/** Collect every rendered tag name in a tree, in document order. */
function tags(node) {
  const out = [];
  walk(node, (n) => { if (n.tag !== undefined) out.push(n.tag); });
  return out;
}

/** Find every rendered element with the given tag, in document order. */
function findAll(node, tag) {
  const out = [];
  walk(node, (n) => { if (n.tag === tag) out.push(n); });
  return out;
}

/** Text content of a rendered subtree, host-element text included. */
function textOf(node) {
  const parts = [];
  walk(node, (n) => {
    if (n.text !== undefined) parts.push(n.text);
    if (n.tag !== undefined && typeof n.props.children === 'string') parts.push(n.props.children);
  });
  return parts.join('');
}

// ── the stand-in shell ──────────────────────────────────────────────────────
const registered = new Map();
globalThis.window = {
  __ModuleLoader__: {
    load(spec) {
      registered.set(spec.id, spec.factory);
    },
  },
  // A live getter, not a captured value: installSelection() replaces the
  // selection between renders and the plugin must observe the current one.
  getSelection: () => globalThis.__selection ?? null,
};

// ── the host summarizer endpoint this bundle calls ──────────────────────────
// The bundle POSTs to /side-chat/summarize; the harness answers it, so the
// briefing path and every failure path are both exercisable offline.
const fetchCalls = [];
/** @type {'summary'|'empty'|'error'|'http-error'|'reject'} */
let fetchMode = 'summary';
globalThis.fetch = async (url, init) => {
  fetchCalls.push({ url, body: JSON.parse(init.body) });
  if (fetchMode === 'reject') throw new Error('ECONNREFUSED (simulated)');
  if (fetchMode === 'http-error') return { ok: false, status: 500, json: async () => ({}) };
  if (fetchMode === 'empty') return { ok: true, status: 200, json: async () => ({ summary: '', error: 'the model returned no text' }) };
  if (fetchMode === 'error') return { ok: true, status: 200, json: async () => ({ summary: '', error: 'summarization did not finish cleanly: max-tokens' }) };
  if (fetchMode === 'no-reason') return { ok: true, status: 200, json: async () => ({ summary: '' }) };
  if (fetchMode === 'bad-json') return { ok: true, status: 200, json: async () => { throw new Error('Unexpected token < in JSON') } };
  if (fetchMode === 'whitespace') return { ok: true, status: 200, json: async () => ({ summary: '   \n  ' }) };
  return { ok: true, status: 200, json: async () => ({ summary: 'BRIEFING: the conversation is about X.' }) };
};
globalThis.AbortController = globalThis.AbortController ?? class { constructor() { this.signal = {}; } abort() {} };
/** Fake event-listener registry so the plugin's own gestures can be driven. */
const listeners = new Map([
  ['mouseup', new Set()],
  ['keyup', new Set()],
  ['scroll', new Set()],
  ['keydown', new Set()],
]);

/**
 * Install a fake selection whose range sits inside a transcript turn.
 * @param {string} text - the selected text.
 * @param {boolean} insideTranscript - whether the range's ancestor is a turn.
 */
function installSelection(text, insideTranscript = true) {
  const turn = { nodeType: 1, closest: (selector) => (selector === '[data-chat-turn]' && insideTranscript ? { nodeType: 1 } : null) };
  globalThis.__selection = {
    isCollapsed: false,
    rangeCount: 1,
    toString: () => text,
    getRangeAt: () => ({
      commonAncestorContainer: turn,
      getBoundingClientRect: () => ({ left: 100, top: 200, width: 40 }),
    }),
  };
}

// ── a minimal stand-in for the transcript DOM the plugin reads ──────────────
/**
 * Build a fake transcript turn element.
 * @param {string} marker - the `data-chat-turn` value.
 * @param {string} text - the turn's rendered text (`innerText`).
 */
function makeTurn(marker, text) {
  return {
    nodeType: 1,
    innerText: text,
    textContent: text,
    getAttribute: (name) => (name === 'data-chat-turn' ? marker : null),
    closest: (selector) => (selector === '[data-chat-turn]' ? { nodeType: 1 } : null),
  };
}

globalThis.document = {
  documentElement: { lang: 'en' },
  addEventListener(type, handler) { listeners.get(type).add(handler); },
  removeEventListener(type, handler) { listeners.get(type).delete(handler); },
  dispatch(type) {
    for (const handler of listeners.get(type)) {
      try {
        handler();
      } catch (error) {
        console.log(`HANDLER THREW on ${type}:`, error && error.message ? error.message : String(error));
        throw error;
      }
    }
  },
  querySelector: () => null,
  querySelectorAll: (selector) => (selector === '[data-chat-turn]' ? globalThis.__turns ?? [] : []),
};

// A React whose hooks actually work: components are invoked directly, state is
// kept in a per-render-slot array so a setState persists into the next render,
// and effects are recorded. Without this the plugin's selection gesture would
// have no observable effect and the harness would test nothing.
let effectQueue = [];
let hookCursor = 0;
globalThis.__reactStates = [];
function makeReact() {
  hookCursor = 0;
  return {
    createElement: (type, props, ...children) =>
      ({ type, props: { ...(props ?? {}), children: children.length <= 1 ? children[0] : children } }),
    Fragment: Symbol('Fragment'),
    useState: (initial) => {
      const slot = hookCursor;
      hookCursor += 1;
      if (!(slot in globalThis.__reactStates)) {
        globalThis.__reactStates[slot] = typeof initial === 'function' ? initial() : initial;
      }
      return [
        globalThis.__reactStates[slot],
        (next) => {
          globalThis.__reactStates[slot] = typeof next === 'function' ? next(globalThis.__reactStates[slot]) : next;
        },
      ];
    },
    useEffect: (fn) => {
      const cleanup = fn();
      if (typeof cleanup === 'function') effectQueue.push(cleanup);
    },
    useRef: (initial) => {
      const slot = `ref${String(hookCursor)}`;
      hookCursor += 1;
      globalThis.__reactStates[slot] ??= { current: initial };
      return globalThis.__reactStates[slot];
    },
    useSyncExternalStore: (subscribe, getSnapshot) => {
      // Every SideChatLayer render begins with its two useStore calls, so this
      // is where a render starts. Reset the hook cursor here: the shell's
      // `require('react')` is memoized, so a cursor reset in the factory would
      // only ever run once and the slots would drift on every later render.
      hookCursor = 0;
      subscribe(() => {});
      return getSnapshot();
    },
  };
}

// ── fake services ───────────────────────────────────────────────────────────
const calls = { create: [], fork: [], retain: [], prompt: [], cancel: [], register: [], inject: [], release: 0 };

function createStore(initial) {
  let value = initial;
  const listeners = new Set();
  return {
    getSnapshot: () => value,
    subscribe: (l) => { listeners.add(l); return () => listeners.delete(l); },
    set: (next) => { value = next; listeners.forEach((l) => l()); },
  };
}

/** A fake SessionBinding over a scripted event window. */
function makeBinding(sessionId, events) {
  const eventStore = createStore({ entries: events, hasMore: false, revision: 1 });
  const sessionStore = createStore({ running: false, blank: false });
  return {
    sessionId,
    eventSource: eventStore,
    session: {
      getSnapshot: () => sessionStore.getSnapshot(),
      subscribe: (l) => sessionStore.subscribe(l),
      prompt: async (content, mode) => { calls.prompt.push({ sessionId, content, mode }); return { ok: true, value: { accepted: true } }; },
      cancel: async () => { calls.cancel.push({ sessionId }); },
    },
    push: (entry) => eventStore.set({ entries: [...eventStore.getSnapshot().entries, entry], hasMore: false, revision: 2 }),
    setRunning: (running) => sessionStore.set({ running, blank: false }),
  };
}

const bindings = new Map();
let createCounter = 0;

const sessions = {
  /** A detached Session starts EMPTY: no inherited prefix at all. */
  create: async (opts) => {
    calls.create.push(opts ?? {});
    const sessionId = `session-side-${++createCounter}`;
    bindings.set(sessionId, makeBinding(sessionId, []));
    return sessionId;
  },
  /** Present so the harness can prove the plugin does NOT fork any more. */
  fork: async (opts) => {
    calls.fork.push(opts);
    throw new Error('the plugin must not fork: a fork inherits the parent conversation and joins its Workspace');
  },
  retain: (id, options) => {
    calls.retain.push({ id, options });
    const binding = bindings.get(id);
    return {
      sessionId: id,
      binding,
      ready: Promise.resolve(binding),
      release: () => { calls.release += 1; },
    };
  },
  list: createStore({ ids: [], byId: {}, phase: 'ready', projectionsBySession: {} }),
};

const slots = {
  inject: (name, factory) => { calls.inject.push(name); return factory(); },
  register: (definition, component) => { calls.register.push({ definition, component }); return () => {}; },
};

const uiSession = { adapter: { current: createStore({ key: 'session-main' }) } };

const ctx = {
  get: (name) => ({ sessions, slots, uiSession })[name],
  effect: (fn) => { const d = fn(); return d; },
};

// ── load the bundle exactly the way the shell does ──────────────────────────
const source = readFileSync(join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'lib', 'client.js'), 'utf8');
globalThis.require = (specifier) => {
  if (specifier === 'react') return makeReact();
  throw new Error(`unexpected require("${specifier}") — the bundle must stay self-contained`);
};
new Function('window', 'require', 'document', 'Node', source)(globalThis.window, globalThis.require, globalThis.document, FakeNode);

const factory = registered.get('dsh-side-chat');
if (factory === undefined) throw new Error('bundle did not register id "dsh-side-chat"');
const plugin = factory(globalThis.require);

// ── assertions ──────────────────────────────────────────────────────────────
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `  — ${detail}`}`);
};

check('bundle registers under id "dsh-side-chat"', registered.has('dsh-side-chat'));
check('exports apply and inject', typeof plugin.apply === 'function' && Array.isArray(plugin.inject));
check('inject roster is exactly sessions + slots', JSON.stringify(plugin.inject) === JSON.stringify(['sessions', 'slots']), JSON.stringify(plugin.inject));

effectQueue = [];
plugin.apply(ctx);
check('apply injects into "shell.overlay"', calls.inject.includes('shell.overlay'), JSON.stringify(calls.inject));
check('apply registers exactly one contribution', calls.register.length === 1);

const contribution = calls.register[0];
check('contribution is registered for shell.overlay', contribution.definition.name === 'shell.overlay');
check('contribution id is "side-chat"', contribution.definition.id === 'side-chat');
check('contribution carries an inject factory', typeof contribution.definition.inject === 'function');
check('component is registered directly (not a factory)', typeof contribution.component === 'function' && contribution.component.length <= 1);

const injected = contribution.definition.inject();
check('inject face exposes the controller', typeof injected.sideChat === 'object' && injected.sideChat !== null);
check('inject face exposes both hooks', typeof injected.hooks.sideChatView === 'object' && typeof injected.hooks.sideChatRows === 'object');
check('inject face no longer needs the current-session reader', injected.currentSessionId === undefined);

// Closed state: no launcher, no panel.
let tree = contribution.component(injected);
check('closed: renders no launcher', findAll(tree, 'button').length === 0, JSON.stringify(tags(tree)));
check('closed: renders no panel', findAll(tree, 'aside').length === 0);

// Fold behaviour over the child window: inherited prefix is skipped.
const folded = plugin.foldTranscript([
  { type: 'event', event: { type: 'user/message', seq: 0, time: 0, data: { content: [{ type: 'text', text: 'INHERITED' }], source: { kind: 'user' } } } },
  { type: 'event', event: { type: 'session/end-seed', seq: 1, time: 0, data: { inherited: true } } },
  { type: 'event', event: { type: 'user/message', seq: 2, time: 0, data: { content: [{ type: 'text', text: 'MY QUESTION' }], source: { kind: 'user' } } } },
  { type: 'event', event: { type: 'assistant/message', seq: 3, time: 0, data: { message: { content: [{ type: 'text', text: 'MY ANSWER' }] }, stream: [] } } },
  { type: 'event', event: { type: 'user/message', seq: 4, time: 0, data: { content: [{ type: 'text', text: 'injected reminder' }], source: { kind: 'system' } } } },
]);
check('fold skips the inherited prefix', !JSON.stringify(folded).includes('INHERITED'), JSON.stringify(folded));
check('fold keeps this conversation\'s own turns', folded.length === 2 && folded[0].text === 'MY QUESTION' && folded[1].text === 'MY ANSWER', JSON.stringify(folded));
check('fold drops harness-injected context', !JSON.stringify(folded).includes('injected reminder'));

// The transcript the plugin will read its bounded context from.
globalThis.__turns = [
  makeTurn('user', 'why is the side conversation cheap?'),
  makeTurn('assistant', 'because it never re-sends the whole conversation'),
  makeTurn('user', 'ok, and how does it know the context?'),
  makeTurn('assistant', 'the quoted passage stays the inherited prefix stays a cache hit here'),
];

// Open: a DETACHED blank Session is created and retained. No fork.
const controller = injected.sideChat;
fetchMode = 'summary';
await controller.open('the quoted passage', 'SOURCE-BLOCK', 'PASSAGE-BLOCK', 2);
check('open never forks (a fork inherits context and joins the parent workspace)', calls.fork.length === 0, JSON.stringify(calls.fork));
check('open creates a detached Session', calls.create.length === 1 && calls.create[0].sessionId === undefined, JSON.stringify(calls.create));
check('create payload joins NO workspace', calls.create[0].workspaceId === undefined, JSON.stringify(calls.create[0]));
check('create payload pins NO cwd', calls.create[0].cwd === undefined, JSON.stringify(calls.create[0]));
check('open retains the new child', calls.retain.length === 1 && calls.retain[0].id === 'session-side-1', JSON.stringify(calls.retain));
check('open clears the starting flag', controller.view.getSnapshot().starting === false && controller.view.getSnapshot().error === null, JSON.stringify(controller.view.getSnapshot()));
check('open stores the quote', controller.view.getSnapshot().quote === 'the quoted passage');
check('open stores the fallback excerpt', controller.view.getSnapshot().context === 'PASSAGE-BLOCK' && controller.view.getSnapshot().contextTurns === 2);
check('open offers the whole conversation to the summarizer', fetchCalls.some((c) => c.body.text === 'SOURCE-BLOCK'), JSON.stringify(fetchCalls.map((c) => c.body.text)));

// Open panel: panel present, quote visible, rows from the side conversation only.
tree = contribution.component(injected);
const panel = findAll(tree, 'aside');
check('open: renders one panel', panel.length === 1);
check('open: panel is labelled', panel[0].props['aria-label'] === 'Side chat', String(panel[0].props['aria-label']));
check('open: panel shows the quoted passage', textOf(tree).includes('the quoted passage'));
check('open: panel offers a composer', findAll(tree, 'textarea').length === 1);
check('open: composer starts disabled with an empty draft', findAll(tree, 'button').some((b) => b.props.disabled === true));
// The disclosure matters: the panel must state what the side session is.
const statusNodes = findAll(tree, 'div').filter((d) => d.props['data-side-chat'] === 'status');
check('open: panel discloses the detached-session behaviour', statusNodes.length === 1 && /Detached session/i.test(String(statusNodes[0].props.children)), JSON.stringify(statusNodes.map((d) => d.props.children)));
check('open: panel never claims the chat is unsaved', !/not saved|不会保存/i.test(textOf(tree)));
// The context cost is visible before it is spent.
const contextNodes = findAll(tree, 'div').filter((d) => d.props['data-side-chat'] === 'context');
check('open: panel shows what the question will carry', contextNodes.length === 1, JSON.stringify(contextNodes.map((d) => d.props.children)));

// The panel owns its own way out: folding it away must not discard the chat.
const collapseButton = findAll(tree, 'button').find((b) => b.props['data-side-chat'] === 'collapse');
const closeButton = findAll(tree, 'button').find((b) => b.props['data-side-chat'] === 'close');
check('open: panel offers a collapse control', collapseButton !== undefined, JSON.stringify(findAll(tree, 'button').map((b) => b.props['data-side-chat'])));
check('open: panel offers a close control', closeButton !== undefined);
check('open: collapse control is labelled for collapsing', collapseButton?.props['aria-label'] === 'Collapse side chat', String(collapseButton?.props['aria-label']));

collapseButton.props.onClick();
check('collapse: the view records it', controller.view.getSnapshot().minimized === true, String(controller.view.getSnapshot().minimized));
tree = contribution.component(injected);
// NOTE: findAll() returns walker REPORT records ({ tag, props }), not live
// elements, so a report cannot be re-walked. Assert against the root tree.
const collapsedPanel = findAll(tree, 'aside')[0];
check('collapse: the panel shrinks to a collapsed strip', collapsedPanel.props['data-collapsed'] === 'true', String(collapsedPanel.props['data-collapsed']));
check('collapse: the strip is just the header height', collapsedPanel.props.style.height === '42px' && collapsedPanel.props.style.bottom === 'auto', JSON.stringify({ height: collapsedPanel.props.style.height, bottom: collapsedPanel.props.style.bottom }));
check('collapse: the title stays in the strip', tags(tree).filter((tag) => tag === 'span').length === 1, JSON.stringify(tags(tree)));
check('collapse: the transcript and composer are hidden', findAll(tree, 'textarea').length === 0);
check('collapse: the composer status line is gone', findAll(tree, 'div').every((d) => d.props['data-side-chat'] !== 'status'));
check('collapse: both controls remain reachable', findAll(tree, 'button').length === 2, JSON.stringify(findAll(tree, 'button').map((b) => b.props['data-side-chat'])));
const expandButton = findAll(tree, 'button').find((b) => b.props['data-side-chat'] === 'collapse');
check('collapse: the control flips to expand', expandButton.props['aria-label'] === 'Expand side chat', String(expandButton.props['aria-label']));
check('collapse: the side Session survives', controller.view.getSnapshot().open === true && calls.release === 0, JSON.stringify({ open: controller.view.getSnapshot().open, releases: calls.release }));
expandButton.props.onClick();
tree = contribution.component(injected);
check('expand: the transcript and composer come back', findAll(tree, 'aside')[0].props['data-collapsed'] === undefined && findAll(tree, 'textarea').length === 1);
// Folding is not re-seeding: no second Session, no second briefing, no prompt.
check('expand: nothing was re-issued', calls.create.length === 1 && calls.prompt.length === 0 && fetchCalls.length === 1, JSON.stringify({ creates: calls.create.length, prompts: calls.prompt.length, briefings: fetchCalls.length }));

// Prompting: the FIRST send carries context + quote + question in one message.
controller.setDraft('What else?');
controller.ask(controller.view.getSnapshot().draft);
await new Promise((r) => setTimeout(r, 0));
check('ask sends exactly one prompt', calls.prompt.length === 1, JSON.stringify(calls.prompt));
const firstPrompt = calls.prompt[0].content[0].text;
check('first prompt leads with the bounded context', firstPrompt.startsWith('BRIEFING:') || firstPrompt.startsWith('[Assistant]') || firstPrompt.startsWith('[User]'), JSON.stringify(firstPrompt));
check('first prompt quotes the selection', firstPrompt.includes('> the quoted passage'), JSON.stringify(firstPrompt));
check('first prompt appends the question', firstPrompt.endsWith('What else?'));
check('ask uses the queue delivery mode', calls.prompt[0].mode === 'queue');
check('ask clears the quote so it is not repeated', controller.view.getSnapshot().quote === '');
check('ask clears the context so it is not re-sent', controller.view.getSnapshot().context === '' && controller.view.getSnapshot().contextTurns === 0);

// The context rides ONE question only: a follow-up must not re-send it.
controller.setDraft('And then?');
controller.ask('And then?');
await new Promise((r) => setTimeout(r, 0));
check('second prompt is the question alone', calls.prompt.length === 2 && calls.prompt[1].content[0].text === 'And then?', JSON.stringify(calls.prompt[1] && calls.prompt[1].content[0].text));

// A running turn swaps Send for Stop.
bindings.get('session-side-1').setRunning(true);
tree = contribution.component(injected);
const buttons = findAll(tree, 'button');
const buttonLabels = buttons.map((b) => (typeof b.props.children === 'string' ? b.props.children : JSON.stringify(b.props.children)));
check('running: offers Stop instead of Send', buttons.some((b) => b.props.children === 'Stop'), JSON.stringify(buttonLabels));
check('running: offers no Send button', !buttons.some((b) => b.props.children === 'Send'), JSON.stringify(buttonLabels));
controller.stop();
await new Promise((r) => setTimeout(r, 0));
check('stop cancels the side session', calls.cancel.length === 1 && calls.cancel[0].sessionId === 'session-side-1', JSON.stringify(calls.cancel));

// Close: everything is dropped and the surface disappears.
controller.close();
check('close releases the retained reference', calls.release === 1, `release=${String(calls.release)}`);
check('close resets the view', controller.view.getSnapshot().open === false && controller.view.getSnapshot().quote === '', JSON.stringify(controller.view.getSnapshot()));
check('close clears the rows', controller.rows.getSnapshot().length === 0);
tree = contribution.component(injected);
check('close: panel is gone', findAll(tree, 'aside').length === 0);

// Reopen: a fresh detached Session, never the released one.
await controller.open('second passage', 'SOURCE-2', '', 0);
check('reopen creates a NEW detached Session', calls.create.length === 2 && calls.retain[1].id === 'session-side-2', JSON.stringify(calls.retain.map((r) => r.id)));
check('reopen never forks either', calls.fork.length === 0);
controller.close();

// ── the real gesture: selecting transcript text offers the launcher, and the
//    briefing the question will carry comes from the host half ───────────────
globalThis.__turns = [
  makeTurn('assistant', 'EARLIER-TURN-1 ' + 'a'.repeat(300)),
  makeTurn('user', 'EARLIER-TURN-2'),
  makeTurn('assistant', 'SELECTION-TURN the passage under the cursor'),
];
// Render once so the component's effect subscribes its document listeners.
tree = contribution.component(injected);
installSelection('the passage under the cursor', true);
document.dispatch('mouseup');
tree = contribution.component(injected);
const launcher = findAll(tree, 'button').filter((b) => b.props.children === 'Ask');
check('gesture: selecting transcript text offers the launcher', launcher.length === 1, JSON.stringify(findAll(tree, 'button').map((b) => b.props.children)));
check('gesture: the launcher is anchored to the selection rect', launcher[0].props.style.left === '120px' && launcher[0].props.style.top === '200px', JSON.stringify({ left: launcher[0].props.style.left, top: launcher[0].props.style.top }));

// A selection outside the transcript must offer nothing.
installSelection('sidebar text', false);
document.dispatch('mouseup');
tree = contribution.component(injected);
check('gesture: a selection outside the transcript offers nothing', findAll(tree, 'button').length === 0, JSON.stringify(findAll(tree, 'button').map((b) => b.props.children)));

// Click it: the plugin asks the HOST half for a briefing of the conversation.
installSelection('the passage under the cursor', true);
document.dispatch('mouseup');
tree = contribution.component(injected);
fetchCalls.length = 0;
fetchMode = 'summary';
findAll(tree, 'button').filter((b) => b.props.children === 'Ask')[0].props.onClick();
await new Promise((r) => setTimeout(r, 0));
check('briefing: exactly one summarize call is made', fetchCalls.length === 1, JSON.stringify(fetchCalls.map((c) => c.url)));
check('briefing: it posts to the host route', fetchCalls[0]?.url === '/side-chat/summarize', String(fetchCalls[0]?.url));
check('briefing: it sends the visible conversation, not just the selection', String(fetchCalls[0]?.body.text).includes('EARLIER-TURN-1') && String(fetchCalls[0]?.body.text).includes('EARLIER-TURN-2'), String(fetchCalls[0]?.body.text).slice(0, 80));
check('briefing: it bounds its own input', fetchCalls[0]?.body.maxChars === 24000, String(fetchCalls[0]?.body.maxChars));
const briefed = controller.view.getSnapshot();
check('briefing: the summary is adopted', briefed.summary === 'BRIEFING: the conversation is about X.' && briefed.summarizing === false, JSON.stringify(briefed.summary));
check('briefing: no error is reported on success', briefed.summaryError === null, String(briefed.summaryError));

// The briefing is what the first question actually carries.
controller.setDraft('What about it?');
controller.ask('What about it?');
await new Promise((r) => setTimeout(r, 0));
const briefedPrompt = calls.prompt[calls.prompt.length - 1].content[0].text;
check('briefing: the first prompt leads with the summary', briefedPrompt.startsWith('BRIEFING:'), JSON.stringify(briefedPrompt));
check('briefing: the first prompt still quotes the selection', briefedPrompt.includes('> the passage under the cursor'), JSON.stringify(briefedPrompt));
check('briefing: the summary is cleared after use', controller.view.getSnapshot().summary === '', JSON.stringify(controller.view.getSnapshot().summary));

// A failed briefing must fall back to the transcript excerpt, never break.
for (const mode of ['empty', 'error', 'no-reason', 'whitespace', 'http-error', 'reject', 'bad-json']) {
  controller.close();
  globalThis.__turns = [
    makeTurn('assistant', 'FALLBACK-TURN-1'),
    makeTurn('assistant', 'SELECTION-TURN the passage under the cursor'),
  ];
  installSelection('the passage under the cursor', true);
  document.dispatch('mouseup');
  tree = contribution.component(injected);
  fetchCalls.length = 0;
  fetchMode = mode;
  findAll(tree, 'button').filter((b) => b.props.children === 'Ask')[0].props.onClick();
  await new Promise((r) => setTimeout(r, 0));
  const failed = controller.view.getSnapshot();
  check(`fallback (${mode}): no summary is adopted`, failed.summary === '', JSON.stringify(failed.summary));
  check(`fallback (${mode}): the reason is surfaced`, failed.summaryError !== null, String(failed.summaryError));
  check(`fallback (${mode}): the excerpt is kept for sending`, failed.context.includes('FALLBACK-TURN-1'), JSON.stringify(failed.context));
  check(`fallback (${mode}): summarizing has stopped`, failed.summarizing === false, String(failed.summarizing));
  // The panel must say what it is sending and admit the briefing failed.
  const fallbackTree = contribution.component(injected);
  const noteNodes = findAll(fallbackTree, 'div').filter((d) => d.props['data-side-chat'] === 'context-note');
  check(`fallback (${mode}): the panel discloses the failure`, noteNodes.length === 1, JSON.stringify(noteNodes.length));
  const contextNodes = findAll(fallbackTree, 'div').filter((d) => d.props['data-side-chat'] === 'context');
  check(`fallback (${mode}): the panel names the excerpt as the payload`, /excerpt/i.test(String(contextNodes[0]?.props.children)), JSON.stringify(contextNodes[0]?.props.children));
}
// And a fallback question must carry the excerpt rather than nothing.
controller.setDraft('Fallback question?');
controller.ask('Fallback question?');
await new Promise((r) => setTimeout(r, 0));
const fallbackPrompt = calls.prompt[calls.prompt.length - 1].content[0].text;
check('fallback: the prompt carries the excerpt', fallbackPrompt.includes('FALLBACK-TURN-1'), JSON.stringify(fallbackPrompt));
controller.close();

// The budget drops an oversized turn whole instead of truncating it.
globalThis.__turns = [
  makeTurn('assistant', 'O'.repeat(50000)),
  makeTurn('assistant', 'SELECTION-TURN ' + 'the passage under the cursor'),
];
installSelection('the passage under the cursor', true);
document.dispatch('mouseup');
tree = contribution.component(injected);
fetchMode = 'empty';
findAll(tree, 'button').filter((b) => b.props.children === 'Ask')[0].props.onClick();
await new Promise((r) => setTimeout(r, 0));
const bounded = controller.view.getSnapshot();
check('budget: an oversized preceding turn is dropped whole', bounded.context === '' && bounded.contextTurns === 0, JSON.stringify({ turns: bounded.contextTurns, len: bounded.context.length }));
controller.close();

const failures = results.filter((r) => !r.ok);
console.log(`\n${String(results.length - failures.length)}/${String(results.length)} checks passed`);
console.log(`MODEL CALLS: 0 (no network, no LLM adapter touched)`);
if (failures.length > 0) {
  console.log('\nFAILURES:');
  for (const f of failures) console.log(`  - ${f.name} ${f.detail}`);
  process.exitCode = 1;
}
