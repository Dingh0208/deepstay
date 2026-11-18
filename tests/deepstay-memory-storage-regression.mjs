import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { registerHooks, stripTypeScriptTypes } from 'node:module'
import { fileURLToPath } from 'node:url'

await import(new URL('../node_modules/fake-indexeddb/auto/index.mjs', import.meta.url))
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
    if (url.startsWith(src.href) && url.endsWith('.ts')) {
      return { format: 'module', source: stripTypeScriptTypes(readFileSync(new URL(url), 'utf8'), { mode: 'transform' }), shortCircuit: true }
    }
    return nextLoad(url, context)
  },
})
const session = id => ({
  id, title: id, createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000,
  contextMemory: { fixed: '旧固定记忆：称呼阿青。' },
  messages: [
    { id: id + '-u', role: 'user', content: '周五一起看海。', files: [], createdAt: 1_700_000_000_000 },
    { id: id + '-a', role: 'assistant', model: 'fixture', status: 'done', blocks: [{ type: 'text', text: '记得我们的约定。' }], stopReason: 'end_turn', prefix: false, createdAt: 1_700_000_000_001 },
  ],
})
const update = (sessionId, suffix = '1') => {
  const sources = [{ messageId: sessionId + '-u', fingerprint: 'fixture-fingerprint', start: 0, end: 8 }]
  return {
    records: [{ id: sessionId + '-record-' + suffix, sessionId, kind: 'event', actor: 'user', realm: 'roleplay', key: '看海约定', text: '周五一起看海。', sources, supersedes: [], extractedAt: 1, extractorVersion: 1 }],
    segments: [{ id: sessionId + '-segment-' + suffix, sessionId, sources, summary: '用户提到看海约定。', provider: 'fixture', model: 'fixture', createdAt: 1, extractorVersion: 1 }],
  }
}
const transactionDone = tx => new Promise((resolve, reject) => {
  tx.oncomplete = () => resolve()
  tx.onerror = () => reject(tx.error)
  tx.onabort = () => reject(tx.error)
})
const open = version => new Promise((resolve, reject) => {
  const request = version === undefined ? indexedDB.open('xuchat-guest') : indexedDB.open('xuchat-guest', version)
  request.onsuccess = () => resolve(request.result)
  request.onerror = () => reject(request.error)
  if (version === 12) request.onupgradeneeded = () => {
    for (const name of ['sessions', 'files', 'sessionsStaging', 'filesStaging']) request.result.createObjectStore(name, { keyPath: 'id' })
    request.result.createObjectStore('sessionSummaries', { keyPath: 'id' }).createIndex('fileIds', 'fileIds', { multiEntry: true })
  }
})
const counts = async () => {
  const connection = await open()
  try {
    return await Promise.all(['memoryRecords', 'memorySegments', 'memoryState'].map(name => new Promise((resolve, reject) => {
      const request = connection.transaction(name).objectStore(name).count()
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })))
  } finally { connection.close() }
}
const checks = []
try {
  const old = session('legacy-A')
  const previous = await open(12)
  const seed = previous.transaction(['sessions', 'sessionSummaries'], 'readwrite')
  const seeded = transactionDone(seed)
  seed.objectStore('sessions').put(old)
  seed.objectStore('sessionSummaries').put({ id: old.id, title: old.title, createdAt: old.createdAt, updatedAt: old.updatedAt, fileIds: [] })
  await seeded
  previous.close()

  const db = await import(new URL('services/chat/db.ts', src))
  const legacy = await db.loadMemorySnapshot(old.id)
  assert.deepEqual(legacy.session, old)
  assert.deepEqual(legacy.state, { sessionId: old.id, sourceRevision: 0, memoryRevision: 0 })
  assert.deepEqual(legacy.records, [])
  assert.deepEqual(legacy.segments, [])
  assert.equal(await db.loadMemorySnapshot('missing'), undefined)
  assert.deepEqual(await counts(), [0, 0, 0])
  checks.push('Version-12 messages and fixed memory survive the additive schema upgrade without eager migration; missing chats stay missing')

  const first = update(old.id)
  assert.equal(await db.commitMemoryUpdate(legacy.state, first), true)
  const saved = await db.loadMemorySnapshot(old.id)
  assert.deepEqual(saved.session, old)
  assert.deepEqual(saved.records, first.records)
  assert.deepEqual(saved.segments, first.segments)
  assert.equal(saved.state.memoryRevision, 1)
  assert.equal(await db.commitMemoryUpdate(legacy.state, update(old.id, 'stale')), false)
  assert.deepEqual(await db.loadMemorySnapshot(old.id), saved)
  assert.equal(await db.commitMemoryUpdate(saved.state, first), true)
  assert.deepEqual(await db.loadMemorySnapshot(old.id), saved)
  checks.push('A committed memory update is atomic and durable; stale derived versions are rejected and a repeated segment is reused without duplicate records or version changes')

  const changed = structuredClone(old)
  changed.messages[0].content = '更正约定：周六一起看海。'
  await db.saveSession(changed)
  const edited = await db.loadMemorySnapshot(old.id)
  assert.equal(edited.state.sourceRevision, saved.state.sourceRevision + 1)
  assert.equal(edited.state.memoryRevision, saved.state.memoryRevision)
  assert.equal(await db.commitMemoryUpdate(saved.state, update(old.id, 'late-edit')), false)
  await db.renameSession(old.id, 'Renamed A')
  const renamed = await db.loadMemorySnapshot(old.id)
  assert.equal(renamed.state.sourceRevision, edited.state.sourceRevision + 1)
  assert.equal(await db.commitMemoryUpdate(edited.state, update(old.id, 'late-rename')), false)
  const competing = await Promise.all([
    db.commitMemoryUpdate(renamed.state, update(old.id, 'parallel-1')),
    db.commitMemoryUpdate(renamed.state, update(old.id, 'parallel-2')),
  ])
  assert.deepEqual(competing, [true, false])
  checks.push('Every raw save and rename advances source revision in its write transaction; source edits and competing writers cannot admit an expired extraction')

  const beforeFailure = await db.loadMemorySnapshot(old.id)
  const put = IDBObjectStore.prototype.put
  IDBObjectStore.prototype.put = function (...args) {
    if (this.name === 'memoryState') throw new DOMException('Injected state write failure', 'QuotaExceededError')
    return put.apply(this, args)
  }
  try { await assert.rejects(db.saveSession({ ...changed, title: 'Must not persist' }), /Injected state write failure/) }
  finally { IDBObjectStore.prototype.put = put }
  assert.deepEqual(await db.loadMemorySnapshot(old.id), beforeFailure)
  const add = IDBObjectStore.prototype.add
  IDBObjectStore.prototype.add = function (...args) {
    if (this.name === 'memorySegments') throw new DOMException('Injected segment write failure', 'QuotaExceededError')
    return add.apply(this, args)
  }
  try { await assert.rejects(db.commitMemoryUpdate(beforeFailure.state, update(old.id, 'failed')), /Injected segment write failure/) }
  finally { IDBObjectStore.prototype.add = add }
  assert.deepEqual(await db.loadMemorySnapshot(old.id), beforeFailure)
  checks.push('Failed source-version and segment writes roll back messages, records, coverage and revisions together, preserving the previous committed memory')

  assert.equal(await db.commitMemoryUpdate(beforeFailure.state, update(old.id, 'pre-cancelled'), () => false), false)
  for (const method of ['get', 'add']) {
    const native = IDBObjectStore.prototype[method]
    let valid = true
    let armed = true
    IDBObjectStore.prototype[method] = function (...args) {
      const request = native.apply(this, args)
      if (armed && this.transaction.mode === 'readwrite' && this.name === (method === 'get' ? 'memoryState' : 'memoryRecords')) {
        armed = false
        request.addEventListener('success', () => { valid = false }, { once: true })
      }
      return request
    }
    try {
      assert.equal(await db.commitMemoryUpdate(beforeFailure.state, update(old.id, `cancel-${method}`), () => valid), false)
    } finally { IDBObjectStore.prototype[method] = native }
    assert.equal(armed, false)
    assert.deepEqual(await db.loadMemorySnapshot(old.id), beforeFailure)
  }
  checks.push('An invalidated task cannot commit before a transaction, during source reads, or after a record write; the entire derived update rolls back without an unhandled rejection')

  const other = session('B')
  await db.saveSession(other)
  const otherStart = await db.loadMemorySnapshot(other.id)
  await assert.rejects(db.commitMemoryUpdate(otherStart.state, first), /another session/)
  const collision = update(other.id)
  collision.records[0].id = first.records[0].id
  await assert.rejects(db.commitMemoryUpdate(otherStart.state, collision), /another session/)
  assert.deepEqual(await db.loadMemorySnapshot(other.id), otherStart)
  assert.equal(await db.commitMemoryUpdate(otherStart.state, update(other.id)), true)
  const otherSaved = await db.loadMemorySnapshot(other.id)
  const originalBeforeImport = await db.loadMemorySnapshot(old.id)
  await db.addStagingSession(session('archive-source'))
  const imported = await db.commitStaging()
  assert.equal(imported.length, 1)
  assert.notEqual(imported[0].id, 'archive-source')
  const importedMemory = await db.loadMemorySnapshot(imported[0].id)
  assert.deepEqual(importedMemory.state, { sessionId: imported[0].id, sourceRevision: 1, memoryRevision: 0 })
  assert.deepEqual(importedMemory.records, [])
  assert.deepEqual(importedMemory.segments, [])
  assert.deepEqual(await db.loadMemorySnapshot(old.id), originalBeforeImport)
  assert.deepEqual(await db.loadMemorySnapshot(other.id), otherSaved)
  await db.addStagingSession(session('archive-source'))
  const importedAgain = await db.commitStaging()
  assert.notEqual(importedAgain[0].id, imported[0].id)
  assert.deepEqual((await db.loadMemorySnapshot(importedAgain[0].id)).records, [])
  checks.push('Cross-session payloads and colliding record IDs cannot overwrite another chat; repeated additive imports get independent empty memory state and preserve all existing memory')

  const beforeImportFailure = await counts()
  const summariesBeforeFailure = await db.loadSessionSummaries()
  await db.addStagingSession(session('failed-import'))
  IDBObjectStore.prototype.put = function (...args) {
    if (this.name === 'memoryState') throw new DOMException('Injected import state failure', 'QuotaExceededError')
    return put.apply(this, args)
  }
  try { await assert.rejects(db.commitStaging(), /Injected import state failure/) }
  finally { IDBObjectStore.prototype.put = put }
  assert.deepEqual(await counts(), beforeImportFailure)
  assert.deepEqual(await db.loadSessionSummaries(), summariesBeforeFailure)
  assert.deepEqual(await db.loadMemorySnapshot(old.id), originalBeforeImport)
  await db.clearStaging()
  await db.deleteSession(old.id)
  assert.equal(await db.loadMemorySnapshot(old.id), undefined)
  assert.equal(await db.commitMemoryUpdate(originalBeforeImport.state, update(old.id, 'after-delete')), false)
  assert.deepEqual(await db.loadMemorySnapshot(other.id), otherSaved)
  assert.deepEqual(await counts(), [1, 1, 3])
  await db.commitStaging(true)
  assert.deepEqual(await counts(), [0, 0, 0])
  assert.deepEqual(await db.loadSessionSummaries(), [])
  assert.equal(await db.commitMemoryUpdate(otherSaved.state, update(other.id, 'after-clear')), false)
  checks.push('Import failure rolls back memory state with history; delete and explicit clear remove derived stores and refuse late writes without resurrecting chats')

  console.log(JSON.stringify({ passed: true, runtime: process.version, checks, scope: 'Actual IndexedDB schema upgrade, source revision, CAS memory commit, import, delete and clear with isolated fake-indexeddb. No real browser records, model calls or credentials.' }, null, 2))
} finally { hooks.deregister() }
