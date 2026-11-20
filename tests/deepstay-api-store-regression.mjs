import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { registerHooks, stripTypeScriptTypes } from 'node:module'
import { fileURLToPath } from 'node:url'

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
    if (url.startsWith(sourceRoot.href) && url.endsWith('.ts')) return {
      format: 'module', source: stripTypeScriptTypes(readFileSync(new URL(url), 'utf8'), { mode: 'transform' }), shortCircuit: true,
    }
    return nextLoad(url, context)
  },
})
await import(new URL('../node_modules/fake-indexeddb/auto/index.mjs', import.meta.url))
const saved = new Map()
globalThis.localStorage = { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value), removeItem: key => saved.delete(key) }
globalThis.window = new EventTarget()
globalThis.document = Object.assign(new EventTarget(), { visibilityState: 'visible' })
Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh-CN' }, configurable: true })
globalThis.__API_ORIGIN__ = 'https://api.deepseek.com'
globalThis.requestAnimationFrame = callback => setTimeout(() => callback(Date.now()), 0)
globalThis.cancelAnimationFrame = token => clearTimeout(token)
const originalA = { apiKey: 'provider-a-fixture', apiBaseUrl: 'https://provider-a.example.test/v1', apiProtocol: 'openai', model: 'model-a-selected', models: ['model-a-selected'] }
const changedB = { apiKey: 'provider-b-fixture', apiBaseUrl: 'https://provider-b.example.test/v1', apiProtocol: 'openai', model: 'model-b-selected', models: ['model-b-selected'] }
const settings = await import(new URL('services/settings.ts', sourceRoot))
const store = await import(new URL('services/chat/store.ts', sourceRoot))
const drafts = await import(new URL('services/chat/drafts.ts', sourceRoot))
const db = await import(new URL('services/chat/db.ts', sourceRoot))
const { getReplyMetrics, getTokenRate } = await import(new URL('services/chat/replyMetrics.ts', sourceRoot))
const { estimateRequestParts, estimateRequestTokens } = await import(new URL('services/chat/contextMemory.ts', sourceRoot))
const checks = [], requests = []
const encoder = new TextEncoder()
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body)
  requests.push({ url: String(url), key: new Headers(init.headers).get('Authorization'), body })
  const expected = requests.length === 1 ? originalA : changedB
  assert.equal(url, `${expected.apiBaseUrl}/chat/completions`)
  assert.equal(new Headers(init.headers).get('Authorization'), `Bearer ${expected.apiKey}`)
  assert.equal(body.model, expected.model)
  const content = requests.length === 1 ? '第一个供应商完整回答' : '第二个供应商完整回答'
  return new Response(new ReadableStream({ start(controller) {
    controller.enqueue(encoder.encode(`data: ${JSON.stringify({ id: 'store-reply', model: body.model, choices: [{ index: 0, delta: { reasoning_content: '认真思考' }, finish_reason: null }] })}\n\n`))
    controller.enqueue(encoder.encode(`data: ${JSON.stringify({ id: 'store-reply', choices: [{ index: 0, delta: { content }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`))
    controller.close()
  } }), { headers: { 'Content-Type': 'text/event-stream' } })
}
const waitIdle = () => new Promise((resolve, reject) => {
  const timeout = setTimeout(() => { unsubscribe(); reject(new Error('Store request failed to settle')) }, 5000)
  const inspect = state => {
    if (Object.keys(state.streaming).length === 0) {
      clearTimeout(timeout)
      unsubscribe()
      resolve()
    }
  }
  const unsubscribe = store.useChatStore.subscribe(inspect)
  inspect(store.useChatStore.getState())
})
await store.initChat()
settings.setApiConnection(originalA)
settings.setThinking(true)
drafts.setDraftText(null, '第一条问题')
assert.equal(store.sendMessage(null), true)
const firstId = store.useChatStore.getState().activeId
assert.ok(store.useChatStore.getState().streaming[firstId])
assert.equal(requests.length, 0)
const visibleReasoning = []
const unsubscribeReasoning = store.useChatStore.subscribe((state) => {
  const reply = state.sessionCache[firstId]?.messages[1]
  if (state.streaming[firstId] && reply?.status === 'streaming') {
    visibleReasoning.push({
      thinking: reply.blocks.find(block => block.type === 'thinking')?.thinking,
      answer: reply.blocks.find(block => block.type === 'text')?.text,
    })
  }
})
// This change occurs before prepareFiles' awaited work settles. The first turn
// must remain a coherent URL/key/model snapshot; the next turn uses the new one.
settings.setApiConnection(changedB)
settings.setGeneration({
  system: '保持角色设定',
  temperature: 0.7,
  topP: 0.9,
  maxTokens: 640,
  contextTokens: 2048,
  frequencyPenalty: 0,
  presencePenalty: -0.3,
  stop: ['结束标记', '结束标记'],
})
await waitIdle()
unsubscribeReasoning()
if (requests.length === 0) console.log(store.useChatStore.getState().sessionCache[firstId].messages[1])
assert.equal(requests.length, 1)
assert.equal(requests[0].body.max_tokens, undefined)
assert.notEqual(requests[0].body.messages[0].content, '保持角色设定')
const first = store.useChatStore.getState().sessionCache[firstId]
assert.equal(first.messages[1].model, originalA.model)
assert.equal(first.messages[1].status, 'done')
assert.equal(first.messages[1].blocks.filter(block => block.type === 'text').map(block => block.text).join(''), '第一个供应商完整回答')
assert.ok(visibleReasoning.some(({ thinking, answer }) => thinking === '认真思考' && answer === undefined))
checks.push('A real sendMessage snapshots selected URL, key and model before async preparation; changing provider settings during that await never mixes old model with a new destination/key')
checks.push('The first send is accepted before network preparation and shows reasoning before the answer even when both stream fragments are already buffered')

