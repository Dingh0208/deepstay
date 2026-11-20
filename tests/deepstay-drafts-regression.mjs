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
const key = 'deepstay:chat-drafts'
const saved = new Map([[key, JSON.stringify([['existing', '未发送文字'], [null, '新对话草稿']])]])
let writes = 0
globalThis.localStorage = {
  getItem: name => saved.get(name) ?? null,
  setItem: (name, value) => { writes++; saved.set(name, value) },
  removeItem: name => { writes++; saved.delete(name) },
}
globalThis.__API_ORIGIN__ = 'https://api.deepseek.com'
globalThis.fetch = async () => { throw new Error('No network calls allowed') }
const lifecycle = () => {
  globalThis.window = new EventTarget()
  globalThis.document = Object.assign(new EventTarget(), { visibilityState: 'visible' })
}
lifecycle()

try {
  const draft = await import(new URL('services/chat/drafts.ts', src))
  assert.equal(draft.getDraft('existing').text, '未发送文字', 'A saved chat draft is ready before input mounts')
  assert.equal(draft.getDraft(null).text, '新对话草稿')
  draft.setDraftText('existing', '新输入优先')
  assert.equal(draft.getDraft('existing').text, '新输入优先')
  assert.equal(writes, 0, 'Typing does not synchronously serialize all drafts')
  document.visibilityState = 'hidden'
  document.dispatchEvent(new Event('visibilitychange'))
  assert.equal(writes, 1, 'Backgrounding flushes a pending edit before the debounce expires')
  assert.equal(new Map(JSON.parse(saved.get(key))).get('existing'), '新输入优先')

  lifecycle()
  const restarted = await import(new URL('services/chat/drafts.ts?restart', src))
  assert.equal(restarted.getDraft('existing').text, '新输入优先')
  assert.deepEqual(restarted.getDraft('existing').attachments, [])
  restarted.setDraftText('existing', '即将发送')
  restarted.clearSentDraft('existing')
  assert.equal(new Map(JSON.parse(saved.get(key))).has('existing'), false, 'Accepted sends remove persisted text immediately')
  restarted.setDraftText('existing', '下一轮仍可输入')
  restarted.clearDraft('existing')
  assert.equal(restarted.getDraft('existing').text, '')
  window.dispatchEvent(new Event('pagehide'))
  assert.equal(new Map(JSON.parse(saved.get(key))).has('existing'), false, 'A pending write cannot resurrect a deleted draft')
  restarted.setDraftText('existing', '重新导入同一会话后可以输入')
  assert.equal(restarted.getDraft('existing').text, '重新导入同一会话后可以输入', 'A legitimately reused session ID is never permanently blocked')
  window.dispatchEvent(new Event('pagehide'))
  assert.equal(new Map(JSON.parse(saved.get(key))).get('existing'), '重新导入同一会话后可以输入')

  restarted.clearAllDrafts()
  assert.equal(saved.has(key), false)
  restarted.setDraftText('existing', '清空历史后导回仍可输入')
  assert.equal(restarted.getDraft('existing').text, '清空历史后导回仍可输入')
  restarted.setDraftText(null, '删除历史后仍可新建')
  for (let i = 0; i < 35; i++) restarted.setDraftText(`recent-${i}`, `文字-${i}`)
  const before = writes
  await new Promise(resolve => setTimeout(resolve, 450))
  assert.equal(writes, before + 1, 'Rapid changes produce one debounced write')
  const bounded = new Map(JSON.parse(saved.get(key)))
  assert.equal(bounded.size, 30)
  assert.equal(bounded.has('recent-0'), false)
  assert.equal(bounded.get('recent-34'), '文字-34')

  restarted.useDrafts.setState({ drafts: new Map([['with-attachment', { text: '仅文字恢复', attachments: [{ id: 'private-file', file: { name: 'private.docx' }, serverId: 'must-not-persist' }] }]]) })
  window.dispatchEvent(new Event('pagehide'))
  assert.equal(saved.get(key).includes('private'), false, 'File metadata and server identifiers are never persisted with drafts')
  lifecycle()
  const textOnly = await import(new URL('services/chat/drafts.ts?text-only', src))
  assert.deepEqual(textOnly.getDraft('with-attachment'), { text: '仅文字恢复', attachments: [] })

  textOnly.setDraftText('large-newest', '大'.repeat(500_001))
  window.dispatchEvent(new Event('pagehide'))
  assert.equal(new Map(JSON.parse(saved.get(key))).has('large-newest'), false, 'Oversized drafts are not silently truncated into a misleading partial restore')
  assert.equal(textOnly.getDraft('large-newest').text.length, 500_001, 'Persistence bounds never truncate the active input')

  saved.set(key, '{unreadable')
  lifecycle()
  const corrupt = await import(new URL('services/chat/drafts.ts?corrupt', src))
  assert.equal(corrupt.getDraft(null).text, '')
  corrupt.setDraftText(null, '损坏草稿后仍可正常输入')
  window.dispatchEvent(new Event('pagehide'))
  assert.equal(new Map(JSON.parse(saved.get(key))).get(null), '损坏草稿后仍可正常输入')

  globalThis.localStorage = { getItem: () => { throw new Error('Unavailable') }, setItem: () => { throw new Error('Quota') }, removeItem: () => { throw new Error('Unavailable') } }
  lifecycle()
  const unavailable = await import(new URL('services/chat/drafts.ts?unavailable', src))
  unavailable.setDraftText(null, '存储不可用仍能输入')
  window.dispatchEvent(new Event('pagehide'))
  assert.equal(unavailable.getDraft(null).text, '存储不可用仍能输入')
  unavailable.clearSentDraft(null)
  assert.equal(unavailable.getDraft(null).text, '')
  console.log('Draft persistence: restore, current-input precedence, background flush, debounce, send/delete, bounds, text-only and unavailable storage passed')
} finally {
  hooks.deregister()
}
