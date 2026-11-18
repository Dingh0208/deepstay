import { Capacitor, registerPlugin } from '@capacitor/core'
import { diagnosticText } from './log.js'

const localFiles = registerPlugin<{
  save(options: { name: string; data: string; mimeType: string }): Promise<{ cancelled: boolean }>
  shareDiagnostics(options: { text: string }): Promise<void>
}>('LocalFiles')
const filename = 'deepstay-diagnostics.json'
const mimeType = 'application/json'

export const supportsDiagnosticShare = () =>
  Capacitor.getPlatform() === 'android' || typeof navigator.share === 'function'

export const downloadDiagnostics = async () => {
  const text = diagnosticText()
  if (Capacitor.getPlatform() === 'android') {
    // Diagnostic entries contain only ASCII timestamps, operation codes and status values.
    await localFiles.save({ name: filename, data: btoa(text), mimeType })
    return
  }
  const url = URL.createObjectURL(new Blob([text], { type: mimeType }))
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

export const shareDiagnostics = async () => {
  const text = diagnosticText()
  if (Capacitor.getPlatform() === 'android') {
    await localFiles.shareDiagnostics({ text })
    return
  }
  const file = new File([text], filename, { type: mimeType })
  await navigator.share(navigator.canShare?.({ files: [file] }) ? { files: [file] } : { text })
}
