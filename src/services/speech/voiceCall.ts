import { create } from 'zustand'
import { getApiConnection, supportsDeepSeekExtras } from '../api/connection.js'
import { getVisibleMessages } from '../chat/branches.js'
import { getReplyText } from '../chat/reply.js'
import { sendMessage, stopReply, useChatStore } from '../chat/store.js'
import { setDraftText } from '../chat/drafts.js'
import type { AssistantMessage, Session } from '../chat/types.js'
import { setVoiceCallSpeakerPreference, useSettings } from '../settings.js'
import { synthesize, transcribeForConnection } from '../api/speech.js'
import { CallAudioSession, decodeCallAudioFrame, type AudioFrame, type CallAudioHandlers, type PlayLevel } from './callAudio.js'
import { alignPcm16Chunk, isBackchannel, isCallStopPhrase, pcmFramesToWav, SpeechGate, takeSpeechChunks } from './callLogic.js'

export type VoiceCallPhase = 'idle' | 'starting' | 'listening' | 'hearing' | 'recognizing' | 'thinking' | 'speaking' | 'error'
export type VoiceCallTurn = { id: string; userText: string; assistantText: string; cut?: boolean }
type VoiceCallState = {
  open: boolean
  phase: VoiceCallPhase
  sessionId: string | null
  turns: VoiceCallTurn[]
  currentUserText: string
  currentReplyText: string
  micLevel: number
  playbackLevel: number
  muted: boolean
  speaker: boolean
  supportsSpeaker: boolean
  error?: string
}

const initialState: VoiceCallState = {
  open: false,
  phase: 'idle',
  sessionId: null,
  turns: [],
  currentUserText: '',
  currentReplyText: '',
  micLevel: 0,
  playbackLevel: 0,
  muted: false,
  speaker: true,
  supportsSpeaker: false,
}
export const useVoiceCall = create<VoiceCallState>(() => initialState)

const PRE_ROLL_FRAMES = 15
const MAX_UTTERANCE_SAMPLES = 16_000 * 120
const assistantAfter = (session: Session, parentId: string): AssistantMessage | undefined =>
  session.messages.find((message): message is AssistantMessage =>
    message.role === 'assistant' && message.parentId === parentId
  )

class VoiceCallController {
  private audio?: CallAudioSession
  private listeners: (() => void)[] = []
  private sessionId: string | null = null
  private muted = false
  private speaker = true
  private gate = new SpeechGate(600)
  private bargeIn = true
  private preRoll: Int16Array[] = []
  private utterance: Int16Array[] = []
  private utteranceSamples = 0
  private phaseBeforeUtterance: VoiceCallPhase = 'listening'
  private replyInterruptedByDuration = false
  private bargeTimer: ReturnType<typeof setTimeout> | undefined
  private ttsAbort?: AbortController
  private ttsQueue: Promise<void> = Promise.resolve()
  private replyCursor = 0
  private activeQuestionId?: string
  private pendingTurnId?: string
  private replyFinished = false
  private stopped = false
  private autoSpeak = true
  private playbackSamples = 0
  private speechWrittenSamples = 0
  private speechSegments: { start: number; end: number; text: string }[] = []
  private speakingSegment?: { start: number; end: number; text: string }
  private visibilityHandler?: () => void
  private replyEpoch = 0
  private browserCompletedText = ''
  private browserCurrentText = ''
  private browserUtterance?: SpeechSynthesisUtterance
  private asrAbort?: AbortController

