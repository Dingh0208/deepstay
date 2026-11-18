import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { registerHooks, stripTypeScriptTypes } from 'node:module'
import { fileURLToPath } from 'node:url'

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
    if (url.startsWith(root.href) && url.endsWith('.ts')) return { format: 'module', source: stripTypeScriptTypes(readFileSync(new URL(url), 'utf8'), { mode: 'transform' }), shortCircuit: true }
    return nextLoad(url, context)
  },
})
const saved = new Map()
globalThis.localStorage = { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value), removeItem: key => saved.delete(key) }
Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh-CN' }, configurable: true })
globalThis.__API_ORIGIN__ = 'https://api.deepseek.com'
const settings = await import(new URL('services/settings.ts', root))
const { prepareContextMemory, estimateContextTokens, estimateRequestTokens, CONTEXT_INPUT_BUDGET } = await import(new URL('services/chat/contextMemory.ts', root))
const { toRequestMessages } = await import(new URL('services/chat/reply.ts', root))
const { memoryFingerprint, MEMORY_VERSION } = await import(new URL('services/chat/memoryRecords.ts', root))
const { ApiError } = await import(new URL('services/api/client.ts', root))
const connection = { baseUrl: 'https://qa-memory.example.test/v1', protocol: 'openai' }
const requests = []
const checks = []
const stream = (text, finish = 'stop') => new Response('data: ' + JSON.stringify({ id: 'memory-qa', choices: [{ index: 0, delta: { content: text }, finish_reason: finish }] }) + '\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
const extraction = (summary = '本段记录日常聊天，未确认额外事实。', records = []) => stream(JSON.stringify({ summary, records }))
let respond = () => extraction()
globalThis.fetch = async (url, init) => {
  const request = { url: String(url), init, body: JSON.parse(init.body) }
  requests.push(request)
  return respond(request)
}
const question = { id: 'latest', role: 'user', content: '我们上次约好什么时候散步？', files: [], createdAt: Date.UTC(2026, 10, 18) }
const round = (index, user = `用户第${index}次分享。` + '当日心情'.repeat(90), answer = '助手说愿意耐心陪伴。' + '请慢慢说我在听'.repeat(160)) => [
  { id: `u-${index}`, role: 'user', content: user, files: [], createdAt: Date.UTC(2026, 10, 1) + index * 60000 },
  { id: `a-${index}`, role: 'assistant', model: 'qa-model', thinking: false, status: 'done', stopReason: 'end_turn', prefix: false, blocks: [{ type: 'text', text: answer }], createdAt: Date.UTC(2026, 10, 1) + index * 60000 + 1000 },
]
const history = Array.from({ length: 14 }, (_, index) => round(index)).flat()
const emptySnapshot = () => ({ records: [], segments: [] })
const optionsFor = (overrides = {}) => {
  const snapshot = overrides.snapshot ?? emptySnapshot()
  return {
    sessionId: 'fixture-chat', history, question, apiKey: 'memory-fixture-key', connection, model: 'qa-model', signal: new AbortController().signal,
    snapshot,
    onCommit: async update => { snapshot.records.push(...update.records); snapshot.segments.push(...update.segments); return true },
    ...overrides,
  }
}
const isExtraction = request => (request.body.system ?? request.body.messages[0].content).includes('你只负责整理已有聊天记录')
const requestOf = context => ({ system: context.systemMemory, messages: toRequestMessages(context.history, question), tools: [] })
const assertWithinBudget = request => assert.ok(estimateRequestTokens(request) <= CONTEXT_INPUT_BUDGET)

try {
  assert.equal(settings.useSettings.getState().contextMemoryEnabled, false)
  settings.setContextMemoryEnabled(true)
  const cold = await import(new URL('services/settings.ts?memory-cold', root))
  assert.equal(cold.useSettings.getState().contextMemoryEnabled, true)
  const shortProgress = []
  const short = await prepareContextMemory(optionsFor({ history: round(0, '你好', '我在'), memory: { fixed: '称呼：小鹿。' }, onProgress: value => shortProgress.push(value) }))
  assert.deepEqual(shortProgress, [], 'A chat that fits must never show compression status')
  assert.equal(requests.length, 0)
  assert.ok(short.systemMemory.includes('称呼：小鹿'))
  assert.deepEqual(short.history, round(0, '你好', '我在'))
  checks.push('Compression defaults off, persists opt-in, and makes no extraction call for short history')

  const repeatedReminders = Array.from({ length: 20 }, (_, index) => {
    const pair = round(900 + index, '今天好。', '我在。')
    pair[1].latestReminder = '同一份历史提醒。'.repeat(200)
    return pair
  }).flat()
  const beforeReminders = requests.length
  const reminders = await prepareContextMemory(optionsFor({ history: repeatedReminders }))
  assert.equal(requests.length, beforeReminders, 'Deduplicated reminders that fit the actual request must not trigger extractions')
  assert.deepEqual(reminders.history, repeatedReminders)
  checks.push('Identical historical reminders are budgeted once as in the actual request instead of forcing unnecessary compression')

  const original = JSON.stringify(history)
  const progress = []
  const snapshot = emptySnapshot()
  const first = await prepareContextMemory(optionsFor({ snapshot, memory: { fixed: '昵称：小鹿。' }, onProgress: value => progress.push(value) }))
  assert.ok(requests.length > 0 && requests.length <= 2)
  assert.equal(snapshot.segments.length, requests.length)
  assert.ok(first.history.length > 0 && first.history.length % 2 === 0)
  assert.deepEqual(first.history, history.slice(-first.history.length))
  assert.equal(JSON.stringify(history), original)
  assert.deepEqual(progress[0], { completed: 0, total: 0 }, 'Report compression before selecting extraction batches')
  assert.ok(progress.some(value => value.completed === value.total && value.total > 0))
  for (const { url, init, body } of requests) {
    assert.equal(url, 'https://qa-memory.example.test/v1/chat/completions')
    assert.equal(new Headers(init.headers).get('Authorization'), 'Bearer memory-fixture-key')
    assert.equal(body.model, 'qa-model')
    assert.equal(body.max_tokens, 4096)
    assert.ok(!('tools' in body))
    assert.ok(!('thinking' in body))
    assert.ok(body.messages[0].content.includes('角色扮演'))
    assert.ok(body.messages[1].content.includes('[本段原文]'))
  }
  assertWithinBudget(requestOf(first))
  assert.ok(estimateRequestTokens(requestOf(first)) < estimateRequestTokens({ system: '', messages: toRequestMessages(history, question), tools: [] }) / 2)
  checks.push('Long chats use at most two bounded structured extractions with the captured URL/key/model, commit each segment, preserve complete recent rounds and original logs, and fit the final request budget')

  const savedSegmentCount = snapshot.segments.length
  const afterInitialExtraction = requests.length
  const agingHistory = [...history]
  const reusedProgress = []
  for (let index = 0; index < 3; index++) {
    agingHistory.push(...round(800 + index, '好的。', '我在。'))
    const reused = await prepareContextMemory(optionsFor({ history: agingHistory, snapshot, onProgress: value => reusedProgress.push(value) }))
    assert.ok(reused.systemMemory.includes('历史分段脉络'))
    assert.ok(reused.systemMemory.includes('部分历史尚未整理'))
  }
  assert.equal(requests.length, afterInitialExtraction)
  assert.equal(snapshot.segments.length, savedSegmentCount)
  assert.deepEqual(reusedProgress, [])
  const priorSources = new Set(snapshot.segments.flatMap(segment => segment.sources.map(source => `${source.messageId}:${source.start}:${source.end}`)))
  const beforeAppend = requests.length
  const moreRounds = (first) => Array.from({ length: 6 }, (_, index) => round(first + index)).flat()
  agingHistory.push(...moreRounds(810))
  await prepareContextMemory(optionsFor({ snapshot, history: agingHistory }))
  assert.ok(requests.length > beforeAppend)
  assert.ok(requests.length - beforeAppend <= 2)
  const appended = snapshot.segments.flatMap(segment => segment.sources).filter(source => !priorSources.has(`${source.messageId}:${source.start}:${source.end}`))
  assert.ok(appended.length > 0)
  const edited = structuredClone(agingHistory)
  edited[0].content = '用户明确编辑了昵称。' + edited[0].content
  edited.push(...moreRounds(820))
  const beforeEdit = requests.length
  await prepareContextMemory(optionsFor({ snapshot, history: edited }))
  assert.ok(requests.length > beforeEdit)
  assert.ok(requests.slice(beforeEdit).some(request => request.body.messages[1].content.includes('用户明确编辑了昵称')))
  checks.push('Successive short turns reuse verified segments without an extraction request or progress status; new aged history triggers bounded extraction and newly invalidated source text is re-extracted')

  // Return evidence-backed facts through the actual extraction/parser/prompt chain.
  const continuityHistory = Array.from({ length: 18 }, (_, index) => round(200 + index)).flat()
  const nickname = '我喜欢被叫小鹿，不要叫我宝贝。'
  const promise = '我答应周五陪你复盘，现在还没有完成。'
  const correction = '我明确更正称呼，现在请叫我小禾。'
  continuityHistory[0].content = nickname + continuityHistory[0].content
  continuityHistory[3].blocks[0].text = promise + continuityHistory[3].blocks[0].text
  continuityHistory[16].content = correction + continuityHistory[16].content
  const continuitySnapshot = emptySnapshot()
  for (const message of continuityHistory) {
    if (['u-200', 'a-201', 'u-208'].includes(message.id)) continue
    const text = message.role === 'user' ? message.content : message.blocks[0].text
    const source = { messageId: message.id, fingerprint: await memoryFingerprint(message), start: 0, end: text.length }
    continuitySnapshot.segments.push({ id: `continuity-${message.id}`, sessionId: 'fixture-chat', sources: [source], summary: '以前已整理。', provider: 'openai:https://archive.example.test', model: 'qa-model', createdAt: 1, extractorVersion: MEMORY_VERSION })
  }
  respond = ({ body }) => {
    const chunk = body.messages[1].content
    const source = chunk.split('[本段原文]\n')[1]
    const known = JSON.parse(chunk.split('\n\n[本段原文]')[0].split('\n').slice(1).join('\n'))
    const records = []
    if (source.includes(nickname)) records.push({ kind: 'preference', actor: 'user', realm: 'self_report', key: '称呼', text: '用户喜欢小鹿这一称呼，边界是不要叫宝贝。', sources: [{ messageId: 'u-200', quote: nickname }], supersedes: [] })
    if (source.includes(promise)) records.push({ kind: 'promise', actor: 'assistant', realm: 'roleplay', key: '复盘约定', text: '助手承诺周五陪伴复盘，仍未完成。', sources: [{ messageId: 'a-201', quote: promise }], supersedes: [] })
    if (source.includes(correction)) records.push({ kind: 'correction', actor: 'user', realm: 'self_report', key: '称呼', text: '用户明确更正当前称呼为小禾。', sources: [{ messageId: 'u-208', quote: correction }], supersedes: source.includes(nickname) ? ['@0'] : known.filter(record => record.key === '称呼' && record.kind === 'preference').map(record => record.id) })
    return extraction('本段记录称呼、互动边界与未完成约定，以原文为准。', records)
  }
  const continuity = await prepareContextMemory(optionsFor({ history: continuityHistory, snapshot: continuitySnapshot }))
  assert.ok(continuitySnapshot.records.some(record => record.kind === 'preference' && record.actor === 'user'))
  assert.ok(continuitySnapshot.records.some(record => record.kind === 'promise' && record.actor === 'assistant' && record.realm === 'roleplay'))
  const correctionRecord = continuitySnapshot.records.find(record => record.kind === 'correction')
  assert.ok(correctionRecord?.supersedes.length > 0)
  const coreSection = continuity.systemMemory.split('[当前路径核心记忆]\n')[1].split('\n\n')[0]
  assert.ok(coreSection.includes('当前称呼为小禾'))
  assert.ok(!coreSection.includes('用户喜欢小鹿这一称呼'))
  const branchBHistory = structuredClone(continuityHistory)
  branchBHistory[16] = round(208)[0]
  const branchB = await prepareContextMemory(optionsFor({ history: branchBHistory, snapshot: structuredClone(continuitySnapshot) }))
  const branchBCore = branchB.systemMemory.split('[当前路径核心记忆]\n')[1].split('\n\n')[0]
  assert.ok(branchBCore.includes('用户喜欢小鹿这一称呼'))
  assert.ok(!branchBCore.includes('当前称呼为小禾'))
  checks.push('Evidence-backed user preferences, an assistant roleplay promise and a user correction survive extraction into core memory; the correction applies only on the branch whose original text supports it')
  respond = () => extraction()

  const ledgerHistory = Array.from({ length: 12 }, (_, index) => round(600 + index)).flat()
  const colorBefore = '颜色偏好：我喜欢红色。'
  const colorAfter = '颜色更正：现在改喜欢蓝色。'
  ledgerHistory[0].content = colorBefore + ledgerHistory[0].content
  ledgerHistory[2].content = colorAfter + ledgerHistory[2].content
  const ledgerSnapshot = emptySnapshot()
  const ledgerSources = new Map()
  for (const message of ledgerHistory.slice(0, 14)) {
    const content = message.role === 'user' ? message.content : message.blocks[0].text
    const source = { messageId: message.id, fingerprint: await memoryFingerprint(message), start: 0, end: content.length }
    ledgerSources.set(message.id, source)
    if (message.id !== 'u-601') ledgerSnapshot.segments.push({ id: `covered-${message.id}`, sessionId: 'fixture-chat', sources: [source], summary: '已整理片段。', provider: 'openai:https://archive.example.test', model: 'qa-model', createdAt: 1, extractorVersion: MEMORY_VERSION })
  }
  for (let index = 0; index < 24; index++) ledgerSnapshot.records.push({ id: `setting-${index}`, sessionId: 'fixture-chat', kind: 'setting', actor: 'user', realm: 'roleplay', key: `人物设定${index}`, text: `人物设定${index}。` + '虚构角色细节'.repeat(30), sources: [ledgerSources.get('u-600')], supersedes: [], extractedAt: 100 + index, extractorVersion: MEMORY_VERSION })
  ledgerSnapshot.records.push({ id: 'old-color', sessionId: 'fixture-chat', kind: 'preference', actor: 'user', realm: 'self_report', key: '颜色', text: '用户偏好红色。', sources: [{ ...ledgerSources.get('u-600'), end: colorBefore.length }], supersedes: [], extractedAt: 1, extractorVersion: MEMORY_VERSION })
  ledgerSnapshot.records.push({ id: 'later-color', sessionId: 'fixture-chat', kind: 'preference', actor: 'user', realm: 'self_report', key: '颜色', text: '该记录来源在本次更正之后，不能倒填更正目标。', sources: [ledgerSources.get('u-605')], supersedes: [], extractedAt: 999, extractorVersion: MEMORY_VERSION })
  let sawRelevantKnown = false
  respond = ({ body }) => {
    const chunk = body.messages[1].content
    const source = chunk.split('[本段原文]\n')[1]
    const known = JSON.parse(chunk.split('\n\n[本段原文]')[0].split('\n').slice(1).join('\n'))
    if (source.includes(colorAfter)) {
      assert.ok(known.some(record => record.id === 'old-color'), 'A relevant old preference must survive a crowded setting ledger')
      assert.ok(!known.some(record => record.id === 'later-color'), 'Later evidence cannot be supplied as an earlier correction target')
      sawRelevantKnown = true
      return extraction('用户明确更正颜色。', [{ kind: 'correction', actor: 'user', realm: 'self_report', key: '颜色', text: '用户明确改为偏好蓝色。', sources: [{ messageId: 'u-601', quote: colorAfter }], supersedes: ['old-color'] }])
    }
    return extraction()
  }
  await prepareContextMemory(optionsFor({ history: ledgerHistory, snapshot: ledgerSnapshot }))
  assert.equal(sawRelevantKnown, true)
  assert.ok(ledgerSnapshot.records.some(record => record.kind === 'correction' && record.supersedes.includes('old-color')))
  checks.push('A relevant old preference remains available for correction despite twenty-four large settings, while records sourced after the current segment cannot become backward correction targets')
  respond = () => extraction()

  const hugeHistory = [...round(100, '首段。' + '字'.repeat(50000) + '我们在纸鸢山约好周六散步。' + '字'.repeat(50000) + '末段。', '收到。'), ...round(101, '你好', '在的'), ...round(102, '继续', '好的')]
  const hugeOriginal = JSON.stringify(hugeHistory)
  const beforeHuge = requests.length
  const huge = await prepareContextMemory(optionsFor({ history: hugeHistory, question: { ...question, content: '纸鸢山的散步约在什么时候？' } }))
  assert.equal(requests.length - beforeHuge, 2)
  assert.ok(huge.systemMemory.includes('纸鸢山约好周六散步'))
  assert.ok(huge.systemMemory.includes('部分历史尚未整理'))
  assert.ok(!huge.systemMemory.includes('[当前路径核心记忆]'))
  assert.equal(JSON.stringify(hugeHistory), hugeOriginal)
  assert.ok(requests.slice(beforeHuge).every(request => request.body.messages[1].content.length < 15000))
  assertWithinBudget({ system: huge.systemMemory, messages: toRequestMessages(huge.history, question), tools: [] })
  checks.push('An imported message exceeding sixteen batches can continue after only two extractions; middle-history evidence is recovered directly from original text and incomplete coverage cannot claim a current core state')

  // This exercises bounded model input for an already-loaded 80 MiB session, not paged storage.
  const hugeMiddle = '我们在星灯桥约定十一月十九日见面。'
  const eightyMiB = 80 * 1024 * 1024
  const largeText = 'x'.repeat(eightyMiB / 2) + hugeMiddle + 'x'.repeat(eightyMiB / 2 - hugeMiddle.length)
  const largeHistory = [...round(500, largeText, '我记下这个约定。'), ...round(501, '今天好吗', '很好'), ...round(502, '继续', '我在')]
  const beforeEightyMiB = requests.length
  const large = await prepareContextMemory(optionsFor({ history: largeHistory, question: { ...question, content: '星灯桥约定的见面日期是哪天？' } }))
  assert.equal(largeHistory[0].content.length, eightyMiB)
  assert.equal(requests.length - beforeEightyMiB, 2)
  assert.ok(large.systemMemory.includes(hugeMiddle))
  assert.ok(requests.slice(beforeEightyMiB).every(request => estimateContextTokens(request.body.messages[1].content) < 8000))
  assertWithinBudget({ system: large.systemMemory, messages: toRequestMessages(large.history, question), tools: [] })
  checks.push('An already-loaded 80 MiB single-message session resumes with two small extraction requests and recovers a middle-file date; this does not validate mobile heap capacity or implement paged session storage')

  // Derived data from another session or from an unselected branch must never enter a prompt.
  const isolatedSnapshot = structuredClone(snapshot)
  isolatedSnapshot.segments.push({ ...snapshot.segments[0], id: 'foreign-segment', sessionId: 'another-chat', summary: '跨会话绝密设定不可出现' })
  const branchHistory = structuredClone(history)
  branchHistory[0].id = 'branch-b-user'
  isolatedSnapshot.segments.push({ ...snapshot.segments[0], id: 'branch-a-segment', sources: [{ ...snapshot.segments[0].sources[0], messageId: 'unselected-branch-a' }], summary: '未选中分支绝密设定不可出现' })
  const isolated = await prepareContextMemory(optionsFor({ snapshot: isolatedSnapshot, history: branchHistory }))
  assert.ok(!isolated.systemMemory.includes('跨会话绝密设定'))
  assert.ok(!isolated.systemMemory.includes('未选中分支绝密设定'))
  checks.push('Session and selected-branch scope filters derived segments before they enter the model prompt')

  const fail = error => error instanceof ApiError && error.localMessage?.key === 'contextMemoryFailed'
  const errorResponse = (status, message) => Response.json({ error: { message } }, { status })
  for (const status of [401, 402, 429]) {
    respond = () => errorResponse(status, 'fixture failure')
    await assert.rejects(prepareContextMemory(optionsFor({ sessionId: `credential-${status}` })), error => error instanceof ApiError && error.status === status)
  }
  respond = () => { throw new Error('fixture network error') }
  await assert.rejects(prepareContextMemory(optionsFor({ sessionId: 'network-failure' })), error => error instanceof ApiError && error.kind === 'network')
  for (const [id, response] of [
    ['truncated', () => stream('{"summary":"unfinished","records":[]}', 'length')],
    ['invalid-json', () => stream('not JSON')],
    ['unsupported-evidence', () => extraction('假引用', [{ kind: 'preference', actor: 'user', realm: 'self_report', key: '颜色', text: '喜欢蓝色', sources: [{ messageId: 'u-0', quote: '原文没有这句话' }], supersedes: [] }])],
    ['length-rejected', () => errorResponse(400, 'user input too long, 70668 tokens exceeds max 32768 tokens')],
    ['server-failure', () => errorResponse(503, 'fixture busy')],
  ]) {
    respond = response
    const failOptions = optionsFor({ sessionId: id, history: hugeHistory, question: { ...question, content: '纸鸢山的散步约在什么时候？' } })
    const beforeFailure = requests.length
    const fallback = await prepareContextMemory(failOptions)
    assert.ok(fallback.systemMemory.includes('纸鸢山约好周六散步'))
    assert.ok(fallback.systemMemory.includes('部分历史尚未整理'))
    assert.ok(!fallback.systemMemory.includes('[当前路径核心记忆]'))
    assert.deepEqual(fallback.history, hugeHistory.slice(-4))
    assert.equal(failOptions.snapshot.segments.length, 0)
    assert.equal(failOptions.snapshot.records.length, 0)
    assert.equal(requests.length, beforeFailure + 1)
    await prepareContextMemory(failOptions)
    assert.equal(requests.length, beforeFailure + 1, 'Another send during cooldown must reuse the local fallback')
  }
  const incomplete = optionsFor({ sessionId: 'partially-extracted', history: hugeHistory })
  const partialBefore = requests.length
  respond = () => requests.length === partialBefore + 1 ? extraction('第一段已整理。') : stream('invalid')
  const partial = await prepareContextMemory(incomplete)
  assert.ok(partial.systemMemory.includes('第一段已整理'))
  assert.ok(partial.systemMemory.includes('部分历史尚未整理'))
  assert.equal(requests.length, partialBefore + 2)
  assert.equal(incomplete.snapshot.segments.length, 1)
  respond = () => extraction()
  const clockNow = Date.now
  const beforeRetry = requests.length
  try {
    Date.now = () => clockNow() + 5 * 60_000
    await prepareContextMemory(optionsFor({ sessionId: 'invalid-json', history: hugeHistory }))
  } finally {
    Date.now = clockNow
  }
  assert.ok(requests.length > beforeRetry, 'An expired cooldown must allow extraction again')
  await assert.rejects(prepareContextMemory(optionsFor({ onCommit: async () => false })), fail)
  assert.equal(JSON.stringify(history), original)
  assert.equal(JSON.stringify(hugeHistory), hugeOriginal)
  checks.push('Recoverable extraction errors preserve verified segments, use bounded recent turns and source recall, and skip repeat extraction during cooldown. Authentication, quota, network and stale commit failures remain explicit.')

  const cancel = new AbortController()
  const committedBeforeStop = emptySnapshot()
  const beforeCancel = requests.length
  await assert.rejects(prepareContextMemory(optionsFor({
    snapshot: committedBeforeStop, signal: cancel.signal,
    onCommit: async update => { committedBeforeStop.segments.push(...update.segments); committedBeforeStop.records.push(...update.records); cancel.abort(); return true },
  })), error => error.name === 'AbortError')
  assert.equal(requests.length - beforeCancel, 1)
  assert.equal(committedBeforeStop.segments.length, 1)
  const firstStoppedId = committedBeforeStop.segments[0].id
  await prepareContextMemory(optionsFor({ snapshot: committedBeforeStop }))
  assert.equal(committedBeforeStop.segments.filter(segment => segment.id === firstStoppedId).length, 1)
  const abort = new AbortController()
  let release
  const fetched = new Promise(resolve => { release = resolve })
  respond = ({ init }) => { release(); return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })) }
  const pending = prepareContextMemory(optionsFor({ signal: abort.signal }))
  await fetched
  abort.abort()
  await assert.rejects(pending, error => error.name === 'AbortError')
  const cancelled = new AbortController()
  cancelled.abort()
  const beforePreCancelled = requests.length
  await assert.rejects(prepareContextMemory(optionsFor({ signal: cancelled.signal })), error => error.name === 'AbortError')
  assert.equal(requests.length, beforePreCancelled)
  checks.push('Stopping extraction cancels its request, pre-cancelled tasks do no work, and completed segments survive a stop and are not duplicated on retry')

  respond = () => extraction()
  const beforeBudget = requests.length
  const longQuestion = { ...question, content: '字'.repeat(20000) }
  const longPrefix = { ...round(99)[1], prefix: true, thinking: true, blocks: [
    { type: 'thinking', thinking: '思'.repeat(9000), signature: 'fixture-signature' },
    { type: 'text', text: '续'.repeat(9000) },
  ] }
  const document = { id: 'doc', serverId: null, name: 'history.pdf', size: 1280, isImage: false, mimeType: 'application/pdf' }
  const fixed = '会话设定：小鹿。'
  const progressWhileOversized = []
  for (const overrides of [
    { question: longQuestion },
    { prefix: longPrefix },
    { question: { ...question, files: [document] }, connection: { baseUrl: 'https://api.deepseek.com', protocol: 'deepseek' } },
    { question: { ...question, files: [{ ...document, serverId: 'file-doc' }] }, connection: { baseUrl: 'https://api.deepseek.com', protocol: 'deepseek' } },
    { requestOverhead: 30_000 },
  ]) {
    const context = await prepareContextMemory(optionsFor({
      memory: { fixed }, onProgress: value => progressWhileOversized.push(value), ...overrides,
    }))
    assert.deepEqual(context, {
      history: [],
      systemMemory: '[用户固定记忆]\n' + fixed,
      requiredSystemMemory: '[用户固定记忆]\n' + fixed,
    })
  }
  assert.equal(requests.length, beforeBudget)
  assert.deepEqual(progressWhileOversized, [])
  assert.ok(estimateContextTokens('中文') > estimateContextTokens('en'))
  assert.equal(CONTEXT_INPUT_BUDGET, 24000)
  checks.push('A long current question, a continuation with long text and thinking, a current document or oversized request overhead skips optional history and extraction, preserves fixed memory and defers to the provider limit')

  const largeCurrent = { ...question, content: '我们约好散步。'.repeat(2100) }
  const largeCurrentContext = await prepareContextMemory(optionsFor({ question: largeCurrent,
    history: [...round(880, '散步约定。' + '散步细节。'.repeat(2000), '我在听。'), ...history] }))
  assert.equal(toRequestMessages(largeCurrentContext.history, largeCurrent).slice(-1)[0].content, largeCurrent.content)
  assertWithinBudget({ system: largeCurrentContext.systemMemory, messages: toRequestMessages(largeCurrentContext.history, largeCurrent), tools: [] })
  checks.push('A large current question that fits the input budget is retained in full while optional recalled history yields room')

  const protectedSnapshot = emptySnapshot()
  for (const message of history) {
    const content = message.role === 'user' ? message.content : message.blocks[0].text
    const source = { messageId: message.id, fingerprint: await memoryFingerprint(message), start: 0, end: content.length }
    protectedSnapshot.segments.push({ id: `protected-${message.id}`, sessionId: 'fixture-chat', sources: [source], summary: '已整理。', provider: 'openai:https://qa-memory.example.test', model: 'qa-model', createdAt: 1, extractorVersion: MEMORY_VERSION })
  }
  for (const kind of ['setting', 'boundary', 'correction']) protectedSnapshot.records.push({ id: `protected-${kind}`, sessionId: 'fixture-chat', kind, actor: 'user', realm: 'roleplay', key: kind, text: `${kind}必须保留。` + '明确的角色边界和设定。'.repeat(20), sources: [protectedSnapshot.segments[0].sources[0]], supersedes: [], extractedAt: 1, extractorVersion: MEMORY_VERSION })
  const protectedContext = await prepareContextMemory(optionsFor({ snapshot: protectedSnapshot }))
  for (const kind of ['setting', 'boundary', 'correction']) assert.ok(protectedContext.systemMemory.includes(`${kind}必须保留。`))
  const beforeProtectedBudget = requests.length
  const tightQuestion = { ...question, content: '问'.repeat(14750) }
  const tightContext = await prepareContextMemory(optionsFor({ snapshot: protectedSnapshot, question: tightQuestion }))
  assert.deepEqual(tightContext, { history: [], systemMemory: '', requiredSystemMemory: '' })
  assertWithinBudget({ system: tightContext.systemMemory, messages: toRequestMessages(tightContext.history, tightQuestion), tools: [] })
  assert.equal(requests.length, beforeProtectedBudget)
  checks.push('Selected role settings, boundaries and corrections remain in normal requests; when they cannot fit together, optional derived memory yields to the current turn')

  // Exercise the real store, IndexedDB, adapter and stream parser with isolated chats.
  await import('fake-indexeddb/auto')
  globalThis.window = new EventTarget()
  globalThis.document = Object.assign(new EventTarget(), { visibilityState: 'visible' })
  globalThis.requestAnimationFrame = callback => setTimeout(callback, 0)
  globalThis.cancelAnimationFrame = clearTimeout
  const db = await import(new URL('services/chat/db.ts', root))
  const store = await import(new URL('services/chat/store.ts', root))
  const drafts = await import(new URL('services/chat/drafts.ts', root))
  settings.setApiConnection({ apiKey: 'memory-fixture-key', apiBaseUrl: connection.baseUrl, apiProtocol: 'openai', model: 'qa-model', models: ['qa-model'] })
  const fixedA = '角色A：阿青的旅行搭子。约定周五去看海。'
  const fixedB = '角色B：队长的星际领航员。约定周日观星。'
  const originalLog = history.map(message => message.role === 'user' ? message.content : message.blocks[0].text)
  for (const [id, fixed] of [['chat-a', fixedA], ['chat-b', fixedB], ['chat-failure', '失败测试角色']]) {
    await db.saveSession({ id, title: id, createdAt: 1, updatedAt: 1, messages: structuredClone(history), contextMemory: { fixed } })
  }
  const continuationPrefix = { ...round(999, '接着讲我们的旅途。', '尚未讲完的正文。')[1], model: 'deepseek-v4-pro', prefix: true, thinking: true, status: 'done', stopReason: 'max_tokens', latestReminder: '原回复的提醒快照', blocks: [{ type: 'thinking', thinking: '原思考', signature: 'continue-signature' }, { type: 'text', text: '尚未讲完的正文。' }] }
  await db.saveSession({ id: 'chat-continue', title: '续写测试', createdAt: 1, updatedAt: 1, messages: [...structuredClone(history), round(999, '接着讲我们的旅途。')[0], continuationPrefix], contextMemory: { fixed: '保持此会话旅途设定。' } })
  await store.initChat()
  const wait = async predicate => {
    const deadline = Date.now() + 10000
    while (!await predicate()) {
      if (Date.now() > deadline) throw new Error('Store memory integration timed out')
      await new Promise(resolve => setTimeout(resolve, 5))
    }
  }
  const sent = []
  respond = request => {
    if (isExtraction(request)) return extraction('本段日常分享。')
    sent.push(request.body)
    return stream('我们约好周五去看海。')
  }
  store.selectSession('chat-a')
  await wait(() => store.useChatStore.getState().sessionCache['chat-a'])
  drafts.setDraftText('chat-a', '我们的约定是什么？')
  assert.equal(store.sendMessage('chat-a'), true)
  await wait(() => !store.useChatStore.getState().streaming['chat-a'])
  assert.equal(sent.length, 1)
  const system = sent[0].messages.filter(message => message.role === 'system').map(message => message.content).join('\n')
  assert.ok(system.includes(fixedA))
  assert.ok(!system.includes(fixedB))
  await wait(async () => (await db.loadMemorySnapshot('chat-a')).segments.length > 0 && (await db.loadSession('chat-a')).messages.at(-1).status === 'done')
  const storedA = await db.loadSession('chat-a')
  assert.deepEqual(storedA.messages.slice(0, history.length).map(message => message.role === 'user' ? message.content : message.blocks[0].text), originalLog)
  assert.equal(storedA.messages.at(-1).blocks[0].text, '我们约好周五去看海。')
  assert.deepEqual((await db.loadSession('chat-b')).contextMemory, { fixed: fixedB })
  assert.equal((await db.loadMemorySnapshot('chat-b')).segments.length, 0)
  assert.ok(sent[0].messages.length < history.length)
  checks.push('The real store persists source-checked derived memory for chat A, sends only A fixed memory with a bounded recent tail, preserves original logs, and leaves chat B unchanged')

  respond = request => isExtraction(request) ? stream('invalid extraction') : (sent.push(request.body), stream('原文续聊成功'))
  store.selectSession('chat-failure')
  await wait(() => store.useChatStore.getState().sessionCache['chat-failure'])
  const beforeFallback = requests.length
  for (const message of ['继续我们的聊天', '1']) {
    drafts.setDraftText('chat-failure', message)
    assert.equal(store.sendMessage('chat-failure'), true)
    await wait(() => !store.useChatStore.getState().streaming['chat-failure'])
    const reply = store.useChatStore.getState().sessionCache['chat-failure'].messages.at(-1)
    assert.equal(reply.status, 'done')
    assert.equal(reply.blocks[0].text, '原文续聊成功')
    assert.equal(sent.at(-1).messages.at(-1).content, message)
  }
  assert.equal(sent.length, 3)
  assert.equal(requests.slice(beforeFallback).filter(isExtraction).length, 1)
  const fallbackSnapshot = await db.loadMemorySnapshot('chat-failure')
  assert.equal(fallbackSnapshot.segments.length, 0)
  assert.equal(fallbackSnapshot.records.length, 0)
  assert.deepEqual(fallbackSnapshot.session.messages.slice(0, history.length).map(({id})=>id), history.map(({id})=>id))
  checks.push('An unusable summary is not saved, the real store continues with bounded local history, and the next short send does not call the failed summary again')

  const deepseekStream = text => new Response([
    { type: 'message_start', message: { id: 'continue-fixture', model: 'deepseek-v4-pro' } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
    { type: 'message_stop' },
  ].map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
  settings.setApiConnection({ apiKey: 'deepseek-memory-fixture', apiBaseUrl: 'https://api.deepseek.com', apiProtocol: 'deepseek', model: 'deepseek-v4-pro', models: ['deepseek-v4-pro'] })
  const continuations = []
  respond = request => {
    if (isExtraction(request)) return deepseekStream(JSON.stringify({ summary: '既有旅途聊天片段。', records: [] }))
    continuations.push(request.body)
    return deepseekStream('续写完成。')
  }
  store.selectSession('chat-continue')
  await wait(() => store.useChatStore.getState().sessionCache['chat-continue'])
  store.continueReply('chat-continue', continuationPrefix.id)
  await wait(() => !store.useChatStore.getState().streaming['chat-continue'])
  assert.equal(continuations.length, 1)
  assert.equal(continuations[0].model, 'deepseek-v4-pro')
  assert.ok(continuations[0].messages.some(message => message.role === 'latest_reminder' && message.content === continuationPrefix.latestReminder))
  const sentPrefix = continuations[0].messages.at(-1)
  assert.equal(sentPrefix.role, 'assistant')
  assert.ok(sentPrefix.content.some(block => block.type === 'text' && block.text === '尚未讲完的正文。'))
  assert.ok(sentPrefix.content.some(block => block.type === 'thinking' && block.thinking === '原思考' && block.signature === 'continue-signature'))
  const completedContinuation = store.useChatStore.getState().sessionCache['chat-continue'].messages.at(-1)
  assert.equal(completedContinuation.status, 'done')
  assert.equal(completedContinuation.blocks.filter(block => block.type === 'text').map(block => block.text).join(''), '尚未讲完的正文。续写完成。')
  assert.equal((await db.loadMemorySnapshot('chat-continue')).session.contextMemory.fixed, '保持此会话旅途设定。')
  checks.push('The real DeepSeek continuation path accepts its saved pending snapshot, compresses long prior history and preserves original text/thinking/signature/reminder/model while appending the new answer')

  await writeFile(new URL('deepstay-context-memory-evidence.json', import.meta.url), JSON.stringify({ passed: true, runtime: process.version, checks, extractionRequests: requests.filter(isExtraction).length, scope: 'Real context memory pipeline, IndexedDB, OpenAI adapter and SSE parser with deterministic fixture responses. No paid upstream calls; model semantic quality requires separate evaluation.' }, null, 2))
  console.log(JSON.stringify({ passed: true, checks, extractionRequests: requests.filter(isExtraction).length }, null, 2))
} finally { hooks.deregister() }
