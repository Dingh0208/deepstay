import { useSettings, type ApiProtocol } from '../settings.js'

export type ApiConnection = { baseUrl: string; protocol: ApiProtocol }
export const DEEPSEEK_OFFICIAL_API_URL = 'https://api.deepseek.com'

export const normalizeApiBaseUrl = (input: string): string => {
  const url = new URL(input.trim())
  if (
    !['https:', 'http:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error('Enter an HTTP or HTTPS API base URL without credentials, query or fragment')
  }
  return url.href.replace(/\/+$/, '')
}

/** 请求路径包含协议前缀；允许地址已带 /v1 或 /anthropic/v1。 */
export const apiEndpoint = (baseUrl: string, path: string): string => {
  let base = normalizeApiBaseUrl(baseUrl)
  const route = path.replace(/^\/+/, '')
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
