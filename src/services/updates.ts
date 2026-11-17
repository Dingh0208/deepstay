const RELEASES_URL = 'https://github.com/Dingh0208/deepstay/releases/'
const LATEST_RELEASE_API = 'https://api.github.com/repos/Dingh0208/deepstay/releases/latest'

export type AppRelease = {
  version: string
  releaseUrl: string
  apkUrl: string | null
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
  return {
    version: value.tag_name.replace(/^v/i, ''),
    releaseUrl: value.html_url,
    apkUrl: apk ? String(apk.browser_download_url) : null,
  }
}

/** 仅由用户点击触发，不携带 API Key 或账号凭证。 */
export const fetchLatestRelease = async (signal: AbortSignal): Promise<AppRelease | null> => {
  const controller = new AbortController()
  const abort = () => controller.abort()
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) {
    controller.abort()
  }
  const timeout = setTimeout(abort, 10_000)
  try {
    const response = await fetch(LATEST_RELEASE_API, {
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
    const release = readAppRelease(await response.json())
    if (!release) {
      throw new Error('Invalid release response')
    }
    return release
  } finally {
    clearTimeout(timeout)
    signal.removeEventListener('abort', abort)
  }
}
