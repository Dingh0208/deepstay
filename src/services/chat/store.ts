import { create } from 'zustand'
import { createId } from '../../utils/id.js'
import { hasOwn } from '../../utils/object.js'
import { adaptRequestForConnection, ApiError, streamMessage } from '../api/client.js'
import type { CreateMessageRequest } from '../api/types.js'
import { DEFAULT_CONTEXT_WINDOW, generationParameters } from '../api/generation.js'
import { supportsDeepSeekTitles, usesAnthropicWebSearch } from '../api/modelCapabilities.js'
import { getApiConnection, supportsDeepSeekExtras, type ApiConnection } from '../api/connection.js'
import {
  extractFileIds,
  classifyApiError,
  getContextLengthError,
  getFileErrorCode,
  getImageSizeError,
  isTotalImageSizeError,
  getUnsupportedImageError,
  isRetryableApiError,
} from '../api/errors.js'
import { cancelUpload, describeUploadError, getUploadPurpose, uploadAttachment, useUploads } from '../attachments.js'
import { encodeLocalImage, extractLocalAttachmentText, LocalAttachmentError, type LocalAttachmentContent } from '../localAttachments.js'
import { clearFavoriteMessages, clearPinnedSessions, getModelReasoningProfile, removeFavoriteMessages, setPinnedSession, useSettings } from '../settings.js'
import { appendBranch, getRoundMessageIds, getVisibleMessages, normalizeSession, removeBranchMessages, replaceSessionReply, selectVersion } from './branches.js'
import * as db from './db.js'
import { limitRequestImages } from './requestImages.js'
import {
  clearAllDrafts,
  clearDraft,
  clearSentDraft,
  getDraft,
  prepareDraftMessage,
} from './drafts.js'
import { createLatestReminder } from './latestReminder.js'
import { characterGreetings, characterSnapshot, characterSystemPrompt, type CharacterPreset } from '../characters.js'
import { useHistoryTarget } from './historySearch.js'
import {
  estimateContextTokens,
  estimateRequestParts,
  estimateRequestTokens,
  prepareContextMemory,
  type CompactionFailure,
  type CompactionSkipReason,
} from './contextMemory.js'
import { fitRequestHistory, getRetryInputBudget } from './contextLimit.js'
import { memoryText } from './memoryRecords.js'
import type { MemoryState } from './memoryTypes.js'
import {
  applyEvent,
  canContinueReply,
  getContextRounds,
  hasVisibleReplyText,
  settleReply,
  toRequestMessages,
} from './reply.js'
import { getGeneratedText, getTokenRate } from './replyMetrics.js'
import {
  toSessionSummary,
  type AssistantMessage,
  type FileAttachment,
  type Message,
  type Session,
  type SessionSummary,
  type UserMessage,
} from './types.js'

/** 所有生成请求统一携带的助手身份说明 */
export const SYSTEM_PROMPT = '你是 deepstay 的 AI 助手。认真理解用户的语境，以自然、温和的方式回应。'
/** 默认发送预算与界面窗口分离，避免单次请求过大。 */
export const DEFAULT_REQUEST_INPUT_BUDGET = 128_000
/** 保留最近打开的详情；当前会话、生成中及尚未成功保存的会话不淘汰。 */
const SESSION_CACHE_LIMIT = 5
/** 安全审核固定开启，所有请求都走扩展模式 */
const SAFETY_CHECK = { level: 'high' } as const
/** 附件错误后自动重发的最多次数（不含首次请求） */
const FILE_RETRY_LIMIT = 2
/** 退避基数，第 n 次重试等待 2^n 倍；连续失败达到上限就放弃，把原始报错展示出来 */
const FILE_RETRY_BASE_DELAY = 1000
// Reuse a confirmed input budget on the same API configuration during this app session.
let learnedContextLimit: { route: string; key: string; budget: number } | undefined

/** Read-only budget for the next request, including a provider-confirmed limit on this route. */
export const getEffectiveContextInputBudget = (): number => {
  const { apiKey, model, thinking, search, generation } = useSettings.getState()
  const connection = getApiConnection()
  const serverSearch = supportsDeepSeekExtras(connection) && search
  const route = JSON.stringify([connection.baseUrl, connection.protocol, model, thinking, serverSearch])
  const window = generation.contextTokens ?? DEFAULT_CONTEXT_WINDOW
  const budget = generation.contextTokens ?? DEFAULT_REQUEST_INPUT_BUDGET
  return learnedContextLimit?.route === route && learnedContextLimit.key === apiKey
    ? Math.min(budget, learnedContextLimit.budget)
    : Math.min(window, budget)
}

let rejectedHistoryImages: { route: string; key: string; ids: Set<string> } | undefined
// 让浏览器先处理交互和绘制，再准备请求或继续处理缓冲中的数据。
const yieldToBrowser = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

// 首段正文或思考先绘制一帧。切到后台后动画帧可能暂停，用定时器收尾。
const yieldPastPaint = () =>
  new Promise<void>((resolve) => {
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(finish)
    })
    const fallback = setTimeout(finish, 100)
    function finish() {
      cancelAnimationFrame(frame)
      clearTimeout(fallback)
      resolve()
    }
  })

/** 支持扩展的模型默认声明阅读链接，智能搜索开关控制搜索工具（含边想边搜）。 */
export const serverTools = (search: boolean, model = useSettings.getState().model): CreateMessageRequest['tools'] => {
  if (usesAnthropicWebSearch(model)) {
    return search ? [{ type: 'web_search_20250305', name: 'web_search' }] : []
  }
  const tools: CreateMessageRequest['tools'] = [
    { type: 'deepseek_read_url', name: 'deepseek_read_url' },
  ]
  if (search) {
    tools.push({ type: 'deepseek_web_search', name: 'deepseek_web_search' })
  }
  return tools
}

/** 允许自动补标题的请求；手动重命名后取消本轮标题写入，包含主动清空标题的情况。 */
const titleRequests = new Set<AbortController>()

type ChatState = {
  ready: boolean
  initError: boolean
  /** 历史导入或全部删除期间锁定交互，提交成功前仍展示原有记录。 */
  importingHistory: boolean
  /** 仅列表元数据，按 updatedAt 降序；流式消息更新不会改变此数组。 */
  sessions: SessionSummary[]
  sessionCache: Record<string, Session>
  sessionLoadErrors: Record<string, boolean>
  sessionSaveErrors: Record<string, boolean>
  /** null 表示新对话（欢迎页） */
  activeId: string | null
  /** 正在生成回复的会话 */
  streaming: Record<string, AbortController>
  contextProgress: Record<string, { completed: number; total: number; manual?: boolean }>
}

export const useChatStore = create<ChatState>(() => ({
  ready: false,
  initError: false,
  importingHistory: false,
  contextProgress: {},
  sessions: [],
  sessionCache: {},
  sessionLoadErrors: {},
  sessionSaveErrors: {},
  activeId: null,
  streaming: {},
}))

const { getState: get, setState: set } = useChatStore

const sortSessions = (sessions: SessionSummary[]) =>
  [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)

const getSession = (id: string) => {
  const cache = get().sessionCache
  return hasOwn(cache, id) ? cache[id] : undefined
}

const getStreamController = (id: string) => {
  const streams = get().streaming
  return hasOwn(streams, id) ? streams[id] : undefined
}

const sameSummary = (a: SessionSummary, b: SessionSummary) =>
  a.title === b.title && a.createdAt === b.createdAt && a.updatedAt === b.updatedAt

const sessionAccess = new Map<string, number>()
const unsavedSessions = new Set<string>()
const pendingSaves = new Map<string, Promise<boolean>>()
/** 保存失败时保留原件，重试成功后才释放。 */
const pendingFiles = new Map<string, db.StoredFile[]>()
const deletingSessions = new Set<string>()
const deletionTasks = new Set<Promise<boolean>>()
const streamFlushes = new Map<string, () => void>()
const contextPreparations = new Set<string>()
let accessSequence = 0
let historyEpoch = 0
let initTask: Promise<void> | undefined
const sessionLoads = new Map<string, { promise: Promise<void> }>()

const touchSession = (id: string) => sessionAccess.set(id, ++accessSequence)

const trimSessionCache = () => {
  const state = get()
  const ids = Object.keys(state.sessionCache)
  if (ids.length <= SESSION_CACHE_LIMIT) {
    return
  }
  const removable = ids
    .filter(
      (id) =>
        id !== state.activeId &&
        !hasOwn(state.streaming, id) &&
        !unsavedSessions.has(id) &&
        !deletingSessions.has(id)
    )
    .sort((a, b) => (sessionAccess.get(a) ?? 0) - (sessionAccess.get(b) ?? 0))
  const evicted = new Set(removable.slice(0, ids.length - SESSION_CACHE_LIMIT))
  for (const id of evicted) {
    sessionAccess.delete(id)
  }
  if (evicted.size > 0) {
    set({
      sessionCache: Object.fromEntries(
        Object.entries(state.sessionCache).filter(([id]) => !evicted.has(id))
      ),
    })
  }
}

