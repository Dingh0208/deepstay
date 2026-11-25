import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
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
await import(new URL('services/settings.ts', root))
const { prepareContextMemory, previewContextMemory } = await import(new URL('services/chat/contextMemory.ts', root))
const { MEMORY_VERSION, memoryFingerprint, memoryText } = await import(new URL('services/chat/memoryRecords.ts', root))
const requests = []
// Every path below must decide locally; a model call is a regression, not something to answer.
globalThis.fetch = async url => { requests.push(String(url)); throw new Error(`Unexpected model request: ${url}`) }
const question = { id: 'latest', role: 'user', content: '我们上次约好什么时候散步？', files: [], createdAt: Date.UTC(2026, 10, 18) }
const round = index => [
  { id: `u-${index}`, role: 'user', content: `用户第${index}次分享。`, files: [], createdAt: Date.UTC(2026, 10, 1) + index * 60000 },
  { id: `a-${index}`, role: 'assistant', model: 'qa-model', thinking: false, status: 'done', stopReason: 'end_turn', prefix: false, blocks: [{ type: 'text', text: '助手说愿意耐心陪伴。' }], createdAt: Date.UTC(2026, 10, 1) + index * 60000 + 1000 },
]
const optionsFor = (history, overrides = {}) => ({
  sessionId: 'skip-reason-chat', history, question, apiKey: 'memory-fixture-key', connection: { baseUrl: 'https://qa-memory.example.test/v1', protocol: 'openai' },
  model: 'qa-model', signal: new AbortController().signal, snapshot: { records: [], segments: [] },
  onCommit: async () => true, ...overrides,
})

try {
  const twoRounds = [0, 1].flatMap(round)
  const threeRounds = [0, 1, 2].flatMap(round)
  // Each assertion compares [compaction, compactionSkipReason]: a reason may only tag a notNeeded outcome.
  const outcome = async (history, overrides) => {
    const { compaction, compactionSkipReason } = await prepareContextMemory(optionsFor(history, overrides))
    assert.ok(!compactionSkipReason || compaction === 'notNeeded')
    return [compaction, compactionSkipReason]
  }
  assert.deepEqual(await outcome(twoRounds, { mode: 'manual' }), ['notNeeded', 'tooShort'])
  assert.deepEqual(await outcome(twoRounds, { mode: 'auto' }), [undefined, undefined])
  assert.deepEqual(await outcome(threeRounds, { mode: 'manual', requestOverhead: 30_000 }), ['notNeeded', 'requiredSystemTooLarge'])
  assert.deepEqual(await outcome(threeRounds, { mode: 'auto', requestOverhead: 30_000 }), ['notNeeded', undefined])
  // Everything before the retained turn is already covered by a saved segment.
  const sources = await Promise.all(threeRounds.slice(0, 4).map(async message => ({
    messageId: message.id, start: 0, end: memoryText(message).length, fingerprint: await memoryFingerprint(message),
  })))
  const snapshot = { records: [], segments: [{ id: 'saved-segment', sessionId: 'skip-reason-chat', sources, summary: '已整理。', provider: 'openai:https://qa-memory.example.test', model: 'qa-model', createdAt: 1, extractorVersion: MEMORY_VERSION, checkpoint: { retainedFromId: 'u-2', lastReplyId: 'a-2', complete: true } }] }
  assert.deepEqual(await outcome(threeRounds, { mode: 'manual', snapshot }), ['notNeeded', 'nothingExtracted'])
  assert.deepEqual(await outcome(threeRounds, { mode: 'auto', snapshot }), ['notNeeded', undefined])
  const reused = await previewContextMemory(optionsFor(threeRounds, { snapshot }))
  assert.deepEqual([reused.compaction, reused.compactionSkipReason], ['notNeeded', undefined])
  assert.deepEqual(requests, [], 'A skipped compaction never calls the model')
  console.log(JSON.stringify({ passed: true, checks: [
    'A manual compaction of fewer than 3 turns reports tooShort; the automatic path stays untagged',
    'A manual compaction whose system prompt already exceeds the budget reports requiredSystemTooLarge; the automatic path stays untagged',
    'A manual compaction with nothing left to extract reports nothingExtracted; the automatic and reuse paths reach the same result untagged',
  ], scope: 'Real context memory preparation with synthetic chats and one saved segment. No model calls: each skipped manual compaction must decide locally.' }, null, 2))
} finally { hooks.deregister() }
