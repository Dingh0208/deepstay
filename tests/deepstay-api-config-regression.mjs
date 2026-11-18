import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { registerHooks, stripTypeScriptTypes } from 'node:module'
import { fileURLToPath } from 'node:url'

const sourceRoot = new URL('../src/', import.meta.url)
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL?.startsWith(sourceRoot.href)) {
      const candidate = new URL(specifier.slice(0, -3) + '.ts', context.parentURL)
      if (existsSync(fileURLToPath(candidate))) return { url: candidate.href, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url.startsWith(sourceRoot.href) && new URL(url).pathname.endsWith('.ts')) {
      return { format: 'module', source: stripTypeScriptTypes(readFileSync(new URL(url), 'utf8'), { mode: 'transform' }), shortCircuit: true }
    }
    return nextLoad(url, context)
  },
})
const saved = new Map()
globalThis.localStorage = { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value), removeItem: key => saved.delete(key) }
Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh-CN' }, configurable: true })
globalThis.__API_ORIGIN__ = 'https://api.deepseek.com'
const checks = []
let networkCalls = 0
let responder = () => { throw new Error('Unexpected test fetch') }
globalThis.fetch = async (url, init) => { networkCalls += 1; return responder(String(url), init) }

const settings = await import(new URL('services/settings.ts', sourceRoot))
assert.equal(settings.useSettings.getState().apiBaseUrl, 'https://api.deepseek.com')
assert.equal(settings.useSettings.getState().apiProtocol, 'deepseek')
assert.equal(settings.useSettings.getState().model, 'deepseek-flash')
assert.equal(settings.useSettings.getState().thinkingCollapsed, false)
const configured = { apiKey: 'fixture-private-key', apiBaseUrl: 'https://gateway.example.test/proxy/v1', apiProtocol: 'openai', model: 'chosen-reasoner', models: ['chosen-reasoner', 'second-model'] }
settings.setApiConnection(configured)
settings.setThinkingCollapsed(true)
const reloaded = await import(new URL('services/settings.ts?settings-reload', sourceRoot))
for (const [key, value] of Object.entries(configured)) assert.deepEqual(reloaded.useSettings.getState()[key], value)
assert.equal(reloaded.useSettings.getState().thinkingCollapsed, true)
checks.push('Fresh settings preserve the existing DeepSeek defaults and expanded thinking; custom URL, key, protocol, model list and collapse preference survive a cold reload')

const { normalizeApiBaseUrl, apiEndpoint, getApiConnection } = await import(new URL('services/api/connection.ts', sourceRoot))
const { ApiError, fetchModels, verifyApiKey, streamMessage } = await import(new URL('services/api/client.ts', sourceRoot))
assert.equal(normalizeApiBaseUrl(' https://gateway.example.test/proxy/v1/// '), 'https://gateway.example.test/proxy/v1')
assert.equal(normalizeApiBaseUrl('http://127.0.0.1:8000/v1/'), 'http://127.0.0.1:8000/v1')
for (const invalid of ['', '/v1', 'not a URL', 'ftp://gateway.example.test', 'https://name:pass@gateway.example.test/v1', 'https://gateway.example.test/v1?key=secret', 'https://gateway.example.test/v1#part']) {
  assert.throws(() => normalizeApiBaseUrl(invalid), invalid)
}
for (const [base, path, expected] of [
  ['https://gateway.example.test', 'v1/models', 'https://gateway.example.test/v1/models'],
  ['https://gateway.example.test/v1', 'v1/models', 'https://gateway.example.test/v1/models'],
  ['https://gateway.example.test/proxy/v1/', 'v1/chat/completions', 'https://gateway.example.test/proxy/v1/chat/completions'],
  ['https://api.deepseek.com', 'anthropic/v1/messages', 'https://api.deepseek.com/anthropic/v1/messages'],
  ['https://api.deepseek.com/v1', 'anthropic/v1/messages', 'https://api.deepseek.com/anthropic/v1/messages'],
  ['https://gateway.example.test/proxy/anthropic/v1', 'anthropic/v1/messages', 'https://gateway.example.test/proxy/anthropic/v1/messages'],
]) assert.equal(apiEndpoint(base, path), expected)
assert.deepEqual(getApiConnection(), { baseUrl: configured.apiBaseUrl, protocol: 'openai' })
checks.push('Root and /v1 endpoints join once, reverse-proxy prefixes remain intact, DeepSeek Anthropic paths remain compatible and malformed/credential-bearing base URLs are rejected')

