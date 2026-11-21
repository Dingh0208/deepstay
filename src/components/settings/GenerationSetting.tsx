import { useRef, useState, type FormEvent } from 'react'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import {
  DEFAULT_CONTEXT_WINDOW,
  generationRanges,
  type GenerationNumber,
  type GenerationSettings,
} from '../../services/api/generation.js'
import { setAutoReadAloud, setGeneration, setShowReplyTokenUsage, useSettings } from '../../services/settings.js'
import { Button } from '../base/Button.js'
import appearance from './AppearanceSetting.module.css'
import styles from './Settings.module.css'

export const ReplyPreferenceSettings = () => {
  const t = useTranslate()
  const autoReadAloud = useSettings((state) => state.autoReadAloud)
  const showUsage = useSettings((state) => state.showReplyTokenUsage)
  return (
    <>
      {[
        { id: 'show-reply-usage', label: 'showReplyTokenUsage' as const, checked: showUsage, change: setShowReplyTokenUsage },
        { id: 'auto-read-aloud', label: 'settingsAutoReadAloud' as const, checked: autoReadAloud, change: setAutoReadAloud },
      ].map(({ id, label, checked, change }) => (
        <div key={id} className={styles.cell}>
          <div className={appearance.row}>
            <label className={styles.label} htmlFor={id}>{t(label)}</label>
            <input id={id} type="checkbox" role="switch" className={appearance.switch}
              checked={checked} onChange={(event) => change(event.target.checked)} />
          </div>
        </div>
      ))}
    </>
  )
}

const fields: [GenerationNumber, TranslationKey][] = [
  ['temperature', 'generationTemperature'],
  ['topP', 'generationTopP'],
  ['maxTokens', 'generationMaxTokens'],
  ['contextTokens', 'generationContextTokens'],
  ['frequencyPenalty', 'generationFrequencyPenalty'],
  ['presencePenalty', 'generationPresencePenalty'],
]

export const GenerationSetting = () => {
  const route = useSettings((state) => JSON.stringify([state.apiBaseUrl, state.apiProtocol, state.model]))
  return <GenerationForm key={route} />
}

const GenerationForm = () => {
  const t = useTranslate()
  const current = useSettings((state) => state.generation)
  const [draft, setDraft] = useState<Record<string, string>>(() => ({
    ...Object.fromEntries(fields.map(([key]) => [key, current[key]?.toString() ?? ''])),
    system: current.system ?? '',
    stop: current.stop?.join('\n') ?? '',
  }))
  const [status, setStatus] = useState<
    'generationInvalidStops' | 'generationSaved' | 'generationImported' | 'generationImportFailed' | null
  >(null)
  const [importing, setImporting] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const edit = (key: string, value: string) => {
    setDraft((previous) => ({ ...previous, [key]: value }))
    setStatus(null)
  }
  const save = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (importing) {
      return
    }
    const stop = draft.stop.split(/\r?\n/).filter(Boolean)
    if (stop.length > 4 || stop.some((text) => text.length > 128)) {
      setStatus('generationInvalidStops')
      return
    }
    const next: GenerationSettings = { system: draft.system, stop }
    for (const [key] of fields) {
      if (draft[key]?.trim()) {
        next[key] = Number(draft[key])
      }
    }
    setGeneration(next)
    setStatus('generationSaved')
  }
  const importText = async (file: File) => {
    setImporting(true)
    setStatus(null)
    try {
      const system = await file.text()
      setDraft((previous) => ({ ...previous, system }))
      setStatus('generationImported')
    } catch {
      setStatus('generationImportFailed')
    } finally {
      setImporting(false)
    }
  }
  return (
    <details className={styles.cell}>
      <summary className={styles.generationSummary}>{t('generationSettings')}</summary>
      <form className={styles.generationForm} onSubmit={save}>
        <label>
          {t('generationSystem')}
          <textarea rows={3} value={draft.system} onChange={(event) => edit('system', event.target.value)} />
        </label>
        <div className={styles.generationImportRow}>
          <input ref={fileInput} type="file" accept=".txt,text/plain" hidden
            onChange={(event) => {
              const file = event.target.files?.[0]
              event.target.value = ''
              if (file) {
                void importText(file)
              }
            }} />
          <Button type="button" variant="outlined" size="m" disabled={importing}
            onClick={() => fileInput.current?.click()}>
            {t(importing ? 'generationImporting' : 'generationImportText')}
          </Button>
        </div>
        <div className={styles.generationNumbers}>
          {fields.map(([key, label]) => (
            <label key={key}>
              {t(label)}
              <input type="number" min={generationRanges[key][0]} max={generationRanges[key][1]}
                step={generationRanges[key][2] === 1 ? 1 : 'any'}
                placeholder={key === 'contextTokens' ? String(DEFAULT_CONTEXT_WINDOW) : t('generationDefault')}
                value={draft[key] ?? ''}
                onChange={(event) => edit(key, event.target.value)} />
            </label>
          ))}
        </div>
        <label>
          {t('generationStop')}
          <textarea rows={2} value={draft.stop} onChange={(event) => edit('stop', event.target.value)} />
        </label>
        <div className={appearance.row}>
          <span role="status" className={
            status === 'generationInvalidStops' || status === 'generationImportFailed' ? styles.error : styles.description
          }>
            {status ? t(status) : ''}
          </span>
          <Button type="submit" variant="outlined" size="m" disabled={importing}>{t('save')}</Button>
        </div>
      </form>
    </details>
  )
}
