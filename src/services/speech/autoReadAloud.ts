import { supportsDeepSeekExtras } from '../api/connection.js'
import { useChatStore } from '../chat/store.js'
import { useSettings } from '../settings.js'
import {
  playAutomaticReadAloud,
  prepareReadAloudAudio,
  stopAutomaticReadAloud,
} from './readAloud.js'

/** Observe requests at acceptance and completion, independently of message virtualization. */
export const bindAutoReadAloud = () => {
  let pending: {
    sessionId: string
    messageId: string
    signal: AbortSignal
    audio: AudioContext
  } | null = null

  const cancel = () => {
    if (pending) {
      pending.signal.removeEventListener('abort', cancel)
      void pending.audio.close().catch(() => {})
      pending = null
    }
  }
  const unsubscribeChat = useChatStore.subscribe((state, previous) => {
    const id = state.activeId
    if (id === null || state.importingHistory || pending?.sessionId !== id) {
      cancel()
    }
    if (id === null || state.importingHistory || document.visibilityState !== 'visible') {
      return
    }
    const controller = state.streaming[id]
    const previousController = previous.streaming[id]
    if (controller === previousController) {
      return
    }
    const settings = useSettings.getState()
    if (!settings.autoReadAloud || !settings.apiKey || !supportsDeepSeekExtras()) {
      cancel()
      return
    }
    const session = state.sessionCache[id]
    if (!session) {
      return
    }
    if (controller && !controller.signal.aborted) {
      // Manual compaction also uses the busy state, but has no pending reply.
      let index = session.messages.length - 1
      while (index >= 0) {
        const message = session.messages[index]
        if (message.role === 'assistant' && message.status === 'pending') {
          break
        }
        index--
      }
      const reply = session.messages[index]
      if (!reply) {
        return
      }
      const audio = prepareReadAloudAudio()
      if (audio) {
        pending = { sessionId: id, messageId: reply.id, signal: controller.signal, audio }
        controller.signal.addEventListener('abort', cancel, { once: true })
      }
    } else if (pending) {
      const { messageId, audio, signal } = pending
      const reply = session.messages.find((message) => message.id === messageId)
      const text =
        reply?.role === 'assistant' && reply.status === 'done' && reply.stopReason !== 'refusal'
          ? reply.blocks
              .map((block) => (block.type === 'text' && !block.isTemplate ? block.text : ''))
              .join('')
              .trim()
          : ''
      if (!signal.aborted && text) {
        signal.removeEventListener('abort', cancel)
        pending = null
        playAutomaticReadAloud(messageId, text, audio)
      } else {
        cancel()
      }
    }
  })

  const unsubscribeSettings = useSettings.subscribe((state, previous) => {
    if (
      !state.autoReadAloud ||
      state.apiKey !== previous.apiKey ||
      state.apiBaseUrl !== previous.apiBaseUrl ||
      state.apiProtocol !== previous.apiProtocol
    ) {
      cancel()
      stopAutomaticReadAloud()
    }
  })
  const onVisibility = () => {
    if (document.visibilityState !== 'visible') {
      cancel()
      stopAutomaticReadAloud()
    }
  }
  document.addEventListener('visibilitychange', onVisibility)
  return () => {
    unsubscribeChat()
    unsubscribeSettings()
    document.removeEventListener('visibilitychange', onVisibility)
    cancel()
    stopAutomaticReadAloud()
  }
}
