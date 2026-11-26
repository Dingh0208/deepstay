import { create } from 'zustand'
import type { TtsVoice } from './api/speech.js'
import { reasoningEffortLevels, type ReasoningEffort } from './api/types.js'
import { normalizeGeneration, type GenerationSettings } from './api/generation.js'
import { apiEndpoint, normalizeApiBaseUrl } from './api/endpoints.js'

export type Locale = 'zh-CN' | 'en-US'

/** 主题偏好；默认跟随系统 */
export type ThemePreference = 'light' | 'dark' | 'system'
export type ApiProtocol = 'deepseek' | 'openai'
export type VoiceCallPause = 'short' | 'normal' | 'patient'
export const DEFAULT_DEEPSEEK_SEARCH_API_BASE_URL = 'https://api.deepseek.com/v1/tools'
export const bundledChatFonts = [
  { value: 'noto-sans-sc', label: 'Noto Sans SC' },
  { value: 'noto-serif-sc', label: 'Noto Serif SC' },
  { value: 'ma-shan-zheng', label: 'Ma Shan Zheng' },
  { value: 'dm-sans', label: 'DM Sans' },
  { value: 'inter', label: 'Inter' },
  { value: 'lato', label: 'Lato' },
  { value: 'lora', label: 'Lora' },
  { value: 'manrope', label: 'Manrope' },
  { value: 'montserrat', label: 'Montserrat' },
  { value: 'nunito', label: 'Nunito' },
  { value: 'open-sans', label: 'Open Sans' },
  { value: 'oswald', label: 'Oswald' },
  { value: 'pt-sans', label: 'PT Sans' },
  { value: 'roboto', label: 'Roboto' },
  { value: 'raleway', label: 'Raleway' },
  { value: 'rubik', label: 'Rubik' },
  { value: 'source-sans-3', label: 'Source Sans 3' },
  { value: 'ubuntu', label: 'Ubuntu' },
  { value: 'work-sans', label: 'Work Sans' },
  { value: 'fira-sans', label: 'Fira Sans' },
  { value: 'ibm-plex-sans', label: 'IBM Plex Sans' },
  { value: 'noto-serif', label: 'Noto Serif' },
  { value: 'pt-serif', label: 'PT Serif' },
  { value: 'merriweather', label: 'Merriweather' },
  { value: 'libre-baskerville', label: 'Libre Baskerville' },
  { value: 'bitter', label: 'Bitter' },
  { value: 'crimson-text', label: 'Crimson Text' },
] as const

export type ChatFont = 'system' | 'serif' | 'mono' | typeof bundledChatFonts[number]['value']
export type ChatFontSize = 'system' | 'small' | 'normal' | 'large' | 'extraLarge'

export const getChatFontFamily = (font: ChatFont): string => {
  if (font === 'serif') {
    return "'Noto Serif SC', 'Songti SC', SimSun, Georgia, serif"
  }
  if (font === 'mono') {
    return 'ui-monospace, Consolas, "Roboto Mono", monospace'
  }
  const selected = bundledChatFonts.find((item) => item.value === font)
  return selected
    ? `"${selected.label}", 'Noto Sans SC', 'Microsoft YaHei', system-ui, sans-serif`
    : "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Open Sans', 'Helvetica Neue', sans-serif"
}

/** 本机设置，存 localStorage：API Key、语言、主题、朗读音色、深度思考与智能搜索开关、侧边栏收起状态 */
type Settings = {
  apiKey: string | null
  apiBaseUrl: string
  apiProtocol: ApiProtocol
  model: string
  models: string[]
  modelReasoningProfiles: Record<string, ModelReasoningProfile>
  modelPresets: ModelPreset[]
  activeModelPresetId: string | null
  locale: Locale
  themePreference: ThemePreference
  chatFont: ChatFont
  chatFontSize: ChatFontSize
  ttsVoice: TtsVoice
  thinking: boolean
  thinkingCollapsed: boolean
  contextMemoryEnabled: boolean
  autoReadAloud: boolean
  showReplyTokenUsage: boolean
  voiceCallBargeIn: boolean
  voiceCallPause: VoiceCallPause
  voiceCallSpeaker: boolean
  generation: GenerationSettings
  search: boolean
  siderCollapsed: boolean
  pinnedSessionIds: string[]
  favoriteMessages: FavoriteMessage[]
}

