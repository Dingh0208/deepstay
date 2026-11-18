import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { registerHooks, stripTypeScriptTypes } from 'node:module'
import { fileURLToPath } from 'node:url'
import { forceCloseDatabase } from 'fake-indexeddb'
import 'fake-indexeddb/auto'

const src = new URL('../src/', import.meta.url)
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.startsWith(src.href) && specifier.startsWith('.') && specifier.endsWith('.js')) {
      const candidate = new URL(specifier.slice(0, -3) + '.ts', context.parentURL)
      if (existsSync(fileURLToPath(candidate))) return { url: candidate.href, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url.startsWith(src.href) && new URL(url).pathname.endsWith('.ts')) {
      const source = readFileSync(new URL(url), 'utf8')
      return { format: 'module', source: stripTypeScriptTypes(source, { mode: 'transform' }), shortCircuit: true }
    }
    return nextLoad(url, context)
  },
})

const makeSession = (id, title) => ({
  id,
  title,
  createdAt: 1,
  updatedAt: 2,
  rootMessageId: 'message',
  messages: [{ id: 'message', role: 'user', createdAt: 1, content: title, files: [] }],
})
const open = () => new Promise((resolve, reject) => {
  const request = indexedDB.open('xuchat-guest')
  request.onsuccess = () => resolve(request.result)
  request.onerror = () => reject(request.error)
})
const complete = (tx) => new Promise((resolve, reject) => {
  tx.oncomplete = resolve
  tx.onabort = () => reject(tx.error)
})

let appConnection
const nativeOpen = IDBFactory.prototype.open
IDBFactory.prototype.open = function (...args) {
  const request = nativeOpen.apply(this, args)
  if (args[0] === 'xuchat-guest' && args[1] !== undefined) {
    request.addEventListener('success', () => { appConnection = request.result })
  }
  return request
}
const durable = []
const nativeTx = IDBDatabase.prototype.transaction
IDBDatabase.prototype.transaction = function (stores, mode, options) {
  const tx = nativeTx.call(this, stores, mode, options)
  if (mode === 'readwrite' && Array.isArray(stores) && stores.includes('sessions') &&
    (stores.includes('files') || stores.includes('sessionsStaging'))) {
    durable.push(tx.durability)
  }
  return tx
}

try {
  const db = await import(new URL('services/chat/db.ts', src))
  const regular = makeSession('regular', '普通会话')
  const archive = makeSession('zip-source', '导入记录')
  await db.saveSession(regular)
  await db.addStagingSession(archive)
  const [imported] = await db.commitStaging()
  const importedSnapshot = await db.loadSession(imported.id)
  assert.notEqual(imported.id, archive.id)

  // Simulate a browser/WebView unexpectedly closing the IndexedDB connection.
  const oldConnection = appConnection
  const closed = new Promise(resolve => oldConnection.addEventListener('close', resolve, { once: true }))
  forceCloseDatabase(oldConnection)
  await closed
  assert.equal((await db.loadSessionSummaries()).length, 2)
  assert.notEqual(appConnection, oldConnection)
  assert.deepEqual(await db.loadSession(regular.id), regular)
  assert.deepEqual(await db.loadSession(imported.id), importedSnapshot)
  assert.deepEqual(durable, ['strict', 'strict'])

  // The list can be rebuilt if a legacy or incomplete index lacks otherwise intact sessions.
  const raw = await open()
  try {
    const tx = raw.transaction('sessionSummaries', 'readwrite')
    const done = complete(tx)
    tx.objectStore('sessionSummaries').clear()
    await done
  } finally {
    raw.close()
  }
  assert.deepEqual(new Set((await db.loadSessionSummaries()).map(({ id }) => id)), new Set([regular.id, imported.id]))
  assert.deepEqual(await db.loadSession(regular.id), regular)
  assert.deepEqual(await db.loadSession(imported.id), importedSnapshot)
  const checked = await open()
  try {
    const tx = checked.transaction('sessionSummaries')
    const done = complete(tx)
    const indexCount = new Promise(resolve => {
      const request = tx.objectStore('sessionSummaries').count()
      request.onsuccess = () => resolve(request.result)
    })
    assert.equal(await indexCount, 2)
    await done
  } finally {
    checked.close()
  }
  console.log('Ordinary and imported sessions reopen after unexpected IndexedDB closure and survive a missing summary index')
} finally {
  IDBFactory.prototype.open = nativeOpen
  IDBDatabase.prototype.transaction = nativeTx
  hooks.deregister()
}
