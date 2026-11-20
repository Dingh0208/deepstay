import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { registerHooks, stripTypeScriptTypes } from 'node:module'
import { fileURLToPath } from 'node:url'

const src = new URL('../src/', import.meta.url)
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.startsWith(src.href) && specifier.startsWith('.') && specifier.endsWith('.js')) {
      const candidate = new URL(specifier.slice(0, -3) + '.ts', context.parentURL)
      if (existsSync(fileURLToPath(candidate))) return { url: candidate.href, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url.startsWith(src.href) && new URL(url).pathname.endsWith('.ts')) {
      return {
        format: 'module',
        source: stripTypeScriptTypes(readFileSync(new URL(url), 'utf8'), { mode: 'transform' }),
        shortCircuit: true,
      }
    }
    return nextLoad(url, context)
  },
})

try {
  const { appendBranch, buildMessageVersions, getVisibleMessages, normalizeSession, removeBranchMessages, replaceSessionReply, selectVersion } =
    await import(new URL('services/chat/branches.ts', src))

  const makeMessage = (index) => ({
    id: `m${index}`,
    parentId: index ? `m${index - 1}` : null,
    selectedChildId: index < 49_999 ? `m${index + 1}` : undefined,
    role: index % 2 ? 'assistant' : 'user',
    content: `history ${index}`,
    ...(index % 2 ? { blocks: [], status: 'done', prefix: false, model: null } : { files: [] }),
    createdAt: index,
  })
  const messageCount = 50_000
  const raw = {
    id: 'large-session',
    title: 'Long synthetic history',
    createdAt: 0,
    updatedAt: messageCount,
    rootMessageId: 'm0',
    messages: Array.from({ length: messageCount }, (_, index) => makeMessage(index)),
  }

  const oldVisibleMessages = (session) => {
    const byId = new Map()
    for (const message of session.messages) byId.set(message.id, message)
    const path = []
    let id = session.rootMessageId
    while (id) {
      const message = byId.get(id)
      if (!message) break
      path.push(message)
      byId.delete(id)
      id = message.selectedChildId ?? null
    }
    return path
  }
  const oldMessageVersions = (session, shown) => {
    const groups = new Map()
    for (const message of shown) groups.set(message.parentId, [])
    for (const message of session.messages) groups.get(message.parentId)?.push(message.id)
    return new Map(shown.map((message) => [message.id, groups.get(message.parentId) ?? [message.id]]))
  }
  const oldReplyUpdate = (session, reply) => ({
    ...session,
    messages: session.messages.map((message) =>
      message.id === reply.id
        ? { ...reply, parentId: message.parentId, selectedChildId: message.selectedChildId }
        : message
    ),
  })
  const reply = { ...raw.messages.at(-1), blocks: [{ type: 'text', text: 'next token' }], status: 'streaming' }
  const updated = replaceSessionReply(normalizeSession(raw), reply)
  assert.equal(updated.messages.length, messageCount)
  assert.equal(updated.messages.at(-1).content, reply.content)
  assert.equal(updated.messages.at(-1).parentId, raw.messages.at(-1).parentId)
  assert.equal(updated.linearMessagePath, true)
  assert.equal(getVisibleMessages(updated), updated.messages, 'A linear path reuses the message array')
  assert.equal(getVisibleMessages(updated).at(-1).id, reply.id)

  const appended = appendBranch(updated, 'm49999', [
    { id: 'm50000', role: 'user', content: 'next', files: [], createdAt: messageCount },
    { id: 'm50001', role: 'assistant', blocks: [], status: 'pending', prefix: false, model: null, createdAt: messageCount + 1 },
  ])
  assert.equal(appended.linearMessagePath, true)
  assert.deepEqual(getVisibleMessages(appended).slice(-2).map(({ id }) => id), ['m50000', 'm50001'])

  const branched = appendBranch(updated, 'm49997', [
    { id: 'alternate', role: 'assistant', blocks: [], status: 'done', prefix: false, model: null, createdAt: messageCount + 2 },
  ])
  assert.equal(branched.linearMessagePath, false)
  assert.equal(getVisibleMessages(branched).at(-1).id, 'alternate')
  assert.deepEqual(buildMessageVersions(branched, new Map(), getVisibleMessages(branched).slice(-24)).get('alternate')?.ids,
    ['m49998', 'alternate'])
  const switchedBack = selectVersion(branched, 'm49998')
  assert.equal(getVisibleMessages(switchedBack).at(-1).id, 'm49999')
  const linearAgain = removeBranchMessages(branched, new Set(['alternate']))
  assert.equal(linearAgain.linearMessagePath, true)
  assert.equal(getVisibleMessages(linearAgain).length, messageCount)

  const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
  const measure = (fn) => {
    fn()
    const samples = []
    for (let index = 0; index < 7; index++) {
      const start = performance.now()
      fn()
      samples.push(performance.now() - start)
    }
    return median(samples)
  }
  let previousVersions = new Map()
  const baselineSwitchMs = measure(() => {
    const visible = oldVisibleMessages(raw)
    oldMessageVersions(raw, visible.slice(-24))
  })
  const optimizedColdSwitchMs = measure(() => {
    const normalized = normalizeSession(raw)
    const visible = getVisibleMessages(normalized)
    buildMessageVersions(normalized, new Map(), visible.slice(-24))
  })
  const normalized = normalizeSession(raw)
  const baselineStreamFrameMs = measure(() => {
    const session = oldReplyUpdate(raw, reply)
    const visible = oldVisibleMessages(session)
    oldMessageVersions(session, visible.slice(-24))
  })
  const optimizedStreamFrameMs = measure(() => {
    const session = replaceSessionReply(normalized, reply)
    const visible = getVisibleMessages(session)
    const versions = buildMessageVersions(session, previousVersions, visible.slice(-24))
    previousVersions = new Map(versions)
  })

  console.log(JSON.stringify({
    passed: true,
    messageCount,
    baseline: {
      switchMedianMs: Math.round(baselineSwitchMs * 100) / 100,
      streamFrameMedianMs: Math.round(baselineStreamFrameMs * 100) / 100,
      fullHistoryPassesPerStreamFrame: 3,
      messageArrayUpdate: 'map callback over every stored message',
    },
    optimized: {
      coldSwitchAndNormalizeMedianMs: Math.round(optimizedColdSwitchMs * 100) / 100,
      streamFrameMedianMs: Math.round(optimizedStreamFrameMs * 100) / 100,
      fullHistoryPassesPerStreamFrame: 0,
      messageArrayUpdate: 'slice reference copy plus one tail replacement',
    },
    ratio: {
      switch: Math.round((baselineSwitchMs / optimizedColdSwitchMs) * 100) / 100,
      streamFrame: Math.round((baselineStreamFrameMs / optimizedStreamFrameMs) * 100) / 100,
    },
    checks: [
      'A normalized linear 50,000-message history reuses its stored array as the visible path.',
      'Tail stream updates preserve branch links and avoid full-history JavaScript map callbacks.',
      'Appending at the selected tail stays linear; adding an alternate branch, switching versions, and deleting that branch preserve path semantics.',
    ],
    note: 'Wall-clock medians are local Node.js measurements, not Android/WebView latency. Array immutability still requires copying message references on each streamed update.',
  }, null, 2))
} finally {
  hooks.deregister()
}
