import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'

const source = await readFile(new URL('../src/services/updates.ts', import.meta.url), 'utf8')
// Compile two independent instances so the build-time URL is tested without module-cache leakage.
const loadUpdates = async (manifestUrl = '') => {
  const compiled = stripTypeScriptTypes(source.replaceAll('__UPDATE_MANIFEST_URL__', JSON.stringify(manifestUrl)))
  return import('data:text/javascript;base64,' + Buffer.from(compiled).toString('base64'))
}
const { compareVersions, readAppRelease, readUpdateManifest, fetchLatestRelease } = await loadUpdates()
const checks = []

for (const [left, right, expected] of [
  ['0.10.0', '0.9.9', 1], ['1.0.0', '0.99.99', 1], ['0.1.10', '0.1.9', 1],
  ['v0.1.0', '0.1.0', 0], ['1.0.0+build.1', '1.0.0+build.2', 0],
  ['1.0.0-rc.2', '1.0.0-rc.10', -1], ['1.0.0', '1.0.0-rc.10', 1],
  ['1.0.0-alpha', '1.0.0-alpha.1', -1], ['1.0.0-1', '1.0.0-alpha', -1],
  ['not-a-version', '1.0.0', null], ['1.0', '1.0.0', null],
]) {
  assert.equal(compareVersions(left, right), expected, `${left} vs ${right}`)
}
checks.push('Numerical version ordering, prerelease ordering, v prefix, build metadata and malformed versions')

const release = {
  tag_name: 'v0.2.0', draft: false, prerelease: false,
  html_url: 'https://github.com/Dingh0208/deepstay/releases/tag/v0.2.0',
  assets: [{ name: 'deepstay-0.2.0.apk', browser_download_url: 'https://github.com/Dingh0208/deepstay/releases/download/v0.2.0/deepstay-0.2.0.apk' }],
}
assert.equal(readAppRelease(release).version, '0.2.0')
assert.equal(readAppRelease(release).apkUrl, release.assets[0].browser_download_url)
assert.equal(readAppRelease({ ...release, assets: [] }).apkUrl, null)
for (const invalid of [null, {}, { ...release, prerelease: true }, { ...release, draft: true },
  { ...release, tag_name: 'invalid' }, { ...release, assets: null },
  { ...release, html_url: 'https://example.com/release' }]) {
  assert.equal(readAppRelease(invalid), null)
}
assert.equal(readAppRelease({ ...release, assets: [{ name: 'update.apk', browser_download_url: 'https://example.com/update.apk' }] }).apkUrl, null)
assert.equal(readAppRelease({ ...release, html_url: release.html_url.replace('v0.2.0', 'v0.1.0') }), null)
assert.equal(readAppRelease({ ...release, assets: [{ ...release.assets[0], browser_download_url: release.assets[0].browser_download_url.replace('/v0.2.0/', '/v0.1.0/') }] }).apkUrl, null)
assert.equal(readAppRelease({ ...release, assets: [{ name: 'old.apk', browser_download_url: 'https://github.com/Dingh0208/deepstay/releases/download/v0.1.0/old.apk' }, ...release.assets] }).apkUrl, release.assets[0].browser_download_url)
const hash = 'a1'.repeat(32)
assert.equal(readAppRelease(release).apkSha256, null)
assert.equal(readAppRelease({ ...release, assets: [{ ...release.assets[0], digest: `sha256:${hash}` }] }).apkSha256, hash)
for (const digest of [null, 123, '', 'sha1:' + hash, 'sha256:abc', 'sha256:' + 'g'.repeat(64)]) {
  const parsed = readAppRelease({ ...release, assets: [{ ...release.assets[0], digest }] })
  assert.equal(parsed.apkSha256, null)
  assert.equal(parsed.apkUrl, release.assets[0].browser_download_url)
}
checks.push('Stable GitHub releases reject foreign URLs; missing/malformed asset digest stays unavailable, while a valid SHA-256 is parsed')