  async start(targetSessionId: string | null) {
    if (this.audio || useVoiceCall.getState().phase === 'starting') {return}
    if (!useSettings.getState().apiKey?.trim()) {
      useVoiceCall.setState({ ...initialState, open: true, phase: 'error', error: 'voiceCallRequiresApiKey' })
      return
    }
    if (!supportsDeepSeekExtras(getApiConnection()) && !('speechSynthesis' in window)) {
      useVoiceCall.setState({ ...initialState, open: true, phase: 'error', error: 'voiceCallSpeechUnavailable' })
      return
    }
    if (targetSessionId && useChatStore.getState().streaming[targetSessionId]) {
      useVoiceCall.setState({ ...initialState, open: true, phase: 'error', error: 'voiceCallChatBusy' })
      return
    }
    this.sessionId = targetSessionId
    this.stopped = false
    this.autoSpeak = true
    this.muted = false
    this.bargeIn = useSettings.getState().voiceCallBargeIn
    this.gate = new SpeechGate(useSettings.getState().voiceCallPause === 'short' ? 350
      : useSettings.getState().voiceCallPause === 'patient' ? 1200 : 600)
    this.speaker = useSettings.getState().voiceCallSpeaker
    this.browserCompletedText = ''
    this.browserCurrentText = ''
    this.resetTurn()
    useVoiceCall.setState({ ...initialState, open: true, phase: 'starting', sessionId: targetSessionId })
    const audio = new CallAudioSession()
    this.audio = audio
    try {
      const handlers: CallAudioHandlers = {
        onFrame: (frame) => this.onFrame(frame),
        onPlayback: (level) => this.onPlayback(level),
        onError: (code) => this.fail(code ? `voiceCallAudioError:${code}` : 'voiceCallAudioError'),
      }
      const configuration = await audio.start(handlers)
      if (this.stopped) {
        await audio.stop()
        return
      }
      useVoiceCall.setState({ phase: 'listening', supportsSpeaker: configuration.supportsSpeaker })
      if (configuration.supportsSpeaker) {await audio.setSpeaker(this.speaker)}
      this.visibilityHandler = () => {
        if (document.visibilityState === 'hidden') {void this.end()}
      }
      document.addEventListener('visibilitychange', this.visibilityHandler)
      this.observeSession()
    } catch (error) {
      await audio.stop()
      this.audio = undefined
      this.fail(error instanceof DOMException && error.name === 'NotAllowedError'
        ? 'voiceCallPermissionDenied' : 'voiceCallStartFailed')
    }
  }

  private observeSession() {
    const unsubscribe = useChatStore.subscribe((state) => {
      if (!this.sessionId || !this.activeQuestionId) {return}
      const session = state.sessionCache[this.sessionId]
      if (!session) {return}
      const reply = assistantAfter(session, this.activeQuestionId)
      if (!reply) {return}
      const text = getReplyText(reply)
      if (text.length > this.replyCursor) {
        this.pendingTurnId && this.updateTurn(this.pendingTurnId, { assistantText: text })
        if (this.autoSpeak) {this.queueReplyText(text, false)}
      }
      const complete = reply.status === 'done' || reply.status === 'stopped' || reply.status === 'error'
      if (complete && !this.replyFinished) {
        this.replyFinished = true
        if (reply.status === 'done' && this.autoSpeak) {this.queueReplyText(text, true)}
        else {this.finishReplyWithoutSpeech()}
      }
    })
    this.listeners.push(unsubscribe)
  }

  private onPlayback(level: PlayLevel) {
    this.playbackSamples = level.samplesPlayed
    const current = this.speakingSegment
    const fraction = current
      ? Math.max(0, Math.min(1, (level.samplesPlayed - current.start) / Math.max(1, current.end - current.start)))
      : 0
    const heard = this.heardReplyText()
    if (heard && this.pendingTurnId) {this.updateTurn(this.pendingTurnId, { assistantText: heard })}
    useVoiceCall.setState({ playbackLevel: fraction })
  }

  private onFrame(frame: AudioFrame) {
    if (this.stopped || this.muted || useVoiceCall.getState().phase === 'recognizing' || useVoiceCall.getState().phase === 'thinking') {return}
    if (useVoiceCall.getState().phase === 'speaking' && !this.bargeIn) {return}
    let samples: Int16Array
    try { samples = decodeCallAudioFrame(frame.pcm) } catch { return }
    this.preRoll.push(samples)
    if (this.preRoll.length > PRE_ROLL_FRAMES) {this.preRoll.shift()}
    const phase = useVoiceCall.getState().phase
    const gate = this.gate.push(samples, performance.now())
    if (gate.event === 'start') {
      this.phaseBeforeUtterance = phase
      this.replyInterruptedByDuration = false
      this.utterance = [...this.preRoll]
      this.utteranceSamples = this.utterance.reduce((sum, part) => sum + part.length, 0)
      if (phase === 'speaking') {
        this.setPlaybackGain(0.25)
        this.bargeTimer = setTimeout(() => {
          this.replyInterruptedByDuration = true
          void this.interruptReply()
        }, 1600)
      }
      useVoiceCall.setState({ phase: 'hearing', currentUserText: '', micLevel: gate.level })
      return
    }
    if (this.gate.active) {
      this.utterance.push(samples)
      this.utteranceSamples += samples.length
      if (this.utteranceSamples >= MAX_UTTERANCE_SAMPLES) {
        void this.finishUtterance()
        return
      }
    }
    useVoiceCall.setState({ micLevel: gate.level })
    if (gate.event === 'end') {void this.finishUtterance()}
  }

