import { parseMsDoc, MsDocWorkerClient } from '@file-viewer/doc'
import { Unzip, UnzipInflate, UnzipPassThrough } from 'fflate'
import { prepareImageUpload } from './imageUpload.js'

export type LocalAttachmentContent =
  | { type: 'image'; mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'; data: string }
  | { type: 'text'; text: string }

export type LocalAttachmentErrorKind = 'unsupported' | 'invalid' | 'tooLong' | 'empty'

export class LocalAttachmentError extends Error {
  readonly kind: LocalAttachmentErrorKind

  constructor(kind: LocalAttachmentErrorKind) {
    super(kind)
    this.kind = kind
  }
}

const MAX_TEXT_CHARS = 100_000
const MAX_DOCX_XML_BYTES = 8 * 1024 * 1024
const MAX_TEXT_FILE_BYTES = 4 * 1024 * 1024
const MAX_PDF_PAGES = 2_000
const MAX_INLINE_IMAGE_BYTES = 15 * 1024 * 1024
const TRUNCATED = '\n\n[文件内容已截断，请拆分文件后继续]'
const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'csv', 'tsv', 'json', 'json5', 'jsonl', 'xml', 'html', 'htm', 'log',
  'js', 'jsx', 'ts', 'tsx', 'css', 'scss', 'less', 'py', 'go', 'java', 'c', 'h',
  'cpp', 'cs', 'php', 'rb', 'rs', 'swift', 'kt', 'sql', 'yaml', 'yml', 'toml', 'ini',
  'conf', 'sh', 'bat', 'ps1', 'properties', 'gradle', 'tex', 'rst', 'adoc', 'org',
])

const extension = (name: string) => name.split('.').pop()?.toLowerCase() ?? ''

const boundedText = (parts: string[]) => {
  const text = parts.join('').trim()
  if (!text) {
    throw new LocalAttachmentError('empty')
  }
  return text.length > MAX_TEXT_CHARS ? text.slice(0, MAX_TEXT_CHARS) + TRUNCATED : text
}

const paragraphText = (blocks: ReturnType<typeof parseMsDoc>['blocks']): string[] =>
  blocks.flatMap((block) => {
    if (block.type === 'paragraph') {
      return block.text ? [block.text + '\n'] : []
    }
    if (block.type === 'table') {
      return block.rows.flatMap((row) => [
        row.cells.flatMap((cell) => paragraphText(cell.blocks ?? cell.paragraphs)).join('\t') + '\n',
      ])
    }
    return []
  })

const parseLegacyDoc = async (blob: Blob) => {
  const data = await blob.arrayBuffer()
  if (typeof Worker === 'undefined') {
    return parseMsDoc(data)
  }
  let worker: ReturnType<typeof MsDocWorkerClient.create>
  try {
    worker = MsDocWorkerClient.create(new URL('@file-viewer/doc/worker', import.meta.url))
  } catch {
    // Older WebViews expose Worker but reject module workers during construction.
    return parseMsDoc(data)
  }
  try {
    return await worker.parse(data)
  } finally {
    worker.destroy()
  }
}

const parseDocx = (data: Uint8Array) => new Promise<string>((resolve, reject) => {
  let found = false
  let settled = false
  const fail = (kind: LocalAttachmentErrorKind) => {
    if (!settled) {
      settled = true
      reject(new LocalAttachmentError(kind))
    }
  }
  const unzip = new Unzip((file) => {
    if (file.name !== 'word/document.xml') {
      return
    }
    found = true
    if ((file.originalSize ?? 0) > MAX_DOCX_XML_BYTES) {
      fail('tooLong')
      return
    }
    const chunks: Uint8Array[] = []
    let size = 0
    file.ondata = (error, chunk, final) => {
      if (error) {
        fail('invalid')
        return
      }
      size += chunk.length
      if (size > MAX_DOCX_XML_BYTES) {
        fail('tooLong')
        return
      }
      chunks.push(chunk)
      if (!final || settled) {
        return
      }
      const joined = new Uint8Array(size)
      let offset = 0
      for (const part of chunks) {
        joined.set(part, offset)
        offset += part.byteLength
      }
      const xml = new TextDecoder().decode(joined)
      const document = new DOMParser().parseFromString(xml, 'application/xml')
      if (document.getElementsByTagName('parsererror').length > 0) {
        fail('invalid')
        return
      }
      const text = Array.from(document.getElementsByTagNameNS('*', 'p'), (paragraph) =>
        Array.from(paragraph.getElementsByTagNameNS('*', 't'), (node) => node.textContent ?? '').join('')
      ).join('\n')
      try {
        settled = true
        resolve(boundedText([text]))
      } catch (parseError) {
        reject(parseError)
      }
    }
    try {
      file.start()
    } catch {
      fail('invalid')
    }
  })
  unzip.register(UnzipInflate)
  unzip.register(UnzipPassThrough)
  try {
    unzip.push(data, true)
    if (!found) {
      fail('invalid')
    }
  } catch {
    fail('invalid')
  }
})

