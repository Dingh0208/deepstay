import { ApiError, request } from './http.js'
import { apiEndpoint, type ApiConnection } from './connection.js'
import { readServerSentEvents } from './sse.js'
import type { CreateMessageRequest, MessageStreamEvent, MessageUsage, StopReason } from './types.js'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const toMessages = (body: CreateMessageRequest) => {
  const messages = [{ role: 'system', content: body.system }]
  for (const message of body.messages) {
    if (typeof message.content === 'string') {
      messages.push({
        role: message.role === 'latest_reminder' ? 'system' : message.role,
        content: message.content,
      })
      continue
    }
    if (message.content.some((block) => block.type !== 'text' && block.type !== 'thinking')) {
      throw new ApiError('protocol', 'This OpenAI connection supports text conversations only')
    }
    const content = message.content
      .flatMap((block) => (block.type === 'text' ? [block.text] : []))
      .join('\n\n')
    if (content) {
      messages.push({ role: message.role, content })
    }
  }
  return messages
}

const readUsage = (value: unknown): MessageUsage | undefined => {
  if (!isRecord(value)) {
    return undefined
  }
  const number = (key: string) =>
    typeof value[key] === 'number' && Number.isFinite(value[key]) ? (value[key] as number) : 0
  const cached =
    isRecord(value.prompt_tokens_details) &&
    typeof value.prompt_tokens_details.cached_tokens === 'number'
      ? value.prompt_tokens_details.cached_tokens
      : number('prompt_cache_hit_tokens')
  return {
    input_tokens: Math.max(0, number('prompt_tokens') - cached),
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: cached,
    output_tokens: number('completion_tokens'),
  }
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
  const response = await request(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    credentials: 'omit',
    body: JSON.stringify({
      model: body.model,
      ...(body.max_tokens === undefined ? {} : { max_tokens: body.max_tokens }),
      messages: toMessages(body),
      stream: true,
      stream_options: { include_usage: true },
      ...(officialDeepSeek ? { thinking: body.thinking } : {}),
    }),
    signal,
  })
  if (!response.body || !response.headers.get('Content-Type')?.includes('text/event-stream')) {
    throw new ApiError('protocol', 'Expected an OpenAI event stream')
  }
  let started = false
  let index = -1
  let channel: 'text' | 'thinking' | null = null
  let stopReason: StopReason | undefined
  let usage: MessageUsage | undefined
  let done = false
  for await (const { data, event } of readServerSentEvents(response.body, signal)) {
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
        throw new ApiError('stream', data)
      }
      throw new ApiError('protocol', 'Invalid OpenAI stream event')
    }
    if (!isRecord(value)) {
      throw new ApiError('protocol', 'Invalid OpenAI stream event')
    }
    if (isRecord(value.error)) {
      throw new ApiError(
        'stream',
        typeof value.error.message === 'string' ? value.error.message : 'OpenAI stream failed'
      )
    }
    if (event === 'error') {
      throw new ApiError('stream', data)
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
    usage = readUsage(value.usage) ?? usage
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
    throw new ApiError('interrupted', '')
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
