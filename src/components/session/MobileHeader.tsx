import { IconMenuOutline20, IconNewChatOutline20 } from '../base/icons.js'
import { IconMicOutline16 } from '../base/icons.js'
import { useTranslate } from '../../i18n/index.js'
import { newChat } from '../../services/chat/store.js'
import { IconButton } from '../base/IconButton.js'
import { openMobileSider } from '../sider/mobileSiderState.js'
import { ConversationTitle } from './ConversationTitle.js'
import { startVoiceCall } from '../../services/speech/voiceCall.js'
import styles from './MobileHeader.module.css'

/** 移动端顶栏：左侧菜单打开侧边栏；会话页再显示标题与开启新对话 */
export const MobileHeader = (props: { title?: undefined; sessionId?: string | null } | { title: string; onJumpToFirst: () => void; sessionId?: string | null }) => {
  const t = useTranslate()
  return (
    <div className={styles.header} data-mobile-chat-header="">
      <IconButton
        size="xl"
        tone="primary"
        icon={<IconMenuOutline20 />}
        aria-label={t('expandSiderbarButton')}
        onClick={openMobileSider}
      />
      {props.title === undefined ? null : (
        <>
          <ConversationTitle title={props.title} className={styles.title} onJump={props.onJumpToFirst} />
          <IconButton
            size="xl"
            tone="primary"
            icon={<IconMicOutline16 />}
            tooltip={t('voiceCallTitle')}
            onClick={() => void startVoiceCall(props.sessionId ?? null)}
          />
          <IconButton
            size="xl"
            tone="primary"
            icon={<IconNewChatOutline20 />}
            aria-label={t('newChat')}
            onClick={newChat}
          />
        </>
      )}
      {props.title === undefined ? <IconButton
        size="xl"
        tone="primary"
        icon={<IconMicOutline16 />}
        tooltip={t('voiceCallTitle')}
        onClick={() => void startVoiceCall(props.sessionId ?? null)}
      /> : null}
    </div>
  )
}
