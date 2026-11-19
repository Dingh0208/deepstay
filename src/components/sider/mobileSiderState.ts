import { useRef, type TouchEvent } from 'react'
import { create } from 'zustand'

/** 移动端侧边栏抽屉：顶栏按钮或从左侧右滑打开。 */
export const useMobileSider = create(() => ({ open: false }))

export const openMobileSider = () => useMobileSider.setState({ open: true })

export const closeMobileSider = () => useMobileSider.setState({ open: false })

export const useMobileSiderSwipe = (mobile: boolean) => {
  const start = useRef<{
    x: number
    y: number
    id: number
    closing: boolean
    width: number
    dragging: boolean
  } | null>(null)
  const clearGesture = (frame: HTMLElement) => {
    if (frame.hasAttribute('data-drawer-gesture')) {
      frame.removeAttribute('data-drawer-gesture')
      frame.style.removeProperty('--drawer-translate')
      frame.style.removeProperty('--drawer-opacity')
    }
  }
  const reset = (event: TouchEvent<HTMLElement>) => {
    start.current = null
    clearGesture(event.currentTarget)
  }

  return {
    onTouchStart: (event: TouchEvent<HTMLElement>) => {
      reset(event)
      const touch = event.touches[0]
      if (!mobile || event.touches.length !== 1 || !touch) {
        return
      }
      const target = event.target
      if (!(target instanceof Element) || target.closest('input, textarea, [contenteditable], pre, table, [role="dialog"]')) {
        return
      }
      const closing = useMobileSider.getState().open
      const left = event.currentTarget.getBoundingClientRect().left
      if (closing ? !target.closest('[data-mobile-drawer-layer]') :
        touch.clientX - left > 96 || target.closest('button, a')) {
        return
      }
      const width = event.currentTarget.querySelector('[data-mobile-drawer-panel]')?.clientWidth
      if (width) {
        start.current = { x: touch.clientX, y: touch.clientY, id: touch.identifier, closing, width, dragging: false }
      }
    },
    onTouchMove: (event: TouchEvent<HTMLElement>) => {
      if (event.touches.length !== 1) {
        reset(event)
        return
      }
      const touch = event.touches[0]
      const origin = start.current
      if (!origin || !touch || touch.identifier !== origin.id) {
        return
      }
      const dx = touch.clientX - origin.x
      const dy = Math.abs(touch.clientY - origin.y)
      const travel = origin.closing ? -dx : dx
      if (!origin.dragging) {
        if (travel < -16 || (dy > 18 && dy > Math.abs(dx)) || window.getSelection()?.isCollapsed === false) {
          reset(event)
          return
        }
        if (travel < 12 || travel < 1.5 * dy) {
          return
        }
        origin.dragging = true
      }
      const fraction = Math.min(1, Math.max(0, (origin.closing ? 1 : 0) + dx / origin.width))
      // Commit the inline drag position before the next render starts its snap transition.
      const frame = event.currentTarget
      frame.setAttribute('data-drawer-gesture', '')
      frame.style.setProperty('--drawer-translate', `${(fraction - 1) * 100}%`)
      frame.style.setProperty('--drawer-opacity', `${fraction}`)
    },
    onTouchEnd: (event: TouchEvent<HTMLElement>) => {
      const origin = start.current
      const touch = event.changedTouches[0]
      let committed = false
      if (mobile && origin && touch?.identifier === origin.id && window.getSelection()?.isCollapsed !== false) {
        const dx = touch.clientX - origin.x
        const travel = origin.closing ? -dx : dx
        if (travel >= 60 && (origin.dragging || travel >= 1.5 * Math.abs(touch.clientY - origin.y))) {
          event.currentTarget.querySelector('[data-mobile-drawer-panel]')?.getBoundingClientRect()
          useMobileSider.setState({ open: !origin.closing })
          committed = true
        }
      }
      start.current = null
      if (committed && event.currentTarget.hasAttribute('data-drawer-gesture')) {
        const frame = event.currentTarget
        setTimeout(() => {
          if (!start.current) {
            clearGesture(frame)
          }
        }, 0)
      } else {
        clearGesture(event.currentTarget)
      }
    },
    onTouchCancel: reset,
  }
}
