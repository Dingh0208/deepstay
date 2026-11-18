import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { registerHooks, stripTypeScriptTypes } from 'node:module'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

const sourceRoot = new URL('../src/', import.meta.url)
await import(new URL('../node_modules/fake-indexeddb/auto/index.mjs', import.meta.url))
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL?.startsWith(sourceRoot.href)) {
      const candidate = new URL(specifier.slice(0, -3) + '.ts', context.parentURL)
      if (existsSync(fileURLToPath(candidate))) return { url: candidate.href, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url.startsWith(sourceRoot.href) && url.endsWith('.ts')) {
      let source = readFileSync(new URL(url), 'utf8')
      if (url === new URL('services/chat/db.ts', sourceRoot).href) {
        // Delay only this real database read; keep the production import, staging and transaction code.
        const original = /export const loadSession = async \(id: string\): Promise<Session \| undefined> =>\r?\n  \(await getDB\(\)\)\.get\('sessions', id\)/
        assert.match(source, original)
        source = source.replace(original, `export const loadSession = async (id: string): Promise<Session | undefined> => {
          await globalThis.__beforeSessionRead?.(id)
          return (await getDB()).get('sessions', id)
        }`)
      }
      return { format: 'module', source: stripTypeScriptTypes(source, { mode: 'transform' }), shortCircuit: true }
    }
    return nextLoad(url, context)
  },
})

const local = new Map([['chat-demo:api-key', 'import-display-fixture-key']])
globalThis.localStorage = { getItem: key => local.get(key) ?? null, setItem: (key, value) => local.set(key, value), removeItem: key => local.delete(key) }
globalThis.window = new EventTarget()
globalThis.document = Object.assign(new EventTarget(), { visibilityState: 'visible', compatMode: 'CSS1Compat' })
Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh-CN' }, configurable: true })
globalThis.__API_ORIGIN__ = 'https://api.deepseek.com'
let networkRequests = 0
globalThis.fetch = async () => { networkRequests += 1; throw new Error('Import regression must remain local') }
const checks = []

