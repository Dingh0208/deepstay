import { create } from 'zustand'
import { isTranslationKey, type TranslationKey } from '../../i18n/index.js'
import { clearStaging } from './db.js'
import { applyStagedHistory, reserveHistoryStaging } from './backup.js'
import { useChatStore } from './store.js'

type ImportState = {
  phase: 'idle' | 'preparing' | 'ready' | 'applying' | 'cancelling' | 'done' | 'error'
  progress: number
  sessions: number
  error: TranslationKey | null
}
export const useBackgroundImport = create<ImportState>(() => ({ phase: 'idle', progress: 0, sessions: 0, error: null }))
let worker: Worker | null = null
let releaseStaging: (() => void) | undefined
const release = () => {
  releaseStaging?.()
  releaseStaging = undefined
}
export const backgroundImportBusy = () => ['preparing', 'ready', 'applying', 'cancelling'].includes(useBackgroundImport.getState().phase)

export const startBackgroundImport = (file: File) => {
  if (backgroundImportBusy() || useChatStore.getState().importingHistory) {
    return
  }
  releaseStaging = reserveHistoryStaging()
  if (!releaseStaging) {
    return
  }
  useBackgroundImport.setState({ phase: 'preparing', progress: 0, sessions: 0, error: null })
  try {
    const task = new Worker(new URL('./history/import.worker.ts', import.meta.url))
    worker = task
    task.onmessage = ({ data }) => {
      if (worker !== task) {
        return
      }
      if (data.type === 'progress') {
        useBackgroundImport.setState({ progress: Math.min(99, Math.floor(data.bytes / Math.max(1, data.total) * 100)), sessions: data.sessions })
      } else if (data.type === 'ready') {
        task.terminate()
        worker = null
        useBackgroundImport.setState({ phase: 'ready', progress: 100, sessions: data.sessions })
      } else if (data.type === 'error') {
        task.terminate()
        worker = null
        release()
        useBackgroundImport.setState({ phase: 'error', error: isTranslationKey(data.key) ? data.key : 'historyImportFailed' })
      }
    }
    task.onerror = () => {
      if (worker === task) {
        task.terminate()
        worker = null
        void clearStaging().finally(() => {
          release()
          useBackgroundImport.setState({ phase: 'error', error: 'historyImportFailed' })
        }).catch(() => {})
      }
    }
    task.postMessage({ file })
  } catch {
    worker?.terminate()
    worker = null
    release()
    useBackgroundImport.setState({ phase: 'error', error: 'historyImportFailed' })
  }
}

export const cancelBackgroundImport = async () => {
  const { phase } = useBackgroundImport.getState()
  if (phase !== 'preparing' && phase !== 'ready') {
    return
  }
  worker?.terminate()
  worker = null
  useBackgroundImport.setState({ phase: 'cancelling' })
  try {
    await clearStaging()
    release()
    useBackgroundImport.setState({ phase: 'idle', progress: 0, sessions: 0, error: null })
  } catch {
    release()
    useBackgroundImport.setState({ phase: 'error', error: 'historyImportFailed' })
  }
}

export const applyBackgroundImport = async () => {
  if (useBackgroundImport.getState().phase !== 'ready') {
    return
  }
  useBackgroundImport.setState({ phase: 'applying' })
  try {
    const sessions = await applyStagedHistory()
    release()
    useBackgroundImport.setState({ phase: 'done', progress: 100, sessions })
  } catch {
    release()
    useBackgroundImport.setState({ phase: 'error', error: 'historyImportFailed' })
  }
}

export const dismissBackgroundImport = () => {
  if (!backgroundImportBusy()) {
    useBackgroundImport.setState({ phase: 'idle', progress: 0, sessions: 0, error: null })
  }
}
