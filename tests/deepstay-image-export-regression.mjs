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

const { limitRequestImages, REQUEST_IMAGE_BUDGET } = await import(new URL('services/chat/requestImages.ts', src))
const { isTotalImageSizeError } = await import(new URL('services/api/errors.ts', src))
const { ApiError } = await import(new URL('services/api/http.ts', src))
const { toSessionFile } = await import(new URL('services/chat/history/toArchive.ts', src))
const { exportArchive } = await import(new URL('services/chat/history/exportArchive.ts', src))
const { previewArchive, importArchive } = await import(new URL('services/chat/history/importArchive.ts', src))
const { readArchive, readEntry } = await import(new URL('services/chat/history/zipReader.ts', src))
const { writeArchive } = await import(new URL('services/chat/history/zipWriter.ts', src))
const db = await import(new URL('services/chat/db.ts', src))
const checks = []
const image = (id, size) => ({ id, name: `${id}.png`, size, isImage: true, mimeType: 'image/png', serverId: `file-${id}` })
const png = (size, width = 1000, height = 1000) => {
  const header = new Uint8Array(24)
  const view = new DataView(header.buffer)
  view.setUint32(0, 0x89504e47); view.setUint32(4, 0x0d0a1a0a)
  view.setUint32(16, width); view.setUint32(20, height)
  return new Blob([header, new Uint8Array(size - header.length)], { type: 'image/png' })
}
const oldBlob = png(5_000_000)
const currentBlob = png(2_900_000)
const history = Array.from({ length: 45 }, (_, i) => ({ role: 'user', id: `q${i}`, content: `earlier ${i}`, files: [image(`old${i}`, oldBlob.size)] }))
const question = { role: 'user', id: 'current', content: '原相机哦', files: [image('current-image', currentBlob.size)] }
const limited = await limitRequestImages(history, question, async id => id === 'current-image' ? currentBlob : oldBlob)
const kept = limited.history.flatMap(item => item.files)
assert.ok(kept.length < 45 && kept.length > 0)
assert.equal(limited.question, question)
assert.ok(kept.length * oldBlob.size + 4_000_000 <= REQUEST_IMAGE_BUDGET)
assert.ok(limited.history[0].content.includes('earlier 0'))
assert.equal(history[0].files.length, 1)
assert.equal(limited.history.at(-1).files[0].id, 'old44')
const duplicate = await limitRequestImages([history[0]], { ...question, files: history[0].files }, async () => oldBlob)
assert.equal(duplicate.history[0].files.length, 0)
assert.equal(duplicate.question.files.length, 1)
const retry = await limitRequestImages(history, question, async () => currentBlob, true)
assert.equal(retry.history.flatMap(item => item.files).length, 0)
assert.equal(retry.question.files.length, 1)
await assert.rejects(limitRequestImages([], { ...question, files: Array.from({ length: 4 }, (_, i) => image(`big${i}`, 60_000_000)) }, async () => undefined), error => error.localMessage.key === 'replyCurrentImagesTooLarge')
assert.equal(isTotalImageSizeError(new ApiError('http', 'messages: Total image size exceeds the limit:max 200 MB per request, got 209 MB', 400)), true)
assert.equal(isTotalImageSizeError(new ApiError('http', 'Insufficient Balance', 400)), false)
checks.push('A 2.9 MB current photo plus over 200 MB of old images keeps the current photo and newest history within the request budget; duplicates and retry-only omissions leave source messages intact')

// Parent-first export must not recurse through an arbitrarily ordered, deep tree.
const count = 30000
const messages = Array.from({ length: count }, (_, i) => i % 2 ? {
  id: `m${i}`, role: 'assistant', parentId: `m${i-1}`, selectedChildId: i + 1 < count ? `m${i+1}` : undefined,
  createdAt: i + 1, status: 'done', blocks: [{ type: 'text', text: `回答 ${i}` }],
} : { id: `m${i}`, role: 'user', parentId: i ? `m${i-1}` : null, selectedChildId: `m${i+1}`, createdAt: i + 1, content: `问题 ${i}`, files: [] })
const session = { id: 'long-export', title: '长会话', createdAt: 1, updatedAt: count, messages: messages.slice().reverse(), rootMessageId: 'm0' }
const exported = toSessionFile(session, () => null)
assert.equal(exported.messages.length, count)
assert.equal(exported.messages[0].id, 1)
assert.ok(exported.messages.every(item => !item.parent_id || item.parent_id < item.id))
assert.throws(() => toSessionFile({ ...session, messages: [{ ...messages[0], parentId: 'm0' }] }, () => null), error => error.key === 'backupInvalidBranches')
checks.push('A reverse-ordered 30,000-message parent chain exports without stack overflow; corrupted cycles still fail')

await db.saveFiles([{ id: 'export-photo', blob: png(80 * 1024 * 1024) }])
const withImage = { ...session, id: 'image-export', messages: [{ ...messages[0], parentId: null, selectedChildId: 'm1', files: [image('export-photo', 80 * 1024 * 1024)] }, { ...messages[1], selectedChildId: undefined }] }
let writes = 0, bytes = 0, progress = 0
const chunks = []
const noCopy = await exportArchive([withImage], async chunk => {
  // Async backpressure is awaited before more ZIP data is produced.
  writes++
  bytes += chunk.length
  chunks.push(new Blob([chunk]))
  await Promise.resolve()
}, () => progress++)
assert.equal(noCopy.size, 0, 'Native sink does not also retain a complete ZIP Blob')
assert.ok(writes > 10 && bytes > 80 * 1024 * 1024)
assert.equal(progress, 1)
const file = new File(chunks, 'streamed.zip')
assert.equal((await previewArchive(file))[0].id, withImage.id)
const paths = []
for await (const entry of readArchive(file)) {
  paths.push(entry.path)
  const blob = await readEntry(entry)
  if (entry.path.includes('files/')) assert.equal(blob.size, 80 * 1024 * 1024)
}
assert.ok(paths.length >= 4)
await db.clearStaging()
await importArchive(file)
assert.ok(bytes === file.size)
await db.clearStaging()
checks.push('An 80 MiB photo archive streams with awaited writes and no retained output ZIP, validates every CRC, previews and imports again')
let afterFailure = false
async function* entries() {
  yield { name: 'one.txt', blob: new Blob(['one']) }
  afterFailure = true
  yield { name: 'two.txt', blob: new Blob(['two']) }
}
await assert.rejects(writeArchive(entries(), async () => { throw Error('destination unavailable') }), /destination unavailable/)
assert.equal(afterFailure, false)
checks.push('A failed destination write stops archive generation immediately instead of continuing to allocate or reporting success')
console.log(JSON.stringify({ passed: true, checks, scope: 'Synthetic PNG headers, real ZIP/CRC/import and IndexedDB emulator; no private conversation content or real API requests' }, null, 2))
hooks.deregister()
