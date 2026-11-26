import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { registerHooks, stripTypeScriptTypes } from 'node:module'
import { fileURLToPath } from 'node:url'

const root = new URL('../src/', import.meta.url)
// 原生插件在 Node 中不存在，用同样的方法签名替身覆盖，只验证调用契约。
const capacitorStub = `data:text/javascript;base64,${Buffer.from(
  [
    'export const Capacitor = {',
    "  getPlatform: () => 'android',",
    "  convertFileSrc: (path) => 'https://localhost/_capacitor_file_' + path,",
    '}',
    'export const registerPlugin = () => globalThis.__archivePlugin',
  ].join('\n')
).toString('base64')}`

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@capacitor/core') return { url: capacitorStub, format: 'module', shortCircuit: true }
    if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL?.startsWith(root.href)) {
      const file = new URL(specifier.slice(0, -3) + '.ts', context.parentURL)
      if (existsSync(fileURLToPath(file))) return { url: file.href, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url.startsWith(root.href) && url.endsWith('.ts')) {
      return {
        format: 'module',
        source: stripTypeScriptTypes(readFileSync(new URL(url), 'utf8'), { mode: 'transform' }),
        shortCircuit: true,
      }
    }
    return nextLoad(url, context)
  },
})

const saved = new Map()
globalThis.localStorage = {
  getItem: (key) => saved.get(key) ?? null,
  setItem: (key, value) => saved.set(key, value),
  removeItem: (key) => saved.delete(key),
}
Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh-CN' }, configurable: true })
globalThis.__API_ORIGIN__ = 'https://api.deepseek.com'

const { downloadArchive, archiveName } = await import(new URL('services/chat/history/remoteArchive.ts', root))

const calls = []
const listeners = []

/** 每次用例前重置替身，调用顺序在 calls 中可查。 */
const usePlugin = (overrides = {}) => {
  calls.length = 0
  listeners.length = 0
  globalThis.__archivePlugin = {
    addListener: async (event, listener) => {
      calls.push(['listen', event])
      listeners.push(listener)
      return { remove: async () => calls.push(['removeListener']) }
    },
    downloadArchive: async ({ id }) => {
      for (const listener of listeners) listener({ id, received: 50, total: 100 })
      return { path: `/cache/import/archive-${id}.zip`, bytes: 4 }
    },
    cancelDownload: async ({ id }) => calls.push(['cancel', id]),
    releaseArchive: async ({ path }) => calls.push(['release', path]),
    ...overrides,
  }
}

const useBody = (bytes = [0x50, 0x4b, 3, 4]) => {
  globalThis.fetch = async (url) => {
    calls.push(['fetch', String(url)])
    return new Response(new Uint8Array(bytes))
  }
}

/** 断言失败码落到预期文案 key。 */
const expectKey = async (run, key) => {
  await assert.rejects(run, (error) => {
    assert.equal(error.name, 'BackupError')
    assert.equal(error.key, key)
    return true
  })
}

// 形状与 DeepSeek 导出直链一致，但域名与签名均为占位值，不含真实凭据。
const LINK =
  'https://export.example.test/Wechat-00000000-0000-0000-0000-000000000000.zip' +
  '?response-content-disposition=' +
  encodeURIComponent('attachment; filename=deepseek_data-2026-11-26.zip') +
  '&Expires=1796275193&AccessKeyId=EXAMPLEACCESSKEY00&Signature=00000000000000000000000000%3D'

usePlugin()
useBody()

// 1) 链接语义校验：任何一条不合格都不得进入原生下载
await expectKey(() => downloadArchive('http://example.com/a.zip'), 'historyImportLinkInvalid')
await expectKey(() => downloadArchive('https://user:pass@example.com/a.zip'), 'historyImportLinkInvalid')
await expectKey(() => downloadArchive('not a link'), 'historyImportLinkInvalid')
await expectKey(() => downloadArchive(''), 'historyImportLinkInvalid')

const blocked = [
  'https://localhost/a.zip',
  'https://127.0.0.1/a.zip',
  'https://10.1.2.3/a.zip',
  'https://172.16.5.4/a.zip',
  'https://192.168.0.10/a.zip',
  'https://169.254.1.1/a.zip',
  'https://[::1]/a.zip',
  'https://[fe80::1]/a.zip',
]
for (const url of blocked) {
  await expectKey(() => downloadArchive(url), 'historyImportLinkBlocked')
}
assert.equal(calls.length, 0, 'validation must reject before any native call')

// 2) 文件名推导：disposition 优先，其次路径末段，最后回落默认名
assert.equal(archiveName(new URL(LINK)), 'deepseek_data-2026-11-26.zip')
assert.equal(archiveName(new URL('https://example.com/files/abc.zip')), 'abc.zip')
assert.equal(archiveName(new URL('https://example.com/files/session')), 'deepseek_data.zip')
assert.equal(archiveName(new URL('https://example.com/a%3Ab.zip')), 'a_b.zip')

// 3) 正常路径：进度透传、交接为 File、临时文件与监听器都要释放
usePlugin()
useBody()
calls.length = 0
const progress = []
const file = await downloadArchive(LINK, { onProgress: (value) => progress.push(value) })
assert.equal(file.name, 'deepseek_data-2026-11-26.zip')
assert.equal(file.type, 'application/zip')
assert.equal(file.size, 4)
assert.deepEqual(progress, [{ received: 50, total: 100 }])
assert.ok(calls.some(([name]) => name === 'release'), 'temporary archive must be released')
assert.ok(calls.some(([name]) => name === 'removeListener'), 'progress listener must be removed')
assert.ok(
  calls.some(([name, url]) => name === 'fetch' && String(url).startsWith('https://localhost/_capacitor_file_')),
  'archive must be read back over the local loopback'
)

// 4) 失败码映射
usePlugin({ downloadArchive: async () => Promise.reject(Object.assign(new Error('denied'), { code: 'ARCHIVE_EXPIRED' })) })
await expectKey(() => downloadArchive(LINK), 'historyImportLinkExpired')

usePlugin({ downloadArchive: async () => Promise.reject(Object.assign(new Error('blocked'), { code: 'ARCHIVE_URL_BLOCKED' })) })
await expectKey(() => downloadArchive(LINK), 'historyImportLinkBlocked')

usePlugin({ downloadArchive: async () => Promise.reject(Object.assign(new Error('webdav'), { code: 'ARCHIVE_WEBDAV' })) })
await expectKey(() => downloadArchive(LINK), 'historyImportLinkFailed')

usePlugin({ downloadArchive: async () => ({ path: '/cache/import/big.zip', bytes: 200 * 1024 * 1024 + 1 }) })
await expectKey(() => downloadArchive(LINK), 'historyImportLinkTooLarge')

usePlugin()
useBody([])
await expectKey(() => downloadArchive(LINK), 'historyImportLinkFailed')

// 5) 取消：中断立即通知原生，且不再落到用户可见的失败
usePlugin({
  downloadArchive: () => new Promise(() => {}),
})
const controller = new AbortController()
const pending = downloadArchive(LINK, { signal: controller.signal })
controller.abort()
await expectKey(() => pending, 'historyImportLinkFailed')
assert.ok(calls.some(([name]) => name === 'cancel'), 'abort must cancel the native download')

console.log('remote archive import: ok')
