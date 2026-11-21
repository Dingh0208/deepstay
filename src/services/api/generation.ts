import type { CreateMessageRequest } from './types.js'
import type { ApiConnection } from './connection.js'

export const DEFAULT_CONTEXT_WINDOW = 1_000_000

export const generationRanges = {
  temperature: [0, 2, 0.01],
  topP: [0, 1, 0.01],
  maxTokens: [1, 1_048_576, 1],
  contextTokens: [1_024, 1_048_576, 1],
  frequencyPenalty: [-2, 2, 0.01],
  presencePenalty: [-2, 2, 0.01],
} as const

export type GenerationNumber = keyof typeof generationRanges
export type GenerationSettings = Partial<Record<GenerationNumber, number>> & {
  system?: string
  stop?: string[]
}

export const normalizeGeneration = (value: unknown): GenerationSettings => {
  if (!value || typeof value !== 'object') {
    return {}
  }
  const raw = value as Record<string, unknown>
  const result: GenerationSettings = {}
  for (const key of Object.keys(generationRanges) as GenerationNumber[]) {
    const [min, max, step] = generationRanges[key]
    const val = raw[key]
    if (typeof val === 'number' && Number.isFinite(val) && val >= min && val <= max &&
        (step !== 1 || Number.isInteger(val))) {
      result[key] = val
    }
  }
  if (typeof raw.system === 'string' && raw.system.trim()) {
    result.system = raw.system
  }
  if (Array.isArray(raw.stop)) {
    const parts = [...new Set(raw.stop.filter((s): s is string => typeof s === 'string' && s.length > 0 && s.length <= 128))].slice(0, 4)
    if (parts.length) {
      result.stop = parts
    }
  }
  return result
}

export const generationParameters = (
  generation: GenerationSettings,
  connection: ApiConnection,
  thinking: boolean
): Partial<CreateMessageRequest> => {
  const { protocol, baseUrl } = connection
  const samplingDisabled = thinking && (protocol === 'deepseek' ||
    /^https:\/\/api\.deepseek\.com(?:\/|$)/i.test(baseUrl))
  return {
    ...(generation.maxTokens === undefined ? {} : { max_tokens: generation.maxTokens }),
    ...(samplingDisabled || generation.temperature === undefined ? {} : { temperature: generation.temperature }),
    ...(samplingDisabled || generation.topP === undefined ? {} : { top_p: generation.topP }),
    ...(protocol === 'openai' && !samplingDisabled && generation.frequencyPenalty !== undefined
      ? { frequency_penalty: generation.frequencyPenalty }
      : {}),
    ...(protocol === 'openai' && !samplingDisabled && generation.presencePenalty !== undefined
      ? { presence_penalty: generation.presencePenalty }
      : {}),
    ...(generation.stop ? { stop_sequences: generation.stop } : {}),
  }
}
