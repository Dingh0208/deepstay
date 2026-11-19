import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'

const changelog = (await readFile(new URL('../CHANGELOG.md', import.meta.url), 'utf8')).replaceAll('\r\n', '\n')
const notesSource = await readFile(new URL('../src/services/releaseNotes.ts', import.meta.url), 'utf8')
const notesModule = await import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(notesSource)).toString('base64')}`)
const notes = notesModule.parseReleaseNotes(changelog)
const changelogVersions = [...changelog.matchAll(/^## (\d+\.\d+\.\d+)$/gm)].map((match) => match[1])
assert.deepEqual(notes.map((release) => release.version), changelogVersions,
  'In-app history must cover every changelog version in order')
for (const release of notes) {
  const start = changelog.indexOf(`## ${release.version}\n`) + `## ${release.version}\n`.length
  const next = changelog.indexOf('\n## ', start)
  const section = changelog.slice(start, next < 0 ? undefined : next)
  assert.equal(release.changes.length, [...section.matchAll(/^- /gm)].length,
    `Every ${release.version} changelog entry must appear in the in-app history`)
}
assert.ok(notes[0].version === '0.1.8', 'Newest release must lead the list')
assert.ok(notes[0].changes[0].includes('聊天背景'), 'History retains exact changelog text')

const original = await readFile(new URL('../src/services/appUpdates.ts', import.meta.url), 'utf8')
const mockCreate = `const create = (initializer) => {
  let state = initializer()
  const store = (selector = value => value) => selector(state)
  store.setState = update => {
    const partial = typeof update === 'function' ? update(state) : update
    state = { ...state, ...partial }
  }
  store.getState = () => state
  return store
}`
const mockCompare = `const compareVersions = (left, right) => {
  const a = left.split('.').map(Number)
  const b = right.split('.').map(Number)
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1
  }
  return 0
}`
let round = 0
const compile = (platform) => {
  const source = original
    .replace("import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core'", `const Capacitor = { getPlatform: () => globalThis.__platform }; const registerPlugin = () => globalThis.__plugin`)
    .replace("import { create } from 'zustand'", mockCreate)
    .replace("import { compareVersions, fetchLatestRelease, type AppRelease } from './updates.js'", `${mockCompare}; const fetchLatestRelease = async () => globalThis.__fetchRelease ? globalThis.__fetchRelease() : globalThis.__release ?? null`)
  assert.notEqual(source, original)
  const compiled = stripTypeScriptTypes(source)
  globalThis.__platform = platform
  round += 1
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}#round-${round}`)
}

const localStorageFrom = (entries = {}) => {
  const values = new Map(Object.entries(entries))
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
    get length() { return values.size },
    key: (index) => [...values.keys()][index] ?? null,
    [Symbol.iterator]: () => values.keys(),
  }
}

const initialize = async (module) => {
  module.initializeAppUpdates()
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
  return module.useUpdateState.getState()
}

const listeners = new Map()
globalThis.document = {
  querySelector: () => ({ content: '0.1.8' }),
  addEventListener: (name, listener) => listeners.set(name, listener),
  removeEventListener: (name, listener) => {
    if (listeners.get(name) === listener) listeners.delete(name)
  },
  visibilityState: 'visible',
}
globalThis.__release = null
globalThis.__plugin = { getPendingApk: async () => ({ ready: false }) }
globalThis.localStorage = localStorageFrom()
const firstInstall = await initialize(await compile('android'))
assert.equal(firstInstall.releaseNotesOpen, false, 'A fresh Android install should not show an upgrade notice')

globalThis.__plugin = {
  getPendingApk: async () => ({ ready: false }),
  getInstallStatus: async () => ({ updated: true }),
}
globalThis.localStorage = localStorageFrom()
const upgradedInstall = await initialize(await compile('android'))
assert.equal(upgradedInstall.releaseNotesOpen, true, 'An Android install updated since its previous launch should show notes')
assert.equal(upgradedInstall.recentReleaseNotes, true, 'An upgrade prompt uses only the latest three release notes')

globalThis.__plugin.getInstallStatus = async () => ({ updated: false })
globalThis.localStorage = localStorageFrom({ 'chat-demo:api-key': 'old-local-config' })
const migrated = await compile('android')
assert.equal((await initialize(migrated)).releaseNotesOpen, true,
  'An existing pre-0.1.8 install without a seen-version marker still shows the first upgrade notice')
assert.equal(globalThis.localStorage.getItem('deepstay:last-seen-version'), '0.1.8')
migrated.closeReleaseNotes()
migrated.openReleaseNotes()
assert.equal(migrated.useUpdateState.getState().recentReleaseNotes, false,
  'The version-number entry opens the full update history')

