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
globalThis.document = Object.assign(new EventTarget(), { visibilityState: 'visible' })
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
assert.ok(store.useChatStore.getState().streaming[firstId])
assert.equal(requests.length, 0)
const visibleReasoning = []
const unsubscribeReasoning = store.useChatStore.subscribe((state) => {
  const reply = state.sessionCache[firstId]?.messages[1]
  if (state.streaming[firstId] && reply?.status === 'streaming') {
    visibleReasoning.push({
      thinking: reply.blocks.find(block => block.type === 'thinking')?.thinking,
      answer: reply.blocks.find(block => block.type === 'text')?.text,
    })
  }
})
// This change occurs before prepareFiles' awaited work settles. The first turn
// must remain a coherent URL/key/model snapshot; the next turn uses the new one.
settings.setApiConnection(changedB)
await waitIdle()
unsubscribeReasoning()
if (requests.length === 0) console.log(store.useChatStore.getState().sessionCache[firstId].messages[1])
assert.equal(requests.length, 1)
const first = store.useChatStore.getState().sessionCache[firstId]
assert.equal(first.messages[1].model, originalA.model)
assert.equal(first.messages[1].status, 'done')
assert.equal(first.messages[1].blocks.filter(block => block.type === 'text').map(block => block.text).join(''), '第一个供应商完整回答')
assert.ok(visibleReasoning.some(({ thinking, answer }) => thinking === '认真思考' && answer === undefined))
checks.push('A real sendMessage snapshots selected URL, key and model before async preparation; changing provider settings during that await never mixes old model with a new destination/key')
checks.push('The first send is accepted before network preparation and shows reasoning before the answer even when both stream fragments are already buffered')

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

// Cancel while the UI has accepted the input but the next task has not started preflight.
drafts.setDraftText(firstId, '立即停止')
assert.equal(store.sendMessage(firstId), true)
assert.equal(store.sendMessage(firstId), false)
store.stopReply(firstId)
await waitIdle()
assert.equal(requests.length, 2)
const stopped = await db.loadSession(firstId)
assert.equal(stopped.messages.at(-2).content, '立即停止')
assert.equal(stopped.messages.at(-1).status, 'stopped')
checks.push('An immediate stop prevents starting a request and preserves the accepted question')

const longId = 'long-deepseek-history'
const title = '长历史验收'
const rounds = 1200
const messages = Array.from({ length: rounds * 2 }, (_, index) => {
  const common = {
    id: String(index),
    createdAt: index,
    parentId: index > 0 ? String(index - 1) : null,
    selectedChildId: index + 1 < rounds * 2 ? String(index + 1) : undefined,
  }
  return index % 2
    ? { ...common, role: 'assistant', status: 'done', blocks: [{ type: 'text', text: '旧回答' }] }
    : {
        ...common,
        role: 'user',
        content: '旧问题',
        files: index === 0
          ? [{ id: 'image', serverId: 'fixture-image', name: 'example.png', size: 128, isImage: true, mimeType: 'image/png' }]
          : [],
      }
})
const summary = { id: longId, title, createdAt: 0, updatedAt: rounds * 2 }
await db.saveSession({ ...summary, messages, rootMessageId: '0' })
store.useChatStore.setState(state => ({ sessions: [...state.sessions, summary] }))
await store.openHistoryMatch(longId, null)
const originalRevision = (await db.loadMemorySnapshot(longId)).state.sourceRevision
settings.setApiConnection({
  apiKey: 'deepseek-fixture',
  apiBaseUrl: 'https://api.deepseek.com',
  apiProtocol: 'deepseek',
  model: 'deepseek-v4-pro',
  models: ['deepseek-v4-pro'],
})
const officialRequests = []
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body)
  officialRequests.push({ url: String(url), body })
  const frames = [
    { type: 'message_start', message: { id: 'fixture', model: body.model } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '新回答' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null } },
    { type: 'message_stop' },
  ]
  return new Response(frames.map(payload => `data: ${JSON.stringify(payload)}\n\n`).join(''),
    { headers: { 'Content-Type': 'text/event-stream' } })
}
drafts.setDraftText(longId, '续聊')
assert.equal(store.sendMessage(longId), true)
assert.equal(officialRequests.length, 0)
await waitIdle()
store.regenerateReply(longId)
await waitIdle()
assert.equal(officialRequests.length, 2)
for (const request of officialRequests) {
  assert.equal(request.url, 'https://api.deepseek.com/anthropic/v1/messages')
  assert.equal(request.body.messages.length, rounds * 2 + 2) // The latest reminder adds one message.
  assert.equal(request.body.messages[0].content[0].source.file_id, 'fixture-image')
  assert.equal(request.body.messages.at(-1).content, '续聊')
}
const longSaved = await db.loadMemorySnapshot(longId)
assert.equal(longSaved.state.sourceRevision - originalRevision, 4) // One acceptance and one completion save per turn.
assert.equal(longSaved.session.messages.length, rounds * 2 + 3) // The first reply and the regenerated version are retained.
checks.push('A 1200-turn official history keeps its attachment reference and full protocol context on send and regenerate, with one acceptance and one completion save each')

const evidence = { passed: true, runtime: process.version, checks,
  requests: requests.map(({ url, body }) => ({ url, model: body.model, messages: body.messages.length })),
  scope: 'Actual chat store, drafts, API clients, SSE, reply reducer and IndexedDB code using an isolated IndexedDB emulator and deterministic responses. No real keys, network or user records.' }
await writeFile(new URL('./deepstay-api-store-evidence.json', import.meta.url), JSON.stringify(evidence, null, 2) + '\n')
console.log(JSON.stringify(evidence, null, 2))
hooks.deregister()