// The implementation promises old Android WebView support; run all network and
// conversion cases without these newer built-ins instead of adding a polyfill.
const absent = [[Object, 'hasOwn'], [Array.prototype, 'at'], [Array.prototype, 'toReversed'], [Array.prototype, 'toSorted']]
// Initialize Node's lazy Undici implementation before removing newer built-ins.
// Android's native fetch implementation does not execute Undici's setup code.
new Headers({ Accept: 'application/json' })
Response.json({ ready: true })
for (const [object, key] of absent) Object.defineProperty(object, key, { value: undefined, configurable: true, writable: true })

responder = (url, init) => {
  assert.equal(url, 'https://gateway.example.test/proxy/v1/models')
  assert.equal(init.method, 'GET')
  assert.equal(init.credentials, 'omit')
  assert.equal(new Headers(init.headers).get('Authorization'), 'Bearer fixture-private-key')
  assert.equal(new Headers(init.headers).has('x-api-key'), false)
  return Response.json({ data: [{ id: 'chosen-reasoner' }, { id: 'second-model' }, { id: 'chosen-reasoner' }, { id: '' }, { id: 1 }, null] })
}
assert.deepEqual(await fetchModels(configured.apiKey, configured.apiBaseUrl), configured.models)
await verifyApiKey(configured.apiKey)
responder = () => Response.json({ error: { message: 'Invalid credentials' } }, { status: 401 })
await assert.rejects(fetchModels('invalid-fixture-key', configured.apiBaseUrl), error => error instanceof ApiError && error.kind === 'http' && error.status === 401)
responder = () => Response.json({ unexpected: [] })
await assert.rejects(fetchModels(configured.apiKey, configured.apiBaseUrl))
const realSetTimeout = globalThis.setTimeout, realClearTimeout = globalThis.clearTimeout
const timers = new Map()
globalThis.setTimeout = (callback, delay) => { const token = {}; timers.set(token, { callback, delay }); return token }
globalThis.clearTimeout = token => timers.delete(token)
try {
  responder = (_url, init) => new Promise((_resolve, reject) => {
    if (init.signal.aborted) reject(new DOMException('Aborted', 'AbortError'))
    else init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
  })
  const timed = fetchModels(configured.apiKey, configured.apiBaseUrl)
  const timeout = [...timers.values()].find(timer => timer.delay === 10_000)
  assert.ok(timeout, 'Models request must have a bounded timeout')
  timeout.callback()
  await assert.rejects(timed)
  assert.equal(timers.size, 0)
  const caller = new AbortController()
  const pending = fetchModels(configured.apiKey, configured.apiBaseUrl, caller.signal)
  caller.abort()
  await assert.rejects(pending)
  assert.equal(timers.size, 0)
} finally {
  globalThis.setTimeout = realSetTimeout
  globalThis.clearTimeout = realClearTimeout
}
checks.push('Model discovery and connection validation use the chosen URL and Bearer key only, omit ambient credentials, deduplicate model IDs and handle authorization, invalid JSON shape, caller abort and a ten-second timeout')

