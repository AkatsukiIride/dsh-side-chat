/**
 * dsh-side-chat — HOST half.
 *
 * This exists for exactly one reason: a BROWSER plugin cannot call the model.
 * `ctx.llm` is a host-plane service, so the browser half has no way to turn the
 * conversation on screen into a model-written summary. This half provides that
 * and nothing else — in particular it creates NO Session, which is what keeps
 * summarization from reintroducing the context and workspace pollution the
 * browser half exists to avoid.
 *
 * The call shape follows the shipped `dsh-session-title-llm` auxiliary call:
 * read the current default route, stream with an explicit `maxTokens`, assemble
 * blocks with `BlockAssembler`, and treat a non-`stop` finish as a failure.
 *
 * Route: POST /side-chat/summarize  { text, maxChars? } -> { summary } | { error }
 */

import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'

/** Service keys this half waits for. */
export const inject = ['webServer', 'llm', 'agentDefaultModel']

/** Endpoint the browser half calls. Same-origin, so no extra auth is involved. */
const ROUTE = '/side-chat/summarize'

/** Hard ceiling on input, in code points, whatever the caller asks for. */
const MAX_INPUT_CODE_POINTS = 48000

/** Default input ceiling: a long conversation, bounded in cost. */
const DEFAULT_INPUT_CODE_POINTS = 24000

/**
 * Ceiling on the briefing itself, in output tokens.
 *
 * Raised 400 -> 800 -> 2000 against real failures. It has now failed at
 * `max-tokens` twice, so the honest reading is that a FIXED ceiling is the wrong
 * shape for this job: a long conversation's briefing is longer than a short
 * one's, and a cap tight enough to bound cost is also tight enough to truncate a
 * large Session's briefing. 2000 gives a substantive briefing room without
 * letting a runaway generation cost much. A summarizer that chunks a long
 * conversation and then reduces the chunks is the real fix and is NOT
 * implemented — see the README.
 *
 * The caller is told about a `max-tokens` finish rather than handed a truncated
 * briefing, so an overrun costs the briefing and falls back to the excerpt.
 */
const MAX_OUTPUT_TOKENS = 2000

/** Longest request body accepted, in bytes. */
const MAX_BODY_BYTES = 4 * 1024 * 1024

/** Wall-clock ceiling for one summarization call. */
const TIMEOUT_MS = 60_000

/** Instruction for the summarization call; the briefing follows the source language. */
const SYSTEM_PROMPT = [
  'You compress one AI coding-assistant conversation into a short briefing that another',
  'model will read before answering a follow-up question about it.',
  'Report only what the conversation establishes: what the user is working on, the',
  'decisions taken and why, the constraints in force, what was concluded, and what is',
  'still open. Keep the concrete identifiers a reader would need to be useful — file',
  'paths, symbol and command names, exact error text. Drop greetings and pleasantries,',
  'and ignore anything the harness itself said rather than the participants.',
  'Do not address the reader, do not propose next steps, and add no commentary:',
  'output the briefing only, and write it in the language the conversation uses.',
].join(' ')

/**
 * Cut text to a code-point budget without splitting a surrogate pair.
 * @param value - source text.
 * @param maximum - maximum code points to keep.
 * @returns the longest allowed prefix.
 */
function truncateCodePoints(value, maximum) {
  let count = 0
  let end = 0
  for (const codePoint of value) {
    if (count === maximum) return value.slice(0, end)
    count += 1
    end += codePoint.length
  }
  return value
}

/**
 * Read a bounded request body.
 * @returns the body text, or null when it is oversized or unreadable.
 */
async function readBody(req) {
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) return null
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** Send one JSON response. */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/**
 * Turn one auxiliary call's stream into text, refusing anything but a clean stop.
 * @param chunks - the adapter's chunk stream.
 * @returns the assembled summary text.
 * @throws when the call failed, ran out of tokens, or asked for a tool.
 */
async function collectSummary(chunks) {
  const assembler = new BlockAssembler()
  for await (const chunk of chunks) assembler.push(chunk)
  const finish = assembler.finish
  if (finish.kind !== 'stop') {
    const detail = finish.failure?.message ?? finish.kind
    throw new Error(`summarization did not finish cleanly: ${String(detail)}`)
  }
  const blocks = assembler.blocks()
  if (blocks.some((block) => block.type === 'tool-call')) throw new Error('summarization produced a tool call')
  return blocks
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

/**
 * Install the summarization endpoint.
 * @param ctx - host context carrying the webserver, the LLM, and the default model route.
 */
export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTE,
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'method-not-allowed' })
        return
      }
      let payload
      try {
        const raw = await readBody(req)
        if (raw === null) {
          sendJson(res, 413, { error: 'request body too large' })
          return
        }
        payload = JSON.parse(raw)
      } catch {
        sendJson(res, 400, { error: 'invalid JSON body' })
        return
      }
      const text = typeof payload?.text === 'string' ? payload.text : ''
      if (text.trim() === '') {
        sendJson(res, 400, { error: 'text is required' })
        return
      }
      const requested = Number.isSafeInteger(payload?.maxChars) && payload.maxChars > 0
        ? Math.min(payload.maxChars, MAX_INPUT_CODE_POINTS)
        : DEFAULT_INPUT_CODE_POINTS
      // Keep the TAIL when over budget: the end of a conversation is where its
      // current state lives, which is what a follow-up question needs.
      const bounded = truncateCodePoints(text.slice(-(requested * 2)), requested)

      const abort = new AbortController()
      const timer = setTimeout(() => { abort.abort(new Error('summarization timed out')) }, TIMEOUT_MS)
      try {
        const route = ctx.agentDefaultModel.currentSelection()
        const summary = await collectSummary(ctx.llm.stream({
          provider: route.provider,
          model: route.model,
          system: SYSTEM_PROMPT,
          messages: [createUserMessage({
            content: [{ type: 'text', text: bounded }],
            source: { kind: 'dsh-side-chat' },
          })],
          maxTokens: MAX_OUTPUT_TOKENS,
          purpose: 'side-chat-summary',
          signal: abort.signal,
        }))
        if (summary === '') {
          sendJson(res, 200, { summary: '', error: 'the model returned no text' })
          return
        }
        sendJson(res, 200, { summary })
      } catch (error) {
        // A failed summary is not fatal: the browser half falls back to its own
        // transcript excerpt, so the panel keeps working without a briefing.
        const message = error instanceof Error ? error.message : String(error)
        ctx.logger?.warn?.(`side-chat: summarization failed: ${message}`)
        sendJson(res, 200, { summary: '', error: message })
      } finally {
        clearTimeout(timer)
      }
    },
  }), 'side-chat: summarize route')
}
