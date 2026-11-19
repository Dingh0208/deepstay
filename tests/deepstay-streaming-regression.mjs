import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { createRequire, registerHooks, stripTypeScriptTypes } from 'node:module'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import katex from 'katex'

const app = new URL('../', import.meta.url)
const src = new URL('src/', app)
const require = createRequire(new URL('package.json', app))
const { transformSync } = require(require.resolve('@rspack/binding', { paths: [require.resolve('@rspack/core')] }))
const baselineRevision = '80b10e3564137c5bc3404fab688adff65fc5b0bf'
const baselineCode = execFileSync('git', ['show', `${baselineRevision}:src/components/markdown/CodeBlock.tsx`], { cwd: fileURLToPath(app), encoding: 'utf8' })
const baselineUrl = new URL('components/markdown/__baseline_CodeBlock.tsx', src).href
const baselineThrottleUrl = new URL('components/markdown/__baseline_useThrottleMarkdownRender.ts', src).href
const baselineThrottleCode = execFileSync('git', ['show', `${baselineRevision}:src/components/markdown/useThrottleMarkdownRender.ts`], { cwd: fileURLToPath(app), encoding: 'utf8' })
const mocks = new Map([
  ['i18n/index.ts', 'export const useTranslate=()=>key=>key;'],
  ['app/viewport.ts', 'export const useIsMobile=()=>globalThis.__mobile;'],
  ['services/chat/store.ts', 'export const selectMessageVersion=(...args)=>globalThis.__selection=args; export const deleteMessages=()=>true;'],
  ['services/settings.ts', 'export const addFavoriteMessages=()=>{};'],
  ['services/chat/historySearch.ts', 'export const useHistoryTarget=Object.assign(()=>globalThis.__historyTarget??{}, {setState:target=>globalThis.__historyTarget=target});'],
  ['components/search/searchPanelState.ts', 'export const closeSearchPanel=()=>{};'],
  ['components/messages/AssistantMessage.tsx', 'export const AssistantMessage=()=>null;'],
  ['components/messages/UserMessage.tsx', 'export const UserMessage=()=>null;'],
  ['components/base/IconButton.tsx', 'export const IconButton=()=>null;'],
  ['components/base/Modal.tsx', 'export const Modal=()=>null;'],
  ['components/base/icons.tsx', 'export const IconCheckOutline16=()=>null; export const IconCopyOutline16=()=>null; export const IconChevronDownOutline14=()=>null; export const IconHeartOutline16=()=>null; export const IconTrashOutline16=()=>null;'],
  ['components/base/toastState.ts', 'export const showToast=()=>{};'],
  ['utils/clipboard.ts', 'export const copyText=async()=>true;'],
  ['components/markdown/MermaidDiagram.tsx', 'export const MermaidDiagram=()=>null;'],
])
const reactMock = `
export const memo=fn=>fn;
export const useRef=(...args)=>globalThis.__hooks.useRef(...args);
export const useState=(...args)=>globalThis.__hooks.useState(...args);
export const useReducer=(...args)=>globalThis.__hooks.useReducer(...args);
export const useMemo=(...args)=>globalThis.__hooks.useMemo(...args);
export const useCallback=(fn,deps)=>globalThis.__hooks.useMemo(()=>fn,deps);
export const useEffect=(...args)=>globalThis.__hooks.effect(...args);
export const useLayoutEffect=(...args)=>globalThis.__hooks.effect(...args);
`
const mockUrl = text => 'data:text/javascript;base64,' + Buffer.from(text).toString('base64')
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === baselineUrl || specifier === baselineThrottleUrl) return { url: specifier, shortCircuit: true }
    if (context.parentURL?.startsWith(src.href)) {
      if (specifier === 'react') return { url: mockUrl(reactMock), shortCircuit: true }
      if (specifier === 'react/jsx-runtime') return { url: mockUrl('export const jsx=(type,props,key)=>({type,props,key}); export const jsxs=jsx; export const Fragment=Symbol.for("react.fragment");'), shortCircuit: true }
      if (specifier.endsWith('.css')) return { url: mockUrl('export default {};'), shortCircuit: true }
      if (specifier.startsWith('.') && specifier.endsWith('.js')) {
        for (const extension of ['.ts', '.tsx']) {
          const candidate = new URL(specifier.slice(0, -3) + extension, context.parentURL)
          const relative = candidate.href.slice(src.href.length)
          if (mocks.has(relative)) return { url: mockUrl(mocks.get(relative)), shortCircuit: true }
          if (existsSync(candidate)) return { url: candidate.href, shortCircuit: true }
        }
      }
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url.startsWith(src.href) && /\.tsx?$/.test(url)) {
      const source = url === baselineUrl ? baselineCode : url === baselineThrottleUrl ? baselineThrottleCode : readFileSync(new URL(url), 'utf8')
      const code = url.endsWith('.tsx')
        ? transformSync(source, JSON.stringify({ jsc: { target: 'es2022', parser: { syntax: 'typescript', tsx: true }, transform: { react: { runtime: 'automatic' } } }, module: { type: 'es6' } })).code
        : stripTypeScriptTypes(source, { mode: 'transform' })
      return { format: 'module', source: code, shortCircuit: true }
    }
    return nextLoad(url, context)
  },
})

