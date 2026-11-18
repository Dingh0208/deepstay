import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import { createId } from '../../utils/id.js'
import { toSessionSummary, type Session, type SessionSummary } from './types.js'
import type {
  MemoryRecord,
  MemorySegment,
  MemorySnapshot,
  MemoryState,
  MemoryUpdate,
} from './memoryTypes.js'

/** IndexedDB 存储结构版本；新增或调整存储、索引时递增。 */
const DB_VERSION = 13

/** 文件原件按附件的本地 id 存储，所有引用同一 id 的消息共用一份；用于缩略图、打开查看，以及没有 serverId 时补传。 */
export type StoredFile = {
  id: string
  blob: Blob
}

/** 文件引用留在摘要中，删除会话时通过索引判断原件是否仍被引用。 */
type StoredSessionSummary = SessionSummary & { fileIds: string[] }

interface ChatDB extends DBSchema {
  /** 当前使用的会话，界面读写都在这里 */
  sessions: { key: string; value: Session }
  sessionSummaries: {
    key: string
    value: StoredSessionSummary
    indexes: { fileIds: string }
  }
  /** 当前使用的文件原件 */
  files: { key: string; value: StoredFile }
  /**
   * 历史导入的暂存：导入过程中会话与原件只写入这两个存储，`sessions` / `files` 保持不变；
   * 全部校验通过后在一个事务中新增正式数据并清空暂存，失败时只清空暂存。
   */
  sessionsStaging: { key: string; value: Session }
  filesStaging: { key: string; value: StoredFile }
  memoryRecords: { key: string; value: MemoryRecord; indexes: { sessionId: string } }
  memorySegments: { key: string; value: MemorySegment; indexes: { sessionId: string } }
  memoryState: { key: string; value: MemoryState }
}

let dbPromise: Promise<IDBPDatabase<ChatDB>> | null = null

const storedSummary = (session: Session): StoredSessionSummary => ({
  ...toSessionSummary(session),
  fileIds: [
    ...new Set(
      session.messages.flatMap((message) =>
        message.role === 'user' ? message.files.map((file) => file.id) : []
      )
    ),
  ],
})

const abortTransaction = (tx: { abort(): void }) => {
  try {
    tx.abort()
  } catch {
    // 事务已因请求失败中止。
  }
}

// 每个操作拿到连接后立即创建事务；IndexedDB 按创建顺序执行范围重叠的事务，读取总能看到之前发起的写入。
const getDB = () =>
  (dbPromise ??= openDB<ChatDB>('xuchat-guest', DB_VERSION, {
    upgrade(db, _oldVersion, _newVersion, tx) {
      // 初始化当前格式需要的存储与索引，不迁移旧消息。
      for (const name of ['sessions', 'files', 'sessionsStaging', 'filesStaging'] as const) {
        if (!db.objectStoreNames.contains(name)) {
          db.createObjectStore(name, { keyPath: 'id' })
        }
      }
      const summaries = db.objectStoreNames.contains('sessionSummaries')
        ? tx.objectStore('sessionSummaries')
        : db.createObjectStore('sessionSummaries', { keyPath: 'id' })
      if (!summaries.indexNames.contains('fileIds')) {
        summaries.createIndex('fileIds', 'fileIds', { multiEntry: true })
      }
      for (const name of ['memoryRecords', 'memorySegments'] as const) {
        const store = db.objectStoreNames.contains(name)
          ? tx.objectStore(name)
          : db.createObjectStore(name, { keyPath: 'id' })
        if (!store.indexNames.contains('sessionId')) {
          store.createIndex('sessionId', 'sessionId')
        }
      }
      if (!db.objectStoreNames.contains('memoryState')) {
        db.createObjectStore('memoryState', { keyPath: 'sessionId' })
      }
    },
  }).catch((error: unknown) => {
    // 打开失败后允许界面重试，避免一直复用已拒绝的 Promise。
    dbPromise = null
    throw error
  }))

export const loadSessionSummaries = async (): Promise<SessionSummary[]> =>
  (await (await getDB()).getAll('sessionSummaries')).map(toSessionSummary)

export const loadSession = async (id: string): Promise<Session | undefined> =>
  (await getDB()).get('sessions', id)

