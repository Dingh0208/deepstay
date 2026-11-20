import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Capacitor, registerPlugin } from '@capacitor/core'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import {
  characterGreetings, characterLimits, deleteCharacter, loadCharacters, saveCharacter, useCharacters,
  type CharacterPreset,
} from '../../services/characters.js'
import { exportCharacterCard, importCharacterCard } from '../../services/characterCards.js'
import { startCharacterChat, useChatStore } from '../../services/chat/store.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { Select } from '../base/Select.js'
import { closeSettings } from '../settings/settingsDialogState.js'
import { closeMobileSider } from '../sider/mobileSiderState.js'
import { closeCharacters, useCharacterDialog } from './characterDialogState.js'
import styles from './CharactersDialog.module.css'

export const CharacterIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <circle cx="8" cy="5" r="2.5" stroke="currentColor" strokeWidth="1.4" />
    <path d="M3 14v-1a5 5 0 0 1 10 0v1" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
  </svg>
)

export const CharactersDialog = () => {
  const open = useCharacterDialog((state) => state.open)
  return open ? <CharactersContent /> : null
}

type Draft = { id?: string; name: string; prompt: string; greeting: string; alternateGreetings?: string[] }
const emptyDraft = (): Draft => ({ name: '', prompt: '', greeting: '' })

