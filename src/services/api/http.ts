import { translate, type TranslationMessage } from '../../i18n/index.js'
import {
  looksLikeEventStream,
  readServerSentEvents,
  ServerSentEventDecoder,
  type ServerSentEvent,
} from './sse.js'
import type { ApiErrorBody } from './types.js'

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

export const isErrorBody = (value: unknown): value is ApiErrorBody =>
  typeof value === 'object' &&
  value !== null &&
  'error' in value &&
  typeof (value as ApiErrorBody).error?.message === 'string'

const INVALID_STREAM = { key: 'replyInvalidStream' } as const

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

export const readMessageEventStream = (
  response: Response,
  signal: AbortSignal
): AsyncGenerator<ServerSentEvent> => {
  if (!response.body) {
    throw new ApiError('protocol', INVALID_STREAM, response.status)
  }
  return readServerSentEvents(
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

export const request = async (url: string, init: RequestInit): Promise<Response> => {
  let response: Response
  try {
    response = await fetch(url, init)
  } catch (error) {
    if (init.signal?.aborted) {
      throw error
    }
    throw new ApiError('network', error instanceof Error ? error.message : String(error))
  }
  if (!response.ok) {
    throw await readErrorResponse(response)
  }
  return response
}
