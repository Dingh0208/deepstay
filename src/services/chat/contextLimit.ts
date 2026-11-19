import type { CreateMessageRequest } from '../api/types.js'
import { CONTEXT_INPUT_BUDGET, estimateRequestTokens } from './contextMemory.js'

type LengthError = { inputTokens?: number; maxInputTokens?: number }

export const getRetryInputBudget = (estimate: number, error: LengthError, cap = CONTEXT_INPUT_BUDGET): number => {
  const { inputTokens, maxInputTokens } = error
  const ratio = inputTokens && maxInputTokens ? Math.min(1, maxInputTokens / inputTokens) : 0.75
  // The estimator and provider tokenizer can disagree, especially for attachments.
  return Math.floor(Math.min(cap, maxInputTokens ?? Infinity, estimate * ratio) * 0.85)
}

/** Remove oldest complete turns from the outbound copy; retain the current question, prefix and system. */
export const fitRequestHistory = (
  body: CreateMessageRequest,
  budget: number,
  requiredSystem = body.system
): CreateMessageRequest => {
  if (estimateRequestTokens(body) <= budget) {
    return body
  }
  const fitted = trimHistory(body, budget)
  if (body.system !== requiredSystem && estimateRequestTokens(fitted) > budget) {
    return trimHistory({ ...body, system: requiredSystem }, budget)
  }
  return fitted
}

const trimHistory = (body: CreateMessageRequest, budget: number): CreateMessageRequest => {
  const { messages } = body
  const estimateBase = estimateRequestTokens({ ...body, messages: [] })
  const weights = messages.map((message) =>
    estimateRequestTokens({ ...body, messages: [message], system: '', tools: [] }) -
    estimateRequestTokens({ messages: [], system: '', tools: [] })
  )
  let estimate = weights.reduce((sum, weight) => sum + weight, estimateBase)
  const questionIndex = messages.length - (messages[messages.length - 1]?.role === 'assistant' ? 2 : 1)
  let start = 0
  let reminderIndex = -1
  const carry = () => reminderIndex >= 0 && messages[start]?.role !== 'latest_reminder'
  while (start < questionIndex && estimate + (carry() ? weights[reminderIndex] : 0) > budget) {
    const hasReminder = messages[start]?.role === 'latest_reminder'
    const userIndex = start + (hasReminder ? 1 : 0)
    if (
      userIndex + 1 >= questionIndex ||
      messages[userIndex]?.role !== 'user' ||
      messages[userIndex + 1]?.role !== 'assistant'
    ) {
      break
    }
    if (hasReminder) {
      reminderIndex = start
      estimate -= weights[start]
    }
    estimate -= weights[userIndex] + weights[userIndex + 1]
    start = userIndex + 2
  }
  if (!start) {
    return body
  }
  const remaining = messages.slice(start)
  if (carry()) {
    remaining.unshift(messages[reminderIndex])
  }
  return { ...body, messages: remaining }
}
