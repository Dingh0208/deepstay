import { Zip, ZipPassThrough } from 'fflate'

// ZIP32 字段中的哨兵值表示需要 ZIP64；当前格式不支持 ZIP64。
const ZIP64_SIZE = 0xffffffff
const ZIP64_COUNT = 0xffff

export class ArchiveLimitError extends Error {
  constructor() {
    super('History archive requires unsupported ZIP64 fields')
    this.name = 'ArchiveLimitError'
  }
}

const invalid = (): never => {
  throw new Error('Invalid history archive entry')
}

/** 与读取端保持相同路径规则，成品必须能再次导入。 */
const entryName = (name: string) => {
  const normalized = name.normalize('NFC')
  if (
    !normalized ||
    normalized.includes('\\') ||
    normalized.includes('\0') ||
    /^[A-Za-z]:/.test(normalized) ||
    normalized.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    invalid()
  }
  const bytes = new TextEncoder().encode(normalized)
  if (bytes.length > 0xffff) {
    throw new ArchiveLimitError()
  }
  // 拒绝孤立代理项，避免编码时替换成 U+FFFD 后改变附件的关联路径。
  if (new TextDecoder().decode(bytes) !== normalized) {
    invalid()
  }
  return { name: normalized, byteLength: bytes.length }
}

/** STORE 流式写入；成品必须能再次导入。 */
export const writeArchive = async (
  entries: Iterable<{ name: string; blob: Blob }> | AsyncIterable<{ name: string; blob: Blob }>,
  writeChunk?: (chunk: Uint8Array) => Promise<void>
): Promise<Blob> => {
  const names = new Set<string>()
  let expectedSize = 22
  let directorySize = 0
  const chunks: Blob[] = []
  let pending: Uint8Array[] = []
  let size = 0
  let completed = false
  const zip = new Zip((error, chunk, final) => {
    if (error) {
      throw error
    }
    size += chunk.byteLength
    pending.push(chunk)
    completed = final
  })
  const flush = async () => {
    for (const chunk of pending) {
      if (writeChunk) {
        await writeChunk(chunk)
      } else {
        chunks.push(new Blob([new Uint8Array(chunk)]))
      }
    }
    pending = []
  }
  try {
    for await (const { name, blob } of entries) {
      const normalized = entryName(name)
      if (names.has(normalized.name)) {
        invalid()
      }
      names.add(normalized.name)
      directorySize += 46 + normalized.byteLength
      expectedSize += blob.size + 92 + 2 * normalized.byteLength
      if (
        names.size >= ZIP64_COUNT ||
        blob.size >= ZIP64_SIZE ||
        directorySize >= ZIP64_SIZE ||
        expectedSize >= ZIP64_SIZE
      ) {
        throw new ArchiveLimitError()
      }
      const entry = new ZipPassThrough(normalized.name)
      entry.mtime = new Date(1980, 0, 1)
      zip.add(entry)
      const reader = blob.stream().getReader()
      let written = 0
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) {
            break
          }
          written += value.byteLength
          if (written > blob.size) {
            invalid()
          }
          entry.push(value)
          await flush()
        }
        if (written !== blob.size) {
          invalid()
        }
        entry.push(new Uint8Array(), true)
        await flush()
      } finally {
        await reader.cancel().catch(() => {})
        reader.releaseLock()
      }
    }
    zip.end()
    await flush()
    if (!completed || size !== expectedSize) {
      invalid()
    }
    return new Blob(chunks, { type: 'application/zip' })
  } finally {
    zip.terminate()
  }
}
