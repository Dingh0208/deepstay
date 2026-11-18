import { useRef, type TouchEvent } from 'react'
import { create } from 'zustand'

/** 移动端侧边栏抽屉：顶栏按钮或从左侧右滑打开。 */
export const useMobileSider = create(() => ({ open: false }))

export const openMobileSider = () => useMobileSider.setState({ open: true })

export const closeMobileSider = () => useMobileSider.setState({ open: false })

export const useMobileSiderSwipe = (mobile: boolean) => {
  const start = useRef<{ x: number; y: number; id: number } | null>(null)
  const reset = () => { start.current = null }

  return {
    onTouchStart: (event: TouchEvent<HTMLElement>) => {
      reset()
      const touch = event.touches[0]
      if (!mobile || event.touches.length !== 1 || !touch || useMobileSider.getState().open) {
        return
      }
      const left = event.currentTarget.getBoundingClientRect().left
      if (touch.clientX - left > 96 ||
          (event.target instanceof Element &&
            event.target.closest('button, a, input, textarea, [contenteditable], pre, table, [role="dialog"]'))) {
        return
      }
      start.current = { x: touch.clientX, y: touch.clientY, id: touch.identifier }
    },
    onTouchMove: (event: TouchEvent<HTMLElement>) => {
      const touch = event.touches[0]
      if (!start.current || !touch || touch.identifier !== start.current.id) {
        return
      }
      const dx = touch.clientX - start.current.x
      const dy = Math.abs(touch.clientY - start.current.y)
      if (dx < -16 || (dy > 18 && dy > Math.abs(dx))) {
        reset()
      }
    },
    onTouchEnd: (event: TouchEvent<HTMLElement>) => {
      const origin = start.current
      reset()
      const touch = event.changedTouches[0]
      if (!mobile || !origin || !touch || touch.identifier !== origin.id ||
          window.getSelection()?.isCollapsed === false) {
        return
      }
      const dx = touch.clientX - origin.x
      if (dx >= 60 && dx >= 1.5 * Math.abs(touch.clientY - origin.y)) {
        openMobileSider()
      }
    },
    onTouchCancel: reset,
  }
}
