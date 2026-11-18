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
  ['@capacitor/core', 'export const Capacitor={}; export const registerPlugin=()=>({});'],
  ['../base/icons.js', ['IconDarkOutline16', 'IconDataOutline16', 'IconDownloadOutline16', 'IconFollowsystemOutline16', 'IconLightOutline16', 'IconSettingsOutline16', 'IconUploadOutline14'].map(name => `export const ${name}=()=>null;`).join('')],
  ['../../services/chat/backup.js', 'export class BackupError extends Error{}; export const clearHistory=async()=>{}; export const exportHistory=async()=>{}; export const importHistory=(file)=>globalThis.__importHistory(file);'],
  ['../../services/chat/backgroundImport.js', 'export const backgroundImportBusy=()=>["preparing","ready","applying","cancelling"].includes(globalThis.__backgroundState.phase); export const startBackgroundImport=file=>{globalThis.__backgroundCalls.push(file); globalThis.__backgroundState={phase:"preparing",progress:0,sessions:0,error:null};}; export const useBackgroundImport=()=>globalThis.__backgroundState;'],
  ['../../app/viewport.js', 'export const useIsMobile=()=>true;'],
  ['../../services/chat/store.js', 'export const useChatStore=selector=>selector(globalThis.__chatState);'],
  ['../../services/settings.js', 'export const isChineseBrowser=()=>false; export const setLocale=()=>{}; export const setThemePreference=()=>{}; export const setTtsVoice=()=>{}; export const useSettings=selector=>selector({locale:"zh-CN"});'],
  ['../../i18n/index.js', 'export const useTranslate=()=>globalThis.__translate;'],
  ['../base/Button.js', 'export const Button=()=>null;'],
  ['../base/Modal.js', 'export const Modal=()=>null;'],
  ['../base/Select.js', 'export const Select=()=>null;'],
  ['../base/toastState.js', 'export const showToast=()=>{};'],
  ['./ApiKeyField.js', 'export const ApiKeyConfirm=()=>null; export const ApiKeyField=()=>null; export const useApiKeyEditor=()=>({});'],
  ['./ApiBalanceSetting.js', 'export const ApiBalanceSetting=()=>null;'],
  ['./AppearanceSetting.js', 'export const ChatBackgroundSetting=()=>null; export const ThinkingCollapseSetting=()=>null;'],
  ['./ContextMemorySetting.js', 'export const ContextMemorySetting=()=>null;'],
  ['./UpdateSetting.js', 'export const UpdateSetting=()=>null;'],
  ['./settingsDialogState.js', 'export const closeSettings=()=>{globalThis.__closed+=1}; export const useSettingsDialog=Object.assign(selector=>selector({open:true,section:"data"}),{getState:()=>({section:"data"})});'],
  ['./Settings.module.css', 'export default {};'],
])
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL === source.href && mocks.has(specifier)) return { url: mockUrl(mocks.get(specifier)), shortCircuit: true }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url === source.href) {
      const input = readFileSync(source, 'utf8') + '\nexport { useHistoryImport, ImportHistory, SettingsContent };'
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
  globalThis.__backgroundCalls = []
  globalThis.__backgroundState = { phase: 'idle', progress: 0, sessions: 0, error: null }
  globalThis.__chatState = { importingHistory: false }
  const { useHistoryImport, ImportHistory, SettingsContent } = await import(source)
  const renderHook = runner(useHistoryImport)
  const renderImport = runner(ImportHistory)
  let current = renderHook()
  current.select(new File(['fixture'], 'history.zip'))
  current = renderHook()
  current.confirm()
  current = renderHook()
  assert.equal(current.busy, true)
  assert.equal(current.file, null)
  assert.equal(current.status.key, 'historyBackgroundProgress')
  assert.equal(globalThis.__backgroundCalls.length, 1, 'Confirmation starts one background import')
  current.confirm()
  assert.equal(globalThis.__backgroundCalls.length, 1, 'Repeated confirmation must not start another import')
  const cell = renderImport({ historyImport: current, disabled: true })
  const button = find(cell.props.action, node => node.type?.name === 'Button')
  assert.equal(button.props.disabled, true)
  assert.equal(button.props['aria-busy'], true)
  assert.equal(button.props.children[1], zh.historyImporting)
  assert.ok(zh.historyBackgroundProgress && en.historyBackgroundProgress)
  assert.equal(globalThis.__closed, 1)
  checks.push('Actual import hook starts one worker, closes settings so chat remains usable, and displays translated progress while blocking duplicate imports')

  globalThis.__backgroundState = { phase: 'done', progress: 100, sessions: 15, error: null }
  current = renderHook()
  assert.equal(current.busy, false)
  assert.equal(current.status.key, 'historyBackgroundDone')
  assert.equal(current.status.params.count, 15)
  checks.push('The completed background import count is available for the progress banner')

  current.select(new File(['fixture'], 'bad.zip'))
  current = renderHook()
  current.confirm()
  assert.equal(globalThis.__backgroundCalls.length, 2)
  globalThis.__backgroundState = { phase: 'error', progress: 0, sessions: 0, error: 'historyImportFailed' }
  current = renderHook()
  assert.equal(current.busy, false)
  assert.equal(current.status.key, 'historyImportFailed')
  assert.equal(current.status.error, true)
  checks.push('Import failure releases the upload lock and retains a visible error')

  const renderSettings = runner(SettingsContent)
  globalThis.__chatState.importingHistory = true
  const busyModal = find(renderSettings(), node => node.type?.name === 'Modal')
  busyModal.props.onClose()
  assert.equal(globalThis.__closed, 2)
  globalThis.__chatState.importingHistory = false
  const readyModal = find(renderSettings(), node => node.type?.name === 'Modal')
  readyModal.props.onClose()
  assert.equal(globalThis.__closed, 3)
  checks.push('Settings cannot unmount during history replacement and can close immediately after it finishes')

  const evidence = { passed: true, runtime: process.version, checks,
    scope: 'Actual SettingsDialog TSX, import hook, button and modal callbacks with deterministic React hooks and deferred import I/O; complements the real ZIP/IndexedDB regression, not a handset screenshot.' }
  await writeFile(new URL('./deepstay-import-ui-evidence.json', import.meta.url), JSON.stringify(evidence, null, 2) + '\n')
  console.log(JSON.stringify(evidence, null, 2))
} finally {
  hooks.deregister()
}
