import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core'
import { create } from 'zustand'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import { compareVersions, fetchLatestRelease, type AppRelease } from '../../services/updates.js'
import { Button } from '../base/Button.js'
import settingsStyles from './Settings.module.css'
import styles from './UpdateSetting.module.css'

type DownloadProgress = { receivedBytes: number; totalBytes: number }

type ApkUpdatePlugin = {
  addListener(
    eventName: 'downloadProgress',
    listener: (progress: DownloadProgress) => void
  ): Promise<PluginListenerHandle>
  downloadApk(options: { url: string; sha256: string }): Promise<{ bytes: number }>
  installApk(): Promise<{ permissionRequired?: boolean }>
}

const apkUpdate = registerPlugin<ApkUpdatePlugin>('ApkUpdate')

type UpdateState =
  | { status: 'idle' | 'checking' | 'notFound' | 'error' }
  | {
      status:
        | 'available'
        | 'current'
        | 'downloading'
        | 'downloaded'
        | 'downloadError'
        | 'installing'
        | 'installPermissionRequired'
        | 'installerOpened'
        | 'installError'
      release: AppRelease
      receivedBytes?: number
      totalBytes?: number
    }

// 设置关闭或切换分组时，保留下载进度和已下载安装包的操作入口。
const useUpdateState = create<{ value: UpdateState }>(() => ({ value: { status: 'idle' } }))
const setState = (value: UpdateState | ((previous: UpdateState) => UpdateState)) =>
  useUpdateState.setState((current) => ({
    value: typeof value === 'function' ? value(current.value) : value,
  }))
let pending: AbortController | null = null

export const UpdateSetting = () => {
  const t = useTranslate()
  const isAndroid = Capacitor.getPlatform() === 'android'
  const currentVersion =
    document.querySelector<HTMLMetaElement>('meta[name="application-version"]')?.content ?? ''
  const state = useUpdateState((current) => current.value)

  const check = async () => {
    if (pending) {
      return
    }
    const controller = new AbortController()
    pending = controller
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
      if (pending === controller) {
        pending = null
      }
    }
  }

  const download = async (release: AppRelease) => {
    if (!release.apkUrl || !release.apkSha256) {
      return
    }
    setState({ status: 'downloading', release, receivedBytes: 0, totalBytes: 0 })
    let listener: PluginListenerHandle | undefined
    try {
      listener = await apkUpdate.addListener('downloadProgress', (progress) => {
        setState((current) =>
          current.status === 'downloading' ? { ...current, ...progress } : current
        )
      })
      await apkUpdate.downloadApk({ url: release.apkUrl, sha256: release.apkSha256 })
      setState({ status: 'downloaded', release })
    } catch {
      setState({ status: 'downloadError', release })
    } finally {
      void listener?.remove()
    }
  }

  const install = async (release: AppRelease) => {
    setState({ status: 'installing', release })
    try {
      const result = await apkUpdate.installApk()
      setState({
        status: result.permissionRequired ? 'installPermissionRequired' : 'installerOpened',
        release,
      })
    } catch {
      setState({ status: 'installError', release })
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
          disabled={state.status === 'checking' || state.status === 'downloading' || state.status === 'installing'}
          onClick={() => void check()}
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
