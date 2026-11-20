import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { registerHooks, stripTypeScriptTypes } from 'node:module'

const css = await readFile(new URL('../src/components/markdown/markdown.css', import.meta.url), 'utf8')
const nativePlugin = await readFile(
  new URL('../android/app/src/main/java/xyz/infralyx/deepstay/LocalFilesPlugin.java', import.meta.url),
  'utf8'
)
const typography = await readFile(new URL('../src/app/useChatTypography.ts', import.meta.url), 'utf8')
const settingsDialog = await readFile(new URL('../src/components/settings/SettingsDialog.tsx', import.meta.url), 'utf8')

const markdownRoot = css.match(/\.ds-markdown\s*\{([^}]+)\}/)?.[1]
assert.ok(markdownRoot, 'Markdown root rule')
assert.match(markdownRoot, /min-width:\s*0/)
assert.match(markdownRoot, /max-width:\s*100%/)
assert.match(markdownRoot, /overflow-wrap:\s*anywhere/)

const inlineCode = css.match(/\.ds-markdown code\s*\{([^}]+)\}/)?.[1]
assert.ok(inlineCode, 'Inline code rule')
assert.match(inlineCode, /display:\s*inline\s*;/)
assert.match(inlineCode, /overflow-wrap:\s*anywhere/)

const table = css.match(/\.ds-markdown table\s*\{([^}]+)\}/)?.[1]
const tableWrapper = css.match(/\.markdown-table-wrapper\s*\{([^}]+)\}/)?.[1]
assert.match(table, /width:\s*max-content/)
assert.match(tableWrapper, /max-width:\s*100%/)
assert.match(tableWrapper, /overflow-x:\s*auto/)

const codeBlock = css.match(/\.ds-markdown \.md-code-block\s*\{([^}]+)\}/)?.[1]
const codePre = css.match(/\.md-code-block > pre\s*\{([^}]+)\}/)?.[1]
const pre = css.match(/\.ds-markdown pre\s*\{([^}]+)\}/)?.[1]
assert.match(codeBlock, /max-width:\s*100%/)
assert.match(codePre, /max-width:\s*100%/)
assert.match(pre, /overflow:\s*auto/)
assert.doesNotMatch(css, /\.ds-markdown[^{}]*\{[^}]*overflow-x:\s*hidden/)