  private async finishUtterance() {
    if (!this.utteranceSamples || this.stopped) {return}
    clearTimeout(this.bargeTimer)
    this.bargeTimer = undefined
    const frames = this.utterance
    const sampleCount = this.utteranceSamples
    const spokenDuringReply = this.phaseBeforeUtterance === 'speaking'
    this.utterance = []
    this.utteranceSamples = 0
    this.gate.reset()
    this.preRoll = []
    if (sampleCount / 16 < 350) {
      if (spokenDuringReply) {this.setPlaybackGain(1)}
      useVoiceCall.setState({ phase: spokenDuringReply ? 'speaking' : 'listening', micLevel: 0 })
      return
    }
    const audio = pcmFramesToWav(frames, sampleCount)
    useVoiceCall.setState({ phase: 'recognizing', currentUserText: '' })
    try {
      const asrAbort = new AbortController()
      this.asrAbort = asrAbort
      const text = (await transcribeForConnection(
        useSettings.getState().apiKey ?? '', audio, getApiConnection(), asrAbort.signal
      )).trim()
      if (this.asrAbort === asrAbort) {this.asrAbort = undefined}
      if (this.stopped) {return}
      if (!text) {
        if (spokenDuringReply) {this.setPlaybackGain(1)}
        useVoiceCall.setState({ phase: spokenDuringReply && !this.replyInterruptedByDuration ? 'speaking' : 'listening', micLevel: 0 })
        return
      }
      useVoiceCall.setState({ currentUserText: text })
      if (spokenDuringReply && isBackchannel(text) && sampleCount / 16 < 1600 && !this.replyInterruptedByDuration) {
        this.setPlaybackGain(1)
        useVoiceCall.setState({ phase: 'speaking', currentUserText: '', micLevel: 0 })
        return
      }
      if (spokenDuringReply) {
        if (isCallStopPhrase(text)) {
          await this.interruptReply()
          this.finishReplyWithoutSpeech()
          useVoiceCall.setState({ phase: 'listening', currentUserText: '', micLevel: 0 })
          return
        }
        await this.interruptReply()
        await this.sendTurn(text)
      } else {
        await this.sendTurn(text)
      }
    } catch (error) {
      this.asrAbort = undefined
      if (this.stopped) {return}
      useVoiceCall.setState({ phase: 'error', error: error instanceof Error ? error.message : 'voiceCallRecognitionFailed' })
      setTimeout(() => {
        if (!this.stopped) {useVoiceCall.setState({ phase: 'listening', error: undefined, currentUserText: '' })}
      }, 1600)
    }
  }

  private async sendTurn(text: string) {
    if (this.stopped) {return}
    if (this.sessionId && !(await this.waitForStreamIdle(this.sessionId))) {
      this.fail('voiceCallSendFailed')
      return
    }
    const turnId = `${Date.now()}-${Math.random().toString(36).slice(2)}`
    this.pendingTurnId = turnId
    this.activeQuestionId = undefined
    this.replyCursor = 0
    this.replyFinished = false
    const currentId = this.sessionId
    setDraftText(currentId, text)
    if (!sendMessage(currentId)) {
      this.fail('voiceCallSendFailed')
      return
    }
    const state = useChatStore.getState()
    const sessionId = currentId ?? state.activeId
    const session = sessionId ? state.sessionCache[sessionId] : undefined
    const question = session ? getVisibleMessages(session).at(-2) : undefined
    if (!sessionId || question?.role !== 'user') {
      this.fail('voiceCallSendFailed')
      return
    }
    this.sessionId = sessionId
    this.activeQuestionId = question.id
    this.updateTurn(turnId, { userText: text })
    if (!useVoiceCall.getState().turns.some((turn) => turn.id === turnId)) {
      useVoiceCall.setState((state) => ({ turns: [...state.turns, { id: turnId, userText: text, assistantText: '' }] }))
    }
    useVoiceCall.setState({ sessionId, phase: 'thinking', currentUserText: '', currentReplyText: '' })
  }

