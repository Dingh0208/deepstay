import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { registerHooks, stripTypeScriptTypes } from 'node:module'
import { fileURLToPath } from 'node:url'

const sourceRoot = new URL('../src/', import.meta.url)
const fakeRoot = new URL('../../', import.meta.resolve('fake-indexeddb'))
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
      return { format: 'module', source: stripTypeScriptTypes(readFileSync(new URL(url), 'utf8'), { mode: 'transform' }), shortCircuit: true }
    }
    // The test's IndexedDB emulator itself uses Object.hasOwn. Adapt only that test
    // dependency; native IndexedDB on the handset does not execute its JavaScript.
    if (url.startsWith(fakeRoot.href) && url.endsWith('.js')) {
      return { format: 'module', source: readFileSync(new URL(url), 'utf8').replaceAll('Object.hasOwn(', 'Object.prototype.hasOwnProperty.call('), shortCircuit: true }
    }
    return nextLoad(url, context)
  },
})
await import(new URL('auto/index.mjs', fakeRoot))
const local = new Map([['chat-demo:api-key', 'compatibility-fixture-key']])
globalThis.localStorage = { getItem: key => local.get(key) ?? null, setItem: (key, value) => local.set(key, value), removeItem: key => local.delete(key) }
globalThis.window = new EventTarget()
globalThis.document = Object.assign(new EventTarget(), { visibilityState: 'visible', compatMode: 'CSS1Compat' })
Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh-CN' }, configurable: true })
globalThis.__API_ORIGIN__ = 'https://api.deepseek.com'
let networkRequests = 0
globalThis.fetch = async () => { networkRequests += 1; throw new Error('Compatibility fixtures must remain local') }

