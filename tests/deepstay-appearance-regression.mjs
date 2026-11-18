import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { createRequire, registerHooks, stripTypeScriptTypes } from 'node:module'

const app = new URL('../', import.meta.url)
const service = new URL('src/services/chatBackground.ts', app)
const area = new URL('src/components/messages/ReplyArea.tsx', app)
const require = createRequire(new URL('package.json', app))
const { transformSync } = require(require.resolve('@rspack/binding', { paths: [require.resolve('@rspack/core')] }))
const mockUrl = text => 'data:text/javascript;base64,' + Buffer.from(text).toString('base64')
const mocks = new Map([
  ['react', 'export const memo=fn=>fn; export const useState=(...a)=>globalThis.__hooks.useState(...a); export const useEffect=(...a)=>globalThis.__hooks.useEffect(...a);'],
  ['react/jsx-runtime', 'export const Fragment=Symbol.for("fragment"); export const jsx=(type,props,key)=>({type,props,key}); export const jsxs=jsx;'],
  ['../../i18n/index.js', 'export const useTranslate=()=>key=>key;'],
  ['../../services/settings.js', 'export const useSettings=selector=>selector(globalThis.__settings);'],
  ['../../services/chat/view.js', 'export const getAreaTitle=()=>"Thinking"; export const isDeepSearchKind=()=>false; export const isImageSearchKind=()=>false;'],
  ['../base/icons.js', readFileSync(area, 'utf8').match(/import \{([^}]+)\} from '\.\.\/base\/icons\.js'/s)[1].split(',').map(name=>name.trim()).filter(Boolean).map(name=>`export const ${name}=()=>null;`).join('')],
  ['../base/Tooltip.js', 'export const Tooltip=()=>null;'],
  ['../markdown/Markdown.js', 'export const Markdown=()=>null;'],
  ['../search/SiteLogo.js', 'export const SiteThumbnails=()=>null;'],
  ['../search/searchPanelState.js', 'export const toggleSearchPanel=()=>{}; export const useSearchPanel=()=>null;'],
])
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL === area.href && mocks.has(specifier)) return { url: mockUrl(mocks.get(specifier)), shortCircuit:true }
    if (context.parentURL === area.href && specifier.endsWith('.css')) return {url:mockUrl('export default {title:"title",steps:"steps"};'),shortCircuit:true}
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url.startsWith(service.href)) return {format:'module',source:stripTypeScriptTypes(readFileSync(service,'utf8')),shortCircuit:true}
    if (url === area.href) return {format:'module',source:transformSync(readFileSync(area,'utf8'),JSON.stringify({jsc:{target:'es2022',parser:{syntax:'typescript',tsx:true},transform:{react:{runtime:'automatic'}}},module:{type:'es6'}})).code,shortCircuit:true}
    return nextLoad(url,context)
  },
})
const checks = []
const activeTimers = new Set()
const originalSetInterval = globalThis.setInterval
globalThis.setInterval = (...args) => {
  const timer = originalSetInterval(...args)
  activeTimers.add(timer)
  return timer
}
try {
  const fake = await import(new URL('../node_modules/fake-indexeddb/auto/index.mjs',import.meta.url))
  void fake
  const imageState = {width:4032,height:3024,fail:false,draws:[],revoked:[]}
  let sequence=0
  URL.createObjectURL=()=>`blob:test-${++sequence}`
  URL.revokeObjectURL=url=>imageState.revoked.push(url)
  globalThis.Image=class {
    naturalWidth=imageState.width
    naturalHeight=imageState.height
    set src(_url) {queueMicrotask(()=>imageState.fail?this.onerror():this.onload())}
  }
  globalThis.document={createElement(type) {
    assert.equal(type,'canvas')
    return {width:0,height:0,getContext(){return {fillRect(){},drawImage:(_image,x,y,width,height)=>imageState.draws.push({x,y,width,height})}},toBlob(callback,type,quality){assert.equal(type,'image/jpeg');assert.equal(quality,0.86);callback(new Blob(['normalized-pixels'],{type}))}}
  }}
  const background=await import(service)
  await background.loadChatBackground()
  assert.equal(background.useChatBackground.getState().url,null)
  const prepared=await background.prepareChatBackground(new File(['image'],'photo.jpg',{type:'image/jpeg'}))
  assert.equal(prepared.type,'image/jpeg')
  assert.deepEqual(imageState.draws[0],{x:0,y:0,width:2048,height:1536})
  assert.ok(imageState.revoked.includes('blob:test-1'))
  await assert.rejects(background.prepareChatBackground(new File(['text'],'not-image.txt',{type:'text/plain'})),/format/)
  await assert.rejects(background.prepareChatBackground(new File([new Uint8Array(20*1024*1024+1)],'large.jpg',{type:'image/jpeg'})),/size/)
  imageState.fail=true
  await assert.rejects(background.prepareChatBackground(new File(['bad'],'bad.png',{type:'image/png'})),/format/)
  assert.ok(imageState.revoked.includes('blob:test-2'))
  imageState.fail=false
  checks.push('Image preparation rejects unsupported/oversized/corrupt inputs, scales a 4032px photo to2048px and releases temporary image URLs')

  await background.setChatBackground(prepared)
  const firstUrl=background.useChatBackground.getState().url
  assert.ok(firstUrl)
  const cold=await import(service.href+'?cold=1')
  await cold.loadChatBackground()
  assert.ok(cold.useChatBackground.getState().url)
  const originalPut=IDBObjectStore.prototype.put
  IDBObjectStore.prototype.put=function(){throw new DOMException('Full','QuotaExceededError')}
  await assert.rejects(background.setChatBackground(new Blob(['new'])),/Full/)
  IDBObjectStore.prototype.put=originalPut
  assert.equal(background.useChatBackground.getState().url,firstUrl)
  const afterFailure=await import(service.href+'?afterFailure=1')
  await afterFailure.loadChatBackground()
  assert.ok(afterFailure.useChatBackground.getState().url)
  await background.setChatBackground(null)
  assert.equal(background.useChatBackground.getState().url,null)
  assert.ok(imageState.revoked.includes(firstUrl))
  const cleared=await import(service.href+'?cleared=1')
  await cleared.loadChatBackground()
  assert.equal(cleared.useChatBackground.getState().url,null)
  checks.push('Actual IndexedDB persists the normalized Blob across cold module loads; failed writes retain the previous background, reset deletes it and old object URLs are released')

  const {ReplyArea}=await import(area)
  const runner=component=>{
    const slots=[],effects=[],cleanups=[]
    let cursor=0
    const deps=[]
    return props=>{
      cursor=0
      globalThis.__hooks={
        useState(initial){const index=cursor++;if(!(index in slots))slots[index]=typeof initial==='function'?initial():initial;return[slots[index],value=>{slots[index]=typeof value==='function'?value(slots[index]):value}]},
        useEffect(callback,next){const index=cursor++;if(!deps[index]||next.some((value,i)=>value!==deps[index][i])){deps[index]=next;effects.push(()=>{cleanups[index]?.();cleanups[index]=callback()})}},
      }
      const tree=component(props)
      for(const effect of effects.splice(0))effect()
      return tree
    }
  }
  const props={message:{id:'answer1',thinking:true},view:{steps:[{type:'thinking',key:'thinking1',blocks:[{thinking:'private thought'}]}],sources:[]},streaming:true,hasResponse:false}
  const title=node=>node.props.children[0]
  const expanded=node=>title(node).props['aria-expanded']
  globalThis.__settings={thinkingCollapsed:false}
  const defaultRender=runner(ReplyArea)
  assert.equal(expanded(defaultRender(props)),true)
  globalThis.__settings.thinkingCollapsed=true
  const collapsedRender=runner(ReplyArea)
  let tree=collapsedRender(props)
  assert.equal(expanded(tree),false)
  assert.equal(tree.props.children[1],null)
  title(tree).props.onClick()
  assert.equal(expanded(collapsedRender({...props,view:{...props.view,steps:[...props.view.steps]}})),true)
  assert.equal(expanded(collapsedRender({...props,streaming:false,hasResponse:true})),true)
  globalThis.__settings.thinkingCollapsed=false
  collapsedRender(props)
  assert.equal(expanded(collapsedRender(props)),true)
  globalThis.__settings.thinkingCollapsed=true
  collapsedRender(props)
  assert.equal(expanded(collapsedRender(props)),false)
  checks.push('Actual ReplyArea defaults open, collapse mode starts closed, manual opening survives streamed chunks/completion, and changing the setting updates existing replies')

  const modelReasoningRender=runner(ReplyArea)
  const modelReasoningProps={...props,message:{...props.message,thinking:false}}
  tree=modelReasoningRender(modelReasoningProps)
  assert.equal(expanded(tree),false)
  assert.equal(tree.props.children[1],null)
  title(tree).props.onClick()
  assert.equal(expanded(modelReasoningRender({...modelReasoningProps,streaming:false,hasResponse:true})),true)
  checks.push('Reasoning returned by a model also respects collapse mode when the local thinking request toggle was off')

  const evidence={passed:true,runtime:process.version,checks,scope:'Actual background service/IndexedDB with in-memory browser database and deterministic image/canvas; actual ReplyArea TSX with deterministic hooks. Visual contrast/mobile gallery tested separately by parent.'}
  await writeFile(new URL('./deepstay-appearance-evidence.json',import.meta.url),JSON.stringify(evidence,null,2)+'\n')
  console.log(JSON.stringify(evidence,null,2))
} finally {
  for (const timer of activeTimers) clearInterval(timer)
  globalThis.setInterval = originalSetInterval
  hooks.deregister()
}
