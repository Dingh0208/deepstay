import { getReplyText } from './reply.js'
import type { MemoryMessage, MemoryRecord, MemorySlice, MemorySource } from './memoryTypes.js'
import type { Message } from './types.js'

export const MEMORY_VERSION = 1

/** Only visible, settled conversation text can support a memory. */
export const memoryText = (message: Message): string =>
  message.role === 'user'
    ? message.content
    : (message.status === 'done' || message.status === 'stopped') &&
        message.stopReason !== 'refusal' &&
        !message.blocks.some((block) => block.type === 'text' && block.isTemplate)
      ? getReplyText(message)
      : ''

export const memoryFingerprint = async (message: Message): Promise<string> => {
  const input = JSON.stringify([message.id, message.role, message.createdAt, memoryText(message)])
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('')
}

const invalid = (): never => {
  throw new Error('Invalid memory extraction')
}
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : invalid()
const text = (value: unknown, max: number): string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= max
    ? value.trim()
    : invalid()
const array = (value: unknown, max: number): unknown[] =>
  Array.isArray(value) && value.length <= max ? value : invalid()

const findSource = (value: unknown, slices: MemorySlice[]): MemorySource => {
  const item = object(value)
  const id = text(item.messageId, 256)
  const quote = text(item.quote, 1_000)
  const matches: MemorySource[] = []
  for (const slice of slices) {
    if (slice.message.id !== id) {
      continue
    }
    const full = memoryText(slice.message)
    if (
      !Number.isInteger(slice.start) ||
      !Number.isInteger(slice.end) ||
      slice.start < 0 ||
      slice.end > full.length ||
      slice.start >= slice.end
    ) {
      invalid()
    }
    const within = full.slice(slice.start, slice.end)
    const start = within.indexOf(quote)
    if (start !== -1) {
      if (within.indexOf(quote, start + 1) !== -1) {
        invalid()
      }
      matches.push({
        messageId: id,
        fingerprint: slice.fingerprint,
        start: slice.start + start,
        end: slice.start + start + quote.length,
      })
    }
  }
  if (matches.length !== 1) {
    invalid()
  }
  return matches[0]
}

type ExtractionOptions = {
  sessionId: string
  segmentId: string
  sources: MemorySlice[]
  knownRecords: MemoryRecord[]
  sourceOrder?: ReadonlyMap<string, number>
  now?: number
}

/** The model supplies quotes; the application derives offsets and rejects ambiguous evidence. */
export const parseMemoryExtraction = (
  input: string,
  options: ExtractionOptions
): {
  summary: string
  records: MemoryRecord[]
} => {
  if (input.length > 24_000) {
    invalid()
  }
  const body = object(JSON.parse(input))
  const summary = text(body.summary, 4_000)
  const rows = array(body.records, 24)
  const order =
    options.sourceOrder ?? new Map(options.sources.map((slice, index) => [slice.message.id, index]))
  const known = new Map(
    options.knownRecords
      .filter((record) => record.sessionId === options.sessionId)
      .map((record) => [record.id, record])
  )
  const records: MemoryRecord[] = []
  const seen = new Set<string>()
  for (const raw of rows) {
    const row = object(raw)
    const kind = text(row.kind, 20) as MemoryRecord['kind']
    const actor = text(row.actor, 20) as MemoryRecord['actor']
    const realm = text(row.realm, 20) as MemoryRecord['realm']
    if (
      !['setting', 'preference', 'boundary', 'event', 'promise', 'correction'].includes(kind) ||
      !['user', 'assistant'].includes(actor) ||
      !['self_report', 'roleplay', 'hypothetical', 'unspecified'].includes(realm)
    ) {
      invalid()
    }
    if (['preference', 'boundary', 'correction'].includes(kind) && actor !== 'user') {
      invalid()
    }
    const rawSources = array(row.sources, 6)
    if (rawSources.length === 0) {
      invalid()
    }
    const sources = rawSources.map((source) => findSource(source, options.sources))
    const authored = sources.some((source) =>
      options.sources.some(
        (slice) => slice.message.id === source.messageId && slice.message.role === actor
      )
    )
    if (!authored) {
      invalid()
    }
    const supersedes: string[] = []
    if (row.supersedes !== undefined) {
      for (const target of array(row.supersedes, 6)) {
        const id = text(target, 512)
        const previous = known.get(id)
        const lastSource = Math.max(...sources.map((source) => order.get(source.messageId) ?? -1))
        if (
          kind !== 'correction' ||
          !previous ||
          previous.extractorVersion !== MEMORY_VERSION ||
          previous.realm !== realm ||
          !previous.sources.every((source) => {
            const position = order.get(source.messageId)
            return position !== undefined && position < lastSource
          })
        ) {
          invalid()
        }
        if (!supersedes.includes(id)) {
          supersedes.push(id)
        }
      }
    }
    const record: MemoryRecord = {
      id: `${options.sessionId}:${MEMORY_VERSION}:${options.segmentId}:${records.length}`,
      sessionId: options.sessionId,
      kind,
      actor,
      realm,
      key: text(row.key, 100),
      text: text(row.text, 1_000),
      sources,
      supersedes,
      extractedAt: options.now ?? Date.now(),
      extractorVersion: MEMORY_VERSION,
    }
    if (row.eventTime !== undefined) {
      record.eventTime = text(row.eventTime, 80)
    }
    if (row.eventTimeText !== undefined) {
      record.eventTimeText = text(row.eventTimeText, 160)
    }
    const signature = JSON.stringify([
      kind,
      actor,
      realm,
      record.key,
      record.text,
      sources,
      supersedes,
    ])
    if (!seen.has(signature)) {
      seen.add(signature)
      records.push(record)
    }
  }
  return { summary, records }
}

export const isMemorySourceValid = (
  source: MemorySource,
  path: ReadonlyMap<string, MemoryMessage>
): boolean => {
  const current = path.get(source.messageId)
  return (
    !!current &&
    source.fingerprint === current.fingerprint &&
    Number.isInteger(source.start) &&
    Number.isInteger(source.end) &&
    source.start >= 0 &&
    source.end > source.start &&
    source.end <= memoryText(current.message).length
  )
}

/** Corrections affect the selected path only; stored records are never globally invalidated. */
export const filterMemoryRecords = (
  records: MemoryRecord[],
  sessionId: string,
  path: ReadonlyMap<string, MemoryMessage>
): MemoryRecord[] => {
  const valid = records.filter(
    (record) =>
      record.sessionId === sessionId &&
      record.extractorVersion === MEMORY_VERSION &&
      record.sources.length > 0 &&
      record.sources.every((source) => isMemorySourceValid(source, path))
  )
  const byId = new Map(valid.map((record) => [record.id, record]))
  const order = new Map(Array.from(path.keys(), (id, index) => [id, index]))
  const hidden = new Set<string>()
  for (const correction of valid) {
    if (correction.kind !== 'correction' || correction.actor !== 'user') {
      continue
    }
    const latest = Math.max(
      ...correction.sources.map((source) => order.get(source.messageId) ?? -1)
    )
    for (const id of correction.supersedes) {
      const previous = byId.get(id)
      if (
        previous &&
        previous.realm === correction.realm &&
        previous.sources.every((source) => (order.get(source.messageId) ?? Infinity) < latest)
      ) {
        hidden.add(id)
      }
    }
  }
  return valid.filter((record) => !hidden.has(record.id))
}
