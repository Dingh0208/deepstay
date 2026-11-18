import { useSettings } from '../settings.js'
import { getApiConnection, normalizeApiBaseUrl, type ApiConnection } from './connection.js'
import { ApiError, request } from './http.js'

export type ApiBalanceInfo = {
  currency: string
  total_balance: string
  granted_balance: string
  topped_up_balance: string
}

export type ApiBalance = { is_available: boolean; balance_infos: ApiBalanceInfo[] }
export type ApiBalanceRequest = {
  apiKey: string | null
  connection: ApiConnection
}

/** 余额只查官方账户；自定义地址的 Key 不转发到 DeepSeek。 */
export const supportsApiBalance = (connection: ApiConnection = getApiConnection()): boolean => {
  try {
    const url = new URL(normalizeApiBaseUrl(connection.baseUrl))
    return (
      url.origin === 'https://api.deepseek.com' &&
      ['', '/v1', '/anthropic', '/anthropic/v1'].includes(url.pathname.replace(/\/+$/, ''))
    )
  } catch {
    return false
  }
}

const isBalanceInfo = (value: unknown): value is ApiBalanceInfo => {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const info = value as Record<string, unknown>
  return (
    typeof info.currency === 'string' &&
    /^[A-Z]{3}$/.test(info.currency) &&
    ['total_balance', 'granted_balance', 'topped_up_balance'].every(
      (key) => typeof info[key] === 'string' && /^-?\d+(?:\.\d+)?$/.test(info[key] as string)
    )
  )
}

/** GET /user/balance 不调用模型；可直接查询表单当前填写的官方 Key。 */
export const fetchApiBalance = async (
  signal?: AbortSignal,
  requestSettings?: ApiBalanceRequest
): Promise<ApiBalance> => {
  const saved = useSettings.getState()
  const apiKey = requestSettings ? requestSettings.apiKey : saved.apiKey
  const connection = requestSettings?.connection ?? {
    baseUrl: saved.apiBaseUrl,
    protocol: saved.apiProtocol,
  }
  if (!supportsApiBalance(connection)) {
    throw new ApiError('protocol', { key: 'apiBalanceUnsupported' })
  }
  if (!apiKey?.trim()) {
    throw new ApiError('protocol', { key: 'apiKeyRequired' })
  }
  const controller = new AbortController()
  const abort = () => controller.abort()
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) {
    controller.abort()
  }
  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, 10_000)
  try {
    const response = await request('https://api.deepseek.com/user/balance', {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey.trim()}`, Accept: 'application/json' },
      credentials: 'omit',
      redirect: 'error',
      signal: controller.signal,
    })
    const balance: unknown = await response.json()
    if (
      typeof balance !== 'object' ||
      balance === null ||
      !('is_available' in balance) ||
      typeof balance.is_available !== 'boolean' ||
      !('balance_infos' in balance) ||
      !Array.isArray(balance.balance_infos) ||
      !balance.balance_infos.every(isBalanceInfo)
    ) {
      throw new ApiError('protocol', { key: 'apiBalanceFailed' })
    }
    return { is_available: balance.is_available, balance_infos: balance.balance_infos }
  } catch (error) {
    if (timedOut && !signal?.aborted) {
      throw new ApiError('network', { key: 'apiBalanceTimeout' })
    }
    throw error
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener('abort', abort)
  }
}
