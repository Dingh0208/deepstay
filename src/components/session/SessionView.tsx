import clsx from 'clsx'
import { useState } from 'react'
import { useIsMobile } from '../../app/viewport.js'
import { useTranslate } from '../../i18n/index.js'
import type { Session } from '../../services/chat/types.js'
import { ChatInput } from '../chatInput/ChatInput.js'
import { MessageList } from '../messages/MessageList.js'
import { ConversationTitle } from './ConversationTitle.js'
import { MobileHeader } from './MobileHeader.js'
import { Welcome } from './Welcome.js'
import { IconMicOutline16 } from '../base/icons.js'
import { IconButton } from '../base/IconButton.js'
import { startVoiceCall } from '../../services/speech/voiceCall.js'
import styles from './SessionView.module.css'

/** 会话页：标题栏（移动端为顶栏）+ 消息列表，输入框吸底 */
export const SessionView = ({
  session,
  streaming,
  siderCollapsed,
}: {
  session: Session
  streaming: boolean
  siderCollapsed: boolean
}) => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  const [jumpRequest, setJumpRequest] = useState(0)
  const jumpToFirst = () => setJumpRequest((value) => value + 1)
  const title = session.title || t('untitledChat')
  if (session.messages.length === 0) {
    return <Welcome sessionId={session.id} />
  }
  return (
    <div className={styles.view}>
      {isMobile ? (
        <MobileHeader title={title} onJumpToFirst={jumpToFirst} sessionId={session.id} />
      ) : (
        <div className={styles.header}>
          <ConversationTitle
            key={session.id}
            title={title}
            className={clsx(styles.title, siderCollapsed && styles.withCollapsedSider)}
            onJump={jumpToFirst}
          />
          <IconButton size="xl" tone="primary" icon={<IconMicOutline16 />}
            tooltip={t('voiceCallTitle')} onClick={() => void startVoiceCall(session.id)} />
        </div>
      )}
      <MessageList
        session={session}
        streaming={streaming}
        jumpRequest={jumpRequest}
        footer={(latestReply) => (
          <div className={styles.inputContainer}>
            <ChatInput sessionId={session.id} latestReply={latestReply} />
            <div className={styles.caveat} data-input-caveat="">{t('contentCaveat')}</div>
          </div>
        )}
      />
    </div>
  )
}
