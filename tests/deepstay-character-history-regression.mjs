import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { registerHooks, stripTypeScriptTypes } from 'node:module'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

const src = new URL('../src/', import.meta.url)
await import(new URL('../node_modules/fake-indexeddb/auto/index.mjs', import.meta.url))
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.startsWith(src.href) && specifier.startsWith('.') && specifier.endsWith('.js')) {
      const candidate = new URL(specifier.slice(0, -3) + '.ts', context.parentURL)
      if (existsSync(fileURLToPath(candidate))) return { url: candidate.href, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url.startsWith(src.href) && url.endsWith('.ts')) {
      return { format: 'module', source: stripTypeScriptTypes(readFileSync(new URL(url), 'utf8'), { mode: 'transform' }), shortCircuit: true }
    }
    return nextLoad(url, context)
  },
})
const preferences = new Map()
globalThis.localStorage = {
  getItem: key => preferences.get(key) ?? null,
  setItem: (key, value) => preferences.set(key, value),
  removeItem: key => preferences.delete(key),
}
globalThis.__API_ORIGIN__ = 'https://api.deepseek.com'
globalThis.window = new EventTarget()
globalThis.document = Object.assign(new EventTarget(), { visibilityState: 'visible' })
Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh-CN' }, configurable: true })
globalThis.requestAnimationFrame = callback => setTimeout(callback, 0)
globalThis.cancelAnimationFrame = clearTimeout
globalThis.fetch = async () => { throw new Error('Character history tests must stay offline') }

