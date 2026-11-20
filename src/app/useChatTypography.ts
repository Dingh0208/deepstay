import { Capacitor, registerPlugin } from '@capacitor/core'
import { useEffect } from 'react'
import { getChatFontFamily, useSettings } from '../services/settings.js'

const device = registerPlugin<{
  getFontScale(): Promise<{ scale: number }>
  getSystemFontFamilyName(): Promise<{ familyName: string }>
}>('LocalFiles')
const sizes = { small: 0.875, normal: 1, large: 1.125, extraLarge: 1.25 }

export const useChatTypography = () => {
  const font = useSettings((state) => state.chatFont)
  const size = useSettings((state) => state.chatFontSize)

  useEffect(() => {
    const root = document.documentElement
    const style = root.style
    const fallback = getChatFontFamily(font)
    style.setProperty('--dsw-font-family', fallback)
    if (font !== 'system' || Capacitor.getPlatform() !== 'android') {
      return
    }

    let active = true
    const refreshSystemFont = async () => {
      try {
        const { familyName } = await device.getSystemFontFamilyName()
        if (active) {
          const family = familyName.trim()
          const quotedFamily = `"${family.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
          style.setProperty('--dsw-font-family', family ? `${quotedFamily}, ${fallback}` : fallback)
        }
      } catch {
        // Older native shells keep the CSS system font stack.
        if (active) {
          style.setProperty('--dsw-font-family', fallback)
        }
      }
    }
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        void refreshSystemFont()
      }
    }
    void refreshSystemFont()
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      active = false
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [font])

  useEffect(() => {
    const root = document.documentElement
    const style = root.style
    const applyScale = (scale: number) => {
      style.setProperty('--ds-ui-scale', String(scale))
      style.setProperty('--ds-chat-scale', '1')
    }
    applyScale(size === 'system' ? 1 : sizes[size])
    if (size !== 'system' || Capacitor.getPlatform() !== 'android') {
      return
    }

    let active = true
    const refresh = async () => {
      try {
        const { scale } = await device.getFontScale()
        if (active && Number.isFinite(scale) && scale > 0) {
          applyScale(scale)
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