// Exercise the actual component functions with deterministic hooks, refs and animation frames.
// This models scheduling; it is not a browser or a claim about real handset FPS.
const runner = component => {
  const slots = []
  let cursor = 0
  const effects = []
  const equalDeps = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]))
  const api = {
    useRef(initial) { const index = cursor++; return slots[index] ??= { current: initial } },
    useState(initial) {
      const index = cursor++
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial
      return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value }]
    },
    useReducer(reducer, initial) { const [value, setValue] = api.useState(initial); return [value, action => setValue(value => reducer(value, action))] },
    useMemo(factory, deps) {
      const index = cursor++
      if (!slots[index] || !equalDeps(slots[index].deps, deps)) slots[index] = { value: factory(), deps }
      return slots[index].value
    },
    effect(effect, deps) {
      const index = cursor++
      if (!slots[index] || !equalDeps(slots[index].deps, deps)) {
        const previous = slots[index]
        slots[index] = { deps, cleanup: previous?.cleanup }
        effects.push(() => { previous?.cleanup?.(); slots[index].cleanup = effect() })
      }
    },
  }
  return {
    render(props) { cursor = 0; globalThis.__hooks = api; return component(props) },
    effects() { for (const effect of effects.splice(0)) effect() },
    cleanup() { for (const slot of slots) slot?.cleanup?.() },
  }
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

