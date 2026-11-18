import { formatDate } from '../../utils/format.js'
import { hasOwn } from '../../utils/object.js'
import * as db from './db.js'
import { appendStagedHistory, replaceHistory, useChatStore } from './store.js'
import type { Session } from './types.js'

export { BackupError } from './history/errors.js'

// 导入、导出与全部删除串行处理，避免读取归档时数据被清空或两个导入事务交错。
let backupQueue: Promise<unknown> = Promise.resolve()
let stagingReserved = false

/** 校验和后台准备也占用暂存，避免两个导入在异步读取期间交错。 */
export const reserveHistoryStaging = (): (() => void) | undefined => {
  if (stagingReserved) {
    return
  }
  stagingReserved = true
  let owned = true
  return () => {
    if (owned) {
      owned = false
      stagingReserved = false
    }
  }
}

const withStaging = async <T>(run: () => Promise<T>): Promise<T> => {
  const release = reserveHistoryStaging()
  if (!release) {
    throw new Error('Another history import already owns the staging area')
  }
  try {
    return await run()
  } finally {
    release()
  }
}

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

/**
 * 先检查 ZIP 格式与版本，再流式写入暂存；校验成功才新增会话和图片原件。
 * 现有聊天和生成不受影响。返回新增的会话数。
 */
export const importHistory = (file: File): Promise<number> =>
  enqueueBackup(() => withStaging(async () => {
    const { checkArchiveFormat, importArchive } = await import('./history/importArchive.js')
    await checkArchiveFormat(file)
    try {
      await db.clearStaging()
      await importArchive(file)
      return await appendStagedHistory()
    } catch (error) {
      await db.clearStaging().catch(db.reportStorageError('clear unfinished history import'))
      throw error
    }
  }))

/** 后台暂存由调用方持有；与导出串行，保证导出与正式导入按顺序执行。 */
export const applyStagedHistory = (): Promise<number> =>
  enqueueBackup(async () => {
    try {
      return await appendStagedHistory()
    } catch (error) {
      await db.clearStaging().catch(db.reportStorageError('clear unfinished history import'))
      throw error
    }
  })

/** 确认删除后调用：以空历史原子替换全部本地会话与附件，保留 API Key 和其他设置。 */
export const clearHistory = (): Promise<void> =>
  enqueueBackup(() => withStaging(async () => {
    await replaceHistory(async () => {})
  }))
