import { useSettings, type ApiProtocol } from '../settings.js'
import { normalizeApiBaseUrl } from './endpoints.js'
export { apiEndpoint, isSafeApiPath, normalizeApiBaseUrl } from './endpoints.js'

export type ApiConnection = { baseUrl: string; protocol: ApiProtocol }
export const DEEPSEEK_OFFICIAL_API_URL = 'https://api.deepseek.com'

export const isLoopbackApiUrl = (input: string): boolean => {
  try {
    const { hostname } = new URL(input)
    return hostname === 'localhost' || hostname === '[::1]' || /^127(?:\.\d+){3}$/.test(hostname)
  } catch {
    return false
  }
}

export const getApiConnection = (): ApiConnection => {
  const { apiBaseUrl, apiProtocol } = useSettings.getState()
  return { baseUrl: apiBaseUrl, protocol: apiProtocol }
}

const extensionBaseUrl = (baseUrl: string) =>
  normalizeApiBaseUrl(baseUrl).replace(/\/(?:anthropic(?:\/v1)?|v1)$/, '')

/** 扩展文件与语音接口只对当前内置 DeepSeek 服务开放。 */
export const supportsDeepSeekExtras = (connection: ApiConnection = getApiConnection()): boolean =>
  connection.protocol === 'deepseek' && extensionBaseUrl(connection.baseUrl) === extensionBaseUrl(__API_ORIGIN__)
