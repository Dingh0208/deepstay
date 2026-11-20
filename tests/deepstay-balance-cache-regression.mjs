import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire, registerHooks, stripTypeScriptTypes } from 'node:module'

const root = new URL('../', import.meta.url)
const componentUrl = new URL('src/components/settings/ApiBalanceSetting.tsx', root)
const cacheUrl = new URL('src/services/api/balanceCache.ts', root)
const require = createRequire(new URL('package.json', root))
const { transformSync } = require(require.resolve('@rspack/binding', { paths: [require.resolve('@rspack/core')] }))
const mockUrl = text => 'data:text/javascript;base64,' + Buffer.from(text).toString('base64')
const fixtures = new Map([
  ['react', 'export const useState=(...a)=>globalThis.__hooks.useState(...a);export const useRef=(...a)=>globalThis.__hooks.useRef(...a);export const useCallback=(fn)=>fn;export const useMemo=(fn)=>fn();export const useEffect=(...a)=>globalThis.__hooks.useEffect(...a);export const useSyncExternalStore=(_subscribe,get)=>get();'],
  ['react/jsx-runtime', 'export const jsx=(type,props)=>({type,props});export const jsxs=jsx;export const Fragment=Symbol.for("fragment");'],
  ['../../i18n/index.js', 'export const useTranslate=()=>((key,params)=>key+(params?.time?":"+params.time:""));'],
  ['../../services/api/balance.js', 'export const supportsApiBalance=({baseUrl})=>baseUrl.startsWith("https://api.deepseek.com");export const fetchApiBalance=(...a)=>globalThis.__fetchBalance(...a);'],
  ['./balance.js', 'export const supportsApiBalance=({baseUrl})=>baseUrl.startsWith("https://api.deepseek.com");export const fetchApiBalance=(...a)=>globalThis.__fetchBalance(...a);'],
  ['./connection.js', 'export const normalizeApiBaseUrl=input=>new URL(input).href.replace(/\\/+$/,"");'],
  ['./http.js', 'export const ApiError=globalThis.__ApiError;'],
  ['../../services/api/http.js', 'export const ApiError=globalThis.__ApiError;'],
  ['../base/Button.js', 'export const Button=()=>null;'],
  ['../base/Modal.js', 'export const Modal=()=>null;'],
  ['./Settings.module.css', 'export default {};'],
  ['./ApiBalanceSetting.module.css', 'export default {};'],
])
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if ((context.parentURL === componentUrl.href || context.parentURL === cacheUrl.href) && fixtures.has(specifier)) {
      return { url: mockUrl(fixtures.get(specifier)), shortCircuit: true }
    }
    if (context.parentURL === componentUrl.href && specifier === '../../services/api/balanceCache.js') {
      return { url: cacheUrl.href, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url === componentUrl.href) return { format: 'module', shortCircuit: true, source: transformSync(
      readFileSync(componentUrl, 'utf8') + '\nexport { ApiBalanceContent };', JSON.stringify({
        jsc: { target: 'es2022', parser: { syntax: 'typescript', tsx: true }, transform: { react: { runtime: 'automatic' } } }, module: { type: 'es6' },
      })).code }
    if (url === cacheUrl.href) return { format: 'module', shortCircuit: true, source: stripTypeScriptTypes(readFileSync(cacheUrl, 'utf8')) }
    return nextLoad(url, context)
  },
})
const walk = (node, predicate) => {
  if (!node || typeof node !== 'object') return null
  if (!Array.isArray(node) && predicate(node)) return node
  for (const child of Array.isArray(node) ? node : [node.props?.children]) {
    const found = walk(child, predicate)
    if (found) return found
  }
  return null
}
const text = node => typeof node === 'string' || typeof node === 'number' ? String(node)
  : Array.isArray(node) ? node.map(text).join(' ') : node && typeof node === 'object' ? text(node.props?.children) : ''
