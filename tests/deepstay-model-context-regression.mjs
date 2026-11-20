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
const saved = new Map([
  ['deepstay:api-base-url', 'https://relay.example.test/v1'],
  ['deepstay:api-protocol', 'openai'],
  ['deepstay:model', 'model-a'],
  ['deepstay:generation', JSON.stringify({ contextTokens: 4096, temperature: 0.7, system: '共同设定' })],
])
globalThis.localStorage = {
  getItem: key => saved.get(key) ?? null,
  setItem: (key, value) => saved.set(key, value),
  removeItem: key => saved.delete(key),
}
globalThis.__API_ORIGIN__ = 'https://api.deepseek.com'
globalThis.fetch = async () => { throw new Error('No network calls allowed') }

try {
  const settings = await import(new URL('services/settings.ts', src))
  const current = () => settings.useSettings.getState().generation
  assert.equal(current().contextTokens, 4096, 'Legacy custom context remains on the selected route')
  settings.setModel('model-b')
  assert.equal(current().contextTokens, undefined, 'A different model starts at the 1M default rather than inheriting another model window')
  assert.equal(current().temperature, 0.7)
  assert.equal(current().system, '共同设定')
  settings.setGeneration({ ...current(), contextTokens: 8192 })
  settings.setModel('model-a')
  assert.equal(current().contextTokens, 4096)
  settings.setApiConnection({
    apiKey: 'synthetic-key', apiBaseUrl: 'https://other.example.test/v1',
    apiProtocol: 'openai', model: 'model-a', models: ['model-a'],
  })
  assert.equal(current().contextTokens, undefined, 'Identical model IDs on different providers have independent windows')
  settings.setGeneration({ ...current(), contextTokens: 16384 })
  settings.setApiConnection({
    apiKey: 'changed-synthetic-key', apiBaseUrl: 'https://RELAY.example.test:443/v1/chat/completions/',
    apiProtocol: 'openai', model: 'model-a', models: ['model-a'],
  })
  assert.equal(current().contextTokens, 4096, 'Equivalent endpoint spelling and rotated keys keep the same route override')
  settings.setApiConnection({
    apiKey: 'synthetic-key', apiBaseUrl: 'https://relay.example.test/v1',
    apiProtocol: 'deepseek', model: 'model-a', models: ['model-a'],
  })
  assert.equal(current().contextTokens, undefined, 'Protocol is part of the route identity')
  settings.setGeneration({ ...current(), contextTokens: 2048 })
  settings.setApiConnection({
    apiKey: 'synthetic-key', apiBaseUrl: 'https://relay.example.test/anthropic/v1',
    apiProtocol: 'deepseek', model: 'model-a', models: ['model-a'],
  })
  assert.equal(current().contextTokens, 2048, 'Equivalent native DeepSeek endpoint bases share an override')
  settings.setApiConnection({
    apiKey: 'synthetic-key', apiBaseUrl: 'https://relay.example.test',
    apiProtocol: 'openai', model: 'model-a', models: ['model-a', 'model-b'],
  })
  assert.equal(current().contextTokens, 4096, 'Root and /v1 OpenAI bases route to the same chat endpoint')
  settings.setGeneration({ temperature: 0.4, system: '更新设定' })
  assert.equal(current().contextTokens, undefined, 'An empty context input clears only the selected route')
  settings.setModel('model-b')
  assert.equal(current().contextTokens, 8192, 'Clearing one override preserves the other model')
  assert.equal(current().temperature, 0.4)
  const reloaded = await import(new URL('services/settings.ts?route-reload', src))
  assert.equal(reloaded.useSettings.getState().generation.contextTokens, 8192, 'Route values survive restart')
  assert.equal(reloaded.useSettings.getState().generation.system, '更新设定')
  settings.setApiConnection({
    apiKey: 'synthetic-key', apiBaseUrl: 'https://other.example.test/v1',
    apiProtocol: 'openai', model: 'model-a', models: ['model-a'],
  })
  assert.equal(current().contextTokens, 16384)
  assert.equal(saved.get('deepstay:generation').includes('contextTokens'), false, 'The global generation record no longer leaks a model window')

  saved.clear()
  saved.set('deepstay:api-base-url', 'https://quota.example.test/v1')
  saved.set('deepstay:api-protocol', 'openai')
  saved.set('deepstay:model', 'model-a')
  saved.set('deepstay:generation', JSON.stringify({ contextTokens: 4096, temperature: 0.7 }))
  let blockRouteWrite = true
  globalThis.localStorage.setItem = (key, value) => {
    if (blockRouteWrite && key === 'deepstay:model-context-windows') throw new Error('QuotaExceededError')
    saved.set(key, value)
  }
  const quota = await import(new URL('services/settings.ts?migration-quota', src))
  assert.equal(quota.useSettings.getState().generation.contextTokens, 4096, 'A failed migration keeps the active window in memory')
  assert.equal(JSON.parse(saved.get('deepstay:generation')).contextTokens, 4096,
    'The legacy window remains on disk until the route map has actually been saved')
  assert.equal(saved.has('deepstay:model-context-windows'), false)
  blockRouteWrite = false
  const retry = await import(new URL('services/settings.ts?migration-retry', src))
  assert.equal(retry.useSettings.getState().generation.contextTokens, 4096, 'Restart retries a previously failed migration')
  assert.equal(JSON.parse(saved.get('deepstay:generation')).contextTokens, undefined)
  assert.deepEqual(Object.values(JSON.parse(saved.get('deepstay:model-context-windows'))), [4096])
  console.log('Model context routes: legacy migration, provider/model/protocol isolation, canonical endpoints, key rotation, clear and restart passed')
} finally {
  hooks.deregister()
}
