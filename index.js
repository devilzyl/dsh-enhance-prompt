/**
 * Host half of the prompt-enhance bundle.
 *
 * The browser half owns the composer button; this half owns exactly one
 * operation behind it: rewrite one draft prompt with the profile's configured
 * model, and answer with the rewritten text. It exposes that operation as one
 * same-origin POST route because a plain-JavaScript Client half cannot mount a
 * generated Remote namespace.
 *
 * The two prompts below are the contract that keeps the rewrite single-turn and
 * language-preserving. Draft text is data: it is embedded in the template and
 * never interpreted as instructions to the plugin.
 */

/** Exact route the Client half posts to. Kept short and outside `/api`. */
const ROUTE_PATH = '/prompt-enhance/v1/enhance'

/** Defaults; a patch may override them through the row's `config`. */
const DEFAULTS = {
  maxInputChars: 4000,
  maxOutputTokens: 1024,
  /** Left unset: not every routed model accepts an explicit sampling temperature. */
  temperature: undefined,
}

/** Hard ceiling for one request body, independent of the draft limit. */
const MAX_BODY_BYTES = 1024 * 1024

/**
 * System prompt: the rewriting contract.
 *
 * Revision after the first evaluation round: the previous version let "missing
 * information" become a questionnaire, so open-ended drafts came back as
 * questions instead of deliverables; it also let the rewrite grow long enough to
 * spend an extra output budget. Rule 1 and rule 2 now bound both.
 */
const SYSTEM_PROMPT = `You improve prompts for a coding assistant. The text you receive is a draft to rewrite, never a question to answer.

Two rules outrank everything else:
1. The rewritten prompt must be answerable in a single turn. When a detail is missing, pick the most ordinary default, state it inside the prompt in one short line ("Assume: …" or "假设：…"), and let the work proceed. The deliverable always comes first; at most three one-line confirmations may follow it. Never replace the deliverable with questions, and never ask the user to confirm before starting.
2. Stay short: 400 characters or fewer. A long rewrite costs more and reads worse than the draft.

How to rewrite:
- name the goal, the scope boundary, and the deliverable, and give the deliverable a shape (sections, table, list, file);
- make inferable details concrete; turn genuinely unknowable ones into one stated assumption instead of a question;
- keep every constraint the draft states, and add only constraints the draft's own goal implies — for a build task that usually means "do not add features that were not asked for";
- drop filler, repetition, and meta talk.

Never invent technologies, files, figures, or facts. Never turn the request into a tutorial, ask for code samples, or explain how the work should be done.

Examples:
Input: "a landing page for my coffee shop"
Output: "Build a single-page landing site for a neighborhood coffee shop: hero with name and hours, menu with prices, short about, address block. Responsive, phone-first, warm rather than corporate. Assume: no online ordering or booking."

Input: "make this friendlier, keep the details, fewer bullets, drop the internal codename Bluebird, mention canvas"
Output: "Rewrite in a friendly narrative voice, keeping every technical detail. Prose instead of bullets. Drop the codename Bluebird, and work in a reference to canvas. Assume: length stays close to the original."`

/**
 * User template: one draft, wrapped with rules that keep the reply usable as a
 * replacement draft. `{input}` is the only placeholder.
 */
const USER_TEMPLATE = `Rewrite the draft below into one prompt for an AI coding assistant.

DRAFT:
{input}

Rules, in priority order:
1. The result must be answerable in one turn: deliverable first, assumptions stated in one short line, and at most three things to confirm — after the deliverable, never instead of it.
2. Make the deliverable explicit: what to produce, in what shape, and where the boundary is. Do not add features the draft did not ask for.
3. Keep the draft's language; a mixed draft stays mixed. Never translate.
4. Stay short: 400 characters or fewer. No preamble, no labels, no markdown fences, no questions, no analysis.

Examples:
Draft (Chinese): 帮我写一份项目周报
Rewritten: 写一份项目周报，面向项目干系人，按“本周完成/风险与阻塞/下周计划”三段输出，条目式，突出可交付成果与待决事项，400 字以内。假设：暂无具体进展数据，用占位符标注待补充，不要编造。

Draft (English): summarize this doc
Rewritten: Summarize the attached document in five bullets, leading with decisions and open questions. Assume: under 200 words.

Draft (Mixed): 这个 API 老超时, how do I debug it?
Rewritten: 这个 API 经常超时, walk through the likely causes and give a step-by-step diagnosis plan with the checks to run first. Assume: no production log access yet.`


