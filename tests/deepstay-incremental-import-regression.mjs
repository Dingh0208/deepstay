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
  const { getVisibleMessages, appendBranch } = await import(new URL('services/chat/branches.ts', src))
  const { matchImport } = await import(new URL('services/chat/history/mergeImport.ts', src))
  const { setDraftText, getDraft } = await import(new URL('services/chat/drafts.ts', src))
  const archive = async items => new File([await exportArchive(items)], 'selected-history.zip')
  const snapshot = async () => Promise.all((await db.loadSessionSummaries()).map(item => db.loadSession(item.id)))
  const original = session(1, 'Local history')
  await db.saveSession(original)
  await store.initChat()
  const sourceA = session(10, 'Same title')
  const sourceB = session(20, 'Same title')
  const fileId = randomUUID()
  const pixels = new Blob([Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])], { type: 'image/png' })
  sourceB.messages[0].files.push({ id: fileId, serverId: null, name: 'original.png', size: pixels.size, isImage: true, mimeType: 'image/png' })
  await db.saveFiles([{ id: fileId, blob: pixels }])
  const file = await archive([sourceA, sourceB])
  const beforePreview = await snapshot()
  const preview = await backup.previewHistory(file)
  assert.equal(preview.length, 2)
  assert.deepEqual(preview.map(item => item.id).sort(), [sourceA.id, sourceB.id].sort())
  assert.deepEqual(preview.map(item => item.message_count), [2, 2])
  assert.deepEqual(await snapshot(), beforePreview)
  assert.equal(await backup.importHistory(file, undefined, new Set()), 0)
  assert.deepEqual(await snapshot(), beforePreview)
  checks.push('Index preview lists all chats and message counts without changing local history; empty selection commits nothing')

  const selected = new Set([sourceB.id])
  assert.equal(await backup.importHistory(file, undefined, selected), 1)
  const id = store.useChatStore.getState().activeId
  const first = await db.loadSession(id)
  assert.equal(first.importSource.id, sourceB.id)
  assert.equal(first.messages.length, 2)
  assert.equal((await db.loadSessionSummaries()).length, 2)
  assert.deepEqual(await db.loadSession(original.id), beforePreview[0])
  const mappedImage = first.messages[0].files[0].id
  assert.notEqual(mappedImage, fileId)
  assert.equal((await db.loadFile(mappedImage)).size, pixels.size)
  assert.equal(await backup.importHistory(file, undefined, selected), 0)
  assert.deepEqual(await db.loadSession(id), first)
  checks.push('Only selected chats and their images are added; repeating the same selection adds no duplicate chats, messages or files')

  const local = appendBranch({ ...first, title: 'Local renamed title', contextMemory: { fixed: 'Keep this local memory' } }, first.messages.at(-1).id, [
    { id: 'local-question', role: 'user', content: 'Local continuation', files: [], createdAt: first.updatedAt + 100 },
    { id: 'local-answer', role: 'assistant', model: null, prefix: false, status: 'done', blocks: [{ type: 'text', text: 'Local answer' }], createdAt: first.updatedAt + 101 },
  ])
  await db.saveSession(local)
  store.useChatStore.setState({ sessionCache: { [id]: local } })
  setDraftText(id, 'Do not remove this draft')
  sourceB.messages.push(
    { id: 'remote-q2', role: 'user', content: 'New archive continuation', files: [], createdAt: sourceB.updatedAt + 200 },
    { id: 'remote-a2', role: 'assistant', model: null, prefix: false, status: 'done', blocks: [{ type: 'text', text: 'New archive answer' }], createdAt: sourceB.updatedAt + 201 },
  )
  sourceB.updatedAt += 201
  const update = await archive([sourceA, sourceB])
  assert.equal(await backup.importHistory(update, undefined, selected), 1)
  const merged = await db.loadSession(id)
  assert.equal((await db.loadSessionSummaries()).length, 2)
  assert.equal(merged.messages.length, 6)
  assert.equal(merged.title, local.title)
  assert.deepEqual(merged.contextMemory, local.contextMemory)
  assert.equal(getDraft(id).text, 'Do not remove this draft')
  assert.deepEqual(getVisibleMessages(merged).map(item => item.id), getVisibleMessages(local).map(item => item.id))
  assert.ok(merged.messages.some(item => item.role === 'user' && item.content === 'New archive continuation'))
  assert.ok(store.useChatStore.getState().sessionCache[id].messages.some(item => item.role === 'user' && item.content === 'New archive continuation'))
  assert.equal((await db.loadFile(mappedImage)).size, pixels.size)
  assert.equal(await backup.importHistory(update, undefined, selected), 0)
  assert.deepEqual(await db.loadSession(id), merged)
  checks.push('An updated source adds only new messages to the same chat and refreshes cache, preserving local continuation, selected branch, renamed title, draft, fixed memory and attachment')

  const savedSource = structuredClone(merged.importSource)
  assert.equal(await backup.importHistory(await archive([merged])), 0)
  assert.deepEqual((await db.loadSession(id)).importSource, savedSource)
  assert.equal((await db.loadSessionSummaries()).length, 2)
  checks.push('Reimporting an app export recognizes its local chat ID and preserves the original external source mapping')

  const emptied = { ...merged, messages: [], rootMessageId: null, linearMessagePath: true }
  await db.saveSession(emptied)
  store.useChatStore.setState({ sessionCache: { [id]: emptied } })
  sourceB.messages.push(
    { id: 'remote-q3', role: 'user', content: 'Only new third round', files: [], createdAt: sourceB.updatedAt + 100 },
    { id: 'remote-a3', role: 'assistant', model: null, prefix: false, status: 'done', blocks: [{ type: 'text', text: 'Only new third answer' }], createdAt: sourceB.updatedAt + 101 },
  )
  sourceB.updatedAt += 101
  assert.equal(await backup.importHistory(await archive([sourceB])), 1)
  const afterDeletion = await db.loadSession(id)
  assert.equal(afterDeletion.messages.length, 2)
  assert.equal(getVisibleMessages(afterDeletion).length, 2)
  assert.equal(getVisibleMessages(afterDeletion)[0].content, 'Only new third round')
  assert.equal(await backup.importHistory(await archive([sourceB])), 0)
  checks.push('Previously deleted source messages remain deleted; a newer round is connected to a visible root rather than a deleted message')

  const legacy = { ...first, id: 'legacy-without-source', importSource: undefined }
  const anotherSource = { ...first, id: 'different-source', importSource: undefined }
  assert.ok(matchImport(anotherSource, legacy), 'Exact legacy content can be recognized without a title match')
  const longer = { ...anotherSource, messages: [...anotherSource.messages, { id: '3', role: 'user', parentId: '2', content: 'Different conversation after common greeting', files: [], createdAt: 12345 }] }
  assert.equal(matchImport(longer, legacy), undefined, 'A common opening must not merge two different source chats')
  await db.saveSession(legacy)
  assert.equal(await backup.importHistory(file, undefined, selected), 0, 'The primary matching imported session remains authoritative')
  checks.push('Legacy matching requires the entire imported message set; matching titles or common short openings do not merge distinct conversations')

  const unrelated = new AbortController()
  store.useChatStore.setState({ streaming: { [original.id]: unrelated } })
  assert.equal(await backup.importHistory(await archive([sourceA])), 1)
  assert.equal(unrelated.signal.aborted, false)
  store.useChatStore.setState({ streaming: {} })
  checks.push('Importing an unrelated chat leaves another conversation’s active model stream running')

  const nativeEmpty = { id: 'native-empty-source', title: 'Deleted native conversation', createdAt: 50_000, updatedAt: 50_001,
    messages: [], rootMessageId: null, linearMessagePath: true }
  await db.saveSession(nativeEmpty)
  const nativeEmptyArchive = await archive([nativeEmpty])
  const beforeEmptyImport = (await db.loadSessionSummaries()).length
  assert.equal(await backup.importHistory(nativeEmptyArchive), 0)
  assert.equal((await db.loadSessionSummaries()).length, beforeEmptyImport)
  assert.deepEqual(await db.loadSession(nativeEmpty.id), nativeEmpty)
  const continuedNative = appendBranch(nativeEmpty, null, [
    { id: 'later-native-question', role: 'user', content: 'Keep the later native conversation', files: [], createdAt: 50_100 },
    { id: 'later-native-answer', role: 'assistant', model: null, prefix: false, status: 'done', blocks: [{ type: 'text', text: 'Keep the later native reply' }], createdAt: 50_101 },
  ])
  await db.saveSession(continuedNative)
  assert.equal(await backup.importHistory(nativeEmptyArchive), 0)
  assert.deepEqual(await db.loadSession(nativeEmpty.id), continuedNative)
  assert.equal((await db.loadSessionSummaries()).length, beforeEmptyImport)
  const foreignEmpty = { ...nativeEmpty, id: 'foreign-empty-source' }
  assert.equal(await backup.importHistory(await archive([foreignEmpty])), 1)
  assert.equal((await db.loadSessionSummaries()).length, beforeEmptyImport + 1)
  assert.equal(await backup.importHistory(await archive([foreignEmpty])), 0)
  assert.deepEqual(await db.loadSession(nativeEmpty.id), continuedNative)
  assert.equal(matchImport({ ...nativeEmpty, createdAt: 60_000 }, continuedNative), undefined)
  checks.push('An empty native export reuses its own ID without creating a duplicate or clearing later local messages; a distinct empty source remains an independent chat')

  const { writeArchive } = await import(new URL('services/chat/history/zipWriter.ts', src))
  const { toSessionFile, toIndexEntry } = await import(new URL('services/chat/history/toArchive.ts', src))
  const previewSource = toSessionFile(session(1000, 'Many image entries'), () => null)
  const previewFiles = async count => writeArchive([
    { name: 'manifest.json', blob: new Blob([JSON.stringify({ export_format_version: 3 })]) },
    { name: `chat_sessions/${previewSource.id}.json`, blob: new Blob([JSON.stringify(previewSource)]) },
    { name: 'chat_session_index.json', blob: new Blob([JSON.stringify([toIndexEntry(previewSource)])]) },
    ...Array.from({ length: count }, (_, index) => ({ name: `chat_sessions/${previewSource.id}_files/image-${index}.png`, blob: new Blob([new Uint8Array(16 * 1024)]) })),
  ])
  class CountedFile extends File {
    reads = []
    slice(...args) {
      const blob = super.slice(...args)
      this.reads.push(blob.size)
      return blob
    }
  }
  const oneImagePreview = new CountedFile([await previewFiles(1)], 'one-image.zip')
  const manyImageBytes = await previewFiles(510)
  const manyImagePreview = new CountedFile([manyImageBytes], '510-images.zip')
  const beforeBoundedPreview = await snapshot()
  assert.equal((await backup.previewHistory(oneImagePreview)).length, 1)
  assert.equal((await backup.previewHistory(manyImagePreview)).length, 1)
  assert.equal(manyImagePreview.reads.length, oneImagePreview.reads.length,
    'Adding 509 images must not add hundreds of sequential local-header file reads to preview')
  assert.ok(manyImagePreview.reads.length <= 12)
  assert.ok(manyImagePreview.reads.reduce((sum, size) => sum + size, 0) < 200 * 1024,
    'Preview reads only the ZIP directory, manifest and index, not image bodies or conversation JSON')
  assert.deepEqual(await snapshot(), beforeBoundedPreview)
  const damagedHeader = new Uint8Array(await manyImageBytes.arrayBuffer())
  const zipView = new DataView(damagedHeader.buffer)
  const centralOffset = zipView.getUint32(damagedHeader.length - 22 + 16, true)
  let directoryCursor = centralOffset
  let corruptImageHeader = false
  while (zipView.getUint32(directoryCursor, true) === 0x02014b50) {
    const nameLength = zipView.getUint16(directoryCursor + 28, true)
    const name = new TextDecoder().decode(damagedHeader.subarray(directoryCursor + 46, directoryCursor + 46 + nameLength))
    if (name.endsWith('/image-0.png')) {
      damagedHeader[zipView.getUint32(directoryCursor + 42, true)] ^= 1
      corruptImageHeader = true
      break
    }
    directoryCursor += 46 + nameLength + zipView.getUint16(directoryCursor + 30, true) + zipView.getUint16(directoryCursor + 32, true)
  }
  assert.equal(corruptImageHeader, true)
  const damagedHeaderFile = new File([damagedHeader], 'damaged-excluded-header.zip')
  assert.equal((await backup.previewHistory(damagedHeaderFile)).length, 1,
    'Preview intentionally defers excluded image local headers to the full confirmation scan')
  await assert.rejects(backup.importHistory(damagedHeaderFile), error => error.key === 'backupIncomplete')
  assert.deepEqual(await snapshot(), beforeBoundedPreview)
  checks.push('510-image preview uses the same bounded number of file reads as a one-image archive; a corrupted excluded local header is still rejected on confirmation without changing history')

  const beforeDamage = await snapshot()
  const corrupt = new File([file.slice(0, file.size - 10)], 'truncated.zip')
  await assert.rejects(backup.previewHistory(corrupt))
  await assert.rejects(backup.importHistory(corrupt))
  assert.deepEqual(await snapshot(), beforeDamage)
  assert.deepEqual(await db.loadSession(original.id), beforePreview[0])
  checks.push('Invalid preview or import does not overwrite or remove any prior local conversation')
  const evidence = { passed: true, runtime: process.version, checks,
    previewIO: { imageEntries: 510, oneImageReads: oneImagePreview.reads.length, manyImageReads: manyImagePreview.reads.length,
      manyImageBytesRead: manyImagePreview.reads.reduce((sum, size) => sum + size, 0), archiveBytes: manyImagePreview.size },
    scope: 'Actual preview, ZIP parser, selected serial import, incremental transaction, chat cache, branches and attachment code with isolated fake-indexeddb and synthetic conversations; no user chat or network.' }
  await writeFile(new URL('./deepstay-incremental-import-evidence.json', import.meta.url), JSON.stringify(evidence, null, 2))
  console.log(JSON.stringify(evidence, null, 2))
} finally { hooks.deregister() }
