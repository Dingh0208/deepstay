import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { registerHooks, stripTypeScriptTypes } from 'node:module'
import { fileURLToPath } from 'node:url'

const root = new URL('../src/', import.meta.url)
const capacitorStub = `export const Capacitor = { getPlatform: () => 'android' }; export const registerPlugin = () => ({ getPendingApk: async () => ({ ready: true, version: '0.1.17', versionCode: 18, sha256: '${'a1'.repeat(32)}' }), getInstallStatus: async () => ({ updated: false }) })`
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@capacitor/core' && context.parentURL?.startsWith(root.href)) {
      return { url: `data:text/javascript,${encodeURIComponent(capacitorStub)}`, shortCircuit: true }
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

globalThis.localStorage = {
  get length() { return 1 },
  key: index => index === 0 ? 'deepstay:last-seen-version' : null,
  getItem: key => key === 'deepstay:last-seen-version' ? '0.1.17' : null,
  setItem() {},
  removeItem() {},
}
globalThis.document = {
  visibilityState: 'visible',
  querySelector: () => ({ content: '0.1.17' }),
  addEventListener() {},
  removeEventListener() {},
}
globalThis.__UPDATE_MANIFEST_URL__ = ''
const stableRelease = version => ({
  tag_name: `v${version}`,
  draft: false,
  prerelease: false,
  html_url: `https://github.com/Dingh0208/deepstay/releases/tag/v${version}`,
  assets: [{
    name: `deepstay-${version}.apk`,
    browser_download_url: `https://github.com/Dingh0208/deepstay/releases/download/v${version}/deepstay-${version}.apk`,
    digest: `sha256:${'b2'.repeat(32)}`,
  }],
})
let release = stableRelease('0.1.17')
globalThis.fetch = async () => Response.json(release)

const currentUpdate = await import(new URL('services/appUpdates.ts?same-version', root))
await currentUpdate.checkForUpdates(true)
assert.deepEqual(currentUpdate.useUpdateState.getState().value, { status: 'current', release: currentUpdate.useUpdateState.getState().value.release })
assert.equal(currentUpdate.useUpdateState.getState().hasUpdate, false)
assert.equal(currentUpdate.useUpdateState.getState().value.release.version, '0.1.17')
assert.equal(currentUpdate.useUpdateState.getState().value.status, 'current')

release = stableRelease('0.1.18')
const newerUpdate = await import(new URL('services/appUpdates.ts?new-version', root))
await newerUpdate.checkForUpdates(true)
assert.equal(newerUpdate.useUpdateState.getState().hasUpdate, true)
assert.equal(newerUpdate.useUpdateState.getState().value.status, 'available')
assert.equal(newerUpdate.useUpdateState.getState().value.release.version, '0.1.18')

console.log(JSON.stringify({
  passed: true,
  checks: [
    'The current release and a stale same-version APK cache resolve to current with no update/install state',
    'Only a strictly newer release resolves to available',
  ],
  scope: 'Actual application update state machine with mocked Android plugin, manifest response, document version, and localStorage; no APK download or installation performed.',
}, null, 2))