const manifestUrl = 'https://downloads.example.cn/deepstay/update.json'
const manifest = { version: 'v0.2.0', apkUrl: 'https://downloads.example.cn/deepstay/deepstay-0.2.0.apk', sha256: hash.toUpperCase() }
assert.deepEqual(readUpdateManifest(manifest, manifestUrl), {
  version: '0.2.0', releaseUrl: release.html_url, apkUrl: manifest.apkUrl, apkSha256: hash,
})
const hashedApkUrl = `https://downloads.example.cn/deepstay/deepstay-0.2.0-${hash}.apk`
assert.equal(readUpdateManifest({ ...manifest, apkUrl: hashedApkUrl }, manifestUrl).apkUrl, hashedApkUrl)
assert.equal(readUpdateManifest({ ...manifest, versionCode: 15 }, manifestUrl).apkVersionCode, 15)
assert.equal(readUpdateManifest({ ...manifest, version: '0.2.0+build.1', apkUrl: manifest.apkUrl.replace('0.2.0.apk', '0.2.0+build.1.apk') }, manifestUrl).version, '0.2.0+build.1')
for (const mismatch of [
  { ...manifest, apkUrl: manifest.apkUrl.replace('0.2.0', '0.1.0') },
  { ...manifest, apkUrl: hashedApkUrl.replace(hash, 'b2'.repeat(32)) },
  ...[0, -1, 1.5, '15', Number.MAX_SAFE_INTEGER + 1].map(versionCode => ({ ...manifest, versionCode })),
]) assert.equal(readUpdateManifest(mismatch, manifestUrl), null, 'Manifest version, code and content-addressed filename must agree')
for (const invalid of [null, {}, { ...manifest, version: 'bad' }, { ...manifest, version: '0.2' },
  { ...manifest, version: '0.2.0-rc.1' }, { ...manifest, version: 'v0.2.0-beta' },
  { ...manifest, sha256: '' }, { ...manifest, sha256: '0'.repeat(63) }, { ...manifest, sha256: 'g'.repeat(64) },
  { ...manifest, sha256: null }, { ...manifest, apkUrl: null }]) {
  assert.equal(readUpdateManifest(invalid, manifestUrl), null, JSON.stringify(invalid))
}
for (const apkUrl of [
  'http://downloads.example.cn/deepstay/app.apk',
  'https://foreign.example/deepstay/app.apk',
  'https://downloads.example.cn.evil.example/deepstay/app.apk',
  'https://downloads.example.cn:444/deepstay/app.apk',
  'https://name:password@downloads.example.cn/deepstay/app.apk',
  'https://downloads.example.cn/deepstay/app.apk#fragment',
  'https://downloads.example.cn/deepstay/app.zip',
  'https://downloads.example.cn/deepstay/subdir/app.apk',
  'https://downloads.example.cn/deepstay/../app.apk',
  'https://downloads.example.cn/deepstay/%2e%2e/app.apk',
  'https://downloads.example.cn/deepstay/sub%2fapp.apk',
  '../app.apk', 'not a URL',
]) {
  assert.equal(readUpdateManifest({ ...manifest, apkUrl }, manifestUrl), null, apkUrl)
}
for (const invalidBase of ['http://downloads.example.cn/deepstay/update.json', 'not a URL']) {
  assert.equal(readUpdateManifest(manifest, invalidBase), null)
}
checks.push('Configured manifest accepts a stable version and normalizes SHA-256, rejects bad hashes/prereleases/HTTP/foreign hosts or ports/credentials/fragments/subdirectories and directory escape')

let calls = 0
globalThis.fetch = async (url, init) => {
  calls += 1
  assert.equal(url, 'https://api.github.com/repos/Dingh0208/deepstay/releases/latest')
  assert.equal(init.credentials, 'omit')
  assert.equal('Authorization' in init.headers, false)
  assert.equal('x-api-key' in init.headers, false)
  return Response.json(release)
}
assert.equal((await fetchLatestRelease(new AbortController().signal)).version, '0.2.0')
assert.equal(calls, 1)
globalThis.fetch = async () => new Response(null, { status: 404 })
assert.equal(await fetchLatestRelease(new AbortController().signal), null)
globalThis.fetch = async () => new Response(null, { status: 503 })
await assert.rejects(fetchLatestRelease(new AbortController().signal))
globalThis.fetch = async () => Response.json({ tag_name: 'invalid' })
await assert.rejects(fetchLatestRelease(new AbortController().signal))
globalThis.fetch = async () => { throw new TypeError('Network unavailable') }
await assert.rejects(fetchLatestRelease(new AbortController().signal))
checks.push('Latest release fetch sends no credentials; 404, server error, malformed response and network failure remain distinct usable outcomes')

