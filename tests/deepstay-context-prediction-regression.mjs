import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { registerHooks, stripTypeScriptTypes } from 'node:module'
import { fileURLToPath } from 'node:url'
import 'fake-indexeddb/auto'
import { IDBObjectStore } from 'fake-indexeddb'

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
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} }
globalThis.__API_ORIGIN__ = 'https://api.deepseek.com'
let network = 0
globalThis.fetch = async () => { network++; throw new Error('Prediction must never call a provider') }

try {
  const { predictNextContext } = await import(new URL('services/chat/contextPrediction.ts', src))
  const db = await import(new URL('services/chat/db.ts', src))
  const { normalizeSession, appendBranch } = await import(new URL('services/chat/branches.ts', src))
  const { memoryFingerprint, MEMORY_VERSION } = await import(new URL('services/chat/memoryRecords.ts', src))
  const { getReplyMetrics } = await import(new URL('services/chat/replyMetrics.ts', src))
  const user = (id, content, files = []) => ({ id, role: 'user', content, files, createdAt: 1 })
  const assistant = (id, text) => ({ id, role: 'assistant', blocks: [{ type: 'text', text }], model: null, prefix: false, status: 'done', createdAt: 2 })
  const session = normalizeSession({ id: 'prediction', title: 'Synthetic only', createdAt: 0, updatedAt: 1,
    messages: Array.from({ length: 12 }, (_, i) => [user(`u${i}`, `第${i}轮原话`.repeat(350)), assistant(`a${i}`, `第${i}轮回答`.repeat(350))]).flat(),
  })
  session.messages.at(-1).metrics = { system: 1, tools: 2, messages: 3 }
  session.messages.at(-1).usage = { input_tokens: 80, output_tokens: 20, cache_read_input_tokens: 40 }
  await db.saveSession(session)
  const options = { session, text: '', files: [], system: '当前设定', tools: [], model: 'fixture', thinking: false,
    connection: { baseUrl: 'https://api.deepseek.com', protocol: 'deepseek' }, inputBudget: 1_000_000,
    signal: new AbortController().signal,
  }
  const full = await predictNextContext(options)
  assert.ok(full.messages > 6, 'The next request is derived from the current branch, never an old request snapshot')
  assert.equal(getReplyMetrics(session.messages.at(-1)).context.occupied, 140, 'Recent actual usage remains a separate, unchanged measurement')
  const source = session.messages[0]
  const snapshot = await db.loadMemorySnapshot(session.id)
  await db.commitMemoryUpdate(snapshot.state, { records: [], segments: [{
    id: 'saved-checkpoint', sessionId: session.id,
    sources: [{ messageId: source.id, fingerprint: await memoryFingerprint(source), start: 0, end: source.content.length }],
    summary: '已核验历史脉络', provider: 'fixture', model: 'fixture', createdAt: 3, extractorVersion: MEMORY_VERSION,
    checkpoint: { retainedFromId: 'u10', lastReplyId: 'a11', complete: true },
  }] })
  const originalPut = IDBObjectStore.prototype.put, originalGet = IDBObjectStore.prototype.get
  let writes = 0, sessionReads = 0
  IDBObjectStore.prototype.put = function (...args) { writes++; throw new Error('Prediction cannot persist') }
  IDBObjectStore.prototype.get = function (...args) {
    if (this.name === 'sessions') { sessionReads++; throw new Error('Prediction must reuse the loaded session instead of copying large history') }
    return originalGet.apply(this, args)
  }
  try {
    const compacted = await predictNextContext(options)
    assert.ok(compacted.messages < full.messages, 'A saved compaction checkpoint reduces the next request without a new model call')
    const changed = await predictNextContext({ ...options, system: '新人物与全局设定'.repeat(200) })
    assert.ok(changed.system > compacted.system)
    const typed = await predictNextContext({ ...options, text: '新的输入'.repeat(100) })
    assert.ok(typed.messages > compacted.messages, 'Current draft text changes the next request estimate')
    const file = { id: 'doc', serverId: 'file-doc', name: 'synthetic.pdf', size: 1, mimeType: 'application/pdf', isImage: false }
    const withFile = await predictNextContext({ ...options, files: [file] })
    const withoutFile = await predictNextContext({ ...options, files: [{ ...file, contextExcluded: true }] })
    assert.ok(withFile.messages > withoutFile.messages, 'Paused attachments no longer occupy the predicted input')
    const textOnly = await predictNextContext({ ...options, files: [file], connection: { baseUrl: 'https://relay.example.test/v1', protocol: 'openai' } })
    assert.ok(textOnly.messages < withFile.messages, 'Text-only third-party requests do not include file blocks')
    const branch = appendBranch(session, 'u0', [assistant('alternative', '另一条选中的回答')])
    const branched = await predictNextContext({ ...options, session: branch })
    assert.ok(branched.messages < full.messages, 'Unselected branches and their checkpoint are excluded')
    const edited = appendBranch(session, null, [user('edited-u', 'Edited source'), assistant('edited-a', 'New reply')])
    const editedEstimate = await predictNextContext({ ...options, session: edited })
    assert.ok(editedEstimate.messages < compacted.messages, 'An edited source has a new ID and cannot retain the old checkpoint')
    const invalidRange = { ...session, messages: session.messages.map((message, i) => i === 0 ? { ...message, content: 'short' } : message) }
    const invalidEstimate = await predictNextContext({ ...options, session: invalidRange })
    assert.ok(invalidEstimate.messages > compacted.messages, 'An impossible saved evidence range cannot activate the checkpoint')
    const stopped = new AbortController(); stopped.abort()
    await assert.rejects(predictNextContext({ ...options, signal: stopped.signal }), error => error.name === 'AbortError')
    const afterCancellation = await predictNextContext(options)
    assert.deepEqual(afterCancellation, compacted, 'Cancelling a prediction does not poison later reuse')
    assert.equal(writes, 0)
    assert.equal(sessionReads, 0)
  } finally {
    IDBObjectStore.prototype.put = originalPut
    IDBObjectStore.prototype.get = originalGet
  }
  const large = normalizeSession({ id: 'prediction-large', title: 'Synthetic 80 MiB', createdAt: 0, updatedAt: 1,
    messages: session.messages.map((message, i) => i === 0 ? { ...message, content: 'x'.repeat(80 * 1024 * 1024) } : message),
  })
  await db.saveSession(large)
  const largeOptions = { ...options, session: large }
  const uncompressed = await predictNextContext(largeOptions)
  const largeSnapshot = await db.loadDerivedMemory(large.id)
  const largeSource = large.messages[0]
  // The ASCII fixture allows a valid existing SHA-256 without creating another 80 MiB JSON string.
  const hash = createHash('sha256').update(JSON.stringify([largeSource.id, largeSource.role, largeSource.createdAt]).slice(0, -1) + ',"')
    .update(largeSource.content).update('"]').digest('hex')
  await db.commitMemoryUpdate(largeSnapshot.state, { records: [], segments: [{
    id: 'large-checkpoint', sessionId: large.id,
    sources: [{ messageId: largeSource.id, fingerprint: hash, start: 0, end: 100 }],
    summary: 'Synthetic committed checkpoint', provider: 'fixture', model: 'fixture', createdAt: 3, extractorVersion: MEMORY_VERSION,
    checkpoint: { retainedFromId: 'u10', lastReplyId: 'a11', complete: true },
  }] })
  const digest = crypto.subtle.digest
  let hashCalls = 0
  crypto.subtle.digest = function () { hashCalls++; throw new Error('Read-only prediction must not hash large original messages') }
  const baseline = process.memoryUsage().rss
  let peak = baseline
  const monitor = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss) }, 5)
  try {
    const started = performance.now()
    const prediction = await predictNextContext(largeOptions)
    const firstMs = performance.now() - started
    assert.ok(prediction.messages < uncompressed.messages, 'An 80 MiB source retains its saved checkpoint in prediction')
    const typingStarted = performance.now()
    for (const text of ['new draft', 'new draft words']) await predictNextContext({ ...largeOptions, text })
    const typingMs = performance.now() - typingStarted
    const hugeTail = { ...large, messages: [...large.messages, user('large-tail-u', largeSource.content), assistant('large-tail-a', 'Tail reply')] }
    await predictNextContext({ ...largeOptions, session: hugeTail })
    assert.equal(hashCalls, 0, 'Neither committed sources, typing nor new uncovered huge turns cause cryptographic copies')
    peak = Math.max(peak, process.memoryUsage().rss)
    console.log(JSON.stringify({ fixtureBytes: 80 * 1024 * 1024, firstPredictionMs: Math.round(firstMs),
      twoDraftPredictionsMs: Math.round(typingMs), extraPeakRssMiB: Math.round((peak - baseline) / 1024 / 1024), hashCalls,
      fullMessages: uncompressed.messages, compactedMessages: prediction.messages }))
  } finally {
    clearInterval(monitor)
    crypto.subtle.digest = digest
  }
  assert.equal(network, 0)
  console.log('Next context prediction: current branch/draft/system, saved checkpoints, attachment pause, route, cancellation, zero provider calls/writes and no full-session DB reads passed')
} finally {
  hooks.deregister()
}