globalThis.__platform = 'web'
globalThis.__release = { version: '0.2.0' }
globalThis.localStorage = localStorageFrom({ 'deepstay:api-key': 'configured', 'deepstay:last-seen-version': '0.1.7' })
const webUpgrade = await initialize(await compile('web'))
assert.equal(webUpgrade.releaseNotesOpen, true, 'A web install that has not seen the current app version should show notes')
assert.equal(webUpgrade.hasUpdate, true, 'An available release should activate the Settings indicator state')

globalThis.__release = { version: '0.1.8' }
globalThis.localStorage = localStorageFrom({ 'deepstay:last-seen-version': '0.1.8' })
const currentInstall = await initialize(await compile('web'))
assert.equal(currentInstall.releaseNotesOpen, false, 'An already-seen version should not reopen update notes')
assert.equal(currentInstall.hasUpdate, false, 'The update indicator should stay clear when versions match')

globalThis.localStorage = localStorageFrom({ 'deepstay:last-seen-version': '0.1.8' })
const stale = await compile('web')
stale.useUpdateState.setState({ hasUpdate: true, value: { status: 'available', release: { version: '0.2.0' } } })
await stale.checkForUpdates(false)
assert.equal(stale.useUpdateState.getState().hasUpdate, false, 'A current release clears a stale update indicator')
assert.equal(stale.useUpdateState.getState().value.status, 'current', 'A stale available message is cleared with its indicator')
stale.useUpdateState.setState({ hasUpdate: true })
globalThis.__release = null
await stale.checkForUpdates(false)
assert.equal(stale.useUpdateState.getState().hasUpdate, false, 'An empty release list clears a stale update indicator')
assert.equal(stale.useUpdateState.getState().value.status, 'idle', 'An empty release list removes the stale update entry')

let requests = 0, respond
globalThis.__fetchRelease = () => {
  requests += 1
  return new Promise((resolve) => { respond = resolve })
}
const concurrent = await compile('web')
const cleanup = concurrent.bindAppUpdates()
concurrent.initializeAppUpdates()
listeners.get('visibilitychange')()
const manual = concurrent.checkForUpdates()
assert.equal(requests, 1, 'Launch, foreground and manual checks share an in-flight request')
respond({ version: '0.2.0' })
await manual
assert.equal(concurrent.useUpdateState.getState().value.status, 'available')
listeners.get('visibilitychange')()
assert.equal(requests, 2, 'Returning to the foreground starts a fresh check after the previous one finishes')
respond({ version: '0.1.8' })
await new Promise((resolve) => setImmediate(resolve))
assert.equal(concurrent.useUpdateState.getState().hasUpdate, false)
cleanup()
assert.equal(listeners.has('visibilitychange'), false, 'Unmount removes the foreground listener')

globalThis.__fetchRelease = async () => { throw new Error('offline') }
const offline = await compile('web')
await offline.checkForUpdates(false)
assert.equal(offline.useUpdateState.getState().value.status, 'idle', 'Background failures stay silent')
await offline.checkForUpdates()
assert.equal(offline.useUpdateState.getState().value.status, 'error', 'A manual failed check is visible and retryable')

globalThis.__fetchRelease = undefined
globalThis.__release = { version: '0.3.0' }
globalThis.__plugin = {
  getInstallStatus: async () => ({ updated: false }),
  getPendingApk: async () => ({ ready: true, version: '0.2.0' }),
}
const downloaded = await compile('android')
await initialize(downloaded)
assert.equal(downloaded.useUpdateState.getState().value.status, 'downloaded',
  'A restored APK ready for installation takes priority over automatic release checks')
await downloaded.checkForUpdates()
assert.equal(downloaded.useUpdateState.getState().value.status, 'downloaded',
  'A manual check also keeps the validated pending APK available')

console.log(JSON.stringify({
  passed: true,
  checks: [
    'Update history exactly matches every release listed in CHANGELOG.md and puts the current release first',
    'Android upgrade prompting distinguishes a fresh install from a later app update',
    'Pre-0.1.8 local installations without a seen-version marker are migrated and version-number clicks reopen all history',
    'Web upgrade prompting is shown once per version and available updates drive the Settings indicator state',
    'Cold-launch, foreground and manual checks share one in-flight request, remove listeners on unmount, and clear stale update dots',
    'Background failures stay silent, manual failures can be retried, and a validated pending APK wins over release refreshes',
  ],
  scope: 'App update state with stubbed platform/native plugin/release API plus the bundled release history; no APK was downloaded or installed',
}, null, 2))
