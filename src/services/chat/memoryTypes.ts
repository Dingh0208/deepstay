import type { Message, Session } from './types.js'

export type MemorySource = {
  messageId: string
  fingerprint: string
  start: number
  end: number
}

export type MemoryRecord = {
  id: string
  sessionId: string
  kind: 'setting' | 'preference' | 'boundary' | 'event' | 'promise' | 'correction'
  actor: 'user' | 'assistant'
  realm: 'self_report' | 'roleplay' | 'hypothetical' | 'unspecified'
  key: string
  text: string
  sources: MemorySource[]
  supersedes: string[]
  eventTime?: string
  eventTimeText?: string
  extractedAt: number
  extractorVersion: number
}

export type MemorySegment = {
  id: string
  sessionId: string
  sources: MemorySource[]
  summary: string
  provider: string
  model: string
  createdAt: number
  extractorVersion: number
  /** The protected tail and last complete turn when this branch was compacted. */
  checkpoint?: { retainedFromId: string | null; lastReplyId: string; complete: boolean }
}

export type MemoryState = {
  sessionId: string
  sourceRevision: number
  memoryRevision: number
  hasCheckpoint?: boolean
}

export type MemorySnapshot = {
  state: MemoryState
  session: Session
  records: MemoryRecord[]
  segments: MemorySegment[]
}

export type MemoryUpdate = { records: MemoryRecord[]; segments: MemorySegment[] }
export type MemoryMessage = { message: Message; fingerprint: string }
export type MemorySlice = MemoryMessage & { start: number; end: number }
