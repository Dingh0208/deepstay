import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { registerHooks, stripTypeScriptTypes } from 'node:module'
import { fileURLToPath } from 'node:url'
import { strToU8, zipSync } from 'fflate'

const root = new URL('../src/', import.meta.url)
const docParserStub = `export const parseMsDoc = () => ({ blocks: [{ type: 'paragraph', text: 'Legacy Word fixture' }] }); export const MsDocWorkerClient = { create: () => { throw new TypeError('Module workers are unavailable') } }`
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@file-viewer/doc' && context.parentURL?.startsWith(root.href)) {
      return { url: `data:text/javascript,${encodeURIComponent(docParserStub)}`, shortCircuit: true }
    }
    if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL?.startsWith(root.href)) {
      const candidate = new URL(specifier.slice(0, -3) + '.ts', context.parentURL)
      if (existsSync(fileURLToPath(candidate))) return { url: candidate.href, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    return url.startsWith(root.href) && new URL(url).pathname.endsWith('.ts')
      ? { format: 'module', source: stripTypeScriptTypes(readFileSync(new URL(url), 'utf8'), { mode: 'transform' }), shortCircuit: true }
      : nextLoad(url, context)
  },
})
globalThis.__API_ORIGIN__ = 'https://api.deepseek.com'
globalThis.DOMParser = class {
  parseFromString(xml) {
    const decode = value => value.replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&apos;', "'")
    return {
      getElementsByTagName: name => name === 'parsererror' && !xml.trim().startsWith('<?xml') ? [{}] : [],
      getElementsByTagNameNS: (_namespace, name) => {
        if (name !== 'p') return []
        return [...xml.matchAll(/<(?:[\w.-]+:)?p\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?p>/g)].map(([, paragraph]) => ({
          getElementsByTagNameNS: (_innerNamespace, innerName) => innerName === 't'
            ? [...paragraph.matchAll(/<(?:[\w.-]+:)?t\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?t>/g)].map(([, text]) => ({ textContent: decode(text) }))
            : [],
        }))
      },
    }
  }
}

const { extractLocalAttachmentText, LocalAttachmentError } = await import(new URL('services/localAttachments.ts', root))
const checks = []

const docx = zipSync({
  'word/document.xml': strToU8('<?xml version="1.0"?><w:document><w:body><w:p><w:r><w:t>关系约定</w:t></w:r><w:r><w:t>每周日散步</w:t></w:r></w:p></w:body></w:document>'),
})
const extractedDocx = await extractLocalAttachmentText(new Blob([docx]), 'memory.docx', 'application/octet-stream')
assert.equal(extractedDocx, '关系约定每周日散步')
checks.push('DOCX extraction reads the document XML from a ZIP archive even when the file picker supplies a generic MIME type')

const makePdf = () => {
  const content = 'BT /F1 12 Tf 20 100 Td (DeepStay PDF fixture) Tj ET'
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
  ]
  let source = '%PDF-1.4\n'
  const offsets = [0]
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(source))
    source += `${index + 1} 0 obj\n${object}\nendobj\n`
  }
  const xrefOffset = Buffer.byteLength(source)
  source += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`
  return new Blob([source], { type: 'application/pdf' })
}
const extractedPdf = await extractLocalAttachmentText(makePdf(), 'memory.pdf', 'application/pdf')
assert.ok(extractedPdf.includes('DeepStay PDF fixture'))
checks.push('PDF text extraction reads a generated text PDF locally without contacting a model or Files API')

const legacyDoc = await extractLocalAttachmentText(new Blob(['fixture']), 'legacy.doc', 'application/msword')
assert.equal(legacyDoc, 'Legacy Word fixture')
checks.push('Legacy .doc parsing falls back to the parser when module Worker construction is unavailable in an older WebView')

const longText = 'remember '.repeat(15_000)
const extractedText = await extractLocalAttachmentText(new Blob([longText]), 'history.txt', 'text/plain')
assert.ok(extractedText.length < longText.length)
assert.ok(extractedText.includes('[文件内容已截断，请拆分文件后继续]'))
checks.push('Plain-text attachment extraction applies a visible bounded truncation marker')

const unsupported = await extractLocalAttachmentText(new Blob(['data']), 'archive.xlsx', 'application/octet-stream').then(
  () => null,
  error => error
)
assert.ok(unsupported instanceof LocalAttachmentError)
assert.equal(unsupported.kind, 'unsupported')

const invalidDocx = await extractLocalAttachmentText(new Blob(['not a ZIP']), 'bad.docx', 'application/octet-stream').then(
  () => null,
  error => error
)
assert.ok(invalidDocx instanceof LocalAttachmentError)
assert.equal(invalidDocx.kind, 'invalid')
checks.push('Unsupported and malformed local documents fail with typed, user-presentable reasons')

console.log(JSON.stringify({ passed: true, checks, scope: 'Synthetic local text and DOCX data plus a stubbed legacy parser; no network calls, model usage, or user attachments.' }, null, 2))
