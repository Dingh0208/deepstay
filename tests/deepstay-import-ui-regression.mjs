import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { createRequire, registerHooks, stripTypeScriptTypes } from 'node:module'

const app = new URL('../', import.meta.url)
const source = new URL('src/components/settings/SettingsDialog.tsx', app)
const require = createRequire(new URL('package.json', app))
const { transformSync } = require(require.resolve('@rspack/binding', { paths: [require.resolve('@rspack/core')] }))
const mockUrl = text => 'data:text/javascript;base64,' + Buffer.from(text).toString('base64')
const mocks = new Map([
  ['react', 'export const useState=(...args)=>globalThis.__hooks.useState(...args); export const useRef=(...args)=>globalThis.__hooks.useRef(...args);'],
  ['react/jsx-runtime', 'export const Fragment=Symbol.for("fragment"); export const jsx=(type,props,key)=>({type,props,key}); export const jsxs=jsx;'],
  ['@capacitor/core', 'export const Capacitor={getPlatform:()=>globalThis.__exportPlatform}; export const registerPlugin=()=>globalThis.__exportNative;'],
  ['../base/icons.js', ['IconDarkOutline16', 'IconDataOutline16', 'IconDownloadOutline16', 'IconFollowsystemOutline16', 'IconLightOutline16', 'IconSettingsOutline16', 'IconUploadOutline14', 'IconWarningOutline16'].map(name => `export const ${name}=()=>null;`).join('')],
  ['../../services/chat/backup.js', 'export const backupFileName=()=>"history.zip"; export class BackupError extends Error{}; export const clearHistory=async()=>{}; export const downloadRemoteHistory=(...args)=>globalThis.__downloadRemoteHistory(...args); export const exportHistory=(...args)=>globalThis.__exportHistory(...args); export const importHistory=(...args)=>globalThis.__importHistory(...args); export const previewHistory=(...args)=>globalThis.__previewHistory(...args);'],
  ['../../app/viewport.js', 'export const useIsMobile=()=>true;'],
  ['../../services/chat/store.js', 'export const useChatStore=selector=>selector(globalThis.__chatState);'],
  ['../../services/settings.js', 'export const isChineseBrowser=()=>false; export const setLocale=()=>{}; export const setThemePreference=()=>{}; export const setTtsVoice=()=>{}; export const setVoiceCallBargeIn=()=>{}; export const setVoiceCallPause=()=>{}; export const setVoiceCallSpeakerPreference=()=>{}; export const setChatFont=()=>{}; export const setChatFontSize=()=>{}; export const bundledChatFonts=[]; export const getChatFontFamily=()=>"system-ui"; export const useSettings=selector=>selector({locale:"zh-CN"});'],
  ['../../services/diagnostics/log.js', 'export const recordDiagnostic=()=>{};'],
  ['../../i18n/index.js', 'export const useTranslate=()=>globalThis.__translate;'],
  ['../base/Button.js', 'export const Button=()=>null;'],
  ['../base/Modal.js', 'export const Modal=()=>null;'],
  ['../base/Select.js', 'export const Select=()=>null;'],
  ['../base/toastState.js', 'export const showToast=()=>{};'],
  ['./ApiKeyField.js', 'export const ApiKeyConfirm=()=>null; export const ApiKeyField=()=>null; export const useApiKeyEditor=()=>({});'],
  ['./ApiBalanceSetting.js', 'export const ApiBalanceSetting=()=>null;'],
  ['./AppearanceSetting.js', 'export const ChatBackgroundSetting=()=>null; export const ThinkingCollapseSetting=()=>null;'],
  ['./AppearanceSetting.module.css', 'export default {};'],
  ['./ContextMemorySetting.js', 'export const ContextMemorySetting=()=>null;'],
  ['./DiagnosticsSetting.js', 'export const DiagnosticsSetting=()=>null;'],
  ['./GenerationSetting.js', 'export const GenerationSetting=()=>null; export const ReplyPreferenceSettings=()=>null;'],
  ['./UpdateSetting.js', 'export const UpdateSetting=()=>null;'],
  ['./settingsDialogState.js', 'export const closeSettings=()=>{globalThis.__closed+=1}; export const useSettingsDialog=Object.assign(selector=>selector({open:true,section:"data"}),{getState:()=>({section:"data"})});'],
  ['../characters/characterDialogState.js', 'export const openCharacters=()=>{};'],
  ['./Settings.module.css', 'export default {};'],
])
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL === source.href && mocks.has(specifier)) return { url: mockUrl(mocks.get(specifier)), shortCircuit: true }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url === source.href) {
      const input = readFileSync(source, 'utf8') + '\nexport { useHistoryImport, ImportHistory, ImportConfirm, SettingsContent, ExportHistory };'
      return { format: 'module', source: transformSync(input, JSON.stringify({ jsc: {
        target: 'es2022', parser: { syntax: 'typescript', tsx: true }, transform: { react: { runtime: 'automatic' } },
      }, module: { type: 'es6' } })).code, shortCircuit: true }
    }
    if (url.startsWith(new URL('src/i18n/', app).href) && url.endsWith('.ts')) {
      return { format: 'module', source: stripTypeScriptTypes(readFileSync(new URL(url), 'utf8'), { mode: 'transform' }), shortCircuit: true }
    }
    return nextLoad(url, context)
  },
})
const runner = component => {
  const slots = []
  let cursor = 0
  const state = {
    useState(initial) {
      const index = cursor++
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial
      return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value }]
    },
    useRef(initial) { const index = cursor++; return slots[index] ??= { current: initial } },
  }
  return props => { cursor = 0; globalThis.__hooks = state; return component(props) }
}
const find = (node, predicate) => {
  if (!node || typeof node !== 'object') return null
  if (!Array.isArray(node) && predicate(node)) return node
  for (const child of Array.isArray(node) ? node : [node.props?.children]) {
    const found = find(child, predicate)
    if (found) return found
  }
  return null
}
const checks = []
try {
  const { zh } = await import(new URL('src/i18n/zh.ts', app))
  const { en } = await import(new URL('src/i18n/en.ts', app))
  globalThis.__translate = key => zh[key]
  globalThis.__closed = 0
  globalThis.__chatState = { importingHistory: false }
  globalThis.__previewHistory = async () => [{ id: 'first', title: 'First', message_count: 2, updated_at: '2026-11-20T00:00:00Z' }, { id: 'second', title: 'Second', message_count: 4, updated_at: '2026-11-20T01:00:00Z' }]
  let resolveImport, rejectImport, reportProgress
  const calls = []
  globalThis.__importHistory = (file, onProgress, selected) => {
    calls.push({ file, selected: [...selected] })
    reportProgress = onProgress
    return new Promise((resolve, reject) => { resolveImport = resolve; rejectImport = reject })
  }
  const { useHistoryImport, ImportHistory, ImportConfirm, SettingsContent, ExportHistory } = await import(source)
  const renderHook = runner(useHistoryImport)
  const renderImport = runner(ImportHistory)
  let current = renderHook()
  await current.select(new File(['fixture'], 'cancelled.zip'))
  current = renderHook()
  current.cancel()
  current = renderHook()
  assert.equal(current.file, null)
  assert.equal(calls.length, 0)
  checks.push('Read-only preview selects all chats initially; cancelling never starts import or touches history')

  await current.select(new File(['fixture'], 'history.zip'))
  current = renderHook()
  assert.equal(current.preview.length, 2)
  assert.equal(current.selected.size, 2)
  current.toggle('first')
  current = renderHook()
  const renderConfirm = runner(ImportConfirm)
  const confirmation = renderConfirm({ historyImport: current })
  assert.equal(find(confirmation, node => node.type === 'input').props.checked, true)
  const staleConfirm = current.confirm
  const importing = current.confirm()
  void staleConfirm()
  current = renderHook()
  assert.equal(current.busy, true)
  assert.equal(current.file, null)
  assert.equal(calls.length, 1, 'Repeated confirmation must not start another import')
  assert.deepEqual(calls[0].selected, ['second'], 'Only selected archive IDs are passed to the import service')
  reportProgress(42)
  current = renderHook()
  assert.equal(current.progress, 42)
  const cell = renderImport({ historyImport: current, disabled: true })
  const button = find(cell, node => node.type?.name === 'SettingCell').props.action.props.children[0]
  assert.equal(button.props.disabled, true)
  assert.equal(button.props['aria-busy'], true)
  assert.equal(button.props.children[1], zh.historyImporting)
  const bar = find(cell, node => node.type === 'progress')
  assert.equal(bar.props.value, 42)
  assert.equal(bar.props.max, 100)
  assert.equal(bar.props['aria-label'], zh.historyImporting)
  assert.equal(globalThis.__closed, 0)
  checks.push('Actual import hook prevents duplicate starts, keeps settings open, disables upload and shows an accessible real percentage progress bar')

  reportProgress(100)
  resolveImport(15)
  await importing
  current = renderHook()
  assert.equal(current.busy, false)
  assert.equal(current.status.key, 'historyImported')
  assert.equal(current.status.params.count, 15)
  assert.equal(find(renderImport({ historyImport: current, disabled: false }), node => node.type === 'progress'), null)
  checks.push('Successful save ends progress and displays the imported count')

  await current.select(new File(['fixture'], 'bad.zip'))
  current = renderHook()
  const failing = current.confirm()
  rejectImport(new Error('Invalid ZIP'))
  await failing
  current = renderHook()
  assert.equal(current.busy, false)
  assert.equal(current.status.key, 'historyImportFailed')
  assert.equal(current.status.error, true)
  checks.push('Failure releases the upload lock and displays an error without claiming success')

  globalThis.__previewHistory = async () => { throw new Error('Invalid index') }
  await current.select(new File(['bad'], 'bad-preview.zip'))
  current = renderHook()
  assert.equal(current.file, null)
  assert.equal(current.busy, false)
  assert.equal(current.status.error, true)
  let resolvePreview
  globalThis.__previewHistory = () => new Promise(resolve => { resolvePreview = resolve })
  const cancelledPreview = current.select(new File(['pending'], 'cancel-preview.zip'))
  current = renderHook()
  assert.equal(current.previewing, true)
  current.cancel()
  resolvePreview([{ id: 'late' }])
  await cancelledPreview
  current = renderHook()
  assert.equal(current.file, null)
  assert.equal(current.preview, null)
  globalThis.__previewHistory = async () => [{ id: 'first', title: 'First', message_count: 2, updated_at: '2026-11-20T00:00:00Z' }]
  checks.push('A bad archive preview releases the lock; cancellation ignores a late preview response without starting import')

  const renderSettings = runner(SettingsContent)
  let settings = renderSettings()
  const componentHook = find(settings, node => node.type?.name === 'ImportHistory').props.historyImport
  await componentHook.select(new File(['fixture'], 'settings.zip'))
  settings = renderSettings()
  const settingsImport = find(settings, node => node.type?.name === 'ImportHistory').props.historyImport.confirm()
  settings = renderSettings()
  find(settings, node => node.type?.name === 'Modal').props.onClose()
  assert.equal(globalThis.__closed, 0)
  assert.equal(find(settings, node => node.type?.name === 'ExportHistory').props.disabled, true)
  assert.equal(find(settings, node => node.type?.name === 'ImportHistory').props.disabled, true)
  resolveImport(1)
  await settingsImport
  settings = renderSettings()
  find(settings, node => node.type?.name === 'Modal').props.onClose()
  assert.equal(globalThis.__closed, 1)
  globalThis.__chatState.importingHistory = true
  find(renderSettings(), node => node.type?.name === 'Modal').props.onClose()
  assert.equal(globalThis.__closed, 1)
  checks.push('Settings cannot close or start export/import during a serial import or explicit history replacement')
  assert.ok(zh.historyImported && en.historyImported)

  globalThis.__chatState = { sessions: [{ id: 'export-fixture' }] }
  globalThis.__exportPlatform = 'android'
  const nativeChunks = []
  let finishCalls = 0, cancel = false, failWrite = false, exportCalls = 0
  globalThis.__exportNative = {
    beginSave: async () => ({ cancelled: cancel, id: 'native-target' }),
    appendSave: async ({ id, data }) => {
      assert.equal(id, 'native-target')
      assert.ok(data.length <= 262144, 'No bridge call carries the entire archive')
      if (failWrite) throw Error('disk full')
      nativeChunks.push(Buffer.from(data, 'base64'))
    },
    finishSave: async () => { finishCalls++ },
  }
  const exportBytes = Uint8Array.from({ length: 900000 }, (_, i) => i % 256)
  let releaseExport
  globalThis.__exportHistory = async (progress, writeChunk) => {
    exportCalls++
    progress(42)
    await new Promise(resolve => { releaseExport = resolve })
    await writeChunk(exportBytes)
    progress(100)
    return { name: 'history.zip', blob: new Blob() }
  }
  const renderExport = runner(ExportHistory)
  const exportButton = tree => find(tree, node => node.type?.name === 'SettingCell').props.action
  exportButton(renderExport({ disabled: false })).props.onClick()
  await new Promise(resolve => setTimeout(resolve, 0))
  const exporting = renderExport({ disabled: false })
  assert.equal(find(exporting, node => node.type === 'progress').props.value, 42)
  assert.equal(exportButton(exporting).props.disabled, true)
  releaseExport()
  for (let i = 0; i < 20 && exportButton(renderExport({ disabled: false })).props.disabled; i++) await new Promise(resolve => setTimeout(resolve, 0))
  assert.deepEqual(Buffer.concat(nativeChunks), Buffer.from(exportBytes))
  assert.equal(finishCalls, 1)
  assert.equal(find(renderExport({ disabled: false }), node => node.type === 'progress'), null)
  cancel = true
  exportButton(renderExport({ disabled: false })).props.onClick()
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(exportCalls, 1, 'Picker cancellation does not read or generate any archive')
  cancel = false
  failWrite = true
  exportButton(renderExport({ disabled: false })).props.onClick()
  await new Promise(resolve => setTimeout(resolve, 0))
  releaseExport()
  await new Promise(resolve => setTimeout(resolve, 0))
  const failedExport = renderExport({ disabled: false })
  assert.equal(exportButton(failedExport).props.disabled, false)
  assert.ok(find(failedExport, node => node.type?.name === 'SettingCell').props.status)
  assert.equal(finishCalls, 2, 'Failed writes close the native output before releasing the button')
  checks.push('Android export shows progress, splits a 900 KB ZIP chunk into bounded bridge calls with exact byte fidelity, closes the output on failure and skips archive generation when the picker is cancelled')

  const evidence = { passed: true, runtime: process.version, checks,
    scope: 'Actual SettingsDialog TSX, import hook, button and modal callbacks with deterministic React hooks and deferred import I/O; complements the real ZIP/IndexedDB regression, not a handset screenshot.' }
  await writeFile(new URL('./deepstay-import-ui-evidence.json', import.meta.url), JSON.stringify(evidence, null, 2) + '\n')
  console.log(JSON.stringify(evidence, null, 2))
} finally {
  hooks.deregister()
}
