import { translate, type TranslationMessage } from '../../i18n/index.js'
import { recordDiagnostic } from '../diagnostics/log.js'
import {
  looksLikeEventStream,
  readServerSentEvents,
  ServerSentEventDecoder,
  type ServerSentEvent,
} from './sse.js'
import type { ApiErrorBody } from './types.js'
import { isLoopbackApiUrl } from './connection.js'
import {
  normalizeAndroidProviderError,
  requestAndroidProvider,
  requiresAndroidHttps,
  supportsAndroidProviderTransport,
} from './androidTransport.js'

export type ApiErrorKind = 'http' | 'stream' | 'network' | 'interrupted' | 'protocol'

export class ApiError extends Error {
  readonly localMessage?: TranslationMessage
  readonly providerCode?: string

  constructor(
    readonly kind: ApiErrorKind,
    message: string | TranslationMessage,
    readonly status?: number,
    providerCode?: unknown
  ) {
    super(typeof message === 'string' ? message : translate(message.key, message.params))
    this.name = 'ApiError'
    this.localMessage = typeof message === 'string' ? undefined : message
    this.providerCode = typeof providerCode === 'string' ? providerCode : undefined
  }
}

const ANDROID_PROVIDER_ERRORS = {
  PROVIDER_DNS: { kind: 'network', key: 'apiProviderDns' },
  PROVIDER_TIMEOUT: { kind: 'network', key: 'apiProviderTimeout' },
  PROVIDER_TLS: { kind: 'network', key: 'apiProviderTls' },
  PROVIDER_CONNECT: { kind: 'network', key: 'apiProviderConnect' },
  PROVIDER_NETWORK: { kind: 'network', key: 'apiProviderNetwork' },
  PROVIDER_URL: { kind: 'protocol', key: 'apiProviderRequestUnsupported' },
  PROVIDER_BUSY: { kind: 'network', key: 'apiProviderBusy' },
  PROVIDER_CLOSED: { kind: 'network', key: 'apiProviderNetwork' },
} as const

export const toProviderApiError = (error: unknown): ApiError | null => {
  const providerError = normalizeAndroidProviderError(error)
  if (!providerError) {
    return null
  }
  const mapped = ANDROID_PROVIDER_ERRORS[providerError.code]
  return new ApiError(mapped.kind, { key: mapped.key }, undefined, providerError.code)
}

export const isErrorBody = (value: unknown): value is ApiErrorBody =>
  typeof value === 'object' &&
  value !== null &&
  'error' in value &&
  typeof (value as ApiErrorBody).error?.message === 'string'

const INVALID_STREAM = { key: 'replyInvalidStream' } as const
const INTERRUPTED = { key: 'replyInterrupted' } as const

export const recordApiFailure = (operation: 'models' | 'chat' | 'fetch', error: unknown) => {
  const apiError = error instanceof ApiError ? error : undefined
  const detail = apiError?.providerCode === 'PROVIDER_DNS' ? 'dns'
    : apiError?.providerCode === 'PROVIDER_TIMEOUT' || apiError?.localMessage?.key === 'apiModelsTimeout' ? 'timeout'
      : apiError?.providerCode === 'PROVIDER_TLS' ? 'tls'
    : apiError?.localMessage?.key === 'apiNetworkOffline' ? 'offline'
      : apiError?.kind === 'interrupted' ? 'stream' : apiError?.kind ?? 'unknown'
  recordDiagnostic({ area: 'api', operation, outcome: 'failed', detail, status: apiError?.status })
}

const isEventStreamResponse = (response: Response): boolean =>
  response.headers.get('Content-Type')?.split(';', 1)[0]?.trim().toLowerCase() === 'text/event-stream'

const jsonError = (text: string): ApiErrorBody['error'] | undefined => {
  try {
    const body: unknown = JSON.parse(text)
    return isErrorBody(body) ? body.error : undefined
  } catch {
    return undefined
  }
}

const readableErrorMessage = (message: string | undefined): string | TranslationMessage =>
  message?.trim() && !looksLikeEventStream(message) ? message : INVALID_STREAM

export const streamError = (message?: string, providerCode?: unknown): ApiError =>
  new ApiError('stream', readableErrorMessage(message), undefined, providerCode)

export async function* readMessageEventStream(
  response: Response,
  signal: AbortSignal
): AsyncGenerator<ServerSentEvent> {
  if (!response.body) {
    throw new ApiError('protocol', INVALID_STREAM, response.status)
  }
  try {
    yield* readServerSentEvents(
      response.body,
      signal,
      isEventStreamResponse(response)
        ? undefined
        : (preview) => {
            const detail = jsonError(preview)
            throw new ApiError(
              'protocol',
              readableErrorMessage(detail?.message),
              response.status,
              detail?.code
            )
          }
    )
  } catch (error) {
    if (signal.aborted || error instanceof ApiError) {
      throw error
    }
    const providerFailure = toProviderApiError(error)
    if (providerFailure) {
      throw providerFailure
    }
    throw new ApiError('interrupted', INTERRUPTED)
  }
}

const readErrorResponse = async (response: Response): Promise<ApiError> => {
  const text = await response.text().catch(() => '')
  if (isEventStreamResponse(response) || looksLikeEventStream(text)) {
    const events = new ServerSentEventDecoder().push(`${text}\n\n`)
    const detail = events.map(({ data }) => jsonError(data)).find((error) => error?.message)
    return new ApiError('http', readableErrorMessage(detail?.message), response.status, detail?.code)
  }
  const detail = jsonError(text)
  const message = detail?.message ?? (text || response.statusText)
  return new ApiError(
    'http',
    looksLikeEventStream(message) ? INVALID_STREAM : message,
    response.status,
    detail?.code
  )
}

export const request = async (url: string, init: RequestInit, logFailure = true): Promise<Response> => {
  if (requiresAndroidHttps(url)) {
    throw new ApiError('protocol', {
      key: isLoopbackApiUrl(url) ? 'apiAndroidLocalHttpsRequired' : 'apiAndroidHttpsRequired',
    })
  }
  let response: Response
  try {
    response = supportsAndroidProviderTransport(url)
      ? await requestAndroidProvider(url, init)
      : await fetch(url, init)
  } catch (error) {
    if (init.signal?.aborted) {
      throw error
    }
    const providerFailure = toProviderApiError(error)
    const localFailure = isLoopbackApiUrl(url) &&
      (!providerFailure || providerFailure.localMessage?.key === 'apiProviderConnect' ||
        providerFailure.localMessage?.key === 'apiProviderNetwork')
    const failure = globalThis.navigator?.onLine === false
      ? new ApiError('network', { key: 'apiNetworkOffline' })
      : localFailure
        ? new ApiError('network', { key: 'apiLocalServiceUnavailable' }, undefined, providerFailure?.providerCode)
        : providerFailure ?? new ApiError('network', { key: 'apiNetworkUnavailable' })
    if (logFailure) {
      recordApiFailure('fetch', failure)
    }
    throw failure
  }
  if (!response.ok) {
    const failure = await readErrorResponse(response)
    if (logFailure && !init.signal?.aborted) {
      recordApiFailure('fetch', failure)
    }
    throw failure
  }
  return response
}
