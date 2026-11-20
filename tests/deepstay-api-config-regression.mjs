import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { registerHooks, stripTypeScriptTypes } from 'node:module'
import { fileURLToPath } from 'node:url'

const sourceRoot = new URL('../src/', import.meta.url)
const capacitorBridgeSource = 'export const Capacitor = { getPlatform: () => globalThis.__DEEPSTAY_CAPACITOR__?.platform ?? "web", isPluginAvailable: name => name === "ProviderHttp" && globalThis.__DEEPSTAY_CAPACITOR__?.available === true }; export const registerPlugin = () => ({ open: (...args) => globalThis.__DEEPSTAY_CAPACITOR__?.transport?.open(...args), read: (...args) => globalThis.__DEEPSTAY_CAPACITOR__?.transport?.read(...args), close: (...args) => globalThis.__DEEPSTAY_CAPACITOR__?.transport?.close?.(...args) ?? Promise.resolve() })'
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@capacitor/core' && context.parentURL?.startsWith(sourceRoot.href) && context.parentURL.endsWith('/services/api/androidTransport.ts')) {
      return { url: `data:text/javascript,${encodeURIComponent(capacitorBridgeSource)}`, shortCircuit: true }
    }
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
assert.equal(settings.useSettings.getState().showReplyTokenUsage, false)
const configured = { apiKey: 'fixture-private-key', apiBaseUrl: 'https://gateway.example.test/proxy/v1', apiProtocol: 'openai', model: 'chosen-reasoner', models: ['chosen-reasoner', 'second-model'] }
settings.setApiConnection(configured)
settings.setThinkingCollapsed(true)
settings.setShowReplyTokenUsage(true)
const reloaded = await import(new URL('services/settings.ts?settings-reload', sourceRoot))
for (const [key, value] of Object.entries(configured)) assert.deepEqual(reloaded.useSettings.getState()[key], value)
assert.equal(reloaded.useSettings.getState().thinkingCollapsed, true)
assert.equal(reloaded.useSettings.getState().showReplyTokenUsage, true)
settings.setShowReplyTokenUsage(false)
const disabled = await import(new URL('services/settings.ts?token-usage-disabled', sourceRoot))
assert.equal(disabled.useSettings.getState().showReplyTokenUsage, false)
checks.push('Fresh settings preserve the existing DeepSeek defaults and expanded thinking; custom URL, key, protocol, model list and collapse preference survive a cold reload')