/** 原文、派生记忆及版本来自同一事务，旧会话无需预先迁移。 */
export const loadMemorySnapshot = async (
  sessionId: string
): Promise<MemorySnapshot | undefined> => {
  const tx = (await getDB()).transaction([
    'sessions',
    'memoryRecords',
    'memorySegments',
    'memoryState',
  ])
  const [session, state, records, segments] = await Promise.all([
    tx.objectStore('sessions').get(sessionId),
    tx.objectStore('memoryState').get(sessionId),
    tx.objectStore('memoryRecords').index('sessionId').getAll(sessionId),
    tx.objectStore('memorySegments').index('sessionId').getAll(sessionId),
    tx.done,
  ])
  return session
    ? {
        session,
        state: state ?? { sessionId, sourceRevision: 0, memoryRevision: 0 },
        records,
        segments,
      }
    : undefined
}

/** 只提交仍属于同一原文快照的派生结果；不改写消息，也不复活已删除会话。 */
export const commitMemoryUpdate = async (
  expected: MemoryState,
  update: MemoryUpdate,
  canCommit: () => boolean = () => true
): Promise<boolean> => {
  if (
    [...update.records, ...update.segments].some((entry) => entry.sessionId !== expected.sessionId)
  ) {
    throw new Error('Memory update belongs to another session')
  }
  if (!canCommit()) {
    return false
  }
  const tx = (await getDB()).transaction(
    ['sessions', 'memoryRecords', 'memorySegments', 'memoryState'],
    'readwrite'
  )
  let committed = false
  let invalidated = false
  const current = () => {
    if (canCommit()) {
      return true
    }
    invalidated = true
    abortTransaction(tx)
    return false
  }
  try {
    await Promise.all([
      (async () => {
        try {
          const stateStore = tx.objectStore('memoryState')
          const state = (await stateStore.get(expected.sessionId)) ?? {
            sessionId: expected.sessionId,
            sourceRevision: 0,
            memoryRevision: 0,
          }
          if (!current()) {
            return
          }
          if (
            state.sourceRevision !== expected.sourceRevision ||
            state.memoryRevision !== expected.memoryRevision ||
            (await tx.objectStore('sessions').getKey(expected.sessionId)) === undefined
          ) {
            return
          }
          if (!current()) {
            return
          }
          const segments = tx.objectStore('memorySegments')
          const pending = []
          for (const segment of update.segments) {
            const existing = await segments.get(segment.id)
            if (!current()) {
              return
            }
            if (existing && existing.sessionId !== expected.sessionId) {
              throw new Error('Memory segment belongs to another session')
            }
            if (!existing) {
              pending.push(segment)
            }
          }
          // 同一分段重试不新增另一份模型结果；ID 由来源范围和抽取版本确定。
          if (update.segments.length > 0 && pending.length === 0) {
            committed = true
            return
          }
          const records = tx.objectStore('memoryRecords')
          let changed = false
          for (const record of update.records) {
            const existing = await records.get(record.id)
            if (!current()) {
              return
            }
            if (existing && existing.sessionId !== expected.sessionId) {
              throw new Error('Memory record belongs to another session')
            }
            if (!existing) {
              await records.add(record)
              if (!current()) {
                return
              }
              changed = true
            }
          }
          for (const segment of pending) {
            await segments.add(segment)
            if (!current()) {
              return
            }
            changed = true
          }
          if (changed) {
            await stateStore.put({ ...state, memoryRevision: state.memoryRevision + 1 })
          }
          if (!current()) {
            return
          }
          committed = true
        } catch (error) {
          abortTransaction(tx)
          throw error
        }
      })(),
      tx.done,
    ])
  } catch (error) {
    if (!invalidated) {
      throw error
    }
  }
  return committed
}

export const visitSessions = async (visit: (session: Session) => boolean): Promise<void> => {
  const tx = (await getDB()).transaction('sessions')
  for (let cursor = await tx.store.openCursor(); cursor; cursor = await cursor.continue()) {
    if (!visit(cursor.value)) {
      break
    }
  }
  await tx.done
}

