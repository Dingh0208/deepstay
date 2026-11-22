import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core'

type NativeCallAudio = {
  start(): Promise<{ sampleRate: number; frameSamples: number; echoCancellation: boolean; noiseSuppression: boolean }>
  stop(): Promise<void>
  setMuted(options: { muted: boolean }): Promise<void>
  setSpeaker(options: { speaker: boolean }): Promise<void>
  write(options: { pcm: string }): Promise<{ interrupted: boolean; samplesWritten: number }>
  setPlaybackGain(options: { value: number }): Promise<void>
  stopPlayback(): Promise<{ samplesPlayed: number }>
  addListener(event: 'audioFrame', listener: (event: AudioFrame) => void): Promise<PluginListenerHandle>
  addListener(event: 'playLevel', listener: (event: PlayLevel) => void): Promise<PluginListenerHandle>
  addListener(event: 'audioError', listener: (event: { code?: string }) => void): Promise<PluginListenerHandle>
}

export type AudioFrame = { pcm: string; samples: number; sampleRate: number; level: number; sequence: number }
export type PlayLevel = { samplesPlayed: number; sampleRate: number; sequence: number }
export type CallAudioHandlers = {
  onFrame(frame: AudioFrame): void
  onPlayback(level: PlayLevel): void
  onError(code?: string): void
}

const nativeAudio = registerPlugin<NativeCallAudio>('CallAudio')
const decodeBase64 = (value: string) => {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {bytes[i] = binary.charCodeAt(i)}
  return bytes
}
const encodeBase64 = (bytes: Uint8Array) => {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + 0x8000, bytes.length)))
  }
  return btoa(binary)
}
const toPcm16 = (samples: Float32Array) => {
  const pcm = new Int16Array(samples.length)
  for (let i = 0; i < samples.length; i++) {
    const sample = Math.max(-1, Math.min(1, samples[i]))
    pcm[i] = Math.round(sample * (sample < 0 ? 32768 : 32767))
  }
  return pcm
}

/** Capacitor audio bridge on Android; Web Audio capture/playback in browser previews. */
export class CallAudioSession {
  private native = Capacitor.isPluginAvailable('CallAudio')
  private listeners: PluginListenerHandle[] = []
  private nativeSamplesWritten = 0
  private nativeSamplesPlayed = 0
  private stopped = false
  private media?: MediaStream
  private captureContext?: AudioContext
  private captureSource?: MediaStreamAudioSourceNode
  private captureProcessor?: ScriptProcessorNode
  private captureAnalyser?: AnalyserNode
  private frameTail = new Int16Array(0)
  private muted = false
  private sequence = 0
  private playbackContext?: AudioContext
  private playbackGain?: GainNode
  private nextPlaybackTime = 0
  private playedSamples = 0
  private playbackTimer?: ReturnType<typeof setInterval>
  private playbackSources = new Set<AudioBufferSourceNode>()
  private playedSegments: { start: number; end: number; samples: number }[] = []
  private playbackInterrupted = false

