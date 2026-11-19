import type { MessageUsage } from './types.js'

export const isTokenCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

export const getUsageInput = (usage: MessageUsage | undefined): number | undefined => {
  if (!usage) {
    return undefined
  }
  const { input_tokens, cache_creation_input_tokens = 0, cache_read_input_tokens = 0 } = usage
  const parts = [input_tokens, cache_creation_input_tokens, cache_read_input_tokens]
  if (parts.every(isTokenCount)) {
    const input = parts.reduce((sum, part) => sum + part, 0)
    return isTokenCount(input) ? input : undefined
  }
  const { total_tokens, output_tokens } = usage
  return isTokenCount(total_tokens) && isTokenCount(output_tokens) && total_tokens >= output_tokens
    ? total_tokens - output_tokens
    : undefined
}

export const getUsageTotal = (usage: MessageUsage | undefined): number | undefined => {
  if (!usage) {
    return undefined
  }
  if (isTokenCount(usage.total_tokens)) {
    return usage.total_tokens
  }
  const input = getUsageInput(usage)
  if (input === undefined || !isTokenCount(usage.output_tokens)) {
    return undefined
  }
  const total = input + usage.output_tokens
  return isTokenCount(total) ? total : undefined
}