const { toMdAst } = await import(new URL('services/markdown/parse.ts', src))
const { renderFormula } = await import(new URL('services/markdown/katex.ts', src))
const checks = []
const sources = [{ url: 'https://example.com', title: 'Fixture', siteName: 'example.com', index: 1, publishedAt: null, snippet: null, siteIcon: null }]
const forumArray = String.raw`\begin{array}{l}
\text{\scriptsize 第一条留言} \\
\text{\tiny \textcolor{#A9A4CE}{几分钟前 \; ♡8}} \\
\text{\scriptsize 共 9 条回复}
\end{array}`
const malformedForumBox = String.raw`\fcolorbox{#A9A4CE}{#ffffff}{${forumArray}}`
const fixtures = [
  '你好，今天一起聊聊。\n\n第二段 **加粗** 与 *强调*。\n下一行。',
  '# 标题\n\n正文\n\n---\n\n后文',
  '标题\n===\n\n小标题\n---\n\n后文',
  '- 第一项\n\n- 第二项\n  - 嵌套\n\n正文',
  '> 引用\n>\n> 第二段\n\n正文\n\n> 新引用',
  '| A | B |\n|---|---|\n| 一 | 二 |\n\n正文',
  '```javascript\nconst a = "<b>&"\n```\n\n后文',
  '   ```js\n   const x = 1\n   ```\n\n末尾',
  '前文 [label *bold*]\n\n另一段\n\n[label *bold*]: https://example.com',
  '脚注[^1]\n\n中间\n\n[^1]: 文本\n\n末尾',
  '[链接](https://example.com) ![图片](https://example.com/a.png) [citation:1]',
  '前文 $a+b$\n\n$$\na^2+b^2=c^2\n$$\n\n末尾',
  '前文 \\(x+y\\)\n\n\\[\na^2\n\\]\n\n末尾',
  `前文\n\n${forumArray}\n\n末尾`,
  '<div>\nHTML\n\n</div>\n\n~~删除~~ <br> 末尾',
  '第一段\r\n\r\n第二段\r\n\r\n- 列表\r\n- 结尾',
  '😀 零宽\u200b字符与\t制表符\n\n尾部\n',
]
const parse = value => toMdAst(value, { sources, disableLink: false })
assert.throws(() => katex.renderToString(malformedForumBox, { strict: false }), /text mode/)
for (const value of [forumArray, malformedForumBox, forumArray + '}', '$$\n' + malformedForumBox + '\n$$', '\\[\n' + forumArray + '\n\\]']) {
  const ast = parse(value)
  assert.equal(ast.children.length, 1)
  assert.equal(ast.children[0].type, 'math')
  const rendered = renderFormula(katex, ast.children[0].value, true)
  assert.match(rendered, /class="mtable"/)
  assert.match(rendered, /color:#A9A4CE/i)
  assert.equal(rendered.includes('katex-error'), false)
}
const fencedTex = parse('```latex\n' + forumArray + '\n```').children[0]
assert.equal(fencedTex.type, 'code')
assert.equal(fencedTex.value, forumArray)
assert.equal(parse('这里是源码：`\\begin{array}{l}`').children[0].children[1].type, 'inlineCode')
assert.equal(parse(forumArray + '\n仍然保留这段普通说明').children[0].type, 'paragraph')
assert.throws(() => renderFormula(katex, String.raw`\begin{array}{l}x`, true), /KaTeX parse error/)
assert.equal(renderFormula(katex, 'x^2', false), katex.renderToString('x^2', { strict: false }))
checks.push('Bare and malformed styled TeX arrays use KaTeX while explicit source code, prose, and ordinary math stay intact')
let prefixes = 0
for (const disableLink of [false, true]) {
  for (const text of fixtures) {
    let previous = null
    for (let end = 1; end <= text.length; end += 1) {
      const value = text.slice(0, end)
      const actual = toMdAst(value, { sources, disableLink }, previous)
      assert.deepEqual(actual, toMdAst(value, { sources, disableLink }))
      previous = actual
      prefixes += 1
    }
    // Content replacement and changed source metadata must invalidate the affected nodes.
    const changedSources = sources.map(source => ({ ...source, title: 'Changed' }))
    assert.deepEqual(toMdAst('replacement [citation:1]', { sources: changedSources, disableLink }, previous), toMdAst('replacement [citation:1]', { sources: changedSources, disableLink }))
  }
}
const referenceBefore = toMdAst('[foo *bar*]\n\nsecond', { sources, disableLink: false })
const referenceAfter = toMdAst('[foo *bar*]\n\nsecond\n\n[foo *bar*]: https://example.com', { sources, disableLink: false }, referenceBefore)
assert.notEqual(referenceAfter.children[0], referenceBefore.children[0])
checks.push(`${prefixes} incremental prefixes, both link modes, citations, forward references, lists, fences, tables, math, CRLF and replacement equal a complete parse`)

const longText = Array.from({ length: 90 }, (_, index) => `### 第 ${index + 1} 段\n\n${'今天过得怎么样？我在这里，慢慢听你说。'.repeat(9)}\n\n`).join('')
let previous = null
let baselineChanged = 0
let optimizedChanged = 0
let parsedMs = 0
let cachedMs = 0
let frames = 0
for (let end = 160; ; end = Math.min(longText.length, end + 160)) {
  const value = longText.slice(0, end)
  let start = performance.now()
  const baseline = toMdAst(value, { sources: undefined, disableLink: false })
  parsedMs += performance.now() - start
  start = performance.now()
  const next = toMdAst(value, { sources: undefined, disableLink: false }, previous)
  cachedMs += performance.now() - start
  assert.deepEqual(next, baseline)
  baselineChanged += baseline.children.length
  optimizedChanged += next.children.filter((node, index) => node !== previous?.children[index]).length
  previous = next
  frames += 1
  if (end === longText.length) break
}
checks.push('Long reply keeps complete AST semantics while reusing identical completed blocks by reference')

const Prism = require('prismjs')
const originalHighlight = Prism.highlight
let highlightCalls = 0
Prism.highlight = (...args) => { highlightCalls += 1; return originalHighlight(...args) }
const { CodeBlock } = await import(new URL('components/markdown/CodeBlock.tsx', src))
const { CodeBlock: BaselineCodeBlock } = await import(baselineUrl)
const longCode = Array.from({ length: 420 }, (_, index) => `const value${index} = "<element>&${index}";\n`).join('')
const runCode = component => {
  const instance = runner(component)
  let streamCalls
  let output
  highlightCalls = 0
  const start = performance.now()
  for (let end = 100; ; end = Math.min(longCode.length, end + 100)) {
    output = instance.render({ code: longCode.slice(0, end), infostring: 'javascript', loading: true })
    instance.effects()
    if (component === CodeBlock) assert.equal(find(output, node => node.type === 'pre').props.children, longCode.slice(0, end))
    if (end === longCode.length) break
  }
  streamCalls = highlightCalls
  output = instance.render({ code: longCode, infostring: 'javascript', loading: false })
  instance.effects()
  const result = { streamingHighlights: streamCalls, totalHighlights: highlightCalls, durationMs: performance.now() - start, html: find(output, node => node.type === 'pre').props.dangerouslySetInnerHTML.__html }
  instance.cleanup()
  return result
}
const codeBaseline = runCode(BaselineCodeBlock)
const codeOptimized = runCode(CodeBlock)
assert.equal(codeOptimized.streamingHighlights, 0)
assert.equal(codeOptimized.totalHighlights, 1)
assert.equal(codeOptimized.html, codeBaseline.html)
const mermaid = runner(CodeBlock)
highlightCalls = 0
mermaid.render({ code: 'graph TD\nA-->B', infostring: 'mermaid', loading: true })
mermaid.effects()
assert.equal(highlightCalls, 0)
mermaid.cleanup()
Prism.highlight = originalHighlight
checks.push('Actual CodeBlock renders every streamed code character as text, performs zero live syntax highlights and one final highlight identical to baseline; displayed Mermaid avoids unused Prism work')

globalThis.__mobile = true
let frameId = 0
const pendingFrames = new Map()
globalThis.requestAnimationFrame = callback => { const id = ++frameId; pendingFrames.set(id, callback); return id }
globalThis.cancelAnimationFrame = id => pendingFrames.delete(id)
const frame = () => { const callbacks = [...pendingFrames.values()]; pendingFrames.clear(); callbacks.forEach(callback => callback()) }
const observers = []
globalThis.ResizeObserver = class { constructor(callback) { this.callback = callback; observers.push(this) } observe() {} disconnect() {} }
globalThis.CSS = { escape: value => value }
let reads = 0
let writes = 0
let top = 0
let height = 1000
let client = 400
const listeners = new Map()
const scroll = {
  get scrollHeight() { reads += 1; return height },
  get clientHeight() { reads += 1; return client },
  get scrollTop() { return top },
  set scrollTop(value) { writes += 1; top = Math.max(0, Math.min(value, height - client)) },
  addEventListener(name, callback) { listeners.set(name, callback) },
  removeEventListener(name) { listeners.delete(name) },
  querySelector() { return { getBoundingClientRect: () => ({ top: 100 }) } },
}
const { MessageList } = await import(new URL('components/messages/MessageList.tsx', src))
const instance = runner(MessageList)
let session = { id: 'fixture', title: 'Fixture', messages: [{ id: 'u', role: 'user', content: 'Hi', files: [], createdAt: 1 }, { id: 'a', role: 'assistant', blocks: [], status: 'streaming', createdAt: 2 }] }
const attach = (tree, content = {}) => {
  const refs = []
  const visit = node => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) { node.forEach(visit); return }
    if (node.props?.ref) refs.push(node.props.ref)
    visit(node.props?.children)
  }
  visit(tree)
  refs[0].current = scroll
  refs[1].current = content
}
let tree = instance.render({ session, streaming: true, footer: null })
const jumpButton = tree => find(tree, node => node.props?.tooltip === 'jumpToLatest')
attach(tree)
instance.effects()
assert.equal(pendingFrames.size, 1)
frame()
assert.equal(top, 600)
assert.equal(jumpButton(instance.render({ session, streaming: true, footer: null })), null)
reads = 0; writes = 0
height = 1400
for (let index = 0; index < 20; index += 1) observers[0].callback()
assert.equal(pendingFrames.size, 1)
frame()
assert.equal(top, 1000)
assert.equal(reads, 2)
assert.equal(writes, 1)
const layoutBatch = { requests: 20, scrollHeightReads: reads / 2, clientHeightReads: reads / 2, writes }
// A user can leave the bottom even while an automatic scroll is already queued.
height = 1500
observers[0].callback()
top = 800
listeners.get('scroll')()
frame()
assert.equal(top, 800)
observers[0].callback()
assert.equal(pendingFrames.size, 0)
tree = instance.render({ session, streaming: true, footer: null })
jumpButton(tree).props.onClick()
frame()
assert.equal(top, 1100)
assert.equal(jumpButton(instance.render({ session, streaming: true, footer: null })), null)
client = 300
observers[0].callback()
frame()
assert.equal(top, 1200)
// Branch switch restores the selector position and disables automatic following.
const select = find(tree, node => typeof node.props?.onSelectVersion === 'function').props.onSelectVersion
// Version selection is ignored while streaming.
select('a2', 80)
assert.equal(globalThis.__selection, undefined)
tree = instance.render({ session, streaming: false, footer: null })
attach(tree); instance.effects()
find(tree, node => typeof node.props?.onSelectVersion === 'function').props.onSelectVersion('a2', 80)
assert.deepEqual(globalThis.__selection, ['fixture', 'a2'])
session = { ...session, messages: [session.messages[0], { ...session.messages[1], id: 'a2' }] }
height = 1600
tree = instance.render({ session, streaming: false, footer: null })
attach(tree); instance.effects()
assert.equal(top, 1220)
observers[0].callback()
assert.equal(pendingFrames.size, 0)
// A new message resumes following; unmount must cancel its pending work.
session = { ...session, messages: [...session.messages, { id: 'u2', role: 'user', content: 'More', files: [], createdAt: 3 }] }
tree = instance.render({ session, streaming: false, footer: null })
attach(tree); instance.effects()
assert.equal(pendingFrames.size, 1)
instance.cleanup()
assert.equal(pendingFrames.size, 0)
checks.push('Actual MessageList coalesces 20 resize requests into one frame/read-write pass, lets the user pause and resume following while streaming, follows viewport resizing, preserves branch anchor, ignores branch selection while streaming, resumes on a new message and cancels work on unmount')

