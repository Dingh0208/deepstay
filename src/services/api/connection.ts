import { useSettings, type ApiProtocol } from '../settings.js'

export type ApiConnection = { baseUrl: string; protocol: ApiProtocol }
export const DEEPSEEK_OFFICIAL_API_URL = 'https://api.deepseek.com'

export const isSafeApiPath = (path: string): boolean => {
  try {
    return path.split('/').every((part) => {
      const decoded = decodeURIComponent(part)
      return decoded !== '.' && decoded !== '..' && !/[\\/%]/.test(decoded)
    })
  } catch {
    return false
  }
}

export const normalizeApiBaseUrl = (input: string): string => {
  const url = new URL(input.trim())
  const rawPath = /^[a-z][a-z\d+.-]*:\/\/[^/?#]*([^?#]*)/i.exec(input.trim())?.[1] ?? ''
  if (
    !['https:', 'http:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !isSafeApiPath(rawPath)
  ) {
    throw new Error('Enter an HTTP or HTTPS API base URL without credentials, query or fragment')
  }
  // Accept a request URL copied from an API example without losing a relay's prefix.
  url.pathname = url.pathname
    .replace(/\/+$/, '')
    .replace(/(\/(?:v\d+(?:\.\d+)?|openai))\/(?:chat\/completions|models)$/, '$1')
    .replace(/(\/anthropic\/v1)\/messages$/, '$1')
  return url.href.replace(/\/+$/, '')
}

/** 根地址和普通代理前缀追加 /v1；版本地址、OpenAI base 和完整聊天地址保留原路由。 */
export const apiEndpoint = (baseUrl: string, path: string): string => {
  let base = normalizeApiBaseUrl(baseUrl)
  const route = path.replace(/^\/+/, '')
  if (route === 'v1/models' || route === 'v1/chat/completions') {
    const suffix = route.slice(3)
    // 保留未知前缀的完整 endpoint，避免与普通 /proxy base 的含义混淆。
    if (/\/chat\/completions$/.test(new URL(base).pathname)) {
      return `${base.replace(/\/chat\/completions$/, '')}/${suffix}`
    }
    if (/\/(?:v\d+(?:\.\d+)?|openai)$/.test(new URL(base).pathname)) {
      return `${base}/${suffix}`
    }
  }
  if (route.startsWith('anthropic/v1/') || route.startsWith('v1/')) {
    base = base.replace(/\/(?:anthropic(?:\/v1)?|v1)$/, '')
  }
  return `${base}/${route}`
}

export const getApiConnection = (): ApiConnection => {
  const { apiBaseUrl, apiProtocol } = useSettings.getState()
  return { baseUrl: apiBaseUrl, protocol: apiProtocol }
}

/** 扩展文件与语音接口只对当前内置 DeepSeek 服务开放。 */
export const supportsDeepSeekExtras = (connection: ApiConnection = getApiConnection()): boolean =>
  connection.protocol === 'deepseek' &&
  normalizeApiBaseUrl(connection.baseUrl).replace(/\/v1$/, '') ===
    normalizeApiBaseUrl(__API_ORIGIN__).replace(/\/v1$/, '')
