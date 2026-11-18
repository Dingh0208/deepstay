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
    if (url.startsWith(sourceRoot.href) && url.endsWith('.ts')) return {
      format: 'module', source: stripTypeScriptTypes(readFileSync(new URL(url), 'utf8'), { mode: 'transform' }), shortCircuit: true,
    }
    return nextLoad(url, context)
  },
})
await import(new URL('../node_modules/fake-indexeddb/auto/index.mjs', import.meta.url))
const saved = new Map()
globalThis.localStorage = { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value), removeItem: key => saved.delete(key) }
globalThis.window = new EventTarget()
globalThis.document = Object.assign(new EventTarget(), { visibilityState: 'hidden' })
Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh-CN' }, configurable: true })
globalThis.__API_ORIGIN__ = 'https://api.deepseek.com'
globalThis.requestAnimationFrame = callback => setTimeout(() => callback(Date.now()), 0)
globalThis.cancelAnimationFrame = token => clearTimeout(token)
const originalA = { apiKey: 'provider-a-fixture', apiBaseUrl: 'https://provider-a.example.test/v1', apiProtocol: 'openai', model: 'model-a-selected', models: ['model-a-selected'] }
const changedB = { apiKey: 'provider-b-fixture', apiBaseUrl: 'https://provider-b.example.test/v1', apiProtocol: 'openai', model: 'model-b-selected', models: ['model-b-selected'] }
const settings = await import(new URL('services/settings.ts', sourceRoot))
const store = await import(new URL('services/chat/store.ts', sourceRoot))
const drafts = await import(new URL('services/chat/drafts.ts', sourceRoot))
const db = await import(new URL('services/chat/db.ts', sourceRoot))
const checks = [], requests = []
const encoder = new TextEncoder()
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body)
  requests.push({ url: String(url), key: new Headers(init.headers).get('Authorization'), body })
  const expected = requests.length === 1 ? originalA : changedB
  assert.equal(url, `${expected.apiBaseUrl}/chat/completions`)
  assert.equal(new Headers(init.headers).get('Authorization'), `Bearer ${expected.apiKey}`)
  assert.equal(body.model, expected.model)
  const content = requests.length === 1 ? '第一个供应商完整回答' : '第二个供应商完整回答'
  return new Response(new ReadableStream({ start(controller) {
    controller.enqueue(encoder.encode(`data: ${JSON.stringify({ id: 'store-reply', model: body.model, choices: [{ index: 0, delta: { reasoning_content: '认真思考' }, finish_reason: null }] })}\n\n`))
    controller.enqueue(encoder.encode(`data: ${JSON.stringify({ id: 'store-reply', choices: [{ index: 0, delta: { content }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`))
    controller.close()
  } }), { headers: { 'Content-Type': 'text/event-stream' } })
}
const waitIdle = () => new Promise((resolve, reject) => {
  const timeout = setTimeout(() => { unsubscribe(); reject(new Error('Store request failed to settle')) }, 5000)
  const inspect = state => {
    if (Object.keys(state.streaming).length === 0) {
      clearTimeout(timeout)
      unsubscribe()
      resolve()
    }
  }
  const unsubscribe = store.useChatStore.subscribe(inspect)
  inspect(store.useChatStore.getState())
})
await store.initChat()
settings.setApiConnection(originalA)
settings.setThinking(true)
drafts.setDraftText(null, '第一条问题')
assert.equal(store.sendMessage(null), true)
const firstId = store.useChatStore.getState().activeId
// This change occurs before prepareFiles' awaited work settles. The first turn
// must remain a coherent URL/key/model snapshot; the next turn uses the new one.
settings.setApiConnection(changedB)
await waitIdle()
if (requests.length === 0) console.log(store.useChatStore.getState().sessionCache[firstId].messages[1])
assert.equal(requests.length, 1)
const first = store.useChatStore.getState().sessionCache[firstId]
assert.equal(first.messages[1].model, originalA.model)
assert.equal(first.messages[1].status, 'done')
assert.equal(first.messages[1].blocks.filter(block => block.type === 'text').map(block => block.text).join(''), '第一个供应商完整回答')
checks.push('A real sendMessage snapshots selected URL, key and model before async preparation; changing provider settings during that await never mixes old model with a new destination/key')

drafts.setDraftText(firstId, '继续对话')
assert.equal(store.sendMessage(firstId), true)
await waitIdle()
assert.equal(requests.length, 2)
assert.equal(requests[1].body.messages.some(message => message.content === '第一条问题'), true)
assert.equal(requests[1].body.messages.some(message => message.content === '第一个供应商完整回答'), true)
assert.equal(requests[1].body.messages[requests[1].body.messages.length - 1].content, '继续对话')
const second = store.useChatStore.getState().sessionCache[firstId]
assert.equal(second.messages[3].model, changedB.model)
assert.equal(second.messages[3].status, 'done')
assert.equal(second.messages[3].blocks.filter(block => block.type === 'thinking').map(block => block.thinking).join(''), '认真思考')
assert.equal(second.messages[3].blocks.filter(block => block.type === 'text').map(block => block.text).join(''), '第二个供应商完整回答')
const stored = await db.loadSession(firstId)
assert.equal(stored.messages.length, 4)
assert.equal(stored.messages[3].model, changedB.model)
checks.push('The next real turn uses the new selected provider/model, includes the full prior text history, renders thinking plus answer and persists both turns in IndexedDB')

const evidence = { passed: true, runtime: process.version, checks,
  requests: requests.map(({ url, body }) => ({ url, model: body.model, messages: body.messages.length })),
  scope: 'Actual chat store, drafts, API clients, SSE, reply reducer and IndexedDB code using an isolated IndexedDB emulator and deterministic responses. No real keys, network or user records.' }
await writeFile(new URL('./deepstay-api-store-evidence.json', import.meta.url), JSON.stringify(evidence, null, 2) + '\n')
console.log(JSON.stringify(evidence, null, 2))
hooks.deregister()
