import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire, registerHooks } from 'node:module'

const app = new URL('../', import.meta.url)
const source = new URL('src/components/speech/VoiceCallPage.tsx', app)
const require = createRequire(new URL('package.json', app))
const { transformSync } = require(require.resolve('@rspack/binding', { paths: [require.resolve('@rspack/core')] }))
const mockUrl = value => 'data:text/javascript;base64,' + Buffer.from(value).toString('base64')
const mocks = new Map([
  ['react', 'let id=0; export const useId=()=>`id-${++id}`; export const useEffect=()=>{}; export const useRef=value=>({current:value}); export const useState=value=>{const index=globalThis.__cursor++; if(!(index in globalThis.__slots))globalThis.__slots[index]=typeof value==="function"?value():value; return [globalThis.__slots[index],next=>{globalThis.__slots[index]=typeof next==="function"?next(globalThis.__slots[index]):next}]};'],
  ['react/jsx-runtime', 'export const Fragment=Symbol.for("react.fragment");export const jsx=(type,props,key)=>({type,props,key});export const jsxs=jsx;'],
  ['../../i18n/index.js', 'export const useTranslate=()=>key=>key;'],
  ['../base/Button.js', 'export const Button=props=>({type:"button",props:{...props,"data-kind":"button"}});'],
  ['../base/IconButton.js', 'export const IconButton=props=>({type:"button",props:{...props,"aria-label":props.tooltip,"data-kind":"icon-button"}});'],
  ['../base/icons.js', 'export const IconCloseOutline16=()=>null;export const IconMicFill16=()=>null;export const IconMicOutline16=()=>null;'],
  ['./VoiceCallPage.module.css', 'const styles=new Proxy({}, {get:(_target,key)=>String(key)});export default styles;'],
])
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL === source.href && mocks.has(specifier)) return { url: mockUrl(mocks.get(specifier)), shortCircuit: true }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url === source.href) return {
      format: 'module', source: transformSync(readFileSync(source, 'utf8'), JSON.stringify({
        jsc: { target: 'es2022', parser: { syntax: 'typescript', tsx: true }, transform: { react: { runtime: 'automatic' } } },
        module: { type: 'es6' },
      })).code, shortCircuit: true,
    }
    return nextLoad(url, context)
  },
})

const find = (node, predicate) => {
  if (!node || typeof node !== 'object') return null
  if (!Array.isArray(node) && predicate(node)) return node
  for (const child of Array.isArray(node) ? node : [node.props?.children]) {
    const found = find(child, predicate)
    if (found) return found
  }
  return null
}
const all = (node, predicate, output = []) => {
  if (!node || typeof node !== 'object') return output
  if (!Array.isArray(node) && predicate(node)) output.push(node)
  for (const child of Array.isArray(node) ? node : [node.props?.children]) all(child, predicate, output)
  return output
}
const render = (props) => {
  globalThis.__cursor = 0
  return globalThis.__VoiceCallPage(props)
}

try {
  const { VoiceCallPage } = await import(source)
  globalThis.__slots = []
  globalThis.__VoiceCallPage = props => VoiceCallPage(props)
  const calls = { mute: 0, speaker: 0, hangup: 0 }
  const props = {
    open: false,
    phase: 'listening',
    phaseLabel: 'voiceCallTitle',
    turns: [{ id: 'turn-1', userText: '旧问题', assistantText: '旧回答', cut: true }],
    currentUserText: '实时识别文字',
    currentReplyText: '实时回答文字',
    micLevel: 0.7,
    playbackLevel: 0.2,
    muted: false,
    speaker: true,
    supportsSpeaker: false,
    onMute: () => calls.mute++,
    onSpeaker: () => calls.speaker++,
    onHangup: () => calls.hangup++,
  }
  assert.equal(render(props), null, 'Closed page renders nothing')

  props.open = true
  let tree = render(props)
  assert.equal(find(tree, node => node.props?.role === 'dialog')?.props['aria-modal'], 'true')
  assert.ok(find(tree, node => node.type === 'h1')?.props.children === 'voiceCallTitle')
  assert.ok(find(tree, node => node.type === 'p' && node.props.children === '实时识别文字'))
  assert.ok(find(tree, node => node.type === 'p' && node.props.children === '实时回答文字'))
  assert.equal(find(tree, node => node.props?.className === 'meter')?.props.style['--voice-call-level'], 0.7)

  find(tree, node => node.type?.name === 'Button' && node.props.children === 'voiceCallHangup').props.onClick()
  const muteButton = find(tree, node => node.type === 'button' && node.props['aria-label'] === 'voiceCallMute')
  const speakerButton = find(tree, node => node.type === 'button' && node.props['aria-label'] === 'voiceCallUseReceiver')
  assert.equal(muteButton.props.hidden, undefined, 'Browser call keeps microphone mute available')
  assert.equal(speakerButton, null, 'Browser call omits unsupported audio route control')
  muteButton.props.onClick()
  assert.deepEqual(calls, { mute: 1, speaker: 0, hangup: 1 })

  tree = render(props)
  find(tree, node => node.type?.name === 'Button' && node.props.children === 'voiceCallTranscript').props.onClick()
  tree = render(props)
  assert.ok(find(tree, node => node.props?.role === 'dialog' && node.props['aria-labelledby']?.endsWith('-transcript')))
  assert.ok(find(tree, node => node.type === 'p' && node.props.children === '旧问题'))
  assert.ok(find(tree, node => node.type === 'p' && node.props.children === '旧回答'))
  assert.ok(all(tree, node => node.type === 'span').some(node => (JSON.stringify(node.props.children) ?? '').includes('voiceCallInterrupted')))
  find(tree, node => node.type?.name === 'IconButton' && node.props.tooltip === 'voiceCallCloseTranscript').props.onClick()
  tree = render(props)
  assert.equal(find(tree, node => node.props?.role === 'dialog' && node.props['aria-labelledby']?.endsWith('-transcript')), null)

  const voiceCallSource = readFileSync(new URL('../src/services/speech/voiceCall.ts', import.meta.url), 'utf8')
  const startMethod = voiceCallSource.match(/async start\(targetSessionId: string \| null\) \{([\s\S]*?)\n  private observeSession\(\)/)?.[1]
  assert.ok(startMethod)
  assert.match(startMethod, /apiKey\?\.trim\(\)/)
  assert.doesNotMatch(startMethod, /apiProtocol.*apiKey|apiKey.*apiProtocol/, 'The API-key requirement is not scoped to the DeepSeek protocol')
  const chineseLocale = readFileSync(new URL('../src/i18n/zh.ts', import.meta.url), 'utf8')
  assert.match(chineseLocale, /voiceCallRequiresApiKey: '请先配置当前模型接口的 API Key'/)
  assert.doesNotMatch(chineseLocale, /voiceCallRequiresApiKey: '[^']*DeepSeek/)

  console.log(JSON.stringify({ passed: true, checks: [
    'Closed call page renders nothing; open page presents accessible dialog and current call phase',
    'Live user/reply captions and input playback level are rendered from controlled props',
    'Mute, audio route, and hangup actions invoke only their supplied callbacks',
    'Transcript drawer lists completed turns and interruption marks, then closes without changing call state',
    'Voice calls accept the selected compatible-provider key and use provider-neutral missing-key guidance',
  ] }, null, 2))
} finally { hooks.deregister() }
