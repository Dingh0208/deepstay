export type SpeechGateEvent = 'start' | 'end'

const SAMPLE_RATE = 16_000
const MIN_UTTERANCE_MS = 350
const START_HOLD_MS = 100
const MIN_NOISE_FLOOR = 0.004
const MIN_THRESHOLD = 0.012

/** Adaptive energy gate for 20 ms mono PCM frames after platform echo cancellation. */
export class SpeechGate {
  private noiseFloor = MIN_NOISE_FLOOR
  private aboveThresholdMs = 0
  private silenceMs = 0
  private startedAt = 0
  private speaking = false

  constructor(private readonly pauseMs = 600) {}

  get active() {
    return this.speaking
  }

  get utteranceDurationMs() {
    return this.speaking ? this.silenceMs + this.speechMs : 0
  }

  private speechMs = 0

  reset() {
    this.aboveThresholdMs = 0
    this.silenceMs = 0
    this.speechMs = 0
    this.startedAt = 0
    this.speaking = false
  }

  push(samples: Int16Array, now: number): { level: number; event?: SpeechGateEvent } {
    if (samples.length === 0) {
      return { level: 0 }
    }
    let energy = 0
    for (const sample of samples) {
      const normalized = sample / 32768
      energy += normalized * normalized
    }
    const level = Math.sqrt(energy / samples.length)
    const frameMs = samples.length / SAMPLE_RATE * 1000
    const threshold = Math.max(MIN_THRESHOLD, this.noiseFloor * 2.8 + 0.003)

    if (!this.speaking) {
      if (level >= threshold) {
        this.aboveThresholdMs += frameMs
        if (this.aboveThresholdMs >= START_HOLD_MS) {
          this.speaking = true
          this.startedAt = now - this.aboveThresholdMs
          this.speechMs = this.aboveThresholdMs
          this.silenceMs = 0
          this.aboveThresholdMs = 0
          return { level, event: 'start' }
        }
      } else {
        this.aboveThresholdMs = 0
        this.noiseFloor = Math.max(MIN_NOISE_FLOOR, this.noiseFloor * 0.96 + level * 0.04)
      }
      return { level }
    }

    if (level >= threshold) {
      this.speechMs += frameMs
      this.silenceMs = 0
      return { level }
    }

    this.silenceMs += frameMs
    if (this.silenceMs >= this.pauseMs) {
      const duration = now - this.startedAt - this.silenceMs
      this.reset()
      return { level, ...(duration >= MIN_UTTERANCE_MS ? { event: 'end' as const } : {}) }
    }
    return { level }
  }
}

const SENTENCE_END = /[,.!?;:，。！？；：、\n]/

/** Take complete speakable chunks from an incrementally growing assistant reply. */
export const takeSpeechChunks = (
  text: string,
  cursor: number,
  flush = false,
  maxChars = 180
): { chunks: string[]; cursor: number } => {
  const chunks: string[] = []
  let next = Math.max(0, Math.min(cursor, text.length))
  while (next < text.length) {
    const remaining = text.slice(next)
    const boundary = [...remaining.matchAll(new RegExp(SENTENCE_END.source, 'g'))]
      .find((match) => (match.index ?? 0) + match[0].length >= 8)
    let end = boundary ? next + (boundary.index ?? 0) + boundary[0].length : -1
    if (end < 0 && remaining.length >= maxChars) {
      end = next + maxChars
      if (text.charCodeAt(end - 1) >= 0xd800 && text.charCodeAt(end - 1) <= 0xdbff) {
        end -= 1
      }
    }
    if (end < 0 && flush) {
      end = text.length
    }
    if (end < 0) {
      break
    }
    const chunk = text.slice(next, end).trim()
    if (chunk) {
      chunks.push(chunk)
    }
    next = end
    while (next < text.length && /\s/.test(text[next])) {
      next += 1
    }
  }
  return { chunks, cursor: next }
}

export const isBackchannel = (text: string) =>
  /^(?:嗯+|啊+|对+|好的?|好+|是的?|知道了|ok(?:ay)?|yeah|right)[。！!？?\s]*$/i.test(text.trim())

export const isCallStopPhrase = (text: string) =>
  /^(?:停|等一下|等等|别说了|先停一下|stop|wait)[。！!？?\s]*$/i.test(text.trim())

export const alignPcm16Chunk = (chunk: Uint8Array, carry?: number) => {
  const merged = new Uint8Array(chunk.length + (carry === undefined ? 0 : 1))
  if (carry !== undefined) {
    merged[0] = carry
    merged.set(chunk, 1)
  } else {
    merged.set(chunk)
  }
  const alignedLength = merged.length - (merged.length % 2)
  return {
    bytes: merged.subarray(0, alignedLength),
    carry: alignedLength < merged.length ? merged[merged.length - 1] : undefined,
  }
}

export const pcmFramesToWav = (frames: readonly Int16Array[], sampleCount: number): Blob => {
  const count = Math.max(0, Math.min(sampleCount, Math.floor(SAMPLE_RATE * 120)))
  const buffer = new ArrayBuffer(44 + count * 2)
  const view = new DataView(buffer)
  const write = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) {view.setUint8(offset + i, value.charCodeAt(i))}
  }
  write(0, 'RIFF')
  view.setUint32(4, 36 + count * 2, true)
  write(8, 'WAVE')
  write(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, SAMPLE_RATE, true)
  view.setUint32(28, SAMPLE_RATE * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  write(36, 'data')
  view.setUint32(40, count * 2, true)
  let offset = 44
  let written = 0
  for (const frame of frames) {
    const length = Math.min(frame.length, count - written)
    for (let i = 0; i < length; i++, written++) {
      view.setInt16(offset, frame[i], true)
      offset += 2
    }
    if (written === count) {break}
  }
  return new Blob([buffer], { type: 'audio/wav' })
}