export type ModelReasoningProfile = {
  supportedLevels: ReasoningEffort[]
  defaultLevel?: ReasoningEffort
  selectedLevel?: ReasoningEffort
  visibleLevels?: ReasoningEffort[]
}

export type ModelPreset = {
  id: string
  name: string
  apiKey: string
  apiBaseUrl: string
  apiProtocol: ApiProtocol
  model: string
  models: string[]
  searchApi?: {
    apiKey: string
    baseUrl: string
    count: number
  }
}

export type FavoriteMessage = { sessionId: string; messageId: string }
export const favoriteMessageKey = ({ sessionId, messageId }: FavoriteMessage) => JSON.stringify([sessionId, messageId])

const KEYS = {
  apiKey: 'chat-demo:api-key',
  apiBaseUrl: 'deepstay:api-base-url',
  apiProtocol: 'deepstay:api-protocol',
  model: 'deepstay:model',
  models: 'deepstay:models',
  modelReasoningProfiles: 'deepstay:model-reasoning-profiles',
  modelPresets: 'deepstay:model-presets',
  activeModelPresetId: 'deepstay:active-model-preset-id',
  locale: 'chat-demo:locale',
  themePreference: 'chat-demo:theme-preference',
  chatFont: 'deepstay:chat-font',
  chatFontSize: 'deepstay:chat-font-size',
  ttsVoice: 'chat-demo:tts-voice',
  thinking: 'chat-demo:thinking',
  thinkingCollapsed: 'deepstay:thinking-collapsed',
  contextMemoryEnabled: 'deepstay:context-memory-enabled',
  autoReadAloud: 'deepstay:auto-read-aloud',
  showReplyTokenUsage: 'deepstay:show-reply-token-usage',
  voiceCallBargeIn: 'deepstay:voice-call-barge-in',
  voiceCallPause: 'deepstay:voice-call-pause',
  voiceCallSpeaker: 'deepstay:voice-call-speaker',
  generation: 'deepstay:generation',
  modelContextWindows: 'deepstay:model-context-windows',
  search: 'chat-demo:search',
  siderCollapsed: 'chat-demo:sider-collapsed',
  pinnedSessionIds: 'deepstay:pinned-session-ids',
  favoriteMessages: 'deepstay:favorite-messages',
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
    return true
  } catch {
    // 存储不可用时只在内存中生效
    return false
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
  return saved === 'serif' || saved === 'mono' || bundledChatFonts.some((font) => font.value === saved)
    ? saved as ChatFont
    : 'system'
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

const readModelPresets = (): ModelPreset[] => {
  try {
    const value: unknown = JSON.parse(read(KEYS.modelPresets) ?? '[]')
    if (!Array.isArray(value)) {
      return []
    }
    return value.flatMap((entry): ModelPreset[] => {
      if (!entry || typeof entry !== 'object') {
        return []
      }
      const preset = entry as Record<string, unknown>
      const name = typeof preset.name === 'string' ? preset.name.trim().slice(0, 64) : ''
      const apiKey = typeof preset.apiKey === 'string' ? preset.apiKey.trim() : ''
      const baseUrl = typeof preset.apiBaseUrl === 'string' ? preset.apiBaseUrl : ''
      const apiProtocol = preset.apiProtocol
      const model = typeof preset.model === 'string' ? preset.model.trim() : ''
      const models = Array.isArray(preset.models)
        ? [...new Set(preset.models.filter((item): item is string => typeof item === 'string' && !!item.trim()))]
        : []
      const searchApi = preset.searchApi && typeof preset.searchApi === 'object'
        ? preset.searchApi as Record<string, unknown>
        : undefined
      let parsedSearchApi: ModelPreset['searchApi']
      if (searchApi) {
        const searchBaseUrl = typeof searchApi.baseUrl === 'string' && searchApi.baseUrl.trim()
          ? searchApi.baseUrl
          : DEFAULT_DEEPSEEK_SEARCH_API_BASE_URL
        let normalizedSearchBaseUrl = searchBaseUrl
        try {
          normalizedSearchBaseUrl = normalizeApiBaseUrl(searchBaseUrl)
        } catch {
          // Preserve invalid values so users can correct them in the settings form.
        }
        parsedSearchApi = {
          apiKey: typeof searchApi.apiKey === 'string' ? searchApi.apiKey.trim() : '',
          baseUrl: normalizedSearchBaseUrl,
          count: typeof searchApi.count === 'number' && Number.isInteger(searchApi.count)
            ? Math.max(1, Math.min(50, searchApi.count))
            : 10,
        }
      }
      if (typeof preset.id !== 'string' || !preset.id || !name || !apiKey || !baseUrl ||
          (apiProtocol !== 'deepseek' && apiProtocol !== 'openai') || !model) {
        return []
      }
      try {
        return [{ id: preset.id, name, apiKey, apiBaseUrl: normalizeApiBaseUrl(baseUrl), apiProtocol, model, models,
          ...(parsedSearchApi ? { searchApi: parsedSearchApi } : {}) }]
      } catch {
        return []
      }
    })
  } catch {
    return []
  }
}

const saveModelPresets = (modelPresets: ModelPreset[]) => {
  write(KEYS.modelPresets, modelPresets.length ? JSON.stringify(modelPresets) : null)
  useSettings.setState({ modelPresets })
}

const initialGeneration = () => {
  try {
    return normalizeGeneration(JSON.parse(read(KEYS.generation) ?? '{}'))
  } catch {
    return {}
  }
}

type ModelRoute = Pick<Settings, 'apiBaseUrl' | 'apiProtocol' | 'model'>

const contextWindowKey = ({ apiBaseUrl, apiProtocol, model }: ModelRoute) => {
  let endpoint = apiBaseUrl
  try {
    endpoint = apiEndpoint(apiBaseUrl, apiProtocol === 'openai' ? 'v1/chat/completions' : 'anthropic/v1/messages')
  } catch {
    // Keep a previously saved invalid connection editable in settings.
  }
  return JSON.stringify([apiProtocol, endpoint, model])
}

const reasoningProfileKey = (route: ModelRoute, model = route.model) =>
  contextWindowKey({ ...route, model })

const readModelReasoningProfiles = (): Record<string, ModelReasoningProfile> => {
  try {
    const value: unknown = JSON.parse(read(KEYS.modelReasoningProfiles) ?? '{}')
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return {}
    }
    const isReasoningEffort = (level: unknown): level is ReasoningEffort =>
      typeof level === 'string' && (reasoningEffortLevels as readonly string[]).includes(level)
    return Object.fromEntries(Object.entries(value).flatMap(([key, entry]) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        return []
      }
      const profile = entry as Record<string, unknown>
      const supportedLevels = Array.isArray(profile.supportedLevels)
        ? [...new Set(profile.supportedLevels.filter(isReasoningEffort))]
        : []
      if (supportedLevels.length === 0) {
        return []
      }
      const visibleLevels = Array.isArray(profile.visibleLevels)
        ? [...new Set(profile.visibleLevels.filter((level): level is ReasoningEffort => isReasoningEffort(level) && supportedLevels.includes(level)))]
        : undefined
      const defaultLevel = isReasoningEffort(profile.defaultLevel) && supportedLevels.includes(profile.defaultLevel)
        ? profile.defaultLevel as ReasoningEffort : undefined
      const selectedLevel = isReasoningEffort(profile.selectedLevel) && supportedLevels.includes(profile.selectedLevel)
        ? profile.selectedLevel as ReasoningEffort : undefined
      return [[key, { supportedLevels, ...(defaultLevel ? { defaultLevel } : {}), ...(selectedLevel ? { selectedLevel } : {}), ...(visibleLevels ? { visibleLevels } : {}) }]]
    }))
  } catch {
    return {}
  }
}

