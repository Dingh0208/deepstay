import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { registerHooks, stripTypeScriptTypes } from 'node:module'
import { fileURLToPath } from 'node:url'

const root = new URL('../src/', import.meta.url)
globalThis.__diagnosticPlatform = 'android'
const calls = []
globalThis.__diagnosticNative = {
  save: async value => { calls.push(value); return { cancelled: false } },
  shareDiagnostics: async value => calls.push(value),
}
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@capacitor/core' && context.parentURL?.startsWith(root.href)) {
      return { url: 'data:text/javascript,' + encodeURIComponent('export const Capacitor={getPlatform:()=>globalThis.__diagnosticPlatform};export const registerPlugin=()=>globalThis.__diagnosticNative;'), shortCircuit: true }
    }
    if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL?.startsWith(root.href)) {
      const candidate = new URL(specifier.slice(0, -3) + '.ts', context.parentURL)
      if (existsSync(fileURLToPath(candidate))) return { url: candidate.href, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    return url.startsWith(root.href) && new URL(url).pathname.endsWith('.ts')
      ? { format: 'module', source: stripTypeScriptTypes(readFileSync(new URL(url), 'utf8'), { mode: 'transform' }), shortCircuit: true }
      : nextLoad(url, context)
  },
})
const disk = new Map()
globalThis.localStorage = { getItem: key => disk.get(key), setItem: (key, value) => disk.set(key, value) }
let version = '0.1.15', agent = 'Mozilla/5.0 (Linux; Android 11; PRIVATE_PHONE Build/PRIVATE; wv) Chrome/83.0.4103.106 Mobile secret-key https://private.example/ private chat'
let blob, clicked = false, shared
globalThis.document = {
  querySelector: () => ({ content: version }),
  createElement: () => ({ click: () => { clicked = true } }),
}
Object.defineProperty(globalThis, 'navigator', { value: { get userAgent() { return agent }, share: async value => { shared = value }, canShare: () => true }, configurable: true })
URL.createObjectURL = value => { blob = value; return 'blob:synthetic' }
URL.revokeObjectURL = () => {}
const originalTimeout = globalThis.setTimeout
globalThis.setTimeout = () => 0
try {
  const { diagnosticText, recordDiagnostic } = await import('../src/services/diagnostics/log.ts')
  const { downloadDiagnostics, shareDiagnostics } = await import('../src/services/diagnostics/export.ts')
  for (let i = 0; i < 205; i++) recordDiagnostic({ area: 'api', operation: 'chat', outcome: 'ok' })
  const report = JSON.parse(diagnosticText())
  assert.deepEqual(report.environment, { version: '0.1.15', platform: 'android', chromiumMajor: 83, webView: true, androidMajor: 11 })
  assert.equal(report.entries.length, 200)
  assert.equal(JSON.parse(disk.get('deepstay:diagnostics')).length, 200)
  assert.doesNotMatch(diagnosticText(), /PRIVATE|secret-key|https:|private chat|Build/)
  await downloadDiagnostics()
  await shareDiagnostics()
  assert.equal(Buffer.from(calls[0].data, 'base64').toString('utf8'), diagnosticText())
  assert.equal(calls[1].text, diagnosticText())

  globalThis.__diagnosticPlatform = 'web'
  agent = 'Chrome/156.1.2.3 PRIVATE_PHONE'
  await downloadDiagnostics()
  assert.equal(clicked, true)
  assert.equal(await blob.text(), diagnosticText())
  await shareDiagnostics()
  assert.equal(await shared.files[0].text(), diagnosticText())
  assert.deepEqual(JSON.parse(diagnosticText()).environment, { version, platform: 'web', chromiumMajor: 156 })
  navigator.canShare = () => false
  await shareDiagnostics()
  assert.equal(shared.text, diagnosticText())

  version = '0.1.15/private-secret'
  agent = 'unrecognized private chat'
  globalThis.__diagnosticPlatform = 'private-device-platform'
  assert.deepEqual(JSON.parse(diagnosticText()).environment, {})
  agent = 'Android 0; Chrome/0.0'
  assert.deepEqual(JSON.parse(diagnosticText()).environment, {})
  assert.doesNotMatch(diagnosticText(), /secret|private|unrecognized/)
  console.log('Diagnostic environment whitelist, unknown input omission, ASCII native save, web download and native/web sharing use the same private-safe report with the latest 200 entries')
} finally {
  globalThis.setTimeout = originalTimeout
}
