import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { registerHooks, stripTypeScriptTypes } from 'node:module'
import { fileURLToPath } from 'node:url'

const root = new URL('../src/', import.meta.url)
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL?.startsWith(root.href)) {
      const candidate = new URL(specifier.slice(0, -3) + '.ts', context.parentURL)
      if (existsSync(fileURLToPath(candidate))) return { url: candidate.href, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url.startsWith(root.href) && url.endsWith('.ts')) return {
      format: 'module', source: stripTypeScriptTypes(readFileSync(new URL(url), 'utf8'), { mode: 'transform' }), shortCircuit: true,
    }
    return nextLoad(url, context)
  },
})
await import('fake-indexeddb/auto')
const saved = new Map()
globalThis.localStorage = { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value), removeItem: key => saved.delete(key) }
globalThis.window = new EventTarget()
globalThis.document = Object.assign(new EventTarget(), { visibilityState: 'hidden' })
Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh-CN' }, configurable: true })
globalThis.__API_ORIGIN__ = 'https://api.deepseek.com'
globalThis.requestAnimationFrame = callback => setTimeout(callback, 0)
globalThis.cancelAnimationFrame = clearTimeout

const settings = await import(new URL('services/settings.ts', root))
const store = await import(new URL('services/chat/store.ts', root))
const db = await import(new URL('services/chat/db.ts', root))
const drafts = await import(new URL('services/chat/drafts.ts', root))
const attachments = await import(new URL('services/attachments.ts', root))
const { toRequestMessages } = await import(new URL('services/chat/reply.ts', root))
const { fitRequestHistory } = await import(new URL('services/chat/contextLimit.ts', root))
const config = { apiKey: 'attachment-cost-fixture', apiBaseUrl: 'https://api.deepseek.com', apiProtocol: 'deepseek', model: 'deepseek-flash', models: ['deepseek-flash'] }
const uploads = [], requests = [], checks = []
let uploadFailure = false
let chatFailure = null
const wait = async predicate => {
  const deadline = Date.now() + 10_000
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error('Attachment cost regression timed out')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}
const stream = () => new Response([
  { type: 'message_start', message: { id: 'cost-fixture', model: config.model } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '已读取本轮上下文。' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
  { type: 'message_stop' },
].map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
globalThis.fetch = async (url, init) => {
  assert.equal(new Headers(init.headers).get('x-api-key'), config.apiKey)
  if (String(url).endsWith('/files')) {
    assert.ok(init.body instanceof FormData)
    uploads.push({ url: String(url), purpose: init.body.get('purpose'), file: init.body.get('file') })
    if (uploadFailure) {
      uploadFailure = false
      return Response.json({ error: { message: 'Fixture temporary upload failure' } }, { status: 503 })
    }
    return Response.json({ id: `file-api-cost-${uploads.length}`, type: 'file', size_bytes: 12, created_at: '2026-11-20T00:00:00Z', filename: 'fixture.docx', mime_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })
  }
  assert.equal(String(url), 'https://api.deepseek.com/anthropic/v1/messages')
  requests.push(JSON.parse(init.body))
  return chatFailure ? Response.json({ error: { message: chatFailure } }, { status: 400 }) : stream()
}
const documents = body => body.messages.flatMap(message => Array.isArray(message.content) ? message.content.filter(block => block.type === 'document') : [])
const lastReply = id => store.useChatStore.getState().sessionCache[id].messages.at(-1)
const send = async (id, text = '请继续。') => {
  drafts.setDraftText(id, text)
  assert.equal(store.sendMessage(id), true)
  const target = id ?? store.useChatStore.getState().activeId
  await wait(() => !store.useChatStore.getState().streaming[target])
  return target
}
const user = (id, files, content = '请记住文件。') => ({ id, role: 'user', files, content, createdAt: 1 })
const assistant = id => ({ id, role: 'assistant', model: config.model, prefix: true, status: 'done', stopReason: 'end_turn', blocks: [{ type: 'text', text: '好的，已经了解。' }], createdAt: 2 })
const seed = async (id, messages, files = []) => {
  const session = { id, title: '合成附件费用回归', createdAt: 1, updatedAt: 2, messages }
  await db.saveSession(session, files)
  store.useChatStore.setState(state => ({ sessionCache: { ...state.sessionCache, [id]: session }, sessions: [...state.sessions, { id, title: session.title, createdAt: 1, updatedAt: 2 }] }))
}

try {
  settings.setApiConnection(config)
  settings.setThinking(false)
  settings.setSearch(false)
  settings.setContextMemoryEnabled(false)
  settings.setGeneration({})
  await store.initChat()
  assert.equal(attachments.getUploadPurpose('menu.docx', false), 'text_recognition')
  assert.equal(attachments.getUploadPurpose('report.pdf', false), 'text_recognition')
  assert.equal(attachments.getUploadPurpose('slides.pptx', false, 'rich_layout_recognition'), 'rich_layout_recognition')
  assert.equal(attachments.getUploadPurpose('notes.txt', false, 'rich_layout_recognition'), 'user_data')
  assert.equal(attachments.getUploadPurpose('photo.jpg', true, 'rich_layout_recognition'), null)
  await attachments.uploadAttachment(config.apiKey, 'default-cost-document', new Blob(['doc']), 'menu.docx', false)
  assert.equal(uploads.at(-1).purpose, 'text_recognition')
  await attachments.uploadAttachment(config.apiKey, 'rich-cost-document', new Blob(['doc']), 'report.pdf', false, undefined, 'rich_layout_recognition')
  assert.equal(uploads.at(-1).purpose, 'rich_layout_recognition')
  checks.push('Office/PDF documents default to text-only parsing; image/chart parsing is explicit and does not alter plain text or image uploads')

  uploadFailure = true
  assert.equal(drafts.addDraftFiles(null, [new File(['doc'], 'draft-menu.docx')], config.apiKey, 'rich_layout_recognition'), null)
  const draftFile = drafts.getDraft(null).attachments[0]
  await wait(() => attachments.useUploads.getState().tasks[draftFile.id]?.status === 'error')
  assert.equal(draftFile.uploadPurpose, 'rich_layout_recognition')
  drafts.retryDraftAttachment(null, draftFile.id, config.apiKey)
  await wait(() => attachments.useUploads.getState().tasks[draftFile.id]?.status === 'done')
  assert.equal(uploads.at(-1).purpose, 'rich_layout_recognition')
  assert.equal(drafts.prepareDraftMessage(drafts.getDraft(null), attachments.useUploads.getState().tasks).files[0].uploadPurpose, 'rich_layout_recognition')
  const uploadsAfterDraft = uploads.length
  const chatId = await send(null, '请根据美食库回答。')
  assert.equal(lastReply(chatId).status, 'done')
  assert.equal(uploads.length, uploadsAfterDraft)
  const persisted = await db.loadSession(chatId)
  const savedFile = persisted.messages[0].files[0]
  assert.equal(savedFile.uploadPurpose, 'rich_layout_recognition')
  assert.equal(savedFile.serverId, attachments.useUploads.getState().tasks[draftFile.id].serverId)
  await send(chatId, '再推荐一道菜。')
  assert.equal(uploads.length, uploadsAfterDraft)
  assert.equal(documents(requests.at(-1)).length, 1)
  assert.equal(documents(requests.at(-1))[0].source.file_id, savedFile.serverId)
  checks.push('Selected parsing mode survives draft retries and IndexedDB persistence; later chat turns reuse the uploaded file ID without re-uploading or reparsing')

  assert.equal(await store.setFileContextExcluded(chatId, draftFile.id, true), true)
  const uploadsBeforePause = uploads.length
  await send(chatId, '现在只聊文字。')
  assert.equal(documents(requests.at(-1)).length, 0)
  assert.equal(uploads.length, uploadsBeforePause)
  assert.equal((await db.loadSession(chatId)).messages[0].files[0].serverId, savedFile.serverId)
  assert.equal(await store.setFileContextExcluded(chatId, draftFile.id, false), true)
  await send(chatId, '重新看看美食库。')
  assert.equal(uploads.length, uploadsBeforePause)
  assert.equal(documents(requests.at(-1))[0].source.file_id, savedFile.serverId)
  checks.push('Pausing document references omits the document while retaining its original file ID; resuming restores that ID without another upload')

  const pausedFile = { id: 'paused-never-upload', serverId: null, name: 'paused.docx', size: 12, isImage: false, mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', contextExcluded: true }
  await seed('paused-import-document', [user('paused-u', [pausedFile]), assistant('paused-a')], [{ id: pausedFile.id, blob: new Blob(['doc']) }])
  const uploadsBeforePausedImport = uploads.length
  await send('paused-import-document')
  assert.equal(uploads.length, uploadsBeforePausedImport, 'An excluded imported document must not trigger a paid background parse')
  assert.equal(documents(requests.at(-1)).length, 0)
  checks.push('An excluded imported document with only a local original does not trigger a background upload or parsing charge')

  const duplicate = { id: 'duplicate-cost-document', serverId: 'file-api-duplicate-cost', name: 'shared.docx', size: 12, isImage: false, mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }
  await seed('duplicate-documents', [user('dup-u1', [duplicate]), assistant('dup-a1'), user('dup-u2', [duplicate]), assistant('dup-a2')])
  await send('duplicate-documents')
  assert.equal(documents(requests.at(-1)).length, 1, 'Repeated history references must include a full document at most once per request')
  assert.equal(documents(requests.at(-1))[0].source.file_id, duplicate.serverId)
  const fittedDocument = fitRequestHistory({ model: config.model, system: 'System', tools: [], messages: toRequestMessages(
    [user('fit-old-u', [duplicate], '旧文字'.repeat(4000)), assistant('fit-old-a')],
    user('fit-current-u', [duplicate], '本轮明确引用同一份文件。'),
    undefined, false
  ) }, 1)
  assert.equal(fittedDocument.messages.length, 1)
  assert.equal(documents(fittedDocument).length, 1, 'Trimming the old duplicate turn must retain the current question’s document reference')
  assert.equal(documents(fittedDocument)[0].source.file_id, duplicate.serverId)
  checks.push('Repeated references to one document in chat history are deduplicated within the request instead of billing its full text multiple times')

  const unconfirmed = { ...duplicate, id: 'unconfirmed-import-document', serverId: null, name: 'unconfirmed.docx' }
  await seed('unconfirmed-import-history', [user('unconfirmed-old-u', [unconfirmed]), assistant('unconfirmed-old-a')], [{ id: unconfirmed.id, blob: new Blob(['doc']) }])
  const uploadsBeforeUnconfirmed = uploads.length
  const requestsBeforeUnconfirmed = requests.length
  await send('unconfirmed-import-history')
  assert.equal(uploads.length, uploadsBeforeUnconfirmed, 'A historical Office original must not be silently submitted for paid parsing')
  assert.equal(requests.length, requestsBeforeUnconfirmed, 'An unconfirmed historical document must not be silently omitted from the requested context')
  assert.equal(lastReply('unconfirmed-import-history').error.localMessage.key, 'replyDocumentNeedsConfirmation')
  const preservedUnconfirmed = await db.loadSession('unconfirmed-import-history')
  assert.equal(preservedUnconfirmed.messages[1].blocks[0].text, '好的，已经了解。')
  assert.equal(preservedUnconfirmed.messages[0].files[0].serverId, null)
  assert.ok(await db.loadFile(unconfirmed.id), 'The local original remains available for a user-confirmed upload')
  await seed('unconfirmed-current-document', [user('unconfirmed-current-u', [{ ...unconfirmed, id: 'unconfirmed-current-original' }]), { ...assistant('unconfirmed-current-a'), status: 'error', error: { kind: 'upload', message: '' } }], [{ id: 'unconfirmed-current-original', blob: new Blob(['doc']) }])
  const requestsBeforeUnconfirmedCurrent = requests.length
  store.retryUpload('unconfirmed-current-document', 'unconfirmed-current-a')
  await wait(() => !store.useChatStore.getState().streaming['unconfirmed-current-document'])
  assert.equal(uploads.length, uploadsBeforeUnconfirmed)
  assert.equal(requests.length, requestsBeforeUnconfirmedCurrent)
  assert.equal(lastReply('unconfirmed-current-document').error.localMessage.key, 'replyDocumentNeedsConfirmation')
  checks.push('Unconfirmed local Office originals never trigger paid automatic parsing or silent context loss: history and current questions request explicit upload while originals and prior answers remain intact')

  const expired = { ...duplicate, id: 'expired-cost-document', serverId: 'file-api-expired-cost', uploadPurpose: 'text_recognition' }
  await seed('expired-document', [user('expired-u', [expired]), assistant('expired-a')], [{ id: expired.id, blob: new Blob(['doc']) }])
  chatFailure = 'messages.0.content.0.source.file_id: invalid file_id file-api-expired-cost'
  const beforeExpired = { uploads: uploads.length, requests: requests.length }
  await send('expired-document')
  assert.equal(uploads.length, beforeExpired.uploads, 'An expired paid document must not be automatically reparsed')
  assert.equal(requests.length, beforeExpired.requests + 1)
  assert.equal(lastReply('expired-document').error.localMessage.key, 'replyDocumentExpired')
  checks.push('Expired document references stop with an actionable error and never automatically re-upload a document that could incur another parsing fee')

  chatFailure = null
  await seed('current-document-too-long', [user('length-u', [], '旧问题'.repeat(5000)), assistant('length-a')])
  assert.equal(drafts.addDraftFiles('current-document-too-long', [new File(['long-doc'], 'large.docx')], config.apiKey), null)
  const currentFile = drafts.getDraft('current-document-too-long').attachments[0]
  await wait(() => attachments.useUploads.getState().tasks[currentFile.id]?.status === 'done')
  const beforeLength = { uploads: uploads.length, requests: requests.length }
  chatFailure = 'User input too long, 95000 tokens exceeds max 32000 tokens'
  await send('current-document-too-long', '请先阅读这份文档。')
  assert.equal(requests.length, beforeLength.requests + 1, 'A request containing the oversized current document must not loop through full-document retries')
  assert.equal(uploads.length, beforeLength.uploads)
  assert.equal(lastReply('current-document-too-long').error.localMessage.key, 'replyDocumentContextLimit')
  checks.push('A current document rejected for context length returns a document-specific error after one chat request, with no automatic re-upload or repeated full-document attempts')

  console.log(JSON.stringify({ passed: true, checks, scope: 'Actual draft, upload queue, chat store, request serialization, API parser and IndexedDB modules with synthetic documents and mocked network only; no real model calls or billing.' }, null, 2))
} finally {
  hooks.deregister()
}
