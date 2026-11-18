import { create } from 'zustand'
import type { TtsVoice } from './api/speech.js'

export type Locale = 'zh-CN' | 'en-US'

/** 主题偏好；默认跟随系统 */
export type ThemePreference = 'light' | 'dark' | 'system'
export type ApiProtocol = 'deepseek' | 'openai'
export type ChatFont = 'system' | 'serif' | 'mono'
export type ChatFontSize = 'system' | 'small' | 'normal' | 'large' | 'extraLarge'

/** 本机设置，存 localStorage：API Key、语言、主题、朗读音色、深度思考与智能搜索开关、侧边栏收起状态 */
type Settings = {
  apiKey: string | null
  apiBaseUrl: string
  apiProtocol: ApiProtocol
  model: string
  models: string[]
  locale: Locale
  themePreference: ThemePreference
  chatFont: ChatFont
  chatFontSize: ChatFontSize
  ttsVoice: TtsVoice
  thinking: boolean
  thinkingCollapsed: boolean
  contextMemoryEnabled: boolean
  search: boolean
  siderCollapsed: boolean
  pinnedSessionIds: string[]
}

const KEYS = {
  apiKey: 'chat-demo:api-key',
  apiBaseUrl: 'deepstay:api-base-url',
  apiProtocol: 'deepstay:api-protocol',
  model: 'deepstay:model',
  models: 'deepstay:models',
  locale: 'chat-demo:locale',
  themePreference: 'chat-demo:theme-preference',
  chatFont: 'deepstay:chat-font',
  chatFontSize: 'deepstay:chat-font-size',
  ttsVoice: 'chat-demo:tts-voice',
  thinking: 'chat-demo:thinking',
  thinkingCollapsed: 'deepstay:thinking-collapsed',
  contextMemoryEnabled: 'deepstay:context-memory-enabled',
  search: 'chat-demo:search',
  siderCollapsed: 'chat-demo:sider-collapsed',
  pinnedSessionIds: 'deepstay:pinned-session-ids',
} as const

const read = (key: string) => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

const write = (key: string, value: string | null) => {
  try {
    if (value === null) {
      localStorage.removeItem(key)
    } else {
      localStorage.setItem(key, value)
    }
  } catch {
    // 存储不可用时只在内存中生效
  }
}

/** 初始界面语言跟随浏览器语言。 */
export const isChineseBrowser = (): boolean =>
  (typeof navigator === 'undefined' ? 'zh' : navigator.language).toLowerCase().startsWith('zh')

const initialLocale = (): Locale => {
  const saved = read(KEYS.locale)
  if (saved === 'zh-CN' || saved === 'en-US') {
    return saved
  }
  return isChineseBrowser() ? 'zh-CN' : 'en-US'
}

/** 未保存过时跟随系统 */
const initialThemePreference = (): ThemePreference => {
  const saved = read(KEYS.themePreference)
  return saved === 'light' || saved === 'dark' ? saved : 'system'
}

/** 未保存过时使用服务端默认音色 stella（海星） */
const initialTtsVoice = (): TtsVoice => (read(KEYS.ttsVoice) === 'tide' ? 'tide' : 'stella')

const initialChatFont = (): ChatFont => {
  const saved = read(KEYS.chatFont)
  return saved === 'serif' || saved === 'mono' ? saved : 'system'
}

const initialChatFontSize = (): ChatFontSize => {
  const saved = read(KEYS.chatFontSize)
  return saved === 'small' || saved === 'normal' || saved === 'large' || saved === 'extraLarge'
    ? saved
    : 'system'
}

const readStringList = (key: string): string[] => {
  try {
    const value: unknown = JSON.parse(read(key) ?? '[]')
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && !!item.trim()) : []
  } catch {
    return []
  }
}

