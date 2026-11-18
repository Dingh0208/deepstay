import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { registerHooks, stripTypeScriptTypes } from 'node:module'
import { fileURLToPath } from 'node:url'

const sourceRoot = new URL('../src/', import.meta.url)
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL?.startsWith(sourceRoot.href)) {
      const candidate = new URL(specifier.slice(0, -3) + '.ts', context.parentURL)
      if (existsSync(fileURLToPath(candidate))) return { url: candidate.href, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url.startsWith(sourceRoot.href) && url.endsWith('.ts')) return {
      format: 'module', source: stripTypeScriptTypes(readFileSync(new URL(url), 'utf8'), { mode: 'transform' }), shortCircuit: true,
    }
    return nextLoad(url, context)
  },
})
await import(new URL('../node_modules/fake-indexeddb/auto/index.mjs', import.meta.url))
const { searchHistory } = await import(new URL('services/chat/historySearch.ts', sourceRoot))
const db = await import(new URL('services/chat/db.ts', sourceRoot))
const user = (id, content) => ({ id, role: 'user', content, files: [], createdAt: 1 })
const reply = (id, text, extra = {}) => ({ id, role: 'assistant', prefix: false, model: null, status: 'done', createdAt: 2, blocks: [{ type: 'text', text }], ...extra })
const session = (id, title, messages) => ({ id, title, messages, createdAt: 1, updatedAt: 2 })
const signal = () => new AbortController().signal
const first = session('stored-1', '旅行', [user('u1', '曾约定在春天去看海'), reply('a1', '我记得那个约定')])
const branch = session('stored-2', '旧分支', [
  { ...user('u2', '早上好'), parentId: null, selectedChildId: 'a2' },
  reply('a2', '今天晴朗', { parentId: 'u2' }),
  reply('a2-hidden', '我们的秘密暗号是木星', { parentId: 'u2' }),
])
const titleOnly = session('stored-3', 'JUPITER album', [])
const removed = session('removed', '已删除', [user('removed-u', '木星')])
for (const value of [first, branch, titleOnly, removed]) await db.saveSession(value)
const ids = new Set([first.id, branch.id, titleOnly.id])
const checks = []
let matches = await searchHistory('看海', {}, ids, signal())
assert.deepEqual(matches.map(match => [match.sessionId, match.messageId]), [['stored-1', 'u1']])
matches = await searchHistory('木星', {}, ids, signal())
assert.deepEqual(matches.map(match => [match.sessionId, match.messageId]), [['stored-2', 'a2-hidden']])
matches = await searchHistory('jupiter', {}, ids, signal())
assert.deepEqual(matches.map(match => [match.sessionId, match.messageId]), [['stored-3', null]])
checks.push('Searches user text, assistant text including an unselected branch, and case-insensitive titles, while ignoring sessions outside the current list')

const cached = { ...first, messages: [...first.messages, user('u-new', '刚刚输入的金星承诺')] }
const notYetSaved = session('not-yet-saved', '新对话', [user('u-pending', '金星的新约定')])
const currentIds = new Set([...ids, notYetSaved.id])
matches = await searchHistory('金星', { [first.id]: cached, [notYetSaved.id]: notYetSaved }, currentIds, signal())
assert.deepEqual(new Set(matches.map(match => match.sessionId)), new Set([first.id, notYetSaved.id]))
assert.equal(matches.filter(match => match.sessionId === first.id).length, 1)
matches = await searchHistory('看海', { [first.id]: cached }, ids, signal())
assert.equal(matches.length, 1)
checks.push('Uses current in-memory messages and finds a new session before its first successful write, with no duplicate results for cached database records')

assert.deepEqual(await searchHistory('  ', { [first.id]: cached }, ids, signal()), [])
const controller = new AbortController()
controller.abort()
assert.deepEqual(await searchHistory('木星', { [branch.id]: branch }, ids, controller.signal), [])
const many = Object.fromEntries(Array.from({ length: 110 }, (_, index) => {
  const value = session(`cached-${index}`, '木星', [user(`u-${index}`, '木星')])
  return [value.id, value]
}))
matches = await searchHistory('木星', many, new Set(Object.keys(many)), signal())
assert.equal(matches.length, 100)
checks.push('Empty and pre-cancelled searches return no results; results are capped at 100 even when matching sessions exist only in memory')

const evidence = { passed: true, runtime: process.version, checks, scope: 'Actual historySearch and IndexedDB services using isolated fake-indexeddb and synthetic conversations. No real chat history or network.' }
await writeFile(new URL('./deepstay-history-search-evidence.json', import.meta.url), JSON.stringify(evidence, null, 2) + '\n')
console.log(JSON.stringify(evidence, null, 2))
hooks.deregister()
