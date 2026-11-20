import type { TranslationKey } from '../../i18n/index.js'
import { fetchApiBalance, supportsApiBalance, type ApiBalance, type ApiBalanceRequest } from './balance.js'
import { normalizeApiBaseUrl } from './connection.js'
import { ApiError } from './http.js'

type BalanceState = {
  status: 'idle' | 'loading' | 'ready' | 'error'
  balance?: ApiBalance
  checkedAt?: number
  message?: TranslationKey
}

type BalanceAccount = {
  identity: string
  state: BalanceState
  attemptedAt?: number
  pending?: Promise<void>
  controller?: AbortController
}
const EMPTY: BalanceState = { status: 'idle' }
const listeners = new Set<() => void>()
let current: BalanceAccount | undefined

// The credential is only part of a private in-memory identity; it is never persisted or logged.
const identity = ({ apiKey, connection }: ApiBalanceRequest) => {
  let endpoint = connection.baseUrl
  try {
    endpoint = supportsApiBalance(connection)
      ? 'https://api.deepseek.com/user/balance'
      : normalizeApiBaseUrl(connection.baseUrl)
  } catch {
    // Invalid editable addresses cannot reuse a previous account's balance.
  }
  return JSON.stringify([connection.protocol, endpoint, apiKey?.trim() ?? ''])
}
const notify = () => listeners.forEach((listener) => listener())

export const subscribeBalance = (listener: () => void) => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export const getCachedBalance = (request: ApiBalanceRequest): BalanceState =>
  current?.identity === identity(request) ? current.state : EMPTY

export const selectBalanceAccount = (request: ApiBalanceRequest) => {
  const next = identity(request)
  if (current?.identity === next) {
    return current
  }
  current?.controller?.abort()
  const entry: BalanceAccount = { identity: next, state: EMPTY }
  current = entry
  notify()
  return entry
}

/** Reopening and concurrent readers share one account-scoped, read-only request per minute. */
export const queryCachedBalance = (request: ApiBalanceRequest): Promise<void> => {
  const entry = selectBalanceAccount(request)
  if (!request.apiKey?.trim() || !supportsApiBalance(request.connection)) {
    return Promise.resolve()
  }
  if (entry.pending) {
    return entry.pending
  }
  if (entry.attemptedAt !== undefined && Date.now() - entry.attemptedAt < 60_000) {
    return Promise.resolve()
  }
  entry.attemptedAt = Date.now()
  const controller = new AbortController()
  entry.controller = controller
  entry.state = { ...entry.state, status: 'loading', message: undefined }
  notify()
  entry.pending = (async () => {
    try {
      const balance = await fetchApiBalance(controller.signal, request)
      if (current === entry) {
        entry.state = { status: 'ready', balance, checkedAt: Date.now() }
      }
    } catch (error) {
      if (current === entry) {
        const invalidKey = error instanceof ApiError && (error.status === 401 || error.status === 403)
        entry.state = {
          ...(invalidKey ? {} : entry.state), status: 'error',
          message: invalidKey ? 'apiKeyInvalid'
            : error instanceof ApiError && error.localMessage ? error.localMessage.key : 'apiBalanceFailed',
        }
      }
    } finally {
      entry.pending = undefined
      entry.controller = undefined
      if (current === entry) {
        notify()
      }
    }
  })()
  return entry.pending
}
