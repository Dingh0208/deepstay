import type { CreateMessageRequest } from '../api/types.js'
import { supportsDeepSeekExtras, type ApiConnection } from '../api/connection.js'
import { CONTEXT_INPUT_BUDGET, estimateContextTokens, estimateRequestParts, previewContextMemory } from './contextMemory.js'
import { fitRequestHistory } from './contextLimit.js'
import { getVisibleMessages } from './branches.js'
import { loadDerivedMemory } from './db.js'
import { toRequestMessages } from './reply.js'
import type { ContextEstimate } from './replyMetrics.js'
import type { FileAttachment, Session, UserMessage } from './types.js'

export type ContextPredictionOptions = {
  session?: Session
  text: string
  files: FileAttachment[]
  system: string
  tools: CreateMessageRequest['tools']
  model: string
  thinking: boolean
  connection: ApiConnection
  inputBudget: number
  memoryBudget?: number
  automaticCompaction?: boolean
  latestReminder?: string
  signal: AbortSignal
}

const checkAbort = (signal: AbortSignal) => {
  if (signal.aborted) {
    throw signal.reason ?? new DOMException('Aborted', 'AbortError')
  }
}

/** Predict the next input, reusing committed compaction without upload, extraction or writes. */
export const predictNextContext = async (options: ContextPredictionOptions): Promise<ContextEstimate> => {
  const { session, signal, system, tools, thinking, latestReminder, inputBudget } = options
  checkAbort(signal)
  const question: UserMessage = {
    id: 'next-request-preview', role: 'user', content: options.text, createdAt: 0,
    files: options.files.map((file) => file.serverId ? file : { ...file, serverId: file.id }),
  }
  const history = session ? getVisibleMessages(session) : []
  const snapshot = session ? await loadDerivedMemory(session.id) : { records: [], segments: [] }
  checkAbort(signal)
  const memoryBudget = Math.min(inputBudget, options.memoryBudget ?? CONTEXT_INPUT_BUDGET)
  const context = await previewContextMemory({
    sessionId: session?.id ?? '', snapshot, history, question,
    memory: session?.contextMemory,
    connection: options.connection, model: options.model, thinking, signal,
    inputBudget: memoryBudget,
    requestOverhead: estimateContextTokens(system + (latestReminder ?? '') + JSON.stringify(tools)) + 256,
  })
  checkAbort(signal)
  const request: CreateMessageRequest = {
    model: options.model,
    system: [system, context.systemMemory].filter(Boolean).join('\n\n'),
    messages: toRequestMessages(context.history, question, undefined, thinking, latestReminder, !supportsDeepSeekExtras(options.connection)),
    tools,
    thinking: { type: thinking ? 'enabled' : 'disabled' },
    safety_check: { level: 'high' },
  }
  const fitted = options.automaticCompaction
    ? fitRequestHistory(request, context.active ? memoryBudget : inputBudget,
        [system, context.requiredSystemMemory].filter(Boolean).join('\n\n'))
    : request
  checkAbort(signal)
  return estimateRequestParts(fitted)
}
