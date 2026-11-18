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
const saved = new Map()
globalThis.localStorage = { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value), removeItem: key => saved.delete(key) }
Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh-CN' }, configurable: true })
globalThis.__API_ORIGIN__ = 'https://api.deepseek.com'
const { useSettings, setApiConnection } = await import(new URL('services/settings.ts', sourceRoot))
const { supportsApiBalance, fetchApiBalance } = await import(new URL('services/api/balance.ts', sourceRoot))
const { ApiError } = await import(new URL('services/api/http.ts', sourceRoot))
const configure = (apiBaseUrl = 'https://api.deepseek.com', apiProtocol = 'deepseek', apiKey = 'official-fixture-key') =>
  setApiConnection({ apiBaseUrl, apiProtocol, apiKey, model: 'selected', models: ['selected'] })
const checks = []
let calls = 0
let responder = () => { throw new Error('Unexpected network request') }
globalThis.fetch = async (url, init) => { calls++; return responder(url, init) }

for (const protocol of ['deepseek', 'openai']) {
  for (const baseUrl of ['https://api.deepseek.com', 'https://api.deepseek.com/v1/', 'https://api.deepseek.com/anthropic/v1', 'https://api.deepseek.com:443/anthropic']) {
    assert.equal(supportsApiBalance({ baseUrl, protocol }), true)
  }
}
for (const baseUrl of ['https://custom.example.test/v1', 'http://api.deepseek.com', 'https://api.deepseek.com.evil.test', 'https://api.deepseek.com:8443', 'https://api.deepseek.com/proxy', 'https://user:secret@api.deepseek.com', 'https://api.deepseek.com?key=example', 'bad']) {
  configure(baseUrl, 'openai', 'custom-provider-fixture')
  assert.equal(supportsApiBalance(), false, baseUrl)
  await assert.rejects(fetchApiBalance(), error => error instanceof ApiError && error.localMessage.key === 'apiBalanceUnsupported')
}
assert.equal(calls, 0)
configure('https://api.deepseek.com', 'deepseek', null)
await assert.rejects(fetchApiBalance(), error => error instanceof ApiError && error.localMessage.key === 'apiKeyRequired')
assert.equal(calls, 0)
checks.push('Only official HTTPS DeepSeek root/version paths enable balance checks in either protocol; custom URLs, lookalike hosts, ports, credentials and missing keys never trigger a request')

const balance = { is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '123.456789', granted_balance: '0.000000', topped_up_balance: '123.456789' }, { currency: 'USD', total_balance: '0.00', granted_balance: '0.00', topped_up_balance: '0.00' }] }
configure('https://api.deepseek.com/v1', 'openai')
responder = (url, init) => {
  assert.equal(url, 'https://api.deepseek.com/user/balance')
  assert.equal(init.method, 'GET')
  assert.equal(init.body, undefined)
  assert.equal(new Headers(init.headers).get('Authorization'), 'Bearer official-fixture-key')
  assert.equal(init.credentials, 'omit')
  assert.equal(init.redirect, 'error')
  return Response.json(balance)
}
assert.deepEqual(await fetchApiBalance(), balance)
responder = () => Response.json({ is_available: false, balance_infos: [balance.balance_infos[1]] })
assert.deepEqual(await fetchApiBalance(), { is_available: false, balance_infos: [balance.balance_infos[1]] })
responder = () => Response.json({ is_available: true, balance_infos: [] })
assert.deepEqual(await fetchApiBalance(), { is_available: true, balance_infos: [] })
checks.push('A read-only request uses the saved official key and canonical /user/balance endpoint without redirects/cookies, preserves decimal precision and currency, and correctly handles zero, unavailable and empty balances')

responder = () => Response.json({ error: { message: 'Invalid key' } }, { status: 401 })
await assert.rejects(fetchApiBalance(), error => error instanceof ApiError && error.status === 401)
for (const invalid of [{ balance_infos: [] }, { is_available: 'yes', balance_infos: [] }, { is_available: true, balance_infos: [{ ...balance.balance_infos[0], total_balance: 'not money' }] }]) {
  responder = () => Response.json(invalid)
  await assert.rejects(fetchApiBalance(), error => error instanceof ApiError && error.kind === 'protocol')
}
const realSetTimeout = globalThis.setTimeout, realClearTimeout = globalThis.clearTimeout
const timers = new Map()
globalThis.setTimeout = (callback, delay) => { const token = {}; timers.set(token, { callback, delay }); return token }
globalThis.clearTimeout = token => timers.delete(token)
try {
  responder = (_url, init) => new Promise((_resolve, reject) => {
    if (init.signal.aborted) reject(new DOMException('Aborted', 'AbortError'))
    else init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
  })
  const timed = fetchApiBalance()
  const timeout = [...timers.values()].find(timer => timer.delay === 10_000)
  assert.ok(timeout)
  timeout.callback()
  await assert.rejects(timed, error => error instanceof ApiError && error.localMessage.key === 'apiBalanceTimeout')
  assert.equal(timers.size, 0)
  const controller = new AbortController()
  const pending = fetchApiBalance(controller.signal)
  controller.abort()
  await assert.rejects(pending, error => error.name === 'AbortError')
  assert.equal(timers.size, 0)
} finally {
  globalThis.setTimeout = realSetTimeout
  globalThis.clearTimeout = realClearTimeout
}
checks.push('Invalid credentials and malformed balance responses fail visibly; a ten-second timeout and caller cancellation release timers and do not retry or generate content')

configure()
let finish
responder = (_url, init) => {
  assert.equal(new Headers(init.headers).get('Authorization'), 'Bearer official-fixture-key')
  return new Promise(resolve => { finish = () => resolve(Response.json(balance)) })
}
const pending = fetchApiBalance()
configure('https://custom.example.test/v1', 'openai', 'custom-provider-fixture')
finish()
assert.deepEqual(await pending, balance)
assert.equal(useSettings.getState().apiKey, 'custom-provider-fixture')
const count = calls
await assert.rejects(fetchApiBalance())
assert.equal(calls, count)
checks.push('Changing configuration during a balance request cannot mix keys with a different host; subsequent custom-provider queries are rejected before fetch')
const evidence = { passed: true, runtime: process.version, checks, requests: calls, scope: 'Actual TypeScript balance/settings/http services with deterministic localStorage/fetch, fixture keys only; no user secrets read or sent and no real network/model usage.' }
await writeFile(new URL('./deepstay-api-balance-evidence.json', import.meta.url), JSON.stringify(evidence, null, 2) + '\n')
console.log(JSON.stringify(evidence, null, 2))
hooks.deregister()