const updateSession = (id: string, update: (session: Session) => Session) =>
  set((state) => {
    const previous = hasOwn(state.sessionCache, id) ? state.sessionCache[id] : undefined
    if (!previous) {
      return state
    }
    const session = update(previous)
    if (session === previous) {
      return state
    }
    return {
      sessionCache: { ...state.sessionCache, [id]: session },
      sessions: sameSummary(previous, session)
        ? state.sessions
        : sortSessions(
            state.sessions.map((summary) =>
              summary.id === id ? toSessionSummary(session) : summary
            )
          ),
    }
  })

const updateReply = (sessionId: string, reply: AssistantMessage) =>
  updateSession(sessionId, (session) => replaceSessionReply(session, reply))

const persist = (sessionId: string): Promise<boolean> => {
  const session = getSession(sessionId)
  if (session) {
    unsavedSessions.add(sessionId)
    if (deletingSessions.has(sessionId)) {
      return Promise.resolve(false)
    }
    const epoch = historyEpoch
    const files = pendingFiles.get(sessionId)
    const task = db
      .saveSession(session, files)
      .then(() => {
        if (epoch !== historyEpoch || !getSession(sessionId)) {
          return false
        }
        if (pendingFiles.get(sessionId) === files) {
          pendingFiles.delete(sessionId)
        }
        if (getSession(sessionId) === session) {
          unsavedSessions.delete(sessionId)
          set((state) => ({
            sessionSaveErrors: Object.fromEntries(
              Object.entries(state.sessionSaveErrors).filter(([id]) => id !== sessionId)
            ),
          }))
          trimSessionCache()
        }
        return true
      })
      .catch((error: unknown) => {
        db.reportStorageError('save session')(error)
        if (epoch === historyEpoch && getSession(sessionId)) {
          set((state) => ({
            sessionSaveErrors: { ...state.sessionSaveErrors, [sessionId]: true },
          }))
        }
        return false
      })
    pendingSaves.set(sessionId, task)
    void task.finally(() => {
      if (pendingSaves.get(sessionId) === task) {
        pendingSaves.delete(sessionId)
      }
    })
    return task
  }
  return Promise.resolve(false)
}

export const retrySaveSessions = () => {
  if (!get().importingHistory) {
    unsavedSessions.forEach(persist)
  }
}

/** 离开前先合并尚未绘制的增量；隐藏期间浏览器可能暂停动画帧。 */
export const bindChatPersistence = () => {
  const save = () => {
    if (get().importingHistory) {
      return
    }
    for (const [id, flush] of streamFlushes) {
      if (contextPreparations.has(id)) {
        continue
      }
      flush()
      persist(id)
    }
    for (const id of unsavedSessions) {
      if (!streamFlushes.has(id)) {
        persist(id)
      }
    }
  }
  const onVisibilityChange = () => {
    if (document.visibilityState === 'hidden') {
      save()
    }
  }
  document.addEventListener('visibilitychange', onVisibilityChange)
  window.addEventListener('pagehide', save)
  return () => {
    document.removeEventListener('visibilitychange', onVisibilityChange)
    window.removeEventListener('pagehide', save)
  }
}

/** 按当前开关创建回复：深度思考对应 thinking，智能搜索控制 deepseek_web_search。 */
const createReply = (snapshot?: Pick<AssistantMessage, 'thinking' | 'reasoningEffort'>): AssistantMessage => {
  const { thinking, search, model, apiProtocol } = useSettings.getState()
  const { apiBaseUrl } = useSettings.getState()
  const replyThinking = snapshot?.thinking ?? thinking
  const reasoningEffort = snapshot
    ? snapshot.reasoningEffort
    : replyThinking ? getModelReasoningProfile({ apiBaseUrl, apiProtocol, model }).selectedLevel : undefined
  return {
    id: createId(),
    role: 'assistant',
    createdAt: Date.now(),
    model,
    thinking: replyThinking,
    ...(reasoningEffort ? { reasoningEffort } : {}),
    search: supportsDeepSeekExtras() && search,
    prefix: apiProtocol === 'deepseek',
    status: 'pending',
    blocks: [],
  }
}

/** 仍在生成中的回复（页面关闭或导出时未结束）按「已停止」处理 */
const settleInterrupted = (session: Session): Session => {
  if (
    !session.messages.some(
      (m) => m.role === 'assistant' && (m.status === 'pending' || m.status === 'streaming')
    )
  ) {
    return session
  }
  return {
    ...session,
    messages: session.messages.map((m) =>
      m.role === 'assistant' && (m.status === 'pending' || m.status === 'streaming')
        ? settleReply(m, 'stopped', session.updatedAt)
        : m
    ),
  }
}

export const initChat = (): Promise<void> => {
  if (get().ready) {
    return Promise.resolve()
  }
  if (initTask) {
    return initTask
  }
  const epoch = historyEpoch
  set({ initError: false })
  initTask = (async () => {
    try {
      const summaries = await db.loadSessionSummaries()
      if (epoch === historyEpoch) {
        set({ ready: true, sessions: sortSessions(summaries) })
      }
    } catch (error) {
      if (epoch === historyEpoch) {
        set({ initError: true })
        db.reportStorageError('read local sessions')(error)
      }
    } finally {
      if (epoch === historyEpoch) {
        initTask = undefined
      }
    }
  })()
  return initTask
}

/** 同一会话合并并发读取；切换只改变 activeId，旧请求不会把界面切回去。 */
const ensureSessionLoaded = (id: string): Promise<void> => {
  if (getSession(id)) {
    return Promise.resolve()
  }
  const pending = sessionLoads.get(id)
  if (pending) {
    return pending.promise
  }
  const epoch = historyEpoch
  set((state) => ({ sessionLoadErrors: { ...state.sessionLoadErrors, [id]: false } }))
  const load = { promise: Promise.resolve() }
  sessionLoads.set(id, load)
  load.promise = (async () => {
    try {
      const stored = await db.loadSession(id)
      if (epoch !== historyEpoch || sessionLoads.get(id) !== load) {
        return
      }
      const summary = get().sessions.find((session) => session.id === id)
      if (!summary) {
        return
      }
      if (!stored) {
        throw new Error(`Session ${id} is missing from local storage`)
      }
      const settled = settleInterrupted(normalizeSession(stored))
      // 读取期间可能已在列表重命名，保留最新元数据，不能让旧读取覆盖它。
      const session = sameSummary(settled, summary) ? settled : { ...settled, ...summary }
      touchSession(id)
      set((state) => ({ sessionCache: { ...state.sessionCache, [id]: session } }))
      if (session !== stored) {
        persist(id)
      }
      trimSessionCache()
    } catch (error) {
      if (epoch === historyEpoch && sessionLoads.get(id) === load) {
        set((state) => ({ sessionLoadErrors: { ...state.sessionLoadErrors, [id]: true } }))
        db.reportStorageError('read session')(error)
      }
    } finally {
      if (sessionLoads.get(id) === load) {
        sessionLoads.delete(id)
      }
    }
  })()
  return load.promise
}

/** 等所有回复的收尾（落盘）完成 */
const waitForIdle = (sessionId?: string) =>
  new Promise<void>((resolve) => {
    const isIdle = (state: ChatState) =>
      sessionId === undefined
        ? Object.keys(state.streaming).length === 0
        : !hasOwn(state.streaming, sessionId)
    if (isIdle(get())) {
      resolve()
      return
    }
    const unsubscribe = useChatStore.subscribe((state) => {
      if (isIdle(state)) {
        unsubscribe()
        resolve()
      }
    })
  })

/**
 * 替换历史对话：先写入暂存，成功后原子替换旧记录；写入为空即删除全部会话与附件。
 * 期间停止生成并禁止修改会话；失败时清除暂存，保留原有记录。
 */
export const replaceHistory = async (write: () => Promise<void>): Promise<number> => {
  if (get().importingHistory) {
    throw new Error('History replacement is already in progress')
  }
  set({ importingHistory: true })
  try {
    for (const controller of Object.values(get().streaming)) {
      controller.abort()
    }
    // 已开始的单条删除先同步到内存，避免本次替换失败后列表残留已被删除的记录。
    await Promise.all(deletionTasks)
    historyEpoch += 1
    initTask = undefined
    sessionLoads.clear()
    await waitForIdle()
    await db.clearStaging()
    let summaries: SessionSummary[]
    try {
      await write()
      summaries = await db.commitStaging(true)
    } catch (error) {
      await db.clearStaging().catch(db.reportStorageError('clear unfinished history replacement'))
      throw error
    }
    sessionAccess.clear()
    unsavedSessions.clear()
    pendingFiles.clear()
    clearAllDrafts()
    clearPinnedSessions()
    clearFavoriteMessages()
    const sessions = sortSessions(summaries)
    const activeId = sessions[0]?.id ?? null
    set({
      ready: true,
      initError: false,
      sessions,
      sessionCache: {},
      sessionLoadErrors: {},
      sessionSaveErrors: {},
      activeId,
    })
    if (activeId !== null) {
      await ensureSessionLoaded(activeId)
    }
    return summaries.length
  } finally {
    set({ importingHistory: false })
    retrySaveSessions()
    const { activeId, ready } = get()
    // 替换失败时恢复被取消的详情读取，原有记录继续可用。
    if (activeId !== null) {
      void ensureSessionLoaded(activeId)
    } else if (!ready) {
      void initChat()
    }
  }
}