drafts.setDraftText(firstId, '继续对话')
assert.equal(store.sendMessage(firstId), true)
await waitIdle()
assert.equal(requests.length, 2)
assert.equal(requests[1].body.messages.some(message => message.content === '第一条问题'), true)
assert.equal(requests[1].body.messages.some(message => message.content === '第一个供应商完整回答'), true)
assert.equal(requests[1].body.messages[requests[1].body.messages.length - 1].content, '继续对话')
assert.deepEqual(requests[1].body.messages[0], { role: 'system', content: '保持角色设定' })
const { temperature, top_p, max_tokens, frequency_penalty, presence_penalty, stop, stream } = requests[1].body
assert.deepEqual(
  { temperature, top_p, max_tokens, frequency_penalty, presence_penalty, stop, stream },
  { temperature: 0.7, top_p: 0.9, max_tokens: 640, frequency_penalty: 0, presence_penalty: -0.3, stop: ['结束标记'], stream: true }
)
assert.equal(requests[1].body.contextTokens, undefined)
const { useSettings: reloadedSettings } = await import(new URL('services/settings.ts?generation-reload', sourceRoot))
assert.equal(reloadedSettings.getState().generation.contextTokens, 2048)
assert.equal(reloadedSettings.getState().generation.system, '保持角色设定')
settings.setGeneration({})
assert.equal(saved.has('deepstay:generation'), false)
checks.push('Generation settings persist locally and are snapshotted per send; OpenAI receives only the configured request fields and streaming stays enabled')
const second = store.useChatStore.getState().sessionCache[firstId]
assert.equal(second.messages[3].model, changedB.model)
assert.equal(second.messages[3].status, 'done')
assert.equal(second.messages[3].blocks.filter(block => block.type === 'thinking').map(block => block.thinking).join(''), '认真思考')
assert.equal(second.messages[3].blocks.filter(block => block.type === 'text').map(block => block.text).join(''), '第二个供应商完整回答')
const stored = await db.loadSession(firstId)
assert.equal(stored.messages.length, 4)
assert.equal(stored.messages[3].model, changedB.model)
checks.push('The next real turn uses the new selected provider/model, includes the full prior text history, renders thinking plus answer and persists both turns in IndexedDB')

// Cancel while the UI has accepted the input but the next task has not started preflight.
drafts.setDraftText(firstId, '立即停止')
assert.equal(store.sendMessage(firstId), true)
assert.equal(store.sendMessage(firstId), false)
store.stopReply(firstId)
await waitIdle()
assert.equal(requests.length, 2)
const stopped = await db.loadSession(firstId)
assert.equal(stopped.messages.at(-2).content, '立即停止')
assert.equal(stopped.messages.at(-1).status, 'stopped')
checks.push('An immediate stop prevents starting a request and preserves the accepted question')

const longId = 'long-deepseek-history'
const title = '长历史验收'
const rounds = 1200
const messages = Array.from({ length: rounds * 2 }, (_, index) => {
  const common = {
    id: String(index),
    createdAt: index,
    parentId: index > 0 ? String(index - 1) : null,
    selectedChildId: index + 1 < rounds * 2 ? String(index + 1) : undefined,
  }
  return index % 2
    ? { ...common, role: 'assistant', status: 'done', blocks: [{ type: 'text', text: '旧回答' }] }
    : {
        ...common,
        role: 'user',
        content: '旧问题',
        files: index === 0
          ? [{ id: 'image', serverId: 'fixture-image', name: 'example.png', size: 128, isImage: true, mimeType: 'image/png' }]
          : [],
      }
})
const summary = { id: longId, title, createdAt: 0, updatedAt: rounds * 2 }
await db.saveSession({ ...summary, messages, rootMessageId: '0' })
store.useChatStore.setState(state => ({ sessions: [...state.sessions, summary] }))
await store.openHistoryMatch(longId, null)
const originalRevision = (await db.loadMemorySnapshot(longId)).state.sourceRevision
settings.setApiConnection({
  apiKey: 'deepseek-fixture',
  apiBaseUrl: 'https://api.deepseek.com',
  apiProtocol: 'deepseek',
  model: 'deepseek-v4-pro',
  models: ['deepseek-v4-pro'],
})
const officialReply = (body) => {
  const frames = [
    { type: 'message_start', message: { id: 'fixture', model: body.model } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '新回答' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null } },
    { type: 'message_stop' },
  ]
  return new Response(frames.map(payload => `data: ${JSON.stringify(payload)}\n\n`).join(''),
    { headers: { 'Content-Type': 'text/event-stream' } })
}
const officialRequests = []
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body)
  officialRequests.push({ url: String(url), body })
  return officialReply(body)
}
drafts.setDraftText(longId, '续聊')
assert.equal(store.sendMessage(longId), true)
assert.equal(officialRequests.length, 0)
await waitIdle()
store.regenerateReply(longId)
await waitIdle()
assert.equal(officialRequests.length, 2)
for (const request of officialRequests) {
  assert.equal(request.url, 'https://api.deepseek.com/anthropic/v1/messages')
  assert.equal(request.body.messages.length, rounds * 2 + 2) // The latest reminder adds one message.
  assert.equal(request.body.messages[0].content[0].source.file_id, 'fixture-image')
  assert.equal(request.body.messages.at(-1).content, '续聊')
}
const longSaved = await db.loadMemorySnapshot(longId)
assert.equal(longSaved.state.sourceRevision - originalRevision, 4) // One acceptance and one completion save per turn.
assert.equal(longSaved.session.messages.length, rounds * 2 + 3) // The first reply and the regenerated version are retained.
checks.push('A 1200-turn official history keeps its attachment reference and full protocol context on send and regenerate, with one acceptance and one completion save each')