const saveModelReasoningProfiles = (profiles: Record<string, ModelReasoningProfile>) =>
  write(KEYS.modelReasoningProfiles, Object.keys(profiles).length ? JSON.stringify(profiles) : null)

const readModelContextWindows = (): Map<string, number> => {
  try {
    const raw: unknown = JSON.parse(read(KEYS.modelContextWindows) ?? '{}')
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      return new Map(Object.entries(raw).flatMap(([key, value]) => {
        const tokens = normalizeGeneration({ contextTokens: value }).contextTokens
        return tokens === undefined ? [] : [[key, tokens] as const]
      }))
    }
  } catch {
    // Invalid preferences use the default context window.
  }
  return new Map()
}

const modelContextWindows = readModelContextWindows()
const saveModelContextWindows = () => write(KEYS.modelContextWindows,
  modelContextWindows.size ? JSON.stringify(Object.fromEntries(modelContextWindows)) : null)

const generationForRoute = (generation: GenerationSettings, route: ModelRoute): GenerationSettings => {
  const next = { ...generation }
  delete next.contextTokens
  const contextTokens = modelContextWindows.get(contextWindowKey(route))
  return contextTokens === undefined ? next : { ...next, contextTokens }
}

const initialRoute: ModelRoute = {
  apiBaseUrl: read(KEYS.apiBaseUrl) || __API_ORIGIN__,
  apiProtocol: read(KEYS.apiProtocol) === 'openai' ? 'openai' : 'deepseek',
  model: read(KEYS.model) || 'deepseek-flash',
}
const initialModelPresets = readModelPresets()
const storedActiveModelPresetId = read(KEYS.activeModelPresetId)
const savedGeneration = initialGeneration()
if (savedGeneration.contextTokens !== undefined) {
  const key = contextWindowKey(initialRoute)
  if (!modelContextWindows.has(key)) {
    modelContextWindows.set(key, savedGeneration.contextTokens)
  }
  const migrated = saveModelContextWindows()
  delete savedGeneration.contextTokens
  if (migrated) {
    write(KEYS.generation, Object.keys(savedGeneration).length ? JSON.stringify(savedGeneration) : null)
  }
}