/** Commit incremental imports after local writes settle, then refresh affected cached conversations. */
export const appendStagedHistory = async (): Promise<number> => {
  await initChat()
  set({ importingHistory: true })
  try {
    const targets = await db.getStagedImportTargets()
    for (const id of targets) {
      getStreamController(id)?.abort()
    }
    await Promise.all(deletionTasks)
    await Promise.all([...targets].map((id) => waitForIdle(id)))
    await Promise.all([...targets].map((id) => sessionLoads.get(id)?.promise))
    for (const id of targets) {
      if (unsavedSessions.has(id) && !await persist(id)) {
        throw new Error('Unsaved local history must be saved before merging an import')
      }
    }
    if ((await Promise.all([...targets].map((id) => pendingSaves.get(id)))).some((saved) => saved === false)) {
      throw new Error('Unsaved local history must be saved before merging an import')
    }
    const summaries = await db.commitStaging()
    const affected = new Set(summaries.map((summary) => summary.id))
    const activeId = sortSessions(summaries)[0]?.id
    set((state) => ({
      sessions: sortSessions([...state.sessions.filter((summary) => !affected.has(summary.id)), ...summaries]),
      sessionCache: Object.fromEntries(Object.entries(state.sessionCache).filter(([id]) => !affected.has(id))),
      ...(activeId ? { activeId } : {}),
    }))
    if (activeId) {
      await ensureSessionLoaded(activeId)
    }
    return summaries.length
  } finally {
    set({ importingHistory: false })
    retrySaveSessions()
  }
}

export const newChat = () => {
  if (!get().importingHistory) {
    set({ activeId: null })
    trimSessionCache()
  }
}

/** 人物设定和开场白复制到新会话；普通新对话不隐式使用人物。 */
export const startCharacterChat = (preset: CharacterPreset, greetingIndex = 0): boolean => {
  if (!get().ready || get().importingHistory) {
    return false
  }
  const greetings = characterGreetings(preset)
  if (!Number.isInteger(greetingIndex) || greetingIndex < 0 || greetingIndex >= greetings.length) {
    return false
  }
  const opening = greetings[greetingIndex]
  const now = Date.now()
  const greeting: AssistantMessage | undefined = opening ? {
    id: createId(),
    role: 'assistant',
    questionDeleted: true,
    parentId: null,
    createdAt: now,
    model: null,
    prefix: false,
    status: 'done',
    stopReason: 'end_turn',
    blocks: [{ type: 'text', text: opening }],
  } : undefined
  const session: Session = {
    id: createId(),
    title: preset.name,
    createdAt: now,
    updatedAt: now,
    messages: greeting ? [greeting] : [],
    rootMessageId: greeting?.id ?? null,
    linearMessagePath: true,
    character: characterSnapshot(preset, opening),
  }
  touchSession(session.id)
  set((state) => ({
    sessions: [toSessionSummary(session), ...state.sessions],
    sessionCache: { ...state.sessionCache, [session.id]: session },
    activeId: session.id,
  }))
  persist(session.id)
  trimSessionCache()
  return true
}

export const selectSession = (id: string) => {
  if (!get().importingHistory && get().sessions.some((session) => session.id === id)) {
    touchSession(id)
    set({ activeId: id })
    void ensureSessionLoaded(id)
    trimSessionCache()
  }
}

export const openHistoryMatch = async (id: string, messageId: string | null) => {
  selectSession(id)
  await ensureSessionLoaded(id)
  const original = getSession(id)
  if (!original || get().activeId !== id || get().importingHistory || deletingSessions.has(id) || !messageId) {
    return
  }
  const session = normalizeSession(original)
  const byId = new Map(session.messages.map((message) => [message.id, message]))
  let child = byId.get(messageId)
  const choices = new Map<string, string>()
  const visited = new Set<string>()
  while (child?.parentId && !visited.has(child.id)) {
    visited.add(child.id)
    choices.set(child.parentId, child.id)
    child = byId.get(child.parentId)
  }
  if (!child) {
    return
  }
  updateSession(id, (current) => ({ ...current, rootMessageId: child.id,
    messages: current.messages.map((message) => choices.has(message.id)
      ? { ...message, selectedChildId: choices.get(message.id) } : message) }))
  useHistoryTarget.setState({ sessionId: id, messageId })
  persist(id)
}

export const setSessionContextMemory = (sessionId: string, fixed: string) => {
  if (get().importingHistory || get().streaming[sessionId] || deletingSessions.has(sessionId) || !getSession(sessionId)) {
    return
  }
  updateSession(sessionId, (session) => ({ ...session,
    contextMemory: { ...session.contextMemory, fixed: fixed.slice(0, 10_000) } }))
  persist(sessionId)
}

export const setFileContextExcluded = (sessionId: string, fileId: string, excluded: boolean): Promise<boolean> => {
  if (get().importingHistory || get().streaming[sessionId] || deletingSessions.has(sessionId) || !getSession(sessionId)) {
    return Promise.resolve(false)
  }
  let changed = false
  updateSession(sessionId, (session) => {
    const messages = session.messages.map((message) => {
      if (message.role !== 'user') {
        return message
      }
      let messageChanged = false
      const files = message.files.map((file) => {
        if (file.id !== fileId || file.isImage || Boolean(file.contextExcluded) === excluded) {
          return file
        }
        changed = messageChanged = true
        return { ...file, contextExcluded: excluded }
      })
      return messageChanged ? { ...message, files } : message
    })
    return changed ? { ...session, messages } : session
  })
  return changed ? persist(sessionId) : Promise.resolve(false)
}

export const renameSession = (id: string, title: string) => {
  if (get().importingHistory || deletingSessions.has(id)) {
    return
  }
  const controller = getStreamController(id)
  if (controller) {
    titleRequests.delete(controller)
  }
  if (getSession(id)) {
    updateSession(id, (session) => ({ ...session, title }))
    persist(id)
  } else {
    set((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === id ? { ...session, title } : session
      ),
    }))
    void db.renameSession(id, title).catch(db.reportStorageError('rename session'))
  }
}

/**
 * 删除会话；本地原件仅在没有其他会话引用时清理。远端文件不删：导入、编辑、重新生成都会复用同一个附件，
 * 同一服务端文件可能被多个会话引用，不维护引用计数。
 */
export const removeSession = (id: string): Promise<boolean> => {
  const task = removeSessionData(id).finally(() => deletionTasks.delete(task))
  deletionTasks.add(task)
  return task
}

const removeSessionData = async (id: string): Promise<boolean> => {
  if (get().importingHistory || deletingSessions.has(id)) {
    return false
  }
  const epoch = historyEpoch
  deletingSessions.add(id)
  try {
    getStreamController(id)?.abort()
    // 等本会话的流收尾，避免删除之后又被收尾保存写回来。
    await waitForIdle(id)
    if (epoch !== historyEpoch) {
      return false
    }
    await db.deleteSession(id)
    if (epoch !== historyEpoch) {
      return true
    }
    sessionLoads.delete(id)
    sessionAccess.delete(id)
    unsavedSessions.delete(id)
    pendingFiles.delete(id)
    clearDraft(id)
    setPinnedSession(id, false)
    removeFavoriteMessages(id)
    set((state) => ({
      sessions: state.sessions.filter((session) => session.id !== id),
      sessionCache: Object.fromEntries(
        Object.entries(state.sessionCache).filter(([key]) => key !== id)
      ),
      sessionLoadErrors: Object.fromEntries(
        Object.entries(state.sessionLoadErrors).filter(([key]) => key !== id)
      ),
      sessionSaveErrors: Object.fromEntries(
        Object.entries(state.sessionSaveErrors).filter(([key]) => key !== id)
      ),
      activeId: state.activeId === id ? null : state.activeId,
    }))
    return true
  } catch (error) {
    db.reportStorageError('delete session')(error)
    return false
  } finally {
    deletingSessions.delete(id)
    // 删除失败时保留会话，并保存停止生成后的最新状态。
    if (getSession(id)) {
      if (get().importingHistory) {
        unsavedSessions.add(id)
      } else {
        persist(id)
      }
    }
  }
}

export const stopReply = (sessionId: string) => getStreamController(sessionId)?.abort()

export const deleteMessages = (id: string, messageIds: readonly string[]): Promise<boolean> => {
  const task = deleteMessageData(id, messageIds).finally(() => deletionTasks.delete(task))
  deletionTasks.add(task)
  return task
}

export const deleteMessageRound = (id: string, messageId: string): Promise<boolean> => {
  const session = getSession(id)
  return session ? deleteMessages(id, getRoundMessageIds(session, messageId)) : Promise.resolve(false)
}

const deleteMessageData = async (id: string, messageIds: readonly string[]): Promise<boolean> => {
  const current = getSession(id)
  if (!current || get().importingHistory || deletingSessions.has(id) || getStreamController(id)) {
    return false
  }
  const ids = new Set(messageIds)
  let next = removeBranchMessages(current, ids)
  if (next === current) {
    return false
  }
  const character = current.character
  const greeting = character?.greeting
  if (character && greeting && current.messages.some((message) =>
    ids.has(message.id) && message.role === 'assistant' && message.questionDeleted &&
    !message.parentId && message.blocks.map((block) => block.type === 'text' ? block.text : '').join('') === greeting
  )) {
    const withoutGreeting = { ...character }
    delete withoutGreeting.greeting
    next = { ...next, character: withoutGreeting }
  }
  deletingSessions.add(id)
  try {
    await pendingSaves.get(id)
    await db.saveSession(next, pendingFiles.get(id))
    updateSession(id, () => next)
    removeFavoriteMessages(id, messageIds)
    pendingFiles.delete(id)
    unsavedSessions.delete(id)
    set((state) => ({
      sessionSaveErrors: Object.fromEntries(Object.entries(state.sessionSaveErrors).filter(([key]) => key !== id)),
    }))
    return true
  } catch (error) {
    db.reportStorageError('delete messages')(error)
    return false
  } finally {
    deletingSessions.delete(id)
  }
}