// A long conversation should not mount every historical Markdown component on open.
const longSession = { id: 'long-fixture', rootMessageId: 'long-0', messages: Array.from({ length: 240 }, (_, index) => ({
  id: 'long-' + index,
  parentId: index ? 'long-' + (index - 1) : null,
  selectedChildId: index < 239 ? 'long-' + (index + 1) : undefined,
  role: 'user',
  content: 'History ' + index,
  files: [],
  createdAt: index,
})) }
longSession.messages.push({ ...longSession.messages[2], id: 'long-2-alt', selectedChildId: undefined })
const messageIds = node => Array.isArray(node)
  ? node.flatMap(messageIds)
  : node?.props?.message ? [node.props.message.id]
    : node?.props ? messageIds(node.props.children) : []
const longInstance = runner(MessageList)
const longProps = { session: longSession, streaming: false, footer: null }
let longTree
let centeredMessage
const mountLong = (props = longProps) => {
  longTree = longInstance.render(props)
  attach(longTree, {
    querySelector(selector) {
      const message = /^\[data-chat-message="([^"]+)"\]$/.exec(selector)?.[1]
      const position = messageIds(longTree).indexOf(message)
      return position < 0 ? null : {
        getBoundingClientRect: () => ({ top: position * 40 - top }),
        scrollIntoView: ({ block }) => { centeredMessage = [message, block] },
      }
    },
  })
  longInstance.effects()
  return messageIds(longTree)
}
const initialIds = mountLong()
assert.ok(initialIds.length <= 32, 'Opening a long chat mounts only a recent batch')
assert.equal(initialIds.at(-1), 'long-239')
frame()
const older = () => find(longTree, node => node.props?.children === 'showOlderMessages').props.onClick()
older()
let shownIds = mountLong()
assert.ok(shownIds.length <= 48)
assert.ok(shownIds.includes('long-200'))
older()
shownIds = mountLong()
assert.ok(shownIds.length <= 48)
assert.ok(shownIds.includes('long-170') && !shownIds.includes('long-239'))
find(longTree, node => node.props?.children === 'showNewerMessages').props.onClick()
assert.equal(mountLong().at(-1), 'long-239')
globalThis.__historyTarget = { sessionId: longSession.id, messageId: 'long-2' }
shownIds = mountLong()
assert.ok(shownIds.length <= 32 && shownIds.includes('long-2') && !shownIds.includes('long-239'))
assert.deepEqual(centeredMessage, ['long-2', 'center'])
assert.deepEqual(globalThis.__historyTarget, { sessionId: null, messageId: null })
assert.deepEqual(mountLong(), shownIds)
assert.deepEqual(find(longTree, node => node.props?.message?.id === 'long-2').props.versions,
  { ids: ['long-2', 'long-2-alt'], index: 0 })
