import { readMessageEvent } from './parseEvent.js'
import {
  apiEndpoint,
  getApiConnection,
  InsecurePublicApiUrlError,
  supportsDeepSeekExtras,
  type ApiConnection,
} from './connection.js'
import { streamOpenAiMessage } from './openai.js'
import { adaptDeepSeekRequest } from './modelCapabilities.js'
import { ApiError, isErrorBody, readMessageEventStream, recordApiFailure, request, streamError, toProviderApiError } from './http.js'
import { recordDiagnostic } from '../diagnostics/log.js'
export { ApiError, request, type ApiErrorKind } from './http.js'
import type { CreateMessageRequest, FileObject, FilePurpose, MessageStreamEvent } from './types.js'

/** 构建期 API 地址，默认 https://api.deepseek.com；本地开发支持开发服务器代理 */
export const API_ORIGIN = __API_ORIGIN__
/** 引用 Files API 上传的图片、调用 Anthropic 兼容 Files API 时必须携带 */
const FILES_BETA = 'files-api-2025-04-14'
const localizeEndpointError = (error: unknown) =>
  error instanceof InsecurePublicApiUrlError ? new ApiError('protocol', { key: 'apiHttpPrivateOnly' }) : error

export const adaptRequestForConnection = (
  body: CreateMessageRequest,
  connection: ApiConnection
): CreateMessageRequest =>
  connection.protocol === 'deepseek' ? adaptDeepSeekRequest(body) : body

const anthropicHeaders = (apiKey: string, beta: boolean): Record<string, string> => ({
  // DeepSeek 兼容接口的鉴权方式，也可使用 Authorization: Bearer。
  'x-api-key': apiKey,
  // Files API 和通过 file_id 引用图片时必传；纯文本聊天无需携带。
  ...(beta ? { 'anthropic-beta': FILES_BETA } : {}),
})

/** 拉取模型不生成内容；超时和调用方取消都只中止本次请求。 */
export const fetchModels = async (
  apiKey: string,
  baseUrl: string,
  signal?: AbortSignal
): Promise<string[]> => {
  const controller = new AbortController()
  const abort = () => controller.abort()
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) {
    controller.abort()
  }
  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    abort()
  }, 10_000)
  try {
    const response = await request(apiEndpoint(baseUrl, 'v1/models'), {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      credentials: 'omit',
      signal: controller.signal,
    }, false)
    const value: unknown = await response.json().catch((error: unknown) => {
      if (controller.signal.aborted) {
        throw error
      }
      const providerFailure = toProviderApiError(error)
      if (providerFailure) {
        throw providerFailure
      }
      throw new ApiError('protocol', { key: 'apiModelsInvalid' }, response.status)
    })
    if (
      typeof value !== 'object' ||
      value === null ||
      !('data' in value) ||
      !Array.isArray(value.data)
    ) {
      throw new ApiError('protocol', { key: 'apiModelsInvalid' }, response.status)
    }
    const models = [
      ...new Set(
        value.data.flatMap((item: unknown) =>
          typeof item === 'object' &&
          item !== null &&
          'id' in item &&
          typeof item.id === 'string' &&
          item.id.trim()
            ? [item.id.trim()]
            : []
        )
      ),
    ]
    if (value.data.length > 0 && models.length === 0) {
      throw new ApiError('protocol', { key: 'apiModelsInvalid' }, response.status)
    }
    recordDiagnostic({ area: 'api', operation: 'models', outcome: 'ok', status: response.status })
    return models
  } catch (error) {
    if (signal?.aborted) {
      throw error
    }
    let failure = localizeEndpointError(error)
    if (timedOut) {
      failure = new ApiError('network', { key: 'apiModelsTimeout' })
    } else if (error instanceof ApiError && (error.status === 404 || error.status === 405)) {
      failure = new ApiError('http', { key: 'apiModelsUnsupported' }, error.status)
    }
    recordApiFailure('models', failure)
    throw failure
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener('abort', abort)
  }
}

/** 兼容旧的 Key 校验入口，使用当前设置中的服务地址。 */
export const verifyApiKey = async (apiKey: string, signal?: AbortSignal): Promise<void> => {
  await fetchModels(apiKey, getApiConnection().baseUrl, signal)
}