const encoder = new TextEncoder()
const asSse = frames => frames.map(frame => typeof frame === 'string' ? `data: ${frame}\n\n` : `data: ${JSON.stringify(frame)}\n\n`).join('')
const streamedResponse = frames => {
  const bytes = encoder.encode(asSse(frames))
  return new Response(new ReadableStream({ start(controller) {
    // Deliberately cut multibyte Chinese and SSE fields across network chunks.
    for (let offset = 0; offset < bytes.length;) {
      const end = Math.min(bytes.length, offset + 1 + offset % 13)
      controller.enqueue(bytes.slice(offset, end))
      offset = end
    }
    controller.close()
  } }), { headers: { 'Content-Type': 'text/event-stream' } })
}
const body = {
  model: configured.model, system: '系统说明',
  messages: [
    { role: 'user', content: '上一问' },
    { role: 'assistant', content: [{ type: 'text', text: '上一答' }] },
    { role: 'latest_reminder', content: '用户补充的偏好' },
    { role: 'user', content: '当前问题' },
  ],
  thinking: { type: 'enabled' }, tools: [], safety_check: { level: 'high' }, title: { enabled: true },
}
const collect = async generator => { const output = []; for await (const item of generator) output.push(item); return output }
const { applyEvent, getReplyText } = await import(new URL('services/chat/reply.ts', sourceRoot))
const renderEvents = events => {
  const indexes = new Map()
  let reply = { id: 'fixture-answer', role: 'assistant', model: configured.model, blocks: [], status: 'loading', createdAt: 1 }
  for (const [index, event] of events.entries()) reply = applyEvent(reply, event, 1000 + index, indexes)
  return reply
}
let requestBody
responder = (url, init) => {
  assert.equal(url, 'https://gateway.example.test/proxy/v1/chat/completions')
  const headers = new Headers(init.headers)
  assert.equal(headers.get('Authorization'), 'Bearer fixture-private-key')
  assert.equal(headers.has('x-api-key'), false)
  assert.equal(init.credentials, 'omit')
  requestBody = JSON.parse(init.body)
  assert.equal(requestBody.model, 'chosen-reasoner')
  assert.equal(requestBody.stream, true)
  for (const key of ['thinking', 'tools', 'safety_check', 'title']) assert.equal(key in requestBody, false, key)
  return streamedResponse([
    { id: 'chat-test', model: configured.model, choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: '先思考' }, finish_reason: null }] },
    { id: 'chat-test', choices: [{ index: 0, delta: { reasoning_content: '再推理。' }, finish_reason: null }] },
    { id: 'chat-test', choices: [{ index: 0, delta: { content: '完整回答：' }, finish_reason: null }] },
    { id: 'chat-test', choices: [{ index: 0, delta: { content: '你好，世界。' }, finish_reason: null }] },
    { id: 'chat-test', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    { id: 'chat-test', choices: [], usage: { prompt_tokens: 20, completion_tokens: 12, total_tokens: 32 } },
    '[DONE]',
  ])
}
const complete = await collect(streamMessage(configured.apiKey, body, new AbortController().signal))
assert.equal(complete[complete.length - 1].type, 'message_stop')
assert.equal(complete.filter(event => event.type === 'message_stop').length, 1)
const rendered = renderEvents(complete)
assert.equal(rendered.blocks.filter(block => block.type === 'thinking').map(block => block.thinking).join(''), '先思考再推理。')
assert.equal(getReplyText(rendered), '完整回答：你好，世界。')
assert.equal(rendered.stopReason, 'end_turn')
assert.equal(rendered.usage.output_tokens, 12)
assert.equal(requestBody.messages.some(message => message.content === '上一答'), true)
assert.equal(requestBody.messages.some(message => message.content === '用户补充的偏好'), true)
assert.equal(requestBody.messages[requestBody.messages.length - 1].content, '当前问题')
checks.push('Selected custom model and key reach only its OpenAI endpoint; chunked reasoning_content and content become complete existing reply blocks, preserve history and reminder text, consume trailing usage and finish once')

responder = (_url, init) => {
  assert.equal(JSON.parse(init.body).thinking.type, 'enabled')
  return streamedResponse([{ id: 'official-openai', choices: [{ delta: { content: '官方兼容响应' }, finish_reason: 'length' }] }, '[DONE]'])
}
const official = renderEvents(await collect(streamMessage('official-fixture-key', { ...body, model: 'deepseek-chat' }, new AbortController().signal, { baseUrl: 'https://api.deepseek.com', protocol: 'openai' })))
assert.equal(getReplyText(official), '官方兼容响应')
assert.equal(official.stopReason, 'max_tokens')