const { normalizeApiBaseUrl, apiEndpoint, getApiConnection } = await import(new URL('services/api/connection.ts', sourceRoot))
const { ApiError, fetchModels, verifyApiKey, streamMessage } = await import(new URL('services/api/client.ts', sourceRoot))
const { toProviderApiError } = await import(new URL('services/api/http.ts', sourceRoot))
assert.equal(normalizeApiBaseUrl(' https://gateway.example.test/proxy/v1/// '), 'https://gateway.example.test/proxy/v1')
assert.equal(normalizeApiBaseUrl('http://127.0.0.1:8000/v1/'), 'http://127.0.0.1:8000/v1')
for (const invalid of ['', '/v1', 'not a URL', 'ftp://gateway.example.test', 'https://name:pass@gateway.example.test/v1', 'https://gateway.example.test/v1?key=secret', 'https://gateway.example.test/v1#part',
  'https://gateway.example.test/proxy%2fprivate/v1', 'https://gateway.example.test/proxy%5cprivate/v1',
  'https://gateway.example.test/proxy/%2e%2e/v1', 'https://gateway.example.test/proxy/%252e%252e/v1',
]) {
  assert.throws(() => normalizeApiBaseUrl(invalid), invalid)
}
for (const [base, path, expected] of [
  ['https://gateway.example.test', 'v1/models', 'https://gateway.example.test/v1/models'],
  ['https://gateway.example.test/v1', 'v1/models', 'https://gateway.example.test/v1/models'],
  ['https://gateway.example.test/proxy/v1/', 'v1/chat/completions', 'https://gateway.example.test/proxy/v1/chat/completions'],
  ['https://gateway.example.test/proxy/v1/chat/completions///', 'v1/models', 'https://gateway.example.test/proxy/v1/models'],
  ['https://gateway.example.test/proxy/v1/models', 'v1/chat/completions', 'https://gateway.example.test/proxy/v1/chat/completions'],
  ['https://gateway.example.test/proxy/models', 'v1/models', 'https://gateway.example.test/proxy/models/v1/models'],
  ['https://gateway.example.test/proxy', 'v1/models', 'https://gateway.example.test/proxy/v1/models'],
  ['https://gateway.example.test/api/v3', 'v1/models', 'https://gateway.example.test/api/v3/models'],
  ['https://gateway.example.test/api/v2/chat/completions', 'v1/models', 'https://gateway.example.test/api/v2/models'],
  ['https://gateway.example.test/v1beta/openai', 'v1/chat/completions', 'https://gateway.example.test/v1beta/openai/chat/completions'],
  ['https://gateway.example.test/proxy/chat/completions', 'v1/models', 'https://gateway.example.test/proxy/models'],
  ['https://gateway.example.test/chat/completions', 'v1/chat/completions', 'https://gateway.example.test/chat/completions'],
  ['https://gateway.example.test/chat/completions', 'v1/models', 'https://gateway.example.test/models'],
  ['https://gateway.example.test/proxy%20prefix/v3', 'v1/models', 'https://gateway.example.test/proxy%20prefix/v3/models'],
  ['https://api.deepseek.com', 'anthropic/v1/messages', 'https://api.deepseek.com/anthropic/v1/messages'],
  ['https://api.deepseek.com/v1', 'anthropic/v1/messages', 'https://api.deepseek.com/anthropic/v1/messages'],
  ['https://gateway.example.test/proxy/anthropic/v1', 'anthropic/v1/messages', 'https://gateway.example.test/proxy/anthropic/v1/messages'],
  ['https://gateway.example.test/proxy/anthropic/v1/messages', 'anthropic/v1/messages', 'https://gateway.example.test/proxy/anthropic/v1/messages'],
]) assert.equal(apiEndpoint(base, path), expected)
for (const input of ['https://gateway.example.test/proxy/chat/completions', 'https://gateway.example.test/chat/completions']) {
  assert.equal(apiEndpoint(normalizeApiBaseUrl(input), 'v1/models'), apiEndpoint(input, 'v1/models'), 'Saving an explicit endpoint retains its parent route')
}
assert.deepEqual(getApiConnection(), { baseUrl: configured.apiBaseUrl, protocol: 'openai' })
checks.push('Root and /v1 endpoints join once, copied request URLs are accepted, reverse-proxy prefixes remain intact and credential-bearing base URLs are rejected')

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
for (const response of [new Response('Not found', { status: 404 }), new Response('Not supported', { status: 405 })]) {
  responder = () => response
  await assert.rejects(fetchModels(configured.apiKey, configured.apiBaseUrl), error =>
    error instanceof ApiError && error.status === response.status && error.localMessage?.key === 'apiModelsUnsupported')
}
for (const response of [new Response('<html>wrong route</html>'), Response.json({ unexpected: [] }), Response.json({ data: [{ id: false }] })]) {
  responder = () => response
  await assert.rejects(fetchModels(configured.apiKey, configured.apiBaseUrl), error =>
    error instanceof ApiError && error.kind === 'protocol' && error.localMessage?.key === 'apiModelsInvalid')
}
const { useDiagnosticLog, diagnosticText } = await import(new URL('services/diagnostics/log.ts', sourceRoot))
responder = () => { throw new TypeError('raw failure containing https://gateway.example.test/proxy and fixture-private-key') }
await assert.rejects(fetchModels(configured.apiKey, configured.apiBaseUrl), error =>
  error instanceof ApiError && error.kind === 'network' && error.localMessage?.key === 'apiNetworkUnavailable')
