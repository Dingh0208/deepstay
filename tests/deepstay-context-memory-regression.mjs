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
const anthropicExtraction = text => new Response([
  { type: 'message_start', message: { id: 'memory-qa', model: 'qa-model', role: 'assistant', content: [] } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
  { type: 'message_stop' },
].map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
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
  assert.equal(requests.length, 1)
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
    assert.equal(body.max_tokens, 2048)
    assert.ok(!('tools' in body))
    assert.ok(!('thinking' in body))
    assert.ok(body.messages[0].content.includes('角色扮演'))
    assert.ok(body.messages[1].content.includes('[本段原文]'))
  }
  assertWithinBudget(requestOf(first))
  assert.ok(estimateRequestTokens(requestOf(first)) < estimateRequestTokens({ system: '', messages: toRequestMessages(history, question), tools: [] }) / 2)
  assert.ok(first.systemMemory.includes(history[0].content), 'Keep the original opening words alongside memory')
  checks.push('Long chats use one bounded extraction with the selected URL/key/model, preserve the original opening and complete recent rounds, and fit the final request budget')

  const summaryOnlySnapshot = emptySnapshot()
  const beforeSummaryOnly = requests.length
  respond = () => stream(`\`\`\`json\n${JSON.stringify({ summary: '第三方接口的关系与近期情绪脉络。' })}\n\`\`\``)
  const summaryOnly = await prepareContextMemory(optionsFor({
    mode: 'manual', sessionId: 'third-party-summary-only', snapshot: summaryOnlySnapshot,
    connection, history,
  }))
  assert.equal(requests.length - beforeSummaryOnly, 1)
  assert.equal(summaryOnlySnapshot.segments.length, 1, 'A complete summary can be reused without structured fact rows')
  assert.equal(summaryOnlySnapshot.records.length, 0)
  assert.ok(summaryOnly.systemMemory.includes('第三方接口的关系与近期情绪脉络。'))

  const invalidRecordsSnapshot = emptySnapshot()
  respond = () => extraction('双方关系经历重要转折，仍沿用彼此熟悉的称呼。', [{
    kind: 'preference', actor: 'assistant', realm: 'self_report', key: '称呼', text: '未经原文支持的现实偏好。',
    sources: [{ messageId: history[0].id, quote: '不存在的原文' }], supersedes: [],
  }])
  const narrativeFallback = await prepareContextMemory(optionsFor({
    mode: 'manual', sessionId: 'third-party-invalid-records', snapshot: invalidRecordsSnapshot,
    connection, history,
  }))
  assert.equal(invalidRecordsSnapshot.records.length, 0, 'Unverifiable structured facts are dropped')
  assert.equal(invalidRecordsSnapshot.segments.length, 1, 'The companionship narrative summary remains available')
  assert.ok(narrativeFallback.systemMemory.includes('双方关系经历重要转折'))
  checks.push('A valid companionship narrative is retained when an invalid structured fact is discarded')

  const retrySnapshot = emptySnapshot()
  const beforeTruncatedRetry = requests.length
  respond = ({ body }) => (body.system ?? body.messages[0].content).includes('必须精简输出以避免截断')
    ? extraction('截断后精简重试成功，保留本段重要关系。')
    : stream('{"summary":"尚未完整', 'length')
  const retried = await prepareContextMemory(optionsFor({
    mode: 'manual', sessionId: 'third-party-truncated-retry', snapshot: retrySnapshot,
    connection, history,
  }))
  const retryRequests = requests.slice(beforeTruncatedRetry)
  assert.equal(retryRequests.length, 2, 'A max_tokens finish retries once with a compact output prompt: ' + JSON.stringify({ failure: retried.compactionFailure, result: retried.compaction }))
  assert.ok(estimateContextTokens(retryRequests[1].body.messages[1].content) <
    estimateContextTokens(retryRequests[0].body.messages[1].content), 'The retry also shrinks the source sample')
  assert.equal(retrySnapshot.segments.length, 1, JSON.stringify({ failure: retried.compactionFailure, compaction: retried.compaction, attempts: retryRequests.length }))
  assert.ok(retried.systemMemory.includes('截断后精简重试成功'))
  checks.push('OpenAI-compatible max_tokens truncation retries with a shorter source sample and concise output requirements')
  respond = () => extraction()

  const burstSnapshot = structuredClone(snapshot)
  const burstHistory = [...history]
  const beforeBurst = requests.length
  for (let index = 0; index < 4; index++) {
    burstHistory.push(...round(750 + index, '补充一段原话。'.repeat(300), '继续说，我听着。'.repeat(300)))
    const burst = await prepareContextMemory(optionsFor({ history: burstHistory, snapshot: burstSnapshot }))
    assertWithinBudget(requestOf(burst))
    assert.equal(requests.length, beforeBurst + Number(index === 3), 'Repeated compression requires four newly completed turns as well as pressure')
  }
  checks.push('A burst of oversized turns keeps reply requests bounded and makes no further extraction until four new turns are complete')

  const savedSegmentCount = snapshot.segments.length
  const afterInitialExtraction = requests.length
  const agingHistory = [...history]
  const reusedProgress = []
  for (let index = 0; index < 16; index++) {
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
  const moreRounds = (first) => Array.from({ length: 64 }, (_, index) => round(first + index)).flat()
  agingHistory.push(...moreRounds(810))
  await prepareContextMemory(optionsFor({ snapshot, history: agingHistory }))
  assert.ok(requests.length > beforeAppend)
  assert.equal(requests.length - beforeAppend, 1)
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
  const afterContinuity = requests.length
  const nextContinuity = await prepareContextMemory(optionsFor({
    history: [...continuityHistory, ...round(218, '好。', '我在。')], snapshot: continuitySnapshot,
  }))
  assert.equal(requests.length, afterContinuity)
  assert.ok(nextContinuity.systemMemory.includes('[当前路径核心记忆]'))
  assert.ok(nextContinuity.systemMemory.includes('当前称呼为小禾'))
  assert.ok(!nextContinuity.systemMemory.includes('部分历史尚未整理'))
  const branchBHistory = structuredClone(continuityHistory)
  branchBHistory[16] = round(208)[0]
  const branchB = await prepareContextMemory(optionsFor({ history: branchBHistory, snapshot: structuredClone(continuitySnapshot) }))
  const branchBCore = branchB.systemMemory.split('[当前路径核心记忆]\n')[1].split('\n\n')[0]
  assert.ok(branchBCore.includes('用户喜欢小鹿这一称呼'))
  assert.ok(!branchBCore.includes('当前称呼为小禾'))
  checks.push('Evidence-backed preferences, promises and branch-specific corrections become core memory and keep their status when a fully covered checkpoint is reused')
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
  assert.equal(requests.length - beforeHuge, 1)
  assert.ok(huge.systemMemory.includes('纸鸢山约好周六散步'))
  assert.ok(huge.systemMemory.includes('部分历史尚未整理'))
  assert.ok(!huge.systemMemory.includes('[当前路径核心记忆]'))
  assert.equal(JSON.stringify(hugeHistory), hugeOriginal)
  assert.ok(requests.slice(beforeHuge).every(request => request.body.messages[1].content.length < 15000))
  assertWithinBudget({ system: huge.systemMemory, messages: toRequestMessages(huge.history, question), tools: [] })
  checks.push('An imported message exceeding sixteen batches can continue after one extraction; middle-history evidence is recovered directly from original text and incomplete coverage cannot claim a current core state')

  // This exercises bounded model input for an already-loaded 80 MiB session, not paged storage.
  const hugeMiddle = '我们在星灯桥约定十一月十九日见面。'
  const eightyMiB = 80 * 1024 * 1024
  const largeText = 'x'.repeat(eightyMiB / 2) + hugeMiddle + 'x'.repeat(eightyMiB / 2 - hugeMiddle.length)
  const largeHistory = [...round(500, largeText, '我记下这个约定。'), ...round(501, '今天好吗', '很好'), ...round(502, '继续', '我在')]
  assert.equal(largeHistory[0].content.length, eightyMiB)
  const largeRoutes = [
    { protocol: 'openai', baseUrl: 'https://openai-large.example.test/v1', endpoint: '/v1/chat/completions' },
    { protocol: 'anthropic', baseUrl: 'https://anthropic-large.example.test', endpoint: '/anthropic/v1/messages' },
    { protocol: 'deepseek', baseUrl: 'https://api.deepseek.com', endpoint: '/anthropic/v1/messages' },
  ]
  for (const route of largeRoutes) {
    const model = `large-fixture-${route.protocol}`
    const apiKey = `large-fixture-key-${route.protocol}`
    respond = () => route.protocol === 'openai'
      ? extraction('超长记录中段的见面约定。')
      : anthropicExtraction(JSON.stringify({ summary: '超长记录中段的见面约定。', records: [] }))
    const beforeEightyMiB = requests.length
    const large = await prepareContextMemory(optionsFor({
      sessionId: `eighty-mib-${route.protocol}`,
      history: largeHistory,
      question: { ...question, content: '星灯桥约定的见面日期是哪天？' },
      apiKey,
      model,
      connection: { protocol: route.protocol, baseUrl: route.baseUrl },
    }))
    assert.equal(requests.length - beforeEightyMiB, 1)
    assert.ok(large.systemMemory.includes(hugeMiddle))
    const request = requests[beforeEightyMiB]
    const userPrompt = route.protocol === 'openai' ? request.body.messages[1].content : request.body.messages[0].content
    const systemPrompt = route.protocol === 'openai' ? request.body.messages[0].content : request.body.system
    assert.ok(!userPrompt.includes(largeText), `${route.protocol} extraction must never serialize the complete 80 MiB source`)
    assert.ok(estimateContextTokens(userPrompt) < 8_000, `${route.protocol} extraction sample stays bounded`)
    assert.ok(estimateContextTokens(systemPrompt) + estimateContextTokens(userPrompt) + request.body.max_tokens + 700 <= 24_000)
    assert.equal(request.body.model, model)
    assert.ok(request.url.endsWith(route.endpoint))
    assert.equal(new Headers(request.init.headers).get(route.protocol === 'openai' ? 'Authorization' : 'x-api-key'),
      route.protocol === 'openai' ? `Bearer ${apiKey}` : apiKey)
    if (route.protocol === 'anthropic') assert.equal('safety_check' in request.body, false)
    if (route.protocol === 'deepseek') assert.deepEqual(request.body.safety_check, { level: 'high' })
    assertWithinBudget({ system: large.systemMemory, messages: toRequestMessages(large.history, question), tools: [] })
  }
  checks.push('The same already-loaded 80 MiB session resumes through OpenAI-compatible, Anthropic-compatible and official DeepSeek routes; every extraction uses the selected endpoint, key and model, preserves middle-history evidence, and sends only a bounded sample')
  respond = () => extraction()

  const oneMegHistory = [...round(700, 'x'.repeat(2_100_000), '收到。')]
  const beforeOneMegUnder = requests.length
  const belowDshThreshold = await prepareContextMemory(optionsFor({
    sessionId: 'one-meg-under-threshold', history: oneMegHistory, inputBudget: 1_000_000, outputReserve: 8_192,
  }))
  assert.equal(requests.length, beforeOneMegUnder, 'A large history below the DSH-style 80% trigger remains uncompressed')
  assert.deepEqual(belowDshThreshold.history, oneMegHistory)
  const overWindowHistory = [...round(701, 'x'.repeat(2_550_000), '收到。'), ...round(702, '继续。', '我在。')]
  const beforeOneMegOver = requests.length
  const aboveDshThreshold = await prepareContextMemory(optionsFor({
    sessionId: 'one-meg-over-threshold', history: overWindowHistory, inputBudget: 1_000_000, outputReserve: 8_192,
  }))
  assert.equal(requests.length - beforeOneMegOver, 1)
  assert.ok(aboveDshThreshold.systemMemory.includes('部分历史尚未整理'))
  assert.ok(aboveDshThreshold.history.length < overWindowHistory.length)
  assert.ok(estimateRequestTokens({
    system: aboveDshThreshold.systemMemory,
    messages: toRequestMessages(aboveDshThreshold.history, question),
    tools: [],
  }) < 250_000, 'A 1M-window request keeps the configured recent-tail fraction and never resends the 850k-token source sample')
  assert.ok(estimateContextTokens(requests[beforeOneMegOver].body.messages[1].content) < 8_000,
    'The memory request contains only the bounded sample, not the full imported history')
  checks.push('A configured 1M window uses the DSH-style 80% compaction trigger and roughly 16% retained tail while summary input remains bounded')

  const beforeInsufficientBudget = requests.length
  const insufficientBudget = await prepareContextMemory(optionsFor({
    mode: 'manual', sessionId: 'insufficient-extraction-budget', history: hugeHistory,
    inputBudget: 1_536, outputReserve: 128,
  }))
  assert.equal(requests.length, beforeInsufficientBudget, 'Do not call a model when even the smallest safe sample cannot fit')
  assert.equal(insufficientBudget.compaction, 'failed')
  assert.equal(insufficientBudget.compactionFailure, 'insufficientBudget')
  checks.push('A route with too little context for a safe extraction fails explicitly without sending a sample or claiming the history was compressed')

  const compressionRoutes = [
    { protocol: 'openai', baseUrl: 'https://openai-relay.example.test/v1', endpoint: '/v1/chat/completions' },
    { protocol: 'anthropic', baseUrl: 'https://anthropic-relay.example.test', endpoint: '/anthropic/v1/messages' },
    { protocol: 'deepseek', baseUrl: 'https://api.deepseek.com', endpoint: '/anthropic/v1/messages' },
  ]
  const routeSession = 'small-window-route-fixture'
  const routeSource = hugeHistory[0]
  const routeFingerprint = await memoryFingerprint(routeSource)
  for (const route of compressionRoutes) {
    const sessionId = `${routeSession}-${route.protocol}`
    const routeSnapshot = emptySnapshot()
    const routeSourceRef = { messageId: routeSource.id, fingerprint: routeFingerprint, start: 0, end: 100 }
    routeSnapshot.segments.push({
      id: `known-segment-${route.protocol}`, sessionId, sources: [routeSourceRef], summary: '较早的已整理片段。',
      provider: 'openai:https://qa-memory.example.test/v1', model: 'qa-model', createdAt: 1, extractorVersion: MEMORY_VERSION,
    })
    routeSnapshot.records.push(...Array.from({ length: 24 }, (_, index) => ({
      id: `known-record-${route.protocol}-${index}`, sessionId, kind: 'setting', actor: 'user', realm: 'self_report',
      key: `资料主题${index}`, text: '仍然喜欢保持温柔的称呼。', sources: [routeSourceRef],
      supersedes: [], extractedAt: 1, extractorVersion: MEMORY_VERSION,
    })))
    respond = request => request.url.endsWith('/chat/completions')
      ? extraction()
      : anthropicExtraction(JSON.stringify({ summary: '低窗口下的路由压缩完成。', records: [] }))
    const beforeRoute = requests.length
    const compacted = await prepareContextMemory(optionsFor({
      mode: 'manual', sessionId, history: hugeHistory, snapshot: routeSnapshot,
      inputBudget: 4_096, outputReserve: 512,
      connection: { protocol: route.protocol, baseUrl: route.baseUrl },
    }))
    assert.equal(compacted.compaction, 'saved', `${route.protocol} route should complete within its configured context`)
    assert.equal(requests.length, beforeRoute + 1)
    const sentRequest = requests.at(-1)
    const userPrompt = route.protocol === 'openai' ? sentRequest.body.messages[1].content : sentRequest.body.messages[0].content
    const systemPrompt = route.protocol === 'openai' ? sentRequest.body.messages[0].content : sentRequest.body.system
    assert.ok(userPrompt.includes('[本段原文]'))
    assert.ok(userPrompt.includes('已有记录'), 'Previously verified records are retained within the prompt budget')
    assert.ok(!userPrompt.includes(hugeHistory[0].content), 'A complete imported message must never be sent as the extraction sample')
    assert.ok(userPrompt.length < 15_000)
    assert.ok(estimateContextTokens(systemPrompt) + estimateContextTokens(userPrompt) + sentRequest.body.max_tokens + 700 <= 4_096,
      `${route.protocol} extraction prompt, output reserve, and safety margin fit the route context`)
    assert.ok(sentRequest.url.endsWith(route.endpoint))
    assert.equal(new Headers(sentRequest.init.headers).get(route.protocol === 'openai' ? 'Authorization' : 'x-api-key'),
      route.protocol === 'openai' ? 'Bearer memory-fixture-key' : 'memory-fixture-key')
    if (route.protocol === 'anthropic') assert.equal('safety_check' in sentRequest.body, false)
    if (route.protocol === 'deepseek') assert.deepEqual(sentRequest.body.safety_check, { level: 'high' })

    let adaptiveAttempts = 0
    respond = request => {
      if (adaptiveAttempts++ === 0) {
        return Response.json({ error: { message: 'maximum context length exceeded' } }, { status: 400 })
      }
      return route.protocol === 'openai'
        ? extraction()
        : anthropicExtraction(JSON.stringify({ summary: '自适应缩小后的整理完成。', records: [] }))
    }
    const beforeAdaptive = requests.length
    const adaptive = await prepareContextMemory(optionsFor({
      mode: 'manual', sessionId: `${sessionId}-unknown-window`, history: hugeHistory,
      inputBudget: 1_000_000, outputReserve: 8_192,
      connection: { protocol: route.protocol, baseUrl: route.baseUrl },
    }))
    assert.equal(adaptive.compaction, 'saved', `${route.protocol} route should retry an unreported provider context limit`)
    assert.equal(requests.length, beforeAdaptive + 2)
    const firstAttempt = requests[beforeAdaptive].body
    const smallerAttempt = requests[beforeAdaptive + 1].body
    const attemptPromptTokens = body => route.protocol === 'openai'
      ? estimateContextTokens(body.messages[0].content) + estimateContextTokens(body.messages[1].content)
      : estimateContextTokens(body.system) + estimateContextTokens(body.messages[0].content)
    assert.ok(attemptPromptTokens(smallerAttempt) < attemptPromptTokens(firstAttempt),
      `${route.protocol} retry must reduce the prompt budget even when the provider omits its window size`)
    assert.ok(smallerAttempt.max_tokens < firstAttempt.max_tokens,
      `${route.protocol} retry must also reduce the output reserve`)
  }
  checks.push('OpenAI-compatible, Anthropic-compatible, and official DeepSeek compression use the selected route and key, fit 4k budgets, omit full histories, and adapt prompt/output limits when context errors omit the provider window')

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
    const fallback = await prepareContextMemory(optionsFor({ sessionId: `credential-${status}`, history: hugeHistory }))
    assert.equal(fallback.compactionFailure, 'provider')
  }
  respond = () => { throw new Error('fixture network error') }
  const networkFallback = await prepareContextMemory(optionsFor({ sessionId: 'network-failure', history: hugeHistory }))
  assert.equal(networkFallback.compactionFailure, 'connection')
  for (const [id, response] of [
    ['truncated', () => stream('{"summary":"unfinished","records":[]}', 'length')],
    ['invalid-json', () => stream('not JSON')],
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
    const retryable = ['truncated', 'invalid-json', 'length-rejected'].includes(id)
    const expectedAttempts = id === 'length-rejected' ? 3 : retryable ? 2 : 1
    assert.equal(requests.length, beforeFailure + expectedAttempts)
    assert.equal(fallback.compactionFailure, id === 'length-rejected' ? 'contextLimit' :
      id === 'server-failure' ? 'provider' : id === 'truncated' ? 'truncated' :
        retryable ? 'invalidResponse' : 'truncated')
    if (id === 'length-rejected') {
      assert.ok(requests[beforeFailure + 1].body.messages[1].content.length < requests[beforeFailure].body.messages[1].content.length,
        'A context-limit rejection retries with a smaller source sample')
      assert.ok(requests[beforeFailure + 2].body.messages[1].content.length < requests[beforeFailure + 1].body.messages[1].content.length,
        'A repeated context-limit rejection progressively shrinks the source sample again')
    }
    await prepareContextMemory(failOptions)
    assert.equal(requests.length, beforeFailure + expectedAttempts, 'Another send during cooldown must reuse the local fallback')
  }
  let providerWindowAttempts = 0
  respond = () => providerWindowAttempts++ === 0
    ? errorResponse(400, 'user input too long, 70668 tokens exceeds max 4096 tokens')
    : extraction()
  const beforeProviderWindow = requests.length
  const learnedProviderWindow = await prepareContextMemory(optionsFor({
    mode: 'manual', sessionId: 'provider-reports-smaller-window', history: hugeHistory,
    inputBudget: 1_000_000, outputReserve: 8_192,
  }))
  assert.equal(learnedProviderWindow.compaction, 'saved')
  assert.equal(requests.length, beforeProviderWindow + 2)
  const retriedProviderRequest = requests.at(-1)
  const retriedPromptTokens = estimateContextTokens(retriedProviderRequest.body.messages[0].content) +
    estimateContextTokens(retriedProviderRequest.body.messages[1].content)
  assert.ok(retriedPromptTokens + retriedProviderRequest.body.max_tokens + 700 <= 4_096,
    'An explicit smaller provider window recalculates both input and output reserves for the retry')
  assert.ok(retriedProviderRequest.body.messages[1].content.length < requests.at(-2).body.messages[1].content.length)
  const incomplete = optionsFor({ sessionId: 'partially-extracted', history: hugeHistory })
  const partialBefore = requests.length
  const verifiedEvent = '用户在会话开场提到首段。'
  respond = () => extraction('抽样片段已整理。', [{
    kind: 'event', actor: 'user', realm: 'self_report', key: '开场', text: verifiedEvent,
    sources: [{ messageId: 'u-100', quote: '首段。' }], supersedes: [],
  }])
  const partial = await prepareContextMemory(incomplete)
  assert.ok(partial.systemMemory.includes('抽样片段已整理'))
  assert.ok(partial.systemMemory.includes('部分历史尚未整理'))
  assert.ok(partial.systemMemory.includes('[当前路径已核实的历史记录]'))
  assert.ok(partial.systemMemory.includes(verifiedEvent))
  assert.ok(!partial.systemMemory.includes('[当前路径核心记忆]'))
  assert.equal(requests.length, partialBefore + 1)
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
  const staleWrite = await prepareContextMemory(optionsFor({ sessionId: 'stale-write', onCommit: async () => false }))
  assert.equal(staleWrite.compactionFailure, 'storage')
  assert.equal(JSON.stringify(history), original)
  assert.equal(JSON.stringify(hugeHistory), hugeOriginal)
  checks.push('Recoverable extraction errors preserve verified segments, mark bounded local fallback as incomplete, and skip repeat extraction during cooldown; the send path refuses to use it as complete history')

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
  const beforeStoppedRetry = requests.length
  await prepareContextMemory(optionsFor({ snapshot: committedBeforeStop }))
  assert.equal(requests.length, beforeStoppedRetry)
  assert.equal(committedBeforeStop.segments.filter(segment => segment.id === firstStoppedId).length, 1)
  const abort = new AbortController()
  let release
  const fetched = new Promise(resolve => { release = resolve })
  respond = ({ init }) => { release(); return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })) }
  const pending = prepareContextMemory(optionsFor({ sessionId: 'stop-during-request', signal: abort.signal }))
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
      active: true,
      compaction: 'notNeeded',
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
  assert.deepEqual(tightContext, { history: [], systemMemory: '', requiredSystemMemory: '', active: true, compaction: 'notNeeded' })
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
  const routeLimitCases = [
    { protocol: 'openai', baseUrl: 'https://openai-budget.example.test/v1', endpoint: '/v1/chat/completions' },
    { protocol: 'anthropic', baseUrl: 'https://anthropic-budget.example.test', endpoint: '/anthropic/v1/messages' },
    { protocol: 'deepseek', baseUrl: 'https://api.deepseek.com', endpoint: '/anthropic/v1/messages' },
  ]
  const routeLimitHistory = [
    ...round(960, '我们约定用熟悉的称呼，慢慢分享今天的心情。'.repeat(50_000), '我记下了，会一直认真听你说。'),
    ...round(961, '今天好吗？', '我在。'),
    ...round(962, '我们继续吧。', '好，我陪着你。'),
  ]
  for (const [id, fixed] of [['chat-a', fixedA], ['chat-b', fixedB], ['chat-failure', '失败测试角色']]) {
    await db.saveSession({ id, title: id, createdAt: 1, updatedAt: 1, messages: structuredClone(history), contextMemory: { fixed } })
  }
  for (const route of routeLimitCases) {
    const id = `route-input-limit-${route.protocol}`
    await db.saveSession({ id, title: id, createdAt: 1, updatedAt: 1, messages: structuredClone(routeLimitHistory) })
  }
  const continuationPrefix = { ...round(999, '接着讲我们的旅途。', '尚未讲完的正文。')[1], model: 'deepseek-v4-pro', prefix: true, thinking: true, status: 'done', stopReason: 'max_tokens', latestReminder: '原回复的提醒快照', blocks: [{ type: 'thinking', thinking: '原思考', signature: 'continue-signature' }, { type: 'text', text: '尚未讲完的正文。' }] }
  await db.saveSession({ id: 'chat-continue', title: '续写测试', createdAt: 1, updatedAt: 1, messages: [...structuredClone(history), round(999, '接着讲我们的旅途。')[0], continuationPrefix], contextMemory: { fixed: '保持此会话旅途设定。' } })
  await db.saveSession({ id: 'chat-manual', title: '手动压缩测试', createdAt: 1, updatedAt: 1, messages: structuredClone(history) })
  await store.initChat()
  const wait = async predicate => {
    const deadline = Date.now() + 10000
    while (!await predicate()) {
      if (Date.now() > deadline) throw new Error('Store memory integration timed out')
      await new Promise(resolve => setTimeout(resolve, 5))
    }
  }

  settings.setContextMemoryEnabled(false)
  respond = request => isExtraction(request)
    ? extraction('手动整理的历史。')
    : stream('我在听，慢慢说。')
  store.selectSession('chat-manual')
  await wait(() => store.useChatStore.getState().sessionCache['chat-manual'])
  const manualId = 'chat-manual'
  const sendManualFixture = async text => {
    const start = requests.length
    drafts.setDraftText(manualId, text)
    assert.equal(store.sendMessage(manualId), true)
    await wait(() => !store.useChatStore.getState().streaming[manualId])
    assert.equal(requests.length - start, 1, 'Manual mode must never make an automatic extraction request')
    assert.equal(isExtraction(requests[start]), false)
    assert.equal(requests[start].body.messages.at(-1).content, text)
    return requests[start].body.messages
  }
  const fullMessages = await sendManualFixture('继续聊吧。')
  assert.ok(fullMessages.some(message => message.content === history[0].content))
  await wait(async () => (await db.loadSession(manualId)).messages.at(-1).status === 'done')
  const sourceBeforeCommand = await db.loadSession(manualId)
  const beforeCommand = requests.length
  const manualProgress = []
  const unsubscribe = store.useChatStore.subscribe(state => {
    if (state.contextProgress[manualId]?.manual) manualProgress.push(state.contextProgress[manualId])
  })
  try {
    assert.equal(await store.compactSession(manualId), 'saved')
  } finally {
    unsubscribe()
  }
  assert.equal(requests.length - beforeCommand, 1)
  assert.equal(isExtraction(requests[beforeCommand]), true)
  assert.ok(manualProgress.some(value => value.completed === 1 && value.total === 1))
  assert.deepEqual(await db.loadSession(manualId), sourceBeforeCommand, 'Manual compaction must not create or mutate a chat turn')
  assert.equal((await db.loadMemorySnapshot(manualId)).segments.length, 1)
  const compressedMessages = await sendManualFixture('嗯。')
  assert.ok(!compressedMessages.some(message => message.role === 'user' && message.content === history[0].content),
    'The saved checkpoint omits its older source turn from the next request')
  assert.ok(compressedMessages.some(message => message.role === 'system' && message.content.includes('手动整理的历史')))
  assert.ok(compressedMessages.some(message => message.role === 'assistant' && message.content === '我在听，慢慢说。'))
  assert.equal(settings.useSettings.getState().contextMemoryEnabled, false)
  settings.setContextMemoryEnabled(true)
  checks.push('With auto off the real store sends full history, a manual compaction makes one request and preserves every stored message, then chat reuses its checkpoint without another model call')

  assert.ok(estimateRequestTokens({
    system: '', messages: toRequestMessages(routeLimitHistory, question), tools: [],
  }) > 800_000, 'The store fixture exceeds the 1M route\'s 80% compaction threshold')
  const uploads = await import(new URL('services/attachments.ts', root))
  settings.setContextMemoryEnabled(false)
  for (const [index, route] of routeLimitCases.entries()) {
    const routeId = `route-input-limit-${route.protocol}`
    const apiKey = `route-input-limit-key-${route.protocol}`
    const model = `route-input-limit-model-${route.protocol}`
    settings.setApiConnection({ apiKey, apiBaseUrl: route.baseUrl, apiProtocol: route.protocol, model, models: [model] })
    settings.setGeneration({ ...settings.useSettings.getState().generation, contextTokens: 1_000_000 })
    assert.equal(store.getEffectiveContextInputBudget(), 1_000_000, `${route.protocol} starts with its configured 1M window`)
    store.selectSession(routeId)
    await wait(() => store.useChatStore.getState().sessionCache[routeId])

    let extractionCount = 0
    const chatRequests = []
    respond = request => {
      if (isExtraction(request)) {
        extractionCount += 1
        if (extractionCount === 1) {
          return errorResponse(400, 'user input too long, 70668 tokens exceeds max 4096 tokens')
        }
        return route.protocol === 'openai'
          ? extraction('长会话已按当前路由整理。')
          : anthropicExtraction(JSON.stringify({ summary: '长会话已按当前路由整理。', records: [] }))
      }
      chatRequests.push(request)
      if (route.protocol === 'openai' && index === 0) {
        return errorResponse(400, 'user input too long, 70668 tokens exceeds max 4096 tokens')
      }
      return route.protocol === 'openai'
        ? stream('续聊成功。')
        : anthropicExtraction('续聊成功。')
    }
    assert.equal(await store.compactSession(routeId), 'saved', `${route.protocol} learns the reported window during manual compaction`)
    assert.equal(extractionCount, 2)
    assert.equal(store.getEffectiveContextInputBudget(), Math.floor(4_096 * 0.85))
    const switchedKey = { ...settings.useSettings.getState(), apiKey: `${apiKey}-other` }
    settings.setApiConnection({ ...switchedKey, models: [model] })
    assert.equal(store.getEffectiveContextInputBudget(), 1_000_000, 'A different key on the same route does not inherit the learned limit')
    settings.setApiConnection({ apiKey, apiBaseUrl: route.baseUrl, apiProtocol: route.protocol, model, models: [model] })
    assert.equal(store.getEffectiveContextInputBudget(), Math.floor(4_096 * 0.85))

    let expectedAttachmentText
    if (route.protocol === 'openai') {
      const attachmentId = `${routeId}-note`
      const attachmentText = '附件补充：周五晚上一起看海，沿途慢慢聊。'
      expectedAttachmentText = attachmentText
      const blob = Object.assign(new Blob([attachmentText], { type: 'text/plain' }), { name: 'route-note.txt' })
      const draftMap = new Map(drafts.useDrafts.getState().drafts)
      draftMap.set(routeId, {
        text: '结合附件继续我们的聊天。',
        attachments: [{ id: attachmentId, file: blob, isImage: false, previewUrl: null, uploadPurpose: 'text_recognition' }],
      })
      drafts.useDrafts.setState({ drafts: draftMap })
      uploads.useUploads.setState(state => ({ tasks: {
        ...state.tasks,
        [attachmentId]: { status: 'done', localText: attachmentText },
      } }))
    } else {
      drafts.setDraftText(routeId, '结合刚才的内容继续聊。')
    }
    const beforeChat = requests.length
    assert.equal(store.sendMessage(routeId), true)
    await wait(() => !store.useChatStore.getState().streaming[routeId])
    assert.equal(chatRequests.length, 1, `${route.protocol} sends exactly one normal request and never retries a context rejection`)
    assert.equal(requests.length, beforeChat + 1)
    const chatRequest = chatRequests[0]
    assert.ok(chatRequest.url.endsWith(route.endpoint))
    assert.equal(chatRequest.body.model, model)
    const normalized = route.protocol === 'openai'
      ? { system: chatRequest.body.messages[0].content, messages: chatRequest.body.messages.slice(1), tools: [] }
      : { system: chatRequest.body.system, messages: chatRequest.body.messages, tools: [] }
    assert.ok(estimateRequestTokens(normalized) <= 4_096 * 0.85,
      `${route.protocol} normal chat reuses the provider-confirmed input budget`)
    if (route.protocol === 'openai') {
      assert.ok(JSON.stringify(chatRequest.body.messages).includes(expectedAttachmentText), 'The one submitted request still includes the local text attachment')
    }
    assert.equal(new Headers(chatRequest.init.headers).get(route.protocol === 'openai' ? 'Authorization' : 'x-api-key'),
      route.protocol === 'openai' ? `Bearer ${apiKey}` : apiKey)
  }
  checks.push('The real store learns a 4k provider window during manual compaction for a >800k-token, 1M-window history; OpenAI-compatible, Anthropic-compatible and official DeepSeek chats reuse the 3481-token budget, route/key limits stay isolated, and a document-bearing request is not retried')

  settings.setApiConnection({ apiKey: 'memory-fixture-key', apiBaseUrl: connection.baseUrl, apiProtocol: 'openai', model: 'qa-model', models: ['qa-model'] })
  settings.setContextMemoryEnabled(true)
  const sent = []
  respond = request => {
    if (isExtraction(request)) return extraction('本段日常分享。')
    sent.push(request.body)
    return stream('我们约好周五去看海。')
  }
  settings.setGeneration({ ...settings.useSettings.getState().generation, contextTokens: 24_000 })
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
  for (const [index, message] of ['继续我们的聊天', '1'].entries()) {
    drafts.setDraftText('chat-failure', message)
    assert.equal(store.sendMessage('chat-failure'), true)
    await wait(() => !store.useChatStore.getState().streaming['chat-failure'])
    const reply = store.useChatStore.getState().sessionCache['chat-failure'].messages.at(-1)
    assert.equal(reply.status, 'error')
    assert.equal(reply.error?.localMessage?.key, index === 0 ? 'contextMemoryManualResponseFailed' : 'contextMemoryAutoCooldown', JSON.stringify(reply.error))
  }
  assert.equal(sent.length, 1, 'The chat model is never sent a lossy recent-only history after failed compaction')
  const failedExtractions = requests.slice(beforeFallback).filter(isExtraction)
  assert.equal(failedExtractions.length, 2, 'An invalid extraction gets one bounded shrink retry, then cooldown suppresses another send')
  assert.ok(failedExtractions[1].body.messages[1].content.length < failedExtractions[0].body.messages[1].content.length)
  const fallbackSnapshot = await db.loadMemorySnapshot('chat-failure')
  assert.equal(fallbackSnapshot.segments.length, 0)
  assert.equal(fallbackSnapshot.records.length, 0)
  assert.deepEqual(fallbackSnapshot.session.messages.slice(0, history.length).map(({id})=>id), history.map(({id})=>id))
  checks.push('An unusable summary is not saved or used to omit older turns from a chat request; the retry cooldown is explicit and source history remains intact')

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
  assert.equal(continuations[0].messages.some(message => message.role === 'latest_reminder'), false)
  const sentPrefix = continuations[0].messages.at(-1)
  assert.equal(sentPrefix.role, 'assistant')
  assert.ok(sentPrefix.content.some(block => block.type === 'text' && block.text === '尚未讲完的正文。'))
  assert.ok(sentPrefix.content.some(block => block.type === 'thinking' && block.thinking === '原思考' && block.signature === 'continue-signature'))
  const completedContinuation = store.useChatStore.getState().sessionCache['chat-continue'].messages.at(-1)
  assert.equal(completedContinuation.status, 'done')
  assert.equal(completedContinuation.blocks.filter(block => block.type === 'text').map(block => block.text).join(''), '尚未讲完的正文。续写完成。')
  assert.equal((await db.loadMemorySnapshot('chat-continue')).session.contextMemory.fixed, '保持此会话旅途设定。')
  checks.push('The real V4 Pro continuation path accepts its saved pending snapshot, compresses long prior history, preserves original text/thinking/signature/model, omits unsupported latest_reminder, and appends the new answer')

  settings.setContextMemoryEnabled(false)
  settings.setApiConnection({ apiKey: 'default-budget-key', apiBaseUrl: 'https://default-budget.example.test/v1', apiProtocol: 'openai', model: 'default-budget-model', models: ['default-budget-model'] })
  const defaultSystem = '设'.repeat(50_000)
  settings.setGeneration({ system: defaultSystem })
  assert.equal(store.getEffectiveContextInputBudget(), 128_000)
  const defaultBudgetId = 'default-budget-chat'
  await db.saveSession({ id: defaultBudgetId, title: '默认请求预算', createdAt: 1, updatedAt: 1, messages: structuredClone(routeLimitHistory) })
  store.useChatStore.setState(state => ({ sessions: [...state.sessions, { id: defaultBudgetId, title: '默认请求预算', createdAt: 1, updatedAt: 1 }] }))
  store.selectSession(defaultBudgetId)
  await wait(() => store.useChatStore.getState().sessionCache[defaultBudgetId])
  respond = () => stream('默认预算请求完成。')
  drafts.setDraftText(defaultBudgetId, '请继续。')
  const beforeDefaultBudget = requests.length
  assert.equal(store.sendMessage(defaultBudgetId), true)
  await wait(() => !store.useChatStore.getState().streaming[defaultBudgetId])
  assert.equal(requests.length, beforeDefaultBudget + 1)
  const defaultBudgetRequest = requests.at(-1).body
  assert.equal(defaultBudgetRequest.messages[0].content, defaultSystem,
    'A 50,000-character global prompt remains intact under the default request budget')
  assert.ok(estimateRequestTokens({
    system: defaultBudgetRequest.messages[0].content,
    messages: defaultBudgetRequest.messages.slice(1).map(({ role, content }) => ({
      role, content: role === 'assistant' ? [{ type: 'text', text: content }] : content,
    })),
    tools: defaultBudgetRequest.tools ?? [],
  }) <= 128_000, 'The default store request fits the bounded input budget')
  assert.equal(defaultBudgetRequest.messages.at(-1).content, '请继续。')
  const persistedDefaultBudget = await db.loadSession(defaultBudgetId)
  assert.equal(persistedDefaultBudget.messages.length, routeLimitHistory.length + 2)
  assert.equal(persistedDefaultBudget.messages[0].content, routeLimitHistory[0].content,
    'Request fitting never deletes or rewrites the oversized local history')
  checks.push('With no per-route context setting, a very long store request uses the 128k default budget, keeps the newest question, and preserves the complete local history')

  await writeFile(new URL('deepstay-context-memory-evidence.json', import.meta.url), JSON.stringify({ passed: true, runtime: process.version, checks, extractionRequests: requests.filter(isExtraction).length, scope: 'Real context memory pipeline, IndexedDB, OpenAI adapter and SSE parser with deterministic fixture responses. No paid upstream calls; model semantic quality requires separate evaluation.' }, null, 2))
  console.log(JSON.stringify({ passed: true, checks, extractionRequests: requests.filter(isExtraction).length }, null, 2))
} finally { hooks.deregister() }
