import clsx from 'clsx'
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { createPortal } from 'react-dom'
import { useAnchoredPosition, useDismiss } from './anchored.js'
import { IconCheckOutline16, IconChevronDownOutline14 } from './icons.js'
import styles from './Select.module.css'

export type SelectOption<T extends string> = { value: T; label: string; lang?: string }

/**
 * 胶囊形选择器：触发器高 36px、圆角 18px、浅灰底，下拉菜单选中项右侧打勾；
 * 点外部或 Esc 关闭。value 不匹配任何选项时触发器显示 placeholder。
 */
export const Select = <T extends string>({
  value,
  options,
  onChange,
  placeholder,
  ariaLabel,
  className,
  disabled = false,
  onLongPress,
}: {
  value: T
  options: SelectOption<T>[]
  onChange: (value: T) => void
  placeholder?: string
  ariaLabel?: string
  className?: string
  disabled?: boolean
  onLongPress?: (anchor: HTMLButtonElement) => void
}) => {
  const [open, setOpen] = useState(false)
  const longPressTimer = useRef<number | undefined>(undefined)
  const suppressClickTimer = useRef<number | undefined>(undefined)
  const pointerStart = useRef<{ id: number; x: number; y: number } | null>(null)
  const suppressNextClick = useRef(false)
  const onLongPressRef = useRef(onLongPress)
  onLongPressRef.current = onLongPress
  const current = options.find((option) => option.value === value)
  // 菜单贴右侧展开，最多 320px 高，超出在菜单内滚动
  const { anchorRef, floatingRef, position } = useAnchoredPosition<
    HTMLButtonElement,
    HTMLDivElement
  >(open, { align: 'end', maxHeight: 320, minSpace: 160 })
  // Esc 只关菜单，不让外层弹窗一起关闭
  useDismiss(open, [anchorRef, floatingRef], () => setOpen(false), { captureEscape: true })

  const cancelLongPress = () => {
    window.clearTimeout(longPressTimer.current)
    longPressTimer.current = undefined
    pointerStart.current = null
  }
  useEffect(() => () => {
    window.clearTimeout(longPressTimer.current)
    window.clearTimeout(suppressClickTimer.current)
  }, [])

  const startLongPress = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!onLongPress || disabled || !event.isPrimary || event.button !== 0) {
      return
    }
    const anchor = event.currentTarget
    cancelLongPress()
    window.clearTimeout(suppressClickTimer.current)
    suppressClickTimer.current = undefined
    suppressNextClick.current = false
    pointerStart.current = { id: event.pointerId, x: event.clientX, y: event.clientY }
    longPressTimer.current = window.setTimeout(() => {
      longPressTimer.current = undefined
      pointerStart.current = null
      suppressNextClick.current = true
      suppressClickTimer.current = window.setTimeout(() => {
        suppressNextClick.current = false
        suppressClickTimer.current = undefined
      }, 1000)
      onLongPressRef.current?.(anchor)
    }, 550)
  }

  const moveLongPress = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const start = pointerStart.current
    if (start?.id === event.pointerId &&
      (Math.abs(event.clientX - start.x) > 10 || Math.abs(event.clientY - start.y) > 10)) {
      cancelLongPress()
    }
  }

  const handleClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    if (suppressNextClick.current) {
      event.preventDefault()
      event.stopPropagation()
      suppressNextClick.current = false
      window.clearTimeout(suppressClickTimer.current)
      suppressClickTimer.current = undefined
      return
    }
    setOpen((value) => !value)
  }

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className={clsx(styles.trigger, open && styles.open, className)}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onPointerDown={startLongPress}
        onPointerMove={moveLongPress}
        onPointerUp={cancelLongPress}
        onPointerCancel={cancelLongPress}
        onPointerLeave={cancelLongPress}
        onContextMenu={(event) => {
          if (onLongPress) {
            event.preventDefault()
            onLongPress(event.currentTarget)
          }
        }}
        onKeyDown={(event) => {
          if (onLongPress && (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))) {
            event.preventDefault()
            onLongPress(event.currentTarget)
          }
        }}
        onClick={handleClick}
      >
        {current ? (
          <span lang={current.lang}>{current.label}</span>
        ) : (
          <span className={styles.placeholder}>{placeholder}</span>
        )}
        <span className={styles.arrow}>
          <IconChevronDownOutline14 />
        </span>
      </button>
      {open && !disabled
        ? createPortal(
            <div
              ref={floatingRef}
              className={styles.menu}
              style={position ?? undefined}
              role="listbox"
              aria-label={ariaLabel}
            >
              {options.map((option) => (
                <div
                  key={option.value}
                  role="option"
                  lang={option.lang}
                  aria-selected={option.value === value}
                  className={styles.option}
                  onClick={() => {
                    setOpen(false)
                    onChange(option.value)
                  }}
                >
                  <span>{option.label}</span>
                  {option.value === value ? <IconCheckOutline16 /> : null}
                </div>
              ))}
            </div>,
            document.body
          )
        : null}
    </>
  )
}