assert.equal(diagnosticText().includes('fixture-private-key'), false)
assert.equal(diagnosticText().includes('gateway.example.test'), false)
assert.equal(useDiagnosticLog.getState().entries.slice(-1)[0].detail, 'network')
const providerErrors = [
  ['PROVIDER_DNS', 'apiProviderDns', 'network', 'dns'],
  ['PROVIDER_TIMEOUT', 'apiProviderTimeout', 'network', 'timeout'],
  ['PROVIDER_TLS', 'apiProviderTls', 'network', 'tls'],
  ['PROVIDER_CONNECT', 'apiProviderConnect', 'network', 'network'],
  ['PROVIDER_BUSY', 'apiProviderBusy', 'network', 'network'],
  ['PROVIDER_NETWORK', 'apiProviderNetwork', 'network', 'network'],
  ['PROVIDER_CLOSED', 'apiProviderNetwork', 'network', 'network'],
  ['PROVIDER_URL', 'apiProviderRequestUnsupported', 'protocol', 'protocol'],
]
let nativeFailureCode
const nativeRequestUrls = []
const nativeRequests = []
let nativeResponseChunks = []
globalThis.__DEEPSTAY_CAPACITOR__ = {
  platform: 'android',
  available: true,
  transport: {
    open: async request => {
      const { url } = request
      nativeRequestUrls.push(url)
      nativeRequests.push(request)
      if (nativeFailureCode) {
        throw Object.assign(new Error(`raw failure containing ${url} and ${configured.apiKey}`), { code: nativeFailureCode })
      }
      return { status: 200, contentType: request.accept }
    },
    read: async () => {
      const chunk = nativeResponseChunks.shift()
      return chunk === undefined ? {} : { data: Buffer.from(chunk).toString('base64') }
    },
    close: async () => {},
  },
}
for (const [code, key, kind, diagnostic] of providerErrors) {
  nativeFailureCode = code
  await assert.rejects(fetchModels(configured.apiKey, configured.apiBaseUrl), error =>
    error instanceof ApiError && error.kind === kind && error.localMessage?.key === key &&
    error.providerCode === code && !error.message.includes(configured.apiBaseUrl) && !error.message.includes(configured.apiKey))
  assert.equal(useDiagnosticLog.getState().entries.slice(-1)[0].detail, diagnostic)
}
assert.equal(nativeRequestUrls.length, providerErrors.length)
assert.equal(diagnosticText().includes(configured.apiBaseUrl), false)
assert.equal(diagnosticText().includes(configured.apiKey), false)
assert.equal(toProviderApiError({ code: 'UNRECOGNIZED', message: 'private detail' }), null)
checks.push('Android native DNS, TLS, timeout, busy, closed, URL and network failures become localized errors with sanitized diagnostics')

const androidHttpConnection = { baseUrl: 'http://gateway.example.test/proxy/v1', protocol: 'openai' }
const networkCallsBeforeHttp = networkCalls
const nativeCallsBeforeHttp = nativeRequestUrls.length
const androidHttpError = error => error instanceof ApiError && error.localMessage?.key === 'apiAndroidHttpsRequired'
await assert.rejects(fetchModels(configured.apiKey, androidHttpConnection.baseUrl), androidHttpError)
const androidChatBody = { model: configured.model, system: '', messages: [{ role: 'user', content: '你好' }], tools: [] }
await assert.rejects(streamMessage(configured.apiKey, androidChatBody, new AbortController().signal, androidHttpConnection).next(), androidHttpError)
assert.equal(networkCalls, networkCallsBeforeHttp)
assert.equal(nativeRequestUrls.length, nativeCallsBeforeHttp)
const localConnection = { baseUrl: 'http://127.0.0.1:8080/v1', protocol: 'openai' }
const localHttpsError = error => error instanceof ApiError && error.localMessage?.key === 'apiAndroidLocalHttpsRequired'
await assert.rejects(fetchModels(configured.apiKey, localConnection.baseUrl), localHttpsError)
await assert.rejects(streamMessage(configured.apiKey, androidChatBody, new AbortController().signal, localConnection).next(), localHttpsError)
assert.equal(networkCalls, networkCallsBeforeHttp)
assert.equal(nativeRequestUrls.length, nativeCallsBeforeHttp)
nativeFailureCode = 'PROVIDER_CONNECT'
await assert.rejects(fetchModels(configured.apiKey, 'https://127.0.0.1:8080/v1'), error =>
  error instanceof ApiError && error.localMessage?.key === 'apiLocalServiceUnavailable')
nativeFailureCode = 'PROVIDER_TLS'
await assert.rejects(fetchModels(configured.apiKey, 'https://localhost:8080/v1'), error =>
  error instanceof ApiError && error.localMessage?.key === 'apiProviderTls')