assert.match(nativePlugin, /getSystemFontFamilyName\(PluginCall call\)/)
assert.match(nativePlugin, /SDK_INT >= 34/)
assert.match(nativePlugin, /familyName = "sans-serif"/)
assert.match(nativePlugin, /new TextView\(getActivity\(\)\)\.getTypeface\(\)/)
assert.match(nativePlugin, /runOnUiThread/)
assert.match(settingsDialog, /<p style=\{\{ fontFamily: 'var\(--dsw-font-family\)' \}\}>/)
assert.doesNotMatch(typography, /\.replaceAll\(/, 'The Android WebView 83 target does not provide String.replaceAll')

const hookUrl = new URL('../src/app/useChatTypography.ts', import.meta.url)
const fallback = 'system-ui, sans-serif'
const mocks = new Map([
  ['react', 'export const useEffect=(...args)=>globalThis.__typographyEffects(...args);'],
  ['@capacitor/core', 'export const Capacitor={getPlatform:()=>globalThis.__typographyPlatform}; export const registerPlugin=()=>({getFontScale:async()=>({scale:1}),getSystemFontFamilyName:()=>globalThis.__typographyFamily()});'],
  ['../services/settings.js', 'export const useSettings=selector=>selector(globalThis.__typographySettings); export const getChatFontFamily=font=>font==="system"?"system-ui, sans-serif":"Inter, sans-serif";'],
])
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL === hookUrl.href && mocks.has(specifier)) {
      return { url: `data:text/javascript,${encodeURIComponent(mocks.get(specifier))}`, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    return url === hookUrl.href
      ? { format: 'module', source: stripTypeScriptTypes(typography), shortCircuit: true }
      : nextLoad(url, context)
  },
})
const styles = new Map()
const listeners = new Set()
globalThis.document = {
  visibilityState: 'visible',
  documentElement: { style: { setProperty: (key, value) => styles.set(key, value) } },
  addEventListener: (type, handler) => { assert.equal(type, 'visibilitychange'); listeners.add(handler) },
  removeEventListener: (type, handler) => { assert.equal(type, 'visibilitychange'); listeners.delete(handler) },
}
const cleanups = []
try {
  const { useChatTypography } = await import(hookUrl)
  const dependencies = []
  const effects = []
  let cursor = 0
  globalThis.__typographyEffects = (effect, next) => {
    const index = cursor++
    if (!dependencies[index] || next.some((value, position) => value !== dependencies[index][position])) {
      dependencies[index] = next
      effects.push(() => { cleanups[index]?.(); cleanups[index] = effect() })
    }
  }
  const render = () => {
    cursor = 0
    useChatTypography()
    for (const effect of effects.splice(0)) effect()
  }
  const settle = () => new Promise(resolve => setImmediate(resolve))
  const refresh = () => { for (const handler of listeners) handler() }
  const family = () => styles.get('--dsw-font-family')
  let requests = 0
  globalThis.__typographySettings = { chatFont: 'system', chatFontSize: 'normal' }
  globalThis.__typographyPlatform = 'android'
  globalThis.__typographyFamily = async () => { requests++; return { familyName: 'ThemeSans' } }
  render()
  assert.equal(family(), fallback, 'System fallback applies before the native response')
  await settle()
  assert.equal(family(), `"ThemeSans", ${fallback}`)
  assert.equal(requests, 1)

  document.visibilityState = 'hidden'
  refresh()
  assert.equal(requests, 1, 'Hidden pages do not request the current native font')
  document.visibilityState = 'visible'
  globalThis.__typographyFamily = async () => ({ familyName: 'Theme "Hand\\writing"' })
  refresh()
  await settle()
  assert.equal(family(), `"Theme \\"Hand\\\\writing\\"", ${fallback}`)

  globalThis.__typographyFamily = async () => ({ familyName: '' })
  refresh()
  await settle()
  assert.equal(family(), fallback, 'An empty native family resets a previous candidate')
  globalThis.__typographyFamily = async () => ({ familyName: 'ThemeSans' })
  refresh()
  await settle()
  globalThis.__typographyFamily = async () => { throw new Error('Older native shell') }
  refresh()
  await settle()
  assert.equal(family(), fallback, 'Unavailable native support retains the system fallback')

  let resolveNative
  globalThis.__typographyFamily = () => new Promise(resolve => { resolveNative = resolve })
  refresh()
  globalThis.__typographySettings = { chatFont: 'inter', chatFontSize: 'normal' }
  render()
  assert.equal(family(), 'Inter, sans-serif')
  assert.equal(listeners.size, 0, 'Switching to a bundled font removes the native refresh listener')
  resolveNative({ familyName: 'LateThemeFont' })
  await settle()
  assert.equal(family(), 'Inter, sans-serif', 'A late native response cannot replace the selected bundled font')

  globalThis.__typographyPlatform = 'web'
  globalThis.__typographySettings = { chatFont: 'system', chatFontSize: 'normal' }
  let webRequests = 0
  globalThis.__typographyFamily = () => { webRequests++; throw new Error('Web must not query native fonts') }
  render()
  await settle()
  assert.equal(family(), fallback)
  assert.equal(webRequests, 0)
  assert.equal(listeners.size, 0)
} finally {
  for (const cleanup of cleanups) cleanup?.()
  hooks.deregister()
}

console.log(JSON.stringify({
  passed: true,
  checks: [
    'Static CSS checks require wrapping for Markdown text and inline code, with local horizontal scrolling for wide tables and code blocks',
    'The real typography hook applies native family candidates with system fallbacks, refreshes on visibility, and resets missing native results',
    'Changing to a bundled font cancels late native updates; web mode never requests the Android family, and the settings preview inherits the global font variable',
  ],
  scope: 'CSS and native API guards are static checks; hook behavior uses deterministic React and Capacitor mocks. No pixel layout or OEM font synchronization is asserted.',
}))