const image = id => ({ id, serverId: `file-api-${id}`, name: `${id}.png`, size: 4, isImage: true, mimeType: 'image/png' })
const badImage = image('unsupported')
const goodImage = image('supported')
const badOnly = image('unsupported-only')
const unclassifiedImage = image('unsupported-unclassified')
const openImageHistory = async (id, questions) => {
  const summary = { id, title: id, createdAt: 1, updatedAt: questions.length * 2 }
  const messages = questions.flatMap(({ content, files }, i) => [
    { id: `q${i}`, parentId: i ? `a${i - 1}` : null, selectedChildId: `a${i}`, createdAt: i * 2 + 1,
      role: 'user', content, files },
    { id: `a${i}`, parentId: `q${i}`, selectedChildId: i + 1 < questions.length ? `q${i + 1}` : undefined,
      createdAt: i * 2 + 2, role: 'assistant', status: 'done',
      latestReminder: '旧提醒', blocks: [{ type: 'text', text: `旧回答${i}` }] },
  ])
  await db.saveSession({ ...summary, messages, rootMessageId: 'q0' },
    questions.flatMap(({ files }) => files.map(({ id }) => ({ id, blob: new Blob(['test'], { type: 'image/png' }) }))))
  store.useChatStore.setState(state => ({ sessions: [...state.sessions, summary] }))
  await store.openHistoryMatch(id, null)
}
const imageRequests = []
const rejected = [badImage.serverId, badOnly.serverId, unclassifiedImage.serverId]
let invalidIndex = false
let errorAfterContent = false
globalThis.fetch = async (_url, init) => {
  const body = JSON.parse(init.body)
  imageRequests.push(body.messages)
  for (const [i, message] of body.messages.entries()) {
    if (message.role !== 'user' || !Array.isArray(message.content)) continue
    const block = message.content.findIndex(item => item.type === 'image' && rejected.includes(item.source.file_id))
    if (block !== -1) {
      const error = {
        message: `messages.${i}.content.${invalidIndex ? message.content.length - 1 : block}: You have uploaded an unsupported image. ` +
          'Please make sure your image is valid and in a supported image format.',
      }
      if (errorAfterContent) {
        const frames = [
          { type: 'message_start', message: { id: 'partial-reply', model: body.model } },
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '已收到的部分' } },
          { type: 'error', error },
        ]
        return new Response(frames.map(payload => `data: ${JSON.stringify(payload)}\n\n`).join(''),
          { headers: { 'Content-Type': 'text/event-stream' } })
      }
      return Response.json({ error }, { status: 400 })
    }
  }
  return officialReply(body)
}
const imageHistory = 'image-errors-in-history'
await openImageHistory(imageHistory, [
  { content: '旧问题', files: [badImage, goodImage] },
  { content: '', files: [badOnly] },
])
drafts.setDraftText(imageHistory, '好')
assert.equal(store.sendMessage(imageHistory), true)
await waitIdle()
assert.equal(imageRequests.length, 3)
assert.equal(imageRequests[0][0].role, 'latest_reminder')
assert.equal(imageRequests[0][1].content[0].source.file_id, badImage.serverId)
assert.equal(imageRequests[1][1].content[0].source.file_id, goodImage.serverId)
assert.equal(imageRequests[1].some(message => message.content[0]?.source?.file_id === badOnly.serverId), true)
assert.deepEqual(imageRequests[2][1].content,
  [{ type: 'image', source: { type: 'file', file_id: goodImage.serverId } }, { type: 'text', text: '旧问题' }])
assert.equal(imageRequests[2].some(message => message.content[0]?.text === '旧回答1'), false)
assert.equal(imageRequests[2].at(-1).content, '好')
const repaired = await db.loadSession(imageHistory)
assert.deepEqual(repaired.messages[0].files, [badImage, goodImage])
assert.deepEqual(repaired.messages[2].files, [badOnly])
assert.equal((await db.loadFile(badImage.id)).size, 4)
assert.equal(repaired.messages.at(-1).status, 'done')
assert.equal(repaired.messages.at(-1).blocks[0].text, '新回答')
checks.push('A text-only send with rejected historical images retries only the offending references and preserves the original files, valid image and question in IndexedDB')

