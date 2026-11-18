import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { useTranslate } from '../../i18n/index.js'
import { copyText } from '../../utils/clipboard.js'
import { useDismiss, VIEWPORT_PADDING } from '../base/anchored.js'
import { IconCopyOutline16, IconEditOutline16, IconRefreshOutline16 } from '../base/icons.js'
import { showToast } from '../base/toastState.js'
import styles from './MessageActions.module.css'

type Point = { x: number; y: number }
const INTERACTIVE =
  'a, button, input, textarea, select, [role="button"], [contenteditable], pre, table, img'

export const MessageActions = ({
  children,
  className,
  text,
  onEdit,
  onRegenerate,
}: {
  children: ReactNode
  className?: string
  text?: string
  onEdit?: () => void
  onRegenerate?: () => void
}) => {
  const t = useTranslate()
  const [point, setPoint] = useState<Point | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const hold = useRef<(Point & { pointerId: number }) | null>(null)
  const timer = useRef(0)
  const close = () => setPoint(null)
  useDismiss(point !== null, [menuRef], close)
  useEffect(() => () => window.clearTimeout(timer.current), [])

  useLayoutEffect(() => {
    const menu = menuRef.current
    if (!point || !menu) {
      return
    }
    const place = () => {
      const { offsetWidth: width, offsetHeight: height } = menu
      const left = Math.max(
        VIEWPORT_PADDING,
        Math.min(point.x - width / 2, innerWidth - width - VIEWPORT_PADDING)
      )
      const top = point.y - height - 12 < VIEWPORT_PADDING ? point.y + 12 : point.y - height - 12
      menu.style.left = `${left}px`
      menu.style.top = `${Math.max(VIEWPORT_PADDING, Math.min(top, innerHeight - height - VIEWPORT_PADDING))}px`
    }
    place()
    menu.querySelector('button')?.focus({ preventScroll: true })
    window.addEventListener('resize', place)
    window.addEventListener('scroll', close, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', close, true)
    }
  }, [point])

  const cancelHold = () => {
    window.clearTimeout(timer.current)
    hold.current = null
  }
  const startHold = (event: PointerEvent<HTMLDivElement>) => {
    cancelHold()
    const { pointerType } = event.nativeEvent
    const touch = pointerType === 'touch' ||
      (!pointerType && navigator.maxTouchPoints > 0)
    if (
      !(text || onEdit || onRegenerate) ||
      !touch ||
      !event.isPrimary ||
      (event.target instanceof Element && event.target.closest(INTERACTIVE))
    ) {
      return
    }
    const target = { x: event.clientX, y: event.clientY, pointerId: event.pointerId }
    hold.current = target
    timer.current = window.setTimeout(() => setPoint(target), 500)
  }
  const select = (callback: () => void) => {
    close()
    callback()
  }

  return (
    <>
      <div
        className={className}
        onPointerDown={startHold}
        onPointerMove={(event) => {
          const start = hold.current
          if (
            start?.pointerId === event.pointerId &&
            Math.hypot(event.clientX - start.x, event.clientY - start.y) > 10
          ) {
            cancelHold()
          }
        }}
        onPointerUp={cancelHold}
        onPointerCancel={cancelHold}
        onContextMenu={(event) => {
          if (hold.current) {
            event.preventDefault()
            window.clearTimeout(timer.current)
            setPoint(hold.current)
          }
        }}
      >
        {children}
      </div>
      {point
        ? createPortal(
            <div
              ref={menuRef}
              className={styles.actions}
              role="group"
              aria-label={t('messageActions')}
            >
              {text ? (
                <button
                  type="button"
                  onClick={() =>
                    select(async () => {
                      showToast({ key: (await copyText(text)) ? 'copied' : 'copyFailed' })
                    })
                  }
                >
                  <IconCopyOutline16 /> {t('copy')}
                </button>
              ) : null}
              {onEdit ? (
                <button type="button" onClick={() => select(onEdit)}>
                  <IconEditOutline16 /> {t('editMessage')}
                </button>
              ) : null}
              {onRegenerate ? (
                <button type="button" onClick={() => select(onRegenerate)}>
                  <IconRefreshOutline16 /> {t('regenerate')}
                </button>
              ) : null}
            </div>,
            document.body
          )
        : null}
    </>
  )
}