const absent = [[Object, 'hasOwn'], [Array.prototype, 'at'], [Array.prototype, 'toReversed'], [Array.prototype, 'toSorted']]
const descriptors = absent.map(([object, key]) => Object.getOwnPropertyDescriptor(object, key))
const checks = []
try {
  for (const [object, key] of absent) delete object[key]
  assert.ok(absent.every(([object, key]) => typeof object[key] === 'undefined'))
  const { hasOwn } = await import(new URL('utils/object.ts', sourceRoot))
  const inherited = Object.create({ inherited: 'not owned', toString: 'inherited name' })
  inherited.hasOwnProperty = 'shadowed method'
  const dictionary = Object.create(null)
  dictionary.__proto__ = 'literal key'
  assert.equal(hasOwn(inherited, 'inherited'), false)
  assert.equal(hasOwn(inherited, 'hasOwnProperty'), true)
  assert.equal(hasOwn(dictionary, '__proto__'), true)
  assert.equal(hasOwn(dictionary, 'missing'), false)
  assert.equal(hasOwn({}, 'toString'), false)
  const i18n = await import(new URL('i18n/index.ts', sourceRoot))
  assert.equal(i18n.isTranslationKey('settings'), true)
  assert.equal(i18n.isTranslationKey('toString'), false)
  assert.equal(i18n.translate('settings'), '设置')
  checks.push('Cold imports, translation lookup and own-key checks work without Object.hasOwn, including inherited, shadowed and null-prototype keys')

  const { subscribeMediaQuery } = await import(new URL('utils/mediaQuery.ts', sourceRoot))
  for (const modern of [true, false]) {
    const active = new Set(), calls = []
    const query = modern ? {
      addEventListener(type, listener) { assert.equal(type, 'change'); active.add(listener); calls.push('addEventListener') },
      removeEventListener(type, listener) { assert.equal(type, 'change'); assert.equal(active.delete(listener), true); calls.push('removeEventListener') },
    } : {
      addListener(listener) { active.add(listener); calls.push('addListener') },
      removeListener(listener) { assert.equal(active.delete(listener), true); calls.push('removeListener') },
    }
    let changes = 0
    const off = subscribeMediaQuery(query, event => { assert.equal(event.matches, true); changes += 1 })
    for (const listener of active) listener({ matches: true })
    off()
    for (const listener of active) listener({ matches: true })
    assert.equal(changes, 1)
    assert.deepEqual(calls, modern ? ['addEventListener', 'removeEventListener'] : ['addListener', 'removeListener'])
  }
  checks.push('Media-query changes deliver once and cleanup removes the same listener through both modern and legacy addListener APIs')

  const { groupSessions } = await import(new URL('services/chat/sessionGroups.ts', sourceRoot))
  const now = new Date(2026, 10, 18).getTime()
  const summaries = [0, 0, 1, 3, 12, 40].map((days, index) => ({ id: `group-${index}`, title: '', createdAt: now, updatedAt: now - days * 86400000 }))
  const groups = groupSessions(summaries, now, key => key)
  assert.deepEqual(groups.map(group => group.sessions.length), [2, 1, 1, 1, 1])
  assert.deepEqual(groups.flatMap(group => group.sessions), summaries)
  assert.deepEqual(groupSessions([], now), [])
  checks.push('Empty and populated session timelines group correctly without Array.at and preserve all original summaries')

  const reply = await import(new URL('services/chat/reply.ts', sourceRoot))
  const view = await import(new URL('services/chat/view.ts', sourceRoot))
  const { toMdAst } = await import(new URL('services/markdown/parse.ts', sourceRoot))
  const user = { id: 'u1', role: 'user', createdAt: now, files: [], content: '兼容性问题' }
  const answer = { id: 'a1', role: 'assistant', createdAt: now + 1, model: 'deepseek-flash', prefix: true, status: 'done', stopReason: 'end_turn', blocks: [
    { type: 'text', text: '第一段' }, { type: 'thinking', thinking: '思考内容', startedAt: now, endedAt: now + 1500 },
    { type: 'text', text: '第二段\n', citations: [{ type: 'web_search_result_location', url: 'https://example.com/source', title: '来源' }] },
  ] }
  const request = reply.toRequestMessages([user, answer], { ...user, id: 'u2', content: '下一问' })
  assert.deepEqual(request[1].content, [{ type: 'text', text: '第一段' }, { type: 'text', text: '\n\n第二段\n' }])
  const result = view.buildReplyView(answer, false)
  assert.equal(result.answer.text, '第二段\n')
  assert.equal(result.answer.markdown, '第二段[citation:1]\n')
  assert.equal(result.sources[0].url, 'https://example.com/source')
  assert.ok(view.getAreaTitle(result, false, now + 2000))
  const search = { ...answer, blocks: [{ type: 'server_tool_use', id: 'search', name: 'deepseek_web_search', kind: 'deep_search', input: { action: 'search', queries: ['q'] } }] }
  assert.ok(view.getAreaTitle(view.buildReplyView(search, true), true, now))
  const options = { sources: result.sources, disableLink: false }
  const ast = toMdAst(result.answer.markdown, options)
  const reused = toMdAst(result.answer.markdown, options, ast)
  assert.deepEqual(reused, ast)
  assert.equal(reused.children[0], ast.children[0])
  checks.push('Request text boundaries, thinking/tool views, citation Markdown and stable AST reuse work while Array.at and Object.hasOwn are absent')

  const branches = await import(new URL('services/chat/branches.ts', sourceRoot))
  const { toSessionFile } = await import(new URL('services/chat/history/toArchive.ts', sourceRoot))
  const { toLocalSession } = await import(new URL('services/chat/history/toLocal.ts', sourceRoot))
  const session = { id: 'compat-session', title: '兼容记录', createdAt: now, updatedAt: now + 3, rootMessageId: 'u1', messages: [
    { ...user, selectedChildId: 'a2', parentId: null }, { ...answer, parentId: 'u1' },
    { ...answer, id: 'a2', parentId: 'u1', createdAt: now + 2, usage: { total_tokens: 42 }, blocks: [{ type: 'text', text: '选中的分支 — 尾部完整' }] },
  ] }
  const file = toSessionFile(session, () => null)
  assert.equal(file.messages[2].accumulated_token_usage, 42)
  const originalMessageOrder = file.messages.map(message => message.id)
  file.messages.reverse()
  const reversedInput = file.messages.map(message => message.id)
  const restoredTree = toLocalSession(file).session
  assert.deepEqual(file.messages.map(message => message.id), reversedInput)
  assert.deepEqual(restoredTree.messages.map(message => Number(message.id)), originalMessageOrder)
  assert.equal(branches.getVisibleMessages(restoredTree)[1].blocks[0].text, '选中的分支 — 尾部完整')
  checks.push('Archive conversion sorts a copied list, retains the selected branch and leaves unordered input intact without toSorted/toReversed/at')

  const db = await import(new URL('services/chat/db.ts', sourceRoot))
  const store = await import(new URL('services/chat/store.ts', sourceRoot))
  const backup = await import(new URL('services/chat/backup.ts', sourceRoot))
  await db.saveSession(session)
  await store.initChat()
  assert.equal(store.useChatStore.getState().ready, true)
  assert.equal(store.useChatStore.getState().initError, false)
  assert.equal(branches.getVisibleMessages(await db.loadSession(session.id))[1].usage.total_tokens, 42)
  const archive = await backup.exportHistory()
  assert.ok(archive.blob.size > 0)
  await backup.clearHistory()
  assert.equal(await backup.importHistory(new File([archive.blob], archive.name, { type: 'application/zip' })), 1)
  assert.equal(store.useChatStore.getState().sessions.length, 1)
  const restored = await db.loadSession(store.useChatStore.getState().activeId)
  assert.notEqual(restored.id, 'compat-session')
  assert.equal(restored.title, session.title)
  assert.equal(restored.messages.length, 3)
  assert.equal(branches.getVisibleMessages(restored)[1].blocks[0].text, '选中的分支 — 尾部完整')
  assert.equal(branches.getVisibleMessages(restored)[1].usage, undefined)
  assert.equal(local.get('chat-demo:api-key'), 'compatibility-fixture-key')
  assert.equal(networkRequests, 0)
  checks.push('Actual database/store cold initialization and ZIP export/import retain all three messages, selected branch and API Key with zero network calls')
  checks.push('IndexedDB preserves provider-reported reply usage; ZIP export records the total and ZIP import does not fabricate per-request usage from cumulative archive counts')
  const evidence = { passed: true, runtime: process.version, missingAPIs: absent.map(([, key]) => key), checks, networkRequests,
    scope: 'Actual TypeScript modules with four native APIs removed. In-memory IndexedDB emulator only; no device/browser data or network. Test dependency own-key calls use an equivalent private adapter, not an application polyfill.' }
  await writeFile(new URL('./deepstay-compat-evidence.json', import.meta.url), JSON.stringify(evidence, null, 2) + '\n')
  console.log(JSON.stringify(evidence, null, 2))
} finally {
  absent.forEach(([object, key], index) => { if (descriptors[index]) Object.defineProperty(object, key, descriptors[index]) })
  hooks.deregister()
}