/**
 * POST /anthropic/v1/files 上传附件（不设过期时间，会话里的历史附件一直可用）。
 * purpose 为 null 时不传该字段（图片）；purpose 必须排在 file 之前。
 */
export const uploadFile = async (
  apiKey: string,
  file: File,
  purpose: FilePurpose | null,
  signal?: AbortSignal,
  connection: ApiConnection = getApiConnection()
): Promise<FileObject> => {
  if (!supportsDeepSeekExtras(connection)) {
    throw new ApiError('protocol', 'File uploads are unavailable for this API connection')
  }
  const form = new FormData()
  if (purpose) {
    form.append('purpose', purpose)
  }
  form.append('file', file)
  const response = await request(apiEndpoint(connection.baseUrl, 'anthropic/v1/files'), {
    method: 'POST',
    headers: anthropicHeaders(apiKey, true),
    body: form,
    credentials: 'omit',
    signal,
  })
  const uploaded = (await response.json()) as FileObject
  if (typeof uploaded?.id !== 'string' || !uploaded.id.trim()) {
    throw new ApiError('protocol', 'File upload returned no file_id')
  }
  return uploaded
}

/** DELETE /anthropic/v1/files/{file_id} */
export const deleteFile = async (apiKey: string, fileId: string): Promise<void> => {
  const connection = getApiConnection()
  if (!supportsDeepSeekExtras(connection)) {
    throw new ApiError('protocol', 'File deletion is unavailable for this API connection')
  }
  await request(
    apiEndpoint(connection.baseUrl, `anthropic/v1/files/${encodeURIComponent(fileId)}`),
    {
      method: 'DELETE',
      headers: anthropicHeaders(apiKey, true),
      credentials: 'omit',
    }
  )
}

const hasFile = (body: CreateMessageRequest) =>
  body.messages.some(
    (message) =>
      typeof message.content !== 'string' &&
      message.content.some((block) =>
        block.type === 'document' || (block.type === 'image' && block.source.type === 'file')
      )
  )

/**
 * POST /anthropic/v1/messages（stream: true），逐个产出流式事件，收到 message_stop 时结束。
 * ping、保活注释与无法解析的内容不产出；中止请求时抛出 signal 的 AbortError。
 */
export async function* streamMessage(
  apiKey: string,
  body: CreateMessageRequest,
  signal: AbortSignal,
  connection: ApiConnection = getApiConnection()
): AsyncGenerator<MessageStreamEvent> {
  try {
    yield* streamProviderMessage(apiKey, body, signal, connection)
    recordDiagnostic({ area: 'api', operation: 'chat', outcome: 'ok' })
  } catch (error) {
    const failure = localizeEndpointError(error)
    if (!signal.aborted) {
      recordApiFailure('chat', failure)
    }
    throw failure
  }
}

async function* streamProviderMessage(
  apiKey: string,
  body: CreateMessageRequest,
  signal: AbortSignal,
  connection: ApiConnection
): AsyncGenerator<MessageStreamEvent> {
  if (connection.protocol === 'openai') {
    yield* streamOpenAiMessage(apiKey, body, signal, connection)
    return
  }
  const response = await request(apiEndpoint(connection.baseUrl, 'anthropic/v1/messages'), {
    method: 'POST',
    headers: {
      ...anthropicHeaders(apiKey, hasFile(body)),
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify({ ...adaptRequestForConnection(body, connection), stream: true }),
    credentials: 'omit',
    signal,
  }, false)
  for await (const { event: eventName, data } of readMessageEventStream(response, signal)) {
    let payload: unknown
    try {
      payload = JSON.parse(data)
    } catch {
      if (eventName !== 'error') {
        continue
      }
    }
    if (isErrorBody(payload)) {
      throw streamError(payload.error.message, payload.error.code)
    }
    if (eventName === 'error') {
      throw streamError(payload === undefined ? data : undefined)
    }
    const event = readMessageEvent(payload)
    if (!event) {
      continue
    }
    yield event
    if (event.type === 'message_stop') {
      return
    }
  }
  throw new ApiError('interrupted', { key: 'replyInterrupted' })
}
