import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { createRequire, registerHooks } from 'node:module'

const app = new URL('../', import.meta.url)
const source = new URL('src/components/chatInput/ChatInput.tsx', app)
const require = createRequire(new URL('package.json', app))
const { transformSync } = require(require.resolve('@rspack/binding', { paths: [require.resolve('@rspack/core')] }))
const mockUrl = value => 'data:text/javascript;base64,' + Buffer.from(value).toString('base64')
const mocks = new Map([
  ['react', 'export const memo=fn=>fn; export const useCallback=fn=>fn; export const useEffect=()=>{}; export const useLayoutEffect=()=>{}; export const useRef=value=>({current:value});'],
  ['react/jsx-runtime', 'export const jsx=(type,props,key)=>({type,props,key}); export const jsxs=jsx; export const Fragment=Symbol.for("react.fragment");'],
  ['../base/icons.js', ['IconGlobeLanguageOutline14', 'IconPaperclipOutline16', 'IconSendOutline16', 'IconStopFill16', 'IconThinkOutline14'].map(name => `export const ${name}=()=>null;`).join('')],
  ['../../services/settings.js', 'export const setSearch=()=>{}; export const setThinking=()=>{}; export const useSettings=Object.assign(select=>select(globalThis.__settings),{getState:()=>globalThis.__settings});'],
  ['../../services/api/connection.js', 'export const supportsDeepSeekExtras=connection=>connection.protocol==="deepseek";'],
  ['../../app/viewport.js', 'export const useIsMobile=()=>globalThis.__mobile;'],
  ['../../services/chat/store.js', 'export const sendMessage=()=>{globalThis.__sent++;return true}; export const compactSession=async id=>{globalThis.__compacted.push(id);return "saved"}; export const stopReply=()=>{}; export const useChatStore=Object.assign(select=>select(globalThis.__chat),{getState:()=>globalThis.__chat,subscribe:()=>()=>{}});'],
  ['../../utils/object.js', 'export const hasOwn=(object,key)=>Object.hasOwn(object,key);'],
  ['../../services/chat/drafts.js', 'export const EMPTY_DRAFT={text:"",attachments:[]}; export const useDrafts=select=>select({drafts:new Map([[null,globalThis.__draft]])}); export const getDraft=()=>globalThis.__draft; export const prepareDraftMessage=draft=>draft.text.trim()?{text:draft.text}:null; export const setDraftText=(_id,text)=>{globalThis.__draft.text=text}; export const retryDraftAttachment=(...args)=>globalThis.__retries.push(args); export const removeDraftAttachment=()=>{}; export const addDraftFiles=()=>null;'],
  ['../../services/speech/readAloud.js', 'export const stopReadAloud=()=>{};'],
  ['../base/IconButton.js', 'export const IconButton=()=>null;'],
  ['../base/Tooltip.js', 'export const Tooltip=()=>null;'],
  ['../settings/settingsDialogState.js', 'export const ensureApiKey=()=>true;'],
  ['./DragMask.js', 'export const DragMask=()=>null; export const useFileDrop=()=>false;'],
  ['../base/toastState.js', 'export const showToast=notice=>globalThis.__notices.push(notice);'],
  ['../../services/attachments.js', 'export const ACCEPT=""; export const useUploads=Object.assign(select=>select({tasks:{}}),{getState:()=>({tasks:{}})});'],
  ['./DraftAttachments.js', 'export const DraftAttachments=()=>null;'],
  ['./useVoiceInput.js', 'export const useVoiceInput=()=>({status:"idle",available:true,cancel:()=>{}});'],
  ['./VoiceButton.js', 'export const VoiceButton=()=>null;'],
  ['./Spectrum.js', 'export const Spectrum=()=>null;'],
  ['./ComposerMetrics.js', 'export const ComposerMetrics=()=>null;'],
  ['../../i18n/index.js', 'export const useTranslate=()=>key=>key;'],
  ['./ChatInput.module.css', 'export default {};'],
])
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL === source.href && mocks.has(specifier)) {
      return { url: mockUrl(mocks.get(specifier)), shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url === source.href) {
      return { format: 'module', source: transformSync(readFileSync(source, 'utf8') + '\nexport { Input };', JSON.stringify({
        jsc: { target: 'es2022', parser: { syntax: 'typescript', tsx: true }, transform: { react: { runtime: 'automatic' } } },
        module: { type: 'es6' },
      })).code, shortCircuit: true }
    }
    return nextLoad(url, context)
  },
})
const find = (node, predicate) => {
  if (!node || typeof node !== 'object') return null
  if (!Array.isArray(node) && predicate(node)) return node
  for (const child of Array.isArray(node) ? node : [node.props?.children]) {
    const match = find(child, predicate)
    if (match) return match
  }
  return null
}
try {
  const { Input } = await import(source)
  globalThis.__settings = { apiBaseUrl: 'https://api.deepseek.com', apiProtocol: 'deepseek', apiKey: 'fixture' }
  globalThis.__chat = { streaming: {}, importingHistory: false, contextProgress: {}, sessionCache: {} }
  globalThis.__draft = { text: 'hello', attachments: [] }
  globalThis.__sent = 0
  globalThis.__compacted = []
  globalThis.__retries = []
  globalThis.__notices = []
  const checks = []
  for (const mobile of [false, true]) {
    globalThis.__mobile = mobile
    let tree = Input({ sessionId: null })
    let prevented = false
    const textarea = find(tree, node => node.type === 'textarea')
    assert.equal(textarea.props.enterKeyHint, 'enter')
    textarea.props.onKeyDown?.({ key: 'Enter', shiftKey: false, nativeEvent: { isComposing: false }, preventDefault: () => { prevented = true } })
    textarea.props.onKeyDown?.({ key: 'Enter', shiftKey: false, nativeEvent: { isComposing: true }, preventDefault: () => { prevented = true } })
    assert.equal(prevented, false)
    assert.equal(globalThis.__sent, mobile ? 1 : 0)
    textarea.props.onChange({ target: { value: 'hello\nworld' } })
    tree = Input({ sessionId: null })
    assert.equal(find(tree, node => node.type === 'textarea').props.value, 'hello\nworld')
    const input = find(tree, node => node.type === 'textarea')
    const send = find(tree, node => node.type === 'button' && node.props['aria-label'] === 'send')
    input.props.ref.current = { focus() {}, blur() {} }
    globalThis.document = { activeElement: input.props.ref.current }
    send.props.onPointerDown({ preventDefault: () => { prevented = true } })
    assert.equal(prevented, mobile)
    send.props.onClick()
    assert.equal(globalThis.__sent, mobile ? 2 : 1)
    checks.push(`${mobile ? 'Mobile' : 'Web'} Enter keeps native newline behavior without submitting; multiline draft persists and the send button submits`)
  }
  globalThis.__settings.apiProtocol = 'openai'
  let tree = Input({ sessionId: null })
  find(tree, node => node.type?.name === 'DraftAttachments').props.onRetry('old-file')
  assert.equal(globalThis.__retries.length, 0)
  assert.deepEqual(globalThis.__notices.at(-1), { key: 'apiTextOnly' })
  globalThis.__settings.apiProtocol = 'deepseek'
  tree = Input({ sessionId: null })
  find(tree, node => node.type?.name === 'DraftAttachments').props.onRetry('old-file')
  assert.deepEqual(globalThis.__retries, [[null, 'old-file', 'fixture']])
  globalThis.__chat.importingHistory = true
  tree = Input({ sessionId: null })
  find(tree, node => node.type?.name === 'DraftAttachments').props.onRetry('old-file')
  assert.equal(globalThis.__retries.length, 1)
  checks.push('Existing attachment retry is blocked in text-only mode, allowed for DeepSeek and still blocked during history replacement')
  globalThis.__chat.importingHistory = false
  globalThis.__draft.text = ' /compact '
  tree = Input({ sessionId: 'current-chat' })
  find(tree, node => node.type === 'button' && node.props['aria-label'] === 'send').props.onClick()
  await Promise.resolve()
  assert.deepEqual(globalThis.__compacted, ['current-chat'])
  assert.equal(globalThis.__draft.text, '')
  assert.equal(globalThis.__sent, 2)
  assert.deepEqual(globalThis.__notices.at(-1), { key: 'contextMemorySaved' })
  checks.push('Sending /compact dispatches only local compaction for the selected session and clears the command draft')
  globalThis.__draft.text = 'Unsent draft'
  tree = Input({ sessionId: 'current-chat' })
  let metrics = find(tree, node => node.type?.name === 'ComposerMetrics')
  assert.equal(metrics.props.compactDisabled, false)
  metrics.props.onCompact({ type: 'click' })
  await Promise.resolve()
  assert.deepEqual(globalThis.__compacted, ['current-chat', 'current-chat'])
  assert.equal(globalThis.__draft.text, 'Unsent draft')
  assert.equal(globalThis.__sent, 2)
  globalThis.__chat.streaming['current-chat'] = {}
  globalThis.__chat.contextProgress['current-chat'] = { manual: true, completed: 2, total: 3 }
  tree = Input({ sessionId: 'current-chat' })
  metrics = find(tree, node => node.type?.name === 'ComposerMetrics')
  assert.equal(metrics.props.compactDisabled, true)
  assert.equal(metrics.props.progress, 'contextMemoryProgress')
  assert.equal(typeof metrics.props.onStop, 'function')
  metrics.props.onCompact()
  assert.equal(globalThis.__compacted.length, 2)
  checks.push('Context details share manual compaction, preserve the draft, and expose progress and stop while preventing duplicate starts')
  const evidence = { passed: true, runtime: process.version, checks, scope: 'Actual ChatInput TSX with mocked application services; verifies event handling and retry calls. Native textarea newline is left to browser.' }
  await writeFile(new URL('./deepstay-input-evidence.json', import.meta.url), JSON.stringify(evidence, null, 2) + '\n')
  console.log(JSON.stringify(evidence, null, 2))
} finally {
  hooks.deregister()
}