export const saveSession = async (session: Session, files: StoredFile[] = []): Promise<void> => {
  const summary = storedSummary(session)
  const tx = (await getDB()).transaction(
    ['sessions', 'sessionSummaries', 'files', 'memoryState'],
    'readwrite'
  )
  await Promise.all([
    (async () => {
      try {
        for (const file of files) {
          await tx.objectStore('files').put(file)
        }
        await tx.objectStore('sessions').put(session)
        await tx.objectStore('sessionSummaries').put(summary)
        const memoryState = tx.objectStore('memoryState')
        const previous = await memoryState.get(session.id)
        await memoryState.put({
          sessionId: session.id,
          sourceRevision: (previous?.sourceRevision ?? 0) + 1,
          memoryRevision: previous?.memoryRevision ?? 0,
        })
      } catch (error) {
        abortTransaction(tx)
        throw error
      }
    })(),
    tx.done,
  ])
}

/** 未打开的会话也可重命名，只读取该会话，原子更新详情和列表。 */
export const renameSession = async (id: string, title: string): Promise<void> => {
  const tx = (await getDB()).transaction(
    ['sessions', 'sessionSummaries', 'memoryState'],
    'readwrite'
  )
  await Promise.all([
    (async () => {
      try {
        const sessions = tx.objectStore('sessions')
        const session = await sessions.get(id)
        if (session) {
          session.title = title
          await sessions.put(session)
          await tx.objectStore('sessionSummaries').put(storedSummary(session))
          const memoryState = tx.objectStore('memoryState')
          const previous = await memoryState.get(id)
          await memoryState.put({
            sessionId: id,
            sourceRevision: (previous?.sourceRevision ?? 0) + 1,
            memoryRevision: previous?.memoryRevision ?? 0,
          })
        }
      } catch (error) {
        abortTransaction(tx)
        throw error
      }
    })(),
    tx.done,
  ])
}

/** 删除会话，仅清理已无会话引用的本地原件；远端文件不删。 */
export const deleteSession = async (sessionId: string): Promise<void> => {
  const tx = (await getDB()).transaction(
    ['sessions', 'sessionSummaries', 'files', 'memoryRecords', 'memorySegments', 'memoryState'],
    'readwrite'
  )
  await Promise.all([
    (async () => {
      try {
        const summaries = tx.objectStore('sessionSummaries')
        const summary = await summaries.get(sessionId)
        await tx.objectStore('sessions').delete(sessionId)
        await summaries.delete(sessionId)
        for (const name of ['memoryRecords', 'memorySegments'] as const) {
          const store = tx.objectStore(name)
          for (
            let cursor = await store.index('sessionId').openKeyCursor(sessionId);
            cursor;
            cursor = await cursor.continue()
          ) {
            await store.delete(cursor.primaryKey)
          }
        }
        await tx.objectStore('memoryState').delete(sessionId)
        for (const id of summary?.fileIds ?? []) {
          if ((await summaries.index('fileIds').count(id)) === 0) {
            await tx.objectStore('files').delete(id)
          }
        }
      } catch (error) {
        abortTransaction(tx)
        throw error
      }
    })(),
    tx.done,
  ])
}

const putFiles = async (store: 'files' | 'filesStaging', files: StoredFile[]) => {
  const tx = (await getDB()).transaction(store, 'readwrite')
  await Promise.all([...files.map((file) => tx.store.put(file)), tx.done])
}

export const saveFiles = (files: StoredFile[]): Promise<void> => putFiles('files', files)

export const loadFile = async (id: string): Promise<Blob | undefined> =>
  (await (await getDB()).get('files', id))?.blob

/** 清空导入暂存：开始导入前清除上次中断（如关闭页面）遗留的数据，导入失败后清除本次写入。 */
export const clearStaging = async (): Promise<void> => {
  const tx = (await getDB()).transaction(['sessionsStaging', 'filesStaging'], 'readwrite')
  await Promise.all([
    tx.objectStore('sessionsStaging').clear(),
    tx.objectStore('filesStaging').clear(),
    tx.done,
  ])
}

export const addStagingSession = async (session: Session): Promise<void> => {
  await addStagingSessions([session])
}

