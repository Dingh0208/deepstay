import { useRef } from 'react'
import { useTranslate } from '../../i18n/index.js'

export const ConversationTitle = ({
  title,
  className,
  onJump,
}: {
  title: string
  className: string
  onJump: () => void
}) => {
  const t = useTranslate()
  const firstTap = useRef<number | null>(null)
  return (
    <button
      type="button"
      className={className}
      title={t('jumpToFirstMessage')}
      aria-label={t('jumpToFirstMessageLabel', { title })}
      onClick={(event) => {
        const now = performance.now()
        if (event.detail === 0 || (firstTap.current !== null && now - firstTap.current <= 400)) {
          firstTap.current = null
          onJump()
        } else {
          firstTap.current = now
        }
      }}
    >
      {title}
    </button>
  )
}
