import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { registerHooks, stripTypeScriptTypes } from 'node:module'
import { fileURLToPath } from 'node:url'

const root = new URL('../src/', import.meta.url)
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL?.startsWith(root.href)) {
      const candidate = new URL(specifier.slice(0, -3) + '.ts', context.parentURL)
      if (existsSync(fileURLToPath(candidate))) return { url: candidate.href, shortCircuit: true }
    }
    return next(specifier, context)
  },
  load(url, context, next) {
    return url.startsWith(root.href) && url.endsWith('.ts')
      ? { format: 'module', source: stripTypeScriptTypes(readFileSync(new URL(url), 'utf8'), { mode: 'transform' }), shortCircuit: true }
      : next(url, context)
  },
})
await import('fake-indexeddb/auto')
const values = new Map()
globalThis.localStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) }
globalThis.__API_ORIGIN__ = 'https://api.deepseek.com'
globalThis.window = new EventTarget()
const canvases = [], decoded = [], revoked = []
let failEncode = false, fallbackImages = 0
globalThis.Image = class { constructor() { fallbackImages++; throw new Error('Unexpected full-size fallback') } }
globalThis.document = Object.assign(new EventTarget(), {
  visibilityState: 'visible',
  createElement: tag => {
    assert.equal(tag, 'canvas')
    const canvas = { width: 0, height: 0, getContext: () => ({ drawImage() {} }), toBlob(callback, type) {
      canvases.push({ width: this.width, height: this.height })
      callback(failEncode ? null : new Blob([`${this.width}x${this.height}`], { type }))
    } }
    return canvas
  },
})
Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh-CN' }, configurable: true })
globalThis.requestAnimationFrame = callback => setTimeout(() => callback(Date.now()), 0)
globalThis.cancelAnimationFrame = clearTimeout
globalThis.createImageBitmap = async (blob, options) => {
  decoded.push(options)
  return { width: options.resizeWidth ?? 7000, height: options.resizeHeight ?? 1400, close() { revoked.push('bitmap') } }
}
const png = (width, height) => {
  const bytes = new Uint8Array(32)
  const view = new DataView(bytes.buffer)
  view.setUint32(0, 0x89504e47)
  view.setUint32(4, 0x0d0a1a0a)
  view.setUint32(16, width)
  view.setUint32(20, height)
  return new Blob([bytes], { type: 'image/png' })
}

