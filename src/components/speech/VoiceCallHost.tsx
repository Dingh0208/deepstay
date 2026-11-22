import { isTranslationKey, useTranslate, type TranslationKey } from '../../i18n/index.js'
import { endVoiceCall, setVoiceCallMuted, setVoiceCallSpeaker, useVoiceCall, type VoiceCallPhase } from '../../services/speech/voiceCall.js'
import { VoiceCallPage } from './VoiceCallPage.js'
import { useChatBackground } from '../../services/chatBackground.js'

const phaseLabelKeys: Record<VoiceCallPhase, TranslationKey> = {
  idle: 'voiceCallPhaseListening',
  starting: 'voiceCallPhaseStarting',
  listening: 'voiceCallPhaseListening',
  hearing: 'voiceCallPhaseHearing',
  recognizing: 'voiceCallPhaseRecognizing',
  thinking: 'voiceCallPhaseThinking',
  speaking: 'voiceCallPhaseSpeaking',
  error: 'voiceCallPhaseError',
}

export const VoiceCallHost = () => {
  const t = useTranslate()
  const call = useVoiceCall()
  const backgroundUrl = useChatBackground((state) => state.url)
  const phase = call.phase === 'idle' || call.phase === 'error' ? 'listening' : call.phase
  return (
    <VoiceCallPage
      open={call.open}
      phase={phase}
      phaseLabel={t(phaseLabelKeys[call.phase])}
      turns={call.turns}
      currentUserText={call.currentUserText}
      currentReplyText={call.currentReplyText}
      micLevel={call.micLevel}
      playbackLevel={call.playbackLevel}
      muted={call.muted}
      speaker={call.speaker}
      supportsSpeaker={call.supportsSpeaker}
      backgroundUrl={backgroundUrl}
      error={call.error ? (isTranslationKey(call.error) ? t(call.error) : call.error) : undefined}
      onMute={() => void setVoiceCallMuted(!call.muted)}
      onSpeaker={() => void setVoiceCallSpeaker(!call.speaker)}
      onHangup={() => void endVoiceCall()}
    />
  )
}