const beforeFollowUp = imageRequests.length
drafts.setDraftText(imageHistory, '继续刚才的对话')
assert.equal(store.sendMessage(imageHistory), true)
await waitIdle()
assert.equal(imageRequests.length, beforeFollowUp + 1)
assert.deepEqual(imageRequests.at(-1)[1].content, imageRequests[2][1].content)
checks.push('Later sends do not resubmit confirmed rejected historical image references on the same connection')

const currentImage = 'image-error-in-current-turn'
await openImageHistory(currentImage, [{ content: '当前问题', files: [badImage] }])
store.regenerateReply(currentImage)
await waitIdle()
assert.equal(imageRequests.length, beforeFollowUp + 2)
const currentRejected = (await db.loadSession(currentImage)).messages.at(-1)
assert.equal(currentRejected.status, 'error')
assert.equal(currentRejected.error.localMessage.key, 'replyUnsupportedImage')
checks.push('An image attached to the current question is never retried without the attachment')

invalidIndex = true
const unknownSource = 'image-error-with-nonimage-index'
await openImageHistory(unknownSource, [{ content: '这是真实的文字块索引', files: [unclassifiedImage] }])
drafts.setDraftText(unknownSource, '好')
assert.equal(store.sendMessage(unknownSource), true)
await waitIdle()
assert.equal(imageRequests.length, beforeFollowUp + 3)
assert.equal((await db.loadSession(unknownSource)).messages.at(-1).error.localMessage.key, 'replyUnsupportedImage')
checks.push('A validation path pointing at a text block cannot remove an image from the request')

invalidIndex = false
errorAfterContent = true
drafts.setDraftText(unknownSource, '继续')
assert.equal(store.sendMessage(unknownSource), true)
await waitIdle()
assert.equal(imageRequests.length, beforeFollowUp + 4)
const partial = (await db.loadSession(unknownSource)).messages.at(-1)
assert.equal(partial.status, 'error')
assert.equal(partial.blocks[0].text, '已收到的部分')
assert.equal(partial.error.localMessage.key, 'replyUnsupportedImage')
checks.push('An image error after the response begins preserves the partial reply and cannot start a new request')

const pureText = 'no-image-request'
await openImageHistory(pureText, [{ content: '这里整段聊天从未发过图', files: [] }])
let pureTextRequests = 0
globalThis.fetch = async (_url, init) => {
  pureTextRequests += 1
  const body = JSON.parse(init.body)
  assert.ok(body.messages.every(message => typeof message.content === 'string' ||
    message.content.every(block => block.type !== 'image')))
  return Response.json({ error: { message: 'messages[0].content[0]: You have uploaded an invalid image.' } }, { status: 422 })
}
drafts.setDraftText(pureText, '好')
assert.equal(store.sendMessage(pureText), true)
await waitIdle()
assert.equal(pureTextRequests, 1)
const noImageError = (await db.loadSession(pureText)).messages.at(-1).error
assert.equal(noImageError.localMessage.key, 'replyImageErrorWithoutAttachment')
checks.push('A provider image rejection on an actual text-only request does not accuse users of attaching an image or secretly repeat the same request')

const { exportArchive } = await import(new URL('services/chat/history/exportArchive.ts', sourceRoot))
const { importHistory } = await import(new URL('services/chat/backup.ts', sourceRoot))
const importedImageSource = 'imported-image-source'
const importedImage = image('bad-import')
await openImageHistory(importedImageSource, [{ content: '归档里有文字还有历史图片', files: [importedImage] }])
await db.saveFiles([{ id: importedImage.id, blob: new Blob([
  Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]),
], { type: 'image/png' }) }])
const archive = await exportArchive([{ ...await db.loadSession(importedImageSource), id: 'external-import-image-source', createdAt: 123456 }])
assert.equal(await importHistory(new File([archive], 'image-history.zip', { type: 'application/zip' })), 1)
const importedId = store.useChatStore.getState().activeId
assert.notEqual(importedId, importedImageSource)
const originalImportedAttachment = (await db.loadSession(importedId)).messages[0].files[0]
assert.equal(originalImportedAttachment.serverId, null)
let uploads = 0
const importedRequests = []
globalThis.fetch = async (url, init) => {
  if (String(url).endsWith('/files')) {
    uploads += 1
    assert.equal(init.body.get('file').type, 'image/png')
    return Response.json({ id: 'file-api-imported-history' })
  }
  const body = JSON.parse(init.body)
  importedRequests.push(body)
  const images = body.messages.flatMap(message => typeof message.content === 'string' ? [] :
    message.content.filter(block => block.type === 'image'))
  if (images.length) {
    assert.deepEqual(images.map(block => block.source.file_id), ['file-api-imported-history'])
    return Response.json({ error: { message: 'You have uploaded an unsupported image.' } }, { status: 400 })
  }
  return officialReply(body)
}
drafts.setDraftText(importedId, '继续导入的聊天')
assert.equal(store.sendMessage(importedId), true)
await waitIdle()
assert.equal(uploads, 1)
assert.equal(importedRequests.length, 2)
assert.ok(importedRequests[1].messages.some(message => message.content === '归档里有文字还有历史图片'))
assert.equal(importedRequests[1].messages.at(-1).content, '继续导入的聊天')
const afterImportReply = await db.loadSession(importedId)
assert.equal(afterImportReply.messages.at(-1).status, 'done')
assert.equal(afterImportReply.messages[0].files[0].id, originalImportedAttachment.id)
assert.equal((await db.loadFile(originalImportedAttachment.id)).size, 8)
checks.push('A real import with an unindexed historical image rejection can continue without compression, while retaining its original image and text')