export const addStagingSessions = async (sessions: Session[]): Promise<void> => {
  const tx = (await getDB()).transaction('sessionsStaging', 'readwrite')
  await Promise.all([
    (async () => {
      try {
        await Promise.all(sessions.map((session) => tx.store.add(session)))
      } catch (error) {
        abortTransaction(tx)
        throw error
      }
    })(),
    tx.done,
  ])
}

export const saveStagingFiles = (files: StoredFile[]): Promise<void> =>
  putFiles('filesStaging', files)

/** 图片位于会话 JSON 之后；全部读完后回填具体 MIME，保留归档给出的 isImage 标识。 */
export const updateStagingFileTypes = async (types: ReadonlyMap<string, string>): Promise<void> => {
  const tx = (await getDB()).transaction('sessionsStaging', 'readwrite')
  await Promise.all([
    (async () => {
      for (let cursor = await tx.store.openCursor(); cursor; cursor = await cursor.continue()) {
        const session = cursor.value
        let changed = false
        for (const message of session.messages) {
          if (message.role !== 'user') {
            continue
          }
          for (const file of message.files) {
            const type = types.get(file.id) ?? ''
            if (file.mimeType !== type) {
              file.mimeType = type
              changed = true
            }
          }
        }
        if (changed) {
          await cursor.update(session)
        }
      }
    })(),
    tx.done,
  ])
}

/**
 * 导入完成后原子新增会话、摘要和原件，并清空暂存；仅清空历史时显式替换。
 * 新增导入重建会话和附件 ID，重复导入也不会覆盖本机记录。
 * 逐条游标复制，同一时间只读取一条记录；事务失败时整体回滚，正式数据不变。
 */
export const commitStaging = async (replace = false): Promise<SessionSummary[]> => {
  const summaries: SessionSummary[] = []
  const fileIds = new Map<string, string>()
  const importedFileId = (id: string) => {
    let mapped = fileIds.get(id)
    if (!mapped) {
      mapped = createId()
      fileIds.set(id, mapped)
    }
    return mapped
  }
  const tx = (await getDB()).transaction(
    [
      'sessions',
      'sessionSummaries',
      'files',
      'sessionsStaging',
      'filesStaging',
      'memoryRecords',
      'memorySegments',
      'memoryState',
    ],
    'readwrite'
  )
  const move = async (from: 'sessionsStaging' | 'filesStaging', to: 'sessions' | 'files') => {
    try {
      const target = tx.objectStore(to)
      if (replace) {
        await target.clear()
        if (to === 'sessions') {
          await tx.objectStore('sessionSummaries').clear()
          await tx.objectStore('memoryRecords').clear()
          await tx.objectStore('memorySegments').clear()
          await tx.objectStore('memoryState').clear()
        }
      }
      for (
        let cursor = await tx.objectStore(from).openCursor();
        cursor;
        cursor = await cursor.continue()
      ) {
        const value = cursor.value
        if (!replace) {
          value.id = to === 'sessions' ? createId() : importedFileId(value.id)
          if (to === 'sessions') {
            for (const message of (value as Session).messages) {
              if (message.role === 'user') {
                for (const file of message.files) {
                  file.id = importedFileId(file.id)
                }
              }
            }
          }
        }
        await target.add(value)
        if (to === 'sessions') {
          const summary = storedSummary(value as Session)
          await tx.objectStore('sessionSummaries').put(summary)
          await tx
            .objectStore('memoryState')
            .put({ sessionId: value.id, sourceRevision: 1, memoryRevision: 0 })
          summaries.push(toSessionSummary(summary))
        }
      }
      await tx.objectStore(from).clear()
    } catch (error) {
      // 同步抛出的错误不会让事务自动回滚，需显式中止，避免部分导入。
      abortTransaction(tx)
      throw error
    }
  }
  await Promise.all([move('sessionsStaging', 'sessions'), move('filesStaging', 'files'), tx.done])
  // 直接返回本次提交的列表，调用方无需在提交成功后再发起可能失败的读取。
  return summaries
}

/** 本地存储失败不打断对话，只在控制台留痕 */
export const reportStorageError = (action: string) => (error: unknown) => {
  // eslint-disable-next-line no-console
  console.error(`[storage] ${action} failed`, error)
}
