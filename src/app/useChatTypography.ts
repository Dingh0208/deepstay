import { Capacitor, registerPlugin } from '@capacitor/core'
import { useEffect } from 'react'
import { useSettings } from '../services/settings.js'

const device = registerPlugin<{ getFontScale(): Promise<{ scale: number }> }>('LocalFiles')
const sizes = { small: 0.875, normal: 1, large: 1.125, extraLarge: 1.25 }

export const useChatTypography = () => {
  const font = useSettings((state) => state.chatFont)
  const size = useSettings((state) => state.chatFontSize)

  useEffect(() => {
    document.documentElement.dataset.chatFont = font
  }, [font])

  useEffect(() => {
    const style = document.documentElement.style
    style.setProperty('--ds-chat-scale', String(size === 'system' ? 1 : sizes[size]))
    if (size !== 'system' || Capacitor.getPlatform() !== 'android') {
      return
    }

    let active = true
    const refresh = async () => {
      try {
        const { scale } = await device.getFontScale()
        if (active && Number.isFinite(scale) && scale > 0) {
          style.setProperty('--ds-chat-scale', String(scale))
        }
      } catch {
        // Older native shells use the standard text size.
      }
    }
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        void refresh()
      }
    }
    void refresh()
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      active = false
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [size])
}
