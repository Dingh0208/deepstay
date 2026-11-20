import type { CreateMessageRequest, MessageStreamEvent, MessageUsage } from '../api/types.js'
import { getUsageInput, getUsageTotal, isTokenCount } from '../api/usage.js'
import { getVisibleMessages } from './branches.js'
import { estimateRequestParts } from './contextMemory.js'
import { toRequestMessages } from './reply.js'
import type { AssistantMessage, Session, UserMessage } from './types.js'

export type ContextEstimate = Pick<NonNullable<AssistantMessage['metrics']>, 'system' | 'tools' | 'messages'>

/** Local fallback for imported/older conversations without a saved outbound request snapshot. */
export const estimateSessionContext = (
  session: Session,
  system: string,
  tools: CreateMessageRequest['tools']
): ContextEstimate => {
  const visible = getVisibleMessages(session)
  const last = visible[visible.length - 1]
  const question: UserMessage = last?.role === 'user'
    ? last
    : { id: '', role: 'user', content: '', files: [], createdAt: 0 }
  const messages = toRequestMessages(last === question ? visible.slice(0, -1) : visible, question)
  if (last !== question) {
    messages.pop()
  }
  return estimateRequestParts({ system, tools, messages })
}

export const getGeneratedText = (event: MessageStreamEvent): string => {
  if (event.type === 'content_block_delta') {
    const { delta } = event
    return delta.type === 'text_delta' ? delta.text : delta.type === 'thinking_delta' ? delta.thinking : ''
  }
  if (event.type === 'content_block_start') {
    const block = event.content_block
    return block.type === 'text' ? block.text : block.type === 'thinking' ? block.thinking : ''
  }
  return ''
}

export const getTokenRate = (usage: MessageUsage | undefined, generationMs: number): number | undefined => {
  const output = usage?.output_tokens
  // Buffered/single-chunk replies have no reliable generation interval.
  return isTokenCount(output) && output > 0 && Number.isFinite(generationMs) && generationMs >= 100
    ? output * 1000 / generationMs
    : undefined
}

export const getReplyMetrics = (
  reply: AssistantMessage | undefined,
  fallback?: ContextEstimate
) => {
  const estimates = reply?.metrics ?? fallback
  // Chunk usage is provisional, and interrupted replies may never receive the final counters.
  const usage = reply?.status === undefined || reply.status === 'done' ? reply?.usage : undefined
  const reportedInput = getUsageInput(usage)
  const total = getUsageTotal(usage)
  const output = total !== undefined && isTokenCount(usage?.output_tokens) ? usage.output_tokens : undefined
  const cacheHitPercentage =
    total !== undefined &&
    isTokenCount(usage?.cache_read_input_tokens) && reportedInput !== undefined && reportedInput > 0 &&
    usage.cache_read_input_tokens <= reportedInput
      ? usage.cache_read_input_tokens / reportedInput
      : undefined
  const estimatedInput = estimates && estimates.system + estimates.tools + estimates.messages
  const input = total !== undefined ? reportedInput : estimatedInput
  if (total === undefined && input === undefined) {
    return undefined
  }
  return {
    tokensPerSecond: reply?.metrics?.tokensPerSecond,
    cacheHitPercentage,
    context: {
      system: estimates?.system,
      tools: estimates?.tools,
      messages: estimates?.messages,
      input,
      output,
      occupied: total ?? ((input ?? 0) + (output ?? 0)),
      reported: total !== undefined,
    },
  }
}