const controller = new AbortController()
globalThis.fetch = async (_url, init) => new Promise((_resolve, reject) => {
  init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
})
const pending = fetchLatestRelease(controller.signal)
controller.abort()
await assert.rejects(pending, error => error.name === 'AbortError')
checks.push('Caller abort cancels an in-flight release check; this does not assert that closing settings cancels an APK download')

const configured = await loadUpdates(manifestUrl)
let configuredCalls = 0
globalThis.fetch = async (url, init) => {
  configuredCalls += 1
  assert.equal(url, manifestUrl)
  assert.equal(init.credentials, 'omit')
  assert.equal(init.cache, 'no-store')
  const headers = new Headers(init.headers)
  assert.equal(headers.has('authorization'), false)
  assert.equal(headers.has('x-api-key'), false)
  assert.equal(headers.has('cookie'), false)
  assert.equal(init.signal.aborted, false)
  return Response.json(manifest)
}
assert.equal((await configured.fetchLatestRelease(new AbortController().signal)).apkSha256, hash)
assert.equal(configuredCalls, 1)
globalThis.fetch = async url => { assert.equal(url, manifestUrl); return new Response(null, { status: 404 }) }
assert.equal(await configured.fetchLatestRelease(new AbortController().signal), null)
globalThis.fetch = async () => Response.json({ ...manifest, sha256: 'invalid' })
await assert.rejects(configured.fetchLatestRelease(new AbortController().signal), /Invalid release response/)
checks.push('Configured build fetches only its manifest URL, omits credentials/API Key/cookies and rejects an invalid configured response without falling back to GitHub')

// Drive the actual ten-second abort path immediately, without a ten-second wall-clock sleep.
const originalTimeout = globalThis.setTimeout
const originalClearTimeout = globalThis.clearTimeout
let scheduled, cleared = 0
try {
  globalThis.setTimeout = (callback, delay) => { assert.equal(delay, 10_000); scheduled = callback; return 42 }
  globalThis.clearTimeout = id => { assert.equal(id, 42); cleared += 1 }
  globalThis.fetch = async (url, init) => {
    assert.equal(url, manifestUrl)
    return new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new DOMException('Timed out', 'AbortError')), { once: true })
    })
  }
  const timeoutRequest = configured.fetchLatestRelease(new AbortController().signal)
  scheduled()
  await assert.rejects(timeoutRequest, error => error.name === 'AbortError')
  assert.equal(cleared, 1)

  const aborted = new AbortController()
  aborted.abort()
  globalThis.fetch = async (_url, init) => {
    assert.equal(init.signal.aborted, true)
    throw new DOMException('Already aborted', 'AbortError')
  }
  await assert.rejects(configured.fetchLatestRelease(aborted.signal), error => error.name === 'AbortError')
  assert.equal(cleared, 2)
} finally {
  globalThis.setTimeout = originalTimeout
  globalThis.clearTimeout = originalClearTimeout
}
checks.push('Configured update check forwards caller pre-abort and its actual ten-second timeout aborts the fetch; timers are cleared in both paths')

const evidence = { passed: true, checks, runtime: process.version,
  scope: 'Actual update service with separate GitHub/default and configured-manifest module instances, deterministic fetch responses and a driven timeout callback; no release download or installation performed' }
await writeFile(new URL('./deepstay-updates-evidence.json', import.meta.url), JSON.stringify(evidence, null, 2) + '\n')
console.log(JSON.stringify(evidence, null, 2))
