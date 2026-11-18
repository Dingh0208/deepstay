import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { registerHooks, stripTypeScriptTypes } from 'node:module'
import { fileURLToPath } from 'node:url'

const sourceRoot = new URL('../src/', import.meta.url)
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL?.startsWith(sourceRoot.href)) {
      const candidate = new URL(specifier.slice(0, -3) + '.ts', context.parentURL)
      if (existsSync(fileURLToPath(candidate))) return { url: candidate.href, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url.startsWith(sourceRoot.href) && new URL(url).pathname.endsWith('.ts')) {
      return { format: 'module', source: stripTypeScriptTypes(readFileSync(new URL(url), 'utf8'), { mode: 'transform' }), shortCircuit: true }
    }
    return nextLoad(url, context)
  },
})
const disk = new Map()
globalThis.localStorage = { getItem: (key) => disk.get(key), setItem: (key, value) => disk.set(key, value) }
const log = await import('../src/services/diagnostics/log.ts')
for (let count = 0; count < 205; count++) {
  log.recordDiagnostic({ area: 'api', operation: 'chat', outcome: 'ok', status: count + 200 })
}
log.recordDiagnostic({
  area: 'api', operation: 'models', outcome: 'failed', status: 401, detail: 'http',
  url: 'https://private.example', authorization: 'secret-key', body: 'private message',
})
log.recordDiagnostic({
  area: 'api', operation: 'models', outcome: 'failed', detail: 'user response body', status: 123456,
})
log.recordDiagnostic({ area: 'api', operation: 'private operation', outcome: 'failed' })
const exported = log.diagnosticText()
const { entries } = JSON.parse(exported)
assert.equal(entries.length, 200)
assert.equal(entries[0].status, 207)
assert.equal(entries.at(-2).status, 401)
assert.equal(entries.at(-2).detail, 'http')
assert.equal(entries.at(-1).detail, undefined)
assert.equal(entries.at(-1).status, undefined)
assert.doesNotMatch(exported, /private|secret-key|user response body/)
assert.deepEqual(JSON.parse(disk.get('deepstay:diagnostics')), entries)
const reload = await import('../src/services/diagnostics/log.ts?reload')
assert.equal(reload.diagnosticText(), exported)
const db = await import('../src/services/chat/db.ts')
const originalError = console.error
console.error = () => {}
try {
  db.reportStorageError('read session')(new Error('private session contents'))
} finally {
  console.error = originalError
}
const storageFailure = JSON.parse(log.diagnosticText()).entries.at(-1)
assert.deepEqual({ area: storageFailure.area, operation: storageFailure.operation, outcome: storageFailure.outcome, detail: storageFailure.detail },
  { area: 'history', operation: 'load', outcome: 'failed', detail: 'storage' })
assert.doesNotMatch(log.diagnosticText(), /private session contents/)
console.log('Diagnostics preserve the latest 200 entries across reload, report storage failures, and omit unknown or sensitive fields.')