  async start(handlers: CallAudioHandlers) {
    if (this.native) {
      this.nativeSamplesWritten = 0
      this.nativeSamplesPlayed = 0
      this.stopped = false
      this.listeners = await Promise.all([
        nativeAudio.addListener('audioFrame', handlers.onFrame),
        nativeAudio.addListener('playLevel', (level) => {
          this.nativeSamplesPlayed = Math.max(this.nativeSamplesPlayed, level.samplesPlayed)
          handlers.onPlayback(level)
        }),
        nativeAudio.addListener('audioError', ({ code }) => handlers.onError(code)),
      ])
      const result = await nativeAudio.start()
      return { ...result, native: true as const, supportsSpeaker: true }
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new DOMException('Microphone capture is unavailable', 'NotFoundError')
    }
    this.media = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    })
    try {
      this.captureContext = new AudioContext({ sampleRate: 16_000 })
      this.captureSource = this.captureContext.createMediaStreamSource(this.media)
      this.captureAnalyser = this.captureContext.createAnalyser()
      this.captureProcessor = this.captureContext.createScriptProcessor(1024, 1, 1)
      this.captureProcessor.onaudioprocess = (event) => {
        if (this.muted) {return}
        const input = toPcm16(event.inputBuffer.getChannelData(0))
        const merged = new Int16Array(this.frameTail.length + input.length)
        merged.set(this.frameTail)
        merged.set(input, this.frameTail.length)
        let offset = 0
        while (offset + 320 <= merged.length) {
          const frame = merged.slice(offset, offset + 320)
          let sum = 0
          for (const sample of frame) {sum += (sample / 32768) ** 2}
          handlers.onFrame({
            pcm: encodeBase64(new Uint8Array(frame.buffer)),
            samples: frame.length,
            sampleRate: 16_000,
            level: Math.sqrt(sum / frame.length),
            sequence: ++this.sequence,
          })
          offset += 320
        }
        this.frameTail = merged.slice(offset)
      }
      this.captureSource.connect(this.captureAnalyser)
      this.captureAnalyser.connect(this.captureProcessor)
      this.captureProcessor.connect(this.captureContext.destination)
      if (this.captureContext.state === 'suspended') {await this.captureContext.resume()}
      return { sampleRate: 16_000, frameSamples: 320, echoCancellation: true, noiseSuppression: true, native: false as const, supportsSpeaker: false }
    } catch (error) {
      await this.stop()
      throw error
    }
  }

  async setMuted(muted: boolean) {
    this.muted = muted
    if (this.native) {await nativeAudio.setMuted({ muted })}
  }

  async setSpeaker(speaker: boolean) {
    if (this.native) {await nativeAudio.setSpeaker({ speaker })}
  }

  async setPlaybackGain(value: number) {
    const gain = Math.max(0, Math.min(1, value))
    if (this.native) {
      await nativeAudio.setPlaybackGain({ value: gain })
    } else if (this.playbackGain) {
      this.playbackGain.gain.setTargetAtTime(gain, this.playbackContext?.currentTime ?? 0, 0.04)
    }
  }

  async writePcm(bytes: Uint8Array) {
    if (this.native) {
      const result = await nativeAudio.write({ pcm: encodeBase64(bytes) })
      this.nativeSamplesWritten += result.samplesWritten
      return result
    }
    const samples = new Int16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength - bytes.byteLength % 2))
    if (!samples.length) {return { interrupted: this.playbackInterrupted, samplesWritten: 0 }}
    this.playbackInterrupted = false
    const context = this.getPlaybackContext()
    const gain = this.playbackGain
    if (!gain) {
      throw new Error('Call playback is unavailable')
    }
    const floats = new Float32Array(samples.length)
    for (let i = 0; i < samples.length; i++) {floats[i] = samples[i] / 32768}
    const buffer = context.createBuffer(1, floats.length, 24_000)
    buffer.copyToChannel(floats, 0)
    const source = context.createBufferSource()
    source.buffer = buffer
    source.connect(gain)
    const start = Math.max(this.nextPlaybackTime, context.currentTime + 0.025)
    const end = start + buffer.duration
    const segment = { start, end, samples: floats.length }
    this.playedSegments.push(segment)
    this.nextPlaybackTime = end
    this.playbackSources.add(source)
    source.onended = () => this.playbackSources.delete(source)
    source.start(start)
    return { interrupted: this.playbackInterrupted, samplesWritten: floats.length }
  }

  async stopPlayback() {
    this.playbackInterrupted = true
    if (this.native) {return nativeAudio.stopPlayback()}
    for (const source of this.playbackSources) {
      try { source.stop() } catch { /* A source can finish between the set snapshot and stop. */ }
    }
    this.playbackSources.clear()
    return { samplesPlayed: this.webSamplesPlayed() }
  }

  async flushPlayback() {
    if (this.native) {
      const target = this.nativeSamplesWritten
      while (!this.stopped && this.nativeSamplesPlayed < target) {
        await new Promise((resolve) => setTimeout(resolve, 40))
      }
      return { samplesPlayed: this.nativeSamplesPlayed }
    }
    await this.waitForPlayback()
    return { samplesPlayed: this.webSamplesPlayed() }
  }

  async stop() {
    this.stopped = true
    for (const listener of this.listeners.splice(0)) {await listener.remove().catch(() => {})}
    if (this.native) {
      await nativeAudio.stop().catch(() => {})
      return
    }
    clearInterval(this.playbackTimer)
    this.playbackTimer = undefined
    this.captureProcessor && (this.captureProcessor.onaudioprocess = null)
    for (const node of [this.captureProcessor, this.captureAnalyser, this.captureSource]) {
      try { node?.disconnect() } catch { /* Continue releasing other audio resources. */ }
    }
    for (const source of this.playbackSources) {
      try { source.stop() } catch { /* Already stopped sources need no further cleanup. */ }
    }
    this.playbackSources.clear()
    this.media?.getTracks().forEach((track) => track.stop())
    this.media = undefined
    await Promise.all([this.captureContext?.close().catch(() => {}), this.playbackContext?.close().catch(() => {})])
    this.captureContext = undefined
    this.playbackContext = undefined
    this.playbackGain = undefined
    this.playedSegments = []
    this.frameTail = new Int16Array(0)
  }

  private getPlaybackContext() {
    if (!this.playbackContext) {
      this.playbackContext = new AudioContext({ sampleRate: 24_000 })
      this.playbackGain = this.playbackContext.createGain()
      this.playbackGain.connect(this.playbackContext.destination)
      this.nextPlaybackTime = this.playbackContext.currentTime
      this.playbackTimer = setInterval(() => {
        this.webSamplesPlayed()
      }, 40)
    }
    return this.playbackContext
  }

  private webSamplesPlayed() {
    const now = this.playbackContext?.currentTime ?? 0
    let total = 0
    for (const segment of this.playedSegments) {
      const elapsed = Math.max(0, Math.min(segment.end - segment.start, now - segment.start))
      total += Math.floor(segment.samples * elapsed / Math.max(0.001, segment.end - segment.start))
    }
    this.playedSamples = Math.max(this.playedSamples, total)
    return this.playedSamples
  }

  private waitForPlayback() {
    const context = this.playbackContext
    if (!context) {return Promise.resolve()}
    return new Promise<void>((resolve) => {
      const check = () => {
        if (!this.playbackSources.size && context.currentTime >= this.nextPlaybackTime) {resolve()}
        else {setTimeout(check, 50)}
      }
      check()
    })
  }
}

export const decodeCallAudioFrame = (value: string) => {
  const bytes = decodeBase64(value)
  const samples = new Int16Array(bytes.byteLength >> 1)
  const view = new DataView(bytes.buffer, bytes.byteOffset, samples.length * 2)
  for (let i = 0; i < samples.length; i++) {samples[i] = view.getInt16(i * 2, true)}
  return samples
}