const notNeededStatus = (reason?: CompactionSkipReason) =>
  reason === 'tooShort' ? 'notNeededTooShort'
    : reason === 'requiredSystemTooLarge' ? 'notNeededSystemTooLarge'
    : reason === 'nothingExtracted' ? 'notNeededNothingExtracted'
    : 'notNeeded'

/** Local command: compact the selected branch without creating a chat turn. */
export const compactSession = async (
  sessionId: string | null
): Promise<'saved' | 'failed' | 'failedConnection' | 'failedContextLimit' | 'failedProvider' | 'failedTimeout' | 'failedResponse' | 'failedStorage' | 'notNeeded' | 'notNeededTooShort' | 'notNeededSystemTooLarge' | 'notNeededNothingExtracted' | 'cancelled'> => {
  if (sessionId === null) {return 'notNeeded'}
  const session = getSession(sessionId)
  const settings = useSettings.getState()
  if (!session || !settings.apiKey || get().importingHistory || getStreamController(sessionId) ||
      deletingSessions.has(sessionId)) {return 'cancelled'}
  const controller = new AbortController()
  const { signal } = controller
  const epoch = historyEpoch
  const connection = getApiConnection()
  const valid = () => !signal.aborted && !get().importingHistory && historyEpoch === epoch &&
    getSession(sessionId) === session && !deletingSessions.has(sessionId)
  set((state) => ({ streaming: { ...state.streaming, [sessionId]: controller } }))
  try {
    const pending = pendingSaves.get(sessionId)
    if ((pending && !(await pending)) || unsavedSessions.has(sessionId)) {return 'failed'}
    const snapshot = await db.loadMemorySnapshot(sessionId)
    if (!snapshot || !valid()) {return 'cancelled'}
    if (JSON.stringify(snapshot.session.character) !== JSON.stringify(session.character)) {return 'failed'}
    const history = getVisibleMessages(session)
    const stored = getVisibleMessages(snapshot.session)
    if (stored.length !== history.length || stored.some((message, i) =>
      message.id !== history[i].id || memoryText(message) !== memoryText(history[i])
    )) {return 'failed'}
    const context = await prepareContextMemory({
      mode: 'manual',
      sessionId,
      history,
      question: { id: '', role: 'user', content: '', files: [], createdAt: Date.now() },
      memory: snapshot.session.contextMemory,
      snapshot,
      apiKey: settings.apiKey,
      connection,
      model: settings.model,
      signal,
      inputBudget: getEffectiveContextInputBudget(),
      outputReserve: settings.generation.maxTokens,
      requestOverhead: estimateContextTokens(
        characterSystemPrompt(settings.generation.system ?? SYSTEM_PROMPT, session.character) +
          createLatestReminder(settings) +
          JSON.stringify(supportsDeepSeekExtras(connection)
            ? serverTools(settings.search, settings.model) : [])
      ) + 256,
      onCommit: (update) => db.commitMemoryUpdate(snapshot.state, update, valid),
      onInputLimit: (limit) => {
        const budget = Math.floor(limit * 0.85)
        const route = JSON.stringify([connection.baseUrl, connection.protocol, settings.model,
          settings.thinking, supportsDeepSeekExtras(connection) && settings.search])
        learnedContextLimit = { route, key: settings.apiKey ?? '', budget }
      },
      onProgress: (progress) => set((state) => ({
        contextProgress: { ...state.contextProgress, [sessionId]: { ...progress, manual: true } },
      })),
    })
    if (context.compactionFailure) {
      return manualCompactionFailure(context.compactionFailure)
    }
    if (context.compaction === 'failed') {return 'failedResponse'}
    if (context.compaction === 'notNeeded') {return notNeededStatus(context.compactionSkipReason)}
    return context.compaction ?? 'notNeeded'
  } catch (error) {
    if (signal.aborted) {
      return 'cancelled'
    }
    if (error instanceof ApiError) {
      if (getContextLengthError(error)) {
        return 'failedContextLimit'
      }
      if (classifyApiError(error) === 'network') {
        return 'failedConnection'
      }
      if (error.kind === 'protocol' && error.localMessage?.key === 'contextMemoryFailed') {
        return 'failedStorage'
      }
      if (classifyApiError(error) !== 'other') {
        return 'failedProvider'
      }
    }
    return 'failedResponse'
  } finally {
    set((state) => ({
      streaming: Object.fromEntries(Object.entries(state.streaming).filter(([id]) => id !== sessionId)),
      contextProgress: Object.fromEntries(Object.entries(state.contextProgress).filter(([id]) => id !== sessionId)),
    }))
  }
}

const manualCompactionFailure = (failure: CompactionFailure | 'storage') => {
  switch (failure) {
    case 'connection': return 'failedConnection'
    case 'contextLimit': return 'failedContextLimit'
    case 'insufficientBudget': return 'failedContextLimit'
    case 'provider': return 'failedProvider'
    case 'timeout': return 'failedTimeout'
    case 'storage': return 'failedStorage'
    case 'truncated':
    case 'invalidResponse':
    case 'cooldown': return 'failedResponse'
  }
}

const automaticCompactionFailureMessage = (failure: CompactionFailure | 'storage' | undefined) => {
  switch (failure) {
    case 'connection': return 'contextMemoryManualConnectionFailed'
    case 'contextLimit': return 'contextMemoryManualContextLimit'
    case 'provider': return 'contextMemoryManualProviderFailed'
    case 'timeout': return 'contextMemoryManualTimeout'
    case 'storage': return 'contextMemoryManualStorageFailed'
    case 'cooldown': return 'contextMemoryAutoCooldown'
    case 'insufficientBudget': return 'contextMemoryAutoInsufficientBudget'
    case 'truncated':
    case 'invalidResponse':
    case undefined: return 'contextMemoryManualResponseFailed'
  }
}

/**
 * 提交指定会话的最新草稿；null 表示新建会话。
 * 同步接收成功才清空草稿，附件原件由会话接管；保存失败仍通过保存入口重试。
 */
export const sendMessage = (targetSessionId: string | null) => {
  if (get().importingHistory || !get().ready) {
    return false
  }
  const prepared = prepareDraftMessage(getDraft(targetSessionId), useUploads.getState().tasks)
  if (!prepared) {
    return false
  }
  const { text, files } = prepared
  const now = Date.now()
  let sessionId = targetSessionId
  if (
    sessionId !== null &&
    (deletingSessions.has(sessionId) || getStreamController(sessionId) || !getSession(sessionId))
  ) {
    return false
  }
  if (sessionId === null) {
    const session: Session = {
      id: createId(),
      title: '',
      createdAt: now,
      updatedAt: now,
      messages: [],
      rootMessageId: null,
      linearMessagePath: true,
    }
    sessionId = session.id
    touchSession(session.id)
    set((state) => ({
      sessions: [toSessionSummary(session), ...state.sessions],
      sessionCache: { ...state.sessionCache, [session.id]: session },
      activeId: session.id,
    }))
  }
  const current = getSession(sessionId)
  if (!current) {
    return false
  }
  const history = getVisibleMessages(current)
  const question: UserMessage = {
    id: createId(),
    role: 'user',
    content: text,
    files: files.map(({ id, serverId, name, size, isImage, mimeType, uploadPurpose }) => ({
      id,
      serverId,
      name,
      size,
      isImage,
      mimeType,
      uploadPurpose,
    })),
    createdAt: now,
  }
  const reply = createReply()
  updateSession(sessionId, (session) => ({
    ...appendBranch(session, history[history.length - 1]?.id ?? null, [question, reply]),
    updatedAt: now,
  }))
  const localFiles = new Map<string, LocalAttachmentContent>()
  if (files.length > 0) {
    pendingFiles.set(sessionId, [
      ...(pendingFiles.get(sessionId) ?? []),
      ...files.map(({ id, blob, localText }) => ({ id, blob, ...(localText ? { extractedText: localText } : {}) })),
    ])
    for (const file of files) {
      if (!file.isImage && file.localText) {
        localFiles.set(file.id, { type: 'text', text: file.localText })
      }
    }
  }
  persist(sessionId)
  clearSentDraft(targetSessionId)
  void streamReply(sessionId, reply, { history, question, localFiles })
  return true
}