for (const [frames, expectedKind] of [
  [[{ id: 'cut', choices: [{ delta: { content: '部分回答' }, finish_reason: null }] }], 'interrupted'],
  [[{ error: { message: 'Upstream stream failed' } }], 'stream'],
]) {
  responder = () => streamedResponse(frames)
  await assert.rejects(collect(streamMessage(configured.apiKey, body, new AbortController().signal)), error => error instanceof ApiError && error.kind === expectedKind)
}
responder = () => new Response('{"choices":[]}', { headers: { 'Content-Type': 'application/json' } })
await assert.rejects(collect(streamMessage(configured.apiKey, body, new AbortController().signal)), error => error instanceof ApiError && error.kind === 'protocol')
let cancelled = false
responder = () => new Response(new ReadableStream({ cancel() { cancelled = true } }), { headers: { 'Content-Type': 'text/event-stream' } })
const aborter = new AbortController()
const abortedRead = collect(streamMessage(configured.apiKey, body, aborter.signal))
await new Promise(resolve => realSetTimeout(resolve, 0))
aborter.abort(new DOMException('Stopped by user', 'AbortError'))
await assert.rejects(abortedRead)
assert.equal(cancelled, true)
checks.push('Official DeepSeek OpenAI thinking and length completion adapt correctly; truncated streams, upstream errors, non-SSE responses and cancellation remain distinct from successful completion')

const callsBeforeUnsupported = networkCalls
for (const unsupported of [
  { ...body, tools: [{ type: 'deepseek_web_search', name: 'deepseek_web_search' }] },
  { ...body, messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'file', file_id: 'wrong-provider-file' } }] }] },
]) await assert.rejects(collect(streamMessage(configured.apiKey, unsupported, new AbortController().signal)), error => error instanceof ApiError && error.kind === 'protocol')
assert.equal(networkCalls, callsBeforeUnsupported)
checks.push('Unsupported DeepSeek tools and provider-specific file references are rejected before a custom OpenAI request instead of silently losing data or sending provider file IDs elsewhere')

responder = (url, init) => {
  assert.equal(url, 'https://api.deepseek.com/anthropic/v1/messages')
  assert.equal(new Headers(init.headers).get('x-api-key'), 'deepseek-fixture-key')
  assert.equal(JSON.parse(init.body).model, 'deepseek-v4-pro')
  return streamedResponse([
    { type: 'message_start', message: { id: 'deepseek-test', model: 'deepseek-v4-pro' } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '原协议完整回答' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null } },
    { type: 'message_stop' },
  ])
}
const original = renderEvents(await collect(streamMessage('deepseek-fixture-key', { ...body, model: 'deepseek-v4-pro' }, new AbortController().signal, { baseUrl: 'https://api.deepseek.com/v1', protocol: 'deepseek' })))
assert.equal(getReplyText(original), '原协议完整回答')
assert.equal(original.stopReason, 'end_turn')
checks.push('Existing DeepSeek Anthropic endpoint, x-api-key authentication, selected model and event-driven answer rendering continue to work')

