import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire, registerHooks, stripTypeScriptTypes } from 'node:module'
import { fileURLToPath } from 'node:url'

const src = new URL('../src/', import.meta.url)
const source = new URL('components/chatInput/ComposerMetrics.tsx', src)
const require = createRequire(new URL('../package.json', import.meta.url))
const { transformSync } = require(require.resolve('@rspack/binding', { paths: [require.resolve('@rspack/core')] }))
const mockUrl = value => 'data:text/javascript;base64,' + Buffer.from(value).toString('base64')
const mocks = new Map([
  ['react', 'export const useState=()=>[true,()=>{}];'],
  ['react/jsx-runtime', 'export const jsx=(type,props,key)=>({type,props,key});export const jsxs=jsx;'],
  ['../../services/settings.js', 'export const useSettings=select=>select({locale:"en",generation:{contextTokens:1000}});'],
  ['../../i18n/index.js', 'export const useTranslate=()=>((key,params)=>key+(params?":"+JSON.stringify(params):""));'],
  ['../base/Button.js', 'export const Button=()=>null;'],
  ['../base/Modal.js', 'export const Modal=()=>null;'],
  ['./ComposerMetrics.module.css', 'export default {};'],
])
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL === source.href && mocks.has(specifier)) return { url: mockUrl(mocks.get(specifier)), shortCircuit: true }
    if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL?.startsWith(src.href)) {
      const candidate = new URL(specifier.slice(0, -3) + '.ts', context.parentURL)
      if (existsSync(fileURLToPath(candidate))) return { url: candidate.href, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url === source.href) return { format: 'module', source: transformSync(readFileSync(source, 'utf8'), JSON.stringify({
      jsc: { target: 'es2022', parser: { syntax: 'typescript', tsx: true }, transform: { react: { runtime: 'automatic' } } }, module: { type: 'es6' },
    })).code, shortCircuit: true }
    if (url.startsWith(src.href) && url.endsWith('.ts')) return { format: 'module', source: stripTypeScriptTypes(readFileSync(new URL(url), 'utf8'), { mode: 'transform' }), shortCircuit: true }
    return nextLoad(url, context)
  },
})
globalThis.localStorage = { getItem: () => null }
globalThis.__API_ORIGIN__ = 'https://api.deepseek.com'
const all = node => {
  if (node === null || node === undefined || typeof node === 'boolean') return []
  if (Array.isArray(node)) return node.flatMap(all)
  return [node, ...all(node?.props?.children)]
}
try {
  const { ComposerMetrics } = await import(source)
  const latestReply = { status: 'done', metrics: { system: 100, tools: 0, messages: 800, tokensPerSecond: 12 },
    usage: { input_tokens: 40, cache_read_input_tokens: 60, output_tokens: 20 } }
  const props = { latestReply, estimatedContext: { system: 5, tools: 5, messages: 90 }, compactDisabled: false, empty: false, onCompact() {} }
  let nodes = all(ComposerMetrics(props))
  assert.ok(nodes.includes('composerContextPercent:' + JSON.stringify({ percentage: 'composerEstimate:' + JSON.stringify({ value: '10%' }) })), 'The next estimate wins over old actual/request metrics')
  assert.ok(nodes.includes('composerCacheHit:{"percentage":"60"}'), 'Cache remains tied to the last finalized actual request')
  assert.ok(nodes.includes('composerSpeed:{"speed":"12"}'))
  assert.ok(nodes.includes('composerLastRequestAmount:{"used":"120"}'), 'Last actual usage is independent')
  assert.ok(nodes.includes('composerNextRequestEstimate'))
  nodes = all(ComposerMetrics({ ...props, estimatedContext: undefined, estimating: true }))
  assert.ok(nodes.includes('composerContextEstimating'))
  assert.ok(!nodes.includes('composerNextRequestEstimate'))
  nodes = all(ComposerMetrics({ ...props, estimatedContext: undefined, estimating: false }))
  assert.ok(nodes.includes('composerNoUsage'), 'A local prediction failure has a finite unavailable state')
  assert.ok(!nodes.includes('composerContextEstimating'))
  nodes = all(ComposerMetrics({ ...props, latestReply: { ...latestReply, status: 'streaming' }, estimatedContext: undefined }))
  assert.ok(nodes.includes('composerContextPending'))
  assert.ok(!nodes.some(node => typeof node === 'string' && node.startsWith('composerCacheHit:')), 'Provisional stream usage never publishes a cache percentage')
  console.log('Composer context: next input estimate, independent finalized cache/speed and last actual, pending and unavailable states passed')
} finally {
  hooks.deregister()
}