checks.push('Localhost errors explain the device-local address; HTTP preflight, unavailable local service and TLS failures stay distinct')
nativeFailureCode = 'PROVIDER_TIMEOUT'
await assert.rejects(streamMessage(configured.apiKey, androidChatBody, new AbortController().signal, {
  baseUrl: configured.apiBaseUrl,
  protocol: 'openai',
}).next(), error => error instanceof ApiError && error.localMessage?.key === 'apiProviderTimeout')
assert.equal(useDiagnosticLog.getState().entries.slice(-1)[0].operation, 'chat')
assert.equal(useDiagnosticLog.getState().entries.slice(-1)[0].detail, 'timeout')
nativeFailureCode = undefined
const { supportsAndroidProviderTransport } = await import(new URL('services/api/androidTransport.ts', sourceRoot))
for (const [baseUrl, expected] of [
  ['https://gateway.example.test/api/v3', 'https://gateway.example.test/api/v3/models'],
  ['https://gateway.example.test/v1beta/openai', 'https://gateway.example.test/v1beta/openai/models'],
  ['https://gateway.example.test/proxy/chat/completions', 'https://gateway.example.test/proxy/models'],
  ['https://gateway.example.test/chat/completions', 'https://gateway.example.test/models'],
  ['https://gateway.example.test/proxy%20prefix/v2', 'https://gateway.example.test/proxy%20prefix/v2/models'],
]) {
  assert.equal(supportsAndroidProviderTransport(expected), true)
  nativeResponseChunks = [JSON.stringify({ data: [{ id: configured.model }] })]
  assert.deepEqual(await fetchModels(configured.apiKey, normalizeApiBaseUrl(baseUrl)), [configured.model])
  assert.equal(nativeRequests[nativeRequests.length - 1].url, expected)
  nativeResponseChunks = [
    `data: ${JSON.stringify({ id: 'custom-route', choices: [{ delta: { content: '路径正确' }, finish_reason: 'stop' }] })}\n\n`,
    'data: [DONE]\n\n',
  ]
  const routeEvents = []
  for await (const event of streamMessage(configured.apiKey, androidChatBody, new AbortController().signal, {
    baseUrl: normalizeApiBaseUrl(baseUrl), protocol: 'openai',
  })) routeEvents.push(event)
  assert.equal(nativeRequests[nativeRequests.length - 1].url, expected.replace(/\/models$/, '/chat/completions'))
  assert.ok(routeEvents.some(event => event.type === 'content_block_delta' && event.delta.type === 'text_delta' && event.delta.text === '路径正确'))
}
for (const url of [
  'https://gateway.example.test/proxy%2fprivate/models',
  'https://gateway.example.test/proxy%5cprivate/models',
  'https://gateway.example.test/proxy/%2e%2e/models',
  'https://gateway.example.test/proxy/%252e%252e/models',
]) assert.equal(supportsAndroidProviderTransport(url), false)
checks.push('Android native model discovery and streaming chat preserve explicit endpoints, numeric-version and OpenAI bases, and encoded prefixes while rejecting encoded separators and traversal')
nativeResponseChunks = [JSON.stringify({ data: [{ id: configured.model }] })]
assert.deepEqual(await fetchModels(configured.apiKey, configured.apiBaseUrl), [configured.model])
assert.equal(nativeRequests[nativeRequests.length - 1].url, 'https://gateway.example.test/proxy/v1/models')
assert.equal(nativeRequests[nativeRequests.length - 1].authorization, `Bearer ${configured.apiKey}`)
nativeResponseChunks = [
  `data: ${JSON.stringify({ id: 'android-provider-chat', model: configured.model, choices: [{ index: 0, delta: { reasoning_content: '正在思考' }, finish_reason: null }] })}\n\n`,
  `data: ${JSON.stringify({ id: 'android-provider-chat', choices: [{ index: 0, delta: { content: '第三方接口已正常回复' }, finish_reason: 'stop' }] })}\n\n`,
  'data: [DONE]\n\n',
]
const androidChatEvents = []
for await (const event of streamMessage(configured.apiKey, androidChatBody, new AbortController().signal, {
  baseUrl: configured.apiBaseUrl,
  protocol: 'openai',
})) androidChatEvents.push(event)
assert.equal(nativeRequests[nativeRequests.length - 1].url, 'https://gateway.example.test/proxy/v1/chat/completions')
assert.equal(nativeRequests[nativeRequests.length - 1].authorization, `Bearer ${configured.apiKey}`)
assert.ok(androidChatEvents.some(event => event.type === 'content_block_delta' && event.delta.type === 'thinking_delta' && event.delta.thinking === '正在思考'))
assert.ok(androidChatEvents.some(event => event.type === 'content_block_delta' && event.delta.type === 'text_delta' && event.delta.text === '第三方接口已正常回复'))
globalThis.__DEEPSTAY_CAPACITOR__ = undefined
checks.push('Android rejects insecure API URLs before model discovery or chat; native HTTPS model loading and a full third-party reasoning/text stream both work, with timeout errors mapped consistently')
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
  await assert.rejects(timed, error => error instanceof ApiError && error.localMessage?.key === 'apiModelsTimeout')
  assert.equal(useDiagnosticLog.getState().entries.slice(-1)[0].detail, 'timeout')
  assert.equal(timers.size, 0)
  const entriesBeforeCancellation = useDiagnosticLog.getState().entries.length
  const caller = new AbortController()
  const pending = fetchModels(configured.apiKey, configured.apiBaseUrl, caller.signal)
  caller.abort()
  await assert.rejects(pending, error => error.name === 'AbortError')
  assert.equal(useDiagnosticLog.getState().entries.length, entriesBeforeCancellation)
  assert.equal(timers.size, 0)
} finally {
  globalThis.setTimeout = realSetTimeout
  globalThis.clearTimeout = realClearTimeout
}
checks.push('Model discovery distinguishes missing endpoints, invalid replies, offline/transport failures, caller cancellation and timeout; diagnostic events omit relay addresses, keys and raw exceptions')

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
const { describeReply } = await import(new URL('services/chat/describe.ts', sourceRoot))
const { getUsageTotal } = await import(new URL('services/api/usage.ts', sourceRoot))
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
  assert.deepEqual(requestBody.stream_options, { include_usage: true })
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
assert.equal(getUsageTotal(rendered.usage), 32)
assert.equal(requestBody.messages.some(message => message.content === '上一答'), true)
assert.equal(requestBody.messages.some(message => message.content === '用户补充的偏好'), true)
assert.equal(requestBody.messages[requestBody.messages.length - 1].content, '当前问题')
checks.push('Selected custom model and key reach only its OpenAI endpoint; chunked reasoning_content and content become complete existing reply blocks, preserve history and reminder text, consume trailing usage and finish once')