const runner = component => {
  const slots = []; let cursor = 0
  const state = {
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial
      return [slots[i], next => { slots[i] = typeof next === 'function' ? next(slots[i]) : next }] },
    useRef(initial) { const i = cursor++; return slots[i] ??= { current: initial } },
    useEffect() {},
  }
  return props => { cursor = 0; globalThis.__hooks = state; return component(props) }
}
globalThis.__ApiError = class ApiError extends Error {
  constructor(status) { super('synthetic failure'); this.status = status }
}
let calls = 0, finish, fail
globalThis.__fetchBalance = () => {
  calls++
  return new Promise((resolve, reject) => { finish = resolve; fail = reject })
}
const balance = { is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '12.34', granted_balance: '0', topped_up_balance: '12.34' }] }
const props = { apiKey: 'fixture-a', apiBaseUrl: 'https://api.deepseek.com', apiProtocol: 'deepseek' }
const now = Date.now
let clock = 1_000_000
Date.now = () => clock
try {
  const { ApiBalanceContent } = await import(componentUrl)
  const render = runner(ApiBalanceContent)
  const query = tree => walk(tree, node => node.type?.name === 'Button').props.onClick()
  let tree = render(props)
  query(tree); finish(balance)
  await new Promise(resolve => setImmediate(resolve))
  assert.match(text(render(props)), /12\.34/)
  clock += 61_000
  query(render(props))
  assert.match(text(render(props)), /12\.34/, 'Refreshing must preserve the last successful amount')
  fail(new TypeError('offline'))
  await new Promise(resolve => setImmediate(resolve))
  tree = render(props)
  assert.match(text(tree), /12\.34/, 'Temporary network failures must preserve the last successful amount')
  assert.match(text(tree), /apiBalanceLastChecked/, 'Retained results must be explicitly marked as previous results')
  const switched = { ...props, apiKey: 'fixture-b' }
  assert.doesNotMatch(text(render(switched)), /12\.34/, 'The first render after changing key cannot display the old account balance')

  const cache = await import(cacheUrl)
  const request = { apiKey: props.apiKey, connection: { baseUrl: props.apiBaseUrl, protocol: props.apiProtocol } }
  const other = { ...request, apiKey: 'fixture-b' }
  cache.selectBalanceAccount(other)
  const first = cache.queryCachedBalance(other), shared = cache.queryCachedBalance(other)
  assert.equal(first, shared, 'Concurrent readers share one request promise')
  finish(balance)
  await first
  const afterSuccess = calls
  await cache.queryCachedBalance(other)
  assert.equal(calls, afterSuccess, 'Reopening within a minute reuses the current account result')
  const unsubscribe = cache.subscribeBalance(() => {})
  clock += 61_000
  const pending = cache.queryCachedBalance(other)
  unsubscribe()
  finish(balance)
  await pending
  assert.equal(cache.getCachedBalance(other).balance.balance_infos[0].total_balance, '12.34', 'Closing a reader does not cancel a shared request')
  clock += 61_000
  const unauthorized = cache.queryCachedBalance(other)
  fail(new globalThis.__ApiError(401))
  await unauthorized
  assert.equal(cache.getCachedBalance(other).balance, undefined, 'Revoked credentials clear the cached amount')
  clock += 61_000
  const oldPending = cache.queryCachedBalance(other), oldFinish = finish
  cache.selectBalanceAccount(request)
  const currentPending = cache.queryCachedBalance(request), currentFinish = finish
  oldFinish(balance)
  await oldPending
  assert.equal(cache.getCachedBalance(request).balance, undefined, 'A late response from a previous account cannot overwrite the selected account')
  currentFinish({ ...balance, balance_infos: [{ ...balance.balance_infos[0], total_balance: '5.67' }] })
  await currentPending
  assert.equal(cache.getCachedBalance(request).balance.balance_infos[0].total_balance, '5.67')
  const beforeEquivalent = calls
  const equivalent = { ...request, apiKey: '  fixture-a  ', connection: { ...request.connection, baseUrl: 'https://api.deepseek.com:443/v1/' } }
  await cache.queryCachedBalance(equivalent)
  assert.equal(calls, beforeEquivalent, 'Equivalent official paths and key whitespace share the canonical balance endpoint')
  assert.equal(cache.getCachedBalance(equivalent).balance.balance_infos[0].total_balance, '5.67')
  cache.selectBalanceAccount({ ...request, connection: { ...request.connection, protocol: 'openai' } })
  assert.equal(cache.getCachedBalance(request).balance, undefined, 'Protocol is part of the balance identity')
  const count = calls
  await cache.queryCachedBalance({ ...request, apiKey: '' })
  await cache.queryCachedBalance({ ...request, connection: { ...request.connection, baseUrl: 'https://relay.example.test' } })
  assert.equal(calls, count, 'Empty keys and unsupported providers never trigger a balance request')
  assert.equal(cache.getCachedBalance(request).balance, undefined, 'Changing provider discards the old account even when querying is unsupported')
  console.log('Balance cache: retained amount, loading/error labels, immediate identity isolation, concurrent/60s reuse, unsubscribe, 401 and stale-generation protection passed')
} finally {
  Date.now = now
  hooks.deregister()
}
