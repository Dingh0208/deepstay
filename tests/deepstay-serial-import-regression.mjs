import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { registerHooks, stripTypeScriptTypes } from 'node:module'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

const src = new URL('../src/', import.meta.url)
await import(new URL('../node_modules/fake-indexeddb/auto/index.mjs', import.meta.url))
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
      let source = readFileSync(new URL(url), 'utf8')
      return { format: 'module', source: stripTypeScriptTypes(source, { mode: 'transform' }), shortCircuit: true }
    }
    return nextLoad(url, context)
  },
})
const saved = new Map([['chat-demo:api-key', 'serial-import-fixture']])
globalThis.localStorage = { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value), removeItem: key => saved.delete(key) }
globalThis.__API_ORIGIN__ = 'https://api.deepseek.com'
globalThis.window = new EventTarget()
globalThis.document = Object.assign(new EventTarget(), { visibilityState: 'visible' })
Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh-CN' }, configurable: true })
globalThis.requestAnimationFrame = callback => setTimeout(callback, 0)
globalThis.cancelAnimationFrame = clearTimeout
const wait = async (predicate, label) => {
  const deadline = Date.now() + 8000
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error('Timed out: ' + label)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}
const session = (index, title = 'Imported ' + index) => ({
  id: randomUUID(), title, createdAt: 1_700_000_000_000 + index, updatedAt: 1_700_000_000_000 + index,
  messages: [
    { id: 'question-' + index, role: 'user', content: 'Question ' + index, files: [], createdAt: 1_700_000_000_000 + index },
    { id: 'reply-' + index, role: 'assistant', status: 'done', model: 'fixture', createdAt: 1_700_000_000_001 + index, blocks: [{ type: 'text', text: 'Answer ' + index }], stopReason: 'end_turn', prefix: false },
  ],
})
const checks = []
try {
  const db = await import(new URL('services/chat/db.ts', src))
  const store = await import(new URL('services/chat/store.ts', src))
  const backup = await import(new URL('services/chat/backup.ts', src))
  const { exportArchive } = await import(new URL('services/chat/history/exportArchive.ts', src))
  const { setDraftText, getDraft } = await import(new URL('services/chat/drafts.ts', src))
  const stagingCounts = async () => {
    const connection = await new Promise((resolve, reject) => {
      const request = indexedDB.open('xuchat-guest')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    try {
      return await Promise.all(['sessionsStaging', 'filesStaging'].map(name => new Promise((resolve, reject) => {
        const request = connection.transaction(name, 'readonly').objectStore(name).count()
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })))
    } finally { connection.close() }
  }
  const snapshot = async () => Promise.all((await db.loadSessionSummaries()).map(item => db.loadSession(item.id)))
  const old = session(1, 'Current history')
  old.contextMemory = { fixed: '角色：A，仅属于现有会话。' }
  await db.saveSession(old)
  await store.initChat()
  store.selectSession(old.id)
  await wait(() => store.useChatStore.getState().sessionCache[old.id], 'current session load')
  setDraftText(old.id, '本地草稿，导入后仍然保留')
  const imported = Array.from({ length: 70 }, (_, index) => session(10 + index))
  const archive = new File([await exportArchive(imported)], 'serial-history.zip', { type: 'application/zip' })
  const before = await snapshot()
  const progress = []
  assert.equal(await backup.importHistory(archive, value => progress.push(value)), 70)
  assert.equal(progress[0], 0)
  assert.equal(progress.at(-1), 100)
  assert.ok(progress.includes(97))
  assert.ok(progress.every((value, index) => value >= 0 && value <= 100 && (!index || value > progress[index - 1])))
  assert.deepEqual(await db.loadSession(old.id), before[0])
  assert.equal(getDraft(old.id).text, '本地草稿，导入后仍然保留')
  const current = store.useChatStore.getState()
  assert.equal(current.sessions.length, before.length + 70)
  assert.ok(current.sessionCache[current.activeId], 'Import waits until the selected chat is loaded')
  const firstId = current.activeId
  assert.notEqual(firstId, imported.at(-1).id)
  assert.deepEqual(await stagingCounts(), [0, 0])
  checks.push('Serial import adds 70 chats across staging batches, preserves all original history and drafts, waits for selected details, and reports monotonic real progress ending at 100 only after save')

  store.setSessionContextMemory(firstId, '角色：B，与会话A不同。')
  await wait(async () => (await db.loadSession(firstId)).contextMemory?.fixed.includes('角色：B'), 'session B memory save')
  store.useChatStore.setState({ sessionCache: {} })
  store.selectSession(old.id)
  await wait(() => store.useChatStore.getState().sessionCache[old.id], 'cold memory A')
  store.selectSession(firstId)
  await wait(() => store.useChatStore.getState().sessionCache[firstId], 'cold memory B')
  assert.equal(store.useChatStore.getState().sessionCache[old.id].contextMemory.fixed, old.contextMemory.fixed)
  assert.equal(store.useChatStore.getState().sessionCache[firstId].contextMemory.fixed, '角色：B，与会话A不同。')
  checks.push('Different pinned memories persist separately per chat and reload independently after cache eviction')

  // Hold the first actual file read to prove the second queued job cannot touch staging yet.
  let releaseRead
  const held = new Promise(resolve => { releaseRead = resolve })
  let firstRead = false
  class HeldFile extends File {
    slice(...args) {
      const blob = super.slice(...args)
      if (!firstRead) {
        firstRead = true
        const arrayBuffer = blob.arrayBuffer.bind(blob)
        blob.arrayBuffer = async () => { await held; return arrayBuffer() }
      }
      return blob
    }
  }
  const queueEvents = []
  const first = backup.importHistory(new HeldFile([archive], 'held.zip'), value => queueEvents.push(['first', value]))
  const second = backup.importHistory(archive, value => queueEvents.push(['second', value]))
  await wait(() => firstRead, 'held file read')
  assert.deepEqual(queueEvents, [['first', 0]])
  releaseRead()
  assert.deepEqual(await Promise.all([first, second]), [0, 0])
  const secondStart = queueEvents.findIndex(item => item[0] === 'second')
  assert.deepEqual(queueEvents[secondStart - 1], ['first', 100])
  assert.equal((await db.loadSessionSummaries()).length, before.length + 70)
  assert.deepEqual(await db.loadSession(old.id), before[0])
  checks.push('Concurrent import calls run strictly in queue order; repeated source IDs are skipped without creating duplicates or overwriting any local chat')

  const afterSuccess = await snapshot()
  const add = IDBObjectStore.prototype.add
  const failedProgress = []
  IDBObjectStore.prototype.add = function (...args) {
    if (this.name === 'sessions') throw new DOMException('Injected transaction failure', 'QuotaExceededError')
    return add.apply(this, args)
  }
  const freshArchive = new File([await exportArchive([session(999)])], 'fresh.zip')
  try { await assert.rejects(backup.importHistory(freshArchive, value => failedProgress.push(value)), /Injected transaction failure/) }
  finally { IDBObjectStore.prototype.add = add }
  assert.ok(!failedProgress.includes(100))
  assert.deepEqual(await snapshot(), afterSuccess)
  assert.deepEqual(await stagingCounts(), [0, 0])
  checks.push('A failed commit aborts atomically, clears staging and never reports 100%; every prior chat and memory remains unchanged')

  const damaged = new Uint8Array(await archive.arrayBuffer())
  const manifestText = new TextEncoder().encode('"export_format_version"')
  const offset = damaged.findIndex((byte, index) => byte === manifestText[0] && manifestText.every((expected, j) => damaged[index + j] === expected))
  assert.ok(offset > 0)
  damaged[offset] ^= 1
  await assert.rejects(backup.importHistory(new File([damaged], 'bad-crc.zip')), error => error.key === 'backupIncomplete')
  const lateDamage = new Uint8Array(await archive.arrayBuffer())
  const lateText = new TextEncoder().encode('Question 79')
  const lateOffset = lateDamage.findIndex((byte, index) => byte === lateText[0] && lateText.every((expected, j) => lateDamage[index + j] === expected))
  assert.ok(lateOffset > 0)
  lateDamage[lateOffset] ^= 1
  await assert.rejects(backup.importHistory(new File([lateDamage], 'late-crc.zip')), error => error.key === 'backupIncomplete')
  await assert.rejects(backup.importHistory(new File(['invalid'], 'invalid.zip')), error => error.key === 'backupUnrecognized')
  assert.deepEqual(await snapshot(), afterSuccess)
  assert.deepEqual(await stagingCounts(), [0, 0])
  checks.push('Damaged CRC in both the manifest and a late session after partial staging, plus invalid ZIPs, clear incomplete staging and preserve all local history')

  const longSession = session(100, 'Large conversation JSON')
  longSession.messages[0].content = '长对话内容。'.repeat(300_000)
  const longFile = new File([await exportArchive([longSession])], 'long-json.zip')
  assert.ok(longFile.size > 4 * 1024 * 1024)
  await backup.importHistory(longFile)
  assert.equal((await db.loadSession(store.useChatStore.getState().activeId)).messages[0].content, longSession.messages[0].content)
  checks.push('A conversation JSON larger than the staging batch byte threshold imports completely without truncation')

  const textSessions = Array.from({ length: 80 }, (_, index) => {
    const item = session(200 + index, '80 MiB text archive ' + index)
    item.messages[0].content = 'x'.repeat(1024 * 1024)
    return item
  })
  const textFile = new File([await exportArchive(textSessions)], '80mb-text-history.zip')
  const beforeText = (await db.loadSessionSummaries()).length
  assert.ok(textFile.size >= 80 * 1024 * 1024)
  assert.equal(await backup.importHistory(textFile), textSessions.length)
  const textSummaries = (await db.loadSessionSummaries()).filter(item => item.title.startsWith('80 MiB text archive '))
  assert.equal(textSummaries.length, 80)
  for (const item of textSummaries) {
    const loaded = await db.loadSession(item.id)
    assert.equal(loaded.messages.length, 2)
    assert.equal(loaded.messages[0].content, textSessions[0].messages[0].content)
  }
  assert.equal((await db.loadSessionSummaries()).length, beforeText + 80)
  assert.deepEqual(await db.loadSession(old.id), before[0])
  checks.push('An 80 MiB archive of 80 text conversations preserves every message and byte across serial batches while retaining existing history')

  const imageId = randomUUID()
  const imageBytes = new Uint8Array(80 * 1024 * 1024)
  imageBytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const largeSession = session(80, '80 MiB archive fixture')
  largeSession.messages[0].files.push({ id: imageId, serverId: null, name: 'large.png', size: imageBytes.length, isImage: true, mimeType: 'image/png' })
  await db.saveFiles([{ id: imageId, blob: new Blob([imageBytes], { type: 'image/png' }) }])
  const largeArchive = await exportArchive([largeSession])
  await writeFile(new URL('./deepstay-large-history-80mb.zip', import.meta.url), new Uint8Array(await largeArchive.arrayBuffer()))
  const largeFile = new File([largeArchive], 'large-history.zip', { type: 'application/zip' })
  const largeProgress = []
  const startedAt = performance.now()
  await backup.importHistory(largeFile, value => largeProgress.push(value))
  const importMs = Math.round(performance.now() - startedAt)
  const largeImportedId = store.useChatStore.getState().activeId
  const largeImported = await db.loadSession(largeImportedId)
  const mappedFileId = largeImported.messages[0].files[0].id
  assert.notEqual(mappedFileId, imageId)
  assert.equal((await db.loadFile(mappedFileId)).size, imageBytes.length)
  assert.equal((await db.loadFile(mappedFileId)).type, 'image/png')
  assert.equal((await db.loadFile(imageId)).size, imageBytes.length)
  assert.ok(largeProgress.length > 50, 'Large file reports intermediate progress')
  assert.equal(largeProgress.at(-1), 100)
  const beforeRepeat = (await db.loadSessionSummaries()).length
  assert.equal(await backup.importHistory(largeFile), 0)
  assert.equal((await db.loadSessionSummaries()).length, beforeRepeat)
  assert.deepEqual(await db.loadSession(largeImportedId), largeImported)
  assert.equal((await db.loadFile(mappedFileId)).size, imageBytes.length)
  assert.deepEqual(await db.loadSession(old.id), before[0])
  checks.push('An 80 MiB ZIP imports serially with visible intermediate progress; repeating it reuses the original chat and attachment without touching existing history')

  await backup.clearHistory()
  assert.deepEqual(await db.loadSessionSummaries(), [])
  assert.equal(await db.loadFile(mappedFileId), undefined)
  checks.push('Explicit clear-history still removes all chats and attachments after additive imports')
  const evidence = { passed: true, runtime: process.version, checks,
    textArchiveBytes: textFile.size,
    largeImport: { archiveBytes: largeFile.size, imageBytes: imageBytes.length, importMs, progressUpdates: largeProgress.length },
    scope: 'Actual serial backup entry, ZIP parser, store and IndexedDB transaction code with fake-indexeddb; synthetic 80 MiB PNG-header fixture validates storage, not image decoding or Android compatibility.' }
  await writeFile(new URL('./deepstay-serial-import-evidence.json', import.meta.url), JSON.stringify(evidence, null, 2) + '\n')
  console.log(JSON.stringify(evidence, null, 2))
} finally { hooks.deregister() }
