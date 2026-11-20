import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire, registerHooks, stripTypeScriptTypes } from 'node:module'
import { fileURLToPath } from 'node:url'
import 'fake-indexeddb/auto'

const sourceRoot = new URL('../src/', import.meta.url)
const messageFileSource = new URL('components/messages/MessageFile.tsx', sourceRoot)
const userMessageSource = new URL('components/messages/UserMessage.tsx', sourceRoot)
const require = createRequire(new URL('../package.json', import.meta.url))
const { transformSync } = require(require.resolve('@rspack/binding', { paths: [require.resolve('@rspack/core')] }))
const mockUrl = value => 'data:text/javascript;base64,' + Buffer.from(value).toString('base64')
const mocks = new Map([
  ['react', 'export const memo=fn=>fn; export const useEffect=()=>{}; export const useLayoutEffect=()=>{}; export const useState=value=>[value,()=>{}]; export const useRef=value=>({current:value});'],
  ['react/jsx-runtime', 'export const jsx=(type,props,key)=>({type,props,key}); export const jsxs=jsx; export const Fragment=Symbol.for("react.fragment");'],
  ['../../i18n/index.js', 'export const useTranslate=()=>key=>key;'],
  ['../../services/attachments.js', 'export const useUploads=select=>select({tasks:{}});'],
  ['../../services/chat/db.js', 'export const loadFile=async()=>undefined;'],
  ['../../services/chat/store.js', 'export const editMessage=()=>false; export const retryUpload=()=>{}; export const setFileContextExcluded=(...args)=>globalThis.__toggleFileContext(...args);'],
  ['../../services/speech/readAloud.js', 'export const stopReadAloud=()=>{};'],
  ['../../app/viewport.js', 'export const useIsMobile=()=>false;'],
  ['../base/icons.js', ['IconPhotoErrorFill20', 'IconRefreshOutline16', 'IconEditOutline16', 'IconListCheckOutline16', 'IconTrashOutline16'].map(name => `export const ${name}=()=>null;`).join('')],
  ['../base/Modal.js', 'export const Modal=()=>null;'],
  ['../base/Tooltip.js', 'export const Tooltip=()=>null;'],
  ['../base/Button.js', 'export const Button=()=>null;'],
  ['../base/IconButton.js', 'export const IconButton=()=>null;'],
  ['../files/FileCard.js', 'export const FileCard=()=>null;'],
  ['../settings/settingsDialogState.js', 'export const ensureApiKey=()=>true;'],
  ['./BranchSwitcher.js', 'export const BranchSwitcher=()=>null;'],
  ['./MessageActions.js', 'export const MessageActions=()=>null;'],
  ['./CopyButton.js', 'export const CopyButton=()=>null;'],
  ['./MessageFile.js', 'export const MessageFile=()=>null;'],
  ['./MessageFile.module.css', 'export default {};'],
  ['./UserMessage.module.css', 'export default {};'],
])
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if ([messageFileSource.href, userMessageSource.href].includes(context.parentURL) && mocks.has(specifier)) {
      return { url: mockUrl(mocks.get(specifier)), shortCircuit: true }
    }
    if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL?.startsWith(sourceRoot.href)) {
      const candidate = new URL(specifier.slice(0, -3) + '.ts', context.parentURL)
      if (existsSync(fileURLToPath(candidate))) return { url: candidate.href, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if ([messageFileSource.href, userMessageSource.href].includes(url)) {
      return { format: 'module', source: transformSync(readFileSync(new URL(url), 'utf8'), JSON.stringify({
        jsc: { target: 'es2022', parser: { syntax: 'typescript', tsx: true }, transform: { react: { runtime: 'automatic' } } },
        module: { type: 'es6' },
      })).code, shortCircuit: true }
    }
    if (url.startsWith(sourceRoot.href) && url.endsWith('.ts')) {
      return { format: 'module', source: stripTypeScriptTypes(readFileSync(new URL(url), 'utf8'), { mode: 'transform' }), shortCircuit: true }
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
globalThis.__API_ORIGIN__ = 'https://api.deepseek.com'
const saved = new Map()
globalThis.localStorage = {
  getItem: key => saved.get(key) ?? null,
  setItem: (key, value) => saved.set(key, value),
  removeItem: key => saved.delete(key),
}
let requested = 0
globalThis.fetch = async () => { requested++; throw new Error('Expected local-only operations') }

try {
  const db = await import(new URL('services/chat/db.ts', sourceRoot))
  const store = await import(new URL('services/chat/store.ts', sourceRoot))
  const now = Date.now()
  const file = { id: 'food-library', serverId: 'remote-food', name: 'food.txt', size: 16, isImage: false, mimeType: 'text/plain' }
  const original = new Blob(['original recipes'], { type: file.mimeType })
  await db.saveFiles([{ id: file.id, blob: original }])
  const user = (id, files) => ({ id, role: 'user', content: id, files, createdAt: now })
  const session = {
    id: 'file-context-chat', title: 'Attachment context', createdAt: now, updatedAt: now,
    messages: [user('first', [file]), user('alternative', [{ ...file }]), user('image', [{ ...file, isImage: true }])],
    contextMemory: { fixed: 'Keep the relationship setting' },
  }
  const otherSession = { ...session, id: 'other-chat', messages: [user('unrelated', [{ ...file }])] }
  await db.saveSession(session)
  await db.saveSession(otherSession)
  await store.initChat()
  await store.openHistoryMatch(session.id, null)
  assert.equal(await store.setFileContextExcluded(session.id, file.id, true), true)
  let persisted = await db.loadSession(session.id)
  assert.deepEqual(persisted.messages.map(message => message.files[0].contextExcluded), [true, true, undefined])
  assert.deepEqual(persisted.contextMemory, session.contextMemory)
  assert.equal((await db.loadSession(otherSession.id)).messages[0].files[0].contextExcluded, undefined)
  assert.equal(await (await db.loadFile(file.id)).text(), await original.text())
  const cached = store.useChatStore.getState().sessionCache[session.id]
  assert.equal(await store.setFileContextExcluded(session.id, file.id, true), false)
  assert.equal(store.useChatStore.getState().sessionCache[session.id], cached, 'No-op toggles do not replace the session')
  assert.equal(await store.setFileContextExcluded(session.id, 'unknown', true), false)
  store.useChatStore.setState({ importingHistory: true })
  assert.equal(await store.setFileContextExcluded(session.id, file.id, false), false)
  store.useChatStore.setState({ importingHistory: false, streaming: { [session.id]: new AbortController() } })
  assert.equal(await store.setFileContextExcluded(session.id, file.id, false), false)
  store.useChatStore.setState({ streaming: {} })
  assert.equal(await store.setFileContextExcluded('missing-chat', file.id, true), false)
  assert.equal(await store.setFileContextExcluded(session.id, file.id, false), true)
  persisted = await db.loadSession(session.id)
  assert.deepEqual(persisted.messages.map(message => message.files[0].contextExcluded), [false, false, undefined])

  const { MessageFile } = await import(messageFileSource)
  let clicked = 0
  let tree = MessageFile({ file, onRetry: null, onToggleContext: () => clicked++ })
  let toggle = find(tree, node => node.type === 'button')
  assert.equal(toggle.props.children, 'filePauseContext')
  assert.equal(toggle.props.disabled, false)
  toggle.props.onClick()
  assert.equal(clicked, 1)
  tree = MessageFile({ file: { ...file, contextExcluded: true }, onRetry: null, onToggleContext: () => clicked++, busy: true })
  toggle = find(tree, node => node.type === 'button')
  assert.equal(toggle.props.children, 'fileResumeContext')
  assert.equal(toggle.props.disabled, true)
  assert.ok(find(tree, node => node.type === 'span' && node.props.children === 'fileContextPaused'))
  tree = MessageFile({ file: { ...file, isImage: true }, onRetry: null, onToggleContext: () => clicked++ })
  assert.equal(find(tree, node => node.type === 'button' && node.props.children === 'filePauseContext'), null)

  const { UserMessage } = await import(userMessageSource)
  const toggles = []
  globalThis.__toggleFileContext = (...args) => { toggles.push(args); return Promise.resolve(true) }
  tree = UserMessage({ sessionId: session.id, message: { ...session.messages[0], files: [file, { ...file, id: 'photo', isImage: true }] }, retryUploadId: null, isFirst: true, isLast: true, busy: true, versions: [] })
  const documentCard = find(tree, node => node.type?.name === 'MessageFile' && node.props.file.id === file.id)
  const imageCard = find(tree, node => node.type?.name === 'MessageFile' && node.props.file.id === 'photo')
  assert.equal(documentCard.props.busy, true)
  assert.equal(imageCard.props.onToggleContext, undefined)
  documentCard.props.onToggleContext()
  assert.deepEqual(toggles, [[session.id, file.id, true]])
  assert.equal(requested, 0)
  console.log('Passed local attachment reference pause/resume persistence, session isolation, busy guards, original preservation, and UI wiring')
} finally {
  hooks.deregister()
}
