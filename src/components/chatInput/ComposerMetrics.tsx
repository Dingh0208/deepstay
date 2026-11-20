import { useState } from 'react'
import { DEFAULT_CONTEXT_WINDOW } from '../../services/api/generation.js'
import { getReplyMetrics, type ContextEstimate } from '../../services/chat/replyMetrics.js'
import type { AssistantMessage } from '../../services/chat/types.js'
import { useSettings } from '../../services/settings.js'
import { useTranslate } from '../../i18n/index.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import styles from './ComposerMetrics.module.css'

export const ComposerMetrics = ({
  latestReply,
  estimatedContext,
  empty,
  compactDisabled,
  progress,
  onCompact,
  onStop,
}: {
  latestReply?: AssistantMessage
  estimatedContext?: ContextEstimate
  empty: boolean
  compactDisabled: boolean
  progress?: string
  onCompact: () => void
  onStop?: () => void
}) => {
  const t = useTranslate()
  const locale = useSettings((state) => state.locale)
  const windowTokens =
    useSettings((state) => state.generation.contextTokens) ?? DEFAULT_CONTEXT_WINDOW
  const [open, setOpen] = useState(false)
  const metrics = getReplyMetrics(latestReply, estimatedContext)
  const pending = latestReply?.status === 'pending' || latestReply?.status === 'streaming'
  const context = metrics?.context
  const occupied = context?.occupied ?? (empty ? 0 : undefined)
  const ratio = occupied === undefined ? undefined : occupied / windowTokens
  const speed =
    metrics?.tokensPerSecond?.toLocaleString(locale, { maximumFractionDigits: 1 }) ?? '–'
  const cacheHit =
    metrics?.cacheHitPercentage === undefined
      ? undefined
      : (metrics.cacheHitPercentage * 100).toLocaleString(locale, { maximumFractionDigits: 1 })
  const percentage =
    ratio?.toLocaleString(locale, { style: 'percent', maximumFractionDigits: 1 }) ?? '–'
  const tokens = (count: number | undefined) => count?.toLocaleString(locale) ?? '–'

  return (
    <div className={styles.row}>
      <span title={t('composerReplySpeed')}>{t('composerSpeed', { speed })}</span>
      {cacheHit === undefined ? null : <span>{t('composerCacheHit', { percentage: cacheHit })}</span>}
      <button
        className={styles.contextButton}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        {pending ? t('composerContextPending') : t('composerContextPercent', {
          percentage:
            context?.reported === false ? t('composerEstimate', { value: percentage }) : percentage,
        })}
      </button>
      {open ? (
        <Modal
          title={t('composerContextTitle')}
          className={styles.modal}
          closable
          onClose={() => setOpen(false)}
          footer={
            onStop ? (
              <Button size="m" variant="outlined" onClick={onStop}>
                {t('composerStopCompaction')}
              </Button>
            ) : (
              <Button size="m" variant="outlined" disabled={compactDisabled} onClick={onCompact}>
                {t('composerCompact')}
              </Button>
            )
          }
        >
          <div className={styles.total}>
            <span>{t(pending ? 'composerUsagePending' : occupied === undefined ? 'composerNoUsage' : 'composerLastRequest')}</span>
            <strong>
              {t('composerContextAmount', { used: tokens(occupied), window: tokens(windowTokens) })}
            </strong>
            {context?.reported === false ? <span>{t('composerEstimated')}</span> : null}
          </div>
          <progress
            className={styles.meter}
            aria-label={t('composerContextTitle')}
            aria-valuetext={pending ? t('composerContextPending') : occupied === undefined ? t('composerNoUsage') : percentage}
            value={Math.min(occupied ?? 0, windowTokens)}
            max={windowTokens}
          />
          <dl className={styles.breakdown}>
            <div>
              <dt>{t('composerContextSystem')}</dt>
              <dd>{context?.system === undefined ? '–' : t('composerEstimate', { value: tokens(context.system) })}</dd>
            </div>
            <div>
              <dt>{t('composerContextTools')}</dt>
              <dd>{context?.tools === undefined ? '–' : t('composerEstimate', { value: tokens(context.tools) })}</dd>
            </div>
            <div>
              <dt>{t('composerContextMessages')}</dt>
              <dd>{context?.messages === undefined ? '–' : t('composerEstimate', { value: tokens(context.messages) })}</dd>
            </div>
          </dl>
          {progress ? <div role="status">{progress}</div> : null}
        </Modal>
      ) : null}
    </div>
  )
}