try {
  const { prepareImageUpload } = await import(new URL('services/imageUpload.ts', root))
  const normal = png(4096, 2048)
  assert.equal(await prepareImageUpload(normal), normal)
  assert.equal(decoded.length, 0, 'Ordinary images do not allocate decoded pixels or a canvas')
  const original = png(7000, 1400)
  const converted = await prepareImageUpload(original)
  assert.equal(await converted.text(), '4096x819')
  assert.equal(original.size, 32)
  assert.equal(new DataView(await original.arrayBuffer()).getUint32(16), 7000)
  assert.equal(revoked.length, 1)
  assert.deepEqual(canvases.at(-1), { width: 4096, height: 819 })
  failEncode = true
  await assert.rejects(prepareImageUpload(original), /Image conversion failed/)
  assert.equal(fallbackImages, 0, 'A failed encoding cannot decode a second full-size image')
  assert.equal(revoked.length, 2, 'Failed encodings still release their bounded bitmap')
  failEncode = false

  const screenshot = png(1000, 12000)
  assert.equal(await (await prepareImageUpload(screenshot)).text(), '341x4096')
  assert.deepEqual(decoded.at(-1), { resizeWidth: 341, resizeHeight: 4096, resizeQuality: 'high' })
  const bitmapDecoder = globalThis.createImageBitmap
  globalThis.createImageBitmap = async () => { throw new Error('Resize options unavailable') }
  globalThis.Image = class {
    naturalWidth = 200
    naturalHeight = 2400
    set src(value) { queueMicrotask(() => this.onload()) }
  }
  const downsampled = await prepareImageUpload(screenshot)
  assert.notEqual(downsampled, screenshot, 'A downsampled Image decoder cannot return an oversized encoded original')
  assert.equal(await downsampled.text(), '200x2400')
  globalThis.createImageBitmap = async () => ({ width: 3000, height: 1000, close() {} })
  const unknownHeader = new Blob([new Uint8Array(32)], { type: 'image/jpeg' })
  const decodedUnknown = await prepareImageUpload(unknownHeader)
  assert.notEqual(decodedUnknown, unknownHeader, 'Unknown headers cannot prove the encoded original is bounded')
  assert.equal(await decodedUnknown.text(), '3000x1000')
  globalThis.createImageBitmap = bitmapDecoder
  globalThis.Image = class { constructor() { throw new Error('Unexpected full-size fallback') } }

  const attachments = await import(new URL('services/attachments.ts', root))
  const genericImage = new File([screenshot], 'Android-Screenshot.PNG', { type: 'application/octet-stream' })
  assert.equal(attachments.resolveMimeType(genericImage), 'image/png')
  assert.equal(attachments.isImage(attachments.resolveMimeType(genericImage)), true)
  assert.equal(attachments.resolveMimeType(new File(['text'], 'notes.txt', { type: 'application/octet-stream' })), 'application/octet-stream')
  assert.equal(attachments.resolveMimeType(new File(['text'], 'notes.txt', { type: 'text/plain' })), 'text/plain')

  const { streamMessage } = await import(new URL('services/api/client.ts', root))
  const settings = await import(new URL('services/settings.ts', root))
  const store = await import(new URL('services/chat/store.ts', root))
  const drafts = await import(new URL('services/chat/drafts.ts', root))
  const db = await import(new URL('services/chat/db.ts', root))
  const calls = []
  const tool = { type: 'deepseek_read_url', name: 'deepseek_read_url' }
  const body = { model: 'deepseek-v4-pro', system: 'role', messages: [
    { role: 'user', content: 'prior' },
    { role: 'assistant', content: [{ type: 'text', text: 'preserve this answer' }, { type: 'server_tool_use', id: 'link', name: 'deepseek_read_url', kind: 'read_link', input: { action: 'read_link', url: 'https://example.test' } }] },
    { role: 'user', content: 'hello' },
  ], tools: [tool], title: { enabled: true }, thinking: { type: 'disabled' }, safety_check: { level: 'high' } }
  const reply = model => new Response([
    { type: 'message_start', message: { id: 'test', model } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'reply' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null } },
    { type: 'message_stop' },
  ].map(value => `data: ${JSON.stringify(value)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } })
  globalThis.fetch = async (url, init) => {
    const request = JSON.parse(init.body)
    calls.push(request)
    return reply(request.model)
  }
  const connection = { baseUrl: 'https://api.deepseek.com', protocol: 'deepseek' }
  for (const model of ['deepseek-v4-pro', 'claude-opus-4-6', 'deepseek-flash']) {
    for await (const event of streamMessage('fixture-key', { ...body, model }, new AbortController().signal, connection)) assert.ok(event.type)
  }
  for (const request of [calls[1]]) {
    assert.deepEqual(request.tools, [])
    assert.equal(request.title, undefined)
    assert.deepEqual(request.messages[1].content, [{ type: 'text', text: 'preserve this answer' }])
    assert.deepEqual(request.safety_check, { level: 'high' })
  }
  for (const request of [calls[0], calls[2]]) {
    assert.deepEqual(request.tools, [tool])
    assert.deepEqual(request.messages, body.messages)
    assert.deepEqual(request.title, { enabled: true })
  }
  assert.deepEqual(calls[2].tools, [tool])
  assert.equal(calls[2].title.enabled, true)
  assert.equal(body.messages[1].content.length, 2, 'Adapting an outbound request does not mutate stored tool history')

  await store.initChat()
  settings.setApiConnection({ apiKey: 'fixture-key', apiBaseUrl: connection.baseUrl, apiProtocol: connection.protocol, model: 'deepseek-v4-pro', models: ['deepseek-v4-pro'] })
  settings.setSearch(false)
  const idle = () => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { unsubscribe(); reject(new Error('Store did not settle')) }, 5000)
    const inspect = state => {
      if (!Object.keys(state.streaming).length) { clearTimeout(timeout); unsubscribe(); resolve() }
    }
    const unsubscribe = store.useChatStore.subscribe(inspect)
    inspect(store.useChatStore.getState())
  })
  drafts.setDraftText(null, 'plain question with search off')
  assert.equal(store.sendMessage(null), true)
  await idle()
  assert.deepEqual(calls.at(-1).tools, [tool])
  assert.equal(calls.at(-1).title.enabled, true, 'New Pro chats use official title generation and retain link reading with search off')

  settings.setApiConnection({ apiKey: 'fixture-key', apiBaseUrl: connection.baseUrl, apiProtocol: connection.protocol, model: 'deepseek-flash', models: ['deepseek-flash'] })
  const sessionId = 'old-large-image'
  const oldFile = { id: 'original-image', serverId: 'old-large-file', name: 'large.png', size: original.size, mimeType: 'image/png', isImage: true }
  const session = { id: sessionId, title: 'test', createdAt: 1, updatedAt: 2, messages: [
    { id: 'u', role: 'user', content: 'original image', files: [oldFile], createdAt: 1 },
    { id: 'a', role: 'assistant', model: 'deepseek-flash', prefix: true, status: 'done', blocks: [{ type: 'text', text: 'prior image answer' }], createdAt: 2 },
  ] }
  await db.saveSession(session, [{ id: oldFile.id, blob: original }])
  store.useChatStore.setState(state => ({ sessions: [...state.sessions, session] }))
  await store.openHistoryMatch(sessionId, null)
  let sent = 0, uploaded = 0
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/files')) {
      uploaded++
      const file = init.body.get('file')
      assert.equal(file.type, 'image/png')
      assert.equal(await file.text(), '4096x819')
      return Response.json({ id: 'resized-file' })
    }
    const request = JSON.parse(init.body)
    const index = request.messages.findIndex(message => Array.isArray(message.content) && message.content[0]?.type === 'image')
    assert.ok(index >= 0, 'The retry retains the historical image')
    if (++sent === 1) {
      assert.equal(request.messages[index].content[0].source.file_id, 'old-large-file')
      return Response.json({ error: { message: `messages.${index}.content.0: The image is too large to process: its width and height must each be at most 4096 pixels.` } }, { status: 400 })
    }
    assert.equal(request.messages[index].content[0].source.file_id, 'resized-file')
    return reply(request.model)
  }
  drafts.setDraftText(sessionId, 'continue text')
  assert.equal(store.sendMessage(sessionId), true)
  await idle()
  assert.equal(sent, 2)
  assert.equal(uploaded, 1)
  const preserved = await db.loadSession(sessionId)
  assert.equal(preserved.messages.at(-1).status, 'done')
  assert.equal(preserved.messages[0].files[0].serverId, 'resized-file')
  assert.equal(preserved.messages[0].files[0].size, original.size)
  assert.deepEqual(await (await db.loadFile(oldFile.id)).arrayBuffer(), await original.arrayBuffer())
  const missingId = 'missing-original-image'
  const missingFile = { ...oldFile, id: 'missing-original', serverId: 'unavailable-original' }
  const missingSession = { ...session, id: missingId, messages: [
    { ...session.messages[0], files: [missingFile] }, session.messages[1],
  ] }
  await db.saveSession(missingSession)
  store.useChatStore.setState(state => ({ sessions: [...state.sessions, missingSession] }))
  await store.openHistoryMatch(missingId, null)
  let unrecoverableCalls = 0
  globalThis.fetch = async (url, init) => {
    unrecoverableCalls++
    assert.equal(String(url).endsWith('/messages'), true)
    const request = JSON.parse(init.body)
    const index = request.messages.findIndex(message => Array.isArray(message.content) && message.content[0]?.type === 'image')
    return Response.json({ error: { message: `messages.${index}.content.0: The image is too large to process: its width and height must each be at most 4096 pixels.` } }, { status: 400 })
  }
  drafts.setDraftText(missingId, 'cannot recover missing original')
  assert.equal(store.sendMessage(missingId), true)
  await idle()
  assert.equal(unrecoverableCalls, 1)
  const notDeleted = await db.loadSession(missingId)
  assert.equal(notDeleted.messages.at(-1).error.localMessage.key, 'replyImageTooLarge')
  assert.deepEqual(notDeleted.messages[0].files[0], missingFile)

  const rejectedId = 'still-rejected-after-image-repair'
  const rejectedFile = { ...oldFile, id: 'rejected-original', serverId: 'rejected-large-file' }
  const rejectedSession = { ...session, id: rejectedId, messages: [
    { ...session.messages[0], files: [rejectedFile] }, session.messages[1],
  ] }
  await db.saveSession(rejectedSession, [{ id: rejectedFile.id, blob: original }])
  store.useChatStore.setState(state => ({ sessions: [...state.sessions, rejectedSession] }))
  await store.openHistoryMatch(rejectedId, null)
  let rejectedCalls = 0, repairedUploads = 0
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/files')) {
      repairedUploads++
      assert.equal(await init.body.get('file').text(), '4096x819')
      return Response.json({ id: rejectedFile.serverId })
    }
    rejectedCalls++
    const request = JSON.parse(init.body)
    const index = request.messages.findIndex(message => Array.isArray(message.content) && message.content[0]?.type === 'image')
    assert.ok(index >= 0, 'An unsuccessful resize retry must keep the image in context')
    // Some gateways return a structured error with HTTP 200 instead of an error status.
    return Response.json({ error: { message: `messages.${index}.content.0: The image is too large to process: its width and height must each be at most 8192 pixels.` } })
  }
  drafts.setDraftText(rejectedId, 'reject the repaired image again')
  assert.equal(store.sendMessage(rejectedId), true)
  await idle()
  assert.equal(rejectedCalls, 2, 'A still-rejected image gets only its initial request and one repair retry')
  assert.equal(repairedUploads, 1, 'A pixel-limit rejection cannot repeatedly upload the same local original')
  const rejected = await db.loadSession(rejectedId)
  assert.equal(rejected.messages.at(-1).error.localMessage.key, 'replyImageTooLarge')
  assert.equal(rejected.messages[0].files[0].serverId, rejectedFile.serverId)
  assert.deepEqual(await (await db.loadFile(rejectedFile.id)).arrayBuffer(), await original.arrayBuffer())
  console.log(JSON.stringify({ passed: true, checks: [
    'Pro and Flash retain the official DeepSeek tools, tool history and titles; the existing Opus compatibility path remains separate.',
    'A real Pro send with search off retains the official read-link tool and auto-title request.',
    'Only oversized outbound copies are resized; decoder targets and canvas are bounded, and normal-size originals skip decoding.',
    'Long screenshots over 8192 pixels, downsampled Image fallback and unknown-header ImageBitmap output never upload an oversized original; generic Android image MIME is classified correctly.',
    'A real store request with an old oversized file ID reuploads a bounded copy once, retains the image in the retry and preserves the original in IndexedDB.',
    'Repeated pixel-limit rejection over HTTP 200 JSON stops after one local image repair, preserves the attachment and original, and shows the localized size error.',
  ], scope: 'Actual API/store/upload/IndexedDB paths with synthetic byte headers and mocked image decoding; no real API calls or keys. Real browser image decoding requires separate acceptance.' }, null, 2))
} finally {
  hooks.deregister()
}
