import { useEffect, useId, useRef, useState, type CSSProperties } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { Button } from '../base/Button.js'
import { IconButton } from '../base/IconButton.js'
import { IconCloseOutline16, IconMicFill16, IconMicOutline16 } from '../base/icons.js'
import styles from './VoiceCallPage.module.css'

export type VoiceCallPhase = 'starting' | 'listening' | 'hearing' | 'recognizing' | 'thinking' | 'speaking'
export type VoiceCallTurn = { id: string; userText: string; assistantText: string; cut?: boolean }

export type VoiceCallPageProps = {
  open: boolean
  phase: VoiceCallPhase
  phaseLabel: string
  turns: VoiceCallTurn[]
  currentUserText: string
  currentReplyText: string
  micLevel: number
  playbackLevel: number
  muted: boolean
  speaker: boolean
  supportsSpeaker: boolean
  backgroundUrl?: string | null
  error?: string
  onMute: () => void
  onSpeaker: () => void
  onHangup: () => void
}

const METER_BARS = [0.36, 0.58, 0.82, 0.55, 1, 0.67, 0.42, 0.76, 0.48]
const clampLevel = (value: number) => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0))

export const VoiceCallPage = ({
  open,
  phase,
  phaseLabel,
  turns,
  currentUserText,
  currentReplyText,
  micLevel,
  playbackLevel,
  muted,
  speaker,
  supportsSpeaker,
  backgroundUrl,
  error,
  onMute,
  onSpeaker,
  onHangup,
}: VoiceCallPageProps) => {
  const t = useTranslate()
  const titleId = useId()
  const [transcriptOpen, setTranscriptOpen] = useState(false)
  const transcriptRef = useRef<HTMLDivElement>(null)
  const level = phase === 'speaking' ? clampLevel(playbackLevel) : muted ? 0 : clampLevel(micLevel)

  useEffect(() => {
    if (!open) {
      setTranscriptOpen(false)
      return
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') {
        return
      }
      if (transcriptOpen) {
        setTranscriptOpen(false)
      } else {
        onHangup()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open, onHangup, transcriptOpen])

  useEffect(() => {
    if (transcriptOpen && transcriptRef.current) {
      transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight
    }
  }, [transcriptOpen])

  if (!open) {
    return null
  }

  const turnsWithLive = [
    ...turns,
    ...(currentUserText || currentReplyText
      ? [{ id: 'current', userText: currentUserText, assistantText: currentReplyText }]
      : []),
  ]

  return (
    <div className={styles.page} data-voice-call-page="">
      <section className={styles.call} data-call-background={backgroundUrl ? 'image' : 'default'}
        style={backgroundUrl ? { backgroundImage: `linear-gradient(rgba(10, 12, 18, 0.74), rgba(10, 12, 18, 0.86)), url("${backgroundUrl}")` } : undefined}
        role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header className={styles.header}>
          <div className={styles.heading}>
            <h1 id={titleId}>{t('voiceCallTitle')}</h1>
            <span className={styles.phase} role="status" aria-live="polite">{phaseLabel}</span>
          </div>
          <div className={styles.headerActions}>
            <Button size="s" variant="outlined" onClick={() => setTranscriptOpen(true)}>
              {t('voiceCallTranscript')}
            </Button>
            <IconButton
              size="m"
              tone="primary"
              icon={<IconCloseOutline16 />}
              tooltip={t('voiceCallHangup')}
              onClick={onHangup}
            />
          </div>
        </header>

        <main className={styles.main}>
          <div className={styles.activity} data-phase={phase} aria-label={t('voiceCallAudioLevel')}>
            <div
              className={styles.meter}
              style={{ '--voice-call-level': level } as CSSProperties}
              aria-hidden="true"
            >
              {METER_BARS.map((shape, index) => {
                const height = 4 + Math.round(level * (14 + shape * 36))
                return <span key={index} style={{ height: `${height}px` }} />
              })}
            </div>
          </div>

          <div className={styles.liveText} aria-live="off">
            {currentUserText ? (
              <div className={styles.liveLine}>
                <span>{t('voiceCallYou')}</span>
                <p>{currentUserText}</p>
              </div>
            ) : null}
            {currentReplyText ? (
              <div className={`${styles.liveLine} ${styles.replyLine}`}>
                <span>{t('voiceCallAssistant')}</span>
                <p>{currentReplyText}</p>
              </div>
            ) : null}
          </div>
          {error ? <p className={styles.error} role="alert">{error}</p> : null}
        </main>

        <footer className={styles.controls}>
          <button
            className={styles.control}
            type="button"
            aria-label={t(muted ? 'voiceCallUnmute' : 'voiceCallMute')}
            aria-pressed={muted}
            onClick={onMute}
          >
            {muted ? <IconMicFill16 /> : <IconMicOutline16 />}
            <span>{t(muted ? 'voiceCallUnmute' : 'voiceCallMute')}</span>
          </button>
          {supportsSpeaker ? (
            <button
              className={styles.control}
              type="button"
              aria-label={t(speaker ? 'voiceCallUseReceiver' : 'voiceCallUseSpeaker')}
              aria-pressed={speaker}
              onClick={onSpeaker}
            >
              <span className={styles.routeSymbol} aria-hidden="true">{speaker ? 'S' : 'E'}</span>
              <span>{t(speaker ? 'voiceCallUseReceiver' : 'voiceCallUseSpeaker')}</span>
            </button>
          ) : null}
          <Button variant="danger" size="m" className={styles.hangup} onClick={onHangup}>
            {t('voiceCallHangup')}
          </Button>
        </footer>

        {transcriptOpen ? (
          <div className={styles.transcriptBackdrop} onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setTranscriptOpen(false)
            }
          }}>
            <section className={styles.transcript} role="dialog" aria-modal="true" aria-labelledby={`${titleId}-transcript`}>
              <header className={styles.transcriptHeader}>
                <h2 id={`${titleId}-transcript`}>{t('voiceCallTranscript')}</h2>
                <IconButton
                  size="m"
                  tone="primary"
                  icon={<IconCloseOutline16 />}
                  tooltip={t('voiceCallCloseTranscript')}
                  onClick={() => setTranscriptOpen(false)}
                />
              </header>
              <div className={styles.transcriptBody} ref={transcriptRef}>
                {turnsWithLive.length ? turnsWithLive.map((turn) => (
                  <article className={styles.turn} key={turn.id}>
                    {turn.userText ? <div className={styles.transcriptLine}>
                      <span>{t('voiceCallYou')}</span>
                      <p>{turn.userText}</p>
                    </div> : null}
                    {turn.assistantText ? <div className={`${styles.transcriptLine} ${styles.replyLine}`}>
                      <span>{t('voiceCallAssistant')}{'cut' in turn && turn.cut ? ` · ${t('voiceCallInterrupted')}` : ''}</span>
                      <p>{turn.assistantText}</p>
                    </div> : null}
                  </article>
                )) : <p className={styles.empty}>{t('voiceCallTranscriptEmpty')}</p>}
              </div>
            </section>
          </div>
        ) : null}
      </section>
    </div>
  )
}