settings.setApiConnection({ ...changedB, model: 'window-budget-fixture' })
settings.setContextMemoryEnabled(false)
const windowId = 'one-million-token-window'
const oldest = '往'.repeat(680_000)
const recent = '近'.repeat(20_000)
const windowHistory = [
  { role: 'user', id: 'old-q', content: '最早的提问', files: [], createdAt: 1 },
  { role: 'assistant', id: 'old-a', status: 'done', blocks: [{ type: 'text', text: oldest }], createdAt: 2 },
  { role: 'user', id: 'recent-q', content: '近期提问', files: [], createdAt: 3 },
  { role: 'assistant', id: 'recent-a', status: 'done', blocks: [{ type: 'text', text: recent }], createdAt: 4 },
]
await db.saveSession({ id: windowId, title: '窗口验收', createdAt: 1, updatedAt: 4, messages: windowHistory })
store.useChatStore.setState(state => ({ sessions: [...state.sessions, { id: windowId, title: '窗口验收', createdAt: 1, updatedAt: 4 }] }))
await store.openHistoryMatch(windowId, null)
const windowRequests = []
globalThis.fetch = async (_url, init) => {
  windowRequests.push(JSON.parse(init.body))
  return new Response('data: {"choices":[{"index":0,"delta":{"content":"已收到"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
    { headers: { 'Content-Type': 'text/event-stream' } })
}
drafts.setDraftText(windowId, '在默认窗口继续')
assert.equal(store.sendMessage(windowId), true)
await waitIdle()
assert.equal(windowRequests.length, 1)
assert.ok(!windowRequests[0].messages.some(({content}) => content === oldest))
assert.ok(windowRequests[0].messages.some(({content}) => content === recent))
assert.equal(windowRequests[0].messages.at(-1).content, '在默认窗口继续')
settings.setGeneration({ contextTokens: 4096 })
drafts.setDraftText(windowId, '在自定义窗口继续')
assert.equal(store.sendMessage(windowId), true)
await waitIdle()
assert.equal(windowRequests.length, 2)
assert.ok(!windowRequests[1].messages.some(({content}) => content === recent))
assert.equal(windowRequests[1].messages.at(-1).content, '在自定义窗口继续')
assert.equal((await db.loadSession(windowId)).messages[1].blocks[0].text.length, oldest.length)
settings.setGeneration({})
checks.push('The one-million-token default retains eligible history beyond 24k; default and custom windows crop only the outbound copy')

// A real request can be rejected even when the local tokenizer estimate differs from the provider.
settings.setApiConnection({ ...changedB, model: 'length-limit-fixture' })
settings.setContextMemoryEnabled(false)
const limitId = 'context-length-overflow'
const limitHistory = Array.from({ length: 32 }, (_, index) => [
  { role: 'user', id: 'limit-user-' + index, content: '旧问题 ' + index, files: [], createdAt: index },
  { role: 'assistant', id: 'limit-answer-' + index, model: 'length-limit-fixture', status: 'done',
    prefix: false, stopReason: 'end_turn', blocks: [{type:'text',text:'长回复。'.repeat(350)}], createdAt: index },
]).flat()
await db.saveSession({ id: limitId, title: '长度回归', createdAt: 0, updatedAt: 1, messages: limitHistory })
store.useChatStore.setState(state => ({ sessions: [...state.sessions, { id: limitId, title: '长度回归', createdAt: 0, updatedAt: 1 }] }))
await store.openHistoryMatch(limitId, null)
const limitedRequests = []
const rejectLength = () => Response.json({error:{message:'user input too long, 70668 tokens exceeds max 32768 tokens (request_id: fixture)'}},{status:400})
globalThis.fetch = async (_url, init) => {
  const body = JSON.parse(init.body)
  limitedRequests.push(body)
  if (body.messages.length > 25) return rejectLength()
  return new Response('data: ' + JSON.stringify({choices:[{index:0, delta:{content:'成功续聊'}, finish_reason:'stop'}]}) + '\n\ndata: [DONE]\n\n',
    { headers: { 'Content-Type': 'text/event-stream' } })
}
drafts.setDraftText(limitId, '1')
assert.equal(store.sendMessage(limitId), true)
await waitIdle()
assert.equal(limitedRequests.length, 2)
assert.ok(limitedRequests[1].messages.length < limitedRequests[0].messages.length)
assert.equal(limitedRequests[1].messages.at(-1).content, '1')
assert.ok(limitedRequests[1].messages.some(({content})=>content==='旧问题 31'))
assert.ok(!limitedRequests[1].messages.some(({content})=>content==='旧问题 0'))
const [limitedSystem, ...fitMessages] = limitedRequests[1].messages
assert.deepEqual((await db.loadSession(limitId)).messages.at(-1).metrics, estimateRequestParts({
  system: limitedSystem.content,
  tools: [],
  messages: fitMessages.map(({ role, content }) => ({
    role: role === 'system' ? 'latest_reminder' : role,
    content: role === 'assistant' ? [{ type: 'text', text: content }] : content,
  })),
}))
assert.equal((await db.loadSession(limitId)).messages.at(-1).status, 'done')
assert.deepEqual((await db.loadSession(limitId)).messages.slice(0, limitHistory.length).map(({id})=>id), limitHistory.map(({id})=>id))
drafts.setDraftText(limitId, '再继续')
assert.equal(store.sendMessage(limitId), true)
await waitIdle()
assert.equal(limitedRequests.length, 3, 'the same provider/model should reuse the successful budget')
assert.equal(limitedRequests[2].messages.at(-1).content, '再继续')
checks.push('An explicit provider length rejection retries once with fewer complete turns, preserves the latest question and local history, and reuses the smaller successful budget')

