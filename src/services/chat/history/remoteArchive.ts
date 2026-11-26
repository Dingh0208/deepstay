import { Capacitor, registerPlugin } from '@capacitor/core'
import type { TranslationKey } from '../../../i18n/index.js'
import { isPrivateNetworkHostname } from '../../api/connection.js'
import { BackupError, fail } from './errors.js'

const PLUGIN_NAME = 'LocalFiles'
/** 与 LocalFilesPlugin.MAX_ARCHIVE_BYTES 保持一致。 */
const MAX_ARCHIVE_BYTES = 200 * 1024 * 1024
const DEFAULT_ARCHIVE_NAME = 'deepseek_data.zip'
const DISPOSITION_PATTERN = /filename="?([^";]+)"?/i
const INVALID_NAME_CHARS = /[\\/:*?"<>|]/g

export type ArchiveDownloadProgress = {
  received: number
  total: number | null
}

export type ArchiveDownloadOptions = {
  signal?: AbortSignal
  onProgress?: (progress: ArchiveDownloadProgress) => void
}

type ArchiveProgressEvent = { id: string; received: number; total?: number | null }

type ArchivePlugin = {
  downloadArchive(options: { id: string; url: string }): Promise<{ path: string; bytes: number }>
  cancelDownload(options: { id: string }): Promise<void>
  releaseArchive(options: { path: string }): Promise<void>
  addListener(
    eventName: 'downloadProgress',
    listener: (event: ArchiveProgressEvent) => void
  ): Promise<{ remove: () => Promise<void> }>
}

const archivePlugin = () => registerPlugin<ArchivePlugin>(PLUGIN_NAME)

/** 失败码到文案 key 的映射；未列出的网络类错误统一落到通用提示。 */
const FAILURE_KEYS: Record<string, TranslationKey> = {
  ARCHIVE_URL_INVALID: 'historyImportLinkInvalid',
  ARCHIVE_URL_BLOCKED: 'historyImportLinkBlocked',
  ARCHIVE_EXPIRED: 'historyImportLinkExpired',
  ARCHIVE_TOO_LARGE: 'historyImportLinkTooLarge',
}

/** 仅接受无凭据的 https 直链，并拒绝内网主机。 */
const parseArchiveUrl = (input: string): URL => {
  let url: URL
  try {
    url = new URL(input.trim())
  } catch {
    return fail('historyImportLinkInvalid')
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    fail('historyImportLinkInvalid')
  }
  if (isPrivateNetworkHostname(url.hostname)) {
    fail('historyImportLinkBlocked')
  }
  return url
}

/** 从 disposition 或路径末段推导文件名，非法字符替换后回落默认名。 */
export const archiveName = (url: URL): string => {
  const disposition = url.searchParams.get('response-content-disposition')
  const matched = disposition ? DISPOSITION_PATTERN.exec(disposition) : null
  const raw = matched?.[1] ?? url.pathname.split('/').filter(Boolean).pop() ?? ''
  let decoded = raw
  try {
    decoded = decodeURIComponent(raw)
  } catch {
    decoded = raw
  }
  const cleaned = decoded.replace(INVALID_NAME_CHARS, '_').trim().slice(0, 120)
  return /\.zip$/i.test(cleaned) ? cleaned : DEFAULT_ARCHIVE_NAME
}

const failureKey = (error: unknown): TranslationKey => {
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : ''
  return FAILURE_KEYS[code] ?? 'historyImportLinkFailed'
}

/** 浏览器环境没有原生下载能力，只能依赖目标站点的跨域许可。 */
const downloadInBrowser = async (url: URL): Promise<File> => {
  let response: Response
  try {
    response = await fetch(url.toString())
  } catch {
    return fail('historyImportLinkFailed')
  }
  if (!response.ok) {
    fail(response.status === 403 ? 'historyImportLinkExpired' : 'historyImportLinkFailed')
  }
  const blob = await response.blob()
  if (blob.size === 0) {
    fail('historyImportLinkFailed')
  }
  if (blob.size > MAX_ARCHIVE_BYTES) {
    fail('historyImportLinkTooLarge')
  }
  return new File([blob], archiveName(url), { type: 'application/zip' })
}

/**
 * 下载远端导出包并交接为 File。
 * 原生侧落盘到缓存目录，这里经本地回环地址读回，随后删除临时文件。
 */
export const downloadArchive = async (
  input: string,
  options: ArchiveDownloadOptions = {}
): Promise<File> => {
  const url = parseArchiveUrl(input)
  if (Capacitor.getPlatform() !== 'android') {
    return downloadInBrowser(url)
  }
  const id = `archive-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  const plugin = archivePlugin()
  const cancel = () => {
    void plugin.cancelDownload({ id }).catch(() => {})
  }
  // 先挂取消监听：await 期间的中断同样要能中止原生下载。
  options.signal?.addEventListener('abort', cancel, { once: true })
  let listener: { remove: () => Promise<void> } | null = null
  let path: string | null = null
  try {
    listener = await plugin.addListener('downloadProgress', (event) => {
      if (event.id === id) {
        options.onProgress?.({ received: event.received, total: event.total ?? null })
      }
    })
    if (options.signal?.aborted) {
      fail('historyImportLinkFailed')
    }
    const result = await plugin.downloadArchive({ id, url: url.toString() })
    path = result.path
    if (result.bytes > MAX_ARCHIVE_BYTES) {
      fail('historyImportLinkTooLarge')
    }
    const response = await fetch(Capacitor.convertFileSrc(path))
    const blob = await response.blob()
    if (blob.size === 0) {
      fail('historyImportLinkFailed')
    }
    return new File([blob], archiveName(url), { type: 'application/zip' })
  } catch (error) {
    // 已带文案 key 的失败原样抛出，不要被原生错误码覆盖。
    if (error instanceof BackupError) {
      throw error
    }
    return fail(failureKey(error))
  } finally {
    options.signal?.removeEventListener('abort', cancel)
    if (listener) {
      await listener.remove().catch(() => {})
    }
    if (path) {
      await plugin.releaseArchive({ path }).catch(() => {})
    }
  }
}
