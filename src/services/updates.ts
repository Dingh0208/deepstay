const RELEASES_URL = 'https://github.com/Dingh0208/deepstay/releases/'
const LATEST_RELEASE_API = 'https://api.github.com/repos/Dingh0208/deepstay/releases/latest'
const UPDATE_MANIFEST_URL = typeof __UPDATE_MANIFEST_URL__ === 'string' ? __UPDATE_MANIFEST_URL__ : ''

export type AppRelease = {
  version: string
  releaseUrl: string
  apkUrl: string | null
  apkSha256: string | null
}

const parseVersion = (value: string) => {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([\da-z-]+(?:\.[\da-z-]+)*))?(?:\+[\da-z-]+(?:\.[\da-z-]+)*)?$/i.exec(value)
  return match ? { numbers: match.slice(1, 4).map(BigInt), prerelease: match[4]?.split('.') } : null
}

/** 按语义版本的数字与预发布标识比较；无效版本返回 null。 */
export const compareVersions = (left: string, right: string): number | null => {
  const a = parseVersion(left)
  const b = parseVersion(right)
  if (!a || !b) {
    return null
  }
  for (let index = 0; index < 3; index += 1) {
    if (a.numbers[index] !== b.numbers[index]) {
      return a.numbers[index] > b.numbers[index] ? 1 : -1
    }
  }
  if (!a.prerelease || !b.prerelease) {
    return a.prerelease ? -1 : b.prerelease ? 1 : 0
  }
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index += 1) {
    const first = a.prerelease[index]
    const second = b.prerelease[index]
    if (first === second) {
      continue
    }
    if (first === undefined || second === undefined) {
      return first === undefined ? -1 : 1
    }
    const firstNumeric = /^\d+$/.test(first)
    const secondNumeric = /^\d+$/.test(second)
    if (firstNumeric && secondNumeric) {
      if (BigInt(first) !== BigInt(second)) {
        return BigInt(first) > BigInt(second) ? 1 : -1
      }
    } else {
      return firstNumeric ? -1 : secondNumeric ? 1 : first > second ? 1 : -1
    }
  }
  return 0
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

/** 国内更新源的 APK 必须来自版本清单同目录，且提供 SHA-256。 */
export const readUpdateManifest = (value: unknown, manifestUrl: string): AppRelease | null => {
  if (
    !isObject(value) || typeof value.version !== 'string' ||
    !parseVersion(value.version) || parseVersion(value.version)?.prerelease ||
    typeof value.apkUrl !== 'string' || typeof value.sha256 !== 'string' ||
    !/^[\da-f]{64}$/i.test(value.sha256)
  ) {
    return null
  }
  try {
    const base = new URL('.', manifestUrl)
    const apk = new URL(value.apkUrl)
    if (
      base.protocol !== 'https:' || apk.protocol !== 'https:' ||
      apk.username || apk.password || apk.hash ||
      apk.origin !== base.origin || new URL('.', apk).pathname !== base.pathname ||
      apk.pathname.includes('%') || !apk.pathname.endsWith('.apk')
    ) {
      return null
    }
    return {
      version: value.version.replace(/^v/i, ''),
      releaseUrl: `${RELEASES_URL}tag/v${value.version.replace(/^v/i, '')}`,
      apkUrl: apk.href,
      apkSha256: value.sha256.toLowerCase(),
    }
  } catch {
    return null
  }
}

/** 只接受本仓库正式 Release 和其中的 APK 下载地址。 */
export const readAppRelease = (value: unknown): AppRelease | null => {
  if (
    !isObject(value) || value.draft !== false || value.prerelease !== false ||
    typeof value.tag_name !== 'string' || !parseVersion(value.tag_name) ||
    typeof value.html_url !== 'string' || !value.html_url.startsWith(`${RELEASES_URL}tag/`) ||
    !Array.isArray(value.assets)
  ) {
    return null
  }
  const apk = value.assets.find((asset: unknown) =>
    isObject(asset) && typeof asset.name === 'string' && /\.apk$/i.test(asset.name) &&
    typeof asset.browser_download_url === 'string' &&
    asset.browser_download_url.startsWith(`${RELEASES_URL}download/`) &&
    /\.apk$/i.test(asset.browser_download_url)
  ) as Record<string, unknown> | undefined
  const digest = apk && typeof apk.digest === 'string' && /^sha256:[\da-f]{64}$/i.test(apk.digest)
    ? apk.digest.slice('sha256:'.length)
    : null
  return {
    version: value.tag_name.replace(/^v/i, ''),
    releaseUrl: value.html_url,
    apkUrl: apk ? String(apk.browser_download_url) : null,
    apkSha256: digest,
  }
}

/** 请求公开发布清单，不携带 API Key 或账号凭证。 */
export const fetchLatestRelease = async (signal: AbortSignal): Promise<AppRelease | null> => {
  const controller = new AbortController()
  const abort = () => controller.abort()
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) {
    controller.abort()
  }
  const timeout = setTimeout(abort, 10_000)
  try {
    const response = await fetch(UPDATE_MANIFEST_URL || LATEST_RELEASE_API, {
      headers: { Accept: 'application/vnd.github+json' },
      credentials: 'omit',
      cache: 'no-store',
      signal: controller.signal,
    })
    if (response.status === 404) {
      return null
    }
    if (!response.ok) {
      throw new Error('Update check failed')
    }
    const value: unknown = await response.json()
    const release = UPDATE_MANIFEST_URL
      ? readUpdateManifest(value, UPDATE_MANIFEST_URL)
      : readAppRelease(value)
    if (!release) {
      throw new Error('Invalid release response')
    }
    return release
  } finally {
    clearTimeout(timeout)
    signal.removeEventListener('abort', abort)
  }
}