responder = (_url, init) => {
  const { thinking, stream_options } = JSON.parse(init.body)
  assert.equal(thinking.type, 'enabled')
  assert.equal(stream_options.include_usage, true)
  return streamedResponse([{ id: 'official-openai', choices: [{ delta: { content: '官方兼容响应' }, finish_reason: 'length' }] }, '[DONE]'])
}
const official = renderEvents(await collect(streamMessage('official-fixture-key', { ...body, model: 'deepseek-chat' }, new AbortController().signal, { baseUrl: 'https://api.deepseek.com', protocol: 'openai' })))
assert.equal(getReplyText(official), '官方兼容响应')
assert.equal(official.stopReason, 'max_tokens')
assert.equal(getUsageTotal(official.usage), undefined)

for (const [usage, expected, expectedCached] of [
  [{ total_tokens: 25 }, 25, undefined],
  [{ prompt_tokens: 20, prompt_tokens_details: { cached_tokens: 8 }, completion_tokens: 12 }, 32, 8],
  [{ prompt_tokens: 20, prompt_cache_hit_tokens: 8, completion_tokens: 12 }, 32, 8],
  [{ prompt_tokens: 20, prompt_tokens_details: { cached_tokens: 0 }, prompt_cache_hit_tokens: 8, completion_tokens: 12 }, 32, 8],
  [{ prompt_cache_hit_tokens: 8, prompt_cache_miss_tokens: 12, completion_tokens: 12 }, 32, 8],
  [{ prompt_tokens: 20, completion_tokens: 12 }, 32, undefined],
  [{ prompt_tokens: 20, prompt_tokens_details: { cached_tokens: 0 }, completion_tokens: 12 }, 32, 0],
  [{ prompt_tokens: 20, prompt_tokens_details: { cached_tokens: 21 }, completion_tokens: 12 }, 32, undefined],
  [{ prompt_tokens: 20, completion_tokens: -1, total_tokens: '32' }, undefined, undefined],
]) {
  responder = () => streamedResponse([
    { choices: [{ delta: { content: 'Token fixture' }, finish_reason: 'stop' }] },
    { choices: [], usage },
    '[DONE]',
  ])
  const reply = renderEvents(await collect(streamMessage(configured.apiKey, body, new AbortController().signal)))
  assert.equal(getUsageTotal(reply.usage), expected)
  assert.equal(reply.usage?.cache_read_input_tokens, expectedCached)
}
for (const frames of [
  [{ prompt_tokens: 20, prompt_cache_hit_tokens: 8 }, { prompt_tokens: 20, completion_tokens: 12 }],
  [{ prompt_tokens: 20 }, { prompt_tokens_details: { cached_tokens: 8 } }, { completion_tokens: 12 }],
]) {
  responder = () => streamedResponse([
    { choices: [{ delta: { content: '分帧统计' }, finish_reason: 'stop' }] },
    ...frames.map(usage => ({ choices: [], usage })),
    '[DONE]',
  ])
  const reply = renderEvents(await collect(streamMessage(configured.apiKey, body, new AbortController().signal)))
  assert.equal(getUsageTotal(reply.usage), 32)
  assert.equal(reply.usage.input_tokens, 12)
  assert.equal(reply.usage.cache_read_input_tokens, 8)
}
let rejectedUsageRequests = 0
responder = (_url, init) => {
  rejectedUsageRequests++
  const payload = JSON.parse(init.body)
  if (rejectedUsageRequests === 1) {
    assert.deepEqual(payload.stream_options, { include_usage: true })
    return new Response(JSON.stringify({ error: { message: "Unsupported parameter: 'stream_options'" } }), { status: 400 })
  }
  assert.equal('stream_options' in payload, false)
  return streamedResponse([{ choices: [{ delta: { content: '兼容服务正常回答' }, finish_reason: 'stop' }] }, '[DONE]'])
}
assert.equal(getReplyText(renderEvents(await collect(streamMessage(configured.apiKey, body, new AbortController().signal)))), '兼容服务正常回答')
assert.equal(rejectedUsageRequests, 2)
for (const [status, message] of [[400, 'Invalid messages content'], [401, 'Unsupported stream_options'], [500, 'Unsupported stream_options']]) {
  let attempts = 0
  responder = () => {
    attempts++
    return new Response(JSON.stringify({ error: { message } }), { status })
  }
  await assert.rejects(collect(streamMessage(configured.apiKey, body, new AbortController().signal)), error => error instanceof ApiError && error.status === status)
  assert.equal(attempts, 1)
}
let streamedUsageErrorAttempts = 0
responder = () => {
  streamedUsageErrorAttempts++
  return streamedResponse([
    { choices: [{ delta: { content: '已经生成正文' }, finish_reason: null }] },
    { error: { message: 'Unsupported stream_options' } },
  ])
}
await assert.rejects(collect(streamMessage(configured.apiKey, body, new AbortController().signal)))
assert.equal(streamedUsageErrorAttempts, 1)
checks.push('OpenAI usage is explicitly requested, merged before normalizing split cache counters, and optional usage fallback only follows an explicit pre-generation HTTP 400 parameter rejection')
assert.equal(getUsageTotal(applyEvent(rendered, { type: 'message_start', message: { id: 'continued', model: configured.model } }, 1200, new Map()).usage), undefined)

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
    { type: 'message_start', message: { id: 'deepseek-test', model: 'deepseek-v4-pro', usage: { input_tokens: 12, cache_read_input_tokens: 6, cache_creation_input_tokens: 2, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '原协议完整回答' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 12 } },
    { type: 'message_stop' },
  ])
}
const originalEvents = await collect(streamMessage('deepseek-fixture-key', { ...body, model: 'deepseek-v4-pro' }, new AbortController().signal, { baseUrl: 'https://api.deepseek.com/v1', protocol: 'deepseek' }))
const original = renderEvents(originalEvents)
assert.equal(getReplyText(original), '原协议完整回答')
assert.equal(original.stopReason, 'end_turn')
assert.equal(getUsageTotal(original.usage), 32)
assert.equal(getUsageTotal(renderEvents(originalEvents.filter(event => event.type !== 'message_delta')).usage), undefined)
checks.push('Existing DeepSeek Anthropic endpoint, x-api-key authentication, selected model and event-driven answer rendering continue to work')
checks.push('Reply token visibility defaults off and survives reload; both protocols count cached input once, omit partial or malformed usage, and clear previous usage on continuation')

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