settings.setApiConnection({ ...changedB, model: 'always-reject-length' })
let repeatedRejections = 0
const repeatedRequestSizes = []
globalThis.fetch = async (_url, init) => {
  repeatedRejections += 1
  repeatedRequestSizes.push(JSON.parse(init.body).messages.length)
  return rejectLength()
}
drafts.setDraftText(limitId, '不能一直重试')
assert.equal(store.sendMessage(limitId), true)
await waitIdle()
assert.equal(repeatedRejections, 2)
assert.ok(repeatedRequestSizes[1] < repeatedRequestSizes[0])
assert.equal((await db.loadSession(limitId)).messages.at(-1).error.localMessage.key, 'replyContextLimit')
const firstRejectedRequestSize = repeatedRequestSizes[0]
repeatedRequestSizes.length = 0
drafts.setDraftText(limitId, '继续对话')
assert.equal(store.sendMessage(limitId), true)
await waitIdle()
assert.ok(repeatedRequestSizes[0] < firstRejectedRequestSize, 'the next turn starts from the learned smaller budget')
checks.push('A failed context-limit retry still teaches the route a smaller input budget for the next turn without trimming current text')
repeatedRejections = 0
store.newChat()
drafts.setDraftText(null, '唯一的新消息')
assert.equal(store.sendMessage(null), true)
const newSessionId = store.useChatStore.getState().activeId
assert.equal(store.useChatStore.getState().sessionCache[newSessionId]?.linearMessagePath, true)
await waitIdle()
assert.equal(repeatedRejections, 1, 'no shorter retry is possible with only the current question')
checks.push('A repeated overflow stops after one retry, and an irreducible current question is sent only once')

settings.setContextMemoryEnabled(true)
const oversizedText = '这是要完整保留的本轮原文。'.repeat(1600)
const oversizedId = 'overestimated-current-turn'
const fixedMemory = '会话固定设定：住在有蓝色窗户的房子。'
const oversizedSummary = { id: oversizedId, title: oversizedId, createdAt: 1, updatedAt: 2 }
await db.saveSession({
  ...oversizedSummary, messages: limitHistory.slice(0, 2), contextMemory: { fixed: fixedMemory },
})
store.useChatStore.setState(state => ({ sessions: [...state.sessions, oversizedSummary] }))
await store.openHistoryMatch(oversizedId, null)
const oversizedRequests = []
globalThis.fetch = async (_url, init) => {
  const body = JSON.parse(init.body)
  oversizedRequests.push(body)
  return officialReply(body)
}
settings.setApiConnection({
  apiKey: 'fixture-only', apiBaseUrl: 'https://api.deepseek.com', apiProtocol: 'deepseek',
  model: 'deepseek-v4-pro', models: ['deepseek-v4-pro'],
})
drafts.setDraftText(oversizedId, oversizedText)
assert.equal(store.sendMessage(oversizedId), true)
await waitIdle()
assert.equal(oversizedRequests.length, 1, 'large current message goes directly to the provider without summary')
assert.ok(oversizedRequests[0].system.includes(fixedMemory))
assert.deepEqual(oversizedRequests[0].messages.filter(({role}) => role !== 'latest_reminder'),
  [{ role: 'user', content: oversizedText }])
const oversizedSaved = (await db.loadSession(oversizedId)).messages
assert.equal(oversizedSaved.at(-1).status, 'done')
assert.equal(oversizedSaved.at(-2).content, oversizedText)
assert.deepEqual(oversizedSaved.slice(0, 2).map(({id}) => id), limitHistory.slice(0, 2).map(({id}) => id))

store.newChat()
globalThis.fetch = async (_url, init) => {
  oversizedRequests.push(JSON.parse(init.body))
  return rejectLength()
}
drafts.setDraftText(null, oversizedText)
assert.equal(store.sendMessage(null), true)
const rejectedOversizedId = store.useChatStore.getState().activeId
await waitIdle()
assert.equal(oversizedRequests.length, 2, 'the provider rejected the minimum possible request; do not retry')
assert.equal(oversizedRequests[1].messages.at(-1).content, oversizedText)
const rejectedOversized = (await db.loadSession(rejectedOversizedId)).messages
assert.equal(rejectedOversized.at(-2).content, oversizedText)
assert.equal(rejectedOversized.at(-1).error.localMessage.key, 'replyContextLimit')
checks.push('A conservative estimate never blocks the current text or removes fixed memory; an irreducible request is sent once and preserves its full text even after provider rejection')

