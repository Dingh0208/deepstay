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
    if (url.startsWith(root.href) && url.endsWith('.ts')) return { format: 'module', source: stripTypeScriptTypes(readFileSync(new URL(url), 'utf8'), { mode: 'transform' }), shortCircuit: true }
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
const db = await import(new URL('services/chat/db.ts', root))
const store = await import(new URL('services/chat/store.ts', root))
const drafts = await import(new URL('services/chat/drafts.ts', root))
const unbind = store.bindChatPersistence()
const rounds = Array.from({ length: 14 }, (_, index) => [
  { id: `u-${index}`, role: 'user', content: `第${index}次分享。${'日常生活'.repeat(100)}`, files: [], createdAt: 1_700_000_000_000 + index * 1000 },
  { id: `a-${index}`, role: 'assistant', prefix: false, model: 'fixture', status: 'done', stopReason: 'end_turn', blocks: [{ type: 'text', text: '一起倾听。'.repeat(250) }], createdAt: 1_700_000_000_001 + index * 1000 },
]).flat()
const session = id => ({ id, title: id, createdAt: 1, updatedAt: 1, messages: structuredClone(rounds), contextMemory: { fixed: `当前会话${id}` } })
const stream = text => new Response(`data: ${JSON.stringify({ id: 'lifecycle-fixture', choices: [{ index: 0, delta: { content: text }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
const extract = () => stream(JSON.stringify({ summary: '本段日常对话。', records: [] }))
const wait = async predicate => {
  const deadline = Date.now() + 10_000
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error('Memory lifecycle integration timed out')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}
const send = async id => {
  store.selectSession(id)
  await wait(() => store.useChatStore.getState().sessionCache[id])
  drafts.setDraftText(id, '请继续当前会话。')
  assert.equal(store.sendMessage(id), true)
}
const idle = id => wait(() => !store.useChatStore.getState().streaming[id])
const requests = []
let respond = () => extract()
globalThis.fetch = async (url, init) => {
  const request = { url: String(url), init, body: JSON.parse(init.body) }
  requests.push(request)
  return respond(request)
}
const isExtraction = request => request.body.messages[0].content.includes('你只负责整理已有聊天记录')
const checks = []
try {
  settings.setApiConnection({ apiKey: 'memory-lifecycle-fixture', apiBaseUrl: 'https://memory-lifecycle.example.test/v1', apiProtocol: 'openai', model: 'fixture', models: ['fixture'] })
  settings.setContextMemoryEnabled(true)
  for (const id of ['foreign-edit', 'foreign-disable', 'foreign-stop', 'foreign-delete-disable', 'foreign-delete-stop', 'background-during-extraction', 'disable-during-commit', 'stop-during-commit', 'initial-save-failure', 'delete-during-extraction', 'clear-during-extraction']) await db.saveSession(session(id))
  await store.initChat()

  respond = async request => {
    assert.ok(isExtraction(request), 'A rejected source snapshot must never send a main chat request')
    const foreign = await db.loadSession('foreign-edit')
    foreign.messages[0].content = '另一标签已更正的原始消息，不能被旧任务覆盖。'
    await db.saveSession(foreign)
    return extract()
  }
  await send('foreign-edit')
  await idle('foreign-edit')
  assert.equal((await db.loadSession('foreign-edit')).messages[0].content, '另一标签已更正的原始消息，不能被旧任务覆盖。')
  assert.equal(store.useChatStore.getState().sessionCache['foreign-edit'].messages[0].content, '另一标签已更正的原始消息，不能被旧任务覆盖。')
  assert.equal((await db.loadMemorySnapshot('foreign-edit')).segments.length, 0)
  checks.push('A competing source write rejects stale extraction without the final error save overwriting the other tab original text')

  for (const [id, remove, interrupt] of [
    ['foreign-disable', false, () => settings.setContextMemoryEnabled(false)],
    ['foreign-stop', false, () => store.stopReply('foreign-stop')],
    ['foreign-delete-disable', true, () => settings.setContextMemoryEnabled(false)],
    ['foreign-delete-stop', true, () => store.stopReply('foreign-delete-stop')],
  ]) {
    settings.setContextMemoryEnabled(true)
    respond = async request => {
      assert.ok(isExtraction(request), 'Invalidated memory preparation must not send a main chat request')
      if (remove) {
        await db.deleteSession(id)
      } else {
        const foreign = await db.loadSession(id)
        foreign.messages[0].content = '另一标签修改后停止整理，原文仍须保留。'
        await db.saveSession(foreign)
      }
      interrupt()
      return extract()
    }
    await send(id)
    await idle(id)
    const stored = await db.loadSession(id)
    const cached = store.useChatStore.getState().sessionCache[id]
    if (remove) {
      assert.equal(stored, undefined, 'A cancelled extraction must not resurrect a chat deleted by another tab')
      assert.equal(cached, undefined)
    } else {
      assert.equal(stored.messages[0].content, '另一标签修改后停止整理，原文仍须保留。')
      assert.equal(cached.messages[0].content, '另一标签修改后停止整理，原文仍须保留。')
      assert.equal((await db.loadMemorySnapshot(id)).segments.length, 0)
    }
  }
  checks.push('Stop and disabling compression preserve competing source edits and deletions instead of saving a stale cache')

  settings.setContextMemoryEnabled(true)
  let backgroundChatRequests = 0
  respond = request => {
    if (isExtraction(request)) {
      document.dispatchEvent(new Event('visibilitychange'))
      window.dispatchEvent(new Event('pagehide'))
      return extract()
    }
    backgroundChatRequests += 1
    return stream('后台恢复后正常回答。')
  }
  await send('background-during-extraction')
  await idle('background-during-extraction')
  assert.equal(backgroundChatRequests, 1)
  const background = await db.loadMemorySnapshot('background-during-extraction')
  assert.ok(background.segments.length > 0)
  assert.equal(background.session.messages.at(-1).status, 'done')
  assert.equal(background.session.messages.at(-1).blocks[0].text, '后台恢复后正常回答。')
  checks.push('Real visibilitychange and pagehide persistence hooks during extraction do not invalidate their own source snapshot or prevent the main answer')

  const nativeGet = IDBObjectStore.prototype.get
  const interruptCommit = action => {
    let armed = true
    IDBObjectStore.prototype.get = function (...args) {
      const request = nativeGet.apply(this, args)
      if (armed && this.name === 'memoryState' && this.transaction.mode === 'readwrite') {
        armed = false
        request.addEventListener('success', action, { once: true })
      }
      return request
    }
  }
  for (const [id, action] of [
    ['disable-during-commit', () => settings.setContextMemoryEnabled(false)],
    ['stop-during-commit', () => store.stopReply('stop-during-commit')],
  ]) {
    settings.setContextMemoryEnabled(true)
    const before = requests.length
    respond = request => {
      assert.ok(isExtraction(request), 'Cancelled memory preparation must never send a main chat request')
      interruptCommit(action)
      return extract()
    }
    try {
      await send(id)
      await idle(id)
    } finally { IDBObjectStore.prototype.get = nativeGet }
    assert.equal(requests.length - before, 1)
    const cancelled = await db.loadMemorySnapshot(id)
    assert.equal(cancelled.segments.length, 0, 'Invalidation during transaction reads must roll back all memory writes')
    assert.equal(cancelled.session.messages.at(-1).status, id.startsWith('stop') ? 'stopped' : 'error', 'Cancellation without a competing write must still persist the final reply status')
  }
  checks.push('Disabling compression or stopping while the commit transaction is reading prevents derived writes and the main request')

  settings.setContextMemoryEnabled(true)
  const nativePut = IDBObjectStore.prototype.put
  IDBObjectStore.prototype.put = function (...args) {
    if (this.name === 'sessions' && args[0]?.id === 'initial-save-failure') {
      throw new DOMException('Injected initial source save failure', 'QuotaExceededError')
    }
    return nativePut.apply(this, args)
  }
  respond = () => { throw new Error('A failed initial save must not send extraction or chat requests') }
  try {
    await send('initial-save-failure')
    await idle('initial-save-failure')
    await wait(() => store.useChatStore.getState().sessionSaveErrors['initial-save-failure'])
    assert.equal(store.useChatStore.getState().sessionCache['initial-save-failure'].messages.at(-2).content, '请继续当前会话。')
    assert.equal((await db.loadSession('initial-save-failure')).messages.length, rounds.length)
  } finally { IDBObjectStore.prototype.put = nativePut }
  store.retrySaveSessions()
  await wait(async () => (await db.loadSession('initial-save-failure')).messages.length === rounds.length + 2)
  await wait(() => !store.useChatStore.getState().sessionSaveErrors['initial-save-failure'])
  assert.equal((await db.loadSession('initial-save-failure')).messages.at(-1).status, 'error')
  checks.push('An initial save failure preserves the unsaved input and error state for the existing explicit save retry')

  settings.setContextMemoryEnabled(true)
  for (const [id, remove] of [
    ['delete-during-extraction', () => store.removeSession('delete-during-extraction')],
    ['clear-during-extraction', () => store.replaceHistory(async () => {})],
  ]) {
    let began
    const started = new Promise(resolve => { began = resolve })
    respond = request => {
      assert.ok(isExtraction(request))
      began()
      return new Promise((resolve, reject) => request.init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }))
    }
    await send(id)
    await started
    assert.notEqual(await remove(), false)
    await idle(id)
    assert.equal(await db.loadMemorySnapshot(id), undefined)
  }
  checks.push('Deleting and clearing while extraction is in flight stop the task, remove derived stores and do not resurrect chats')
  console.log(JSON.stringify({ passed: true, checks, scope: 'Real chat store, IndexedDB and network adapters with synthetic source writes and transaction-boundary invalidation. No real user data or upstream calls.' }, null, 2))
} finally { unbind(); hooks.deregister() }