let brokenInput
responder = () => new Response(new ReadableStream({ start(controller) { brokenInput = controller } }), { headers: { 'Content-Type': 'text/event-stream' } })
const brokenReply = streamMessage(configured.apiKey, body, new AbortController().signal)
const firstBrokenEvent = brokenReply.next()
await new Promise(resolve => realSetTimeout(resolve, 0))
brokenInput.enqueue(encoder.encode(asSse([{ choices: [{ delta: { content: '收到一部分' } }] }])))
const brokenEvents = [(await firstBrokenEvent).value, (await brokenReply.next()).value, (await brokenReply.next()).value]
brokenInput.error(new TypeError('raw provider transport error'))
await assert.rejects(brokenReply.next(), error => {
  assert.equal(error.kind, 'interrupted')
  assert.equal(error.localMessage?.key, 'replyInterrupted')
  const partial = renderEvents(brokenEvents)
  assert.equal(getReplyText(partial), '收到一部分')
  assert.equal(describeReply({ ...partial, status: 'error', error }).text, error.message)
  assert.equal(error.message.includes('raw provider transport error'), false)
  return true
})
assert.equal(useDiagnosticLog.getState().entries.slice(-1)[0].detail, 'stream')
checks.push('Transport failure during a stream preserves already received text and shows an actionable interruption message without exposing raw exception text')