const deepseek = { baseUrl: 'https://api.deepseek.com/v1', protocol: 'deepseek' }
const namedFrame = frame => `event: ${frame.type}\r\ndata: ${JSON.stringify(frame)}\r\n\r\n`
const screenshotFrame = namedFrame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '逐段回复' } })
const fixtures = [
  [
    deepseek,
    'text/plain',
    namedFrame({ type: 'message_start', message: { id: 'mislabeled', model: body.model } }) +
      namedFrame({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) +
      screenshotFrame,
    namedFrame({ type: 'content_block_stop', index: 0 }) +
      namedFrame({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null } }) +
      namedFrame({ type: 'message_stop' }),
  ],
  [
    getApiConnection(),
    'application/octet-stream',
    asSse([{ id: 'mislabeled', choices: [{ delta: { content: '逐段回复' } }] }]),
    asSse([{ choices: [{ delta: {}, finish_reason: 'stop' }] }, '[DONE]']),
  ],
]
for (const [connection, contentType, firstChunk, lastChunk] of fixtures) {
  let input
  responder = () => new Response(new ReadableStream({ start(controller) { input = controller } }), { headers: { 'Content-Type': contentType } })
  const reader = streamMessage(configured.apiKey, body, new AbortController().signal, connection)
  input = undefined
  const firstEvent = reader.next()
  // Let the async request create the stream before enqueueing the first chunk.
  await new Promise(resolve => realSetTimeout(resolve, 0))
  input.enqueue(encoder.encode(firstChunk))
  const events = [(await firstEvent).value, (await reader.next()).value, (await reader.next()).value]
  assert.equal(getReplyText(renderEvents(events)), '逐段回复', 'Text must arrive before the response ends')
  input.enqueue(encoder.encode(lastChunk))
  input.close()
  assert.equal(renderEvents([...events, ...await collect(reader)]).stopReason, 'end_turn')

  responder = () => new Response(screenshotFrame, { status: 400, headers: { 'Content-Type': contentType } })
  await assert.rejects(collect(streamMessage(configured.apiKey, body, new AbortController().signal, connection)), error =>
    error instanceof ApiError && error.kind === 'http' && error.status === 400 &&
    error.localMessage?.key === 'replyInvalidStream' && !error.message.includes('content_block_delta'))

  responder = () => new Response(asSse([{ error: { message: screenshotFrame } }]), { headers: { 'Content-Type': 'text/event-stream' } })
  await assert.rejects(collect(streamMessage(configured.apiKey, body, new AbortController().signal, connection)), error =>
    error instanceof ApiError && error.kind === 'stream' && error.localMessage?.key === 'replyInvalidStream')
}
responder = () => Response.json({ error: { message: 'Specific provider failure' } })
await assert.rejects(collect(streamMessage(configured.apiKey, body, new AbortController().signal, deepseek)), error =>
  error instanceof ApiError && error.kind === 'protocol' && error.message === 'Specific provider failure')
responder = () => new Response(namedFrame({ type: 'error', error: { message: 'Specific HTTP stream failure' } }), {
  status: 400, headers: { 'Content-Type': 'text/event-stream' },
})
await assert.rejects(collect(streamMessage(configured.apiKey, body, new AbortController().signal, deepseek)), error =>
  error instanceof ApiError && error.kind === 'http' && error.status === 400 && error.message === 'Specific HTTP stream failure')
checks.push('Valid responses mislabeled by the provider stream incrementally on DeepSeek and OpenAI; nested and HTTP error frames stay out of user notices while specific provider errors remain readable')

const { supportsDeepSeekExtras } = await import(new URL('services/api/connection.ts', sourceRoot))
assert.equal(supportsDeepSeekExtras({ baseUrl: 'https://api.deepseek.com/v1', protocol: 'deepseek' }), true)
assert.equal(supportsDeepSeekExtras({ baseUrl: configured.apiBaseUrl, protocol: 'openai' }), false)
const { transcribe, synthesize } = await import(new URL('services/api/speech.ts', sourceRoot))
const extraCalls = networkCalls
await assert.rejects(transcribe(configured.apiKey, new Blob(['audio'], { type: 'audio/wav' })))
await assert.rejects(synthesize(configured.apiKey, '私人文本', 'stella', new AbortController().signal))
assert.equal(networkCalls, extraCalls, 'Custom provider keys must never be sent to the built-in DeepSeek speech service')
checks.push('All API and SSE cases pass with four modern built-ins absent; custom provider speech is rejected before exposing its key to the built-in DeepSeek host')

const evidence = { passed: true, runtime: process.version, checks, fetchCalls: networkCalls,
  scope: 'Actual TypeScript settings, connection, API client, SSE decoder, speech guards and reply reducer with deterministic in-memory localStorage/fetch. Four modern built-ins are disabled for the network cases. No real credentials, model charges, browser or device data used. Stream transport tests pass the selected model explicitly; store-level selection is verified separately.' }
await writeFile(new URL('./deepstay-api-config-evidence.json', import.meta.url), JSON.stringify(evidence, null, 2) + '\n')
console.log(JSON.stringify(evidence, null, 2))
hooks.deregister()
