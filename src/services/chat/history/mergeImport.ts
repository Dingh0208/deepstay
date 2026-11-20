import { createId } from '../../../utils/id.js'
import { normalizeSession } from '../branches.js'
import type { Message, Session } from '../types.js'

/** Ignore local-only IDs, upload state and metrics when recognizing imports made by older versions. */
const identity = (message: Message): string => JSON.stringify([
  message.role,
  message.createdAt,
  message.role === 'user'
    ? [message.content, message.files.map((file) => [file.name, file.size, file.isImage])]
    : message.blocks.filter((block) => block.type === 'text' || block.type === 'thinking')
      .map((block) => block.type === 'text' ? [block.type, block.text, !!block.isTemplate] : [block.type, block.thinking]),
])

export const matchImport = (source: Session, original: Session): Map<string, string> | undefined => {
  if (source.createdAt !== original.createdAt) {
    return
  }
  if (source.id === original.id && source.messages.length === 0) {
    return new Map()
  }
  if (original.importSource && original.id !== source.id) {
    return original.importSource.id === source.id
      ? new Map(Object.entries(original.importSource.messageIds))
      : undefined
  }
  const local = normalizeSession(original)
  const byContent = new Map<string, Message[]>()
  for (const message of local.messages) {
    const key = identity(message)
    const group = byContent.get(key)
    if (group) {
      group.push(message)
    } else {
      byContent.set(key, [message])
    }
  }
  const matched = new Map<string, string>()
  for (const message of normalizeSession(source).messages) {
    const parent = message.parentId ? matched.get(message.parentId) : null
    const candidates = byContent.get(identity(message))
    const found = candidates?.findIndex((item) => item.parentId === parent)
    if (candidates && found !== undefined && found >= 0) {
      matched.set(message.id, candidates.splice(found, 1)[0].id)
    }
  }
  // Legacy imports retained numeric archive message IDs. Native export/reimport can match its own ID.
  const expected = original.id === source.id ? Math.min(source.messages.length, local.messages.length)
    : local.messages.filter((item) => /^\d+$/.test(item.id)).length
  return expected > 0 && matched.size >= expected &&
    (original.id === source.id || source.messages.length === expected) ? matched : undefined
}

/** Preserve every existing node and selected branch. Only missing source nodes are appended. */
export const mergeImport = (source: Session, original?: Session, matched = new Map<string, string>()) => {
  const local = original ? normalizeSession(original) : undefined
  const incoming = normalizeSession(source)
  const incomingById = new Map(incoming.messages.map((message) => [message.id, message]))
  const messages = local?.messages.slice() ?? []
  const byId = new Map(messages.map((message, index) => [message.id, index]))
  const messageIds = new Map(matched)
  const sameSource = !local?.importSource || local.importSource.id === source.id
  const fileIds = new Map(Object.entries(sameSource ? local?.importSource?.fileIds ?? {} : {}))
  // Older imports remapped file IDs, but their message attachment order stayed intact.
  for (const message of incoming.messages) {
    const existing = byId.get(messageIds.get(message.id) ?? '')
    const previous = existing === undefined ? undefined : messages[existing]
    if (message.role === 'user' && previous?.role === 'user') {
      message.files.forEach((file, index) => {
        const saved = previous.files[index]
        if (saved && file.name === saved.name && file.size === saved.size) {
          fileIds.set(file.id, saved.id)
        }
      })
    }
  }
  let added = 0
  for (const message of incoming.messages) {
    if (messageIds.has(message.id)) {
      continue
    }
    const id = byId.has(message.id) ? createId() : message.id
    messageIds.set(message.id, id)
    let sourceParent = message.parentId
    let parentId = sourceParent ? messageIds.get(sourceParent) ?? null : null
    // Deletions stay deleted; reconnect a newly imported descendant to the nearest surviving node.
    while (parentId && !byId.has(parentId)) {
      sourceParent = incomingById.get(sourceParent ?? '')?.parentId
      parentId = sourceParent ? messageIds.get(sourceParent) ?? null : null
    }
    const parentIndex = parentId ? byId.get(parentId) : undefined
    const parent = parentIndex === undefined ? undefined : messages[parentIndex]
    if (parent && parentIndex !== undefined && !parent.selectedChildId) {
      messages[parentIndex] = { ...parent, selectedChildId: id }
    }
    const mapped: Message = {
      ...message,
      id,
      parentId,
      selectedChildId: undefined,
      ...(message.role === 'assistant' && parent?.role !== 'user' ? { questionDeleted: true as const } : {}),
      ...(message.role === 'user' ? { files: message.files.map((file) => {
        const mappedId = fileIds.get(file.id) ?? createId()
        fileIds.set(file.id, mappedId)
        return { ...file, id: mappedId }
      }) } : {}),
    }
    byId.set(id, messages.push(mapped) - 1)
    added++
  }
  // New imports honor the archive's selected branch; an existing chat keeps its local choice.
  if (!local) {
    for (const message of incoming.messages) {
      const index = byId.get(messageIds.get(message.id) ?? '')
      if (index !== undefined) {
        messages[index].selectedChildId = message.selectedChildId ? messageIds.get(message.selectedChildId) : undefined
      }
    }
  }
  const session: Session = {
    ...(local ?? source),
    id: local?.id ?? createId(),
    messages,
    rootMessageId: local
      ? local.rootMessageId ?? messages.find((message) => message.parentId === null)?.id ?? null
      : incoming.rootMessageId ? messageIds.get(incoming.rootMessageId) : null,
    linearMessagePath: undefined,
    updatedAt: added ? Math.max(local?.updatedAt ?? 0, source.updatedAt) : local?.updatedAt ?? source.updatedAt,
    importSource: !sameSource ? local?.importSource : { id: source.id, createdAt: source.createdAt,
      messageIds: Object.fromEntries(messageIds), fileIds: Object.fromEntries(fileIds) },
  }
  return { session, added, fileIds }
}