const readFavoriteMessages = (): FavoriteMessage[] => {
  try {
    const value: unknown = JSON.parse(read(KEYS.favoriteMessages) ?? '[]')
    if (Array.isArray(value)) {
      const valid = value.filter((entry): entry is FavoriteMessage =>
        !!entry && typeof entry.sessionId === 'string' && !!entry.sessionId &&
        typeof entry.messageId === 'string' && !!entry.messageId)
      return [...new Map(valid.map((entry) => [favoriteMessageKey(entry), entry])).values()]
    }
  } catch {
    // Invalid preference is treated as empty.
  }
  return []
}

export const useSettings = create<Settings>(() => ({
  apiKey: read(KEYS.apiKey),
  ...initialRoute,
  models: readStringList(KEYS.models),
  modelReasoningProfiles: readModelReasoningProfiles(),
  modelPresets: initialModelPresets,
  activeModelPresetId: initialModelPresets.some((preset) => preset.id === storedActiveModelPresetId)
    ? storedActiveModelPresetId
    : null,
  locale: initialLocale(),
  themePreference: initialThemePreference(),
  chatFont: initialChatFont(),
  chatFontSize: initialChatFontSize(),
  ttsVoice: initialTtsVoice(),
  thinking: read(KEYS.thinking) === 'true',
  thinkingCollapsed: read(KEYS.thinkingCollapsed) === 'true',
  contextMemoryEnabled: read(KEYS.contextMemoryEnabled) === 'true',
  autoReadAloud: read(KEYS.autoReadAloud) === 'true',
  showReplyTokenUsage: read(KEYS.showReplyTokenUsage) === 'true',
  voiceCallBargeIn: read(KEYS.voiceCallBargeIn) !== 'false',
  voiceCallPause: read(KEYS.voiceCallPause) === 'short' || read(KEYS.voiceCallPause) === 'patient'
    ? read(KEYS.voiceCallPause) as VoiceCallPause : 'normal',
  voiceCallSpeaker: read(KEYS.voiceCallSpeaker) !== 'false',
  generation: generationForRoute(savedGeneration, initialRoute),
  search: read(KEYS.search) === 'true',
  siderCollapsed: read(KEYS.siderCollapsed) === 'true',
  pinnedSessionIds: [...new Set(readStringList(KEYS.pinnedSessionIds))],
  favoriteMessages: readFavoriteMessages(),
}))

