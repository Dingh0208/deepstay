import { Capacitor, type PluginListenerHandle } from '@capacitor/core'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import {
  apkUpdate,
  checkForUpdates,
  getCurrentVersion,
  openReleaseNotes,
  setUpdateState,
  useUpdateState,
} from '../../services/appUpdates.js'
import type { AppRelease } from '../../services/updates.js'
import { Button } from '../base/Button.js'
import settingsStyles from './Settings.module.css'
import styles from './UpdateSetting.module.css'

export const UpdateSetting = () => {
  const t = useTranslate()
  const isAndroid = Capacitor.getPlatform() === 'android'
  const currentVersion = getCurrentVersion()
  const state = useUpdateState((current) => current.value)

  const download = async (release: AppRelease) => {
    if (!release.apkUrl || !release.apkSha256) {
      return
    }
    setUpdateState({ status: 'downloading', release, receivedBytes: 0, totalBytes: 0 })
    let listener: PluginListenerHandle | undefined
    try {
      listener = await apkUpdate.addListener('downloadProgress', (progress) => {
        setUpdateState((current) =>
          current.status === 'downloading' ? { ...current, ...progress } : current
        )
      })
      await apkUpdate.downloadApk({ url: release.apkUrl, sha256: release.apkSha256 })
      setUpdateState({ status: 'downloaded', release })
    } catch {
      setUpdateState({ status: 'downloadError', release })
    } finally {
      void listener?.remove()
    }
  }

  const install = async (release: AppRelease) => {
    setUpdateState({ status: 'installing', release })
    try {
      const result = await apkUpdate.installApk()
      setUpdateState({
        status: result.permissionRequired ? 'installPermissionRequired' : 'installerOpened',
        release,
      })
    } catch {
      setUpdateState({ status: 'installError', release })
    }
  }

  let statusKey: TranslationKey | null = state.status === 'checking' ? 'updateChecking'
    : state.status === 'notFound' ? 'updateNotPublished'
      : state.status === 'error' ? 'updateFailed'
        : state.status === 'available' ? 'updateAvailable'
          : state.status === 'current' ? 'updateCurrent'
            : state.status === 'downloading' ? 'updateDownloading'
              : state.status === 'downloaded' ? 'updateDownloaded'
                : state.status === 'downloadError' ? 'updateDownloadFailed'
                  : state.status === 'installing' ? 'updateInstalling'
                    : state.status === 'installPermissionRequired' ? 'updateInstallPermissionRequired'
                      : state.status === 'installerOpened' ? 'updateInstallerOpened'
                        : state.status === 'installError' ? 'updateInstallFailed' : null
  let statusParams: { percent: number } | undefined
  if (state.status === 'downloading') {
    const percent = state.totalBytes && state.totalBytes > 0
      ? Math.min(100, Math.floor((state.receivedBytes ?? 0) * 100 / state.totalBytes))
      : 0
    statusKey = 'updateDownloading'
    statusParams = { percent }
  }

  const hasError = state.status === 'error' || state.status === 'downloadError' || state.status === 'installError'
  const canInstall = 'release' in state && (
    state.status === 'downloaded' || state.status === 'installPermissionRequired' ||
    state.status === 'installerOpened' || state.status === 'installError'
  )
  return (
    <div className={settingsStyles.cell}>
      <div className={styles.row}>
        <div className={styles.info}>
          <button type="button" className={styles.version} onClick={openReleaseNotes}>
            deepstay · {currentVersion || t('updateVersionUnknown')}
          </button>
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
          disabled={state.status === 'checking' || state.status === 'downloading' || state.status === 'installing'}
          onClick={() => void checkForUpdates()}
        >
          {t(state.status === 'checking' ? 'updateChecking' : 'checkForUpdates')}
        </Button>
      </div>
      {statusKey ? (
        <div
          role="status"
          aria-live="polite"
          className={`${styles.status} ${hasError ? settingsStyles.error : settingsStyles.description}`}
        >
          {t(statusKey, statusParams)}
        </div>
      ) : null}
      {(state.status === 'available' || state.status === 'downloadError') && isAndroid ? (
        <div className={styles.download}>
          {state.release.apkUrl && state.release.apkSha256 ? (
            <Button
              variant="outlined"
              size="m"
              onClick={() => void download(state.release)}
            >
              {t('updateDownloadAndInstall')}
            </Button>
          ) : (
            <span className={`${settingsStyles.description} ${settingsStyles.error}`}>
              {t('updateChecksumMissing')}
            </span>
          )}
        </div>
      ) : state.status === 'available' ? (
        <div className={styles.download}>
          <a href={state.release.apkUrl ?? state.release.releaseUrl} target="_blank" rel="noreferrer">
            {t(state.release.apkUrl ? 'updateDownloadApk' : 'updateOpenRelease')}
          </a>
          <span className={settingsStyles.description}>{t('updateInstallHint')}</span>
        </div>
      ) : canInstall ? (
        <div className={styles.download}>
          <Button variant="outlined" size="m" onClick={() => void install(state.release)}>
            {t('updateInstallNow')}
          </Button>
        </div>
      ) : null}
    </div>
  )
}
