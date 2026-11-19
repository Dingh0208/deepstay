import { useTranslate } from '../../i18n/index.js'
import { closeReleaseNotes, getCurrentVersion, useUpdateState } from '../../services/appUpdates.js'
import { parseReleaseNotes } from '../../services/releaseNotes.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import styles from './ReleaseNotesDialog.module.css'

const releases = parseReleaseNotes(__CHANGELOG__)

export const ReleaseNotesDialog = () => {
  const t = useTranslate()
  const open = useUpdateState((state) => state.releaseNotesOpen)
  const recent = useUpdateState((state) => state.recentReleaseNotes)
  const currentVersion = getCurrentVersion()
  if (!open) {
    return null
  }
  return (
    <Modal
      title={t('updateHistoryTitle')}
      closable
      className={styles.dialog}
      mainClassName={styles.main}
      onClose={closeReleaseNotes}
      footer={<Button autoFocus onClick={closeReleaseNotes}>{t('close')}</Button>}
    >
      <ol className={styles.list}>
        {(recent ? releases.slice(0, 3) : releases).map((release) => (
          <li key={release.version} className={styles.release}>
            <h2>
              <span>v{release.version}</span>
              {release.version === currentVersion ? (
                <span className={styles.current}>{t('updateHistoryCurrent')}</span>
              ) : null}
            </h2>
            <ul>
              {release.changes.map((change) => <li key={change}>{change}</li>)}
            </ul>
          </li>
        ))}
      </ol>
    </Modal>
  )
}
