import { ApiError, readMessageEventStream, request, streamError } from './http.js'
import { apiEndpoint, type ApiConnection } from './connection.js'
import type { CreateMessageRequest, MessageStreamEvent, MessageUsage, StopReason } from './types.js'
import { isTokenCount } from './usage.js'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const toMessages = (body: CreateMessageRequest) => {
  type ContentItem = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }
  const messages: { role: string; content: string | ContentItem[] }[] = [{ role: 'system', content: body.system }]
  for (const message of body.messages) {
    if (typeof message.content === 'string') {
      messages.push({
        role: message.role === 'latest_reminder' ? 'system' : message.role,
        content: message.content,
      })
      continue
    }
    if (message.content.some((block) =>
      block.type === 'document' || (block.type === 'image' && block.source.type !== 'base64')
    )) {
      throw new ApiError('protocol', 'This OpenAI connection received an unsupported attachment block')
    }
    const content: ContentItem[] = []
    for (const block of message.content) {
      if (block.type === 'text') {
        content.push({ type: 'text', text: block.text })
        continue
      }
      if (block.type === 'image' && block.source.type === 'base64') {
        content.push({
          type: 'image_url',
          image_url: { url: `data:${block.source.media_type};base64,${block.source.data}` },
        })
      }
    }
    if (content.some((block) => block.type === 'image_url')) {
      messages.push({ role: message.role, content })
    } else {
      const text = content.map((block) => block.type === 'text' ? block.text : '').filter(Boolean).join('\n\n')
      if (text) {
        messages.push({ role: message.role, content: text })
      }
    }
  }
  return messages
}

const readUsage = (value: unknown): MessageUsage | undefined => {
  if (!isRecord(value)) {
    return undefined
  }
  const usage: MessageUsage = {}
  const promptTokens = isTokenCount(value.prompt_tokens)
    ? value.prompt_tokens
    : isTokenCount(value.prompt_cache_hit_tokens) && isTokenCount(value.prompt_cache_miss_tokens)
      ? value.prompt_cache_hit_tokens + value.prompt_cache_miss_tokens
      : undefined
  if (isTokenCount(promptTokens)) {
    const details = isRecord(value.prompt_tokens_details)
      ? value.prompt_tokens_details.cached_tokens
      : undefined
    // DeepSeek's explicit counter takes precedence over a relay's generic cached_tokens placeholder.
    const direct = value.prompt_cache_hit_tokens
    const reportedCache = isTokenCount(direct) && direct <= promptTokens ? direct : details
    const cached =
      isTokenCount(reportedCache) && reportedCache <= promptTokens ? reportedCache : undefined
    const cachedTokens = cached ?? 0
    usage.input_tokens = promptTokens - cachedTokens
    if (cached !== undefined) {
      usage.cache_read_input_tokens = cached
    }
  }
  if (isTokenCount(value.completion_tokens)) {
    usage.output_tokens = value.completion_tokens
  }
  if (isTokenCount(value.total_tokens)) {
    usage.total_tokens = value.total_tokens
  }
  return Object.keys(usage).length > 0 ? usage : undefined
}