const presetMatchesRoute = (
  preset: ModelPreset,
  route: Pick<Settings, 'apiKey' | 'apiBaseUrl' | 'apiProtocol' | 'model'>
) => preset.apiKey === route.apiKey && preset.apiBaseUrl === route.apiBaseUrl &&
  preset.apiProtocol === route.apiProtocol && preset.model === route.model

export const getActiveModelPreset = (
  state: Settings = useSettings.getState()
): ModelPreset | undefined => {
  const active = state.modelPresets.find((preset) => preset.id === state.activeModelPresetId)
  if (active && presetMatchesRoute(active, state)) {
    return active
  }
  return state.modelPresets.find((preset) => presetMatchesRoute(preset, state))
}

export const getActiveSearchApi = (
  state: Settings = useSettings.getState()
): ModelPreset['searchApi'] => getActiveModelPreset(state)?.searchApi

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
  const current = useSettings.getState()
  const route = { ...current, ...connection }
  const matchingPreset = current.modelPresets.find((preset) =>
    preset.id === current.activeModelPresetId && presetMatchesRoute(preset, route)
  ) ?? current.modelPresets.find((preset) => presetMatchesRoute(preset, route))
  write(KEYS.activeModelPresetId, matchingPreset?.id ?? null)
  useSettings.setState({ ...connection, activeModelPresetId: matchingPreset?.id ?? null,
    generation: generationForRoute(current.generation, connection) })
}

export const getModelReasoningProfile = (
  route: ModelRoute,
  model = route.model,
  profiles = useSettings.getState().modelReasoningProfiles
): ModelReasoningProfile => profiles[reasoningProfileKey(route, model)] ?? { supportedLevels: [] }

export const setModelReasoningProfile = (
  route: ModelRoute,
  model: string,
  update: { supportedLevels: ReasoningEffort[]; defaultLevel?: ReasoningEffort }
) => {
  let profiles = { ...useSettings.getState().modelReasoningProfiles }
  const key = reasoningProfileKey(route, model)
  const previous = profiles[key]
  const supportedLevels = [...new Set(update.supportedLevels.filter((level) => reasoningEffortLevels.includes(level)))]
  if (supportedLevels.length === 0) {
    profiles = Object.fromEntries(Object.entries(profiles).filter(([profileKey]) => profileKey !== key))
  } else {
    const defaultLevel = update.defaultLevel && supportedLevels.includes(update.defaultLevel) ? update.defaultLevel : undefined
    const selectedLevel = previous?.selectedLevel && supportedLevels.includes(previous.selectedLevel) ? previous.selectedLevel : undefined
    profiles[key] = {
      supportedLevels,
      ...(defaultLevel ? { defaultLevel } : {}),
      ...(selectedLevel ? { selectedLevel } : {}),
      ...(previous?.visibleLevels ? { visibleLevels: previous.visibleLevels.filter((level) => supportedLevels.includes(level)) } : {}),
    }
  }
  saveModelReasoningProfiles(profiles)
  useSettings.setState({ modelReasoningProfiles: profiles })
}

