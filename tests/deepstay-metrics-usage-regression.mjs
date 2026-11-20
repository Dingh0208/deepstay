import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { registerHooks, stripTypeScriptTypes } from 'node:module'
import { fileURLToPath } from 'node:url'

const src = new URL('../src/', import.meta.url)
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL?.startsWith(src.href)) {
      const candidate = new URL(specifier.slice(0, -3) + '.ts', context.parentURL)
      if (existsSync(fileURLToPath(candidate))) return { url: candidate.href, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    return url.startsWith(src.href) && new URL(url).pathname.endsWith('.ts')
      ? { format: 'module', source: stripTypeScriptTypes(readFileSync(new URL(url), 'utf8'), { mode: 'transform' }), shortCircuit: true }
      : nextLoad(url, context)
  },
})
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} }
globalThis.__API_ORIGIN__ = 'https://api.deepseek.com'
globalThis.fetch = async () => { throw new Error('No network calls allowed') }

try {
  const { readMessageEvent } = await import(new URL('services/api/parseEvent.ts', src))
  const { applyEvent, settleReply } = await import(new URL('services/chat/reply.ts', src))
  const { getReplyMetrics, estimateSessionContext } = await import(new URL('services/chat/replyMetrics.ts', src))
  const { appendBranch, normalizeSession } = await import(new URL('services/chat/branches.ts', src))
  const user = (id, text) => ({ id, role: 'user', content: text, files: [], createdAt: 0 })
  const answer = (id, text) => ({ id, role: 'assistant', blocks: [{ type: 'text', text }], model: null, prefix: false, status: 'done', createdAt: 1 })
  const seed = { ...answer('answer', '正文'), metrics: { system: 10, tools: 5, messages: 85 } }
  const indexes = new Map()
  let reply = applyEvent(seed, readMessageEvent({
    type: 'message_start', message: { id: 'stream', model: 'fixture', usage: { input_tokens: 100, cache_read_input_tokens: 0 } },
  }), 0, indexes)
  assert.equal(getReplyMetrics(reply).cacheHitPercentage, undefined, 'Initial zero is provisional while generating')
  assert.equal(getReplyMetrics(reply).context.occupied, 100)
  assert.equal(getReplyMetrics(reply).context.reported, false)
  const usageOnly = readMessageEvent({
    type: 'message_delta', delta: { stop_reason: null }, usage: { input_tokens: 20, cache_read_input_tokens: 80, output_tokens: 12 },
  })
  assert.ok(usageOnly, 'Cache statistics arriving before the terminal stop reason must be consumed')
  reply = applyEvent(reply, usageOnly, 1, indexes)
  assert.equal(reply.stopReason, undefined)
  assert.equal(getReplyMetrics(reply).cacheHitPercentage, undefined, 'Intermediate percentages are not final display values')
  assert.equal(getReplyMetrics(reply).context.occupied, 100, 'Streaming context stays on the fixed outbound snapshot')
  assert.equal(getReplyMetrics(reply).context.output, undefined, 'Provisional output counters are not presented as final usage')
  const finished = readMessageEvent({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 12 } })
  reply = applyEvent(reply, finished, 2, indexes)
  reply = applyEvent(reply, readMessageEvent({ type: 'message_delta', delta: {}, usage: { output_tokens: 13 } }), 3, indexes)
  assert.equal(reply.stopReason, 'end_turn', 'Later usage-only deltas preserve completion semantics')
  assert.equal(getReplyMetrics(reply).context.occupied, 100)
  assert.equal(getReplyMetrics(reply).cacheHitPercentage, undefined, 'A stop reason alone does not end the stream')
  reply = settleReply(reply, 'done', 4)
  assert.equal(getReplyMetrics(reply).context.occupied, 113, 'Only the finalized reply publishes the provider total')
  assert.equal(getReplyMetrics(reply).context.reported, true)
  assert.equal(getReplyMetrics(reply).cacheHitPercentage, 0.8)
  assert.equal(getReplyMetrics({ ...seed, status: 'pending', usage: { input_tokens: 100, cache_read_input_tokens: 0 } }).cacheHitPercentage, undefined)
  assert.equal(getReplyMetrics({ ...seed, usage: { input_tokens: 10, cache_read_input_tokens: 80, cache_creation_input_tokens: 10, output_tokens: 900 } }).cacheHitPercentage, 0.8,
    'The denominator includes cache creation input and excludes output tokens, matching DSH')
  assert.equal(readMessageEvent({ type: 'message_delta', delta: { stop_reason: 'bad-reason' }, usage: { input_tokens: 1 } }), null)
  assert.equal(readMessageEvent({ type: 'message_delta', delta: {}, usage: {} }), null)
  assert.equal(getReplyMetrics({ ...seed, usage: { input_tokens: 100 } }).cacheHitPercentage, undefined)
  assert.equal(getReplyMetrics({ ...seed, usage: { input_tokens: 100, cache_read_input_tokens: 0, output_tokens: 0 } }).cacheHitPercentage, 0)
  assert.equal(getReplyMetrics({ ...seed, usage: { input_tokens: 100, cache_read_input_tokens: 0 } }).cacheHitPercentage, undefined,
    'An incomplete usage object does not masquerade as a final cached request')
  const incomplete = getReplyMetrics({ ...seed, usage: { input_tokens: 900_000, cache_read_input_tokens: 0 } })
  assert.equal(incomplete.context.input, 100, 'A done reply missing output usage retains the outbound snapshot instead of partial prompt counters')
  assert.equal(incomplete.context.occupied, 100)
  assert.equal(incomplete.context.reported, false)
  assert.equal(incomplete.context.output, undefined)
  assert.equal(getReplyMetrics({ ...seed, metrics: undefined, usage: { input_tokens: 900_000 } }), undefined,
    'Incomplete final usage without a snapshot remains unknown')
  for (const status of ['stopped', 'error']) {
    const interrupted = getReplyMetrics({ ...reply, status })
    assert.equal(interrupted.cacheHitPercentage, undefined)
    assert.equal(interrupted.context.occupied, 100)
    assert.equal(interrupted.context.reported, false)
    assert.equal(interrupted.context.output, undefined)
  }
  assert.equal(getReplyMetrics({ ...reply, status: 'streaming', metrics: undefined }), undefined,
    'No request snapshot or final usage remains unknown rather than using partial provider counters')

  const session = normalizeSession({
    id: 'imported', title: 'Synthetic import', createdAt: 0, updatedAt: 1,
    messages: [user('u1', '你好'.repeat(100)), answer('a1', '记得我们的约定'.repeat(100))],
  })
  const estimate = estimateSessionContext(session, '本次全局设定', [])
  assert.ok(estimate.system > 0 && estimate.tools >= 0 && estimate.messages > 256)
  const importedMetrics = getReplyMetrics(session.messages[1], estimate)
  assert.equal(importedMetrics.context.occupied, estimate.system + estimate.tools + estimate.messages)
  assert.equal(importedMetrics.context.reported, false)
  assert.deepEqual({
    system: importedMetrics.context.system, tools: importedMetrics.context.tools, messages: importedMetrics.context.messages,
  }, estimate, 'Imported conversations have all locally estimated breakdown values')
  const next = appendBranch(session, 'a1', [user('u2', '新问题'.repeat(100))])
  assert.ok(estimateSessionContext(next, '本次全局设定', []).messages > estimate.messages)
  const branch = appendBranch(session, 'u1', [answer('alternate', '另一答')])
  const branchEstimate = estimateSessionContext(branch, '本次全局设定', [])
  assert.ok(branchEstimate.messages < estimate.messages, 'Unselected history does not inflate the local context estimate')
  const reported = getReplyMetrics({ ...seed, metrics: undefined, usage: { input_tokens: 5, cache_read_input_tokens: 15, output_tokens: 4 } }, estimate)
  assert.equal(reported.context.occupied, 24, 'Provider-reported totals take precedence over the local fallback')
  assert.deepEqual([reported.context.system, reported.context.tools, reported.context.messages], [estimate.system, estimate.tools, estimate.messages])
  const snapshot = { system: 1, tools: 2, messages: 3, tokensPerSecond: 7 }
  const saved = getReplyMetrics({ ...seed, metrics: snapshot }, estimate)
  assert.equal(saved.context.occupied, 6)
  assert.equal(saved.tokensPerSecond, 7)
  assert.equal(saved.context.system, 1, 'Saved outbound snapshot takes precedence over a history estimate')

  console.log(JSON.stringify({ passed: true, checks: [
    'Initial and chunk cache percentages remain hidden until the reply settles, then final cache statistics include writes and exclude output.',
    'Context uses a fixed sent snapshot during generation; completed replies publish final usage while stopped/error partial counters remain estimates or unknown.',
    'Usage-only intermediate deltas preserve nonzero cache usage and do not erase the final stop reason.',
    'Actual zero cache hits and unknown cache statistics remain distinct.',
    'Imported and older conversations receive branch-specific local context estimates without network calls.',
    'Current user text, selected branches, reported totals and saved request snapshots retain precedence.',
  ], scope: 'Actual parser, reply reducer and local metrics code with synthetic messages; no model requests or real user data.' }, null, 2))
} finally {
  hooks.deregister()
}
