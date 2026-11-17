import { useEffect, useRef, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { compareVersions, fetchLatestRelease, type AppRelease } from '../../services/updates.js'
import { Button } from '../base/Button.js'
import settingsStyles from './Settings.module.css'
import styles from './UpdateSetting.module.css'

type UpdateState =
  | { status: 'idle' | 'checking' | 'notFound' | 'error' }
  | { status: 'available' | 'current'; release: AppRelease }

export const UpdateSetting = () => {
  const t = useTranslate()
  const currentVersion = document.querySelector<HTMLMetaElement>('meta[name="application-version"]')?.content ?? ''
  const [state, setState] = useState<UpdateState>({ status: 'idle' })
  const pending = useRef<AbortController | null>(null)

  useEffect(() => () => pending.current?.abort(), [])

  const check = async () => {
    if (pending.current) {
      return
    }
    const controller = new AbortController()
    pending.current = controller
    setState({ status: 'checking' })
    try {
      const release = await fetchLatestRelease(controller.signal)
      if (controller.signal.aborted) {
        return
      }
      if (!release) {
        setState({ status: 'notFound' })
        return
      }
      const difference = compareVersions(release.version, currentVersion)
      if (difference === null) {
        throw new Error('Invalid current version')
      }
      setState({ status: difference > 0 ? 'available' : 'current', release })
    } catch {
      if (!controller.signal.aborted) {
        setState({ status: 'error' })
      }
    } finally {
      if (pending.current === controller) {
        pending.current = null
      }
    }
  }

  const statusText = state.status === 'checking' ? t('updateChecking')
    : state.status === 'notFound' ? t('updateNotPublished')
      : state.status === 'error' ? t('updateFailed')
        : state.status === 'available' ? t('updateAvailable')
          : state.status === 'current' ? t('updateCurrent') : null

  return (
    <div className={settingsStyles.cell}>
      <div className={styles.row}>
        <div className={styles.info}>
          <div className={settingsStyles.label}>deepstay</div>
          <div className={settingsStyles.description}>
            {t('updateCurrentVersion', { version: currentVersion || t('updateVersionUnknown') })}
          </div>
          {'release' in state ? (
            <div className={settingsStyles.description}>
              {t('updateLatestVersion', { version: state.release.version })}
            </div>
          ) : null}
        </div>
        <Button
          variant="outlined"
          size="m"
          className={`${settingsStyles.cellButton} ${styles.check}`}
          disabled={state.status === 'checking'}
          onClick={() => void check()}
        >
          {t(state.status === 'checking' ? 'updateChecking' : 'checkForUpdates')}
        </Button>
      </div>
      {statusText ? (
        <div
          role="status"
          aria-live="polite"
          className={`${styles.status} ${state.status === 'error' ? settingsStyles.error : settingsStyles.description}`}
        >
          {statusText}
        </div>
      ) : null}
      {state.status === 'available' ? (
        <div className={styles.download}>
          <a href={state.release.apkUrl ?? state.release.releaseUrl} target="_blank" rel="noreferrer">
            {t(state.release.apkUrl ? 'updateDownloadApk' : 'updateOpenRelease')}
          </a>
          <span className={settingsStyles.description}>{t('updateInstallHint')}</span>
        </div>
      ) : null}
    </div>
  )
}