export const setModelReasoningEffort = (route: ModelRoute, model: string, selectedLevel: ReasoningEffort | undefined) => {
  const profiles = { ...useSettings.getState().modelReasoningProfiles }
  const key = reasoningProfileKey(route, model)
  const current = profiles[key] ?? { supportedLevels: [...reasoningEffortLevels], visibleLevels: ['low', 'high', 'max'] as ReasoningEffort[] }
  if (selectedLevel !== undefined && !current.supportedLevels.includes(selectedLevel)) {
    return
  }
  profiles[key] = { ...current, selectedLevel }
  saveModelReasoningProfiles(profiles)
  useSettings.setState({ modelReasoningProfiles: profiles })
}

export const setModelVisibleReasoningLevels = (route: ModelRoute, model: string, visibleLevels: ReasoningEffort[]) => {
  const profiles = { ...useSettings.getState().modelReasoningProfiles }
  const key = reasoningProfileKey(route, model)
  const current = profiles[key] ?? { supportedLevels: [...reasoningEffortLevels], visibleLevels: ['low', 'high', 'max'] as ReasoningEffort[] }
  const visible = [...new Set(visibleLevels.filter((level) => current.supportedLevels.includes(level)))]
  if (visible.length === 0) {
    return
  }
  profiles[key] = {
    ...current,
    visibleLevels: visible,
    ...(current.selectedLevel && !visible.includes(current.selectedLevel) ? { selectedLevel: visible[0] } : {}),
  }
  saveModelReasoningProfiles(profiles)
  useSettings.setState({ modelReasoningProfiles: profiles })
}