jumpButton(longTree).props.onClick()
assert.equal(mountLong().at(-1), 'long-239')
frame()
const atBeginning = { ...longProps, jumpRequest: 1 }
mountLong(atBeginning)
const firstIds = mountLong(atBeginning)
assert.equal(firstIds[0], 'long-0')
assert.equal(firstIds.length, 24)
assert.equal(top, 0)
observers.at(-1).callback()
assert.equal(pendingFrames.size, 0, 'A resize after jumping to the first message does not follow the latest reply')
checks.push('Jumping to the first message replaces the window with the first 24 messages of the visible branch and preserves the top on resize')
jumpButton(longTree).props.onClick()
assert.equal(mountLong(atBeginning).at(-1), 'long-239')
frame()
mountLong(atBeginning)
assert.equal(jumpButton(longTree), null)
globalThis.__historyTarget = { sessionId: longSession.id, messageId: 'long-2' }
mountLong()
mountLong()
const laterSession = { ...longSession, messages: [...longSession.messages] }
laterSession.messages[239] = { ...laterSession.messages[239], selectedChildId: 'long-240' }
laterSession.messages.push({ ...laterSession.messages[239], id: 'long-240', parentId: 'long-239', selectedChildId: undefined })
mountLong({ ...longProps, session: laterSession })
assert.equal(mountLong({ ...longProps, session: laterSession }).at(-1), 'long-240')
longInstance.cleanup()
delete globalThis.__historyTarget
checks.push('Actual MessageList bounds the DOM on a 240-message chat, pages in both directions, centers an early search match, preserves sibling versions and returns to the live tail in one tap or on new input')

