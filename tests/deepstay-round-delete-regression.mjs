import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { registerHooks, stripTypeScriptTypes } from 'node:module'
import { fileURLToPath } from 'node:url'
import 'fake-indexeddb/auto'

const root = new URL('../src/', import.meta.url)
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL?.startsWith(root.href)) {
      const url = new URL(specifier.slice(0, -3) + '.ts', context.parentURL)
      if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true }
    }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (url.startsWith(root.href) && url.endsWith('.ts')) {
      return { format: 'module', source: stripTypeScriptTypes(readFileSync(new URL(url), 'utf8'), { mode: 'transform' }), shortCircuit: true }
    }
    return next(url, context)
  },
})
globalThis.__API_ORIGIN__ = 'https://api.deepseek.com'
const saved = new Map()
globalThis.localStorage = {
  getItem: key => saved.get(key) ?? null,
  setItem: (key, value) => saved.set(key, value),
  removeItem: key => saved.delete(key),
}
let requests = 0
globalThis.fetch = async () => { requests++; throw new Error('No model request expected') }
try {
  const db = await import(new URL('services/chat/db.ts', root))
  const store = await import(new URL('services/chat/store.ts', root))
  const settings = await import(new URL('services/settings.ts', root))
  const branches = await import(new URL('services/chat/branches.ts', root))
  const user = (id, parentId, selectedChildId) => ({ id, role: 'user', parentId, selectedChildId, createdAt: 1, files: [], content: id })
  const answer = (id, parentId, selectedChildId) => ({ id, role: 'assistant', parentId, selectedChildId, createdAt: 2, status: 'done', blocks: [{ type: 'text', text: id }] })
  const session = {
    id: 'rounds', title: 'Synthetic turns', createdAt: 1, updatedAt: 2, rootMessageId: 'q1',
    messages: [
      user('q1', null, 'a1'), answer('a1', 'q1', 'q2'),
      user('q2', 'a1', 'a2'), answer('a2', 'q2', 'q3'),
      user('q3', 'a2', 'a3'), answer('a3', 'q3'),
      answer('a2-alt', 'q2', 'q3-alt'), user('q3-alt', 'a2-alt', 'a3-alt'), answer('a3-alt', 'q3-alt'),
      user('q2-edited', 'a1', 'a2-edited'), answer('a2-edited', 'q2-edited'),
    ],
  }
  assert.deepEqual(branches.getRoundMessageIds(session, 'a2-alt'), ['q2', 'a2', 'a2-alt'])
  assert.deepEqual(branches.getRoundMessageIds(session, 'q2'), ['q2', 'a2', 'a2-alt'])
  assert.deepEqual(branches.getRoundMessageIds(session, 'unknown'), [])
  const legacy = { id: 'legacy', messages: [user('u'), answer('a'), user('next'), answer('next-a')] }
  assert.deepEqual(branches.getRoundMessageIds(legacy, 'a'), ['u', 'a'])
  const orphan = { ...session, messages: session.messages.map(m => m.id === 'a2' ? { ...m, questionDeleted: true } : m) }
  assert.deepEqual(branches.getRoundMessageIds(orphan, 'a2'), ['a2'])
  assert.deepEqual(branches.getRoundMessageIds(orphan, 'q2'), ['q2', 'a2-alt'])
  await db.saveSession(session)
  await store.initChat()
  await store.openHistoryMatch(session.id, null)
  settings.addFavoriteMessages(session.id, ['q2', 'a2', 'a2-alt', 'q3', 'a2-edited'])
  const controller = new AbortController()
  store.useChatStore.setState({ streaming: { [session.id]: controller } })
  assert.equal(await store.deleteMessageRound(session.id, 'a2'), false, 'Generation must block turn deletion')
  assert.deepEqual((await db.loadSession(session.id)).messages, session.messages)
  store.useChatStore.setState({ streaming: {} })
  assert.equal(await store.deleteMessageRound(session.id, 'unknown'), false)
  const deleting = store.deleteMessageRound(session.id, 'a2')
  assert.equal(await store.deleteMessageRound(session.id, 'q3'), false, 'Concurrent turn deletions must not race')
  assert.equal(await deleting, true)
  const actual = await db.loadSession(session.id)
  assert.deepEqual(actual.messages.map(m => m.id), ['q1','a1','q3','a3','q3-alt','a3-alt','q2-edited','a2-edited'])
  assert.deepEqual(branches.getVisibleMessages(actual).map(m => m.id), ['q1','a1','q3','a3'])
  assert.deepEqual(branches.getVisibleMessages(branches.selectVersion(actual, 'q3-alt')).map(m => m.id), ['q1','a1','q3-alt','a3-alt'])
  assert.deepEqual(branches.getVisibleMessages(branches.selectVersion(actual, 'q2-edited')).map(m => m.id), ['q1','a1','q2-edited','a2-edited'])
  assert.deepEqual(store.useChatStore.getState().sessionCache[session.id], actual)
  assert.deepEqual(settings.useSettings.getState().favoriteMessages.map(m => m.messageId), ['q3', 'a2-edited'])
  assert.equal(actual.messages.some(m => m.questionDeleted), false, 'Preserved next turns keep their own original question')
  store.useChatStore.setState({ sessionCache: {} })
  await store.openHistoryMatch(session.id, null)
  assert.deepEqual(store.useChatStore.getState().sessionCache[session.id], actual, 'Reopen reads the same persisted turn deletion')
  assert.equal(await store.deleteMessageRound(session.id, 'q1'), true)
  assert.deepEqual(branches.getVisibleMessages(await db.loadSession(session.id)).map(m => m.id), ['q3','a3'])
  assert.equal(await store.deleteMessageRound(session.id, 'a3'), true)
  const remaining = await db.loadSession(session.id)
  assert.deepEqual(branches.getVisibleMessages(remaining).map(m => m.id), ['q3-alt','a3-alt'])
  assert.equal(requests, 0)
  console.log('Turn deletion passed: question/reply versions, preserved later and edited branches, streaming/concurrency guards, favorite cleanup and reopen persistence')
} finally {
  hooks.deregister()
}
