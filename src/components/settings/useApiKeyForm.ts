import { useEffect, useRef, useState } from 'react'
import { ApiError, fetchModels } from '../../services/api/client.js'
import { DEEPSEEK_OFFICIAL_API_URL, normalizeApiBaseUrl } from '../../services/api/connection.js'
import { classifyApiError } from '../../services/api/errors.js'
import { setApiConnection, useSettings, type ApiProtocol } from '../../services/settings.js'
import { useChatStore } from '../../services/chat/store.js'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'

/** 测试使用当前输入；地址、Key 和模型确认后一起保存。 */
export const useApiKeyForm = () => {
  const t = useTranslate()
  const saved = useSettings.getState()
  const [value, setValue] = useState(saved.apiKey ?? '')
  const [baseUrl, setBaseUrl] = useState(
    saved.apiProtocol === 'deepseek' ? DEEPSEEK_OFFICIAL_API_URL : saved.apiBaseUrl
  )
  const [protocol, setProtocol] = useState<ApiProtocol>(saved.apiProtocol)
  const [model, setModel] = useState(saved.model)
  const [models, setModels] = useState(saved.models)
  const [busy, setBusy] = useState<'test' | 'models' | null>(null)
  const [status, setStatus] = useState<{ key: TranslationKey; error?: boolean } | null>(null)
  const [failure, setFailure] = useState<unknown>(null)
  const task = useRef<AbortController | null>(null)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false; task.current?.abort() }
  }, [])

  const changeConnection = (change: () => void) => {
    task.current?.abort()
    task.current = null
    setBusy(null)
    setModels([])
    setFailure(null)
    setStatus(null)
    change()
  }

  const run = async (action: 'test' | 'models') => {
    if (task.current) {
      return
    }
    let url: string
    try { url = normalizeApiBaseUrl(baseUrl) } catch {
      setStatus({ key: 'apiUrlInvalid', error: true }); return
    }
    if (!value.trim()) { setStatus({ key: 'apiKeyRequired', error: true }); return }
    const controller = new AbortController()
    task.current = controller
    setBusy(action)
    setStatus(null)
    setFailure(null)
    try {
      const available = await fetchModels(value.trim(), url, controller.signal)
      if (!alive.current || task.current !== controller) {
        return
      }
      if (action === 'models') {
        setModels(available)
        if (!available.includes(model)) {
          setModel(available[0] ?? model)
        }
      }
      setStatus({ key: action === 'models' ? 'apiModelsLoaded' : 'apiConnectionOk' })
    } catch (error) {
      if (alive.current && task.current === controller) {
        setFailure(error)
      }
    } finally {
      if (alive.current && task.current === controller) { task.current = null; setBusy(null) }
    }
  }

  const submit = () => {
    if (busy || Object.keys(useChatStore.getState().streaming).length > 0) {
      return
    }
    let url: string
    try { url = normalizeApiBaseUrl(baseUrl) } catch {
      setStatus({ key: 'apiUrlInvalid', error: true }); return
    }
    if (!value.trim() || !model.trim()) {
      setStatus({ key: !value.trim() ? 'apiKeyRequired' : 'apiModelRequired', error: true }); return
    }
    setApiConnection({ apiKey: value.trim(), apiBaseUrl: url, apiProtocol: protocol, model: model.trim(), models })
    setBaseUrl(url)
    setFailure(null)
    setStatus({ key: 'apiConnectionSaved' })
  }

  const error = failure === null ? null
    : classifyApiError(failure) === 'unauthorized' ? t('apiKeyInvalid')
      : failure instanceof ApiError && failure.localMessage
        ? t(failure.localMessage.key, failure.localMessage.params)
        : t('apiKeyVerificationFailed', {
          message: failure instanceof Error ? failure.message : String(failure),
        })
  return {
    value, setValue: (next: string) => changeConnection(() => setValue(next)),
    baseUrl, setBaseUrl: (next: string) => changeConnection(() => setBaseUrl(next)),
    protocol, setProtocol: (next: ApiProtocol) => changeConnection(() => {
      setProtocol(next)
      if (next === 'deepseek') {
        setBaseUrl(DEEPSEEK_OFFICIAL_API_URL)
      }
    }),
    model, setModel: (next: string) => { setModel(next); setStatus(null) },
    models, busy, error, status, run, submit,
  }
}
