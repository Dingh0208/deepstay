import { formatDate } from '../../utils/format.js'
import { hasOwn } from '../../utils/object.js'
import * as db from './db.js'
import { appendStagedHistory, replaceHistory, useChatStore } from './store.js'
import type { Session } from './types.js'

export { BackupError } from './history/errors.js'

// 导入、导出与全部删除串行处理，避免读取归档时数据被清空或两个导入事务交错。
let backupQueue: Promise<unknown> = Promise.resolve()

const enqueueBackup = <T>(run: () => Promise<T>): Promise<T> => {
  const task = backupQueue.then(run)
  backupQueue = task.catch(() => {})
  return task
}

const backupFileName = (date: Date) => `deepseek_data-${formatDate(date)}.zip`

/** 导出为历史会话导出格式的 ZIP，可再次导入。 */
export const exportHistory = (): Promise<{ name: string; blob: Blob }> =>
  enqueueBackup(async () => {
    // 列表和已加载内容保留导出开始时的快照；未打开的会话逐条读取，不填满详情缓存。
    const { sessions, sessionCache } = useChatStore.getState()
    async function* readSessions(): AsyncGenerator<Session> {
      for (const summary of sessions) {
        const session = hasOwn(sessionCache, summary.id)
          ? sessionCache[summary.id]
          : await db.loadSession(summary.id)
        if (!session) {
          throw new Error(`History session disappeared during export: ${summary.id}`)
        }
        // 详情读取期间可能重命名，归档标题与开始时的列表保持一致。
        yield { ...session, ...summary }
      }
    }
    const { exportArchive } = await import('./history/exportArchive.js')
    const now = new Date()
    const blob = await exportArchive(readSessions())
    return { name: backupFileName(now), blob }
  })

/** 先流式校验和暂存，再原子新增会话与图片；失败保留原有记录。 */
export const importHistory = (file: File, onProgress?: (percent: number) => void): Promise<number> =>
  enqueueBackup(async () => {
    let progress = -1
    const report = (percent: number) => {
      if (percent > progress) {
        progress = percent
        onProgress?.(percent)
      }
    }
    report(0)
    const { checkArchiveFormat, importArchive } = await import('./history/importArchive.js')
    await checkArchiveFormat(file)
    try {
      await db.clearStaging()
      await importArchive(file, (bytes) => report(Math.min(95, Math.floor(bytes / file.size * 95))))
      report(97)
      const count = await appendStagedHistory()
      report(100)
      return count
    } catch (error) {
      await db.clearStaging().catch(db.reportStorageError('clear unfinished history import'))
      throw error
    }
  })

/** 确认删除后调用：以空历史原子替换全部本地会话与附件，保留 API Key 和其他设置。 */
export const clearHistory = (): Promise<void> =>
  enqueueBackup(async () => {
    await replaceHistory(async () => {})
  })