const continuationId = 'large-continuation-with-current-document'
const continuationSummary = { id: continuationId, title: continuationId, createdAt: 1, updatedAt: 4 }
const document = { id: 'current-document', serverId: null, name: 'test.txt', isImage: false, size: 4, mimeType: 'text/plain' }
await db.saveSession({
  ...continuationSummary,
  contextMemory: { fixed: fixedMemory },
  messages: [
    ...limitHistory.slice(0, 2),
    { role: 'user', id: 'document-question', content: '接着说', files: [document], createdAt: 3 },
    { role: 'assistant', id: 'partial-prefix', status: 'done', prefix: true, stopReason: 'max_tokens',
      latestReminder: '本轮提醒', blocks: [{type:'text',text:oversizedText}], createdAt: 4 },
  ],
}, [{ id: document.id, blob: new Blob(['test'], { type: document.mimeType }) }])
store.useChatStore.setState(state => ({ sessions: [...state.sessions, continuationSummary] }))
await store.openHistoryMatch(continuationId, null)
let docUploads = 0
globalThis.fetch = async (url, init) => {
  if (String(url).endsWith('/files')) {
    docUploads += 1
    assert.equal(await init.body.get('file').text(), 'test')
    return Response.json({ id: 'uploaded-document' })
  }
  const body = JSON.parse(init.body)
  oversizedRequests.push(body)
  return officialReply(body)
}
store.continueReply(continuationId, 'partial-prefix')
await waitIdle()
assert.equal(docUploads, 1)
assert.equal(oversizedRequests.length, 3)
assert.ok(oversizedRequests[2].system.includes(fixedMemory))
assert.deepEqual(oversizedRequests[2].messages, [
  { role: 'latest_reminder', content: '本轮提醒' },
  { role: 'user', content: [
    { type: 'document', source: { type: 'file', file_id: 'uploaded-document' } },
    { type: 'text', text: '接着说' },
  ] },
  { role: 'assistant', content: [{type:'text',text:oversizedText}] },
])
const continued = (await db.loadSession(continuationId)).messages.at(-1)
assert.equal(continued.status, 'done')
assert.equal(continued.blocks.filter(block => block.type === 'text').map(block => block.text).join(''), oversizedText + '新回答')
checks.push('Continuing an oversized prefix uploads and preserves the current document, keeps the whole prefix and reminder, and only omits optional old history')

const { describeReply } = await import(new URL('services/chat/describe.ts', sourceRoot))
const { canContinueReply, getContextRounds } = await import(new URL('services/chat/reply.ts', sourceRoot))
const { buildReplyView } = await import(new URL('services/chat/view.ts', sourceRoot))
settings.setContextMemoryEnabled(false)
const blankStart = { type: 'message_start', message: { id: 'blank-fixture', model: 'deepseek-v4-pro', usage: { input_tokens: 10 } } }
const blankStop = { type: 'message_stop' }
const blankDelta = (stop_reason = 'end_turn') => ({ type: 'message_delta', delta: { stop_reason, stop_sequence: null }, usage: { output_tokens: 5 } })
const textFrame = text => ({ type: 'content_block_start', index: 0, content_block: { type: 'text', text } })
const thinkingFrame = { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '继续推理' } }
const sseReply = frames => new Response(frames.map(payload => `data: ${JSON.stringify(payload)}\n\n`).join(''),
  { headers: { 'Content-Type': 'text/event-stream' } })
for (const [content, delta, withStop] of [
  [[], blankDelta(), true],
  [[textFrame('')], blankDelta(), true],
  [[textFrame(' \n\t\u200b')], blankDelta(), true],
  [[thinkingFrame], blankDelta(), false],
]) {
  store.newChat()
  let attempts = 0
  globalThis.fetch = async () => {
    attempts++
    return attempts === 1
      ? sseReply([blankStart, ...content, delta, ...(withStop ? [blankStop] : [])])
      : sseReply([blankStart, textFrame('一次重新生成就看到了。'), blankDelta(), blankStop])
  }
  drafts.setDraftText(null, '往下翻剩下的回复')
  assert.equal(store.sendMessage(null), true)
  const id = store.useChatStore.getState().activeId
  await waitIdle()
  const failed = (await db.loadSession(id)).messages.at(-1)
  assert.equal(failed.status, 'error')
  assert.equal(failed.error.localMessage.key, 'replyEmpty')
  assert.equal(describeReply(failed).action, 'regenerate')
  assert.equal(buildReplyView(failed, false).answer, null)
  assert.equal(attempts, 1)
  assert.equal(describeReply({ ...failed, status: 'done', error: undefined }).action, 'regenerate')
  store.regenerateReply(id, failed.id)
  store.regenerateReply(id, failed.id)
  await waitIdle()
  const recovered = (await db.loadSession(id)).messages
  assert.equal(attempts, 2)
  assert.equal(recovered.filter(({ role }) => role === 'user').length, 1)
  assert.equal(recovered.at(-1).status, 'done')
  assert.equal(recovered.at(-1).blocks[0].text, '一次重新生成就看到了。')
  assert.deepEqual(getContextRounds(recovered.slice(0, 2)), [])
}
for (const [content, reason, notice, resumable] of [
  [[textFrame('不能显示的内容'), thinkingFrame], 'refusal', { presentation: 'response' }, false],
  [[thinkingFrame], 'max_tokens', { action: 'regenerate' }, true],
  [[textFrame('已经生成的部分正文')], 'max_tokens', null, true],
]) {
  store.newChat()
  globalThis.fetch = async () => sseReply([blankStart, ...content, blankDelta(reason), blankStop])
  drafts.setDraftText(null, '检查终止原因')
  assert.equal(store.sendMessage(null), true)
  const id = store.useChatStore.getState().activeId
  await waitIdle()
  const reply = (await db.loadSession(id)).messages.at(-1)
  assert.equal(reply.status, 'done')
  assert.equal(reply.stopReason, reason)
  assert.equal(canContinueReply(reply), resumable)
  const actual = describeReply(reply)
  if (notice === null) assert.equal(actual, null)
  else for (const [key, value] of Object.entries(notice)) assert.equal(actual[key], value)
  if (reason === 'refusal') assert.deepEqual(reply.blocks, [])
}
assert.equal(describeReply(stopped.messages.at(-1)).text, '已停止生成，尚未收到正文。')
checks.push('Usage-only, empty, whitespace/invisible and reasoning-only replies show an explicit recovery action; one user action issues one request, and refusal/limited replies retain their stop semantics')

