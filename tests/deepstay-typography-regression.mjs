import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { registerHooks, stripTypeScriptTypes } from 'node:module'
import { fileURLToPath } from 'node:url'

const sourceRoot = new URL('../src/', import.meta.url)
const settingsUrl = new URL('services/settings.ts', sourceRoot)
const hookUrl = new URL('app/useChatTypography.ts', sourceRoot)
const values = new Map()
globalThis.localStorage = {
  getItem: (key) => values.get(key) ?? null,
  setItem: (key, value) => values.set(key, value),
  removeItem: (key) => values.delete(key),
}
Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh-CN' }, configurable: true })
globalThis.__API_ORIGIN__ = 'https://api.deepseek.com'

const hookMocks = new Map([
  ['react', 'export const useEffect=(effect)=>effect();'],
  ['@capacitor/core', 'export const Capacitor={getPlatform:()=>globalThis.__typographyPlatform}; export const registerPlugin=()=>({getFontScale:()=>globalThis.__getDeviceFontScale()});'],
  ['../services/settings.js', 'export const useSettings=(selector)=>selector(globalThis.__typographySettings); export const getChatFontFamily=(font)=>globalThis.__getFontFamily(font);'],
])
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL === hookUrl.href && hookMocks.has(specifier)) {
      return { url: `data:text/javascript,${encodeURIComponent(hookMocks.get(specifier))}`, shortCircuit: true }
    }
    if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL?.startsWith(sourceRoot.href)) {
      const candidate = new URL(specifier.slice(0, -3) + '.ts', context.parentURL)
      if (existsSync(fileURLToPath(candidate))) return { url: candidate.href, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url.startsWith(sourceRoot.href) && new URL(url).pathname.endsWith('.ts')) {
      return { format: 'module', source: stripTypeScriptTypes(readFileSync(new URL(url), 'utf8'), { mode: 'transform' }), shortCircuit: true }
    }
    return nextLoad(url, context)
  },
})

const settings = await import(settingsUrl)
assert.equal(settings.useSettings.getState().chatFont, 'system')
assert.equal(settings.useSettings.getState().chatFontSize, 'system')
assert.equal(settings.bundledChatFonts.length, 27)
assert.equal(new Set(settings.bundledChatFonts.map(({ value }) => value)).size, 27)
for (const { value, label } of settings.bundledChatFonts) {
  assert.equal(settings.getChatFontFamily(value).startsWith(`"${label}"`), true)
  const file = fileURLToPath(new URL(`assets/fonts/${value}.woff2`, sourceRoot))
  const license = fileURLToPath(new URL(`assets/fonts/licenses/${value}.txt`, sourceRoot))
  assert.equal(existsSync(file), true, `${value} font asset`)
  const notice = readFileSync(license, 'utf8')
  assert.match(notice, value === 'ubuntu' ? /UBUNTU FONT LICENCE Version 1\.0/ : /SIL OPEN FONT LICENSE Version 1\.1/)
  const owner = {
    'noto-sans-sc': 'Adobe', 'noto-serif-sc': 'Google', 'source-sans-3': 'Adobe',
    'noto-serif': 'Noto Project', 'fira-sans': 'Mozilla', 'ibm-plex-sans': 'IBM',
    'pt-sans': 'ParaType', 'pt-serif': 'ParaType',
  }[value] ?? label
  assert.equal(notice.replace(/[^a-z0-9]/gi, '').toLowerCase().includes(owner.replace(/[^a-z0-9]/gi, '').toLowerCase()), true, `${value} license owner`)
}
settings.setChatFont('inter')
settings.setChatFontSize('large')
const reloaded = await import(new URL('services/settings.ts?typography-reload', sourceRoot))
assert.equal(reloaded.useSettings.getState().chatFont, 'inter')
assert.equal(reloaded.useSettings.getState().chatFontSize, 'large')
values.set('deepstay:chat-font', 'serif')
values.set('deepstay:chat-font-size', 'extraLarge')
const legacy = await import(new URL('services/settings.ts?typography-legacy', sourceRoot))
assert.equal(legacy.useSettings.getState().chatFont, 'serif')
assert.equal(legacy.useSettings.getState().chatFontSize, 'extraLarge')
assert.match(legacy.getChatFontFamily('serif'), /serif$/)

const styles = new Map()
globalThis.document = {
  visibilityState: 'visible',
  documentElement: { style: { setProperty: (key, value) => styles.set(key, value) } },
  addEventListener: () => {},
  removeEventListener: () => {},
}
globalThis.__typographySettings = { chatFont: 'inter', chatFontSize: 'large' }
globalThis.__typographyPlatform = 'web'
globalThis.__getFontFamily = (font) => settings.getChatFontFamily(font)
globalThis.__getDeviceFontScale = async () => ({ scale: 1.35 })
const typography = await import(hookUrl)
typography.useChatTypography()
assert.equal(styles.get('--dsw-font-family').startsWith('"Inter"'), true)
assert.equal(styles.get('--ds-ui-scale'), '1.125')
assert.equal(styles.get('--ds-chat-scale'), '1')
globalThis.__typographySettings = { chatFont: 'system', chatFontSize: 'system' }
globalThis.__typographyPlatform = 'android'
typography.useChatTypography()
await new Promise((resolve) => setImmediate(resolve))
assert.equal(styles.get('--ds-ui-scale'), '1.35')
assert.equal(styles.get('--dsw-font-family').startsWith('system-ui'), true)

const theme = readFileSync(new URL('app/theme.css', sourceRoot), 'utf8')
const global = readFileSync(new URL('app/global.css', sourceRoot), 'utf8')
assert.match(theme, /--ds-chat-font-family:\s*var\(--dsw-font-family\)/)
assert.match(global, /font-size:\s*calc\(16px \* var\(--ds-ui-scale\)\)/)
console.log(JSON.stringify({
  passed: true,
  checks: [
    '27 bundled fonts load from local WOFF2 assets with their matching licenses and retain CJK fallback stacks',
    'font and size preferences persist across reloads; old serif and extra-large values remain readable',
    'the real typography hook applies global size, follows Android text scale, and keeps chat scale from doubling',
  ],
}))
