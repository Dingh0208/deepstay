import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire, registerHooks, stripTypeScriptTypes } from 'node:module'

const app = new URL('../', import.meta.url)
const source = new URL('src/components/characters/CharactersDialog.tsx', app)
const cards = new URL('src/services/characterCards.ts', app)
const require = createRequire(new URL('package.json', app))
const { transformSync } = require(require.resolve('@rspack/binding', { paths: [require.resolve('@rspack/core')] }))
const mockUrl = text => 'data:text/javascript;base64,' + Buffer.from(text).toString('base64')
const mocks = new Map([
  ['react', 'export const useState=(...args)=>globalThis.__hooks.useState(...args); export const useRef=(...args)=>globalThis.__hooks.useRef(...args); export const useEffect=()=>{};'],
  ['react/jsx-runtime', 'export const Fragment=Symbol.for("fragment"); export const jsx=(type,props,key)=>({type,props,key}); export const jsxs=jsx;'],
  ['@capacitor/core', 'export const Capacitor={getPlatform:()=>globalThis.__platform}; export const registerPlugin=name=>{if(name!=="LocalFiles")throw Error("Unexpected plugin"); return {save:(...args)=>globalThis.__nativeSave(...args)}};'],
  ['../../i18n/index.js', 'export const useTranslate=()=>key=>key;'],
  ['../../services/characters.js', 'export const useCharacters=()=>globalThis.__characters; export const characterLimits={name:100,prompt:20000,greeting:10000,greetings:100}; export const characterGreetings=p=>[p.greeting,...(p.alternateGreetings??[])]; export const loadCharacters=async()=>{}; export const saveCharacter=(...args)=>globalThis.__saveCharacter(...args); export const deleteCharacter=async()=>{};'],
  ['../../services/chat/store.js', 'export const useChatStore=selector=>selector({ready:true,importingHistory:false}); export const startCharacterChat=(...args)=>{globalThis.__starts.push(args);return true};'],
  ['../base/Button.js', 'export const Button=()=>null;'],
  ['../base/Modal.js', 'export const Modal=()=>null;'],
  ['../base/Select.js', 'export const Select=()=>null;'],
  ['../settings/settingsDialogState.js', 'export const closeSettings=()=>{};'],
  ['../sider/mobileSiderState.js', 'export const closeMobileSider=()=>{};'],
  ['./characterDialogState.js', 'export const closeCharacters=()=>{globalThis.__closed++}; export const useCharacterDialog=selector=>selector({open:true});'],
  ['./CharactersDialog.module.css', 'export default {main:"character-scrollable-main"};'],
])
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL === source.href && mocks.has(specifier)) return { url: mockUrl(mocks.get(specifier)), shortCircuit: true }
    if (context.parentURL === source.href && specifier === '../../services/characterCards.js') return { url: cards.href, shortCircuit: true }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url === source.href) return {
      format: 'module', source: transformSync(readFileSync(source, 'utf8') + '\nexport { CharactersContent };', JSON.stringify({ jsc: {
        target: 'es2022', parser: { syntax: 'typescript', tsx: true }, transform: { react: { runtime: 'automatic' } },
      }, module: { type: 'es6' } })).code, shortCircuit: true,
    }
    if (url === cards.href) return {
      format: 'module', source: stripTypeScriptTypes(readFileSync(cards, 'utf8'), { mode: 'transform' }), shortCircuit: true,
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
  return () => { cursor = 0; globalThis.__hooks = state; return component() }
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
const button = (tree, key) => find(tree, node => node.type?.name === 'Button' && node.props.children === key)
const wait = async predicate => {
  const deadline = Date.now() + 5000
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error('Character UI regression timed out')
    await new Promise(resolve => setImmediate(resolve))
  }
}
const nativeCalls = []
const downloads = []
const blobs = new Map()
const originalCreate = URL.createObjectURL
const originalRevoke = URL.revokeObjectURL
globalThis.__platform = 'android'
globalThis.__closed = 0
globalThis.__starts = []
globalThis.__characters = { ready: true, error: false, presets: [{
  id: 'character-1', name: '阿澜🌊', prompt: '温柔的海边画家，记得我们约好去看海。', greeting: '茶已经泡好，欢迎回来。', updatedAt: 123,
}] }
let resolveSave, rejectSave
globalThis.__nativeSave = options => {
  nativeCalls.push(options)
  return new Promise((resolve, reject) => { resolveSave = resolve; rejectSave = reject })
}
globalThis.FileReader = class {
  readAsDataURL(blob) {
    blob.arrayBuffer().then(buffer => {
      this.result = `data:${blob.type};base64,${Buffer.from(buffer).toString('base64')}`
      this.onload()
    }, error => { this.error = error; this.onerror() })
  }
}
globalThis.document = { createElement: tag => {
  assert.equal(tag, 'a')
  const link = { click() { downloads.push({ href: this.href, name: this.download }) } }
  return link
} }
URL.createObjectURL = blob => {
  const url = `blob:character-ui-${blobs.size}`
  blobs.set(url, blob)
  return url
}
URL.revokeObjectURL = () => {}
const saved = []
globalThis.__saveCharacter = async value => { saved.push(value); return value }
globalThis.fetch = async () => { throw new Error('Character UI tests must not access the network') }
const checks = []
try {
  const { CharactersContent } = await import(source)
  const { exportCharacterCard } = await import(cards)
  const render = runner(CharactersContent)
  let tree = render()
  const exportClick = button(tree, 'characterExport').props.onClick
  exportClick()
  exportClick()
  await wait(() => nativeCalls.length === 1)
  tree = render()
  assert.equal(button(tree, 'characterExport').props.disabled, true)
  find(tree, node => node.type?.name === 'Modal').props.onClose()
  assert.equal(globalThis.__closed, 0, 'An active native file picker must keep the dialog alive')
  assert.equal(nativeCalls[0].name, 'deepstay-character.json')
  assert.equal(nativeCalls[0].mimeType, 'application/json')
  assert.equal(Buffer.from(nativeCalls[0].data, 'base64').toString('utf8'), exportCharacterCard(globalThis.__characters.presets[0]))
  assert.equal(downloads.length, 0)
  resolveSave({ cancelled: true })
  await wait(() => !button(render(), 'characterExport').props.disabled)
  assert.equal(find(render(), node => node.props?.role === 'alert'), null)
  assert.equal(nativeCalls.length, 1)
  checks.push('Android export calls LocalFiles.save with JSON MIME and exact UTF-8 Chinese/emoji content; duplicate clicks are locked and picker cancellation is silent')

  button(render(), 'characterExport').props.onClick()
  await wait(() => nativeCalls.length === 2)
  rejectSave(new Error('Injected native save failure'))
  await wait(() => !button(render(), 'characterExport').props.disabled)
  assert.equal(find(render(), node => node.props?.role === 'alert').props.children, 'characterExportFailed')
  button(render(), 'characterExport').props.onClick()
  await wait(() => nativeCalls.length === 3)
  resolveSave({ cancelled: false })
  await wait(() => !button(render(), 'characterExport').props.disabled)
  assert.equal(find(render(), node => node.props?.role === 'alert'), null)
  checks.push('Native rejection displays export failure, releases the lock and permits a successful retry')

  globalThis.__platform = 'web'
  button(render(), 'characterExport').props.onClick()
  await wait(() => downloads.length === 1)
  assert.equal(downloads[0].name, 'deepstay-character.json')
  assert.equal(await blobs.get(downloads[0].href).text(), exportCharacterCard(globalThis.__characters.presets[0]))
  assert.equal(nativeCalls.length, 3)
  checks.push('Web export retains the blob download path with the same portable JSON')

  const before = structuredClone(globalThis.__characters.presets)
  const importInput = find(render(), node => node.type === 'input' && node.props.type === 'file')
  const target = { files: [new File([JSON.stringify({ name: '新角色', description: '认真倾听{{user}}。', first_mes: '', alternate_greetings: ['第二个开场', '第三个开场'] })], 'character.json')], value: 'fixture' }
  importInput.props.onChange({ target })
  await wait(() => Boolean(find(render(), node => node.type === 'form')))
  tree = render()
  assert.equal(find(tree, node => node.type === 'input').props.value, '新角色')
  assert.ok(find(tree, node => node.type === 'p' && node.props.children === 'characterImportTextOnly'))
  assert.equal(target.value, '')
  assert.deepEqual(saved, [])
  button(tree, 'cancel').props.onClick()
  assert.equal(find(render(), node => node.type === 'form'), null)
  assert.deepEqual(saved, [])
  assert.deepEqual(globalThis.__characters.presets, before)
  find(render(), node => node.type === 'input' && node.props.type === 'file').props.onChange({ target: { files: [new File(['bad json'], 'bad.json')], value: 'fixture' } })
  await wait(() => Boolean(find(render(), node => node.props?.role === 'alert')))
  assert.equal(find(render(), node => node.props?.role === 'alert').props.children, 'characterImportFailed')
  assert.deepEqual(saved, [])
  assert.deepEqual(globalThis.__characters.presets, before)
  checks.push('Actual character parsing produces an editable text-only preview; cancel or malformed import never writes or replaces the library')

  find(render(), node => node.type === 'input' && node.props.type === 'file').props.onChange({ target })
  await wait(() => Boolean(find(render(), node => node.type === 'form')))
  let preview = render()
  assert.equal(find(preview, node => node.type === 'textarea' && node.props.value === '第二个开场').props.maxLength, 10000)
  find(preview, node => node.type === 'textarea' && node.props.value === '第二个开场').props.onChange({ target: { value: '编辑后的第二开场' } })
  button(render(), 'characterAddGreeting').props.onClick()
  find(render(), node => node.type === 'form').props.onSubmit({ preventDefault() {} })
  await wait(() => !find(render(), node => node.type === 'form'))
  assert.deepEqual(saved[0].alternateGreetings, ['编辑后的第二开场', '第三个开场', ''])
  assert.equal(saved[0].greeting, '')
  checks.push('Imported alternates remain editable and adding a blank candidate preserves its position on save')

  globalThis.__characters.presets = [{ ...before[0], greeting: '', alternateGreetings: ['所选开场', '不要自动选择此项'] }]
  button(render(), 'characterStartChat').props.onClick()
  tree = render()
  assert.deepEqual(globalThis.__starts, [])
  let selection = find(tree, node => node.type?.name === 'Select')
  assert.equal(find(tree, node => node.type?.name === 'Modal' && node.props.title === 'characterChooseGreeting').props.mainClassName,
    'character-scrollable-main', 'Greeting preview must scroll within the modal so its footer remains reachable on short screens')
  assert.deepEqual(selection.props.options.map(option => option.value), ['0', '1', '2'])
  assert.equal(find(tree, node => node.type === 'textarea' && node.props.readOnly).props.value, '')
  selection.props.onChange('1')
  tree = render()
  assert.equal(find(tree, node => node.type === 'textarea' && node.props.readOnly).props.value, '所选开场')
  find(tree, node => node.type?.name === 'Modal' && node.props.title === 'characterChooseGreeting').props.onClose()
  assert.deepEqual(globalThis.__starts, [])
  button(render(), 'characterStartChat').props.onClick()
  selection = find(render(), node => node.type?.name === 'Select')
  selection.props.onChange('2')
  tree = render()
  const chooseModal = find(tree, node => node.type?.name === 'Modal' && node.props.title === 'characterChooseGreeting')
  button(chooseModal.props.footer, 'characterStartChat').props.onClick()
  assert.equal(globalThis.__starts.length, 1)
  assert.equal(globalThis.__starts[0][1], 2)
  assert.equal(globalThis.__closed, 1)
  checks.push('Multiple greetings require an explicit preview/selection before starting; cancelling creates no chat and confirmation passes exactly the selected index')
  console.log(JSON.stringify({ passed: true, checks, scope: 'Actual character dialog callbacks with controlled React hooks and native save I/O; real card serialization, no network or device writes.' }, null, 2))
} finally {
  URL.createObjectURL = originalCreate
  URL.revokeObjectURL = originalRevoke
  hooks.deregister()
}