/** 重新生成当前路径上的回答：在原问题下新增版本，不覆盖旧回答和后续对话。 */
export const regenerateReply = (sessionId: string, messageId?: string) => {
  if (get().importingHistory || deletingSessions.has(sessionId)) {
    return
  }
  const session = getSession(sessionId)
  if (!session || getStreamController(sessionId)) {
    return
  }
  const path = getVisibleMessages(session)
  const index =
    messageId === undefined ? path.length - 1 : path.findIndex((m) => m.id === messageId)
  const question = path[index - 1]
  const previous = path[index]
  if (question?.role !== 'user' || previous?.role !== 'assistant' || previous.questionDeleted) {
    return
  }
  const history = path.slice(0, index - 1)
  const reply = createReply({ thinking: previous.thinking, reasoningEffort: previous.reasoningEffort })
  updateSession(sessionId, (s) => ({
    ...appendBranch(s, question.id, [reply]),
    updatedAt: Date.now(),
  }))
  persist(sessionId)
  void streamReply(sessionId, reply, { history, question })
}

/** 编辑提问后新增同父版本，保留原文件；旧问题的所有回答与后续对话仍可切回。 */
export const editMessage = (sessionId: string, messageId: string, content: string): boolean => {
  if (get().importingHistory || deletingSessions.has(sessionId)) {
    return false
  }
  const session = getSession(sessionId)
  if (!session || getStreamController(sessionId)) {
    return false
  }
  const path = getVisibleMessages(session)
  const index = path.findIndex((message) => message.id === messageId)
  const previous = path[index]
  const text = content.trim()
  if (previous?.role !== 'user' || (!text && previous.files.length === 0)) {
    return false
  }
  const question: UserMessage = {
    id: createId(),
    role: 'user',
    content: text,
    files: previous.files,
    createdAt: Date.now(),
  }
  const reply = createReply()
  updateSession(sessionId, (s) => ({
    ...appendBranch(s, path[index - 1]?.id ?? null, [question, reply]),
    updatedAt: Date.now(),
  }))
  persist(sessionId)
  void streamReply(sessionId, reply, { history: path.slice(0, index), question })
  return true
}

export const selectMessageVersion = (sessionId: string, messageId: string) => {
  if (get().importingHistory || deletingSessions.has(sessionId)) {
    return
  }
  if (getStreamController(sessionId)) {
    return
  }
  updateSession(sessionId, (session) => selectVersion(session, messageId))
  persist(sessionId)
}

/** 继续最后一条未完成的回答：保留原消息与开关，仅将新流的内容追加到原块之后。 */
export const continueReply = (sessionId: string, messageId: string) => {
  if (get().importingHistory || deletingSessions.has(sessionId) || useSettings.getState().apiProtocol !== 'deepseek') {
    return
  }
  const session = getSession(sessionId)
  if (!session || getStreamController(sessionId)) {
    return
  }
  const path = getVisibleMessages(session)
  const question = path[path.length - 2]
  const previous = path[path.length - 1]
  if (
    question?.role !== 'user' ||
    previous?.role !== 'assistant' ||
    previous.questionDeleted ||
    previous.id !== messageId ||
    !canContinueReply(previous)
  ) {
    return
  }
  const { thinking, search, model } = useSettings.getState()
  const reply: AssistantMessage = {
    ...previous,
    // 未记录请求配置的回复，续写时使用默认模型和当前开关。
    model: previous.model ?? model,
    thinking: previous.thinking ?? thinking,
    search: previous.search ?? search,
    status: 'pending',
    stopReason: undefined,
    stopDetails: undefined,
    usage: undefined,
    metrics: undefined,
    error: undefined,
  }
  updateReply(sessionId, reply)
  updateSession(sessionId, (s) => ({ ...s, updatedAt: Date.now() }))
  persist(sessionId)
  void streamReply(sessionId, reply, { history: path.slice(0, -2), question, prefix: previous })
}

/** 附件补传失败后重试：保留原回答位置，重新补传并请求 */
export const retryUpload = (sessionId: string, messageId: string) => {
  if (get().importingHistory || deletingSessions.has(sessionId)) {
    return
  }
  const session = getSession(sessionId)
  if (!session || getStreamController(sessionId)) {
    return
  }
  const path = getVisibleMessages(session)
  const index = path.findIndex((message) => message.id === messageId)
  const question = path[index - 1]
  const previous = path[index]
  if (
    question?.role !== 'user' ||
    previous?.role !== 'assistant' ||
    previous.questionDeleted ||
    previous.error?.kind !== 'upload'
  ) {
    return
  }
  const reply: AssistantMessage = { ...previous, status: 'pending', error: undefined }
  updateReply(sessionId, reply)
  persist(sessionId)
  void streamReply(sessionId, reply, { history: path.slice(0, index - 1), question })
}

type Request = {
  history: Message[]
  question: UserMessage
  prefix?: AssistantMessage
  localFiles?: Map<string, LocalAttachmentContent>
}

/** 把补传得到的 serverId 写回会话里所有引用同一附件的消息（编辑、重新生成会共用附件） */
const saveServerIds = (sessionId: string, serverIds: Map<string, string>) => {
  if (serverIds.size === 0) {
    return
  }
  let changed = false
  updateSession(sessionId, (session) => {
    const messages = session.messages.map((message) => {
      if (message.role !== 'user') {
        return message
      }
      let filesChanged = false
      const files = message.files.map((file) => {
        const serverId = serverIds.get(file.id)
        if (!serverId || serverId === file.serverId) {
          return file
        }
        filesChanged = true
        return { ...file, serverId }
      })
      changed ||= filesChanged
      return filesChanged ? { ...message, files } : message
    })
    return changed ? { ...session, messages } : session
  })
  if (changed) {
    persist(sessionId)
  }
}

/**
 * 附件的服务端 id：已有直接用；正在上传的等待同一任务；否则读取本地原件补传。
 * 本地也没有原件（导入的文档附件只有元数据）时返回 null，该附件只展示、不进入请求。
 */
const ensureServerId = async (apiKey: string, file: FileAttachment, connection: ApiConnection): Promise<string | null> => {
  if (!file.isImage && file.contextExcluded) {
    return null
  }
  if (file.serverId) {
    return file.serverId
  }
  const task = useUploads.getState().tasks[file.id]
  if (task?.status === 'done' && task.serverId) {
    return task.serverId
  }
  const blob = await db.loadFile(file.id)
  if (!blob) {
    return null
  }
  if (!file.isImage && getUploadPurpose(file.name, false) !== 'user_data') {
    throw new ApiError('protocol', { key: 'replyDocumentNeedsConfirmation' })
  }
  return uploadAttachment(apiKey, file.id, blob, file.name, file.isImage, connection, file.uploadPurpose)
}

/** 用会话里的最新消息替换请求快照：重传前会重置附件的 serverId，快照必须跟着更新 */
const refreshRequest = (sessionId: string, request: Request): Request => {
  const session = getSession(sessionId)
  if (!session) {
    return request
  }
  const byId = new Map(session.messages.map((message) => [message.id, message]))
  const pick = <T extends Message>(message: T): T =>
    (byId.get(message.id) as T | undefined) ?? message
  return {
    history: request.history.map(pick),
    question: pick(request.question),
    prefix: request.prefix,
  }
}

/**
 * 发送前补齐附件的 serverId。
 * - 本轮提问的附件并行补齐，任一失败则整体失败，已成功的照常写回，重试时复用成功结果；
 * - 历史轮次（仅进入上下文的）中没有 serverId 的附件，多为导入的图片：从最新的消息往前逐张补传，
 *   图片失败静默跳过；需要付费解析的文档必须由用户重新选择确认。
 */
