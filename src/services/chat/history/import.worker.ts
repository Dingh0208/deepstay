import { checkArchiveFormat, importArchive } from './importArchive.js'
import { clearStaging } from '../db.js'
import { BackupError } from './errors.js'

const worker = globalThis as unknown as {
  onmessage: (event: MessageEvent<{ file: File }>) => void
  postMessage: (message: unknown) => void
}
worker.onmessage = ({ data: { file } }) => {
  void (async () => {
    try {
      await checkArchiveFormat(file)
      await clearStaging()
      let lastReport = 0
      let count = 0
      await importArchive(file, (bytes, sessions) => {
        count = sessions
        if (Date.now() - lastReport >= 100 || bytes === file.size) {
          lastReport = Date.now()
          worker.postMessage({ type: 'progress', bytes, total: file.size, sessions })
        }
      })
      worker.postMessage({ type: 'ready', sessions: count })
    } catch (error) {
      await clearStaging().catch(() => {})
      worker.postMessage({ type: 'error', key: error instanceof BackupError ? error.key : 'historyImportFailed' })
    }
  })()
}
