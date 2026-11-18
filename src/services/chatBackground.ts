import { openDB } from 'idb'
import { create } from 'zustand'

const getDB = () => openDB('deepstay-appearance', 1, {
  upgrade(db) {
    db.createObjectStore('background')
  },
})

export const useChatBackground = create<{ url: string | null }>(() => ({ url: null }))
let loadTask: Promise<void> | null = null

const applyBackground = (blob: Blob | null) => {
  const previous = useChatBackground.getState().url
  useChatBackground.setState({ url: blob ? URL.createObjectURL(blob) : null })
  if (previous) {
    URL.revokeObjectURL(previous)
  }
}

/** 图片只保存在本机，与聊天归档分开，清空历史不会删除背景。 */
export const loadChatBackground = (): Promise<void> => {
  if (!loadTask) {
    loadTask = (async () => {
      const db = await getDB()
      try {
        const blob: Blob | undefined = await db.get('background', 'image')
        applyBackground(blob ?? null)
      } finally {
        db.close()
      }
    })().catch((error: unknown) => {
      loadTask = null
      throw error
    })
  }
  return loadTask
}

export const setChatBackground = async (blob: Blob | null): Promise<void> => {
  await loadChatBackground()
  const db = await getDB()
  try {
    if (blob) {
      await db.put('background', blob, 'image')
    } else {
      await db.delete('background', 'image')
    }
    applyBackground(blob)
  } finally {
    db.close()
  }
}

/** 限制本机图片的解码输入与保存尺寸，避免原始大照片反复占用聊天内存。 */
export const prepareChatBackground = async (file: File): Promise<Blob> => {
  if (!/^image\/(jpeg|png|webp|gif|bmp)$/i.test(file.type)) {
    throw new Error('format')
  }
  if (file.size > 20 * 1024 * 1024) {
    throw new Error('size')
  }
  const url = URL.createObjectURL(file)
  try {
    const image = new Image()
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve()
      image.onerror = () => reject(new Error('format'))
      image.src = url
    })
    const ratio = Math.min(1, 2048 / Math.max(image.naturalWidth, image.naturalHeight))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(image.naturalWidth * ratio))
    canvas.height = Math.max(1, Math.round(image.naturalHeight * ratio))
    const context = canvas.getContext('2d')
    if (!context) {
      throw new Error('canvas')
    }
    context.fillStyle = '#fff'
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('canvas')), 'image/jpeg', 0.86)
    })
  } finally {
    URL.revokeObjectURL(url)
  }
}