  private waitForStreamIdle(sessionId: string) {
    if (!useChatStore.getState().streaming[sessionId]) {return Promise.resolve(true)}
    return new Promise<boolean>((resolve) => {
      let settled = false
      let timeout: ReturnType<typeof setTimeout>
      const finish = (idle: boolean) => {
        if (settled) {return}
        settled = true
        clearTimeout(timeout)
        unsubscribe()
        resolve(idle)
      }
      const inspect = () => {
        if (!useChatStore.getState().streaming[sessionId]) {finish(true)}
      }
      const unsubscribe = useChatStore.subscribe(inspect)
      timeout = setTimeout(() => finish(false), 10_000)
      inspect()
    })
  }

  private queueReplyText(text: string, flush: boolean) {
    const next = takeSpeechChunks(text, this.replyCursor, flush)
    this.replyCursor = next.cursor
    const epoch = this.replyEpoch
    if (next.chunks.length) {useVoiceCall.setState({ currentReplyText: text, phase: 'speaking' })}
    for (const chunk of next.chunks) {
      this.ttsQueue = this.ttsQueue.then(() => epoch === this.replyEpoch ? this.speak(chunk) : undefined).catch(() => {})
    }
    if (flush) {
      this.ttsQueue = this.ttsQueue.then(async () => {
        if (this.stopped || epoch !== this.replyEpoch) {return}
        await this.audio?.flushPlayback()
        if (epoch === this.replyEpoch) {this.finishReplyWithoutSpeech()}
      }).catch(() => { if (epoch === this.replyEpoch) {this.finishReplyWithoutSpeech()} })
    }
  }

  private async speak(text: string) {
    if (!this.audio || this.stopped || this.ttsAbort?.signal.aborted) {return}
    const settings = useSettings.getState()
    if (supportsDeepSeekExtras(getApiConnection())) {
      const controller = new AbortController()
      this.ttsAbort = controller
      const segment = { start: this.speechWrittenSamples, end: this.speechWrittenSamples, text }
      this.speakingSegment = segment
      const stream = await synthesize(settings.apiKey ?? '', text, settings.ttsVoice, controller.signal)
      const reader = stream.getReader()
      let carry: number | undefined
      try {
        while (!this.stopped && !controller.signal.aborted) {
          const { value, done } = await reader.read()
          if (done) {break}
          if (value?.length) {
            const aligned = alignPcm16Chunk(value, carry)
            carry = aligned.carry
            if (aligned.bytes.length) {
              const written = await this.audio.writePcm(aligned.bytes)
              this.speechWrittenSamples += written.samplesWritten
              segment.end = this.speechWrittenSamples
            }
          }
        }
      } finally {
        await reader.cancel().catch(() => {})
        this.speechSegments.push(segment)
        if (this.speakingSegment === segment) {this.speakingSegment = undefined}
        if (this.ttsAbort === controller) {this.ttsAbort = undefined}
      }
      return
    }
    await this.speakWithBrowser(text)
  }

  private speakWithBrowser(text: string) {
    if (!('speechSynthesis' in window)) {
      this.fail('voiceCallSpeechUnavailable')
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => {
      const utterance = new SpeechSynthesisUtterance(text)
      this.browserUtterance = utterance
      this.browserCurrentText = ''
      utterance.lang = useSettings.getState().locale === 'zh-CN' ? 'zh-CN' : 'en-US'
      utterance.onboundary = (event) => {
        this.browserCurrentText = text.slice(0, Math.max(0, event.charIndex))
        useVoiceCall.setState({ playbackLevel: Math.min(1, event.charIndex / Math.max(1, text.length)) })
      }
      utterance.onend = () => {
        this.browserCompletedText += text
        this.browserCurrentText = ''
        if (this.browserUtterance === utterance) {this.browserUtterance = undefined}
        resolve()
      }
      utterance.onerror = () => {
        if (this.browserUtterance === utterance) {this.browserUtterance = undefined}
        resolve()
      }
      window.speechSynthesis.speak(utterance)
    })
  }

  private setPlaybackGain(value: number) {
    void this.audio?.setPlaybackGain(value)
    if (this.browserUtterance) {this.browserUtterance.volume = Math.max(0, Math.min(1, value))}
  }

  private async interruptReply() {
    clearTimeout(this.bargeTimer)
    this.bargeTimer = undefined
    this.ttsAbort?.abort()
    this.asrAbort?.abort()
    if ('speechSynthesis' in window) {window.speechSynthesis.cancel()}
    const interruptedTurnId = this.pendingTurnId
    const played = await this.audio?.stopPlayback().catch(() => ({ samplesPlayed: this.playbackSamples }))
    this.playbackSamples = played?.samplesPlayed ?? this.playbackSamples
    const heard = this.heardReplyText()
    if (this.sessionId) {stopReply(this.sessionId)}
    this.replyEpoch++
    if (interruptedTurnId) {this.updateTurn(interruptedTurnId, { assistantText: heard, cut: true })}
    useVoiceCall.setState({ playbackLevel: 0, currentReplyText: heard })
    return heard
  }