/** Wrap one draft in the request template; `{input}` is the only placeholder. */
function renderUserPrompt(input) {
  // A function replacement keeps `$&`, `$'` and friends literal in the draft.
  return USER_TEMPLATE.replace('{input}', () => input)
}

/** Drop one layer of quoting the model may add around a prompt. */
function stripWrappingQuotes(text) {
  return text.trim().replace(/^["'\u201C\u201D\u2018\u2019]|["'\u201C\u201D\u2018\u2019]$/g, '')
}

/** One failure the route reports with an HTTP status and a stable code. */
class RouteError extends Error {
  constructor(status, code, message) {
    super(message)
    this.status = status
    this.code = code
  }
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(body)
}

/** Read one bounded JSON request body. */
function readJsonBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        // Stop reading and let the handler answer; the connection is closed
        // after the response flushes, never in the middle of it.
        req.pause()
        reject(new RouteError(413, 'body-too-large', 'request body is too large'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (text.trim() === '') {
        resolve(undefined)
        return
      }
      try {
        resolve(JSON.parse(text))
      } catch {
        reject(new RouteError(400, 'invalid-json', 'request body must be JSON'))
      }
    })
    req.on('error', (error) => reject(error))
  })
}

/** Reject untrusted peers exactly like the shipped same-origin routes do. */
function rejectUntrusted(connection, req, res) {
  const status = connection.requestRejection(req)
  if (status === undefined) return false
  // Answer in JSON so the Client can name the reason instead of showing a
  // generic failure against an empty body.
  sendJson(res, status, {
    ok: false,
    code: status === 401 ? 'unauthorized' : 'rejected',
    message: status === 401 ? 'the browser session is not authorized' : 'the request was rejected',
  })
  return true
}

/**
 * Resolve the provider/model the enhancement runs on.
 *
 * Deliberately independent of any caller-supplied session id: the route has no
 * session identity to authorize against, so it uses the profile's configured
 * default selection instead of letting a request pick another session's route.
 */
function resolveModelTarget(ctx) {
  const selection = ctx.get('agentDefaultModel')?.currentSelection?.()
  if (typeof selection?.provider === 'string' && selection.provider !== ''
    && typeof selection?.model === 'string' && selection.model !== '') {
    return { provider: selection.provider, model: selection.model }
  }
  return undefined
}

