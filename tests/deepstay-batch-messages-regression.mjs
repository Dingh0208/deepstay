import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { registerHooks, stripTypeScriptTypes } from 'node:module'
import { fileURLToPath } from 'node:url'
import 'fake-indexeddb/auto'

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
    if (url.startsWith(sourceRoot.href) && url.endsWith('.ts')) {
      return { format: 'module', source: stripTypeScriptTypes(readFileSync(new URL(url), 'utf8'), { mode: 'transform' }), shortCircuit: true }
    }
    return nextLoad(url, context)
  },
})

globalThis.__API_ORIGIN__ = 'https://api.deepseek.com'
const saved = new Map()
globalThis.localStorage = {
  getItem: key => saved.get(key) ?? null,
  setItem: (key, value) => saved.set(key, value),
  removeItem: key => saved.delete(key),
}
let requested = 0
globalThis.fetch = async () => { requested++; throw new Error('Expected local-only operations') }

try {
  const db = await import(new URL('services/chat/db.ts', sourceRoot))
  const store = await import(new URL('services/chat/store.ts', sourceRoot))
  const settings = await import(new URL('services/settings.ts', sourceRoot))
  const backup = await import(new URL('services/chat/backup.ts', sourceRoot))
  const { getVisibleMessages, selectVersion } = await import(new URL('services/chat/branches.ts', sourceRoot))
  const { toSessionFile } = await import(new URL('services/chat/history/toArchive.ts', sourceRoot))
  const { toLocalSession } = await import(new URL('services/chat/history/toLocal.ts', sourceRoot))
  const now = Date.now()
  const user = (id, parentId, selectedChildId) => ({
    id, role: 'user', parentId, selectedChildId, createdAt: now, files: [], content: id,
  })
  const assistant = (id, parentId, selectedChildId) => ({
    id, role: 'assistant', parentId, selectedChildId, createdAt: now, status: 'done', blocks: [{ type: 'text', text: id }],
  })
  const sessionId = 'batch-chat'
  const otherId = 'separate-chat'
  await db.saveSession({
    id: sessionId, createdAt: now, updatedAt: now, title: 'Branching history',
    rootMessageId: 'root',
    messages: [
      user('root', null, 'answer'),
      assistant('answer', 'root', 'second'),
      user('second', 'answer', 'second-answer'),
      assistant('second-answer', 'second', 'third'),
      user('third', 'second-answer', 'third-answer'),
      assistant('third-answer', 'third'),
      assistant('alternative', 'root', 'alternative-user'),
      user('alternative-user', 'alternative', 'alternative-answer'),
      assistant('alternative-answer', 'alternative-user', 'remaining-user'),
      user('remaining-user', 'alternative-answer', 'remaining-answer'),
      assistant('remaining-answer', 'remaining-user'),
    ],
  })
  await db.saveSession({
    id: otherId, createdAt: now, updatedAt: now - 1, title: 'Separate history',
    rootMessageId: 'root',
    messages: [user('root', null)],
  })
  await store.initChat()
  await store.openHistoryMatch(sessionId, null)
  assert.equal(store.useChatStore.getState().activeId, sessionId)
  settings.addFavoriteMessages(sessionId, ['root', 'third-answer'])
  settings.addFavoriteMessages(otherId, ['root'])
  const selected = ['root', 'second-answer', 'third', 'alternative-answer']
  assert.equal(await store.deleteMessages(sessionId, ['unknown']), false)
  const deleting = store.deleteMessages(sessionId, selected)
  assert.equal(await store.deleteMessages(sessionId, ['second']), false)
  assert.equal(await deleting, true)
  const after = await db.loadSession(sessionId)
  assert.deepEqual(after, store.useChatStore.getState().sessionCache[sessionId])
  assert.deepEqual(after.messages.map(({ id }) => id), [
    'answer', 'second', 'third-answer', 'alternative', 'alternative-user', 'remaining-user', 'remaining-answer',
  ])
  assert.deepEqual(getVisibleMessages(after).map(({ id }) => id), ['answer', 'second', 'third-answer'])
  assert.deepEqual(getVisibleMessages(selectVersion(after, 'alternative')).map(({ id }) => id), [
    'alternative', 'alternative-user', 'remaining-user', 'remaining-answer',
  ])
  assert.equal(after.messages.find(({ id }) => id === 'third-answer').questionDeleted, true)
  assert.deepEqual(settings.useSettings.getState().favoriteMessages, [
    { sessionId: otherId, messageId: 'root' }, { sessionId, messageId: 'third-answer' },
  ])

  const file = toSessionFile(after, () => null)
  assert.deepEqual(file.messages.filter(message => message.deepstay_relinked).map(({ id }) => id), [1, 3, 4, 6])
  assert.throws(
    () => toLocalSession({ ...file, messages: file.messages.map(({ deepstay_relinked, ...message }) => message) }),
    error => error.key === 'backupInvalidBranches'
  )
  assert.throws(
    () => toLocalSession({ ...file, messages: [{ ...file.messages[0], parent_id: 100 }, ...file.messages.slice(1)] }),
    error => error.key === 'backupInvalidBranches'
  )

  const archive = await backup.exportHistory()
  const { exportArchive } = await import(new URL('services/chat/history/exportArchive.ts', sourceRoot))
  archive.blob = await exportArchive(await Promise.all((await db.loadSessionSummaries()).map(async summary => ({ ...await db.loadSession(summary.id), id: summary.id + '-external', createdAt: summary.createdAt + 1 }))))
  assert.equal(await backup.importHistory(new File([archive.blob], archive.name)), 2)
  const importedId = store.useChatStore.getState().sessions.find(
    summary => summary.title === after.title && summary.id !== sessionId
  ).id
  const imported = await db.loadSession(importedId)
  const messageText = message => message.role === 'user' ? message.content : message.blocks[0].text
  const visibleText = session => getVisibleMessages(session).map(messageText)
  assert.deepEqual(visibleText(imported), ['answer', 'second', 'third-answer'])
  assert.equal(imported.messages.find(message => messageText(message) === 'third-answer').questionDeleted, true)
  const alternative = imported.messages.find(message => messageText(message) === 'alternative')
  assert.deepEqual(visibleText(selectVersion(imported, alternative.id)), [
    'alternative', 'alternative-user', 'remaining-user', 'remaining-answer',
  ])
  assert.equal(settings.useSettings.getState().favoriteMessages.length, 2)
  assert.equal((await db.loadSession(sessionId)).messages.length, 7)

  store.selectSession(sessionId)
  assert.equal(await store.deleteMessages(sessionId, after.messages.map(({ id }) => id)), true)
  assert.deepEqual((await db.loadSession(sessionId)).messages, [])
  assert.equal((await db.loadSession(sessionId)).rootMessageId, null)
  assert.deepEqual(settings.useSettings.getState().favoriteMessages, [{ sessionId: otherId, messageId: 'root' }])
  assert.equal(requested, 0)
  console.log('Passed exact multi-message deletion, branch persistence, favorite cleanup, and ZIP round trip')
} finally {
  hooks.deregister()
}
