import { create } from 'zustand'
import type { TranslationMessage } from '../../i18n/index.js'
import type { FilePurpose } from '../api/types.js'
import { createId } from '../../utils/id.js'
import {
  cancelUpload,
  getUploadPurpose,
  isImage,
  resolveMimeType,
  uploadAttachment,
  validateFiles,
  type UploadTask,
} from '../attachments.js'
import type { FileAttachment } from './types.js'

export type DraftAttachment = {
  /** 本地标识，也是 IndexedDB 原件与上传任务的 key */
  id: string
  file: File
  isImage: boolean
  previewUrl: string | null
  uploadPurpose?: FilePurpose
}

type Draft = { text: string; attachments: DraftAttachment[] }

export const EMPTY_DRAFT: Draft = { text: '', attachments: [] }

const TEXT_DRAFT_KEY = 'deepstay:chat-drafts'
const TEXT_DRAFT_LIMIT = 30
const TEXT_DRAFT_CHAR_LIMIT = 500_000

const restoreTextDrafts = (): Map<string | null, Draft> => {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(TEXT_DRAFT_KEY) ?? '[]')
    if (Array.isArray(raw)) {
      const entries: [string | null, Draft][] = []
      let characters = 0
      for (const item of raw.slice(0, TEXT_DRAFT_LIMIT)) {
        if (!Array.isArray(item) || item.length !== 2 ||
            (item[0] !== null && (typeof item[0] !== 'string' || !item[0])) ||
            typeof item[1] !== 'string' || !item[1] ||
            characters + item[1].length > TEXT_DRAFT_CHAR_LIMIT) {
          continue
        }
        characters += item[1].length
        entries.push([item[0], { text: item[1], attachments: [] }])
      }
      return new Map(entries.reverse())
    }
  } catch {
    // Storage is optional; an unreadable draft never blocks the composer.
  }
  return new Map()
}

/** 最近的文字草稿可重启恢复；附件只留内存。null 是新对话的草稿。 */
export const useDrafts = create<{ drafts: Map<string | null, Draft> }>(() => ({
  drafts: restoreTextDrafts(),
}))

let writeTimer: ReturnType<typeof setTimeout> | undefined
const flushTextDrafts = () => {
  clearTimeout(writeTimer)
  writeTimer = undefined
  const entries: [string | null, string][] = []
  let characters = 0
  for (const [id, draft] of [...useDrafts.getState().drafts].reverse()) {
    if (!draft.text || characters + draft.text.length > TEXT_DRAFT_CHAR_LIMIT) {
      continue
    }
    entries.push([id, draft.text])
    characters += draft.text.length
    if (entries.length === TEXT_DRAFT_LIMIT) {
      break
    }
  }
  try {
    if (entries.length) {
      localStorage.setItem(TEXT_DRAFT_KEY, JSON.stringify(entries))
    } else {
      localStorage.removeItem(TEXT_DRAFT_KEY)
    }
  } catch {
    // Keep the full in-memory draft when storage is unavailable or full.
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', flushTextDrafts)
}
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      flushTextDrafts()
    }
  })
}

export const getDraft = (sessionId: string | null): Draft =>
  useDrafts.getState().drafts.get(sessionId) ?? EMPTY_DRAFT

const updateDraft = (sessionId: string | null, update: (draft: Draft) => Draft) => {
  useDrafts.setState((state) => {
    const draft = update(state.drafts.get(sessionId) ?? EMPTY_DRAFT)
    const drafts = new Map(state.drafts)
    drafts.delete(sessionId)
    if (draft.text || draft.attachments.length > 0) {
      drafts.set(sessionId, draft)
    }
    return { drafts }
  })
  clearTimeout(writeTimer)
  writeTimer = setTimeout(flushTextDrafts, 400)
}

export const setDraftText = (sessionId: string | null, text: string) => {
  updateDraft(sessionId, (draft) => ({ ...draft, text }))
}

