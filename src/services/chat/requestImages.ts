import { ApiError } from '../api/http.js'
import { estimateImageRequestBytes } from '../imageUpload.js'
import type { FileAttachment, Message, UserMessage } from './types.js'

// Leave room below the provider's 200 MB request limit, including decoded pixels.
export const REQUEST_IMAGE_BUDGET = 160_000_000

/** Limit only the request snapshot; local originals and message history stay intact. */
export const limitRequestImages = async (
  history: Message[],
  question: UserMessage,
  loadFile: (id: string) => Promise<Blob | undefined>,
  omitHistoryImages = false
): Promise<{ history: Message[]; question: UserMessage }> => {
  let remaining = REQUEST_IMAGE_BUDGET
  const owners = new Map<string, string>()
  const seen = new Set<string>()
  const key = (file: FileAttachment) => file.serverId || file.id
  const users = [
    ...history.filter((message): message is UserMessage => message.role === 'user'),
    question,
  ]
  for (const user of users.slice().reverse()) {
    for (const file of user.files) {
      if (!file.isImage || seen.has(key(file))) {
        continue
      }
      seen.add(key(file))
      if (omitHistoryImages && user.id !== question.id) {
        continue
      }
      const blob = remaining > 0 ? await loadFile(file.id) : undefined
      const bytes = blob
        ? await estimateImageRequestBytes(blob)
        : Math.max(0, file.size)
      if (bytes > remaining) {
        if (user.id === question.id) {
          throw new ApiError('protocol', { key: 'replyCurrentImagesTooLarge' })
        }
        continue
      }
      remaining -= bytes
      owners.set(key(file), user.id)
    }
  }
  const trim = (user: UserMessage): UserMessage => {
    const files = user.files.filter((file) => !file.isImage || owners.get(key(file)) === user.id)
    return files.length === user.files.length
      ? user
      : {
          ...user,
          files,
          content: user.content || (user.files.some((file) => file.isImage && !owners.has(key(file)))
            ? '[历史图片未在本轮重复发送，原图仍保存在聊天记录中。]' : ''),
        }
  }
  return {
    history: history.map((message) => (message.role === 'user' ? trim(message) : message)),
    question: trim(question),
  }
}