  private heardReplyText() {
    let heard = ''
    for (const segment of this.speechSegments) {
      if (this.playbackSamples >= segment.end) {
        heard += segment.text
      } else if (this.playbackSamples > segment.start) {
        const fraction = (this.playbackSamples - segment.start) / Math.max(1, segment.end - segment.start)
        heard += segment.text.slice(0, Math.floor(segment.text.length * fraction))
        break
      } else {
        break
      }
    }
    const current = this.speakingSegment
    if (current && this.playbackSamples > current.start) {
      const fraction = Math.min(1, (this.playbackSamples - current.start) / Math.max(1, current.end - current.start))
      heard += current.text.slice(0, Math.floor(current.text.length * fraction))
    }
    return heard + this.browserCompletedText + this.browserCurrentText
  }

  private finishReplyWithoutSpeech() {
    if (this.stopped) {return}
    this.pendingTurnId = undefined
    this.activeQuestionId = undefined
    this.replyFinished = false
    this.playbackSamples = 0
    this.speechWrittenSamples = 0
    this.speechSegments = []
    this.speakingSegment = undefined
    this.browserCompletedText = ''
    this.browserCurrentText = ''
    this.replyEpoch++
    this.replyInterruptedByDuration = false
    useVoiceCall.setState({
      phase: 'listening', currentReplyText: '', currentUserText: '', playbackLevel: 0,
      error: undefined,
    })
  }

  private updateTurn(id: string, update: Partial<VoiceCallTurn>) {
    useVoiceCall.setState((state) => ({
      turns: state.turns.map((turn) => turn.id === id ? { ...turn, ...update } : turn),
    }))
  }

  async setMuted(muted: boolean) {
    this.muted = muted
    this.gate.reset()
    this.preRoll = []
    this.utterance = []
    this.utteranceSamples = 0
    await this.audio?.setMuted(muted)
    useVoiceCall.setState({ muted, phase: muted ? 'listening' : 'listening', micLevel: 0 })
  }

  async setSpeaker(speaker: boolean) {
    await this.audio?.setSpeaker(speaker)
    this.speaker = speaker
    useVoiceCall.setState({ speaker })
    setVoiceCallSpeakerPreference(speaker)
  }

  private resetTurn() {
    this.gate.reset()
    this.preRoll = []
    this.utterance = []
    this.utteranceSamples = 0
    this.activeQuestionId = undefined
    this.pendingTurnId = undefined
    this.replyCursor = 0
    this.replyFinished = false
    this.playbackSamples = 0
    this.speechWrittenSamples = 0
    this.speechSegments = []
    this.speakingSegment = undefined
    this.replyEpoch++
    this.replyInterruptedByDuration = false
    this.ttsQueue = Promise.resolve()
  }

  private fail(error: string) {
    useVoiceCall.setState({ phase: 'error', error })
  }

  async end() {
    if (this.stopped) {return}
    this.stopped = true
    clearTimeout(this.bargeTimer)
    this.bargeTimer = undefined
    this.ttsAbort?.abort()
    this.asrAbort?.abort()
    if ('speechSynthesis' in window) {window.speechSynthesis.cancel()}
    if (this.sessionId && useChatStore.getState().streaming[this.sessionId]) {stopReply(this.sessionId)}
    for (const unsubscribe of this.listeners.splice(0)) {unsubscribe()}
    const audio = this.audio
    this.audio = undefined
    await audio?.stop()
    if (this.visibilityHandler) {document.removeEventListener('visibilitychange', this.visibilityHandler)}
    this.visibilityHandler = undefined
    if ('speechSynthesis' in window) {window.speechSynthesis.cancel()}
    useVoiceCall.setState(initialState)
  }
}

const controller = new VoiceCallController()
export const startVoiceCall = (sessionId: string | null) => controller.start(sessionId)
export const endVoiceCall = () => controller.end()
export const setVoiceCallMuted = (muted: boolean) => controller.setMuted(muted)
export const setVoiceCallSpeaker = (speaker: boolean) => controller.setSpeaker(speaker)
