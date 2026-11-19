import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { registerHooks, stripTypeScriptTypes } from 'node:module'
import { fileURLToPath } from 'node:url'

const root = new URL('../src/', import.meta.url)
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier.startsWith('.') &&
      specifier.endsWith('.js') &&
      context.parentURL?.startsWith(root.href)
    ) {
      const file = new URL(specifier.slice(0, -3) + '.ts', context.parentURL)
      if (existsSync(fileURLToPath(file))) return { url: file.href, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url.startsWith(root.href) && url.endsWith('.ts')) {
      return {
        format: 'module',
        source: stripTypeScriptTypes(readFileSync(new URL(url), 'utf8'), { mode: 'transform' }),
        shortCircuit: true,
      }
    }
    return nextLoad(url, context)
  },
})
await import('fake-indexeddb/auto')
const storage = new Map()
globalThis.localStorage = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, value),
  removeItem: (key) => storage.delete(key),
}
globalThis.window = new EventTarget()
globalThis.document = Object.assign(new EventTarget(), { visibilityState: 'visible' })
globalThis.__API_ORIGIN__ = 'https://api.deepseek.com'
globalThis.requestAnimationFrame = (callback) => setTimeout(callback, 0)
globalThis.cancelAnimationFrame = clearTimeout

const audio = []
let autoplayAllowed = true
globalThis.AudioContext = class {
  state = 'suspended'
  currentTime = 0
  constructor() {
    audio.push(this)
  }
  async resume() {
    if (autoplayAllowed) this.state = 'running'
  }
  async close() {
    this.state = 'closed'
  }
  createBuffer() {
    return { duration: 0.5, copyToChannel() {} }
  }
  createBufferSource() {
    this.source = { connect() {}, start() {} }
    return this.source
  }
}
const settings = await import(new URL('services/settings.ts', root))
const chat = await import(new URL('services/chat/store.ts', root))
const drafts = await import(new URL('services/chat/drafts.ts', root))
const speech = await import(new URL('services/speech/readAloud.ts', root))
const { bindAutoReadAloud } = await import(new URL('services/speech/autoReadAloud.ts', root))
const calls = []
let release
let releaseEnd
let pauseAfterText = false
const speak = 'Visible reply for read aloud.'
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body)
  if (String(url).endsWith('/v1/tools/tts')) {
    calls.push(body.text)
    return new Response(new Uint8Array([0, 0, 0, 0]))
  }
  await new Promise((resolve) => {
    release = resolve
  })
  if (String(url).endsWith('/chat/completions')) {
    return new Response(
      'data: ' +
        JSON.stringify({
          id: 'reply',
          choices: [{ index: 0, delta: { content: speak }, finish_reason: 'stop' }],
        }) +
        '\n\ndata: [DONE]\n\n',
      { headers: { 'Content-Type': 'text/event-stream' } }
    )
  }
  const events = [
    { type: 'message_start', message: { id: 'reply', model: body.model } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: speak } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
    { type: 'message_stop' },
  ]
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event) =>
        controller.enqueue(new TextEncoder().encode('data: ' + JSON.stringify(event) + '\n\n'))
      events.slice(0, 2).forEach(send)
      if (pauseAfterText)
        await new Promise((resolve) => {
          releaseEnd = resolve
        })
      events.slice(2).forEach(send)
      controller.close()
    },
  })
  return new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream' },
  })
}
const wait = async (predicate) => {
  const deadline = performance.now() + 5000
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error('Timed out waiting for fixture')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}
const state = () => chat.useChatStore.getState()
const send = async (id) => {
  release = undefined
  drafts.setDraftText(id, 'Reply with fixture')
  assert.equal(chat.sendMessage(id), true)
  await wait(() => release)
  return state().activeId
}
const settle = async (id) => {
  release()
  await wait(() => !state().streaming[id])
}

assert.equal(settings.useSettings.getState().autoReadAloud, false)
const unbind = bindAutoReadAloud()
try {
  await chat.initChat()
  settings.setApiConnection({
    apiKey: 'fixture-key',
    apiBaseUrl: __API_ORIGIN__,
    apiProtocol: 'deepseek',
    model: 'deepseek-flash',
  })
  const id = await send(null)
  await settle(id)
  assert.deepEqual(calls, [])
  assert.equal(audio.length, 0)

  settings.setAutoReadAloud(true)
  pauseAfterText = true
  await send(id)
  assert.equal(audio.at(-1).state, 'running')
  assert.deepEqual(calls, [])
  release()
  await wait(() => state().sessionCache[id].messages.at(-1).status === 'streaming')
  assert.deepEqual(calls, [])
  pauseAfterText = false
  releaseEnd()
  await wait(() => audio.at(-1).source?.onended)
  assert.deepEqual(calls, [speak])
  assert.equal(speech.useReadAloud.getState().status, 'playing')
  assert.equal(
    speech.useReadAloud.getState().messageId,
    state().sessionCache[id].messages.at(-1).id
  )
  settings.setAutoReadAloud(false)
  assert.equal(audio.at(-1).state, 'closed')
  assert.equal(speech.useReadAloud.getState().status, 'idle')

  speech.toggleReadAloud('manual', speak, (error) => {
    throw error
  })
  await wait(() => audio.at(-1).source?.onended)
  settings.setAutoReadAloud(true)
  settings.setAutoReadAloud(false)
  assert.equal(speech.useReadAloud.getState().messageId, 'manual')
  speech.toggleReadAloud('manual', speak, (error) => {
    throw error
  })
  assert.equal(speech.useReadAloud.getState().status, 'idle')
  assert.deepEqual(calls, [speak, speak])

  for (const interrupt of [
    () => settings.setAutoReadAloud(false),
    () => chat.stopReply(id),
    () => {
      chat.newChat()
      chat.selectSession(id)
    },
    () => {
      document.visibilityState = 'hidden'
      document.dispatchEvent(new Event('visibilitychange'))
      document.visibilityState = 'visible'
    },
    () =>
      settings.setApiConnection({
        apiKey: 'different-fixture-key',
        apiBaseUrl: __API_ORIGIN__,
        apiProtocol: 'deepseek',
        model: 'deepseek-flash',
      }),
  ]) {
    settings.setAutoReadAloud(true)
    await send(id)
    const prepared = audio.at(-1)
    interrupt()
    await settle(id)
    assert.equal(prepared.state, 'closed')
    assert.deepEqual(calls, [speak, speak])
  }

  autoplayAllowed = false
  await send(id)
  await settle(id)
  assert.equal(audio.at(-1).state, 'closed')
  assert.deepEqual(calls, [speak, speak])

  autoplayAllowed = true
  const used = audio.length
  settings.setApiConnection({
    apiKey: 'relay-fixture',
    apiBaseUrl: 'https://relay.example.test',
    apiProtocol: 'openai',
    model: 'fixture',
  })
  await send(id)
  await settle(id)
  assert.equal(audio.length, used)
  assert.deepEqual(calls, [speak, speak])
  console.log(
    'Auto read-aloud: passed default-off, one foreground completion, manual playback, cancellation, autoplay prevention, and compatible-provider isolation.'
  )
} finally {
  unbind()
  speech.stopReadAloud()
  hooks.deregister()
}