const jumpRaceInstance = runner(MessageList)
const jumpRaceProps = { ...longProps, jumpRequest: 0 }
let jumpRaceTree
const mountJumpRace = (props = jumpRaceProps) => {
  jumpRaceTree = jumpRaceInstance.render(props)
  attach(jumpRaceTree, {
    querySelector(selector) {
      const message = /^\[data-chat-message="([^"]+)"\]$/.exec(selector)?.[1]
      const position = messageIds(jumpRaceTree).indexOf(message)
      return position < 0 ? null : {
        getBoundingClientRect: () => ({ top: position * 40 - top }),
        scrollIntoView: () => { top = 123 },
      }
    },
  })
  jumpRaceInstance.effects()
  return messageIds(jumpRaceTree)
}
globalThis.__historyTarget = { sessionId: longSession.id, messageId: 'long-2' }
mountJumpRace()
find(jumpRaceTree, node => node.props?.message?.id === 'long-2').props.onSelectVersion('long-2-alt', 80)
globalThis.__historyTarget = { sessionId: longSession.id, messageId: 'long-239' }
mountJumpRace({ ...jumpRaceProps, jumpRequest: 1 })
assert.deepEqual(globalThis.__historyTarget, { sessionId: null, messageId: null })
assert.equal(mountJumpRace({ ...jumpRaceProps, jumpRequest: 1 })[0], 'long-0')
assert.equal(top, 0)
jumpRaceInstance.cleanup()
delete globalThis.__historyTarget
checks.push('Jumping to the first message clears pending search and message-version scroll targets before they can move the viewport')

