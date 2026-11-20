import type { AssistantMessage, Message, Session } from './types.js'

const hasLinearMessagePath = (session: Session) => {
  const messages = session.messages
  if (messages.length === 0) {
    return session.rootMessageId === null
  }
  if (session.rootMessageId !== messages[0].id) {
    return false
  }
  for (let index = 0; index < messages.length; index++) {
    if (
      messages[index].parentId !== messages[index - 1]?.id &&
      !(index === 0 && messages[index].parentId === null)
    ) {
      return false
    }
    if (messages[index].selectedChildId !== messages[index + 1]?.id) {
      return false
    }
  }
  return true
}

/** 将线性消息列表规范化为单分支，保留消息 ID、内容及时间。 */
export const normalizeSession = (session: Session): Session =>
  session.rootMessageId !== undefined
    ? session.linearMessagePath !== undefined
      ? session
      : { ...session, linearMessagePath: hasLinearMessagePath(session) }
    : {
        ...session,
        rootMessageId: session.messages[0]?.id ?? null,
        linearMessagePath: true,
        messages: session.messages.map((message, index, messages) => ({
          ...message,
          parentId: messages[index - 1]?.id ?? null,
          selectedChildId: messages[index + 1]?.id,
        })),
      }

/** 展示内容与请求上下文共用当前选中的分支路径。 */
export const getVisibleMessages = (session: Session): Message[] => {
  if (session.rootMessageId === undefined) {
    return session.messages
  }
  if (session.linearMessagePath) {
    return session.messages
  }
  const byId = new Map<string, Message>()
  for (const message of session.messages) {
    byId.set(message.id, message)
  }
  const path: Message[] = []
  let id = session.rootMessageId
  while (id) {
    const message = byId.get(id)
    if (!message) {
      break
    }
    path.push(message)
    byId.delete(id)
    id = message.selectedChildId ?? null
  }
  return path
}

export type MessageVersions = { ids: string[]; index: number }

/** 只为已显示的消息收集兄弟版本；版本未变时复用旧对象，避免正文更新重绘历史消息。 */
export const buildMessageVersions = (
  session: Session,
  previous: ReadonlyMap<string, MessageVersions>,
  shown: Message[]
): ReadonlyMap<string, MessageVersions> => {
  const linear = session.linearMessagePath === true || session.rootMessageId === undefined
  const groups = new Map<string | null | undefined, string[]>()
  if (!linear && session.rootMessageId !== undefined) {
    for (const message of shown) {
      groups.set(message.parentId, [])
    }
    for (const message of session.messages) {
      groups.get(message.parentId)?.push(message.id)
    }
  }

  const versions = new Map<string, MessageVersions>()
  let unchanged = previous.size === shown.length
  for (const message of shown) {
    const ids = linear ? [message.id] : groups.get(message.parentId) ?? [message.id]
    const cached = previous.get(message.id)
    const cachedIds = cached?.ids
    const stableIds =
      cachedIds?.length === ids.length && ids.every((id, index) => id === cachedIds[index])
        ? cachedIds
        : ids
    const index = stableIds.indexOf(message.id)
    const version =
      cached?.ids === stableIds && cached.index === index ? cached : { ids: stableIds, index }
    versions.set(message.id, version)
    if (version !== cached) {
      unchanged = false
    }
  }
  return unchanged ? previous : versions
}

/** 新消息挂在指定父节点下，并选择新分支；原节点与其后续对话保持不变。 */
export const appendBranch = (
  original: Session,
  parentId: string | null,
  messages: Message[]
): Session => {
  const session = normalizeSession(original)
  const first = messages[0]
  if (!first) {
    return session
  }
  const linear = session.linearMessagePath &&
    (parentId === null
      ? session.messages.length === 0
      : session.messages[session.messages.length - 1]?.id === parentId)
  if (linear) {
    const nextMessages = session.messages.slice()
    if (parentId !== null) {
      const lastIndex = nextMessages.length - 1
      nextMessages[lastIndex] = { ...nextMessages[lastIndex], selectedChildId: first.id }
    }
    for (let index = 0; index < messages.length; index++) {
      nextMessages.push({
        ...messages[index],
        parentId: messages[index - 1]?.id ?? parentId,
        selectedChildId: messages[index + 1]?.id,
      })
    }
    return {
      ...session,
      rootMessageId: parentId === null ? first.id : session.rootMessageId,
      linearMessagePath: true,
      messages: nextMessages,
    }
  }
  return {
    ...session,
    linearMessagePath: false,
    rootMessageId: parentId === null ? first.id : session.rootMessageId,
    messages: [
      ...session.messages.map((message) =>
        message.id === parentId ? { ...message, selectedChildId: first.id } : message
      ),
      ...messages.map((message, index) => ({
        ...message,
        parentId: messages[index - 1]?.id ?? parentId,
        selectedChildId: messages[index + 1]?.id,
      })),
    ],
  }
}