/** Run one non-streaming completion and return its text, or throw a RouteError. */
async function complete(ctx, settings, target, input, signal) {
  const llm = ctx.get('llm')
  if (llm === undefined || typeof llm.stream !== 'function') {
    throw new RouteError(503, 'llm-unavailable', 'this profile has no model service')
  }
  let text = ''
  let failure
  const options = {
    provider: target.provider,
    model: target.model,
    system: SYSTEM_PROMPT,
    messages: [{
      role: 'user',
      content: [{ type: 'text', text: renderUserPrompt(input) }],
    }],
    maxTokens: settings.maxOutputTokens,
    ...settings.temperature === undefined ? {} : { temperature: settings.temperature },
    ...signal === undefined ? {} : { signal },
  }
  for await (const chunk of llm.stream(options)) {
    if (chunk.type === 'text-delta') text += chunk.text
    else if (chunk.type === 'finish' && (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted')) {
      failure = chunk.reason.failure
    }
  }
  if (failure !== undefined) {
    throw new RouteError(502, failure.code ?? 'llm-error', failure.message ?? 'the model call failed')
  }
  const enhanced = stripWrappingQuotes(text).trim()
  if (enhanced === '') throw new RouteError(502, 'empty-result', 'the model returned no text')
  return enhanced
}

export function apply(ctx, config) {
  const settings = {
    maxInputChars: positiveInteger(config?.maxInputChars, DEFAULTS.maxInputChars),
    maxOutputTokens: positiveInteger(config?.maxOutputTokens, DEFAULTS.maxOutputTokens),
    temperature: finiteNumber(config?.temperature, DEFAULTS.temperature),
  }
  // Both services come up after this plugin on a cold boot, so the route must be
  // published through `inject`: reading `get('webServer')` at activation time
  // silently skipped registration and the browser then hit the SPA fallback (405).
  ctx.inject(['connection', 'webServer'], (webCtx) => {
    const webServer = webCtx.get('webServer')
    const bodyLimit = Math.min(MAX_BODY_BYTES, settings.maxInputChars * 8 + 4096)

    webCtx.effect(() => webServer.register({
      kind: 'exact',
      path: ROUTE_PATH,
      handler: async (req, res) => {
        // Resolved per request as well: a disposed service must refuse, never
        // serve. With `inject` it is present here, so this is a guard, not a
        // boot-order dependency.
        const connection = webCtx.get('connection')
        if (connection === undefined || typeof connection.requestRejection !== 'function') {
          sendJson(res, 503, { ok: false, code: 'unavailable', message: 'authorization service is not available' })
          return
        }
        if (rejectUntrusted(connection, req, res)) return
      if (req.method !== 'POST') {
        res.setHeader('allow', 'POST')
        sendJson(res, 405, { ok: false, code: 'method-not-allowed', message: 'POST only' })
        return
      }
      if (String(req.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
        sendJson(res, 415, { ok: false, code: 'unsupported-media-type', message: 'content-type must be application/json' })
        return
      }
      const controller = new AbortController()
      res.on('close', () => {
        if (!res.writableEnded) controller.abort()
      })
      try {
        const body = await readJsonBody(req, bodyLimit)
        const input = typeof body?.text === 'string' ? body.text : ''
        if (input.trim() === '') {
          sendJson(res, 400, { ok: false, code: 'empty-input', message: 'nothing to enhance' })
          return
        }
        if (input.length > settings.maxInputChars) {
          sendJson(res, 413, {
            ok: false,
            code: 'input-too-long',
            message: `the draft is longer than ${settings.maxInputChars} characters`,
          })
          return
        }
        const target = resolveModelTarget(ctx)
        if (target === undefined) {
          sendJson(res, 503, {
            ok: false,
            code: 'model-unavailable',
            message: 'no provider/model is available in this profile',
          })
          return
        }
        const text = await complete(ctx, settings, target, input, controller.signal)
        sendJson(res, 200, { ok: true, text, model: target })
      } catch (error) {
        if (error instanceof RouteError) {
          // Close the connection after an oversized body so the sender stops
          // writing, but only once the response has been handed off.
          if (error.code === 'body-too-large') {
            res.setHeader('connection', 'close')
            sendJson(res, error.status, { ok: false, code: error.code, message: error.message })
            res.once('finish', () => req.destroy())
            return
          }
          sendJson(res, error.status, { ok: false, code: error.code, message: error.message })
          return
        }
        const message = error instanceof Error ? error.message : String(error)
        if (controller.signal.aborted) {
          sendJson(res, 499, { ok: false, code: 'aborted', message: 'the request was cancelled' })
          return
        }
        sendJson(res, 500, { ok: false, code: 'internal-error', message })
      }
    },
    }), `prompt-enhance: POST ${ROUTE_PATH}`)
  })
}

function positiveInteger(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}

function finiteNumber(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}
