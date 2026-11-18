import { useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { useChatStore } from '../../services/chat/store.js'
import { useSettings } from '../../services/settings.js'
import { Button } from '../base/Button.js'
import { Logo } from '../base/Logo.js'
import { Modal } from '../base/Modal.js'
import { openSettings } from './settingsDialogState.js'
import styles from './FirstRunGuide.module.css'

const GUIDE_KEY = 'deepstay:key-guide-seen'

export const FirstRunGuide = () => {
  const t = useTranslate()
  const ready = useChatStore((state) => state.ready)
  const apiKey = useSettings((state) => state.apiKey)
  const [seen, setSeen] = useState(() => {
    try {
      return localStorage.getItem(GUIDE_KEY) === 'true'
    } catch {
      return false
    }
  })
  const dismiss = () => {
    setSeen(true)
    try {
      localStorage.setItem(GUIDE_KEY, 'true')
    } catch {
      // 本机存储不可用时，仅在本次启动内记住。
    }
  }

  if (!ready || apiKey || seen) {
    return null
  }

  return (
    <Modal
      title="deepstay"
      closable
      className={styles.dialog}
      onClose={dismiss}
      footer={
        <>
          <Button variant="outlined" onClick={dismiss}>{t('keyGuideLater')}</Button>
          <Button autoFocus onClick={() => {
            dismiss()
            openSettings('api')
          }}>{t('keyGuideOpenSettings')}</Button>
        </>
      }
    >
      <div className={styles.content}>
        <Logo size={64} />
        <h2>{t('keyGuideTitle')}</h2>
        <p>{t('keyGuideDescription')}</p>
      </div>
    </Modal>
  )
}
