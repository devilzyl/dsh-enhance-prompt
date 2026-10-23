/**
 * Offline contract check for the prompt-enhance Host half.
 *
 * Builds a fake Cordis context around the real `apply` export, so the route
 * handler's parsing, model resolution, prompt rendering, chunk assembly and
 * error mapping run without the running Harness or a real model.
 */
import { EventEmitter } from 'node:events'
import { apply } from '../index.js'

function makeRes() {
  return {
    statusCode: 0,
    headers: {},
    writableEnded: false,
    body: '',
    setHeader(name, value) { this.headers[name.toLowerCase()] = value },
    end(chunk) {
      if (chunk !== undefined) this.body += chunk
      this.writableEnded = true
    },
    on() {},
    once() {},
  }
}

function makeReq(body, { method = 'POST', contentType = 'application/json' } = {}) {
  const req = new EventEmitter()
  req.method = method
  req.headers = { 'content-type': contentType }
  req.url = '/prompt-enhance/v1/enhance'
  req.pause = () => {}
  req.destroy = () => {}
  setImmediate(() => {
    if (body !== undefined) req.emit('data', Buffer.from(body))
    req.emit('end')
  })
  return req
}

function makeContext({ text = 'hello', finish, routed, fallback, llm, connection = true, webServer = true } = {}) {
  let route
  let capturedOptions
  const pending = []
  const makeWebServer = () => ({ register(r) { route = r; return () => {} } })
  const services = {
    webServer: webServer ? makeWebServer() : undefined,
    connection: connection ? { requestRejection: () => undefined } : undefined,
    agents: { get: () => routed === undefined ? undefined : { session: { requestHeader: () => ({ config: routed }) } } },
    agentDefaultModel: { currentSelection: () => fallback },
    llm: llm ?? {
      async *stream(options) {
        capturedOptions = options
        yield { type: 'text-delta', index: 0, text: '"' + text }
        yield { type: 'text-delta', index: 0, text: '"' }
        yield { type: 'finish', reason: finish ?? { kind: 'stop' } }
      },
    },
  }
  const ctx = {
    get: (name) => services[name],
    effect(fn) { fn(); return () => {} },
    // Mirrors Cordis: run the callback now when every dependency is available,
    // otherwise defer it until the missing service is provided.
    inject(deps, callback) {
      if (deps.every((dep) => services[dep] !== undefined)) callback(ctx)
      else pending.push({ deps, callback })
    },
  }
  apply(ctx, {})
  return {
    get route() { return route },
    get options() { return capturedOptions },
    provide(name) {
      if (name === 'webServer') services.webServer = makeWebServer()
      if (name === 'connection') services.connection = { requestRejection: () => undefined }
      for (const entry of [...pending]) {
        if (entry.deps.every((dep) => services[dep] !== undefined)) {
          pending.splice(pending.indexOf(entry), 1)
          entry.callback(ctx)
        }
      }
    },
  }
}

async function post(ctx, body, init) {
  const res = makeRes()
  await ctx.route.handler(makeReq(body, init), res)
  let json
  try { json = JSON.parse(res.body) } catch { json = undefined }
  return { status: res.statusCode, json }
}

let failures = 0
function check(name, condition, detail) {
  if (condition) console.log('ok   ' + name)
  else { failures += 1; console.log('FAIL ' + name + (detail === undefined ? '' : ' :: ' + JSON.stringify(detail))) }
}

// 1. happy path: the profile default is used even when the caller names a
//    session, quotes are stripped, and the template wraps the draft.
{
  const ctx = makeContext({ text: 'Explain this code', routed: { provider: 'p', model: 'm-session' }, fallback: { provider: 'p', model: 'm-default' } })
  const { status, json } = await post(ctx, JSON.stringify({ text: '帮我解释这段代码', sessionId: 's1' }))
  check('happy status 200', status === 200, { status, json })
  check('a caller-supplied sessionId cannot pick another session route', json?.model?.model === 'm-default', json?.model)
  check('happy returns stripped text', json?.text === 'Explain this code', json)
  check('system prompt sent', typeof ctx.options?.system === 'string' && ctx.options.system.includes('You improve prompts for a coding assistant'), String(ctx.options?.system).slice(0, 40))
  check('user template wraps the draft', ctx.options?.messages?.[0]?.content?.[0]?.text?.includes('帮我解释这段代码'), true)
  check('template placeholder replaced', !ctx.options?.messages?.[0]?.content?.[0]?.text?.includes('{input}'), true)
}

