import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
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
    if (url.startsWith(root.href) && url.endsWith('.ts')) return {
      format: 'module', source: stripTypeScriptTypes(readFileSync(new URL(url), 'utf8'), { mode: 'transform' }), shortCircuit: true,
    }
    return nextLoad(url, context)
  },
})

try {
  const { SpeechGate, takeSpeechChunks, isBackchannel, isCallStopPhrase, alignPcm16Chunk, pcmFramesToWav } =
    await import(new URL('services/speech/callLogic.ts', root))
  const frame = (level, samples = 320) => new Int16Array(samples).fill(Math.round(level * 32767))
  const gate = new SpeechGate(600)
  let now = 0
  let events = []
  for (let i = 0; i < 20; i++) {
    now += 20
    events.push(gate.push(frame(0.002), now).event)
  }
  assert.equal(events.some(Boolean), false, 'Quiet room noise does not start a turn')
  for (let i = 0; i < 30; i++) {
    now += 20
    events.push(gate.push(frame(0.09), now).event)
  }
  assert.equal(events.filter(Boolean).at(-1), 'start')
  assert.equal(gate.active, true)
  for (let i = 0; i < 30; i++) {
    now += 20
    events.push(gate.push(frame(0.002), now).event)
  }
  assert.equal(events.filter(Boolean).at(-1), 'end', 'A sustained pause ends a valid utterance')
  assert.equal(gate.active, false)

  const text = '你刚才说要慢一点。那我们从这里继续好吗？'
  const first = takeSpeechChunks(text.slice(0, 10), 0)
  assert.deepEqual(first.chunks, ['你刚才说要慢一点。'])
  const later = takeSpeechChunks(text, first.cursor)
  assert.deepEqual(later.chunks, ['那我们从这里继续好吗？'])
  assert.equal(later.cursor, text.length)
  const max = takeSpeechChunks('长句'.repeat(110), 0, false, 180)
  assert.ok(max.chunks.length >= 1 && max.chunks.every((chunk) => chunk.length <= 180))
  const remainder = takeSpeechChunks('还有一段没标点', 0, true)
  assert.deepEqual(remainder.chunks, ['还有一段没标点'])

  assert.equal(isBackchannel('嗯。'), true)
  assert.equal(isBackchannel('等一下'), false)
  assert.equal(isCallStopPhrase('等一下'), true)
  assert.equal(isCallStopPhrase('我们继续'), false)

  const firstPcmChunk = alignPcm16Chunk(new Uint8Array([1]))
  assert.deepEqual([...firstPcmChunk.bytes], [])
  assert.equal(firstPcmChunk.carry, 1)
  const secondPcmChunk = alignPcm16Chunk(new Uint8Array([2, 3]), firstPcmChunk.carry)
  assert.deepEqual([...secondPcmChunk.bytes], [1, 2])
  assert.equal(secondPcmChunk.carry, 3)
  const finalPcmChunk = alignPcm16Chunk(new Uint8Array([4]), secondPcmChunk.carry)
  assert.deepEqual([...finalPcmChunk.bytes], [3, 4])
  assert.equal(finalPcmChunk.carry, undefined)

  const wav = pcmFramesToWav([frame(0.1, 320)], 320)
  const bytes = new Uint8Array(await wav.arrayBuffer())
  assert.equal(wav.type, 'audio/wav')
  assert.equal(bytes.length, 44 + 320 * 2)
  assert.equal(new TextDecoder().decode(bytes.slice(0, 4)), 'RIFF')
  assert.equal(new DataView(bytes.buffer).getUint32(24, true), 16000)

  console.log(JSON.stringify({
    passed: true,
    checks: [
      'Adaptive PCM gate ignores quiet noise, detects speech onset and closes only after the configured silence',
      'Incremental TTS chunking emits complete sentences once and bounds long chunks while flushing the final fragment',
      'Backchannel and explicit stop phrases are classified independently',
      'Mono 16kHz PCM frames encode as a valid ASR-compatible WAV payload',
    ],
  }, null, 2))
} finally {
  hooks.deregister()
}
