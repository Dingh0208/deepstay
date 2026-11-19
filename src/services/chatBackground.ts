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

/** 打开裁剪用的本地原图；成功后由弹窗释放 URL。 */
export const openChatBackground = async (file: File): Promise<HTMLImageElement> => {
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
      image.onload = () => {
        if (image.naturalWidth && image.naturalHeight) {
          resolve()
        } else {
          reject(new Error('format'))
        }
      }
      image.onerror = () => reject(new Error('format'))
      image.src = url
    })
    return image
  } catch (error) {
    URL.revokeObjectURL(url)
    throw error
  }
}

type CropRect = { x: number; y: number; width: number; height: number }
export type BackgroundCrop = { x: number; y: number; zoom: number }

export const getBackgroundCrop = (
  { naturalWidth, naturalHeight }: Pick<HTMLImageElement, 'naturalWidth' | 'naturalHeight'>,
  aspect: number,
  { x, y, zoom }: BackgroundCrop
): CropRect => {
  const width = Math.min(naturalWidth, naturalHeight * aspect) / zoom
  const height = width / aspect
  return { x: (naturalWidth - width) * x, y: (naturalHeight - height) * y, width, height }
}

/** 保存选区并限制输出尺寸，聊天页无需再次解码原图。 */
export const encodeChatBackground = async (image: HTMLImageElement, crop: CropRect): Promise<Blob> => {
  const ratio = Math.min(1, 2048 / Math.max(crop.width, crop.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(crop.width * ratio))
  canvas.height = Math.max(1, Math.round(crop.height * ratio))
  const context = canvas.getContext('2d')
  if (!context) {
    throw new Error('canvas')
  }
  context.fillStyle = '#fff'
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.drawImage(image, crop.x, crop.y, crop.width, crop.height, 0, 0, canvas.width, canvas.height)
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('canvas')), 'image/jpeg', 0.86)
  })
}