// 1b. a draft full of replacement patterns stays literal (same rendered length
//     as an ordinary draft of the same size).
{
  const draft = "$'".repeat(50)
  const plain = makeContext({ text: 'ok', fallback: { provider: 'p', model: 'm' } })
  await post(plain, JSON.stringify({ text: 'x'.repeat(draft.length) }))
  const baseline = plain.options?.messages?.[0]?.content?.[0]?.text?.length ?? -1

  const ctx = makeContext({ text: 'ok', fallback: { provider: 'p', model: 'm' } })
  await post(ctx, JSON.stringify({ text: draft }))
  const sent = ctx.options?.messages?.[0]?.content?.[0]?.text ?? ''
  check('$ patterns are not expanded', sent.includes(draft) && sent.length === baseline, { sentLength: sent.length, baseline })
}

// 2. fallback to the configured default when the session has no routed model.
{
  const ctx = makeContext({ text: 'x', fallback: { provider: 'p', model: 'm-default' } })
  const { status, json } = await post(ctx, JSON.stringify({ text: 'hello' }))
  check('fallback status 200', status === 200, { status, json })
  check('fallback model used', json?.model?.model === 'm-default', json?.model)
}

// 3. no model anywhere -> 503 with a stable code.
{
  const ctx = makeContext({})
  const { status, json } = await post(ctx, JSON.stringify({ text: 'hello' }))
  check('no model -> 503', status === 503 && json?.code === 'model-unavailable', { status, json })
}

// 4. empty draft -> 400.
{
  const ctx = makeContext({})
  const { status, json } = await post(ctx, JSON.stringify({ text: '   ' }))
  check('empty draft -> 400', status === 400 && json?.code === 'empty-input', { status, json })
}

// 5. wrong method -> 405.
{
  const ctx = makeContext({})
  const { status } = await post(ctx, JSON.stringify({ text: 'x' }), { method: 'GET' })
  check('GET -> 405', status === 405, { status })
}

// 6. wrong content type -> 415.
{
  const ctx = makeContext({})
  const { status } = await post(ctx, JSON.stringify({ text: 'x' }), { contentType: 'text/plain' })
  check('text/plain -> 415', status === 415, { status })
}

// 7. malformed JSON -> 400.
{
  const ctx = makeContext({})
  const { status, json } = await post(ctx, '{nope')
  check('bad json -> 400', status === 400 && json?.code === 'invalid-json', { status, json })
}

// 8. model failure finish -> 502 carrying the provider code.
{
  const ctx = makeContext({ finish: { kind: 'error', failure: { code: 'rate-limited', message: 'slow down' } }, fallback: { provider: 'p', model: 'm' } })
  const { status, json } = await post(ctx, JSON.stringify({ text: 'hello' }), {})
  check('finish error -> 502', status === 502 && json?.code === 'rate-limited' && json?.message === 'slow down', { status, json })
}

// 9. whitespace-only model output -> 502 empty-result.
{
  const ctx = makeContext({ text: '   ', fallback: { provider: 'p', model: 'm' } })
  const { status, json } = await post(ctx, JSON.stringify({ text: 'hello' }))
  check('blank result -> 502', status === 502 && json?.code === 'empty-result', { status, json })
}

// 10. over-long draft -> 413.
{
  const ctx = makeContext({})
  const long = 'a'.repeat(5000)
  const { status, json } = await post(ctx, JSON.stringify({ text: long }))
  check('too long -> 413', status === 413 && json?.code === 'input-too-long', { status, json })
}

// 11. an oversized request body is refused with a close-after-response answer.
{
  const ctx = makeContext({ fallback: { provider: 'p', model: 'm' } })
  const huge = 'a'.repeat(40000)
  const res = makeRes()
  await ctx.route.handler(makeReq(JSON.stringify({ text: huge })), res)
  let json
  try { json = JSON.parse(res.body) } catch { json = undefined }
  check('oversized body -> 413 body-too-large', res.statusCode === 413 && json?.code === 'body-too-large', { status: res.statusCode, json })
  check('oversized body closes the connection', res.headers.connection === 'close', res.headers)
}

// 12. cold boot: the route is published only once both services exist, and the
//     deferred registration actually happens when they arrive.
{
  const ctx = makeContext({ webServer: false, connection: false, fallback: { provider: 'p', model: 'm' } })
  check('no route before the carrier services exist', ctx.route === undefined)
  ctx.provide('connection')
  check('still no route with only the connection service', ctx.route === undefined)
  ctx.provide('webServer')
  check('route is published once both services exist', ctx.route !== undefined)
  const { status } = await post(ctx, JSON.stringify({ text: 'hello' }))
  check('deferred route answers like any other', status === 200, { status })
}

// 13. a composition that never provides the authorization service stays
//     unpublished (no unauthenticated route).
{
  const ctx = makeContext({ connection: false, fallback: { provider: 'p', model: 'm' } })
  check('missing authorization service -> no route', ctx.route === undefined)
}

console.log(failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED')
process.exit(failures === 0 ? 0 : 1)
