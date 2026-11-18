import { useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import {
  downloadDiagnostics,
  shareDiagnostics,
  supportsDiagnosticShare,
} from '../../services/diagnostics/export.js'
import { useDiagnosticLog } from '../../services/diagnostics/log.js'
import { Button } from '../base/Button.js'
import { showToast } from '../base/toastState.js'
import styles from './Settings.module.css'

export const DiagnosticsSetting = () => {
  const t = useTranslate()
  const entries = useDiagnosticLog((state) => state.entries)
  const [busy, setBusy] = useState(false)
  const action = async (run: () => Promise<void>) => {
    setBusy(true)
    try {
      await run()
    } catch (error) {
      if (!(error instanceof Error && error.name === 'AbortError')) {
        showToast({ key: 'diagnosticActionFailed', type: 'error' })
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <p className={styles.description}>{t('diagnosticScope')}</p>
      <div className={styles.diagnosticActions}>
        <Button variant="outlined" disabled={busy || !entries.length} onClick={() => void action(downloadDiagnostics)}>
          {t('diagnosticExport')}
        </Button>
        {supportsDiagnosticShare() && (
          <Button variant="outlined" disabled={busy || !entries.length} onClick={() => void action(shareDiagnostics)}>
            {t('diagnosticShare')}
          </Button>
        )}
      </div>
      {entries.length ? (
        <ol className={styles.diagnosticList}>
          {[...entries].reverse().map((entry, index) => (
            <li key={`${entry.at}-${entries.length - index}`} className={styles.diagnosticEntry}>
              <time dateTime={entry.at} className={styles.diagnosticTime}>{new Date(entry.at).toLocaleString()}</time>
              <div>{[entry.operation, t(entry.outcome === 'ok' ? 'diagnosticSuccess' : 'diagnosticFailure'), entry.detail, entry.status].filter(Boolean).join(' · ')}</div>
            </li>
          ))}
        </ol>
      ) : <p className={styles.description}>{t('diagnosticEmpty')}</p>}
    </div>
  )
}
