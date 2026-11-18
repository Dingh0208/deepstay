import { useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { applyBackgroundImport, cancelBackgroundImport, dismissBackgroundImport, useBackgroundImport } from '../../services/chat/backgroundImport.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import styles from './HistoryImportBanner.module.css'

export const HistoryImportBanner = () => {
  const t = useTranslate()
  const state = useBackgroundImport()
  const [confirm, setConfirm] = useState(false)
  if (state.phase === 'idle') {
    return null
  }
  const preparing = state.phase === 'preparing'
  const locked = state.phase === 'applying' || state.phase === 'cancelling'
  return (
    <>
      <div className={styles.banner}>
        <div className={styles.info} role="status" aria-live="polite">
          <span>{t(state.phase === 'error' ? state.error ?? 'historyImportFailed'
            : state.phase === 'ready' ? 'historyBackgroundReady'
              : state.phase === 'done' ? 'historyBackgroundDone'
                : state.phase === 'applying' ? 'historyBackgroundApplying'
                  : state.phase === 'cancelling' ? 'historyBackgroundCancelling' : 'historyBackgroundProgress',
          { percent: state.progress, count: state.sessions })}</span>
          {preparing ? <progress value={state.progress} max={100} aria-label={t('historyImporting')} /> : null}
        </div>
        {state.phase === 'ready' ? <Button size="s" onClick={() => setConfirm(true)}>{t('historyBackgroundApply')}</Button> : null}
        {!locked ? <Button size="s" variant="outlined" onClick={() => {
          if (state.phase === 'done' || state.phase === 'error') {
            dismissBackgroundImport()
          } else {
            void cancelBackgroundImport()
          }
        }}>{t(state.phase === 'done' || state.phase === 'error' ? 'close' : 'cancel')}</Button> : null}
      </div>
      {confirm && state.phase === 'ready' ? (
        <Modal title={t('historyImportConfirmTitle')} onClose={() => setConfirm(false)}
          footer={<>
            <Button variant="outlined" onClick={() => setConfirm(false)}>{t('cancel')}</Button>
            <Button onClick={() => { setConfirm(false); void applyBackgroundImport() }}>{t('historyBackgroundApply')}</Button>
          </>}>
          {t('historyBackgroundAppendHint')}
        </Modal>
      ) : null}
    </>
  )
}
