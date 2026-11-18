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

const settings = await import(new URL('services/settings.ts', sourceRoot))
const store = await import(new URL('services/chat/store.ts', sourceRoot))
const drafts = await import(new URL('services/chat/drafts.ts', sourceRoot))
const db = await import(new URL('services/chat/db.ts', sourceRoot))
const file = { id: 'local-old-file', serverId: 'file-api-old-provider', name: '旧图片.png', size: 8, isImage: true, mimeType: 'image/png' }
const user = (id, content) => ({ id, role: 'user', content, files: [file], createdAt: 1 })
const reply = (id, text) => ({
  id, role: 'assistant', model: 'deepseek-flash', thinking: true, search: true,
  prefix: true, status: 'done', stopReason: 'end_turn', createdAt: 2,
  blocks: [
    { type: 'thinking', thinking: '旧的私人思考', signature: 'old-thinking-signature' },
    { type: 'server_tool_use', id: 'old-tool', name: 'deepseek_read_url', kind: 'read_link', input: { action: 'read_link', url: 'https://old-page.example.test' } },
    { type: 'web_fetch_tool_result', tool_use_id: 'old-tool', kind: 'read_link', signature: 'old-page-signature', content: { type: 'web_fetch_result', url: 'https://old-page.example.test', content: { type: 'document', source: { type: 'text', media_type: 'text/plain', data: '' }, title: '旧网页' }, published_at: null } },
    { type: 'text', text },
  ],
})
const original = { id: 'old-deepseek-session', title: '已有历史', createdAt: 1, updatedAt: 2,
  messages: [user('old-question', '解释这张图'), reply('old-answer', '图片原先的解释'), user('image-only-question', ''), reply('image-only-answer', '只有图片的解释')] }
await db.saveSession(original)
await store.initChat()
store.selectSession(original.id)
for (let i = 0; !store.useChatStore.getState().sessionCache[original.id]; i++) {
  assert.ok(i < 100, 'Stored history should become ready')
  await new Promise(resolve => setTimeout(resolve, 10))
}
settings.setApiConnection({ apiKey: 'custom-fixture', apiBaseUrl: 'https://custom.example.test/v1', apiProtocol: 'openai', model: 'custom-model', models: ['custom-model'] })
settings.setSearch(true)
settings.setThinking(true)
const requests = []
const encoder = new TextEncoder()
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body)
  requests.push({ url, body })
  assert.equal(url, 'https://custom.example.test/v1/chat/completions')
  assert.equal(new Headers(init.headers).get('Authorization'), 'Bearer custom-fixture')
  assert.equal(body.model, 'custom-model')
  assert.equal('tools' in body, false)
  assert.equal('title' in body, false)
  assert.equal('safety_check' in body, false)
  assert.equal(body.messages.some(message => message.content === '解释这张图'), true)
  assert.equal(body.messages.some(message => message.content === '图片原先的解释'), true)
  assert.equal(body.messages.some(message => message.content === '只有图片的解释'), false)
  for (const privateData of [file.serverId, 'old-thinking-signature', 'old-page-signature', '旧的私人思考', 'old-tool']) assert.equal(init.body.includes(privateData), false)
  return new Response(new ReadableStream({ start(controller) {
    controller.enqueue(encoder.encode(`data: ${JSON.stringify({ id: 'switch', choices: [{ index: 0, delta: { content: '新接口完整回复' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`))
    controller.close()
  } }), { headers: { 'Content-Type': 'text/event-stream' } })
}
drafts.setDraftText(original.id, '切换接口后继续提问')
assert.equal(store.sendMessage(original.id), true)
for (let i = 0; Object.keys(store.useChatStore.getState().streaming).length; i++) {
  assert.ok(i < 100, 'The provider switch reply should settle')
  await new Promise(resolve => setTimeout(resolve, 10))
}
assert.equal(requests.length, 1)
const current = store.useChatStore.getState().sessionCache[original.id]
const last = current.messages[current.messages.length - 1]
assert.equal(last.status, 'done')
assert.equal(last.model, 'custom-model')
assert.equal(last.search, false)
assert.equal(last.prefix, false)
assert.equal(last.blocks.filter(block => block.type === 'text').map(block => block.text).join(''), '新接口完整回复')
assert.deepEqual(current.messages.slice(0, original.messages.length).map(({ parentId, selectedChildId, ...message }) => message), original.messages)
const stored = await db.loadSession(original.id)
assert.equal(stored.messages.length, 6)
assert.equal(stored.messages[0].files[0].serverId, file.serverId)
const evidence = { passed: true, runtime: process.version, checks: [
  'Existing DeepSeek file, thinking and read-link history can continue with a selected custom OpenAI model without uploading old attachments or forwarding DeepSeek file IDs, signatures or tools',
  'Previous textual user/assistant context is retained; file-only turns that cannot be represented in a text connection are omitted together',
  'Original local history, attachment references and tool details remain intact; the new reply is rendered and saved with the selected model and text-only capabilities',
], scope: 'Actual chat store, IndexedDB persistence, request conversion, OpenAI transport and stream rendering using isolated fake IndexedDB and deterministic fetch. No real user records, credentials or upstream charges.' }
await writeFile(new URL('./deepstay-api-provider-switch-evidence.json', import.meta.url), JSON.stringify(evidence, null, 2) + '\n')
console.log(JSON.stringify(evidence, null, 2))
hooks.deregister()
