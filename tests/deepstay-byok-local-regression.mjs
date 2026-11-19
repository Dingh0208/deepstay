import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { registerHooks, stripTypeScriptTypes } from 'node:module'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

// Reuse the existing test dependency; no browser data or production database is touched.
const sourceRoot = new URL('../src/', import.meta.url)
await import(new URL('../node_modules/fake-indexeddb/auto/index.mjs', import.meta.url))
const { openDB } = await import(new URL('../node_modules/idb/build/index.js', import.meta.url))
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL?.startsWith(sourceRoot.href)) {
      const candidate = new URL(specifier.slice(0, -3) + '.ts', context.parentURL)
      if (existsSync(fileURLToPath(candidate))) {
        return { url: candidate.href, shortCircuit: true }
      }
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

const local = new Map([['chat-demo:api-key', 'local-regression-fixture']])
globalThis.localStorage = { getItem: key => local.get(key) ?? null, setItem: (key, value) => local.set(key, value), removeItem: key => local.delete(key) }
globalThis.window = new EventTarget()
globalThis.document = Object.assign(new EventTarget(), { visibilityState: 'visible' })
Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh-CN' }, configurable: true })
globalThis.__API_ORIGIN__ = 'https://api.deepseek.com'
let networkRequests = 0
globalThis.fetch = async () => { networkRequests += 1; throw new Error('Local history must not access the network') }

const checks = []
const id = randomUUID()
const fileId = randomUUID()
const png = new Blob([Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])], { type: 'image/png' })
const session = {
  id, title: 'Existing guest history', createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000,
  messages: [
    { id: 'user', role: 'user', content: 'Existing local question', createdAt: 1_700_000_000_000,
      files: [{ id: fileId, serverId: null, name: 'fixture.png', size: png.size, isImage: true, mimeType: 'image/png' }] },
    { id: 'assistant', role: 'assistant', model: 'deepseek-flash', prefix: true, status: 'done',
      createdAt: 1_700_000_000_001, blocks: [{ type: 'text', text: 'Existing local answer' }], stopReason: 'end_turn' },
  ],
}

// Seed the exact previous version-12 layout, including the now-unused syncRecords store.
const legacy = await openDB('xuchat-guest', 12, { upgrade(database) {
  for (const name of ['sessions', 'files', 'sessionsStaging', 'filesStaging', 'syncRecords']) {
    database.createObjectStore(name, { keyPath: 'id' })
  }
  database.createObjectStore('sessionSummaries', { keyPath: 'id' }).createIndex('fileIds', 'fileIds', { multiEntry: true })
} })
await legacy.put('sessions', session)
await legacy.put('sessionSummaries', { id, title: session.title, createdAt: session.createdAt, updatedAt: session.updatedAt, fileIds: [fileId] })
await legacy.put('files', { id: fileId, blob: png })
await legacy.put('syncRecords', { id, revision: 3, localVersion: 2, dirty: false })
legacy.close()