const parsePdf = async (blob: Blob) => {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  if (typeof window !== 'undefined') {
    pdfjs.GlobalWorkerOptions.workerSrc = new URL(
      'pdfjs-dist/legacy/build/pdf.worker.min.mjs',
      import.meta.url
    ).toString()
  }
  const task = pdfjs.getDocument({ data: new Uint8Array(await blob.arrayBuffer()), isEvalSupported: false })
  try {
    const pdf = await task.promise
    const parts: string[] = []
    let length = 0
    const pageCount = Math.min(pdf.numPages, MAX_PDF_PAGES)
    for (let pageNumber = 1; pageNumber <= pageCount && length < MAX_TEXT_CHARS; pageNumber++) {
      const page = await pdf.getPage(pageNumber)
      const content = await page.getTextContent()
      const text = content.items.flatMap((item) => 'str' in item ? [item.str] : []).join(' ')
      parts.push(text, '\n')
      length += text.length
      page.cleanup()
    }
    let text: string
    try {
      text = boundedText(parts)
    } catch (error) {
      if (pdf.numPages > pageCount) {
        throw new LocalAttachmentError('tooLong')
      }
      throw error
    }
    return length > MAX_TEXT_CHARS || pdf.numPages > pageCount
      ? text.slice(0, MAX_TEXT_CHARS) + TRUNCATED
      : text
  } catch (error) {
    if (error instanceof LocalAttachmentError) {
      throw error
    }
    throw new LocalAttachmentError('invalid')
  } finally {
    await task.destroy()
  }
}

export const extractLocalAttachmentText = async (blob: Blob, name: string, mimeType: string): Promise<string> => {
  const ext = extension(name)
  try {
    if (ext === 'pdf' || mimeType === 'application/pdf') {
      return await parsePdf(blob)
    }
    if (ext === 'docx') {
      if (blob.size > 64 * 1024 * 1024) {
        throw new LocalAttachmentError('tooLong')
      }
      return await parseDocx(new Uint8Array(await blob.arrayBuffer()))
    }
    if (ext === 'doc') {
      if (blob.size > 64 * 1024 * 1024) {
        throw new LocalAttachmentError('tooLong')
      }
      const parsed = await parseLegacyDoc(blob)
      return boundedText(paragraphText(parsed.blocks))
    }
    if (!TEXT_EXTENSIONS.has(ext) && !mimeType.startsWith('text/') && mimeType !== 'application/json') {
      throw new LocalAttachmentError('unsupported')
    }
    const data = await blob.slice(0, MAX_TEXT_FILE_BYTES).arrayBuffer()
    let text: string
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(data)
    } catch {
      throw new LocalAttachmentError('invalid')
    }
    return boundedText([text, blob.size > MAX_TEXT_FILE_BYTES ? TRUNCATED : ''])
  } catch (error) {
    if (error instanceof LocalAttachmentError) {
      throw error
    }
    throw new LocalAttachmentError('invalid')
  }
}

const toBase64 = (bytes: Uint8Array) => {
  const parts: string[] = []
  for (let offset = 0; offset < bytes.length; offset += 32_768) {
    parts.push(String.fromCharCode(...bytes.subarray(offset, offset + 32_768)))
  }
  return btoa(parts.join(''))
}

export const encodeLocalImage = async (blob: Blob): Promise<LocalAttachmentContent> => {
  let prepared = await prepareImageUpload(blob)
  if (!['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(prepared.type)) {
    prepared = await prepareImageUpload(blob, true)
  }
  if (prepared.size > MAX_INLINE_IMAGE_BYTES) {
    throw new LocalAttachmentError('tooLong')
  }
  if (!['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(prepared.type)) {
    throw new LocalAttachmentError('invalid')
  }
  const mediaType = prepared.type as Extract<LocalAttachmentContent, { type: 'image' }>['mediaType']
  const bytes = new Uint8Array(await prepared.arrayBuffer())
  return { type: 'image', mediaType, data: toBase64(bytes) }
}
