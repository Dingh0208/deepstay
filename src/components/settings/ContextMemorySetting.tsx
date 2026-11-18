import { useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { setContextMemoryEnabled, useSettings } from '../../services/settings.js'
import { setSessionContextMemory, useChatStore } from '../../services/chat/store.js'
import type { Session } from '../../services/chat/types.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import settingsStyles from './Settings.module.css'
import appearanceStyles from './AppearanceSetting.module.css'
import styles from './ContextMemorySetting.module.css'

export const ContextMemorySetting = () => {
  const t = useTranslate()
  const enabled = useSettings((state) => state.contextMemoryEnabled)
  const [editing, setEditing] = useState(false)
  const session = useChatStore((state) => state.activeId ? state.sessionCache[state.activeId] : undefined)
  return (
    <div className={`${settingsStyles.cell} ${appearanceStyles.row}`}>
      <label className={settingsStyles.label} htmlFor="context-memory-enabled">
        {t('contextMemoryLabel')}
      </label>
      <div className={styles.actions}>
        <input id="context-memory-enabled" type="checkbox" role="switch" checked={enabled}
          className={appearanceStyles.switch} onChange={(event) => setContextMemoryEnabled(event.target.checked)} />
        <Button variant="outlined" size="m" disabled={!session} onClick={() => setEditing(true)}>
          {t('contextMemoryEdit')}
        </Button>
      </div>
      {editing && session ? <MemoryEditor key={session.id} session={session} onClose={() => setEditing(false)} /> : null}
    </div>
  )
}

const MemoryEditor = ({ session, onClose }: { session: Session; onClose: () => void }) => {
  const t = useTranslate()
  const [fixed, setFixed] = useState(session.contextMemory?.fixed ?? '')
  const streaming = useChatStore((state) => !!state.streaming[session.id])
  return (
    <Modal title={t('contextMemoryEdit')} closable onClose={onClose} className={styles.dialog}
      mainClassName={styles.main}
      footer={<Button disabled={streaming} onClick={() => { setSessionContextMemory(session.id, fixed); onClose() }}>{t('save')}</Button>}>
      <div className={styles.editor}>
        <div className={settingsStyles.description}>{session.title || t('untitledChat')}</div>
        <label className={styles.field}>
          <span>{t('contextMemoryFixed')}</span>
          <textarea value={fixed} maxLength={10_000} disabled={streaming} onChange={(event) => setFixed(event.target.value)} />
        </label>
        <label className={styles.field}>
          <span>{t('contextMemorySummary')}</span>
          <textarea value={session.contextMemory?.cache?.summary ?? ''} readOnly placeholder={t('contextMemoryNoSummary')} />
        </label>
        {streaming ? <div className={settingsStyles.description} role="status">{t('contextMemoryWait')}</div> : null}
      </div>
    </Modal>
  )
}
