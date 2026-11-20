const RELEASES_URL = 'https://github.com/Dingh0208/deepstay/releases/'
const LATEST_RELEASE_API = 'https://api.github.com/repos/Dingh0208/deepstay/releases/latest'
const UPDATE_MANIFEST_URL = typeof __UPDATE_MANIFEST_URL__ === 'string' ? __UPDATE_MANIFEST_URL__ : ''

export type AppRelease = {
  version: string
  releaseUrl: string
  apkUrl: string | null
  apkSha256: string | null
  apkVersionCode?: number
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
    !/^[\da-f]{64}$/i.test(value.sha256) ||
    (value.versionCode !== undefined && (!Number.isSafeInteger(value.versionCode) || Number(value.versionCode) <= 0))
  ) {
    return null
  }
  try {
    const base = new URL('.', manifestUrl)
    const apk = new URL(value.apkUrl)
    const version = value.version.replace(/^v/i, '')
    const sha256 = value.sha256.toLowerCase()
    if (
      base.protocol !== 'https:' || apk.protocol !== 'https:' ||
      apk.username || apk.password || apk.hash ||
      apk.origin !== base.origin || new URL('.', apk).pathname !== base.pathname ||
      apk.pathname.includes('%') || !apk.pathname.endsWith('.apk') ||
      ![`deepstay-${version}.apk`, `deepstay-${version}-${sha256}.apk`].includes(apk.pathname.slice(base.pathname.length))
    ) {
      return null
    }
    return {
      version,
      releaseUrl: `${RELEASES_URL}tag/v${version}`,
      apkUrl: apk.href,
      apkSha256: sha256,
      ...(value.versionCode !== undefined ? { apkVersionCode: Number(value.versionCode) } : {}),
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
    value.html_url !== `${RELEASES_URL}tag/${value.tag_name}` ||
    !Array.isArray(value.assets)
  ) {
    return null
  }
  const version = value.tag_name.replace(/^v/i, '')
  const apkName = `deepstay-${version}.apk`
  const apk = value.assets.find((asset: unknown) =>
    isObject(asset) && asset.name === apkName &&
    asset.browser_download_url === `${RELEASES_URL}download/${value.tag_name}/${apkName}`
  ) as Record<string, unknown> | undefined
  const digest = apk && typeof apk.digest === 'string' && /^sha256:[\da-f]{64}$/i.test(apk.digest)
    ? apk.digest.slice('sha256:'.length)
    : null
  return {
    version: value.tag_name.replace(/^v/i, ''),
    releaseUrl: String(value.html_url),
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