try {
  const db = await import(new URL('services/chat/db.ts', sourceRoot))
  const store = await import(new URL('services/chat/store.ts', sourceRoot))
  const backup = await import(new URL('services/chat/backup.ts', sourceRoot))
  const branches = await import(new URL('services/chat/branches.ts', sourceRoot))
  const settings = await import(new URL('services/settings.ts', sourceRoot))
  const { describeReply } = await import(new URL('services/chat/describe.ts', sourceRoot))
  const { translate } = await import(new URL('i18n/index.ts', sourceRoot))
  const rawStream = 'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"测试"}}\n\n'
  const plainError = { status: 'error', blocks: [] }
  const importedError = { ...plainError, blocks: [{ type: 'text', isTemplate: true, text: rawStream }] }
  const expected = { text: translate('replyInvalidStream') }
  assert.deepEqual(describeReply({ ...plainError, error: { kind: 'protocol', status: 200, message: rawStream } }), expected)
  assert.deepEqual(describeReply(importedError), expected)
  assert.deepEqual(describeReply({ ...importedError, status: 'done' }), { text: rawStream, presentation: 'response' })
  assert.deepEqual(describeReply({ ...plainError, error: { kind: 'http', status: 400, message: 'Model is unavailable' } }), { text: 'Model is unavailable' })
  checks.push('Saved raw protocol errors and imported raw error templates show a localized notice while valid response templates and readable errors retain their text')
  const now = 1_700_000_000_000
  const sessions = Array.from({ length: 15 }, (_, index) => {
    const messages = Array.from({ length: 36 }, (_, round) => [
      { id: `u-${round}`, role: 'user', content: `第 ${index} 个会话第 ${round} 问：${'今天的事情慢慢聊。'.repeat(80)}`, files: [], createdAt: now + round * 2 },
      { id: `a-${round}`, role: 'assistant', model: 'deepseek-flash', prefix: true, status: 'done', stopReason: 'end_turn',
        blocks: [{ type: 'text', text: `第 ${index} 个会话第 ${round} 答：${'我会认真听你说。'.repeat(120)}` }], createdAt: now + round * 2 + 1 },
    ]).flat()
    return { id: randomUUID(), title: `导入会话 ${index}`, createdAt: now, updatedAt: now + index, messages }
  })
  const latest = sessions[sessions.length - 1]
  for (const session of sessions) await db.saveSession(session)
  await store.initChat()
  const archive = await backup.exportHistory()
  assert.ok(archive.blob.size > 1_000_000)
  await backup.clearHistory()
  assert.equal(store.useChatStore.getState().activeId, null)
  assert.deepEqual(store.useChatStore.getState().sessions, [])

  let releaseRead, enterRead
  const entered = new Promise(resolve => { enterRead = resolve })
  const blocked = new Promise(resolve => { releaseRead = resolve })
  const reads = []
  globalThis.__beforeSessionRead = async id => {
    reads.push(id)
    enterRead('details-read-started')
    await blocked
  }
  const snapshots = []
  const unsubscribe = store.useChatStore.subscribe(state => snapshots.push({
    busy: state.importingHistory, count: state.sessions.length, activeId: state.activeId,
    latestLoaded: Boolean(state.sessionCache[state.activeId]),
  }))
  let resolved = false
  const importing = backup.importHistory(new File([archive.blob], archive.name, { type: 'application/zip' }))
  importing.then(() => { resolved = true })
  const first = await Promise.race([entered, importing.then(() => 'returned-before-details')])
  assert.equal(first, 'details-read-started', 'Import must select and read the latest chat before reporting completion')
  assert.equal(store.useChatStore.getState().importingHistory, false)
  assert.equal(store.useChatStore.getState().sessions.length, sessions.length)
  assert.equal(store.useChatStore.getState().sessions.find(item => item.id === store.useChatStore.getState().activeId).title, latest.title)
  assert.equal(resolved, false, 'Success must wait for the delayed first detail read')
  const importedLatestId = store.useChatStore.getState().activeId
  assert.notEqual(importedLatestId, latest.id)
  assert.deepEqual(reads, [importedLatestId], 'Only the initially displayed chat should be loaded')
  checks.push('A delayed first detail read keeps import pending and other chats usable after the complete sorted list is published')
  releaseRead()
  assert.equal(await importing, sessions.length)
  unsubscribe()
  delete globalThis.__beforeSessionRead
  const state = store.useChatStore.getState()
  assert.equal(state.importingHistory, false)
  assert.equal(state.activeId, importedLatestId)
  assert.deepEqual(state.sessions.map(session => session.title), sessions.slice().reverse().map(session => session.title))
  assert.equal(state.sessionCache[importedLatestId].messages.length, latest.messages.length)
  assert.ok(snapshots.some(snapshot => snapshot.latestLoaded))
  assert.equal(Object.keys(state.sessionCache).length, 1)
  checks.push('Success resolves with all 15 chats listed and the latest 72-message chat ready; other details stay lazy')

  for (const session of sessions) {
    const restored = await db.loadSession(state.sessions.find(item => item.title === session.title).id)
    assert.equal(restored.title, session.title)
    const messages = branches.getVisibleMessages(restored)
    assert.equal(messages.length, session.messages.length)
    for (let index = 0; index < messages.length; index += 1) {
      assert.equal(messages[index].role, session.messages[index].role)
      if (messages[index].role === 'user') assert.equal(messages[index].content, session.messages[index].content)
      else assert.equal(messages[index].blocks[0].text, session.messages[index].blocks[0].text)
    }
  }
  assert.equal(settings.useSettings.getState().apiKey, 'import-display-fixture-key')
  checks.push('Actual ZIP round trip preserves all 1,080 messages, full long text and the locally stored API Key')

  await assert.rejects(backup.importHistory(new File([archive.blob.slice(0, archive.blob.size - 10)], 'truncated.zip')))
  assert.equal(store.useChatStore.getState().activeId, importedLatestId)
  assert.equal(store.useChatStore.getState().sessions.length, sessions.length)
  assert.equal((await db.loadSession(importedLatestId)).messages.length, latest.messages.length)
  assert.equal(store.useChatStore.getState().importingHistory, false)
  checks.push('A truncated archive leaves the current list, selected chat and committed history intact and leaves chat interactions available')

  await backup.clearHistory()
  assert.deepEqual(store.useChatStore.getState().sessions, [])
  assert.deepEqual(store.useChatStore.getState().sessionCache, {})
  assert.equal(store.useChatStore.getState().activeId, null)
  assert.equal((await db.loadSessionSummaries()).length, 0)
  assert.equal(settings.useSettings.getState().apiKey, 'import-display-fixture-key')
  assert.equal(networkRequests, 0)
  checks.push('Clear-all still returns to the empty welcome page, preserves the API Key and requires no network calls')
  const evidence = { passed: true, runtime: process.version, archiveBytes: archive.blob.size,
    sessions: sessions.length, messages: sessions.reduce((count, session) => count + session.messages.length, 0),
    checks, snapshots, networkRequests,
    scope: 'Actual store, backup, archive and IndexedDB transaction code with in-memory IndexedDB; only the first detail read is gated to verify completion ordering. No real user history is touched.' }
  await writeFile(new URL('./deepstay-import-display-evidence.json', import.meta.url), JSON.stringify(evidence, null, 2) + '\n')
  console.log(JSON.stringify(evidence, null, 2))
} finally {
  hooks.deregister()
}
