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
  const { applyEvent } = await import(new URL('services/chat/reply.ts', src))
  const { getReplyMetrics, estimateSessionContext } = await import(new URL('services/chat/replyMetrics.ts', src))
  const { appendBranch, normalizeSession } = await import(new URL('services/chat/branches.ts', src))
  const user = (id, text) => ({ id, role: 'user', content: text, files: [], createdAt: 0 })
  const answer = (id, text) => ({ id, role: 'assistant', blocks: [{ type: 'text', text }], model: null, prefix: false, status: 'done', createdAt: 1 })
  const seed = answer('answer', '正文')
  const indexes = new Map()
  let reply = applyEvent(seed, readMessageEvent({
    type: 'message_start', message: { id: 'stream', model: 'fixture', usage: { input_tokens: 100, cache_read_input_tokens: 0 } },
  }), 0, indexes)
  const usageOnly = readMessageEvent({
    type: 'message_delta', delta: { stop_reason: null }, usage: { input_tokens: 20, cache_read_input_tokens: 80, output_tokens: 12 },
  })
  assert.ok(usageOnly, 'Cache statistics arriving before the terminal stop reason must be consumed')
  reply = applyEvent(reply, usageOnly, 1, indexes)
  assert.equal(reply.stopReason, undefined)
  assert.equal(getReplyMetrics(reply).cacheHitPercentage, 0.8)
  const finished = readMessageEvent({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 12 } })
  reply = applyEvent(reply, finished, 2, indexes)
  reply = applyEvent(reply, readMessageEvent({ type: 'message_delta', delta: {}, usage: { output_tokens: 13 } }), 3, indexes)
  assert.equal(reply.stopReason, 'end_turn', 'Later usage-only deltas preserve completion semantics')
  assert.equal(getReplyMetrics(reply).context.occupied, 113)
  assert.equal(getReplyMetrics(reply).cacheHitPercentage, 0.8)
  assert.equal(readMessageEvent({ type: 'message_delta', delta: { stop_reason: 'bad-reason' }, usage: { input_tokens: 1 } }), null)
  assert.equal(readMessageEvent({ type: 'message_delta', delta: {}, usage: {} }), null)
  assert.equal(getReplyMetrics({ ...seed, usage: { input_tokens: 100 } }).cacheHitPercentage, undefined)
  assert.equal(getReplyMetrics({ ...seed, usage: { input_tokens: 100, cache_read_input_tokens: 0 } }).cacheHitPercentage, 0)

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
  const reported = getReplyMetrics({ ...seed, usage: { input_tokens: 5, cache_read_input_tokens: 15, output_tokens: 4 } }, estimate)
  assert.equal(reported.context.occupied, 24, 'Provider-reported totals take precedence over the local fallback')
  assert.deepEqual([reported.context.system, reported.context.tools, reported.context.messages], [estimate.system, estimate.tools, estimate.messages])
  const snapshot = { system: 1, tools: 2, messages: 3, tokensPerSecond: 7 }
  const saved = getReplyMetrics({ ...seed, metrics: snapshot }, estimate)
  assert.equal(saved.context.occupied, 6)
  assert.equal(saved.tokensPerSecond, 7)
  assert.equal(saved.context.system, 1, 'Saved outbound snapshot takes precedence over a history estimate')

  console.log(JSON.stringify({ passed: true, checks: [
    'Usage-only intermediate deltas preserve nonzero cache usage and do not erase the final stop reason.',
    'Actual zero cache hits and unknown cache statistics remain distinct.',
    'Imported and older conversations receive branch-specific local context estimates without network calls.',
    'Current user text, selected branches, reported totals and saved request snapshots retain precedence.',
  ], scope: 'Actual parser, reply reducer and local metrics code with synthetic messages; no model requests or real user data.' }, null, 2))
} finally {
  hooks.deregister()
}