const prepareFiles = async (sessionId: string, request: Request, signal: AbortSignal, apiKey: string, connection: ApiConnection, omitHistoryImages = false) => {
  if (
    request.question.files.length === 0 &&
    !request.history.some((message) => message.role === 'user' && message.files.length > 0)
  ) {
    return request
  }
  request = refreshRequest(sessionId, request)
  request = { ...request, ...await limitRequestImages(request.history, request.question, db.loadFile, omitHistoryImages) }
  if (!supportsDeepSeekExtras(connection)) {
    await pendingSaves.get(sessionId)
    const localFiles = new Map(request.localFiles ?? [])
    const currentIds = new Set(request.question.files.map((file) => file.id))
    const users = [...getContextRounds(request.history).map(([user]) => user), request.question]
    const seen = new Set<string>()
    for (const user of users) {
      for (const file of user.files) {
        if (seen.has(file.id) || (file.contextExcluded && !file.isImage)) {
          continue
        }
        seen.add(file.id)
        if (localFiles.has(file.id)) {
          continue
        }
        if (signal.aborted) {
          throw signal.reason ?? new DOMException('Aborted', 'AbortError')
        }
        const stored = await db.loadStoredFile(file.id)
        if (!stored?.blob) {
          if (currentIds.has(file.id)) {
            throw new ApiError('protocol', { key: 'replyFileMissingLocal' })
          }
          continue
        }
        if (file.isImage) {
          localFiles.set(file.id, await encodeLocalImage(stored.blob))
          continue
        }
        try {
          const text = stored.extractedText ?? await extractLocalAttachmentText(stored.blob, file.name, file.mimeType)
          if (stored.extractedText === undefined) {
            await db.saveFiles([{ ...stored, extractedText: text }])
          }
          localFiles.set(file.id, { type: 'text', text })
        } catch (error) {
          if (error instanceof LocalAttachmentError) {
            const key = error.kind === 'unsupported'
              ? 'uploadLocalUnsupported'
              : error.kind === 'tooLong'
                ? 'uploadLocalTooLong'
                : error.kind === 'empty'
                  ? 'uploadLocalEmpty'
                  : 'uploadLocalFailed'
            throw new ApiError('protocol', { key })
          }
          throw error
        }
      }
    }
    return { ...request, localFiles }
  }
  request = { ...request, localFiles: undefined }
  const epoch = historyEpoch
  // 服务端判定 file_id 失效时会清掉会话里的 serverId，先用最新消息替换请求快照，
  // 否则快照里仍是旧 id，补传会直接复用它。
  const serverIds = new Map<string, string>()
  // 停止生成立即生效；上传本身不取消（输入框与其他消息可能共用同一任务），完成后照常写回 serverId
  const aborted = new Promise<never>((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
  const uploads = Promise.allSettled(
    request.question.files.map(async (file) => {
      if (file.serverId || (!file.isImage && file.contextExcluded)) {
        return
      }
      const serverId = await ensureServerId(apiKey, file, connection)
      if (serverId) {
        serverIds.set(file.id, serverId)
      }
    })
  )
  void uploads.then(() => {
    if (epoch === historyEpoch) {
      saveServerIds(sessionId, serverIds)
    }
  })
  const results = await Promise.race([uploads, aborted])
  const failed = results.find((result) => result.status === 'rejected')
  if (failed) {
    throw failed.reason
  }

  const pending = new Map<string, FileAttachment>()
  for (const [user] of getContextRounds(request.history).slice().reverse()) {
    for (const file of user.files) {
      if (!(file.contextExcluded && !file.isImage) && !file.serverId && !serverIds.has(file.id) && !pending.has(file.id)) {
        pending.set(file.id, file)
      }
    }
  }
  for (const file of pending.values()) {
    if (signal.aborted) {
      throw signal.reason ?? new DOMException('Aborted', 'AbortError')
    }
    try {
      const serverId = await Promise.race([ensureServerId(apiKey, file, connection), aborted])
      if (serverId) {
        serverIds.set(file.id, serverId)
        saveServerIds(sessionId, new Map([[file.id, serverId]]))
      }
    } catch (error) {
      if (signal.aborted) {
        throw signal.reason ?? new DOMException('Aborted', 'AbortError')
      }
      if (error instanceof ApiError && error.localMessage?.key === 'replyDocumentNeedsConfirmation') {
        throw error
      }
    }
  }

  // 用补齐后的会话重新取历史与提问，保证请求里都是 serverId
  const withServerIds = (message: UserMessage): UserMessage => ({ ...message,
    files: message.files.map((file) => serverIds.has(file.id) ? { ...file, serverId: serverIds.get(file.id) ?? file.serverId } : file),
  })
  return serverIds.size === 0 ? request : { ...request,
    history: request.history.map((message) => message.role === 'user' ? withServerIds(message) : message),
    question: withServerIds(request.question),
  }
}

/** 本次请求实际会用到的服务端 file_id */
const collectServerFileIds = (request: Request): Set<string> => {
  const ids = new Set<string>()
  const add = (files: FileAttachment[]) => {
    for (const file of files) {
      if (file.serverId && (file.isImage || !file.contextExcluded)) {
        ids.add(file.serverId)
      }
    }
  }
  add(request.question.files)
  for (const [user] of getContextRounds(request.history)) {
    add(user.files)
  }
  return ids
}

/**
 * 服务端判定 file_id 失效时，清掉对应附件的 serverId 并丢弃旧的上传任务，
 * 下一次补齐会重新读取本地原件上传。报错里点名了 file_id 就只重置这些，
 * 没点名（如 invalid file_id）则重置本次请求用到的全部附件。
 */
const reuploadInvalidatedFiles = (sessionId: string, request: Request, error: unknown, fileIds?: Set<string>): boolean | 'confirmationRequired' => {
  if (!fileIds && (!(error instanceof ApiError) || !getFileErrorCode(error))) {
    return false
  }
  const mentioned = error instanceof Error ? extractFileIds(error.message) : []
  // 重试时原始快照里还是上一轮已被清掉的 serverId，先换成会话里的最新消息
  const targets =
    fileIds ?? (mentioned.length > 0
      ? new Set(mentioned)
      : collectServerFileIds(refreshRequest(sessionId, request)))
  const session = getSession(sessionId)
  if (targets.size === 0 || !session) {
    return false
  }
  // Word/PDF/PPT 重新上传会再次按页解析收费，必须由用户重新选文件确认。
  if (session.messages.some((message) => message.role === 'user' && message.files.some((file) =>
    file.serverId && targets.has(file.serverId) && !file.contextExcluded && !file.isImage &&
    getUploadPurpose(file.name, false) !== 'user_data'
  ))) {
    return 'confirmationRequired'
  }
  const localIds: string[] = []
  const messages = session.messages.map((message) => {
    if (message.role !== 'user') {
      return message
    }
    let changed = false
    const files = message.files.map((file) => {
      if (!file.serverId || !targets.has(file.serverId)) {
        return file
      }
      localIds.push(file.id)
      changed = true
      return { ...file, serverId: null }
    })
    return changed ? { ...message, files } : message
  })
  if (localIds.length === 0) {
    return false
  }
  updateSession(sessionId, (current) => ({ ...current, messages }))
  // 上传任务里可能还留着同一个失效的 serverId，清掉后 ensureServerId 才会重新上传
  localIds.forEach(cancelUpload)
  persist(sessionId)
  return true
}

/** 重传前的退避等待；停止生成时立即返回，由调用方按已停止收尾 */
const waitForRetry = (attempt: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    function onAbort() {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(
      () => {
        signal.removeEventListener('abort', onAbort)
        resolve()
      },
      FILE_RETRY_BASE_DELAY * 2 ** attempt
    )
    signal.addEventListener('abort', onAbort, { once: true })
  })

/**
 * 请求并消费流：先补齐附件的 serverId，再发请求；流式增量按动画帧刷新内存，完成、失败或停止后落盘。
 * 补传失败时回复记为 upload 错误，可重试。
 * 图片等 file_id 失效时有界补传后重发；付费文档提示用户重新确认，不自动解析。
 */
const streamReply = async (sessionId: string, initial: AssistantMessage, request: Request) => {
  const settings = useSettings.getState()
  const connection = getApiConnection()
  const apiKey = settings.apiKey ?? ''
  const model = initial.model ?? settings.model
  const automaticCompactionEnabled = () => settings.contextMemoryEnabled && useSettings.getState().contextMemoryEnabled
  const generation = settings.generation
  const sourceSession = getSession(sessionId)
  const baseSystem = characterSystemPrompt(generation.system ?? SYSTEM_PROMPT, sourceSession?.character)
  const contextRoute = JSON.stringify([connection.baseUrl, connection.protocol, model, initial.thinking, initial.search])
  let inputBudget = learnedContextLimit?.route === contextRoute && learnedContextLimit.key === apiKey
    ? learnedContextLimit.budget
    : undefined
  const contextWindow = generation.contextTokens ?? DEFAULT_CONTEXT_WINDOW
  const defaultInputBudget = generation.contextTokens ?? DEFAULT_REQUEST_INPUT_BUDGET
  const effectiveBudget = () => Math.min(inputBudget ?? defaultInputBudget, contextWindow)
  const memoryBudget = () => Math.min(effectiveBudget(), generation.contextTokens ?? contextWindow)
  let retriedContextLimit = false
  let attachmentRetries = 0
  const repairedImageIds = new Set<string>()
  const extras = supportsDeepSeekExtras(connection)
  const serverExtras = extras
  const imageRoute = JSON.stringify([connection.baseUrl, connection.protocol, model])
  if (extras && (rejectedHistoryImages?.route !== imageRoute || rejectedHistoryImages.key !== apiKey)) {
    rejectedHistoryImages = { route: imageRoute, key: apiKey, ids: new Set() }
  }
  const knownRejectedImageIds = extras ? rejectedHistoryImages?.ids : undefined
  const latestReminder = request.prefix
    ? request.prefix.latestReminder
    : createLatestReminder(settings)
  const sourceEpoch = historyEpoch
  const controller = new AbortController()
  if (!getSession(sessionId)?.title) {
    titleRequests.add(controller)
  }
  set((state) => ({ streaming: { ...state.streaming, [sessionId]: controller } }))
  let reply: AssistantMessage = { ...initial, latestReminder }
  let frame = 0
  const flush = () => {
    cancelAnimationFrame(frame)
    frame = 0
    updateReply(sessionId, reply)
  }
  streamFlushes.set(sessionId, flush)
  let contextPrepared = false
  let compactContext = false
  let systemMemory = ''
  let requiredSystem = baseSystem
  let sourceConflict = false
  let sourceState: MemoryState | undefined
  // 接口拒绝的历史图片只在本次生成的请求中省略。
  const excludedHistoryImageIds = new Set<string>()
  let retriedWithoutHistoryImages = false
  let omitHistoryImages = false
  const initialSave = pendingSaves.get(sessionId)
  if (settings.contextMemoryEnabled) {
    contextPreparations.add(sessionId)
  }
  const unsubscribeAutomaticCompaction = useSettings.subscribe((state) => {
    if (settings.contextMemoryEnabled && !state.contextMemoryEnabled && contextPreparations.has(sessionId)) {
      controller.abort()
    }
  })

  try {
    await yieldToBrowser()
    const contextEnabled = settings.contextMemoryEnabled || await db.hasContextCheckpoint(sessionId).catch((error) => {
      db.reportStorageError('read context checkpoint')(error)
      return false
    })
    if (contextEnabled) {
      contextPreparations.add(sessionId)
    }
    for (;;) {
      /** 附件补齐前出错属于上传失败，请求还没有发出 */
      let preparing = false
      let receivedContent = false
      let submitted: CreateMessageRequest | undefined
      let firstGeneratedAt: number | undefined
      let lastGeneratedAt: number | undefined
      const complete = () => {
        const completed = settleReply(reply, 'done', Date.now())
        if (completed.status !== 'done' || !completed.metrics || firstGeneratedAt === undefined ||
          lastGeneratedAt === undefined || lastGeneratedAt - firstGeneratedAt < 100) {
          return completed
        }
        const tokensPerSecond = getTokenRate(completed.usage, performance.now() - firstGeneratedAt)
        return tokensPerSecond === undefined ? completed : {
          ...completed,
          metrics: { ...completed.metrics, tokensPerSecond },
        }
      }
      try {
        if (controller.signal.aborted) {
          throw controller.signal.reason
        }
        if (!contextPrepared && contextEnabled) {
          const validSource = () =>
            !controller.signal.aborted &&
            historyEpoch === sourceEpoch &&
            getSession(sessionId) === sourceSession &&
            (!settings.contextMemoryEnabled || useSettings.getState().contextMemoryEnabled)
          if (initialSave && !(await initialSave)) {
            throw new ApiError('protocol', { key: 'contextMemoryFailed' })
          }
          const snapshot = await db.loadMemorySnapshot(sessionId)
          if (!snapshot) {
            sourceConflict = true
            throw new ApiError('protocol', { key: 'contextMemoryFailed' })
          }
          sourceState = snapshot.state
          if (
            (snapshot.session.contextMemory?.fixed ?? '') !==
            (sourceSession?.contextMemory?.fixed ?? '') ||
            JSON.stringify(snapshot.session.character) !== JSON.stringify(sourceSession?.character)
          ) {
            sourceConflict = true
            throw new ApiError('protocol', { key: 'contextMemoryFailed' })
          }
          // A second tab may have written a different branch before the snapshot was loaded.
          const savedPath = getVisibleMessages(snapshot.session)
          const persistedPath = new Map(savedPath.map((message) => [message.id, message]))
          if (
            savedPath.length !== request.history.length + 2 ||
            savedPath[savedPath.length - 1]?.id !== initial.id ||
            [...request.history, request.question].some((message, index) => {
              const stored = persistedPath.get(message.id)
              return (
                !stored ||
                savedPath[index]?.id !== message.id ||
                stored.createdAt !== message.createdAt ||
                stored.role !== message.role ||
                memoryText(stored) !== memoryText(message) ||
                (stored.role === 'user' &&
                  message.role === 'user' &&
                  JSON.stringify(stored.files) !== JSON.stringify(message.files))
              )
            })
          ) {
            sourceConflict = true
            throw new ApiError('protocol', { key: 'contextMemoryFailed' })
          }
          if (request.prefix) {
            const stored = persistedPath.get(request.prefix.id)
            if (
              stored?.role !== 'assistant' ||
              JSON.stringify(stored.blocks) !== JSON.stringify(request.prefix.blocks)
            ) {
              sourceConflict = true
              throw new ApiError('protocol', { key: 'contextMemoryFailed' })
            }
          }
          if (!validSource()) {
            throw new ApiError('protocol', { key: 'contextMemoryFailed' })
          }
          let expected = snapshot.state
          const context = await prepareContextMemory({
            mode: automaticCompactionEnabled() ? 'auto' : 'reuse',
            sessionId,
            snapshot,
            history: request.history,
            question: request.question,
            prefix: request.prefix,
            memory: sourceSession?.contextMemory,
            apiKey,
            thinking: initial.thinking ?? false,
            connection,
            model,
            signal: controller.signal,
            inputBudget: memoryBudget(),
            outputReserve: generation.maxTokens,
            requestOverhead:
              estimateContextTokens(
                baseSystem +
                  (latestReminder ?? '') +
                  JSON.stringify(serverExtras ? serverTools(initial.search ?? false, model) : [])
              ) + 256,
            onInputLimit: (limit) => {
              inputBudget = Math.min(inputBudget ?? Infinity, Math.floor(limit * 0.85))
              learnedContextLimit = { route: contextRoute, key: apiKey, budget: inputBudget }
            },
            onCommit: async (update) => {
              if (!validSource()) {
                return false
              }
              if (!(await db.commitMemoryUpdate(expected, update, validSource))) {
                sourceConflict = validSource()
                return false
              }
              expected = { ...expected, memoryRevision: expected.memoryRevision + 1 }
              sourceState = expected
              return validSource()
            },
            onProgress: (progress) =>
              set((state) => ({
                contextProgress: { ...state.contextProgress, [sessionId]: progress },
              })),
          })
          if (!validSource()) {
            throw new ApiError('protocol', { key: 'contextMemoryFailed' })
          }
          if (context.compaction === 'failed' || context.compactionFailure) {
            throw new ApiError('protocol', {
              key: automaticCompactionFailureMessage(context.compactionFailure),
            })
          }
          if (
            !(await db.commitMemoryUpdate(expected, { records: [], segments: [] }, validSource))
          ) {
            sourceConflict = validSource()
            throw new ApiError('protocol', { key: 'contextMemoryFailed' })
          }
          request = { ...request, history: context.history }
          compactContext = context.active
          systemMemory = context.systemMemory
          if (context.requiredSystemMemory) {
            requiredSystem = [baseSystem, context.requiredSystemMemory].join('\n\n')
          }
          set((state) => ({
            contextProgress: Object.fromEntries(
              Object.entries(state.contextProgress).filter(([id]) => id !== sessionId)
            ),
          }))
        }
        contextPreparations.delete(sessionId)
        contextPrepared = true
        preparing = true
        const prepared = await prepareFiles(sessionId, request, controller.signal, apiKey, connection, omitHistoryImages)
        preparing = false
        if (controller.signal.aborted) {
          throw controller.signal.reason
        }
        const history =
          excludedHistoryImageIds.size > 0 || knownRejectedImageIds?.size
            ? prepared.history.map((message) => {
                if (message.role !== 'user' || message.files.length === 0) {
                  return message
                }
                const files = message.files.filter(
                  (file) => !file.isImage || !file.serverId ||
                    (!excludedHistoryImageIds.has(file.serverId) && !knownRejectedImageIds?.has(file.serverId))
                )
                return files.length === message.files.length ? message : { ...message, files }
              })
            : prepared.history
        const messages = toRequestMessages(
          history,
          prepared.question,
          prepared.prefix,
          initial.thinking ?? false,
          latestReminder,
          false,
          prepared.localFiles
        )
        let body: CreateMessageRequest = {
          model,
          ...generationParameters(generation, connection, initial.thinking ?? false),
          system: [baseSystem, systemMemory].filter(Boolean).join('\n\n'),
          messages,
          thinking: { type: initial.thinking && initial.reasoningEffort !== 'none' ? 'enabled' : 'disabled' },
          ...(initial.thinking && initial.reasoningEffort ? { reasoningEffort: initial.reasoningEffort } : {}),
          safety_check: SAFETY_CHECK,
          tools: serverExtras ? serverTools(initial.search ?? false, model) : [],
          ...(serverExtras && supportsDeepSeekTitles(model) && titleRequests.has(controller) ? { title: { enabled: true } } : {}),
        }
        if (automaticCompactionEnabled()) {
          body = fitRequestHistory(body, compactContext ? memoryBudget() : effectiveBudget(), requiredSystem)
        }
        body = adaptRequestForConnection(body, connection)
        submitted = body
        reply = { ...reply, metrics: estimateRequestParts(body) }
        const events = streamMessage(apiKey, body, controller.signal, connection)
        const blockIndexes = new Map<number, number>()
        let eventsSinceYield = 0
        for await (const event of events) {
          if (controller.signal.aborted) {
            throw controller.signal.reason
          }
          if (
            !initial.thinking &&
            event.type === 'content_block_start' &&
            event.content_block.type === 'thinking'
          ) {
            continue
          }
          receivedContent ||= event.type === 'content_block_start'
          if (
            event.type === 'message_delta' &&
            (event.delta.stop_reason === 'end_turn' || event.delta.stop_reason === 'max_tokens') &&
            event.delta.title?.trim() &&
            titleRequests.has(controller) &&
            !controller.signal.aborted &&
            !get().importingHistory
          ) {
            const title = event.delta.title.trim()
            updateSession(sessionId, (session) => (session.title ? session : { ...session, title }))
            titleRequests.delete(controller)
          }
          reply = applyEvent(reply, event, Date.now(), blockIndexes)
          const generatedText = hasVisibleReplyText(getGeneratedText(event))
          const firstText = firstGeneratedAt === undefined && generatedText
          if (generatedText) {
            lastGeneratedAt = performance.now()
            firstGeneratedAt ??= lastGeneratedAt
          }
          if (document.visibilityState === 'hidden') {
            flush()
          } else if (firstText) {
            flush()
            await yieldPastPaint()
          } else {
            frame ||= requestAnimationFrame(flush)
          }
          eventsSinceYield += 1
          if (eventsSinceYield >= 128) {
            eventsSinceYield = 0
            await yieldToBrowser()
          }
        }
        if (retriedContextLimit && inputBudget !== undefined) {
          learnedContextLimit = { route: contextRoute, key: apiKey, budget: inputBudget }
        }
        reply = complete()
        break
      } catch (error) {
        if (controller.signal.aborted) {
          reply = settleReply(reply, 'stopped', Date.now())
          break
        }
        if (preparing) {
          reply = settleReply(reply, 'error', Date.now(), {
            kind: 'upload',
            message: '',
            localMessage: error instanceof ApiError && error.localMessage ? error.localMessage : describeUploadError(error),
            retryable: isRetryableApiError(error),
          })
          break
        }
        const lengthError = submitted ? getContextLengthError(error) : null
        const messages = submitted?.messages ?? []
        const currentDocument = request.question.files.some((file) => !file.isImage && !file.contextExcluded)
        // 服务端展开文件后的实际长度未知；本轮文档超限时不自动再提交整份文件。
        if (automaticCompactionEnabled() && lengthError && submitted && !currentDocument && !receivedContent && !retriedContextLimit) {
          const budget = getRetryInputBudget(estimateRequestTokens(submitted), lengthError, generation.contextTokens)
          if (fitRequestHistory(submitted, budget, requiredSystem) !== submitted) {
            retriedContextLimit = true
            inputBudget = budget
            learnedContextLimit = { route: contextRoute, key: apiKey, budget }
            continue
          }
        }
        if (submitted && isTotalImageSizeError(error) && !receivedContent && !omitHistoryImages) {
          const currentIndex = messages.length - (messages.at(-1)?.role === 'assistant' ? 2 : 1)
          if (messages.slice(0, currentIndex).some((message) => Array.isArray(message.content) &&
            message.content.some((block) => block.type === 'image'))) {
            // Retry once for providers that count decoded or server-transformed images differently.
            omitHistoryImages = true
            continue
          }
        }
        const oversizedImage = submitted ? getImageSizeError(error) : null
        if (extras && oversizedImage && !receivedContent && attachmentRetries < FILE_RETRY_LIMIT) {
          const message = messages[oversizedImage.messageIndex]
          const block = message?.role === 'user' && Array.isArray(message.content)
            ? message.content[oversizedImage.blockIndex]
            : undefined
          if (block?.type === 'image' && block.source.type === 'file') {
            const fileId = block.source.file_id
            const local = [...request.history, request.question].flatMap((item) => item.role === 'user' ? item.files : [])
              .find((file) => file.serverId === fileId)
            // Only retry when the original is available; never drop the offending image from history.
            if (local && !repairedImageIds.has(local.id) && await db.loadFile(local.id) &&
              reuploadInvalidatedFiles(sessionId, request, error, new Set([block.source.file_id])) === true) {
              repairedImageIds.add(local.id)
              attachmentRetries += 1
              continue
            }
          }
        }
        const unsupportedImage = submitted ? getUnsupportedImageError(error) : null
        let sentImage = false
        if (unsupportedImage) {
          // 以实际发送的消息为准，提醒和续写前缀也可能占用索引。
          const currentQuestionIndex = messages.length - (messages[messages.length - 1]?.role === 'assistant' ? 2 : 1)
          const previousImages = new Set<string>()
          let currentImage = false
          for (const [index, message] of messages.entries()) {
            if (message.role !== 'user' || typeof message.content === 'string') {
              continue
            }
            for (const block of message.content) {
              if (block.type === 'image' && block.source.type === 'file') {
                if (index === currentQuestionIndex) {
                  currentImage = true
                } else {
                  previousImages.add(block.source.file_id)
                }
              }
            }
          }
          sentImage = currentImage || previousImages.size > 0
          if (extras && !receivedContent && previousImages.size > 0) {
            const location = unsupportedImage.location
            const message = location && messages[location.messageIndex]
            const block = message && message.role === 'user' && Array.isArray(message.content)
              ? message.content[location.blockIndex]
              : undefined
            const rejectedHistoricalImage = location && location.messageIndex < currentQuestionIndex &&
              block?.type === 'image' && block.source.type === 'file'
              ? block.source.file_id
              : undefined
            if (rejectedHistoricalImage && attachmentRetries < FILE_RETRY_LIMIT) {
              excludedHistoryImageIds.add(rejectedHistoricalImage)
              knownRejectedImageIds?.add(rejectedHistoricalImage)
              attachmentRetries += 1
              continue
            }
            // 无位置的拒绝不能证明是哪张历史图片坏了；只为本次纯文字提问省略它们一次。
            if (
              !currentImage && !retriedWithoutHistoryImages &&
              (!location || rejectedHistoricalImage)
            ) {
              if (rejectedHistoricalImage) {
                knownRejectedImageIds?.add(rejectedHistoricalImage)
              }
              previousImages.forEach((id) => excludedHistoryImageIds.add(id))
              retriedWithoutHistoryImages = true
              continue
            }
          }
        }
        // 附件失效：重新补传后重发。收到过内容块（含丢弃的客户端工具）后不自动重发。
        const reupload =
          extras &&
          attachmentRetries < FILE_RETRY_LIMIT &&
          !receivedContent &&
          reuploadInvalidatedFiles(sessionId, request, error)
        if (reupload === true) {
          await waitForRetry(attachmentRetries++, controller.signal)
          if (controller.signal.aborted) {
            reply = settleReply(reply, 'stopped', Date.now())
            break
          }
          continue
        }
        if (error instanceof ApiError && error.kind === 'interrupted' && reply.stopReason) {
          // 已收到 message_delta 的结束原因，只是缺了结尾的 message_stop
          reply = complete()
        } else if (error instanceof ApiError) {
          reply = settleReply(reply, 'error', Date.now(), {
            kind: error.kind,
            message: error.message,
            status: error.status,
            localMessage: reupload === 'confirmationRequired'
              ? { key: 'replyDocumentExpired' }
              : lengthError
              ? { key: currentDocument ? 'replyDocumentContextLimit' : automaticCompactionEnabled() ? 'replyContextLimit' : 'replyContextLimitAutoDisabled' }
              : oversizedImage
                ? { key: 'replyImageTooLarge' }
                : unsupportedImage
                  ? { key: sentImage ? 'replyUnsupportedImage' : 'replyImageErrorWithoutAttachment' }
                  : error.localMessage,
          })
        } else {
          reply = settleReply(reply, 'error', Date.now(), {
            kind: 'protocol',
            message: error instanceof Error ? error.message : String(error),
          })
        }
        break
      }
    }
  } finally {
    unsubscribeAutomaticCompaction()
    let sourceVerified = true
    if (!contextPrepared && sourceState && !sourceConflict) {
      try {
        // Cancellation stops new memory writes; it cannot permit a stale source save.
        sourceConflict = !(await db.commitMemoryUpdate(sourceState, { records: [], segments: [] }))
      } catch (error) {
        sourceVerified = false
        db.reportStorageError('verify interrupted memory source')(error)
        unsavedSessions.add(sessionId)
        set((state) => ({
          sessionSaveErrors: { ...state.sessionSaveErrors, [sessionId]: true },
        }))
      }
    }
    contextPreparations.delete(sessionId)
    set((state) => ({
      contextProgress: Object.fromEntries(
        Object.entries(state.contextProgress).filter(([id]) => id !== sessionId)
      ),
    }))
    titleRequests.delete(controller)
    streamFlushes.delete(sessionId)
    cancelAnimationFrame(frame)
    updateReply(sessionId, reply)
    if (sourceConflict) {
      // Reload competing source changes before another local send can persist the old cache.
      const cached = getSession(sessionId)
      try {
        const stored = await db.loadSession(sessionId)
        if (
          historyEpoch === sourceEpoch &&
          getSession(sessionId) === cached &&
          !deletingSessions.has(sessionId)
        ) {
          unsavedSessions.delete(sessionId)
          if (stored) {
            const current = normalizeSession(stored)
            set((state) => ({
              sessionCache: {
                ...state.sessionCache,
                [sessionId]: {
                  ...current,
                  messages: current.messages.map((message) =>
                    message.id === reply.id &&
                    message.role === 'assistant' &&
                    message.status === 'pending'
                      ? {
                          ...reply,
                          parentId: message.parentId,
                          selectedChildId: message.selectedChildId,
                        }
                      : message
                  ),
                },
              },
            }))
          } else {
            set((state) => ({
              sessionCache: Object.fromEntries(
                Object.entries(state.sessionCache).filter(([id]) => id !== sessionId)
              ),
              sessions: state.sessions.filter((session) => session.id !== sessionId),
              activeId: state.activeId === sessionId ? null : state.activeId,
            }))
          }
        }
      } catch (error) {
        db.reportStorageError('reload changed session')(error)
        set((state) => ({
          sessionCache: Object.fromEntries(
            Object.entries(state.sessionCache).filter(([id]) => id !== sessionId)
          ),
          sessionLoadErrors: { ...state.sessionLoadErrors, [sessionId]: true },
        }))
      }
    } else if (sourceVerified) {
      persist(sessionId)
    }
    set((state) => ({
      streaming: Object.fromEntries(
        Object.entries(state.streaming).filter(([id]) => id !== sessionId)
      ),
    }))
  }
}