assert.equal(getTokenRate({ output_tokens: 30 }, 1500), 20)
assert.equal(getTokenRate({ output_tokens: 30 }, 0), undefined)
assert.equal(getTokenRate({ output_tokens: 0 }, 1500), undefined)
assert.equal(getTokenRate({ total_tokens: 30 }, 1500), undefined)
const actualUsage = getReplyMetrics({ usage: { total_tokens: 42 } })
assert.equal(actualUsage.context.occupied, 42)
assert.equal(actualUsage.context.input, undefined)
assert.equal(actualUsage.context.reported, true)
assert.equal(getReplyMetrics({ status: 'done', usage: { input_tokens: 80, cache_read_input_tokens: 20, output_tokens: 0 } }).cacheHitPercentage, 0.2)
assert.equal(getReplyMetrics({ status: 'done', usage: { input_tokens: 100, cache_read_input_tokens: 0, output_tokens: 0 } }).cacheHitPercentage, 0)
assert.equal(getReplyMetrics({ usage: { input_tokens: 100 } }), undefined,
  'Incomplete usage without a saved request snapshot stays unknown')
store.newChat()
let metricRequest
let sendText
const streamMetricResponse = () => {
  const start = { ...blankStart, message: { ...blankStart.message, usage: { input_tokens: 15, cache_creation_input_tokens: 2, cache_read_input_tokens: 3 } } }
  const delta = { ...blankDelta(), usage: { output_tokens: 12 } }
  return new Response(new ReadableStream({
    start(controller) {
      const send = (...frames) => controller.enqueue(encoder.encode(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('')))
      sendText = () => {
        send({ ...textFrame('实际正文'), index: 1 }, delta, blankStop)
        controller.close()
      }
      send(start, thinkingFrame)
    },
  }), { headers: { 'Content-Type': 'text/event-stream' } })
}
globalThis.fetch = async (_url, init) => {
  metricRequest = JSON.parse(init.body)
  return streamMetricResponse()
}
const sawReasoning = new Promise((resolve) => {
  const unsubscribe = store.useChatStore.subscribe((state) => {
    const reply = state.sessionCache[state.activeId]?.messages.at(-1)
    if (reply?.blocks?.some(block => block.type === 'thinking')) {
      unsubscribe()
      resolve()
    }
  })
})
drafts.setDraftText(null, '记录流式速度')
assert.equal(store.sendMessage(null), true)
const metricId = store.useChatStore.getState().activeId
await sawReasoning
assert.equal(getReplyMetrics(store.useChatStore.getState().sessionCache[metricId].messages.at(-1)).tokensPerSecond, undefined)
await new Promise(resolve => setTimeout(resolve, 160))
sendText()
await waitIdle()
const metricReply = (await db.loadSession(metricId)).messages.at(-1)
const metrics = getReplyMetrics(metricReply)
assert.ok(metrics.tokensPerSecond > 0 && metrics.tokensPerSecond <= 100)
assert.deepEqual(metrics.context, {
  ...estimateRequestParts(metricRequest), input: 20, output: 12, occupied: 32, reported: true,
})
const estimateOnly = getReplyMetrics({ ...metricReply, usage: undefined })
assert.equal(estimateOnly.context.occupied, estimateRequestTokens(metricRequest))
assert.equal(estimateOnly.context.reported, false)
checks.push('Stream rate waits for measured provider output and separated content frames; stored request metrics count cache once and describe the actual payload after a history-limit retry')

const evidence = { passed: true, runtime: process.version, checks,
  requests: requests.map(({ url, body }) => ({ url, model: body.model, messages: body.messages.length })),
  scope: 'Actual chat store, drafts, API clients, SSE, reply reducer and IndexedDB code using an isolated IndexedDB emulator and deterministic responses. No real keys, network or user records.' }
await writeFile(new URL('./deepstay-api-store-evidence.json', import.meta.url), JSON.stringify(evidence, null, 2) + '\n')
console.log(JSON.stringify(evidence, null, 2))
hooks.deregister()
