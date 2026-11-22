import { useIsMobile } from '../../app/viewport.js'
import { useTranslate } from '../../i18n/index.js'
import { ChatInput } from '../chatInput/ChatInput.js'
import { Logo } from '../base/Logo.js'
import { MobileHeader } from './MobileHeader.js'
import { openCharacters } from '../characters/characterDialogState.js'
import { Button } from '../base/Button.js'
import { useChatStore } from '../../services/chat/store.js'
import styles from './Welcome.module.css'

/** 新对话：问候语 + 输入框。桌面端居中；移动端输入框吸底 */
export const Welcome = ({ sessionId = null }: { sessionId?: string | null }) => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  const characterName = useChatStore((state) => sessionId === null ? undefined : state.sessionCache[sessionId]?.character?.name)
  return (
    <div className={styles.container}>
      {isMobile ? <MobileHeader sessionId={sessionId} /> : null}
      <div className={styles.welcome}>
        <div className={styles.intro}>
          <Logo size={72} />
          <h1 className={styles.greeting}>{characterName ?? t('welcomeMessageChat250808')}</h1>
          {sessionId === null ? <Button size="s" variant="outlined" onClick={openCharacters}>{t('characterChoose')}</Button> : null}
        </div>
        <ChatInput sessionId={sessionId} />
        <div className={styles.caveat} data-input-caveat="">{t('contentCaveat')}</div>
      </div>
    </div>
  )
}
