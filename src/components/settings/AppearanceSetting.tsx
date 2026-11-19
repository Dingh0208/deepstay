import { useEffect, useRef, useState } from 'react'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import { setThinkingCollapsed, useSettings } from '../../services/settings.js'
import {
  loadChatBackground,
  setChatBackground,
  useChatBackground,
} from '../../services/chatBackground.js'
import { Button } from '../base/Button.js'
import { BackgroundCropDialog } from './BackgroundCropDialog.js'
import settingsStyles from './Settings.module.css'
import styles from './AppearanceSetting.module.css'

export const ThinkingCollapseSetting = () => {
  const t = useTranslate()
  const collapsed = useSettings((state) => state.thinkingCollapsed)
  return (
    <div className={settingsStyles.cell}>
      <div className={styles.row}>
        <label className={settingsStyles.label} htmlFor="thinking-collapsed">
          {t('thinkingCollapsedLabel')}
        </label>
        <input
          id="thinking-collapsed"
          type="checkbox"
          role="switch"
          checked={collapsed}
          className={styles.switch}
          onChange={(event) => setThinkingCollapsed(event.target.checked)}
        />
      </div>
    </div>
  )
}

export const ChatBackgroundSetting = () => {
  const t = useTranslate()
  const url = useChatBackground((state) => state.url)
  const inputRef = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<TranslationKey | null>(null)
  useEffect(() => {
    void loadChatBackground().catch(() => setError('chatBackgroundSaveFailed'))
  }, [])

  const reset = async () => {
    setBusy(true)
    setError(null)
    try {
      await setChatBackground(null)
    } catch {
      setError('chatBackgroundSaveFailed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={settingsStyles.cell} aria-busy={busy}>
      <div className={styles.row}>
        <span className={settingsStyles.label}>{t('chatBackgroundLabel')}</span>
        <div className={styles.actions}>
          <Button variant="outlined" size="m" disabled={busy} onClick={() => inputRef.current?.click()}>
            {t(busy ? 'chatBackgroundSaving' : 'chatBackgroundChoose')}
          </Button>
          {url ? (
            <Button variant="outlined" size="m" disabled={busy} onClick={() => void reset()}>
              {t('chatBackgroundReset')}
            </Button>
          ) : null}
        </div>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/gif,image/bmp"
        hidden
        disabled={busy}
        onChange={(event) => {
          const file = event.target.files?.[0]
          event.target.value = ''
          if (file) {
            setError(null)
            setFile(file)
          }
        }}
      />
      {error ? <div className={settingsStyles.error} role="status">{t(error)}</div> : null}
      {file ? <BackgroundCropDialog file={file} onClose={() => setFile(null)} /> : null}
    </div>
  )
}