const session = (index, character) => ({
  id: randomUUID(), title: `人物归档 ${index}`, createdAt: 1_700_000_000_000 + index, updatedAt: 1_700_000_000_002 + index,
  ...(character === undefined ? {} : { character }),
  messages: [
    { id: `u-${index}`, role: 'user', content: `问题 ${index}`, files: [], createdAt: 1_700_000_000_000 + index },
    { id: `a-${index}`, role: 'assistant', model: null, prefix: false, status: 'done',
      blocks: [{ type: 'text', text: `回答 ${index}` }], stopReason: 'end_turn', createdAt: 1_700_000_000_001 + index },
  ],
})
const checks = []
try {
  const db = await import(new URL('services/chat/db.ts', src))
  const store = await import(new URL('services/chat/store.ts', src))
  const backup = await import(new URL('services/chat/backup.ts', src))
  const { exportArchive } = await import(new URL('services/chat/history/exportArchive.ts', src))
  const { writeArchive } = await import(new URL('services/chat/history/zipWriter.ts', src))
  const { toSessionFile, toIndexEntry } = await import(new URL('services/chat/history/toArchive.ts', src))
  const { readSessionFile } = await import(new URL('services/chat/history/schema.ts', src))
  const { toLocalSession } = await import(new URL('services/chat/history/toLocal.ts', src))
  const { appendBranch, getVisibleMessages } = await import(new URL('services/chat/branches.ts', src))
  const snapshot = async () => Promise.all((await db.loadSessionSummaries()).map(item => db.loadSession(item.id)))
  const archive = async items => new File([await exportArchive(items)], 'character-history.zip')
  const rawArchive = async items => new File([await writeArchive([
    { name: 'manifest.json', blob: new Blob([JSON.stringify({ export_format_version: 3 })]) },
    ...items.map(item => ({ name: `chat_sessions/${item.id}.json`, blob: new Blob([JSON.stringify(item)]) })),
    { name: 'chat_session_index.json', blob: new Blob([JSON.stringify(items.map(toIndexEntry))]) },
  ])], 'raw-character-history.zip')
  const sourceCharacter = { presetId: 'preset-original', name: '小雨', prompt: '称呼我为朋友。\n保留这一行和标点。', greeting: '今天也想听你聊聊。' }
  const source = session(1, sourceCharacter)
  const serialized = toSessionFile(source, () => null)
  assert.deepEqual(serialized.deepstay_character, sourceCharacter)
  assert.deepEqual(toLocalSession(readSessionFile(JSON.parse(JSON.stringify(serialized)))).session.character, sourceCharacter)
  assert.notEqual(serialized.deepstay_character, sourceCharacter)
  checks.push('Export validation and import conversion preserve an independent character snapshot including optional greeting')

  const original = session(2, { presetId: 'local-only', name: '本机人物', prompt: '本机设定' })
  await db.saveSession(original)
  await db.saveCharacterPreset({ id: sourceCharacter.presetId, name: '同 ID 的本机预设',
    prompt: '本机人物库不能被归档覆盖', greeting: '', updatedAt: 1 })
  const presetsBeforeImport = await db.loadCharacterPresets()
  await store.initChat()
  const preferencesBeforeImport = new Map(preferences)
  assert.equal(await backup.importHistory(await archive([source])), 1)
  const importedId = store.useChatStore.getState().activeId
  const imported = await db.loadSession(importedId)
  assert.deepEqual(imported.character, sourceCharacter)
  assert.notEqual(imported.id, source.id)
  assert.deepEqual(await db.loadSession(original.id), original)
  assert.deepEqual(preferences, preferencesBeforeImport, 'Import must not add or replace the local character preset library')
  assert.deepEqual(await db.loadCharacterPresets(), presetsBeforeImport)
  checks.push('Real ZIP incremental import adds a session with its character without modifying other sessions or local preferences')

  const localCharacter = { presetId: 'local-edited', name: '本地更正', prompt: '之后只使用本地设定', greeting: '本地开场' }
  const locallyEdited = { ...imported, character: localCharacter }
  await db.saveSession(locallyEdited)
  store.useChatStore.setState({ sessionCache: { [importedId]: locallyEdited } })
  const updatedSource = session(3, { presetId: 'remote-edited', name: '外部更正', prompt: '不能覆盖本地设定' })
  updatedSource.id = source.id
  updatedSource.createdAt = source.createdAt
  updatedSource.messages = [...source.messages, ...updatedSource.messages]
  assert.equal(await backup.importHistory(await archive([updatedSource])), 1)
  const merged = await db.loadSession(importedId)
  assert.equal(merged.messages.length, 4)
  assert.deepEqual(merged.character, localCharacter)
  assert.equal(await backup.importHistory(await archive([updatedSource])), 0)
  assert.deepEqual((await db.loadSession(importedId)).character, localCharacter)
  checks.push('New source messages append while the existing session character remains local; repeated import is deduplicated')

  const legacy = session(4)
  const legacyFile = toSessionFile(legacy, () => null)
  assert.equal(Object.hasOwn(legacyFile, 'deepstay_character'), false)
  assert.equal(Object.hasOwn(toLocalSession(readSessionFile(legacyFile)).session, 'character'), false)
  assert.equal(await backup.importHistory(await rawArchive([legacyFile])), 1)
  const legacyId = store.useChatStore.getState().activeId
  assert.equal(Object.hasOwn(await db.loadSession(legacyId), 'character'), false)
  const externalCharacter = { ...legacy, character: sourceCharacter,
    messages: [...legacy.messages, ...session(5).messages], updatedAt: legacy.updatedAt + 5 }
  assert.equal(await backup.importHistory(await archive([externalCharacter])), 1)
  assert.equal(Object.hasOwn(await db.loadSession(legacyId), 'character'), false,
    'An external update must not assign a character to an existing legacy session')
  checks.push('Official archives without extensions import unchanged, and later incremental imports cannot assign a character to them')

  assert.equal(store.startCharacterChat({ id: sourceCharacter.presetId, name: sourceCharacter.name,
    prompt: sourceCharacter.prompt, greeting: sourceCharacter.greeting, updatedAt: 1 }), true)
  const greetingSession = store.useChatStore.getState().sessionCache[store.useChatStore.getState().activeId]
  const withGreeting = appendBranch(greetingSession, greetingSession.messages[0].id, session(6).messages)
  assert.equal(await backup.importHistory(await archive([withGreeting])), 1)
  const restoredGreeting = await db.loadSession(store.useChatStore.getState().activeId)
  const greetingPath = getVisibleMessages(restoredGreeting)
  assert.equal(greetingPath.length, 3)
  assert.equal(greetingPath[0].role, 'assistant')
  assert.equal(greetingPath[0].blocks[0].text, sourceCharacter.greeting)
  assert.equal(greetingPath[0].questionDeleted, true, 'Standalone greeting must not be paired with an invented question')
  assert.deepEqual(restoredGreeting.character, sourceCharacter)
  checks.push('A standalone assistant greeting followed by a real chat round survives ZIP export/import and remains distinct from a generated answer')

  const bounds = { presetId: 'i'.repeat(200), name: '名'.repeat(100), prompt: '设'.repeat(20_000), greeting: '好'.repeat(10_000) }
  assert.deepEqual(readSessionFile({ ...legacyFile, deepstay_character: bounds }).deepstay_character, bounds)
  const invalidCharacters = [null, [], 'invalid', {},
    { ...sourceCharacter, presetId: '' }, { ...sourceCharacter, presetId: 1 }, { ...sourceCharacter, presetId: 'i'.repeat(201) },
    { ...sourceCharacter, name: ' ' }, { ...sourceCharacter, name: '名'.repeat(101) },
    { ...sourceCharacter, prompt: '' }, { ...sourceCharacter, prompt: '设'.repeat(20_001) },
    { ...sourceCharacter, greeting: null }, { ...sourceCharacter, greeting: '好'.repeat(10_001) },
  ]
  for (const character of invalidCharacters) {
    assert.throws(() => readSessionFile({ ...legacyFile, deepstay_character: character }), error => error.key === 'backupIncomplete')
    assert.throws(() => toSessionFile({ ...legacy, character }, () => null), error => error.key === 'backupIncomplete')
  }
  checks.push('Defined character fields reject invalid types, empty identity/description and oversized text on both export and import; exact limits pass')

  const beforeFailure = await snapshot()
  const stagedFiles = Array.from({ length: 32 }, (_, index) => toSessionFile(session(100 + index, sourceCharacter), () => null))
  const invalidLast = { ...toSessionFile(session(200), () => null), deepstay_character: { ...sourceCharacter, prompt: null } }
  await assert.rejects(backup.importHistory(await rawArchive([...stagedFiles, invalidLast])), error => error.key === 'backupIncomplete')
  assert.deepEqual(await snapshot(), beforeFailure)
  assert.deepEqual(await db.commitStaging(), [], 'Failed import must clear the earlier staged batch')
  assert.deepEqual(await snapshot(), beforeFailure)
  assert.deepEqual(preferences, preferencesBeforeImport)
  assert.deepEqual(await db.loadCharacterPresets(), presetsBeforeImport)
  assert.equal(await backup.importHistory(await archive([session(201, sourceCharacter)])), 1,
    'A valid import can proceed after rejection')
  assert.deepEqual(await db.loadCharacterPresets(), presetsBeforeImport)
  checks.push('A malformed 33rd session rejects after a real staging batch, rolls back all additions and leaves the next valid import usable')
  console.log(JSON.stringify({ passed: true, checks, scope: 'Synthetic local ZIPs and isolated fake-indexeddb; no user data or model requests' }, null, 2))
} finally {
  hooks.deregister()
}
