import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { registerHooks, stripTypeScriptTypes } from 'node:module'
import { fileURLToPath } from 'node:url'

await import('fake-indexeddb/auto')
const root = new URL('../src/', import.meta.url)
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL?.startsWith(root.href)) {
      const file = new URL(specifier.slice(0, -3) + '.ts', context.parentURL)
      if (existsSync(fileURLToPath(file))) return { url: file.href, shortCircuit: true }
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
const preferences = new Map()
globalThis.localStorage = { getItem: key => preferences.get(key) ?? null, setItem: (key, value) => preferences.set(key, value), removeItem: key => preferences.delete(key) }
globalThis.window = new EventTarget()
globalThis.document = Object.assign(new EventTarget(), { visibilityState: 'hidden' })
Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh-CN' }, configurable: true })
globalThis.__API_ORIGIN__ = 'https://api.deepseek.com'
globalThis.requestAnimationFrame = callback => setTimeout(callback, 0)
globalThis.cancelAnimationFrame = clearTimeout

const user = (id, content) => ({ id, role: 'user', content, files: [], createdAt: 1_700_000_000_000 })
const reply = (id, text) => ({ id, role: 'assistant', prefix: false, model: 'fixture', status: 'done', stopReason: 'end_turn', blocks: [{ type: 'text', text }], createdAt: 1_700_000_000_001 })
const legacy = { id: 'legacy-character-free', title: 'Old conversation', createdAt: 1, updatedAt: 1, messages: [user('legacy-u', '原有记录'), reply('legacy-a', '原有回答')] }
const old = await new Promise((resolve, reject) => {
  const request = indexedDB.open('xuchat-guest', 13)
  request.onupgradeneeded = () => {
    for (const name of ['sessions', 'files', 'sessionsStaging', 'filesStaging']) request.result.createObjectStore(name, { keyPath: 'id' })
    request.result.createObjectStore('sessionSummaries', { keyPath: 'id' }).createIndex('fileIds', 'fileIds', { multiEntry: true })
    for (const name of ['memoryRecords', 'memorySegments']) request.result.createObjectStore(name, { keyPath: 'id' }).createIndex('sessionId', 'sessionId')
    request.result.createObjectStore('memoryState', { keyPath: 'sessionId' })
  }
  request.onsuccess = () => resolve(request.result)
  request.onerror = () => reject(request.error)
})
await new Promise((resolve, reject) => {
  const tx = old.transaction(['sessions', 'sessionSummaries'], 'readwrite')
  tx.objectStore('sessions').put(legacy)
  tx.objectStore('sessionSummaries').put({ id: legacy.id, title: legacy.title, createdAt: 1, updatedAt: 1, fileIds: [] })
  tx.oncomplete = resolve
  tx.onabort = () => reject(tx.error)
})
old.close()

const characters = await import(new URL('services/characters.ts', root))
const { exportCharacterCard, importCharacterCard } = await import(new URL('services/characterCards.ts', root))
const db = await import(new URL('services/chat/db.ts', root))
const settings = await import(new URL('services/settings.ts', root))
const store = await import(new URL('services/chat/store.ts', root))
const drafts = await import(new URL('services/chat/drafts.ts', root))
const { fitRequestHistory } = await import(new URL('services/chat/contextLimit.ts', root))
const { estimateSessionContext } = await import(new URL('services/chat/replyMetrics.ts', root))
const { estimateRequestParts } = await import(new URL('services/chat/contextMemory.ts', root))
const requests = []
const checks = []
let rejectForLength = false
const stream = text => new Response(`data: ${JSON.stringify({ id: 'character-fixture', choices: [{ index: 0, delta: { content: text }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body)
  requests.push(body)
  const extracting = body.messages[0].content.includes('你只负责整理已有聊天记录')
  if (extracting) return stream(JSON.stringify({ summary: '双方分享日常与看海约定。', records: [] }))
  if (rejectForLength) {
    rejectForLength = false
    return new Response(JSON.stringify({ error: { message: 'User input too long, 95000 tokens exceeds max 32000 tokens' } }), { status: 400 })
  }
  return stream('按当前人物设定继续。')
}
const wait = async predicate => {
  const deadline = Date.now() + 10_000
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error('Character core regression timed out')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}
const current = id => store.useChatStore.getState().sessionCache[id]
const idle = id => wait(() => !store.useChatStore.getState().streaming[id])
const send = async id => {
  if (id !== null) {
    store.selectSession(id)
    await wait(() => current(id))
  }
  drafts.setDraftText(id, '你好，继续聊吧。')
  assert.equal(store.sendMessage(id), true)
  const target = id ?? store.useChatStore.getState().activeId
  await idle(target)
  assert.equal(current(target).messages.at(-1).status, 'done')
  return target
}
try {
  await characters.loadCharacters()
  assert.deepEqual(characters.useCharacters.getState().presets, [])
  assert.deepEqual(await db.loadSession(legacy.id), legacy)
  checks.push('An additive version-13 database upgrade preserves existing messages and starts with an empty character library')

  const first = await characters.saveCharacter({ name: '阿澜', prompt: '角色A唯一设定：温柔的海边画家。', greeting: '阿澜把一杯热茶放在你面前。' })
  const second = await characters.saveCharacter({ name: '小岚', prompt: '角色B唯一设定：活泼的山林旅伴。', greeting: '' })
  await assert.rejects(characters.saveCharacter({ name: 'x'.repeat(101), prompt: '有效', greeting: '' }), /Invalid/)
  await assert.rejects(characters.saveCharacter({ name: '有效', prompt: 'x'.repeat(20_001), greeting: '' }), /Invalid/)
  await assert.rejects(characters.saveCharacter({ name: '有效', prompt: '有效', greeting: 'x'.repeat(10_001) }), /Invalid/)
  const oversizedCard = { name: '大卡', prompt: '中'.repeat(20_000), greeting: '',
    alternateGreetings: Array(9).fill('中'.repeat(10_000)) }
  const presetsBeforeOversize = structuredClone(characters.useCharacters.getState().presets)
  await assert.rejects(characters.saveCharacter(oversizedCard), /Invalid or oversized/)
  await assert.rejects(characters.saveCharacter({ ...oversizedCard, id: first.id }), /Invalid or oversized/)
  assert.deepEqual(characters.useCharacters.getState().presets, presetsBeforeOversize)
  assert.deepEqual((await db.loadCharacterPresets()).find(p => p.id === first.id), first)
  assert.equal((await db.loadCharacterPresets()).length, presetsBeforeOversize.length)
  const portableInput = { name: '可备份大卡', prompt: '中'.repeat(20_000), greeting: '',
    alternateGreetings: Array(4).fill('中'.repeat(10_000)) }
  const portablePreset = await characters.saveCharacter(portableInput)
  const portableJson = exportCharacterCard(portablePreset)
  assert.ok(new TextEncoder().encode(portableJson).length < 200 * 1024)
  assert.deepEqual(await importCharacterCard(new File([portableJson], 'character.json')), { ...portableInput, warnings: [] })
  await characters.deleteCharacter(portablePreset.id)
  checks.push('New or edited presets exceeding portable JSON bytes reject before writes, retain the old library, and accepted large Chinese presets export/reimport without losing candidates')
  const put = IDBObjectStore.prototype.put
  IDBObjectStore.prototype.put = function (...args) {
    if (this.name === 'characterPresets') throw new DOMException('Injected character quota error', 'QuotaExceededError')
    return put.apply(this, args)
  }
  try {
    await assert.rejects(characters.saveCharacter({ ...first, prompt: '失败修改不可覆盖原设定' }), /Injected character quota/)
    assert.deepEqual(characters.useCharacters.getState().presets.find(p => p.id === first.id), first)
  } finally { IDBObjectStore.prototype.put = put }
  assert.equal(characters.useCharacters.getState().error, true)
  const remove = IDBObjectStore.prototype.delete
  IDBObjectStore.prototype.delete = function (...args) {
    if (this.name === 'characterPresets') throw new DOMException('Injected character delete error', 'QuotaExceededError')
    return remove.apply(this, args)
  }
  try { await assert.rejects(characters.deleteCharacter(first.id), /Injected character delete/) }
  finally { IDBObjectStore.prototype.delete = remove }
  characters.useCharacters.setState({ presets: [], ready: false })
  await characters.loadCharacters()
  assert.equal(characters.useCharacters.getState().error, false)
  assert.deepEqual(characters.useCharacters.getState().presets.find(p => p.id === first.id), first)
  assert.ok(characters.useCharacters.getState().presets[0].updatedAt >= characters.useCharacters.getState().presets[1].updatedAt)
  checks.push('Library mutations await durable writes, reject invalid or oversized fields without truncation, preserve old values on save/delete failure and reload from IndexedDB')

  settings.setApiConnection({ apiKey: 'character-core-fixture', apiBaseUrl: 'https://character-fixture.example.test/v1', apiProtocol: 'openai', model: 'fixture', models: ['fixture'] })
  settings.setGeneration({ system: '全局设定：自然表达。', contextTokens: 24_000 })
  settings.setContextMemoryEnabled(false)
  assert.equal(store.startCharacterChat(first), false, 'Starting a character chat before initialization must be blocked')
  await store.initChat()
  assert.equal(store.startCharacterChat(first), true)
  const firstId = store.useChatStore.getState().activeId
  const firstSnapshot = structuredClone(current(firstId).character)
  assert.equal(current(firstId).messages[0].blocks[0].text, first.greeting)
  assert.equal(current(firstId).messages[0].questionDeleted, true)
  await wait(async () => (await db.loadSession(firstId))?.character?.prompt === first.prompt)
  await characters.saveCharacter({ ...first, prompt: '库中已编辑的新设定，旧会话不可改变' })
  await characters.deleteCharacter(first.id)
  assert.deepEqual(current(firstId).character, firstSnapshot)
  assert.equal(store.startCharacterChat(second), true)
  const secondId = store.useChatStore.getState().activeId
  assert.equal(current(secondId).messages.length, 0)
  assert.notEqual(current(firstId).character.prompt, current(secondId).character.prompt)
  checks.push('New chats copy independent preset snapshots and optional visible greetings; edits and deletion never rewrite existing sessions')

  await send(firstId)
  assert.ok(requests.at(-1).messages[0].content.includes(first.prompt))
  assert.ok(requests.at(-1).messages[0].content.includes(first.greeting))
  assert.ok(requests.at(-1).messages[0].content.includes('全局设定：自然表达。'))
  assert.ok(!JSON.stringify(requests.at(-1)).includes(second.prompt))
  assert.equal(requests.at(-1).messages.filter(message => message.role === 'user').length, 1, 'A greeting must not create a fabricated user message')
  await send(secondId)
  assert.ok(requests.at(-1).messages[0].content.includes(second.prompt))
  assert.ok(!JSON.stringify(requests.at(-1)).includes(first.prompt))
  const plainId = await send(null)
  assert.equal(current(plainId).character, undefined)
  assert.ok(!JSON.stringify(requests.at(-1)).includes(first.prompt))
  assert.ok(!JSON.stringify(requests.at(-1)).includes(second.prompt))
  await send(legacy.id)
  assert.equal(current(legacy.id).character, undefined)
  checks.push('Actual OpenAI requests carry only their own character and global prompt even with auto compression disabled; ordinary and legacy chats remain character-free')

  settings.setContextMemoryEnabled(true)
  const previousRequests = requests.length
  rejectForLength = true
  await send(firstId)
  assert.equal(requests.length, previousRequests + 2)
  settings.setContextMemoryEnabled(false)
  assert.ok(requests.at(-1).messages[0].content.includes(first.prompt))
  const base = characters.characterSystemPrompt('全局', firstSnapshot)
  const fitted = fitRequestHistory({ model: 'fixture', system: base + '\n可移除摘要'.repeat(1000), tools: [], messages: [
    { role: 'user', content: '旧问题'.repeat(1000) }, { role: 'assistant', content: [{ type: 'text', text: '旧回答'.repeat(1000) }] },
    { role: 'user', content: '当前问题' },
  ] }, 1, base)
  assert.equal(fitted.system, base)
  assert.equal(fitted.messages.length, 1)
  const withCharacter = estimateSessionContext(current(firstId), base, [])
  const withoutCharacter = estimateSessionContext(current(firstId), '全局', [])
  assert.ok(withCharacter.system > withoutCharacter.system)
  assert.equal(withCharacter.system, estimateRequestParts({ system: base, messages: [], tools: [] }).system)
  checks.push('Context-limit retries and final history fitting preserve the required character block; the same helper contributes its full token estimate')

  const long = { id: 'long-character-chat', title: 'Long character', createdAt: 1, updatedAt: 1, character: firstSnapshot,
    messages: Array.from({ length: 12 }, (_, i) => [user(`long-u-${i}`, `第${i}天的日常。${'一起看海和分享心情。'.repeat(80)}`), reply(`long-a-${i}`, '记得我们的约定，慢慢说。'.repeat(100))]).flat() }
  await db.saveSession(long)
  store.useChatStore.setState({ ready: false })
  await store.initChat()
  store.selectSession(long.id)
  await wait(() => current(long.id))
  settings.setApiConnection({ apiKey: 'character-core-fixture', apiBaseUrl: 'https://character-fixture.example.test/v1', apiProtocol: 'openai', model: 'fixture-long-context', models: ['fixture-long-context'] })
  settings.setGeneration({ system: '全局设定：自然表达。', contextTokens: 24_000 })
  const longCompaction = await store.compactSession(long.id)
  assert.equal(longCompaction, 'saved', JSON.stringify({ longCompaction, budget: store.getEffectiveContextInputBudget(), rounds: current(long.id).messages.length }))
  assert.equal((await db.loadMemorySnapshot(long.id)).state.hasCheckpoint, true)
  await send(long.id)
  assert.ok(requests.at(-1).messages[0].content.includes(first.prompt))
  assert.ok(requests.at(-1).messages[0].content.includes(first.greeting))
  settings.setGeneration({ system: '全局设定：自然表达。' })
  assert.deepEqual((await db.loadSession(firstId)).character, firstSnapshot)
  checks.push('Manual compaction saves a checkpoint, and the next request reuses it with auto mode off while retaining the independent character and opening context')

  assert.equal(store.startCharacterChat({ ...first, id: 'greeting-library-independent' }), true)
  const intactId = store.useChatStore.getState().activeId
  const greetingId = current(firstId).messages[0].id
  const normalRound = current(firstId).messages.find(message => message.role === 'user').id
  assert.equal(await store.deleteMessageRound(firstId, normalRound), true)
  assert.equal(current(firstId).character.greeting, first.greeting, 'Deleting a normal round must not remove the greeting context')
  assert.equal(await store.deleteMessages(firstId, [greetingId]), true)
  assert.equal(current(firstId).character.greeting, undefined)
  await send(firstId)
  assert.ok(requests.at(-1).messages[0].content.includes(first.prompt))
  assert.ok(!JSON.stringify(requests.at(-1)).includes(first.greeting), 'A deleted opening must not remain hidden in the outgoing system prompt')
  await send(intactId)
  assert.ok(requests.at(-1).messages[0].content.includes(first.greeting), 'An independent chat retains its own opening')
  assert.equal((await db.loadSession(firstId)).character.greeting, undefined)
  checks.push('Deleting the opening removes its hidden system context durably while retaining the character prompt; ordinary round deletion and other chats keep their own opening context')

  const multi = await characters.saveCharacter({ name: '多开场人物', prompt: '多开场唯一人物设定', greeting: '', alternateGreetings: ['', '第二个开场的唯一文字', '第三个候选不会发送'] })
  const savedMulti = structuredClone(multi)
  characters.useCharacters.setState({ presets: [], ready: false })
  await characters.loadCharacters()
  assert.deepEqual(characters.useCharacters.getState().presets.find(p => p.id === multi.id), savedMulti)
  const idsBefore = store.useChatStore.getState().sessions.map(s => s.id)
  for (const index of [-1, 4, 0.5, NaN]) assert.equal(store.startCharacterChat(multi, index), false)
  assert.deepEqual(store.useChatStore.getState().sessions.map(s => s.id), idsBefore)
  assert.equal(store.startCharacterChat(multi), true)
  const emptyGreetingId = store.useChatStore.getState().activeId
  assert.equal(current(emptyGreetingId).messages.length, 0)
  assert.equal(current(emptyGreetingId).character.greeting, undefined)
  assert.equal(store.startCharacterChat(multi, 2), true)
  const chosenId = store.useChatStore.getState().activeId
  assert.equal(current(chosenId).messages.length, 1)
  assert.equal(current(chosenId).messages[0].blocks[0].text, multi.alternateGreetings[1])
  assert.equal(current(chosenId).character.greeting, multi.alternateGreetings[1])
  assert.equal(Object.hasOwn(current(chosenId).character, 'alternateGreetings'), false)
  const selectedSnapshot = structuredClone(current(chosenId).character)
  await characters.saveCharacter({ ...multi, greeting: '库中新首开场', alternateGreetings: ['库中新候选'] })
  assert.deepEqual(current(chosenId).character, selectedSnapshot)
  await send(chosenId)
  assert.ok(requests.at(-1).messages[0].content.includes(multi.alternateGreetings[1]))
  assert.ok(!JSON.stringify(requests.at(-1)).includes(multi.alternateGreetings[2]))
  assert.ok(!JSON.stringify(requests.at(-1)).includes('库中新首开场'))
  assert.equal(await store.deleteMessages(chosenId, [current(chosenId).messages[0].id]), true)
  await send(chosenId)
  assert.ok(!JSON.stringify(requests.at(-1)).includes(multi.alternateGreetings[1]))
  assert.equal(current(emptyGreetingId).character.greeting, undefined)
  for (const alternateGreetings of [[null], ['x'.repeat(10_001)], Array(100).fill(''), Array(11).fill('x'.repeat(10_000))]) {
    await assert.rejects(characters.saveCharacter({ ...multi, alternateGreetings }), /Invalid/)
  }
  assert.deepEqual((await db.loadCharacterPresets()).find(p => p.id === multi.id).alternateGreetings, ['库中新候选'])
  checks.push('Multiple greetings persist in the preset; invalid indices do not create chats, empty openings remain empty, only the selected opening enters its isolated snapshot/request and deletion removes its hidden context')

  console.log(JSON.stringify({ passed: true, checks, scope: 'Real character library, chat store, API request serialization, compaction and IndexedDB with synthetic messages and mock network only.' }, null, 2))
} finally {
  hooks.deregister()
}
