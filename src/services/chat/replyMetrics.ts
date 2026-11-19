import type { MessageStreamEvent, MessageUsage } from '../api/types.js'
import { getUsageInput, getUsageTotal, isTokenCount } from '../api/usage.js'
import type { AssistantMessage } from './types.js'

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

export const getReplyMetrics = (reply: AssistantMessage | undefined) => {
  const estimates = reply?.metrics
  const usage = reply?.usage
  const reportedInput = getUsageInput(usage)
  const total = getUsageTotal(usage)
  const output = isTokenCount(usage?.output_tokens) ? usage.output_tokens : undefined
  const estimatedInput = estimates && estimates.system + estimates.tools + estimates.messages
  const input = reportedInput ?? estimatedInput
  if (total === undefined && input === undefined) {
    return undefined
  }
  return {
    tokensPerSecond: estimates?.tokensPerSecond,
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
