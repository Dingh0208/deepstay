import { Capacitor } from '@capacitor/core'

/** Only finite version numbers and known platform names may enter an exported report. */
export const diagnosticEnvironment = () => {
  const version = typeof document === 'undefined' ? ''
    : document.querySelector<HTMLMetaElement>('meta[name="application-version"]')?.content ?? ''
  const platform = Capacitor.getPlatform()
  const userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent
  const chrome = /(?:Chrome|Chromium)\/(\d{1,4})(?:\.|\s|$)/.exec(userAgent)
  const android = /Android (\d{1,3})(?:[.;\s]|$)/.exec(userAgent)
  return {
    ...(/^\d+\.\d+\.\d+(?:-[\da-z.-]+)?$/i.test(version) && version.length <= 64 ? { version } : {}),
    ...(['android', 'ios', 'web'].includes(platform) ? { platform } : {}),
    ...(chrome && Number(chrome[1]) > 0 ? {
      chromiumMajor: Number(chrome[1]),
      ...(platform === 'android' && /; wv\)/.test(userAgent) ? { webView: true } : {}),
    } : {}),
    ...(android && Number(android[1]) > 0 ? { androidMajor: Number(android[1]) } : {}),
  }
}
