import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { registerHooks, stripTypeScriptTypes } from 'node:module'
import { fileURLToPath } from 'node:url'

const root = new URL('../src/', import.meta.url)
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL?.startsWith(root.href)) {
      const file = new URL(specifier.slice(0, -3) + '.ts', context.parentURL)
      if (existsSync(fileURLToPath(file))) return { url: file.href, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url.startsWith(root.href) && url.endsWith('.ts')) return { format:'module', source:stripTypeScriptTypes(readFileSync(new URL(url),'utf8'),{mode:'transform'}),shortCircuit:true }
    return nextLoad(url, context)
  },
})
const saved = new Map()
globalThis.localStorage = { getItem:key=>saved.get(key)??null, setItem:(key,value)=>saved.set(key,value), removeItem:key=>saved.delete(key) }
Object.defineProperty(globalThis,'navigator',{value:{language:'zh-CN'},configurable:true})
globalThis.__API_ORIGIN__='https://api.deepseek.com'
const settings=await import(new URL('services/settings.ts',root))
const {prepareContextMemory,estimateContextTokens}=await import(new URL('services/chat/contextMemory.ts',root))
const {ApiError}=await import(new URL('services/api/client.ts',root))
const connection={baseUrl:'https://qa-memory.example.test/v1',protocol:'openai'}
const requests=[]
const checks=[]
const stream=(text,finish='stop')=>new Response('data: '+JSON.stringify({id:'summary-qa',choices:[{index:0,delta:{content:text},finish_reason:finish}]})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}})
let respond=()=>stream(`昵称：小鹿。关系：朋友。约定：周五散步。已整理${requests.length}批。`)
globalThis.fetch=async(url,init)=>{const request={url:String(url),init,body:JSON.parse(init.body)};requests.push(request);return respond(request)}
const question={id:'latest',role:'user',content:'我们上次约好什么时候散步？',files:[],createdAt:Date.UTC(2026,10,18)}
const round=(index,user='用户陈述昵称小鹿。'+'当日心情'.repeat(60),answer='助手说愿意耐心陪伴。'+'请慢慢说我在听'.repeat(140))=>[
 {id:`u-${index}`,role:'user',content:user,files:[],createdAt:Date.UTC(2026,10,1)+index*60000},
 {id:`a-${index}`,role:'assistant',model:'qa-model',thinking:false,status:'done',stopReason:'end_turn',prefix:false,blocks:[{type:'text',text:answer}],createdAt:Date.UTC(2026,10,1)+index*60000+1000},
]
const history=Array.from({length:14},(_,i)=>round(i)).flat()
const options={history,question,apiKey:'memory-fixture-key',connection,model:'qa-model',signal:new AbortController().signal}
try {
 assert.equal(settings.useSettings.getState().contextMemoryEnabled,false)
 settings.setContextMemoryEnabled(true)
 const cold=await import(new URL('services/settings.ts?memory-cold',root))
 assert.equal(cold.useSettings.getState().contextMemoryEnabled,true)
 const short=await prepareContextMemory({...options,history:round(0,'你好','我在'),memory:{fixed:'称呼：小鹿。'}})
 assert.equal(requests.length,0)
 assert.ok(short.systemMemory.includes('称呼：小鹿'))
 assert.deepEqual(short.history,round(0,'你好','我在'))
 checks.push('Compression defaults off and persists opt-in; short chats use pinned memory without making a summary call')

 const snapshot=JSON.stringify(history)
 const progress=[]
 const first=await prepareContextMemory({...options,memory:{fixed:'昵称：小鹿。'},onProgress:value=>progress.push(value)})
 assert.ok(requests.length>1)
 assert.ok(first.memoryPatch.cache.summary)
 assert.ok(first.history.length>=4&&first.history.length<=16)
 assert.equal(first.history.length%2,0)
 assert.deepEqual(first.history,history.slice(-first.history.length))
 assert.equal(JSON.stringify(history),snapshot)
 assert.ok(progress.some(value=>value.completed===value.total&&value.total>0))
 for(const {url,init,body}of requests){
  assert.equal(url,'https://qa-memory.example.test/v1/chat/completions')
  assert.equal(new Headers(init.headers).get('Authorization'),'Bearer memory-fixture-key')
  assert.equal(body.model,'qa-model');assert.equal(body.max_tokens,2048)
  assert.ok(!('tools'in body));assert.ok(!('thinking'in body))
  assert.ok(body.messages[0].content.includes('矛盾'));assert.ok(body.messages[0].content.includes('不要补全没有出现'))
 }
 assert.ok(requests[1].body.messages[1].content.includes('[已有摘要]'))
 const originalTokens=history.reduce((total,message)=>total+estimateContextTokens(message.role==='user'?message.content:message.blocks.map(block=>block.text??'').join('')),estimateContextTokens(question.content))
 const compressedTokens=first.history.reduce((total,message)=>total+estimateContextTokens(message.role==='user'?message.content:message.blocks.map(block=>block.text??'').join('')),estimateContextTokens(question.content+first.systemMemory))
 assert.ok(compressedTokens<originalTokens/2)
 checks.push('Long chats summarize all older text in bounded batches with the selected URL/key/model, retain complete recent rounds and original logs, and cap each summary at 2048 output tokens')

 const relationshipFacts=[
  '用户明确喜欢被称为“小鹿”，并称呼助手“阿舟”。',
  '用户说明两人现实中只是聊天对象，“恋人”仅是虚构角色扮演设定。',
  '用户明确不喜欢被叫“宝贝”，希望先听完再回答。',
  '2026-11-01 面试失败后用户难过，用户说明简短陪伴和先倾听比立刻给建议更有帮助。',
  '助手在2026-11-02 承诺于周五一起复盘面试；当前仍未完成。',
  '用户先说复盘日为周五，随后于2026-11-03 明确更正为周六；当前以周六为准。',
 ]
 const relationshipHistory=relationshipFacts.flatMap((fact,index)=>[
  {id:`rel-u-${index}`,role:'user',content:`${index===4?'我们聊到约定时，我想确认你是不是会记得。':fact}\n${'闲聊'.repeat(700)}`,files:[],createdAt:Date.UTC(2026,10,1)+index*60000},
  {id:`rel-a-${index}`,role:'assistant',model:'qa-model',thinking:false,status:'done',stopReason:'end_turn',prefix:false,blocks:[{type:'text',text:`${index===4?fact:'我听见了，会继续陪你聊。'}\n${'陪伴'.repeat(700)}`}],createdAt:Date.UTC(2026,10,1)+index*60000+1000},
 ])
 for(let index=0;index<3;index++) relationshipHistory.push(...round(30+index,`用户日常分享。${'闲聊'.repeat(700)}`,`助手倾听回应。${'陪伴'.repeat(700)}`))
 const previousRespond=respond
 respond=({body})=>{
  const prompt=body.messages[1].content
  const previous=prompt.match(/\[已有摘要\]\n([\s\S]*?)\n\n\[新增原始记录\]/)?.[1].split('\n').filter(Boolean)??[]
  const current=relationshipFacts.filter(fact=>prompt.includes(fact))
  return stream([...new Set([...previous,...current])].join('\n'))
 }
 const beforeRelationship=requests.length
 let relationship
 try {
  relationship=await prepareContextMemory({...options,history:relationshipHistory})
 } finally {
  respond=previousRespond
 }
 const relationshipRequests=requests.slice(beforeRelationship)
 assert.ok(relationshipRequests.length>1)
 assert.ok(relationshipRequests[0].body.messages[0].content.includes('情绪脉络与有效回应'))
 assert.ok(relationshipFacts.every(fact=>relationshipRequests.some(request=>request.body.messages[1].content.includes(fact))))
 assert.ok(relationshipFacts.every(fact=>relationship.systemMemory.includes(fact)))
 assert.ok(relationshipRequests.slice(1).some(request=>request.body.messages[1].content.includes('[已有摘要]')))
 checks.push('Synthetic relationship continuity: the compressor receives distinct user/assistant facts across batches and the rolling summary carries forward names, roleplay boundaries, support preferences, dated events, an assistant promise, and an explicit correction')

 const afterFirst=requests.length
 const reused=await prepareContextMemory({...options,memory:first.memoryPatch})
 assert.equal(requests.length,afterFirst)
 assert.equal(reused.memoryPatch,undefined)
 assert.equal(reused.systemMemory,first.systemMemory)
 const beforeEmpty=requests.length
 await prepareContextMemory({...options,memory:{...first.memoryPatch,cache:{...first.memoryPatch.cache,summary:''}}})
 assert.ok(requests.length>beforeEmpty)
 assert.ok(requests[beforeEmpty].body.messages[1].content.includes('u-0 ·'))
 const beforeExtended=requests.length
 const extended=await prepareContextMemory({...options,history:[...history,...round(14),...round(15)],memory:first.memoryPatch})
 assert.ok(requests.length>beforeExtended)
 assert.ok(requests[beforeExtended].body.messages[1].content.includes('[已有摘要]'))
 assert.ok(!requests[beforeExtended].body.messages[1].content.includes('u-0 ·'))
 assert.ok(extended.memoryPatch.cache.source.length>first.memoryPatch.cache.source.length)
 checks.push('A valid source-ID/SHA-256/provider/model cache costs no extra call; additional old turns extend the summary instead of resending already summarized records')

 const beforeEdit=requests.length
 const edited=structuredClone(history);edited[0].content+='这条是用户编辑的新信息'
 await prepareContextMemory({...options,history:edited,memory:first.memoryPatch})
 assert.ok(requests.length>beforeEdit)
 assert.ok(requests[beforeEdit].body.messages[1].content.includes('这条是用户编辑的新信息'))
 const branch=structuredClone(history);branch[0].id='alternate-branch'
 const beforeBranch=requests.length
 await prepareContextMemory({...options,history:branch,memory:first.memoryPatch})
 assert.ok(requests[beforeBranch].body.messages[1].content.includes('alternate-branch'))
 const beforeProvider=requests.length
 await prepareContextMemory({...options,connection:{...connection,baseUrl:'https://other-memory.example.test/v1'},model:'other-model',memory:first.memoryPatch})
 assert.ok(requests.length>beforeProvider)
 assert.equal(requests[beforeProvider].body.model,'other-model')
 assert.equal(requests[beforeProvider].url,'https://other-memory.example.test/v1/chat/completions')
 const shortened=await prepareContextMemory({...options,history:round(0,'short','reply'),memory:first.memoryPatch})
 assert.deepEqual(shortened.memoryPatch,{fixed:'昵称：小鹿。'})
 checks.push('Editing source text, changing branch IDs or changing provider/model invalidates summaries; a shortened branch clears the stale cache')

 let beforeFailure=requests.length
 respond=()=>new Response('{"error":{"message":"fixture failure"}}',{status:401,headers:{'content-type':'application/json'}})
 await assert.rejects(prepareContextMemory(options),error=>error instanceof ApiError&&error.localMessage?.key==='contextMemoryFailed')
 assert.equal(requests.length,beforeFailure+1)
 respond=()=>stream('incomplete','length')
 await assert.rejects(prepareContextMemory(options),error=>error.localMessage?.key==='contextMemoryFailed')
 respond=()=>stream('')
 await assert.rejects(prepareContextMemory(options),error=>error.localMessage?.key==='contextMemoryFailed')
 respond=()=>stream('过长'.repeat(3000))
 await assert.rejects(prepareContextMemory(options),error=>error.localMessage?.key==='contextMemoryFailed')
 assert.equal(JSON.stringify(history),snapshot)
 checks.push('HTTP failure, truncated/empty/oversized summaries fail explicitly without emitting a full-context chat request or altering original logs')

 const abort=new AbortController()
 let release
 const fetched=new Promise(resolve=>release=resolve)
 respond=({init})=>{release();return new Promise((_,reject)=>init.signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true}))}
 const cancelPending=prepareContextMemory({...options,signal:abort.signal})
 await fetched;abort.abort()
 await assert.rejects(cancelPending,error=>error.name==='AbortError')
 const cancelled=new AbortController();cancelled.abort()
 beforeFailure=requests.length
 await assert.rejects(prepareContextMemory({...options,signal:cancelled.signal}),error=>error.name==='AbortError')
 assert.equal(requests.length,beforeFailure)
 await assert.rejects(prepareContextMemory({...options,history:[],signal:cancelled.signal}),error=>error.name==='AbortError')
 assert.equal(requests.length,beforeFailure)
 const hugeHistory=[...round(0,'字'.repeat(100000),'回答'),...round(1,'你好','在的'),...round(2,'继续','好的')]
 await assert.rejects(prepareContextMemory({...options,history:hugeHistory}),error=>error.localMessage?.key==='contextMemorySourceTooLarge')
 assert.equal(requests.length,beforeFailure)
 checks.push('Stop cancels an in-flight summary and pre-cancelled requests make no network call')

 respond=()=>stream('昵称：小鹿。关系：朋友。约定：周五散步。')
 beforeFailure=requests.length
 await assert.rejects(prepareContextMemory({...options,history:[],question:{...question,content:'字'.repeat(20000)}}),error=>error.localMessage?.key==='contextMemoryTooLarge')
 await assert.rejects(prepareContextMemory({...options,history:[...history,...round(20,'字'.repeat(9000),'答'.repeat(9000))]}),error=>error.localMessage?.key==='contextMemoryTooLarge')
 const longPrefix={...round(99)[1],prefix:true,blocks:[{type:'text',text:'续'.repeat(17000)}]}
 await assert.rejects(prepareContextMemory({...options,history:[],prefix:longPrefix}),error=>error.localMessage?.key==='contextMemoryTooLarge')
 const longThinking={...longPrefix,blocks:[{type:'thinking',thinking:'思'.repeat(17000),signature:'fixture-signature'}]}
 await assert.rejects(prepareContextMemory({...options,history:[],prefix:longThinking}),error=>error.localMessage?.key==='contextMemoryTooLarge')
 const reminderHistory=round(77,'简短问题','简短回答');reminderHistory[1].latestReminder='旧'.repeat(17000)
 await assert.rejects(prepareContextMemory({...options,history:reminderHistory}),error=>error.localMessage?.key==='contextMemoryTooLarge')
 assert.equal(requests.length,beforeFailure)
 const giantHistory=[...round(0,'首'.repeat(10000)+'末尾标记','回答'),...round(1,'你好','在的'),...round(2,'继续','好的')]
 const beforeGiant=requests.length
 // Raise total history above the trigger while keeping the recent two turns small.
 giantHistory[0].content+='字'.repeat(8000)
 const giant=await prepareContextMemory({...options,history:giantHistory})
 assert.ok(requests.length-beforeGiant>=4)
 assert.ok(requests.slice(beforeGiant).some(request=>request.body.messages[1].content.includes('末尾标记')))
 assert.ok(requests.slice(beforeGiant).every(request=>/u-0 · part \d+/.test(request.body.messages[1].content)))
 assert.equal(giant.history.length,4)
 assert.ok(estimateContextTokens('中文')>estimateContextTokens('en'))
 checks.push('Oversized current/recent turns, continuation text/thinking and historical reminder snapshots are rejected before charging; more than 16 pending batches also fail explicitly. An oversized old message within budget retains every labelled fragment without silent truncation')

 // Exercise the real send path with two chats, not just the compressor function.
 await import('fake-indexeddb/auto')
 globalThis.window=new EventTarget()
 globalThis.document=Object.assign(new EventTarget(),{visibilityState:'visible'})
 globalThis.requestAnimationFrame=callback=>setTimeout(callback,0)
 globalThis.cancelAnimationFrame=clearTimeout
 const db=await import(new URL('services/chat/db.ts',root))
 const store=await import(new URL('services/chat/store.ts',root))
 const drafts=await import(new URL('services/chat/drafts.ts',root))
 settings.setApiConnection({apiKey:'memory-fixture-key',apiBaseUrl:connection.baseUrl,apiProtocol:'openai',model:'qa-model',models:['qa-model']})
 const fixedA='角色A：阿青的旅行搭子。约定周五去看海。'
 const fixedB='角色B：队长的星际领航员。约定周日观星。'
 const originalLog=history.map(message=>message.role==='user'?message.content:message.blocks[0].text)
 for(const [id,fixed]of [['chat-a',fixedA],['chat-b',fixedB]]){
  await db.saveSession({id,title:id,createdAt:1,updatedAt:1,messages:structuredClone(history),contextMemory:{fixed}})
 }
 await store.initChat()
 const wait=async predicate=>{
  const deadline=Date.now()+5000
  while(!await predicate()){
   if(Date.now()>deadline)throw new Error('Store memory integration timed out')
   await new Promise(resolve=>setTimeout(resolve,5))
  }
 }
 const sent=[]
 const summaryCallCount=requests.length
 respond=request=>{
  if(request.body.messages[0].content.includes('你只负责整理已有聊天记录'))return stream('昵称：阿青。约定：周五去看海。')
  sent.push(request.body)
  return stream('我们约好周五去看海。')
 }
 store.selectSession('chat-a')
 await wait(()=>store.useChatStore.getState().sessionCache['chat-a'])
 drafts.setDraftText('chat-a','我们的约定是什么？')
 assert.equal(store.sendMessage('chat-a'),true)
 await wait(()=>!store.useChatStore.getState().streaming['chat-a'])
 assert.equal(sent.length,1)
 assert.ok(requests.length>summaryCallCount+1)
 const system=sent[0].messages.filter(message=>message.role==='system').map(message=>message.content).join('\n')
 assert.ok(system.includes(fixedA));assert.ok(system.includes('周五去看海'))
 assert.ok(!system.includes(fixedB))
 await wait(async()=>!!(await db.loadSession('chat-a')).contextMemory.cache)
 const storedA=await db.loadSession('chat-a')
 assert.deepEqual(storedA.messages.slice(0,history.length).map(message=>message.role==='user'?message.content:message.blocks[0].text),originalLog)
 assert.equal(storedA.messages.at(-1).blocks[0].text,'我们约好周五去看海。')
 assert.deepEqual((await db.loadSession('chat-b')).contextMemory,{fixed:fixedB})
 assert.ok(sent[0].messages.length<history.length)
 checks.push('The real store send path summarizes and persists chat A, sends only A’s pinned memory and summary, retains original logs and a full recent tail, and leaves chat B’s different memory untouched')

 await writeFile(new URL('deepstay-context-memory-evidence.json',import.meta.url),JSON.stringify({passed:true,runtime:process.version,checks,summaryRequests:requests.length-sent.length,estimatedInput:{original:originalTokens,compressed:compressedTokens},scope:'Real compression service, OpenAI adapter and SSE parser with deterministic fixture responses. No paid upstream calls; semantic recall quality requires real-model evaluation.'},null,2))
 console.log(JSON.stringify({passed:true,checks,summaryRequests:requests.length-sent.length},null,2))
} finally {hooks.deregister()}