const { useThrottleMarkdownRender } = await import(new URL('components/markdown/useThrottleMarkdownRender.ts', src))
const { useThrottleMarkdownRender: baselineThrottle } = await import(baselineThrottleUrl)
const realPerformance = globalThis.performance
const realSetTimeout = globalThis.setTimeout
const realClearTimeout = globalThis.clearTimeout
const measureThrottle = hook => {
  let now = 0
  let timerId = 0
  const timers = new Map()
  globalThis.performance = { now: () => now }
  globalThis.setTimeout = (callback, delay) => { const id = ++timerId; timers.set(id, { callback, at: now + delay }); return id }
  globalThis.clearTimeout = id => timers.delete(id)
  const instance = runner(({ content, loading }) => hook(content, loading))
  assert.equal(instance.render({ content: 'start', loading: true }), 'start')
  now = 500 // Model a slow initial commit; neither test sleeps nor contacts a model.
  instance.effects()
  const initialWait = [...timers.values()][0].at - now
  now = 510
  instance.render({ content: 'start: every chunk', loading: true })
  instance.effects()
  const deadline = [...timers.values()][0].at
  now = deadline
  const pending = [...timers.values()]; timers.clear(); pending.forEach(timer => timer.callback())
  assert.equal(instance.render({ content: 'start: every chunk', loading: true }), 'start: every chunk')
  now += 8; instance.effects()
  // A long gap in upstream tokens must not be counted as rendering time.
  now = 4000
  instance.render({ content: 'start: every chunk after pause', loading: true }); instance.effects()
  assert.equal(timers.size, 0)
  assert.equal(instance.render({ content: 'start: every chunk after pause', loading: true }), 'start: every chunk after pause')
  now = 4008; instance.effects()
  now = 4010
  instance.render({ content: 'start: next chunk', loading: true }); instance.effects()
  const ordinaryWait = [...timers.values()][0].at - now
  assert.equal(ordinaryWait, 14)
  // Completion/stop/error all end loading and expose the exact last content immediately.
  now = 4011
  assert.equal(instance.render({ content: 'complete final text', loading: false }), 'complete final text')
  instance.effects()
  assert.equal(timers.size, 0)
  instance.cleanup()
  return { slowCommitAdditionalWaitMs: initialWait, afterUpstreamPauseAdditionalWaitMs: ordinaryWait, finalContentImmediate: true }
}
const throttleBaseline = measureThrottle(baselineThrottle)
const throttleOptimized = measureThrottle(useThrottleMarkdownRender)
assert.equal(throttleBaseline.slowCommitAdditionalWaitMs, 1000)
assert.equal(throttleOptimized.slowCommitAdditionalWaitMs, 100)
globalThis.performance = realPerformance
globalThis.setTimeout = realSetTimeout
globalThis.clearTimeout = realClearTimeout
checks.push('Actual throttle hooks with a fake clock: 500 ms commit adds 100 ms wait instead of 1000 ms, ordinary adaptive timing remains 14 ms, upstream gaps are not accumulated, and loading=false returns final text immediately while cancelling the pending timer')

hooks.deregister()
const evidence = {
  passed: true, runtime: process.version, baselineRevision,
  scope: 'Deterministic real source/TSX functions, synthetic long replies, mock hooks/DOM scheduling. No model requests; not browser FPS or physical handset timings.',
  checks,
  markdown: { characters: longText.length, frames, baselineNewRootBlocks: baselineChanged, optimizedNewRootBlocks: optimizedChanged, stableRootBlockReusePercent: Math.round((1 - optimizedChanged / baselineChanged) * 10000) / 100, baselineCompleteParseMs: Math.round(parsedMs), completeParseWithReuseMs: Math.round(cachedMs), parsingStrategy: 'Both perform the complete parser; reuse avoids downstream stable block renders, not parser work' },
  code: { characters: longCode.length, baseline: { streamingHighlights: codeBaseline.streamingHighlights, totalHighlights: codeBaseline.totalHighlights, durationMs: Math.round(codeBaseline.durationMs) }, optimized: { streamingHighlights: codeOptimized.streamingHighlights, totalHighlights: codeOptimized.totalHighlights, durationMs: Math.round(codeOptimized.durationMs) }, finalHighlightedHtmlIdentical: true },
  scrolling: layoutBatch,
  throttle: { baseline: throttleBaseline, optimized: throttleOptimized },
  unchanged: 'Store token accumulation, RAF state flush, stop/error/final persistence, SSE protocol and network remain unchanged; final loading=false renders the complete content directly.',
}
await writeFile(new URL('./deepstay-streaming-evidence.json', import.meta.url), JSON.stringify(evidence, null, 2) + '\n')
console.log(JSON.stringify(evidence, null, 2))
