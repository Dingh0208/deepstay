import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { registerHooks, stripTypeScriptTypes } from 'node:module'
import { fileURLToPath } from 'node:url'

const root = new URL('../src/', import.meta.url)
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL?.startsWith(root.href)) {
      const file = new URL(specifier.slice(0, -3) + '.ts', context.parentURL)
      if (existsSync(fileURLToPath(file))) return { url: file.href, shortCircuit: true }
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
globalThis.document = Object.assign(new EventTarget(), { visibilityState: 'visible' })
Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh-CN' }, configurable: true })
globalThis.__API_ORIGIN__ = 'https://api.deepseek.com'
globalThis.requestAnimationFrame = callback => setTimeout(callback, 0)
globalThis.cancelAnimationFrame = clearTimeout
const settings = await import(new URL('services/settings.ts', root))
const db = await import(new URL('services/chat/db.ts', root))
const store = await import(new URL('services/chat/store.ts', root))
const drafts = await import(new URL('services/chat/drafts.ts', root))
const { predictNextContext } = await import(new URL('services/chat/contextPrediction.ts', root))
const { getVisibleMessages } = await import(new URL('services/chat/branches.ts', root))
const history = Array.from({ length: 14 }, (_, index) => [
  { id: `u-${index}`, role: 'user', content: `第${index}次分享。${'日常生活'.repeat(100)}`, files: [], createdAt: 1_700_000_000_000 + index * 1000 },
  { id: `a-${index}`, role: 'assistant', prefix: false, model: 'fixture', status: 'done', stopReason: 'end_turn', blocks: [{ type: 'text', text: `第${index}次回答。${'一起倾听。'.repeat(250)}` }], createdAt: 1_700_000_000_001 + index * 1000 },
]).flat()
const wait = async predicate => {
  const deadline = Date.now() + 10000
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error('Compaction opt-out test timed out')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}
const idle = id => wait(() => !store.useChatStore.getState().streaming[id])
const open = async id => {
  store.selectSession(id)
  await wait(() => store.useChatStore.getState().sessionCache[id])
}
const send = async (id, text) => {
  drafts.setDraftText(id, text)
  assert.equal(store.sendMessage(id), true)
  await idle(id)
}
const isExtraction = ({ body }) => (body.system ?? body.messages[0]?.content ?? '').includes('你只负责整理已有聊天记录')
const includesText = (body, text) => body.messages.some(message => typeof message.content === 'string'
  ? message.content === text
  : message.content.some(block => block.type === 'text' && block.text === text))
const stream = (protocol, text) => {
  const events = protocol === 'openai' ? [
    { choices: [{ index: 0, delta: { content: text }, finish_reason: 'stop' }] },
  ] : [
    { type: 'message_start', message: { id: 'optout-fixture', model: 'fixture', usage: { input_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  ]
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + (protocol === 'openai' ? 'data: [DONE]\n\n' : ''), { headers: { 'content-type': 'text/event-stream' } })
}
const requests = [], progress = [], checks = []
let protocol = 'openai'
let respond = request => stream(protocol, isExtraction(request) ? JSON.stringify({ summary: '手动整理的历史与关系。', records: [] }) : '我在听。')
globalThis.fetch = async (url, init) => {
  const request = { url: String(url), init, body: JSON.parse(init.body) }
  requests.push(request)
  return respond(request)
}
const unsubscribe = store.useChatStore.subscribe(state => {
  for (const [id, value] of Object.entries(state.contextProgress)) progress.push({ id, ...value })
})
const routes = [
  { protocol: 'openai', baseUrl: 'https://optout-openai.example.test/v1' },
  { protocol: 'anthropic', baseUrl: 'https://optout-anthropic.example.test/anthropic' },
  { protocol: 'deepseek', baseUrl: 'https://api.deepseek.com' },
]
try {
  assert.equal(settings.useSettings.getState().contextMemoryEnabled, false)
  await store.initChat()
  for (const [index, route] of routes.entries()) {
    protocol = route.protocol
    settings.setApiConnection({ apiKey: 'synthetic-optout-key', apiBaseUrl: route.baseUrl, apiProtocol: protocol, model: 'fixture', models: ['fixture'] })
    settings.setGeneration({ contextTokens: 24_000 })
    settings.setContextMemoryEnabled(false)
    const id = `disabled-long-chat-${index}`
    const session = { id, title: id, createdAt: 1, updatedAt: 2, messages: structuredClone(history) }
    await db.saveSession(session)
    store.useChatStore.setState(state => ({ sessions: [...state.sessions, { id, title: id, createdAt: 1, updatedAt: 2 }] }))
    await open(id)
    const before = requests.length
    const predictionOptions = { session: store.useChatStore.getState().sessionCache[id], text: '好', files: [],
      system: store.SYSTEM_PROMPT, tools: [], model: 'fixture', thinking: false, connection: { baseUrl: route.baseUrl, protocol },
      inputBudget: 24_000, signal: new AbortController().signal }
    const fullPrediction = await predictNextContext(predictionOptions)
    assert.ok(fullPrediction.system + fullPrediction.messages > 24_000, 'Auto-off estimate must reflect the full outbound history')
    const fittedPrediction = await predictNextContext({ ...predictionOptions, automaticCompaction: true })
    assert.ok(fittedPrediction.system + fittedPrediction.messages <= 24_000)
    assert.equal(requests.length, before, 'Both estimates are local and never call the model')
    for (const text of ['好', '嗯', '继续']) {
      await send(id, text)
      const last = requests.at(-1)
      assert.equal(isExtraction(last), false)
      for (const message of history) {
        assert.ok(includesText(last.body, message.role === 'user' ? message.content : message.blocks[0].text),
          `${route.baseUrl}: auto-off must preserve every historical turn, even above the request budget`)
      }
    }
    const reply = getVisibleMessages(store.useChatStore.getState().sessionCache[id]).at(-1)
    store.regenerateReply(id, reply.id)
    await idle(id)
    assert.equal(requests.length - before, 4, 'Each send/regeneration makes only the main chat request')
    assert.ok(includesText(requests.at(-1).body, history[0].content))
    assert.equal((await db.loadMemorySnapshot(id)).segments.length, 0)
    assert.equal(progress.some(item => item.id === id), false)
    if (protocol === 'deepseek') {
      const continuationId = `${id}-continuation`
      const continuation = { id: continuationId, title: continuationId, createdAt: 1, updatedAt: 2, messages: [
        ...structuredClone(history),
        { id: 'prefix-question', role: 'user', content: '接着说', files: [], createdAt: 1_700_000_100_000 },
        { id: 'prefix-reply', role: 'assistant', model: 'fixture', thinking: false, status: 'done', stopReason: 'max_tokens', prefix: true, blocks: [{ type: 'text', text: '尚未说完的正文。' }], createdAt: 1_700_000_100_001 },
      ] }
      await db.saveSession(continuation)
      store.useChatStore.setState(state => ({ sessions: [...state.sessions, { id: continuationId, title: continuationId, createdAt: 1, updatedAt: 2 }] }))
      await open(continuationId)
      const beforeContinuation = requests.length
      store.continueReply(continuationId, 'prefix-reply')
      await idle(continuationId)
      assert.equal(requests.length - beforeContinuation, 1)
      assert.equal(isExtraction(requests.at(-1)), false)
      assert.ok(includesText(requests.at(-1).body, history[0].content))
      assert.ok(includesText(requests.at(-1).body, '尚未说完的正文。'))
      assert.equal(progress.some(item => item.id === continuationId), false)
    }
    const stored = await db.loadSession(id)
    for (const original of history) assert.ok(stored.messages.some(item => item.id === original.id))
    checks.push(`${route.baseUrl}: auto off retains the complete history on repeated send/regenerate (plus official continuation) and predicts its full size, with no compaction requests, writes or progress`)
  }

  protocol = 'openai'
  settings.setApiConnection({ apiKey: 'synthetic-optout-key', apiBaseUrl: routes[0].baseUrl, apiProtocol: protocol, model: 'fixture', models: ['fixture'] })
  const id = 'disabled-long-chat-0'
  await open(id)
  const beforeManual = requests.length
  assert.equal(await store.compactSession(id), 'saved')
  assert.equal(requests.length - beforeManual, 1)
  const checkpoint = await db.loadMemorySnapshot(id)
  const retainedFromId = checkpoint.segments.at(-1).checkpoint.retainedFromId
  const retainedFrom = checkpoint.session.messages.find(message => message.id === retainedFromId)
  assert.ok(retainedFrom)
  await send(id, '手动整理之后继续')
  assert.ok(!includesText(requests.at(-1).body, history[0].content), 'An explicitly saved manual checkpoint is still reused')
  settings.setGeneration({ contextTokens: 1024 })
  await send(id, '缩小窗口也不要继续自动整理')
  assert.ok(includesText(requests.at(-1).body, retainedFrom.content), 'Auto off must not move the saved retained-history boundary')
  assert.equal((await db.loadMemorySnapshot(id)).segments.length, checkpoint.segments.length)
  assert.ok(requests.slice(beforeManual + 1).every(request => !isExtraction(request)))
  checks.push('Manual compaction remains available while auto is off; future sends reuse only its saved boundary without silently shrinking more history')

  const beforeRejection = requests.length
  respond = () => Response.json({ error: { message: 'user input too long, 70668 tokens exceeds max 4096 tokens' } }, { status: 400 })
  await send(id, '遇到超限不要自动裁剪重试')
  assert.equal(requests.length - beforeRejection, 1, 'Auto off must not retry a smaller, silently truncated history')
  assert.ok(includesText(requests.at(-1).body, retainedFrom.content))
  const failed = getVisibleMessages(await db.loadSession(id)).at(-1)
  assert.equal(failed.status, 'error')
  assert.equal(failed.error.localMessage.key, 'replyContextLimitAutoDisabled')
  checks.push('Provider overflow with auto off makes one full request, preserves history and explicitly suggests manual compaction')

  settings.setGeneration({ contextTokens: 24_000 })
  settings.setContextMemoryEnabled(true)
  const autoId = 'disabled-long-chat-1'
  await open(autoId)
  let aborted = false
  respond = request => {
    assert.ok(isExtraction(request), 'A disabled in-flight extraction must not proceed to main chat')
    return new Promise((resolve, reject) => {
      request.init.signal.addEventListener('abort', () => { aborted = true; reject(new DOMException('Aborted', 'AbortError')) }, { once: true })
    })
  }
  drafts.setDraftText(autoId, '开始后关闭自动压缩')
  const beforeAbort = requests.length
  assert.equal(store.sendMessage(autoId), true)
  await wait(() => requests.length > beforeAbort)
  settings.setContextMemoryEnabled(false)
  await idle(autoId)
  assert.equal(aborted, true, 'Turning auto off immediately aborts the pending extraction request')
  assert.equal(requests.length - beforeAbort, 1)
  assert.equal((await db.loadMemorySnapshot(autoId)).segments.length, 0)
  assert.equal(store.useChatStore.getState().contextProgress[autoId], undefined)
  respond = () => stream(protocol, '已收到。')
  const beforeAfterAbort = requests.length
  await send(autoId, '关闭以后继续')
  assert.equal(requests.length - beforeAfterAbort, 1)
  assert.equal(isExtraction(requests.at(-1)), false)
  assert.ok(includesText(requests.at(-1).body, history[0].content))
  const cold = await import(new URL('services/settings.ts?optout-reload', root))
  assert.equal(cold.useSettings.getState().contextMemoryEnabled, false)
  checks.push('Switching auto off aborts the active extraction, clears progress, persists opt-out and permits a full-history next send')
  settings.setContextMemoryEnabled(true)
  store.newChat()
  let releaseChat
  respond = request => {
    assert.equal(isExtraction(request), false)
    return new Promise(resolve => { releaseChat = () => resolve(stream(protocol, '正常完成。')) })
  }
  drafts.setDraftText(null, '普通回复中关闭开关')
  assert.equal(store.sendMessage(null), true)
  const shortId = store.useChatStore.getState().activeId
  await wait(() => releaseChat)
  const chatSignal = requests.at(-1).init.signal
  settings.setContextMemoryEnabled(false)
  assert.equal(chatSignal.aborted, false, 'Turning off auto compression must not cancel a normal chat response')
  releaseChat()
  await idle(shortId)
  assert.equal((await db.loadSession(shortId)).messages.at(-1).status, 'done')
  checks.push('Disabling automatic compression does not abort an already-running normal chat response')
  console.log(JSON.stringify({ passed: true, checks, scope: 'Real chat store, API serialization, SSE and IndexedDB; synthetic conversations and mock network only.' }, null, 2))
} finally {
  unsubscribe()
  hooks.deregister()
}