export const saveModelPreset = (value: Omit<ModelPreset, 'id'>, id?: string) => {
  const existing = useSettings.getState().modelPresets
  if (value.searchApi && (!Number.isInteger(value.searchApi.count) || value.searchApi.count < 1 || value.searchApi.count > 50)) {
    throw new Error('Search result count must be between 1 and 50')
  }
  const presetId = id && existing.some((preset) => preset.id === id)
    ? id
    : typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`
  const preset: ModelPreset = {
    ...value,
    id: presetId,
    name: value.name.trim().slice(0, 64),
    apiKey: value.apiKey.trim(),
    apiBaseUrl: normalizeApiBaseUrl(value.apiBaseUrl),
    model: value.model.trim(),
    models: [...new Set(value.models.filter(Boolean))],
    ...(value.searchApi ? { searchApi: {
      apiKey: value.searchApi.apiKey.trim(),
      baseUrl: normalizeApiBaseUrl(value.searchApi.baseUrl || DEFAULT_DEEPSEEK_SEARCH_API_BASE_URL),
      count: value.searchApi.count,
    } } : {}),
  }
  saveModelPresets([preset, ...existing.filter((entry) => entry.id !== presetId)])
  return presetId
}

export const deleteModelPreset = (id: string) => {
  const presets = useSettings.getState().modelPresets
  if (presets.some((preset) => preset.id === id)) {
    saveModelPresets(presets.filter((preset) => preset.id !== id))
    if (useSettings.getState().activeModelPresetId === id) {
      write(KEYS.activeModelPresetId, null)
      useSettings.setState({ activeModelPresetId: null })
    }
  }
}

export const applyModelPreset = (id: string) => {
  const preset = useSettings.getState().modelPresets.find((entry) => entry.id === id)
  if (!preset) {
    return false
  }
  setApiConnection({
    apiKey: preset.apiKey,
    apiBaseUrl: preset.apiBaseUrl,
    apiProtocol: preset.apiProtocol,
    model: preset.model,
    models: preset.models,
  })
  write(KEYS.activeModelPresetId, id)
  useSettings.setState({ activeModelPresetId: id })
  return true
}

export const setModel = (model: string) => {
  write(KEYS.model, model)
  const current = useSettings.getState()
  const route = { ...current, model }
  const matchingPreset = current.modelPresets.find((preset) =>
    preset.id === current.activeModelPresetId && presetMatchesRoute(preset, route)
  ) ?? current.modelPresets.find((preset) => presetMatchesRoute(preset, route))
  write(KEYS.activeModelPresetId, matchingPreset?.id ?? null)
  useSettings.setState({ model, activeModelPresetId: matchingPreset?.id ?? null,
    generation: generationForRoute(current.generation, route) })
}

export const setThinkingCollapsed = (thinkingCollapsed: boolean) => {
  write(KEYS.thinkingCollapsed, String(thinkingCollapsed))
  useSettings.setState({ thinkingCollapsed })
}

export const setContextMemoryEnabled = (contextMemoryEnabled: boolean) => {
  write(KEYS.contextMemoryEnabled, String(contextMemoryEnabled))
  useSettings.setState({ contextMemoryEnabled })
}

export const setAutoReadAloud = (autoReadAloud: boolean) => {
  write(KEYS.autoReadAloud, String(autoReadAloud))
  useSettings.setState({ autoReadAloud })
}

export const setShowReplyTokenUsage = (showReplyTokenUsage: boolean) => {
  write(KEYS.showReplyTokenUsage, String(showReplyTokenUsage))
  useSettings.setState({ showReplyTokenUsage })
}

export const setVoiceCallBargeIn = (voiceCallBargeIn: boolean) => {
  write(KEYS.voiceCallBargeIn, String(voiceCallBargeIn))
  useSettings.setState({ voiceCallBargeIn })
}

export const setVoiceCallPause = (voiceCallPause: VoiceCallPause) => {
  write(KEYS.voiceCallPause, voiceCallPause)
  useSettings.setState({ voiceCallPause })
}

export const setVoiceCallSpeakerPreference = (voiceCallSpeaker: boolean) => {
  write(KEYS.voiceCallSpeaker, String(voiceCallSpeaker))
  useSettings.setState({ voiceCallSpeaker })
}

export const setGeneration = (value: GenerationSettings) => {
  const generation = normalizeGeneration(value)
  const key = contextWindowKey(useSettings.getState())
  if (generation.contextTokens === undefined) {
    modelContextWindows.delete(key)
  } else {
    modelContextWindows.set(key, generation.contextTokens)
  }
  saveModelContextWindows()
  const globalGeneration = { ...generation }
  delete globalGeneration.contextTokens
  write(KEYS.generation, Object.keys(globalGeneration).length ? JSON.stringify(globalGeneration) : null)
  useSettings.setState({ generation })
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

/** 导入恢复置顶：只追加新 ID 到最前，不改动既有顺序与本机选择。 */
export const addPinnedSessions = (ids: readonly string[]) => {
  if (ids.length === 0) {
    return
  }
  const previous = useSettings.getState().pinnedSessionIds
  savePinnedSessions([...ids.filter((id) => !previous.includes(id)), ...previous])
}

const saveFavoriteMessages = (favoriteMessages: FavoriteMessage[]) => {
  write(KEYS.favoriteMessages, favoriteMessages.length ? JSON.stringify(favoriteMessages) : null)
  useSettings.setState({ favoriteMessages })
}

export const addFavoriteMessages = (sessionId: string, messageIds: readonly string[]) => {
  const previous = useSettings.getState().favoriteMessages
  const added = [...new Set(messageIds)].map((messageId) => ({ sessionId, messageId }))
  const existing = new Set(previous.map(favoriteMessageKey))
  const next = added.filter((entry) => !existing.has(favoriteMessageKey(entry)))
  if (next.length) {
    saveFavoriteMessages([...next, ...previous])
  }
}

export const removeFavoriteMessages = (sessionId: string, messageIds?: readonly string[]) => {
  const previous = useSettings.getState().favoriteMessages
  const removed = messageIds && new Set(messageIds)
  const next = previous.filter((entry) => entry.sessionId !== sessionId || (removed && !removed.has(entry.messageId)))
  if (next.length !== previous.length) {
    saveFavoriteMessages(next)
  }
}

export const clearFavoriteMessages = () => saveFavoriteMessages([])
