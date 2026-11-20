/** Bound the outbound copy for the Messages API and older WebViews. */
export const MAX_IMAGE_SIDE = 4096

const imageSize = (data: ArrayBuffer): { width: number; height: number } | undefined => {
  const view = new DataView(data)
  const bytes = new Uint8Array(data)
  if (bytes.length < 24) {
    return
  }
  if (view.getUint32(0) === 0x89504e47 && view.getUint32(4) === 0x0d0a1a0a) {
    return { width: view.getUint32(16), height: view.getUint32(20) }
  }
  if (String.fromCharCode(...bytes.subarray(0, 3)) === 'GIF') {
    return { width: view.getUint16(6, true), height: view.getUint16(8, true) }
  }
  if (bytes.length >= 30 && view.getUint32(0) === 0x52494646 && view.getUint32(8) === 0x57454250) {
    const format = view.getUint32(12)
    if (format === 0x56503858) {
      return { width: 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16), height: 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16) }
    }
    if (format === 0x56503820) {
      return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff }
    }
    if (format === 0x5650384c) {
      return { width: 1 + bytes[21] + ((bytes[22] & 0x3f) << 8), height: 1 + (bytes[22] >> 6) + (bytes[23] << 2) + ((bytes[24] & 0xf) << 10) }
    }
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2
    while (offset + 8 < bytes.length && bytes[offset] === 0xff) {
      const marker = bytes[offset + 1]
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        return { width: view.getUint16(offset + 7), height: view.getUint16(offset + 5) }
      }
      const length = view.getUint16(offset + 2)
      if (length < 2) {
        break
      }
      offset += length + 2
    }
  }
  return undefined
}

/** Resize only the outbound copy. The original file remains in local history and exports. */
export const prepareImageUpload = async (blob: Blob): Promise<Blob> => {
  // Invalid tiny uploads cannot contain an oversized raster; let the existing upload error handle them.
  if (blob.size < 24) {
    return blob
  }
  const size = imageSize(await blob.slice(0, 128 * 1024).arrayBuffer())
  if (size && size.width > 0 && size.height > 0 && Math.max(size.width, size.height) <= MAX_IMAGE_SIDE) {
    return blob
  }
  const encode = async (image: CanvasImageSource, width: number, height: number) => {
    const ratio = Math.min(1, MAX_IMAGE_SIDE / Math.max(width, height))
    // A memory-constrained decoder can report fewer pixels than the encoded file contains.
    // Only the verified header above may return the original; decoded fallbacks always re-encode.
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.floor(width * ratio))
    canvas.height = Math.max(1, Math.floor(height * ratio))
    try {
      const context = canvas.getContext('2d')
      if (!context) {
        throw new Error('Image conversion unavailable')
      }
      context.drawImage(image, 0, 0, canvas.width, canvas.height)
      return await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((result) => result ? resolve(result) : reject(new Error('Image conversion failed')), 'image/png')
      })
    } finally {
      canvas.width = canvas.height = 1
    }
  }
  if (typeof createImageBitmap === 'function') {
    let bitmap: ImageBitmap | undefined
    // Ask the decoder for bounded pixels before allocating a canvas for oversized originals.
    const target = size && Math.max(size.width, size.height) > MAX_IMAGE_SIDE
      ? Math.max(1, Math.floor(MAX_IMAGE_SIDE * Math.min(size.width, size.height) / Math.max(size.width, size.height)))
      : undefined
    try {
      bitmap = await createImageBitmap(blob, target === undefined || !size ? {} : {
        resizeWidth: size.width >= size.height ? MAX_IMAGE_SIDE : target,
        resizeHeight: size.width >= size.height ? target : MAX_IMAGE_SIDE,
        resizeQuality: 'high',
      })
    } catch {
      // Older WebViews may expose ImageBitmap but reject resize options or a supported image format.
    }
    if (bitmap) {
      try {
        return await encode(bitmap, bitmap.width, bitmap.height)
      } finally {
        bitmap.close()
      }
    }
  }
  const url = URL.createObjectURL(blob)
  try {
    const image = new Image()
    await new Promise<void>((resolve, reject) => {
      image.onload = () => image.naturalWidth && image.naturalHeight ? resolve() : reject(new Error('Invalid image'))
      image.onerror = () => reject(new Error('Invalid image'))
      image.src = url
    })
    return await encode(image, image.naturalWidth, image.naturalHeight)
  } finally {
    URL.revokeObjectURL(url)
  }
}