const CharactersContent = () => {
  const t = useTranslate()
  const { presets, ready, error } = useCharacters()
  const importing = useChatStore((state) => state.importingHistory)
  const chatReady = useChatStore((state) => state.ready)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [deleting, setDeleting] = useState<CharacterPreset | null>(null)
  const [starting, setStarting] = useState<{ preset: CharacterPreset; index: number } | null>(null)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const [status, setStatus] = useState<TranslationKey | null>(null)
  const [imported, setImported] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  useEffect(() => { void loadCharacters().catch(() => {}) }, [])

  const run = async (action: () => Promise<void>, failure: TranslationKey) => {
    if (busyRef.current) {
      return
    }
    busyRef.current = true
    setBusy(true)
    setStatus(null)
    try {
      await action()
    } catch {
      setStatus(failure)
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }
  const edit = (value: Draft | null) => {
    setDraft(value)
    setImported(false)
    setStatus(null)
  }
  const save = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (draft) {
      void run(async () => { await saveCharacter(draft); edit(null) }, 'characterSaveFailed')
    }
  }
  const start = (preset: CharacterPreset, index = 0) => {
    if (startCharacterChat(preset, index)) {
      closeCharacters()
      closeSettings()
      closeMobileSider()
    }
  }
  const download = async (preset: CharacterPreset) => {
    const blob = new Blob([exportCharacterCard(preset)], { type: 'application/json' })
    if (Capacitor.getPlatform() === 'android') {
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result).split(',')[1])
        reader.onerror = () => reject(reader.error)
        reader.readAsDataURL(blob)
      })
      const files = registerPlugin<{
        save(options: { name: string; data: string; mimeType: string }): Promise<{ cancelled: boolean }>
      }>('LocalFiles')
      await files.save({ name: 'deepstay-character.json', data, mimeType: 'application/json' })
      return
    }
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = 'deepstay-character.json'
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  return (
    <>
      <Modal title={t(draft ? draft.id ? 'characterEdit' : 'characterCreate' : 'characterPresets')}
        className={styles.dialog} mainClassName={styles.main} closable
        onClose={() => { if (!busyRef.current) { closeCharacters() } }}>
        {draft ? (
          <form className={styles.form} onSubmit={save}>
            <label>{t('characterName')}
              <input autoFocus required maxLength={characterLimits.name} value={draft.name} disabled={busy}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
            </label>
            <label>{t('characterPrompt')}
              <textarea rows={8} required maxLength={characterLimits.prompt} value={draft.prompt} disabled={busy}
                onChange={(event) => setDraft({ ...draft, prompt: event.target.value })} />
            </label>
            <label>{t('characterGreeting')}
              <textarea rows={3} maxLength={characterLimits.greeting} value={draft.greeting} disabled={busy}
                onChange={(event) => setDraft({ ...draft, greeting: event.target.value })} />
            </label>
            {(draft.alternateGreetings ?? []).map((greeting, index) => (
              <div key={index}>
                <label>{t('characterGreetingNumber', { number: index + 2 })}
                  <textarea rows={3} maxLength={characterLimits.greeting} value={greeting} disabled={busy}
                    onChange={(event) => setDraft({ ...draft, alternateGreetings: draft.alternateGreetings?.map((text, at) => at === index ? event.target.value : text) })} />
                </label>
                <Button size="s" variant="outlined" disabled={busy} onClick={() => setDraft({
                  ...draft, alternateGreetings: draft.alternateGreetings?.filter((_, at) => at !== index),
                })}>{t('characterRemoveGreeting')}</Button>
              </div>
            ))}
            <div>
              <Button size="s" variant="outlined" disabled={busy || (draft.alternateGreetings?.length ?? 0) >= characterLimits.greetings - 1}
                onClick={() => setDraft({ ...draft, alternateGreetings: [...(draft.alternateGreetings ?? []), ''] })}>
                {t('characterAddGreeting')}
              </Button>
            </div>
            {imported ? <p className={styles.hint}>{t('characterImportTextOnly')}</p> : null}
            <p className={styles.hint}>{t('characterSnapshotHint')}</p>
            {status ? <div role="alert" className={styles.error}>{t(status)}</div> : null}
            <div className={styles.actions}>
              <Button size="m" variant="outlined" disabled={busy} onClick={() => edit(null)}>{t('cancel')}</Button>
              <Button type="submit" size="m" disabled={busy || !draft.name.trim() || !draft.prompt.trim()}>
                {t(busy ? 'characterSaving' : 'save')}
              </Button>
            </div>
          </form>
        ) : (
          <>
            <div className={styles.toolbar}>
              <Button size="m" onClick={() => edit(emptyDraft())} disabled={busy || !ready}>{t('characterCreate')}</Button>
              <Button size="m" variant="outlined" onClick={() => fileInput.current?.click()} disabled={busy || !ready}>
                {t(busy ? 'characterReading' : 'characterImport')}
              </Button>
              <input ref={fileInput} type="file" accept=".json,.png,.charx" hidden disabled={busy || !ready}
                onChange={(event) => {
                  const file = event.target.files?.[0]
                  event.target.value = ''
                  if (file) {
                    void run(async () => {
                      const value = await importCharacterCard(file)
                      edit({ name: value.name, prompt: value.prompt, greeting: value.greeting, alternateGreetings: value.alternateGreetings })
                      setImported(value.warnings.length > 0)
                    }, 'characterImportFailed')
                  }
                }} />
            </div>
            {!ready ? (
              <div className={styles.empty} role="status">
                {t(error ? 'characterLoadFailed' : 'characterLoading')}
                {error ? <Button size="s" variant="outlined" onClick={() => { void loadCharacters().catch(() => {}) }}>{t('retry')}</Button> : null}
              </div>
            ) : presets.length === 0 ? <p className={styles.empty}>{t('characterEmpty')}</p> : (
              <div className={styles.list}>
                {presets.map((preset) => (
                  <article key={preset.id} className={styles.card}>
                    <div className={styles.cardHeader}>
                      <span className={styles.avatar} aria-hidden="true">{Array.from(preset.name)[0]}</span>
                      <strong>{preset.name}</strong>
                    </div>
                    <p className={styles.excerpt}>{preset.prompt}</p>
                    <div className={styles.cardActions}>
                      <Button size="s" disabled={busy || importing || !chatReady} onClick={() => {
                        if (preset.alternateGreetings?.length) {
                          setStarting({ preset, index: 0 })
                        } else {
                          start(preset)
                        }
                      }}>{t('characterStartChat')}</Button>
                      <Button size="s" variant="outlined" disabled={busy} onClick={() => edit(preset)}>{t('characterEdit')}</Button>
                      <Button size="s" variant="outlined" disabled={busy} onClick={() => {
                        void run(() => download(preset), 'characterExportFailed')
                      }}>{t('characterExport')}</Button>
                      <Button size="s" variant="dangerOutlined" disabled={busy} onClick={() => setDeleting(preset)}>{t('delete')}</Button>
                    </div>
                  </article>
                ))}
              </div>
            )}
            {status ? <div role="alert" className={styles.error}>{t(status)}</div> : null}
          </>
        )}
      </Modal>
      {starting ? (
        <Modal title={t('characterChooseGreeting')} closable className={styles.dialog} mainClassName={styles.main}
          onClose={() => setStarting(null)} footer={<>
            <Button size="m" variant="outlined" onClick={() => setStarting(null)}>{t('cancel')}</Button>
            <Button size="m" disabled={importing || !chatReady} onClick={() => start(starting.preset, starting.index)}>{t('characterStartChat')}</Button>
          </>}>
          <div className={styles.form}>
            <Select ariaLabel={t('characterChooseGreeting')} value={String(starting.index)}
              options={characterGreetings(starting.preset).map((_, index) => ({ value: String(index), label: t('characterGreetingNumber', { number: index + 1 }) }))}
              onChange={(value) => setStarting({ ...starting, index: Number(value) })} />
            <textarea readOnly rows={8} aria-label={t('characterGreetingPreview')}
              value={characterGreetings(starting.preset)[starting.index]} placeholder={t('characterNoGreeting')} />
          </div>
        </Modal>
      ) : null}
      {deleting ? (
        <Modal title={t('characterDeleteTitle')} onClose={() => { if (!busyRef.current) { setDeleting(null) } }}
          footer={<>
            <Button size="m" variant="outlined" disabled={busy} onClick={() => setDeleting(null)}>{t('cancel')}</Button>
            <Button size="m" variant="danger" disabled={busy} onClick={() => {
              void run(async () => { await deleteCharacter(deleting.id); setDeleting(null) }, 'characterSaveFailed')
            }}>{t('delete')}</Button>
          </>}>
          <p>{t('characterDeleteHint', { name: deleting.name })}</p>
          {status ? <div role="alert" className={styles.error}>{t(status)}</div> : null}
        </Modal>
      ) : null}
    </>
  )
}