/** 仅允许切换当前路径上某一节点的兄弟版本，恢复该版本已选中的后续分支。 */
export const selectVersion = (original: Session, messageId: string): Session => {
  const session = normalizeSession(original)
  const message = session.messages.find((item) => item.id === messageId)
  if (!message || !getVisibleMessages(session).some((item) => item.parentId === message.parentId)) {
    return original
  }
  const selected = message.parentId === null
    ? session.rootMessageId === message.id
    : session.messages.find((item) => item.id === message.parentId)?.selectedChildId === message.id
  if (selected) {
    return original
  }
  return {
    ...session,
    linearMessagePath: false,
    rootMessageId: message.parentId === null ? message.id : session.rootMessageId,
    messages: session.messages.map((item) =>
      item.id === message.parentId ? { ...item, selectedChildId: message.id } : item
    ),
  }
}

/** 删除指定节点，将保留的分支接到最近的保留祖先。 */
export const removeBranchMessages = (original: Session, ids: ReadonlySet<string>): Session => {
  if (!original.messages.some((message) => ids.has(message.id))) {
    return original
  }
  const session = normalizeSession(original)
  const deleted = new Map(session.messages.filter((message) => ids.has(message.id)).map((message) => [message.id, message]))
  const resolveEdge = (edge: 'parentId' | 'selectedChildId') => {
    const resolved = new Map<string, string | null>()
    return (id: string | null | undefined): string | null => {
      const crossed: string[] = []
      let next = id ?? null
      while (next && deleted.has(next)) {
        if (resolved.has(next)) {
          next = resolved.get(next) ?? null
          break
        }
        crossed.push(next)
        next = deleted.get(next)?.[edge] ?? null
      }
      for (const id of crossed) {
        resolved.set(id, next)
      }
      return next
    }
  }
  const parent = resolveEdge('parentId')
  const selected = resolveEdge('selectedChildId')
  const children = new Map<string | null, string>()
  const kept = session.messages.filter((message) => !ids.has(message.id))
  for (const message of kept) {
    const parentId = parent(message.parentId)
    if (!children.has(parentId)) {
      children.set(parentId, message.id)
    }
  }
  const next: Session = {
    ...session,
    rootMessageId: selected(session.rootMessageId) ?? children.get(null) ?? null,
    messages: kept.map((message) => {
      const parentId = parent(message.parentId)
      const childId = selected(message.selectedChildId) ??
        (message.selectedChildId ? children.get(message.id) : undefined)
      return parentId === message.parentId && childId === message.selectedChildId
        ? message
        : {
            ...message,
            parentId,
            selectedChildId: childId,
            ...(message.role === 'assistant' && parentId !== message.parentId && { questionDeleted: true }),
          }
    }),
  }
  return { ...next, linearMessagePath: hasLinearMessagePath(next) }
}

/** Update a streamed reply without invoking a JavaScript callback for every history item. */
export const replaceSessionReply = (session: Session, reply: AssistantMessage): Session => {
  const lastIndex = session.messages.length - 1
  const last = session.messages[lastIndex]
  if (last?.id === reply.id) {
    const messages = session.messages.slice()
    messages[lastIndex] = { ...reply, parentId: last.parentId, selectedChildId: last.selectedChildId }
    return { ...session, messages }
  }
  return {
    ...session,
    messages: session.messages.map((message) =>
      message.id === reply.id
        ? { ...reply, parentId: message.parentId, selectedChildId: message.selectedChildId }
        : message
    ),
  }
}
