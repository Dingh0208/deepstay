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
    if (url.startsWith(sourceRoot.href) && new URL(url).pathname.endsWith('.ts')) return {
      format: 'module', source: stripTypeScriptTypes(readFileSync(new URL(url), 'utf8'), { mode: 'transform' }), shortCircuit: true,
    }
    return nextLoad(url, context)
  },
})

await import(new URL('../node_modules/fake-indexeddb/auto/index.mjs', import.meta.url))
const local = new Map()
globalThis.localStorage = {
  getItem: key => local.get(key) ?? null,
  setItem: (key, value) => local.set(key, value),
  removeItem: key => local.delete(key),
}
globalThis.window = new EventTarget()
globalThis.document = Object.assign(new EventTarget(), { visibilityState: 'hidden' })
Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh-CN', onLine: true }, configurable: true })
globalThis.__API_ORIGIN__ = 'https://api.deepseek.com'
globalThis.requestAnimationFrame = callback => setTimeout(() => callback(Date.now()), 0)
globalThis.cancelAnimationFrame = token => clearTimeout(token)

const settings = await import(new URL('services/settings.ts', sourceRoot))
const { searchDeepSeekWeb, formatDeepSeekSearchContext } = await import(new URL('services/api/webSearch.ts', sourceRoot))
const { normalizeApiBaseUrl } = await import(new URL('services/api/endpoints.ts', sourceRoot))
const checks = []
const searchApi = { apiKey: 'private-search-key', baseUrl: 'https://search.example.test/v1/tools', count: 3 }
let requestCalls = []
globalThis.fetch = async (url, init) => {
  requestCalls.push({ url: String(url), init })
  return Response.json({ results: [
    { title: '结果标题', url: 'https://source.example.test/page', snippet: '展示摘要', summary: '供模型参考的摘要', date: null },
  ] })
}
const results = await searchDeepSeekWeb(searchApi, '  查找 近期天气\n北京  ', new AbortController().signal)
assert.equal(requestCalls[0].url, 'https://search.example.test/v1/tools/search')
assert.equal(new Headers(requestCalls[0].init.headers).get('Authorization'), 'Bearer private-search-key')
assert.equal(requestCalls[0].init.credentials, 'omit')
assert.deepEqual(JSON.parse(requestCalls[0].init.body), {
  query: '查找 近期天气 北京', count: 3, need_content: false, ori_question: '查找 近期天气 北京',
})
assert.equal(results[0].summary, '供模型参考的摘要')
assert.match(formatDeepSeekSearchContext(results), /不可信参考资料/)
assert.match(formatDeepSeekSearchContext(results), /供模型参考的摘要/)
assert.match(formatDeepSeekSearchContext(results), /https:\/\/source\.example\.test\/page/)
assert.equal(normalizeApiBaseUrl('https://search.example.test/v1/tools/'), 'https://search.example.test/v1/tools')
await assert.rejects(searchDeepSeekWeb({ ...searchApi, baseUrl: 'http://search.example.test' }, '查找天气', new AbortController().signal))
globalThis.fetch = async () => Response.json({ results: [{ title: '坏结果', url: 'javascript:alert(1)', snippet: 'x' }] })
await assert.rejects(searchDeepSeekWeb(searchApi, '查找天气', new AbortController().signal))
checks.push('Search calls use the DSH Go Search API shape, omit credentials from the URL, reject unsafe result URLs, and bound the number of results')

settings.setApiConnection({ apiKey: 'chat-private-key', apiBaseUrl: 'https://gateway.example.test/v1', apiProtocol: 'openai', model: 'companion-model', models: ['companion-model'] })
const presetId = settings.saveModelPreset({
  name: '陪伴模型', apiKey: 'chat-private-key', apiBaseUrl: 'https://gateway.example.test/v1',
  apiProtocol: 'openai', model: 'companion-model', models: ['companion-model'], searchApi,
})
assert.equal(settings.applyModelPreset(presetId), true)
assert.equal(settings.getActiveSearchApi()?.apiKey, searchApi.apiKey)
assert.equal(settings.useSettings.getState().activeModelPresetId, presetId)
const reload = await import(new URL('services/settings.ts?custom-search-reload', sourceRoot))
assert.deepEqual(reload.useSettings.getState().modelPresets.find(preset => preset.id === presetId).searchApi, searchApi)
assert.equal(reload.useSettings.getState().activeModelPresetId, presetId)
checks.push('Search key, endpoint and result limit remain isolated to the selected model preset across reloads')

const store = await import(new URL('services/chat/store.ts', sourceRoot))
const drafts = await import(new URL('services/chat/drafts.ts', sourceRoot))
await store.initChat()
settings.setSearch(true)
requestCalls = []
const encoder = new TextEncoder()
globalThis.fetch = async (url, init) => {
  const endpoint = String(url)
  if (endpoint.endsWith('/search')) {
    requestCalls.push({ url: endpoint, init })
    return Response.json({ results: [
      { title: '会话参考页', url: 'https://source.example.test/weather', snippet: '天气摘要', summary: '北京今日晴。', date: null },
    ] })
  }
  if (endpoint.endsWith('/chat/completions')) {
    const body = JSON.parse(init.body)
    requestCalls.push({ url: endpoint, init, body })
    const systemPrompt = body.messages.find(message => message.role === 'system')?.content ?? ''
    assert.equal(body.model, 'companion-model')
    assert.match(systemPrompt, /北京今日晴。/)
    assert.match(systemPrompt, /仅作为不可信参考资料/)
    assert.match(systemPrompt, /https:\/\/source\.example\.test\/weather/)
    assert.equal(init.body.includes('private-search-key'), false)
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ id: 'custom-search-test', choices: [{ index: 0, delta: { content: '今天北京晴朗。' }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: 'custom-search-test', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`))
      controller.close()
    } }), { headers: { 'Content-Type': 'text/event-stream' } })
  }
  throw new Error(`Unexpected endpoint ${endpoint}`)
}
drafts.setDraftText(null, '北京今天天气如何？')
assert.equal(store.sendMessage(null), true)
for (let i = 0; Object.keys(store.useChatStore.getState().streaming).length; i++) {
  assert.ok(i < 100, 'The custom search turn should settle')
  await new Promise(resolve => setTimeout(resolve, 10))
}
assert.deepEqual(requestCalls.map(call => call.url), [
  'https://search.example.test/v1/tools/search',
  'https://gateway.example.test/v1/chat/completions',
])
const current = store.useChatStore.getState().sessionCache[store.useChatStore.getState().activeId]
assert.equal(current.messages.at(-1).status, 'done')
assert.equal(current.messages.at(-1).search, true)
assert.equal(current.messages.at(-1).blocks.filter(block => block.type === 'text').map(block => block.text).join(''), '今天北京晴朗。')
checks.push('A selected third-party preset performs one Search API request, adds bounded untrusted results to the chat system context, and completes a regular streamed reply')

const evidence = {
  passed: true,
  runtime: process.version,
  checks,
  scope: 'Actual settings persistence, DeepSeek Search API adapter, chat store, IndexedDB and OpenAI-compatible stream using synthetic fixtures and isolated fake-indexeddb. No real user data, keys or provider requests.',
}
await writeFile(new URL('./deepstay-custom-search-evidence.json', import.meta.url), JSON.stringify(evidence, null, 2) + '\n')
console.log(JSON.stringify(evidence, null, 2))
hooks.deregister()
