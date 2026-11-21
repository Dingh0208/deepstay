import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { registerHooks, stripTypeScriptTypes } from 'node:module'
import { fileURLToPath } from 'node:url'

const root = new URL('../src/', import.meta.url)
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL?.startsWith(root.href)) {
      const candidate = new URL(specifier.slice(0, -3) + '.ts', context.parentURL)
      if (existsSync(fileURLToPath(candidate))) return { url: candidate.href, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url.startsWith(root.href) && url.endsWith('.ts')) return {
      format: 'module', source: stripTypeScriptTypes(readFileSync(new URL(url), 'utf8'), { mode: 'transform' }), shortCircuit: true,
    }
    return nextLoad(url, context)
  },
})
await import('fake-indexeddb/auto')
const saved = new Map()
globalThis.localStorage = { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value), removeItem: key => saved.delete(key) }
globalThis.window = new EventTarget()
globalThis.document = Object.assign(new EventTarget(), { visibilityState: 'hidden' })
Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh-CN' }, configurable: true })
globalThis.__API_ORIGIN__ = 'https://api.deepseek.com'
globalThis.requestAnimationFrame = callback => setTimeout(callback, 0)
globalThis.cancelAnimationFrame = clearTimeout

const settings = await import(new URL('services/settings.ts', root))
const store = await import(new URL('services/chat/store.ts', root))
const db = await import(new URL('services/chat/db.ts', root))
const drafts = await import(new URL('services/chat/drafts.ts', root))
const attachments = await import(new URL('services/attachments.ts', root))
const oldConfig = { apiKey: 'snapshot-old-fixture', apiBaseUrl: 'https://api.deepseek.com', apiProtocol: 'deepseek', model: 'deepseek-v4-pro', models: ['deepseek-v4-pro'] }
const nextConfig = { apiKey: 'snapshot-next-fixture', apiBaseUrl: 'https://next-fixture.example.test/v1', apiProtocol: 'openai', model: 'fixture-next-model', models: ['fixture-next-model'] }
const wait = async predicate => {
  const deadline = Date.now() + 10_000
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error('Attachment snapshot integration timed out')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}
const deepseekStream = text => new Response([
  { type: 'message_start', message: { id: 'attachment-snapshot', model: oldConfig.model } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
  { type: 'message_stop' },
].map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
const openaiStream = text => new Response(`data: ${JSON.stringify({ id: 'new-config', choices: [{ index: 0, delta: { content: text }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
const memory = JSON.stringify({ summary: '本段为日常分享。', records: [] })
const checks = []

try {
  settings.setApiConnection(oldConfig)
  settings.setGeneration({ contextTokens: 24_000 })
  settings.setContextMemoryEnabled(true)
  const image = { id: 'snapshot-local-image', serverId: null, name: '记忆图片.png', size: 8, isImage: true, mimeType: 'image/png' }
  const history = Array.from({ length: 14 }, (_, index) => [
    { id: `u-${index}`, role: 'user', content: `第${index}次分享。${'当天心情'.repeat(100)}`, files: index === 13 ? [image] : [], createdAt: 1_700_000_000_000 + index * 1000 },
    { id: `a-${index}`, role: 'assistant', prefix: true, model: oldConfig.model, status: 'done', stopReason: 'end_turn', blocks: [{ type: 'text', text: '我愿意耐心倾听。'.repeat(120) }], createdAt: 1_700_000_000_001 + index * 1000 },
  ]).flat()
  await db.saveSession({ id: 'attachment-memory', title: '附件记忆快照', createdAt: 1, updatedAt: 2, messages: history }, [{ id: image.id, blob: new Blob(['fixture!'], { type: image.mimeType }) }])
  await store.initChat()
  store.selectSession('attachment-memory')
  await wait(() => store.useChatStore.getState().sessionCache['attachment-memory'])
  const requests = []
  let switched = false
  globalThis.fetch = async (url, init) => {
    const body = init.body instanceof FormData ? null : JSON.parse(init.body)
    requests.push({ url: String(url), init, body })
    if (String(url).endsWith('/files')) return Response.json({ id: 'old-connection-file-id' })
    if ((body.system ?? '').includes('你只负责整理已有聊天记录')) {
      if (!switched) { switched = true; settings.setApiConnection(nextConfig) }
      return deepseekStream(memory)
    }
    if (String(url).startsWith(nextConfig.apiBaseUrl)) {
      const extraction = body.messages[0].content.includes('你只负责整理已有聊天记录')
      return openaiStream(extraction ? memory : '新配置下一轮回复。')
    }
    return deepseekStream('旧配置本轮回复。')
  }
  drafts.setDraftText('attachment-memory', '请继续这段对话。')
  assert.equal(store.sendMessage('attachment-memory'), true)
  await wait(() => !store.useChatStore.getState().streaming['attachment-memory'])
  assert.equal(switched, true)
  const uploads = requests.filter(request => request.url.endsWith('/files'))
  assert.equal(uploads.length, 1, 'The retained historical image must actually be uploaded')
  assert.equal(uploads[0].url, 'https://api.deepseek.com/anthropic/v1/files')
  for (const request of requests) {
    assert.ok(request.url.startsWith(oldConfig.apiBaseUrl), 'The in-flight turn must retain its original destination')
    assert.equal(new Headers(request.init.headers).get('x-api-key'), oldConfig.apiKey)
  }
  const oldMain = requests.find(request => request.body && !(request.body.system ?? '').includes('你只负责整理已有聊天记录'))
  assert.equal(oldMain.body.model, oldConfig.model)
  assert.ok(JSON.stringify(oldMain.body.messages).includes('old-connection-file-id'))
  assert.equal(store.useChatStore.getState().sessionCache['attachment-memory'].messages.at(-1).status, 'done')
  assert.equal((await db.loadSession('attachment-memory')).messages.find(message => message.id === 'u-13').files[0].serverId, 'old-connection-file-id')
  checks.push('Changing provider and key during long-history extraction cannot change the retained image upload or main chat destination/credentials/model')

  const before = requests.length
  drafts.setDraftText('attachment-memory', '现在再问下一轮。')
  assert.equal(store.sendMessage('attachment-memory'), true)
  await wait(() => !store.useChatStore.getState().streaming['attachment-memory'])
  const nextRequests = requests.slice(before)
  assert.ok(nextRequests.length > 0)
  for (const request of nextRequests) {
    assert.equal(request.url, 'https://next-fixture.example.test/v1/chat/completions')
    assert.equal(new Headers(request.init.headers).get('Authorization'), `Bearer ${nextConfig.apiKey}`)
    assert.equal(request.body.model, nextConfig.model)
    assert.ok(!JSON.stringify(request.body).includes('old-connection-file-id'))
  }
  checks.push('A later turn uses the newly selected text provider and omits old provider file references')

  settings.setApiConnection(oldConfig)
  const queued = []
  const releases = []
  globalThis.fetch = async (url, init) => {
    queued.push({ url: String(url), init })
    return new Promise(resolve => releases.push(() => resolve(Response.json({ id: `queue-file-${queued.length}` }))))
  }
  const tasks = Array.from({ length: 4 }, (_, index) => attachments.uploadAttachment(oldConfig.apiKey, `queue-image-${index}`, new Blob(['image']), `queue-${index}.png`, true))
  await wait(() => queued.length === 3)
  settings.setApiConnection(nextConfig)
  releases[0]()
  await wait(() => queued.length === 4)
  for (const release of releases.slice(1)) release()
  await Promise.all(tasks)
  assert.equal(queued.length, 4)
  for (const request of queued) {
    assert.equal(request.url, 'https://api.deepseek.com/anthropic/v1/files')
    assert.equal(new Headers(request.init.headers).get('x-api-key'), oldConfig.apiKey)
  }
  checks.push('Queued uploads retain the connection captured when queued instead of consulting new settings when a slot opens')
  console.log(JSON.stringify({ passed: true, checks, scope: 'Actual memory/store/attachment queue/API and IndexedDB modules with fixture credentials and mocked endpoints; no real account or model calls.' }, null, 2))
} finally { hooks.deregister() }
