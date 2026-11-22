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
  ['react', 'export const memo=fn=>fn; export const useCallback=fn=>fn; export const useEffect=()=>{}; export const useLayoutEffect=()=>{}; export const useMemo=fn=>fn(); export const useRef=value=>({current:value}); export const useState=value=>[globalThis.__inputState??value,update=>{globalThis.__inputState=typeof update==="function"?update(globalThis.__inputState):update}];'],
  ['react/jsx-runtime', 'export const jsx=(type,props,key)=>({type,props,key}); export const jsxs=jsx; export const Fragment=Symbol.for("react.fragment");'],
  ['../base/icons.js', ['IconGlobeLanguageOutline14', 'IconMicOutline16', 'IconPaperclipOutline16', 'IconPlusOutline16', 'IconSendOutline16', 'IconStopFill16', 'IconThinkOutline14'].map(name => `export const ${name}=()=>null;`).join('')],
  ['../../services/settings.js', 'export const applyModelPreset=id=>{globalThis.__appliedModelPreset=id}; export const setModel=model=>{globalThis.__settings.model=model}; export const setSearch=()=>{}; export const setThinking=()=>{}; export const useSettings=Object.assign(select=>select(globalThis.__settings),{getState:()=>globalThis.__settings});'],
  ['../../services/api/connection.js', 'export const supportsDeepSeekExtras=connection=>connection.protocol==="deepseek"&&connection.baseUrl.replace(/\\/(?:anthropic(?:\\/v1)?|v1)(?:\\/messages)?$/,"")==="https://api.deepseek.com";'],
  ['../../services/api/generation.js', 'export const DEFAULT_CONTEXT_WINDOW=1000000;'],
  ['../../services/chat/latestReminder.js', 'export const createLatestReminder=()=>"fixture reminder";'],
  ['./useContextPrediction.js', 'export const useContextPrediction=(options,paused)=>{globalThis.__estimated.push({...options,paused});return {estimate:paused?undefined:{system:5,tools:options.tools.length,messages:200},estimating:false}};'],
  ['../../services/characters.js', 'export const characterSystemPrompt=base=>base;'],
  ['../../app/viewport.js', 'export const useIsMobile=()=>globalThis.__mobile;'],
  ['../../services/chat/store.js', 'export const getEffectiveContextInputBudget=()=>globalThis.__settings.generation.contextTokens??1000000;export const SYSTEM_PROMPT="default system";export const serverTools=(search,model)=>model==="deepseek-v4-pro"?(search?[{type:"web_search_20250305",name:"web_search"}]:[]):search?["read","search"]:["read"];export const sendMessage=()=>{globalThis.__sent++;return true}; export const compactSession=async id=>{globalThis.__compacted.push(id);return "saved"}; export const stopReply=()=>{}; export const useChatStore=Object.assign(select=>select(globalThis.__chat),{getState:()=>globalThis.__chat,subscribe:()=>()=>{}});'],
  ['../../utils/object.js', 'export const hasOwn=(object,key)=>Object.hasOwn(object,key);'],
  ['../../services/chat/drafts.js', 'export const EMPTY_DRAFT={text:"",attachments:[]}; export const useDrafts=select=>select({drafts:{get:()=>globalThis.__draft}}); export const getDraft=()=>globalThis.__draft; export const prepareDraftMessage=draft=>draft.text.trim()?{text:draft.text}:null; export const setDraftText=(_id,text)=>{globalThis.__draft.text=text}; export const retryDraftAttachment=(...args)=>globalThis.__retries.push(args); export const removeDraftAttachment=()=>{}; export const addDraftFiles=(...args)=>{globalThis.__fileBatches.push(args);return null};'],
  ['../../services/speech/readAloud.js', 'export const stopReadAloud=()=>{};'],
  ['../base/IconButton.js', 'export const IconButton=()=>null;'],
  ['../base/Menu.js', 'export const Menu=props=>props.children?.({toggle:()=>{}})??null;'],
  ['../base/Button.js', 'export const Button=()=>null;'],
  ['../base/Modal.js', 'export const Modal=()=>null;'],
  ['../base/Select.js', 'export const Select=()=>null;'],
  ['../base/Tooltip.js', 'export const Tooltip=()=>null;'],
  ['../settings/settingsDialogState.js', 'export const ensureApiKey=()=>true;'],
  ['./DragMask.js', 'export const DragMask=()=>null; export const useFileDrop=()=>false;'],
  ['../base/toastState.js', 'export const showToast=notice=>globalThis.__notices.push(notice);'],
  ['../../services/attachments.js', 'export const ACCEPT=""; export const useUploads=Object.assign(select=>select({tasks:{}}),{getState:()=>({tasks:{}})}); export const validateFiles=(files,count)=>{globalThis.__validated.push({files,count});return globalThis.__validationError}; export const resolveMimeType=file=>file.type; export const isImage=mime=>mime.startsWith("image/"); export const getUploadPurpose=(name,image)=>image?null:/\\.(pdf|doc|docx|ppt|pptx)$/i.test(name)?"text_recognition":"user_data";'],
  ['./DraftAttachments.js', 'export const DraftAttachments=()=>null;'],
  ['./useVoiceInput.js', 'export const useVoiceInput=()=>({status:"idle",available:true,cancel:()=>{},toggle:()=>{globalThis.__voiceInputToggled++}});'],
  ['./VoiceButton.js', 'export const VoiceButton=()=>null;'],
  ['./Spectrum.js', 'export const Spectrum=()=>null;'],
  ['./ComposerMetrics.js', 'export const ComposerMetrics=()=>null;'],
  ['../../services/speech/voiceCall.js', 'export const startVoiceCall=(...args)=>{globalThis.__voiceCall.push(args)};'],
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
const hasMenuOption = (tree, key) => find(tree, node => node.type?.name === 'Menu')?.props.options.some(option => option.key === key) ?? false
try {
  const { Input } = await import(source)
  globalThis.__settings = { apiBaseUrl: 'https://api.deepseek.com', apiProtocol: 'deepseek', apiKey: 'fixture', model: 'deepseek-flash', models: ['deepseek-flash', 'deepseek-v4-pro'], modelPresets: [], generation: {} }
  globalThis.__chat = { streaming: {}, importingHistory: false, contextProgress: {}, sessionCache: {} }
  globalThis.__draft = { text: 'hello', attachments: [] }
  globalThis.__sent = 0
  globalThis.__compacted = []
  globalThis.__retries = []
  globalThis.__notices = []
  globalThis.__estimated = []
  globalThis.__fileBatches = []
  globalThis.__inputState = null
  globalThis.__voiceCall = []
  globalThis.__voiceInputToggled = 0
  globalThis.__validated = []
  globalThis.__validationError = null
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
  assert.deepEqual(globalThis.__retries, [[null, 'old-file', 'fixture']], 'Custom-provider attachment retries use their local parser')
  globalThis.__settings.apiProtocol = 'deepseek'
  tree = Input({ sessionId: null })
  find(tree, node => node.type?.name === 'DraftAttachments').props.onRetry('old-file')
  assert.deepEqual(globalThis.__retries, [[null, 'old-file', 'fixture'], [null, 'old-file', 'fixture']])
  globalThis.__chat.importingHistory = true
  tree = Input({ sessionId: null })
  find(tree, node => node.type?.name === 'DraftAttachments').props.onRetry('old-file')
  assert.equal(globalThis.__retries.length, 2)
  checks.push('Existing attachment retries use local parsing on third-party routes or DeepSeek upload on official routes, and remain blocked during history replacement')
  globalThis.__chat.importingHistory = false
  tree = Input({ sessionId: 'current-chat' })
  const picker = find(tree, node => node.type === 'input' && node.props.type === 'file')
  assert.equal(picker.props.multiple, true)
  const files = [new File(['one'], 'first.txt'), new File(['two'], 'second.txt')]
  const fileTarget = { files, value: 'chosen-files' }
  picker.props.onChange({ target: fileTarget })
  assert.deepEqual(globalThis.__fileBatches.at(-1), ['current-chat', files, 'fixture'], 'All selected files reach the existing batch upload queue')
  assert.equal(fileTarget.value, '', 'Selecting the same files again remains possible')
  const documents = [new File(['doc'], 'menu.docx'), new File(['notes'], 'notes.txt')]
  const batchesBeforeConfirmation = globalThis.__fileBatches.length
  picker.props.onChange({ target: { files: documents, value: 'documents' } })
  assert.equal(globalThis.__fileBatches.length, batchesBeforeConfirmation, 'Paid document parsing must not start before confirmation')
  tree = Input({ sessionId: 'current-chat' })
  let uploadDialog = find(tree, node => node.type?.name === 'Modal')
  assert.ok(uploadDialog)
  assert.equal(find(uploadDialog, node => node.type?.name === 'Select').props.value, 'text_recognition')
  uploadDialog.props.onClose()
  tree = Input({ sessionId: 'current-chat' })
  assert.equal(find(tree, node => node.type?.name === 'Modal'), null)
  assert.equal(globalThis.__fileBatches.length, batchesBeforeConfirmation, 'Cancelling a document upload leaves the upload service untouched')
  find(tree, node => node.type === 'input' && node.props.type === 'file').props.onChange({ target: { files: documents, value: '' } })
  tree = Input({ sessionId: 'current-chat' })
  uploadDialog = find(tree, node => node.type?.name === 'Modal')
  const confirmDocumentUpload = find(uploadDialog.props.footer, node => node.type?.name === 'Button' && node.props.children === 'documentUploadConfirm').props.onClick
  confirmDocumentUpload()
  const batchesAfterConfirmation = globalThis.__fileBatches.length
  confirmDocumentUpload()
  assert.equal(globalThis.__fileBatches.length, batchesAfterConfirmation, 'A rapid double tap must not start a second paid upload')
  assert.deepEqual(globalThis.__fileBatches.at(-1), ['current-chat', documents, 'fixture', 'text_recognition'], 'Confirmation preserves the complete mixed batch and defaults to text-only document parsing')
  tree = Input({ sessionId: 'current-chat' })
  find(tree, node => node.type === 'input' && node.props.type === 'file').props.onChange({ target: { files: documents, value: '' } })
  tree = Input({ sessionId: 'current-chat' })
  uploadDialog = find(tree, node => node.type?.name === 'Modal')
  find(uploadDialog, node => node.type?.name === 'Select').props.onChange('rich_layout_recognition')
  tree = Input({ sessionId: 'current-chat' })
  uploadDialog = find(tree, node => node.type?.name === 'Modal')
  find(uploadDialog.props.footer, node => node.type?.name === 'Button' && node.props.children === 'documentUploadConfirm').props.onClick()
  assert.deepEqual(globalThis.__fileBatches.at(-1), ['current-chat', documents, 'fixture', 'rich_layout_recognition'], 'Image and chart parsing requires an explicit choice')
  globalThis.__validationError = { key: 'uploadMaxFiles', params: { count: 50 } }
  const batchesBeforeInvalid = globalThis.__fileBatches.length
  tree = Input({ sessionId: 'current-chat' })
  find(tree, node => node.type === 'input' && node.props.type === 'file').props.onChange({ target: { files: documents, value: '' } })
  tree = Input({ sessionId: 'current-chat' })
  assert.equal(find(tree, node => node.type?.name === 'Modal'), null, 'Invalid batches are rejected before showing a paid upload confirmation')
  assert.equal(globalThis.__fileBatches.length, batchesBeforeInvalid)
  assert.deepEqual(globalThis.__notices.at(-1), globalThis.__validationError)
  globalThis.__validationError = null
  const imageFiles = [new File(['image'], 'photo.jpg', { type: 'image/jpeg' })]
  find(tree, node => node.type === 'input' && node.props.type === 'file').props.onChange({ target: { files: imageFiles, value: '' } })
  assert.deepEqual(globalThis.__fileBatches.at(-1), ['current-chat', imageFiles, 'fixture'], 'Image-only selection keeps the existing immediate upload flow')
  tree = Input({ sessionId: 'current-chat' })
  checks.push('Office/PDF uploads wait for explicit confirmation, cancel without uploading, default to text parsing, preserve mixed batches, allow opt-in layout parsing, and reject invalid batches first')
  const modelPicker = find(tree, node => node.type?.name === 'Select' && node.props.ariaLabel === 'apiModel')
  assert.deepEqual(modelPicker.props.options.map(item => item.value), ['deepseek-flash', 'deepseek-v4-pro'])
  const connection = { url: globalThis.__settings.apiBaseUrl, protocol: globalThis.__settings.apiProtocol, key: globalThis.__settings.apiKey }
  globalThis.__chat.streaming['current-chat'] = { model: 'deepseek-flash' }
  modelPicker.props.onChange('deepseek-v4-pro')
  assert.equal(globalThis.__settings.model, 'deepseek-v4-pro')
  assert.equal(globalThis.__chat.streaming['current-chat'].model, 'deepseek-flash', 'A quick switch does not mutate the in-flight request')
  assert.deepEqual({ url: globalThis.__settings.apiBaseUrl, protocol: globalThis.__settings.apiProtocol, key: globalThis.__settings.apiKey }, connection)
  delete globalThis.__chat.streaming['current-chat']
  globalThis.__settings.model = 'deepseek-flash'
  checks.push('Quick model switching uses configured models without changing the service or active request, and file picking forwards the complete batch')
  globalThis.__settings.modelPresets = [{ id: 'quick-profile', name: '中转站', apiKey: 'fixture', apiBaseUrl: 'https://api.deepseek.com', apiProtocol: 'deepseek', model: 'deepseek-flash', models: ['deepseek-flash'] }]
  tree = Input({ sessionId: 'current-chat' })
  const presetPicker = find(tree, node => node.type?.name === 'Select' && node.props.ariaLabel === 'modelPresetSelect')
  assert.equal(presetPicker.props.value, 'quick-profile')
  assert.deepEqual(presetPicker.props.options, [{ value: 'quick-profile', label: '中转站' }])
  presetPicker.props.onChange('quick-profile')
  assert.equal(globalThis.__appliedModelPreset, 'quick-profile')
  globalThis.__settings.modelPresets = []
  checks.push('A saved named connection preset appears in the composer and selecting it applies that profile immediately')
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
  globalThis.__chat.sessionCache['imported-chat'] = { messages: [{ role: 'user', content: 'Imported history' }], contextMemory: { fixed: 'Session facts' } }
  globalThis.__settings.generation.system = 'Custom system'
  globalThis.__settings.search = true
  tree = Input({ sessionId: 'imported-chat' })
  metrics = find(tree, node => node.type?.name === 'ComposerMetrics')
  assert.equal(metrics.props.estimatedContext.messages, 200)
  assert.equal(globalThis.__estimated.at(-1).system, 'Custom system')
  assert.equal(globalThis.__estimated.at(-1).session.contextMemory.fixed, 'Session facts', 'Fixed memory is handed to the checkpoint-aware prediction service')
  assert.equal(globalThis.__estimated.at(-1).text, 'Unsent draft')
  assert.deepEqual(globalThis.__estimated.at(-1).tools, ['read', 'search'])
  const estimatesBefore = globalThis.__estimated.length
  tree = Input({ sessionId: 'imported-chat', latestReply: { metrics: { system: 1, tools: 0, messages: 10 } } })
  assert.equal(globalThis.__estimated.length, estimatesBefore + 1, 'Old request metrics cannot suppress a new prediction')
  assert.equal(find(tree, node => node.type?.name === 'ComposerMetrics').props.estimatedContext.messages, 200)
  assert.equal(globalThis.__estimated.at(-1).inputBudget, 1_000_000)
  globalThis.__chat.streaming['imported-chat'] = {}
  tree = Input({ sessionId: 'imported-chat' })
  assert.equal(globalThis.__estimated.at(-1).paused, true, 'Streaming pauses local prediction work')
  assert.equal(find(tree, node => node.type?.name === 'ComposerMetrics').props.estimatedContext, undefined)
  delete globalThis.__chat.streaming['imported-chat']
  globalThis.__settings.model = 'deepseek-v4-pro'
  tree = Input({ sessionId: 'imported-chat' })
  assert.ok(find(tree, node => node.type === 'button' && node.props['aria-label'] === 'search'))
  assert.ok(find(tree, node => node.type?.name === 'VoiceButton'), 'Unsupported server tools do not disable unrelated attachment and voice capabilities')
  assert.ok(hasMenuOption(tree, 'upload'), 'The attachment menu keeps its upload action')
  assert.ok(hasMenuOption(tree, 'voice-call'), 'The attachment menu exposes voice calling')
  find(tree, node => node.type?.name === 'Menu').props.options.find(option => option.key === 'voice-call').onSelect()
  assert.deepEqual(globalThis.__voiceCall, [['imported-chat']], 'Voice call starts in the current chat')
  assert.deepEqual(globalThis.__estimated.at(-1).tools, [{ type: 'web_search_20250305', name: 'web_search' }])
  globalThis.__settings.model = 'deepseek-v4-flash'
  globalThis.__settings.apiBaseUrl = 'https://api.deepseek.com/anthropic/v1/messages'
  tree = Input({ sessionId: 'imported-chat' })
  assert.ok(find(tree, node => node.type === 'button' && node.props['aria-label'] === 'search'), 'The official full Messages URL keeps search available')
  assert.ok(find(tree, node => node.type?.name === 'VoiceButton'), 'The official full Messages URL keeps voice input available')
  assert.ok(hasMenuOption(tree, 'upload'), 'The official full Messages URL keeps file uploads available')
  assert.deepEqual(globalThis.__estimated.at(-1).tools, ['read', 'search'])
  globalThis.__settings.apiProtocol = 'openai'
  globalThis.__settings.apiBaseUrl = 'https://relay.example.test/v1'
  tree = Input({ sessionId: 'imported-chat' })
  assert.ok(hasMenuOption(tree, 'upload'), 'Third-party routes expose the local attachment path')
  const customVoiceButton = find(tree, node => node.type?.name === 'VoiceButton')
  assert.ok(customVoiceButton, 'OpenAI-compatible routes expose their own ASR path')
  customVoiceButton.props.onClick()
  assert.equal(globalThis.__voiceInputToggled, 1, 'Custom-provider voice input stays connected to the selected route')
  globalThis.__settings.apiKey = null
  tree = Input({ sessionId: 'imported-chat' })
  assert.ok(find(tree, node => node.type?.name === 'VoiceButton'), 'Voice input remains visible before an API key is configured')
  globalThis.__settings.apiKey = 'fixture'
  const beforeLocalDocument = globalThis.__fileBatches.length
  const customInput = find(tree, node => node.type === 'input' && node.props.type === 'file')
  customInput.props.onChange({ target: { files: [new File(['fixture'], 'notes.pdf', { type: 'application/pdf' })], value: 'selected' } })
  assert.equal(globalThis.__fileBatches.length, beforeLocalDocument + 1, 'Third-party PDF is handed to local attachment parsing without the paid DeepSeek confirmation dialog')
  assert.equal(find(tree, node => node.type?.name === 'Modal'), null)
  checks.push('Search prediction and entry points use the model-specific V4 schemas; official routes expose supported search, upload and voice, while custom routes expose local PDF/image attachments and never call the private DeepSeek ASR endpoint')
  const evidence = { passed: true, runtime: process.version, checks, scope: 'Actual ChatInput TSX with mocked application services; verifies event handling and retry calls. Native textarea newline is left to browser.' }
  await writeFile(new URL('./deepstay-input-evidence.json', import.meta.url), JSON.stringify(evidence, null, 2) + '\n')
  console.log(JSON.stringify(evidence, null, 2))
} finally {
  hooks.deregister()
}
