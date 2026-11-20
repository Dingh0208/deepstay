import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core'
import { create } from 'zustand'
import { compareVersions, fetchLatestRelease, type AppRelease } from './updates.js'

type DownloadProgress = { receivedBytes: number; totalBytes: number }
type ApkTarget = { sha256: string; expectedVersion: string; expectedVersionCode?: number }

type ApkUpdatePlugin = {
  addListener(
    eventName: 'downloadProgress',
    listener: (progress: DownloadProgress) => void
  ): Promise<PluginListenerHandle>
  downloadApk(options: ApkTarget & { url: string }): Promise<{ bytes: number }>
  installApk(options: ApkTarget): Promise<{ permissionRequired?: boolean }>
  getPendingApk(): Promise<{ ready: boolean; version?: string; versionCode?: number; sha256?: string; bytes?: number }>
  getInstallStatus(): Promise<{ updated: boolean }>
}

export const apkUpdate = registerPlugin<ApkUpdatePlugin>('ApkUpdate')
export const getCurrentVersion = () =>
  document.querySelector<HTMLMetaElement>('meta[name="application-version"]')?.content ?? ''

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

type UpdateStore = {
  value: UpdateState
  hasUpdate: boolean
  releaseNotesOpen: boolean
  recentReleaseNotes: boolean
}

export const useUpdateState = create<UpdateStore>(() => ({
  value: { status: 'idle' },
  hasUpdate: false,
  releaseNotesOpen: false,
  recentReleaseNotes: false,
}))
export const setUpdateState = (value: UpdateState | ((previous: UpdateState) => UpdateState)) =>
  useUpdateState.setState((current) => ({
    value: typeof value === 'function' ? value(current.value) : value,
  }))

const hasInstallWork = ({ status }: UpdateState) =>
  status === 'downloading' || status === 'downloaded' || status === 'installing' ||
  status === 'installPermissionRequired' || status === 'installerOpened' || status === 'installError'

let started = false
let pending: Promise<void> | undefined
let manualRequested = false

export const openReleaseNotes = () => useUpdateState.setState({ releaseNotesOpen: true, recentReleaseNotes: false })
export const closeReleaseNotes = () => useUpdateState.setState({ releaseNotesOpen: false })

const hasExistingInstallationData = () => {
  try {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index)
      if (key?.startsWith('deepstay:') || key?.startsWith('chat-demo:')) {
        return true
      }
    }
    return false
  } catch {
    return false
  }
}

const rememberVersionAndCheckUpgrade = async () => {
  const currentVersion = getCurrentVersion()
  if (!currentVersion) {
    return
  }
  let previousVersion: string | null = null
  try {
    previousVersion = localStorage.getItem('deepstay:last-seen-version')
  } catch {
    // Native install status still detects upgrades when browser storage is unavailable.
  }
  let nativeUpdated = false
  if (Capacitor.getPlatform() === 'android') {
    try {
      nativeUpdated = (await apkUpdate.getInstallStatus()).updated
    } catch {
      // Older app shells do not expose an install status.
    }
  }
  const changed = previousVersion
    ? compareVersions(currentVersion, previousVersion) === 1
    : hasExistingInstallationData()
  if (nativeUpdated || changed) {
    useUpdateState.setState({ releaseNotesOpen: true, recentReleaseNotes: true })
  }
  try {
    localStorage.setItem('deepstay:last-seen-version', currentVersion)
  } catch {
    // Browser storage is optional; Android install status remains available.
  }
}

const restorePendingApk = async () => {
  if (Capacitor.getPlatform() !== 'android') {
    return
  }
  // 开启安装权限可能重启进程；只恢复原生重新校验过的目标包。
  try {
    const { ready, version, versionCode, sha256 } = await apkUpdate.getPendingApk()
    if (ready && version && sha256 && /^[\da-f]{64}$/i.test(sha256) && compareVersions(version, getCurrentVersion()) === 1) {
      useUpdateState.setState({
        hasUpdate: true,
        value: {
          status: 'downloaded',
          release: {
            version,
            releaseUrl: `https://github.com/Dingh0208/deepstay/releases/tag/v${version}`,
            apkUrl: null,
            apkSha256: sha256,
            apkVersionCode: versionCode,
          },
        },
      })
    }
  } catch {
    // 原生缓存不可用时继续检查远端。
  }
}

export const checkForUpdates = (manual = true) => {
  if (manual) {
    manualRequested = true
    setUpdateState((current) => hasInstallWork(current) ? current : { status: 'checking' })
  }
  if (pending) {
    return pending
  }

  const restore = started ? undefined : restorePendingApk()
  started = true
  pending = (async () => {
    const request = fetchLatestRelease(new AbortController().signal).catch(() => undefined)
    await restore
    try {
      const release = await request
      const current = useUpdateState.getState().value
      // 正在下载/打开安装器时不切换目标；空闲缓存可由更新的清单取代。
      if (current.status === 'downloading' || current.status === 'installing') {
        return
      }
      if (hasInstallWork(current)) {
        if (!release || !('release' in current)) {
          return
        }
        const newer = compareVersions(release.version, current.release.version) === 1
        const replaced = release.version === current.release.version && release.apkSha256 &&
          release.apkSha256 !== current.release.apkSha256
        if (!newer && !replaced) {
          if (release.version === current.release.version && release.apkSha256 === current.release.apkSha256) {
            setUpdateState({ ...current, release: {
              ...release, apkVersionCode: release.apkVersionCode ?? current.release.apkVersionCode,
            } })
          }
          return
        }
      }
      if (release === undefined) {
        throw new Error('Update check failed')
      }
      if (!release) {
        useUpdateState.setState({ hasUpdate: false })
        if (manualRequested || 'release' in useUpdateState.getState().value) {
          setUpdateState({ status: manualRequested ? 'notFound' : 'idle' })
        }
        return
      }
      const difference = compareVersions(release.version, getCurrentVersion())
      if (difference === null) {
        throw new Error('Invalid current version')
      }
      useUpdateState.setState({ hasUpdate: difference > 0 })
      if (difference > 0 || manualRequested || 'release' in useUpdateState.getState().value) {
        useUpdateState.setState({
          value: { status: difference > 0 ? 'available' : 'current', release },
        })
      }
    } catch {
      if (manualRequested) {
        setUpdateState({ status: 'error' })
      }
    } finally {
      manualRequested = false
      pending = undefined
    }
  })()
  return pending
}

export const initializeAppUpdates = () => {
  if (!started) {
    void rememberVersionAndCheckUpgrade()
    void checkForUpdates(false)
  }
}

export const bindAppUpdates = () => {
  initializeAppUpdates()
  const onVisible = () => {
    if (document.visibilityState === 'visible') {
      void checkForUpdates(false)
    }
  }
  document.addEventListener('visibilitychange', onVisible)
  return () => document.removeEventListener('visibilitychange', onVisible)
}
