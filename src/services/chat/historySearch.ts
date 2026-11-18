import { create } from 'zustand'
import { visitSessions } from './db.js'
import type { Session } from './types.js'

export type HistoryMatch = { sessionId: string; messageId: string | null; title: string; excerpt: string; timestamp: number }
export const useHistoryTarget = create<{ sessionId: string; messageId: string } | { sessionId: null; messageId: null }>(() => ({ sessionId: null, messageId: null }))

/** 逐条扫描本机会话，不将全部长对话装入界面缓存；包括未选中的消息分支。 */
export const searchHistory = async (
  query: string,
  cached: Record<string, Session>,
  ids: ReadonlySet<string>,
  signal: AbortSignal
): Promise<HistoryMatch[]> => {
  const term = query.trim().toLocaleLowerCase()
  const matches: HistoryMatch[] = []
  const inspected = new Set<string>()
  if (!term || signal.aborted) {
    return matches
  }
  const inspect = (session: Session) => {
    if (signal.aborted || !ids.has(session.id) || inspected.has(session.id)) {
      return
    }
    inspected.add(session.id)
    const countBefore = matches.length
    for (const message of session.messages) {
      const text = message.role === 'user' ? message.content
        : message.blocks.filter((block) => block.type === 'text').map((block) => block.text).join('\n')
      const index = text.toLocaleLowerCase().indexOf(term)
      if (index >= 0) {
        matches.push({ sessionId: session.id, messageId: message.id, title: session.title, timestamp: message.createdAt,
          excerpt: `${index > 35 ? '…' : ''}${text.slice(Math.max(0, index - 35), index + term.length + 75)}` })
      }
    }
    if (matches.length === countBefore && session.title.toLocaleLowerCase().includes(term)) {
      matches.push({ sessionId: session.id, messageId: null, title: session.title, excerpt: '', timestamp: session.updatedAt })
    }
  }
  // 新会话可能尚未落盘，已打开会话也可能有等待保存的最新消息。
  Object.values(cached).forEach(inspect)
  if (signal.aborted) {
    return []
  }
  await visitSessions((stored) => {
    if (signal.aborted) {
      return false
    }
    inspect(cached[stored.id] ?? stored)
    return true
  })
  return signal.aborted ? [] : matches.sort((a, b) => b.timestamp - a.timestamp)
}
