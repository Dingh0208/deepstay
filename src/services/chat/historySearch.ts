import { create } from 'zustand'
import { visitSessions } from './db.js'
import type { Session } from './types.js'

export type HistoryMatch = { sessionId: string; messageId: string | null; title: string; excerpt: string; timestamp: number }
export const useHistoryTarget = create<{ sessionId: string; messageId: string } | { sessionId: null; messageId: null }>(() => ({ sessionId: null, messageId: null }))

/** 折叠全半角与大小写，保持 UTF-16 长度，命中位置仍可直接用于原文。 */
const foldForSearch = (text: string) => {
  const normalized = text.replace(/[\uFF01-\uFF5E\u3000]/g, (char) =>
    char === '\u3000' ? ' ' : String.fromCharCode(char.charCodeAt(0) - 0xfee0))
  const lower = normalized.toLowerCase()
  if (lower.length === normalized.length) {
    return lower
  }
  return normalized.replace(/[\s\S]/gu, (char) => {
    const lower = char.toLowerCase()
    return lower.length === char.length ? lower : char
  })
}

const splitsSurrogatePair = (text: string, index: number) =>
  /[\uD800-\uDBFF][\uDC00-\uDFFF]/.test(text.slice(Math.max(0, index - 1), index + 1))

/** 逐条扫描本机会话，不将全部长对话装入界面缓存；包括未选中的消息分支。 */
export const searchHistory = async (
  query: string,
  cached: Record<string, Session>,
  ids: ReadonlySet<string>,
  signal: AbortSignal
): Promise<HistoryMatch[]> => {
  const terms = [...new Set(foldForSearch(query).trim().split(/\s+/).filter(Boolean))]
  const matches: HistoryMatch[] = []
  const inspected = new Set<string>()
  if (terms.length === 0 || signal.aborted) {
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
      const folded = foldForSearch(text)
      const indexes = terms.map((term) => folded.indexOf(term))
      if (indexes.every((index) => index >= 0)) {
        const index = Math.min(...indexes)
        let start = Math.max(0, index - 35)
        let end = index + terms[indexes.indexOf(index)].length + 75
        if (splitsSurrogatePair(text, start)) {
          start -= 1
        }
        if (splitsSurrogatePair(text, end)) {
          end += 1
        }
        matches.push({ sessionId: session.id, messageId: message.id, title: session.title, timestamp: message.createdAt,
          excerpt: `${start > 0 ? '…' : ''}${text.slice(start, end)}` })
      }
    }
    const title = foldForSearch(session.title)
    if (matches.length === countBefore && terms.every((term) => title.includes(term))) {
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
