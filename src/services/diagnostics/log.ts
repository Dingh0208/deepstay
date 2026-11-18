import { create } from 'zustand'

const KEY = 'deepstay:diagnostics'
const LIMIT = 200
const operations = {
  api: ['models', 'chat', 'balance', 'fetch'],
  history: ['import', 'export', 'load', 'save', 'delete'],
} as const
const details = [
  'offline', 'network', 'timeout', 'http', 'protocol', 'stream', 'cors', 'redirect',
  'invalid-url', 'non-sse', 'cancelled', 'storage', 'unknown',
]

type Diagnostic = {
  area: keyof typeof operations
  operation: (typeof operations)[keyof typeof operations][number]
  outcome: 'ok' | 'failed'
  detail?: string
  status?: number
}
type Entry = Diagnostic & { at: string }

// Project only known fields: never store arbitrary messages, URLs, headers or payloads.
const validate = (value: unknown): Diagnostic | null => {
  if (!value || typeof value !== 'object') {
    return null
  }
  const { area, operation, outcome, detail, status } = value as Partial<Diagnostic>
  if ((area !== 'api' && area !== 'history') ||
      typeof operation !== 'string' || !(operations[area] as readonly string[]).includes(operation) ||
      (outcome !== 'ok' && outcome !== 'failed')) {
    return null
  }
  return {
    area, operation, outcome,
    ...(typeof detail === 'string' && details.includes(detail) ? { detail } : {}),
    ...(typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599
      ? { status } : {}),
  }
}

const load = (): Entry[] => {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]')
    if (!Array.isArray(saved)) {
      return []
    }
    return saved.slice(-LIMIT).flatMap((item: unknown) => {
      const entry = validate(item)
      const at = (item as Partial<Entry> | null)?.at
      return entry && typeof at === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(at)
        ? [{ at, ...entry }]
        : []
    })
  } catch {
    return []
  }
}

export const useDiagnosticLog = create<{ entries: Entry[] }>(() => ({ entries: load() }))

export const recordDiagnostic = (value: Diagnostic) => {
  const entry = validate(value)
  if (!entry) {
    return
  }
  const entries = [...useDiagnosticLog.getState().entries.slice(1 - LIMIT), {
    at: new Date().toISOString(), ...entry,
  }]
  useDiagnosticLog.setState({ entries })
  try {
    localStorage.setItem(KEY, JSON.stringify(entries))
  } catch {
    // No storage access: the entries remain available for this run.
  }
}

export const diagnosticText = () => JSON.stringify({
  app: 'DeepStay',
  format: 1,
  entries: useDiagnosticLog.getState().entries,
}, null, 2)
