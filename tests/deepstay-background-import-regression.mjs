import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { registerHooks, stripTypeScriptTypes } from 'node:module'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

const src = new URL('../src/', import.meta.url)
const workerSource = new URL('services/chat/history/import.worker.ts', src)
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
      if (url.startsWith(workerSource.href)) {
        source = source.replace('const worker = globalThis as unknown as', 'const worker = globalThis.__workerScopes.get(new URL(import.meta.url).searchParams.get("worker")) as unknown as')
      }
      return { format: 'module', source: stripTypeScriptTypes(source, { mode: 'transform' }), shortCircuit: true }
    }
    return nextLoad(url, context)
  },
})
const saved = new Map([['chat-demo:api-key', 'background-import-fixture']])
globalThis.localStorage = { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value), removeItem: key => saved.delete(key) }
globalThis.__API_ORIGIN__ = 'https://api.deepseek.com'
globalThis.window = new EventTarget()
globalThis.document = Object.assign(new EventTarget(), { visibilityState: 'visible' })
Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh-CN' }, configurable: true })
globalThis.requestAnimationFrame = callback => setTimeout(callback, 0)
globalThis.cancelAnimationFrame = clearTimeout
let networkCalls = 0
globalThis.fetch = async (_url, init) => {
  networkCalls++
  const body = JSON.parse(init.body)
  assert.equal(body.messages.at(-1).content, 'Chat continues while import prepares')
  const data = [
    { id: 'during-preparation', choices: [{ index: 0, delta: { content: 'Preparation did not block chatting' }, finish_reason: null }] },
    { id: 'during-preparation', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  ].map(chunk => 'data: ' + JSON.stringify(chunk) + '\n\n').join('') + 'data: [DONE]\n\n'
  return new Response(data, { headers: { 'Content-Type': 'text/event-stream' } })
}
globalThis.__workerScopes = new Map()
const workers = []
class WorkerHarness {
  static holdNext = false
  constructor(url) {
    assert.equal(url.href, workerSource.href)
    this.id = String(workers.length)
    this.hold = WorkerHarness.holdNext
    WorkerHarness.holdNext = false
    this.scope = { postMessage: data => { if (!this.terminated) this.onmessage?.({ data }) }, onmessage: null }
    globalThis.__workerScopes.set(this.id, this.scope)
    workers.push(this)
  }
  postMessage(data) {
    this.data = data
    if (!this.hold) void this.run()
  }
  async run() {
    if (this.terminated) return
    try {
      await import(workerSource.href + '?worker=' + this.id)
      if (!this.terminated) this.scope.onmessage({ data: this.data })
    } catch (error) {
      this.onerror?.({ error })
    }
  }
  terminate() { this.terminated = true }
}
globalThis.Worker = WorkerHarness
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
  const background = await import(new URL('services/chat/backgroundImport.ts', src))
  const backup = await import(new URL('services/chat/backup.ts', src))
  const { exportArchive } = await import(new URL('services/chat/history/exportArchive.ts', src))
  const { setDraftText } = await import(new URL('services/chat/drafts.ts', src))
  const { setApiConnection } = await import(new URL('services/settings.ts', src))
  const rawDb = await new Promise((resolve, reject) => {
    const request = indexedDB.open('xuchat-guest')
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  rawDb.close()
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
  const formalSnapshot = async () => {
    const summaries = await db.loadSessionSummaries()
    return Promise.all(summaries.map(summary => db.loadSession(summary.id)))
  }
  const phase = () => background.useBackgroundImport.getState().phase
  const old = session(1, 'Current history')
  old.contextMemory = { fixed: '角色：A，仅属于现有会话。' }
  await db.saveSession(old)
  await store.initChat()
  store.selectSession(old.id)
  await wait(() => store.useChatStore.getState().sessionCache[old.id], 'current session load')
  const imported = [session(10), session(20), session(30)]
  const archive = new File([await exportArchive(imported)], 'worker-history.zip', { type: 'application/zip' })

  WorkerHarness.holdNext = true
  background.startBackgroundImport(archive)
  assert.equal(phase(), 'preparing')
  assert.equal(store.useChatStore.getState().importingHistory, false)
  store.renameSession(old.id, 'Renamed during preparation')
  await wait(async () => (await db.loadSession(old.id)).title === 'Renamed during preparation', 'rename while preparing')
  setApiConnection({ apiKey: 'background-import-fixture', apiBaseUrl: 'https://qa.deepstay.invalid', apiProtocol: 'openai', model: 'fixture', models: ['fixture'] })
  setDraftText(null, 'Chat continues while import prepares')
  assert.equal(store.sendMessage(null), true)
  await wait(() => Object.keys(store.useChatStore.getState().streaming).length === 0, 'message while preparing')
  assert.equal(networkCalls, 1)
  const beforeCancel = await formalSnapshot()
  assert.equal(beforeCancel.length, 2)
  await db.addStagingSession(imported[0])
  await background.cancelBackgroundImport()
  assert.equal(phase(), 'idle')
  assert.equal(workers[0].terminated, true)
  assert.deepEqual(await stagingCounts(), [0, 0])
  assert.deepEqual(await formalSnapshot(), beforeCancel)
  checks.push('Preparing keeps chatting and rename available; cancellation terminates the worker, clears partial staging and preserves both original and newly generated messages')

  background.startBackgroundImport(archive)
  await wait(() => phase() !== 'preparing', 'actual worker preparation')
  assert.equal(phase(), 'ready')
  assert.equal(background.useBackgroundImport.getState().sessions, 3)
  assert.equal(background.useBackgroundImport.getState().progress, 100)
  assert.equal(store.useChatStore.getState().importingHistory, false)
  assert.deepEqual(await stagingCounts(), [3, 0])
  assert.deepEqual(await formalSnapshot(), beforeCancel)
  const workerCount = workers.length
  background.startBackgroundImport(archive)
  assert.equal(workers.length, workerCount)
  await assert.rejects(backup.clearHistory(), /staging area/)
  await assert.rejects(backup.importHistory(archive), /staging area/)
  assert.equal(phase(), 'ready')
  assert.deepEqual(await stagingCounts(), [3, 0])
  await background.cancelBackgroundImport()
  assert.deepEqual(await stagingCounts(), [0, 0])
  assert.deepEqual(await formalSnapshot(), beforeCancel)
  checks.push('Actual worker entry parses and stages a real ZIP without replacing history; ready state reserves staging against second import/clear and can be cancelled safely')

  background.startBackgroundImport(archive)
  await wait(() => phase() !== 'preparing', 'rollback preparation')
  assert.equal(phase(), 'ready')
  const originalPut = IDBObjectStore.prototype.add
  IDBObjectStore.prototype.add = function (...args) {
    if (this.name === 'sessions') throw new DOMException('Injected transaction failure', 'QuotaExceededError')
    return originalPut.apply(this, args)
  }
  try { await background.applyBackgroundImport() } finally { IDBObjectStore.prototype.add = originalPut }
  assert.equal(phase(), 'error')
  assert.equal(store.useChatStore.getState().importingHistory, false)
  assert.deepEqual(await formalSnapshot(), beforeCancel)
  assert.deepEqual(await stagingCounts(), [0, 0])
  checks.push('A synchronous failure after the replacement transaction starts aborts atomically, preserving current and during-preparation messages and clearing failed staging')

  background.startBackgroundImport(archive)
  await wait(() => phase() !== 'preparing', 'success preparation')
  assert.equal(phase(), 'ready')
  let sawReplacementLock = false
  const unsubscribeReplacementLock = store.useChatStore.subscribe((state) => {
    if (state.importingHistory) sawReplacementLock = true
  })
  const applying = background.applyBackgroundImport()
  assert.equal(phase(), 'applying')
  await background.cancelBackgroundImport()
  assert.equal(phase(), 'applying')
  await applying
  unsubscribeReplacementLock()
  assert.equal(phase(), 'done')
  assert.equal(sawReplacementLock, false)
  const current = store.useChatStore.getState()
  assert.equal(current.importingHistory, false)
  assert.equal(current.sessions.length, beforeCancel.length + 3)
  const firstImportedId = current.activeId
  assert.notEqual(firstImportedId, imported[2].id)
  assert.equal(current.sessions.find(item => item.id === firstImportedId).title, imported[2].title)
  assert.equal(current.sessionCache[current.activeId].messages[0].content, 'Question 30')
  assert.deepEqual(await stagingCounts(), [0, 0])
  const firstImport = await formalSnapshot()
  store.setSessionContextMemory(firstImportedId, '角色：B，与会话A不同。')
  await wait(async () => (await db.loadSession(firstImportedId)).contextMemory?.fixed.includes('角色：B'), 'session B memory save')
  assert.equal((await db.loadSession(old.id)).contextMemory.fixed, old.contextMemory.fixed)
  store.selectSession(old.id)
  assert.equal(store.useChatStore.getState().sessionCache[old.id].contextMemory.fixed, old.contextMemory.fixed)
  store.useChatStore.setState({ sessionCache: {} })
  store.selectSession(old.id)
  await wait(() => store.useChatStore.getState().sessionCache[old.id], 'cold memory A')
  store.selectSession(firstImportedId)
  await wait(() => store.useChatStore.getState().sessionCache[firstImportedId], 'cold memory B')
  assert.equal(store.useChatStore.getState().sessionCache[firstImportedId].contextMemory.fixed, '角色：B，与会话A不同。')
  assert.equal(store.useChatStore.getState().sessionCache[old.id].contextMemory.fixed, old.contextMemory.fixed)
  checks.push('Different pinned memories stay isolated per chat, survive persistence and are restored independently after cache eviction')

  const ongoing = new AbortController()
  store.useChatStore.setState({ streaming: { [old.id]: ongoing } })
  background.startBackgroundImport(archive)
  await wait(() => phase() !== 'preparing', 'repeat import preparation')
  await background.applyBackgroundImport()
  assert.equal(phase(), 'done')
  assert.equal(ongoing.signal.aborted, false)
  assert.equal(store.useChatStore.getState().streaming[old.id], ongoing)
  store.useChatStore.setState({ streaming: {} })
  assert.equal(store.useChatStore.getState().sessions.length, firstImport.length + imported.length)
  assert.notEqual(store.useChatStore.getState().activeId, firstImportedId)
  assert.equal((await db.loadSession(firstImportedId)).contextMemory.fixed, '角色：B，与会话A不同。')
  checks.push('Repeated archive import creates independent chats and preserves original memories and in-progress reply controllers')
  const afterSuccess = await formalSnapshot()
  assert.equal((await db.loadSession(old.id)).contextMemory.fixed, old.contextMemory.fixed)
  for (const existing of beforeCancel) assert.deepEqual(await db.loadSession(existing.id), existing)
  checks.push('Explicit apply adds separate chats with new IDs, keeps existing and during-preparation messages and loads the latest imported chat without interrupting other chats')

  const damaged = new Uint8Array(await archive.arrayBuffer())
  const manifestText = new TextEncoder().encode('export_format_version')
  const badOffset = damaged.findIndex((byte, index) => byte === manifestText[0] && manifestText.every((expected, j) => damaged[index + j] === expected))
  assert.ok(badOffset > 0)
  damaged[badOffset] ^= 1
  background.startBackgroundImport(new File([damaged], 'bad-crc.zip'))
  await wait(() => phase() !== 'preparing', 'invalid ZIP failure')
  assert.equal(phase(), 'error')
  assert.equal(background.useBackgroundImport.getState().error, 'backupIncomplete')
  assert.deepEqual(await formalSnapshot(), afterSuccess)
  assert.deepEqual(await stagingCounts(), [0, 0])
  checks.push('Actual worker rejects corrupted ZIP CRC with the original typed error key, clears staging and preserves the completed history')

  store.useChatStore.setState({ importingHistory: true })
  const beforeBusyStart = workers.length
  background.startBackgroundImport(archive)
  assert.equal(workers.length, beforeBusyStart)
  store.useChatStore.setState({ importingHistory: false })
  background.dismissBackgroundImport()
  assert.equal(phase(), 'idle')
  checks.push('Starting background preparation during an existing history replacement is rejected without creating another worker')

  const imageId = randomUUID()
  const imageBytes = new Uint8Array(80 * 1024 * 1024)
  imageBytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const largeSession = session(80, '80 MiB archive fixture')
  largeSession.messages[0].files.push({
    id: imageId, serverId: null, name: 'large.png', size: imageBytes.length, isImage: true, mimeType: 'image/png',
  })
  await db.saveFiles([{ id: imageId, blob: new Blob([imageBytes], { type: 'image/png' }) }])
  const largeArchive = await exportArchive([largeSession])
  await writeFile(new URL('./deepstay-large-history-80mb.zip', import.meta.url), new Uint8Array(await largeArchive.arrayBuffer()))
  assert.ok(largeArchive.size >= imageBytes.length)
  const largeFile = new File([largeArchive], 'large-history.zip', { type: 'application/zip' })
  const baselineRss = process.memoryUsage().rss
  let peakRss = baselineRss
  const monitor = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss) }, 10)
  const startedAt = performance.now()
  try {
    background.startBackgroundImport(largeFile)
    await wait(() => phase() !== 'preparing', '80 MiB archive preparation')
  } finally {
    clearInterval(monitor)
  }
  const preparationMs = Math.round(performance.now() - startedAt)
  assert.equal(phase(), 'ready')
  assert.equal(background.useBackgroundImport.getState().progress, 100)
  assert.deepEqual(await stagingCounts(), [1, 1])
  const largeConnection = await new Promise((resolve, reject) => {
    const request = indexedDB.open('xuchat-guest')
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  const stagedImage = await new Promise((resolve, reject) => {
    const request = largeConnection.transaction('filesStaging', 'readonly').objectStore('filesStaging').get(imageId)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  largeConnection.close()
  assert.equal(stagedImage.blob.size, imageBytes.length)
  await background.applyBackgroundImport()
  assert.equal(phase(), 'done')
  const largeImportedId = store.useChatStore.getState().activeId
  const largeImported = await db.loadSession(largeImportedId)
  const mappedFileId = largeImported.messages[0].files[0].id
  assert.notEqual(mappedFileId, imageId)
  assert.equal((await db.loadFile(mappedFileId)).size, imageBytes.length)
  assert.equal((await db.loadFile(mappedFileId)).type, 'image/png')
  assert.equal((await db.loadFile(imageId)).size, imageBytes.length)
  const beforeRepeatLarge = (await db.loadSessionSummaries()).length
  background.startBackgroundImport(largeFile)
  await wait(() => phase() !== 'preparing', 'repeated large file preparation')
  await background.applyBackgroundImport()
  const duplicate = await db.loadSession(store.useChatStore.getState().activeId)
  assert.notEqual(duplicate.id, largeImportedId)
  assert.notEqual(duplicate.messages[0].files[0].id, mappedFileId)
  assert.equal((await db.loadFile(duplicate.messages[0].files[0].id)).size, imageBytes.length)
  assert.equal((await db.loadSessionSummaries()).length, beforeRepeatLarge + 1)
  assert.deepEqual(await db.loadSession(largeImportedId), largeImported)
  await store.removeSession(duplicate.id)
  assert.equal(await db.loadFile(duplicate.messages[0].files[0].id), undefined)
  assert.equal((await db.loadFile(mappedFileId)).size, imageBytes.length)
  checks.push('Repeated 80 MiB import creates separate attachment IDs; deleting one imported chat preserves the other chat’s full image')
  checks.push('An 80 MiB STORE ZIP with a single large image completes background staging and atomic apply with full file size and MIME preserved')
  const largeImport = {
    archiveBytes: largeFile.size,
    preparationMs,
    peakRssDeltaMiB: Math.round((peakRss - baselineRss) / 1024 / 1024),
    stagedImageBytes: stagedImage.blob.size,
  }

  await backup.clearHistory()
  assert.deepEqual(await db.loadSessionSummaries(), [])
  assert.equal(await db.loadFile(mappedFileId), undefined)
  checks.push('Clear history still removes every chat and attachment after append imports')
  const evidence = { passed: true, runtime: process.version, checks, largeImport,
    workerEntriesExecuted: workers.filter(worker => !worker.hold).length, networkCalls,
    scope: 'Actual TypeScript background service, worker entry, archive parser, store and IndexedDB transactions. Includes a synthetic 80 MiB STORE ZIP image archive. The worker global is isolated by a harness in the same Node thread with fake-indexeddb; OS thread cancellation and WebView compatibility require native/browser tests.' }
  await writeFile(new URL('./deepstay-background-import-evidence.json', import.meta.url), JSON.stringify(evidence, null, 2) + '\n')
  console.log(JSON.stringify(evidence, null, 2))
} finally {
  hooks.deregister()
}