/** 将 OpenAI 的文本与 reasoning_content 流转换为现有消息事件。 */
export async function* streamOpenAiMessage(
  apiKey: string,
  body: CreateMessageRequest,
  signal: AbortSignal,
  connection: ApiConnection
): AsyncGenerator<MessageStreamEvent> {
  if (body.tools.length > 0) {
    throw new ApiError(
      'protocol',
      'DeepSeek server tools are unavailable for this OpenAI connection'
    )
  }
  const endpoint = apiEndpoint(connection.baseUrl, 'v1/chat/completions')
  const officialDeepSeek = new URL(endpoint).hostname === 'api.deepseek.com'
  const payload = {
    model: body.model,
    ...(body.max_tokens === undefined ? {} : { max_tokens: body.max_tokens }),
    ...(body.temperature === undefined ? {} : { temperature: body.temperature }),
    ...(body.top_p === undefined ? {} : { top_p: body.top_p }),
    ...(body.frequency_penalty === undefined ? {} : { frequency_penalty: body.frequency_penalty }),
    ...(body.presence_penalty === undefined ? {} : { presence_penalty: body.presence_penalty }),
    ...(body.stop_sequences === undefined ? {} : { stop: body.stop_sequences }),
    messages: toMessages(body),
    stream: true,
    ...(officialDeepSeek ? { thinking: body.thinking } : {}),
  }
  const send = (includeUsage: boolean) => request(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    credentials: 'omit',
    body: JSON.stringify({
      ...payload,
      ...(includeUsage ? { stream_options: { include_usage: true } } : {}),
    }),
    signal,
  }, false)
  let response: Response
  try {
    response = await send(true)
  } catch (error) {
    // Retry only a pre-generation rejection naming this optional streaming parameter.
    if (
      signal.aborted || officialDeepSeek || !(error instanceof ApiError) ||
      error.kind !== 'http' || error.status !== 400 ||
      !/\b(?:stream_options|include_usage)\b/i.test(error.message) ||
      !/unsupported|not supported|unknown|unrecogni[sz]ed|unexpected|not (?:permitted|allowed)|extra (?:inputs|fields)/i.test(error.message)
    ) {
      throw error
    }
    response = await send(false)
  }
  let started = false
  let index = -1
  let channel: 'text' | 'thinking' | null = null
  let stopReason: StopReason | undefined
  let usage: MessageUsage | undefined
  let usageFields: Record<string, unknown> = {}
  let done = false
  for await (const { data, event } of readMessageEventStream(response, signal)) {
    if (signal.aborted) {
      throw signal.reason ?? new DOMException('Aborted', 'AbortError')
    }
    if (data.trim() === '[DONE]') {
      done = true
      break
    }
    let value: unknown
    try {
      value = JSON.parse(data)
    } catch {
      if (event === 'error') {
        throw streamError(data)
      }
      throw new ApiError('protocol', 'Invalid OpenAI stream event')
    }
    if (!isRecord(value)) {
      throw new ApiError('protocol', 'Invalid OpenAI stream event')
    }
    if (isRecord(value.error)) {
      throw streamError(
        typeof value.error.message === 'string' ? value.error.message : undefined,
        value.error.code
      )
    }
    if (event === 'error') {
      throw streamError()
    }
    if (!started) {
      yield {
        type: 'message_start',
        message: {
          id: typeof value.id === 'string' ? value.id : '',
          model: typeof value.model === 'string' ? value.model : body.model,
        },
      }
      started = true
    }
    if (isRecord(value.usage)) {
      usageFields = {
        ...usageFields,
        ...value.usage,
        ...(isRecord(value.usage.prompt_tokens_details)
          ? { prompt_tokens_details: {
              ...(isRecord(usageFields.prompt_tokens_details) ? usageFields.prompt_tokens_details : {}),
              ...value.usage.prompt_tokens_details,
            } }
          : {}),
      }
      usage = readUsage(usageFields)
    }
    if (!Array.isArray(value.choices)) {
      throw new ApiError('protocol', 'Invalid OpenAI stream choices')
    }
    const choice = value.choices.find(
      (item: unknown) => isRecord(item) && (item.index === 0 || item.index === undefined)
    )
    if (!isRecord(choice)) {
      continue
    }
    const delta = isRecord(choice.delta) ? choice.delta : {}
    if (delta.tool_calls || delta.function_call) {
      throw new ApiError('protocol', 'Tool calls are unavailable for this text-only connection')
    }
    for (const [kind, text] of [
      ['thinking', delta.reasoning_content],
      ['text', delta.content],
    ] as const) {
      if (typeof text !== 'string' || !text) {
        continue
      }
      if (channel !== kind) {
        if (channel !== null) {
          yield { type: 'content_block_stop', index }
        }
        index += 1
        channel = kind
        yield {
          type: 'content_block_start',
          index,
          content_block:
            kind === 'text'
              ? { type: 'text', text: '' }
              : { type: 'thinking', thinking: '', signature: '' },
        }
      }
      yield {
        type: 'content_block_delta',
        index,
        delta:
          kind === 'text'
            ? { type: 'text_delta', text }
            : { type: 'thinking_delta', thinking: text },
      }
    }
    if (choice.finish_reason !== null && choice.finish_reason !== undefined) {
      if (choice.finish_reason === 'tool_calls' || choice.finish_reason === 'function_call') {
        throw new ApiError('protocol', 'Tool calls are unavailable for this text-only connection')
      }
      stopReason =
        choice.finish_reason === 'length'
          ? 'max_tokens'
          : choice.finish_reason === 'content_filter'
            ? 'refusal'
            : 'end_turn'
    }
  }
  if (signal.aborted) {
    throw signal.reason ?? new DOMException('Aborted', 'AbortError')
  }
  if (!done && !stopReason) {
    throw new ApiError('interrupted', { key: 'replyInterrupted' })
  }
  if (!started) {
    throw new ApiError('protocol', 'Empty OpenAI event stream')
  }
  if (channel !== null) {
    yield { type: 'content_block_stop', index }
  }
  yield {
    type: 'message_delta',
    delta: { stop_reason: stopReason ?? 'end_turn', stop_sequence: null },
    usage,
  }
  yield { type: 'message_stop' }
}