try {
  const db = await import(new URL('services/chat/db.ts', sourceRoot))
  const store = await import(new URL('services/chat/store.ts', sourceRoot))
  const backup = await import(new URL('services/chat/backup.ts', sourceRoot))
  const settings = await import(new URL('services/settings.ts', sourceRoot))

  assert.deepEqual(await db.loadSession(id), session)
  assert.equal((await db.loadSessionSummaries())[0].id, id)
  assert.equal((await db.loadFile(fileId)).size, png.size)
  checks.push('Previous xuchat-guest version-12 sessions, summaries and attachment are readable')

  const addedId = randomUUID()
  await db.saveSession({ ...session, id: addedId, title: 'New local session' })
  await db.renameSession(id, 'Renamed locally')
  assert.equal((await db.loadSession(id)).title, 'Renamed locally')
  await db.deleteSession(addedId)
  assert.equal(await db.loadSession(addedId), undefined)
  assert.equal((await db.loadFile(fileId)).size, png.size)
  checks.push('Local save, rename and delete work; a shared attachment is retained')

  await store.initChat()
  assert.equal(store.useChatStore.getState().ready, true)
  assert.equal(store.useChatStore.getState().sessions.length, 1)
  const archive = await backup.exportHistory()
  assert.ok(archive.blob.size > 0)
  assert.equal((await archive.blob.text()).includes('local-regression-fixture'), false)
  checks.push('Actual exportHistory creates a ZIP without exporting the API Key')

  settings.addFavoriteMessages(id, ['user', 'assistant', 'user'])
  const savedFavorites = [{ sessionId: id, messageId: 'user' }, { sessionId: id, messageId: 'assistant' }]
  assert.deepEqual(settings.useSettings.getState().favoriteMessages, savedFavorites)
  const { useSettings: afterReload } = await import(new URL('services/settings.ts?favorite-reload', sourceRoot))
  assert.deepEqual(afterReload.getState().favoriteMessages, savedFavorites)
  checks.push('Multi-select favorites store distinct message references and survive module reload')

  const extra = await backup.importHistory(new File([archive.blob], archive.name, { type: 'application/zip' }))
  assert.equal(extra, 1)
  assert.deepEqual(settings.useSettings.getState().favoriteMessages, savedFavorites)
  const importedId = (await db.loadSessionSummaries()).find((summary) => summary.id !== id).id
  const importedMessage = (await db.loadSession(importedId)).messages[0]
  settings.addFavoriteMessages(importedId, [importedMessage.id])
  assert.equal(settings.useSettings.getState().favoriteMessages.length, 3)
  assert.equal(await store.removeSession(importedId), true)
  assert.deepEqual(settings.useSettings.getState().favoriteMessages, savedFavorites)
  settings.removeFavoriteMessages(id, ['assistant'])
  assert.deepEqual(settings.useSettings.getState().favoriteMessages, savedFavorites.slice(0, 1))
  assert.equal((await db.loadSession(id)).messages.length, 2)
  checks.push('Appending history preserves favorites; deleting a chat removes only its references; unfavoriting retains the original message')

  await backup.clearHistory()
  assert.equal((await db.loadSessionSummaries()).length, 0)
  assert.equal(await db.loadFile(fileId), undefined)
  assert.equal(settings.useSettings.getState().apiKey, 'local-regression-fixture')
  assert.deepEqual(settings.useSettings.getState().favoriteMessages, [])
  assert.equal(local.get('deepstay:favorite-messages'), undefined)
  checks.push('Actual clearHistory removes local sessions, attachments, and favorite references while preserving the API Key')

  const imported = await backup.importHistory(new File([archive.blob], archive.name, { type: 'application/zip' }))
  assert.equal(imported, 1)
  const restored = await db.loadSession((await db.loadSessionSummaries())[0].id)
  assert.equal(restored.title, 'Renamed locally')
  assert.equal(restored.messages[0].content, session.messages[0].content)
  assert.equal(restored.messages[1].blocks[0].text, session.messages[1].blocks[0].text)
  assert.equal((await db.loadFile(restored.messages[0].files[0].id)).size, png.size)
  checks.push('Actual importHistory restores the exported messages and image attachment')

  await assert.rejects(backup.importHistory(new File(['invalid archive'], 'invalid.zip')))
  assert.equal((await db.loadSessionSummaries()).length, 1)
  assert.equal(settings.useSettings.getState().apiKey, 'local-regression-fixture')
  checks.push('Invalid import preserves current history and API Key')

  assert.equal(networkRequests, 0)
  checks.push('Initialization, CRUD, export, clear and import issue zero network requests')
  const evidence = { passed: true, runtime: process.version, checks, networkRequests,
    scope: 'In-memory fake-indexeddb with actual TypeScript database/store/backup modules; no real account, API or browser data used' }
  await writeFile(new URL('./deepstay-byok-local-evidence.json', import.meta.url), JSON.stringify(evidence, null, 2) + '\n')
  console.log(JSON.stringify(evidence, null, 2))
} finally {
  hooks.deregister()
}