const { getContextLengthError } = await import(new URL('services/api/errors.ts', sourceRoot))
const overflow = 'user input too long, 70668 tokens exceeds max 32768 tokens (request_id: fixture)'
const lengthCode = 'context_length_exceeded'
const lengthCases = [
  [deepseek, () => Response.json({ error: { message: overflow } }, { status: 400 }), { inputTokens: 70668, maxInputTokens: 32768 }],
  [deepseek, () => new Response(overflow, { status: 400 }), { inputTokens: 70668, maxInputTokens: 32768 }],
  [getApiConnection(), () => Response.json({ error: {
    message: "This model's maximum context length is 8,192 tokens. However, you requested 9,216 tokens.",
  } }, { status: 400 }), {}],
  [getApiConnection(), () => Response.json({ error: { code: lengthCode, message: 'Input rejected.' } }, { status: 400 }), {}],
  [getApiConnection(), () => Response.json({ error: { code: lengthCode, message: 'Input rejected.' } }), {}],
  [deepseek, () => new Response(namedFrame({ type: 'error', error: { code: lengthCode, message: 'Input rejected.' } }),
    { status: 400, headers: { 'Content-Type': 'text/event-stream' } }), {}],
  [getApiConnection(), () => new Response(asSse([{ error: { code: lengthCode, message: 'Input rejected.' } }]),
    { headers: { 'Content-Type': 'text/event-stream' } }), {}],
  [deepseek, () => Response.json({ error: { message: 'prompt is too long: 70668 tokens > 32768 maximum' } }, { status: 400 }), { inputTokens: 70668, maxInputTokens: 32768 }],
  [deepseek, () => Response.json({ error: { message: 'Unsupported image' } }, { status: 400 }), null],
  [getApiConnection(), () => Response.json({ error: { message: 'Request body is too large' } }, { status: 413 }), null],
  [getApiConnection(), () => Response.json({ error: { code: lengthCode, message: overflow } }, { status: 429 }), null],
]
for (const [connection, response, expected] of lengthCases) {
  responder = response
  await assert.rejects(collect(streamMessage(configured.apiKey, body, new AbortController().signal, connection)), error => {
    assert.deepEqual(getContextLengthError(error), expected)
    return true
  })
}
checks.push('Input limit classification preserves explicit provider budgets and recognizes structured context length errors while keeping unrelated HTTP failures distinct')

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
