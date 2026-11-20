import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerHooks, stripTypeScriptTypes } from 'node:module'

const source = new URL('../src/components/chatInput/useContextPrediction.ts', import.meta.url)
const mockUrl = value => 'data:text/javascript;base64,' + Buffer.from(value).toString('base64')
const slots = [], effects = [], timers = new Map(), predictions = []
let cursor = 0, timerId = 0
const equal = (a, b) => a?.length === b.length && b.every((item, i) => Object.is(item, a[i]))
globalThis.__predictionReact = {
  useMemo(create, deps) {
    const i = cursor++
    if (!slots[i] || !equal(slots[i].deps, deps)) slots[i] = { value: create(), deps }
    return slots[i].value
  },
  useState(initial) {
    const i = cursor++
    slots[i] ??= { value: initial }
    return [slots[i].value, value => { slots[i].value = value }]
  },
  useEffect(create, deps) {
    const i = cursor++
    if (!slots[i] || !equal(slots[i].deps, deps)) {
      effects.push(() => { slots[i]?.cleanup?.(); slots[i] = { deps, cleanup: create() } })
    }
  },
}
globalThis.__predictContext = options => new Promise((resolve, reject) => predictions.push({ options, resolve, reject }))
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL === source.href) {
      if (specifier === 'react') return { url: mockUrl('export const {useMemo,useState,useEffect}=globalThis.__predictionReact'), shortCircuit: true }
      if (specifier.endsWith('/contextPrediction.js')) return { url: mockUrl('export const predictNextContext=options=>globalThis.__predictContext(options)'), shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url === source.href) return { format: 'module', source: stripTypeScriptTypes(readFileSync(source, 'utf8'), { mode: 'transform' }), shortCircuit: true }
    return nextLoad(url, context)
  },
})
const originalSetTimeout = globalThis.setTimeout, originalClearTimeout = globalThis.clearTimeout
globalThis.setTimeout = fn => { timers.set(++timerId, fn); return timerId }
globalThis.clearTimeout = id => timers.delete(id)
try {
  const { useContextPrediction } = await import(source)
  const base = { session: { id: 'one', messages: [] }, text: 'first', files: [], system: 'role', tools: [],
    connection: { baseUrl: 'https://api.deepseek.com', protocol: 'deepseek' }, model: 'fixture', inputBudget: 1_000_000, thinking: false }
  const render = (options, paused = false) => {
    cursor = 0
    const value = useContextPrediction(options, paused)
    while (effects.length) effects.shift()()
    return value
  }
  const advance = () => { const callbacks = [...timers.values()]; timers.clear(); callbacks.forEach(fn => fn()) }
  const settle = async () => { await Promise.resolve(); await Promise.resolve() }
  assert.deepEqual(render(base), { estimate: undefined, estimating: true })
  render({ ...base })
  assert.equal(timers.size, 1, 'A normal rerender preserves the existing debounce')
  const draft = { ...base, text: 'second' }
  render(draft)
  assert.equal(timers.size, 1, 'Fast draft changes cancel the previous timer')
  advance()
  assert.equal(predictions.length, 1)
  assert.equal(predictions[0].options.text, 'second')
  const next = { ...draft, session: { id: 'two', messages: [] }, system: 'another character' }
  assert.deepEqual(render(next), { estimate: undefined, estimating: true })
  assert.equal(predictions[0].options.signal.aborted, true)
  predictions[0].resolve({ system: 999, tools: 0, messages: 999 })
  await settle()
  assert.equal(render(next).estimate, undefined, 'A late result from another session cannot appear')
  advance()
  predictions[1].resolve({ system: 5, tools: 0, messages: 20 })
  await settle()
  assert.deepEqual(render(next), { estimate: { system: 5, tools: 0, messages: 20 }, estimating: false })
  assert.deepEqual(render(next, true), { estimate: undefined, estimating: false }, 'Streaming/compaction pauses predictions')
  assert.equal(timers.size, 0)
  assert.deepEqual(render(next), { estimate: undefined, estimating: true }, 'Compaction completion refreshes even when session identity is unchanged')
  advance()
  predictions[2].reject(new Error('Synthetic local DB failure'))
  await settle()
  assert.deepEqual(render(next), { estimate: undefined, estimating: false }, 'Local failures show unavailable, never an endless estimating state')
  const changed = { ...next, model: 'other-model', inputBudget: 32000, files: [{ id: 'new-file' }] }
  render(changed)
  advance()
  assert.equal(predictions[3].options.model, 'other-model')
  assert.equal(predictions[3].options.inputBudget, 32000)
  predictions[3].resolve({ system: 8, tools: 0, messages: 80 })
  await settle()
  assert.equal(render(changed).estimate.messages, 80)
  console.log('Prediction hook: debounce, draft/route changes, abort and stale isolation, unchanged-session compaction refresh, and finite local error state passed')
} finally {
  for (const slot of slots) slot?.cleanup?.()
  hooks.deregister()
  globalThis.setTimeout = originalSetTimeout
  globalThis.clearTimeout = originalClearTimeout
  delete globalThis.__predictionReact
  delete globalThis.__predictContext
}