const upload = (attachment: DraftAttachment, apiKey: string) => {
  // 上传任务负责记录错误，输入框的附件卡片展示失败及重试入口。
  void uploadAttachment(
    apiKey,
    attachment.id,
    attachment.file,
    attachment.file.name,
    attachment.isImage,
    undefined,
    attachment.uploadPurpose
  ).catch(() => {})
}

/** 整批校验通过后才创建预览和开始上传。 */
export const addDraftFiles = (
  sessionId: string | null,
  files: File[],
  apiKey: string,
  documentPurpose: FilePurpose = 'text_recognition'
): TranslationMessage | null => {
  if (files.length === 0) {
    return null
  }
  const error = validateFiles(files, getDraft(sessionId).attachments.length)
  if (error) {
    return error
  }
  const added = files.map((file): DraftAttachment => {
    const image = isImage(resolveMimeType(file))
    return {
      id: createId(),
      file,
      isImage: image,
      previewUrl: image ? URL.createObjectURL(file) : null,
      uploadPurpose: getUploadPurpose(file.name, image, documentPurpose) ?? undefined,
    }
  })
  updateDraft(sessionId, (draft) => ({ ...draft, attachments: [...draft.attachments, ...added] }))
  added.forEach((attachment) => upload(attachment, apiKey))
  return null
}

export const retryDraftAttachment = (
  sessionId: string | null,
  attachmentId: string,
  apiKey: string
) => {
  const attachment = getDraft(sessionId).attachments.find((item) => item.id === attachmentId)
  if (attachment) {
    upload(attachment, apiKey)
  }
}

/** 发送按钮和实际提交共用规则：有内容，且全部附件已上传成功。 */
export const prepareDraftMessage = (draft: Draft, tasks: Record<string, UploadTask>) => {
  const text = draft.text.trim()
  if (!text && draft.attachments.length === 0) {
    return null
  }
  const files: (FileAttachment & { serverId: string; blob: Blob })[] = []
  for (const attachment of draft.attachments) {
    const task = tasks[attachment.id]
    if (task?.status !== 'done' || !task.serverId) {
      return null
    }
    files.push({
      id: attachment.id,
      serverId: task.serverId,
      name: attachment.file.name,
      size: attachment.file.size,
      isImage: attachment.isImage,
      mimeType: resolveMimeType(attachment.file),
      uploadPurpose: attachment.uploadPurpose,
      blob: attachment.file,
    })
  }
  return { text, files }
}

const releaseAttachment = (attachment: DraftAttachment, cancel: boolean) => {
  if (cancel) {
    cancelUpload(attachment.id)
  }
  if (attachment.previewUrl) {
    URL.revokeObjectURL(attachment.previewUrl)
  }
}

export const removeDraftAttachment = (sessionId: string | null, attachmentId: string) => {
  const attachment = getDraft(sessionId).attachments.find((item) => item.id === attachmentId)
  if (!attachment) {
    return
  }
  releaseAttachment(attachment, true)
  updateDraft(sessionId, (draft) => ({
    ...draft,
    attachments: draft.attachments.filter((item) => item.id !== attachmentId),
  }))
}

/** 发送成功后原件与 serverId 已交给会话，释放预览但保留上传完成态。 */
export const clearSentDraft = (sessionId: string | null) => {
  getDraft(sessionId).attachments.forEach((attachment) => releaseAttachment(attachment, false))
  updateDraft(sessionId, () => EMPTY_DRAFT)
  flushTextDrafts()
}

/** 删除会话或替换历史成功后，释放尚未发送的草稿及上传任务。 */
export const clearDraft = (sessionId: string | null) => {
  getDraft(sessionId).attachments.forEach((attachment) => releaseAttachment(attachment, true))
  updateDraft(sessionId, () => EMPTY_DRAFT)
  flushTextDrafts()
}

export const clearAllDrafts = () => {
  for (const draft of useDrafts.getState().drafts.values()) {
    draft.attachments.forEach((attachment) => releaseAttachment(attachment, true))
  }
  useDrafts.setState({ drafts: new Map() })
  flushTextDrafts()
}