export const useSettings = create<Settings>(() => ({
  apiKey: read(KEYS.apiKey),
  apiBaseUrl: read(KEYS.apiBaseUrl) || __API_ORIGIN__,
  apiProtocol: read(KEYS.apiProtocol) === 'openai' ? 'openai' : 'deepseek',
  model: read(KEYS.model) || 'deepseek-flash',
  models: readStringList(KEYS.models),
  locale: initialLocale(),
  themePreference: initialThemePreference(),
  chatFont: initialChatFont(),
  chatFontSize: initialChatFontSize(),
  ttsVoice: initialTtsVoice(),
  thinking: read(KEYS.thinking) === 'true',
  thinkingCollapsed: read(KEYS.thinkingCollapsed) === 'true',
  contextMemoryEnabled: read(KEYS.contextMemoryEnabled) === 'true',
  search: read(KEYS.search) === 'true',
  siderCollapsed: read(KEYS.siderCollapsed) === 'true',
  pinnedSessionIds: [...new Set(readStringList(KEYS.pinnedSessionIds))],
}))

export const setLocale = (locale: Locale) => {
  write(KEYS.locale, locale)
  useSettings.setState({ locale })
}

export const setThemePreference = (themePreference: ThemePreference) => {
  write(KEYS.themePreference, themePreference)
  useSettings.setState({ themePreference })
}

export const setTtsVoice = (ttsVoice: TtsVoice) => {
  write(KEYS.ttsVoice, ttsVoice)
  useSettings.setState({ ttsVoice })
}

export const setChatFont = (chatFont: ChatFont) => {
  write(KEYS.chatFont, chatFont)
  useSettings.setState({ chatFont })
}

export const setChatFontSize = (chatFontSize: ChatFontSize) => {
  write(KEYS.chatFontSize, chatFontSize)
  useSettings.setState({ chatFontSize })
}

export const setApiKey = (apiKey: string | null) => {
  write(KEYS.apiKey, apiKey)
  useSettings.setState({ apiKey })
}

export const setApiConnection = (connection: Pick<Settings, 'apiKey' | 'apiBaseUrl' | 'apiProtocol' | 'model' | 'models'>) => {
  write(KEYS.apiKey, connection.apiKey)
  write(KEYS.apiBaseUrl, connection.apiBaseUrl)
  write(KEYS.apiProtocol, connection.apiProtocol)
  write(KEYS.model, connection.model)
  write(KEYS.models, JSON.stringify(connection.models))
  useSettings.setState(connection)
}

export const setThinkingCollapsed = (thinkingCollapsed: boolean) => {
  write(KEYS.thinkingCollapsed, String(thinkingCollapsed))
  useSettings.setState({ thinkingCollapsed })
}

export const setContextMemoryEnabled = (contextMemoryEnabled: boolean) => {
  write(KEYS.contextMemoryEnabled, String(contextMemoryEnabled))
  useSettings.setState({ contextMemoryEnabled })
}

export const setThinking = (thinking: boolean) => {
  write(KEYS.thinking, String(thinking))
  useSettings.setState({ thinking })
}

export const setSearch = (search: boolean) => {
  write(KEYS.search, String(search))
  useSettings.setState({ search })
}

export const setSiderCollapsed = (siderCollapsed: boolean) => {
  write(KEYS.siderCollapsed, String(siderCollapsed))
  useSettings.setState({ siderCollapsed })
}

const savePinnedSessions = (pinnedSessionIds: string[]) => {
  write(KEYS.pinnedSessionIds, pinnedSessionIds.length ? JSON.stringify(pinnedSessionIds) : null)
  useSettings.setState({ pinnedSessionIds })
}

export const setPinnedSession = (id: string, pinned: boolean) => {
  const ids = useSettings.getState().pinnedSessionIds
  if (pinned === ids.includes(id)) {
    return
  }
  savePinnedSessions(pinned ? [id, ...ids] : ids.filter((value) => value !== id))
}

export const clearPinnedSessions = () => savePinnedSessions([])
