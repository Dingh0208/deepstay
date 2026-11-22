import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { registerHooks, stripTypeScriptTypes } from 'node:module'
import { fileURLToPath } from 'node:url'

const sourceRoot = new URL('../src/', import.meta.url)
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL?.startsWith(sourceRoot.href)) {
      const candidate = new URL(specifier.slice(0, -3) + '.ts', context.parentURL)
      if (existsSync(fileURLToPath(candidate))) return { url: candidate.href, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url.startsWith(sourceRoot.href) && url.endsWith('.ts')) return {
      format: 'module', source: stripTypeScriptTypes(readFileSync(new URL(url), 'utf8'), { mode: 'transform' }), shortCircuit: true,
    }
    return nextLoad(url, context)
  },
})

const listeners = new EventTarget()
const viewport = new EventTarget()
viewport.height = 800
viewport.offsetTop = 0
viewport.scale = 1
const mediaQuery = Object.assign(new EventTarget(), { matches: true })
globalThis.window = Object.assign(new EventTarget(), {
  innerHeight: 800,
  visualViewport: viewport,
  matchMedia: () => mediaQuery,
})
globalThis.document = Object.assign(listeners, { activeElement: { matches: () => false } })
globalThis.requestAnimationFrame = callback => { callback(); return 1 }
globalThis.cancelAnimationFrame = () => {}

const attributes = new Set()
const styles = new Map()
const frame = {
  style: {
    setProperty: (name, value) => styles.set(name, value),
    removeProperty: name => styles.delete(name),
  },
  toggleAttribute(name, force) {
    if (force) attributes.add(name)
    else attributes.delete(name)
    return force
  },
  removeAttribute: name => attributes.delete(name),
}
globalThis.__frame = frame

const react = {
  useEffect: () => {},
  useLayoutEffect: callback => { callback() },
  useRef: () => ({ current: globalThis.__frame }),
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
}
const reactUrl = `data:text/javascript,${encodeURIComponent(Object.entries(react).map(([name]) =>
  `export const ${name}=globalThis.__keyboardReact.${name};`).join(''))}`
globalThis.__keyboardReact = react
const hooksWithReact = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'react' && context.parentURL?.startsWith(sourceRoot.href)) {
      return { url: reactUrl, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
})

try {
  const { useMobileViewport } = await import(new URL('app/viewport.ts', sourceRoot))
  assert.equal(useMobileViewport(true).current, frame)
  assert.equal(attributes.has('data-keyboard-open'), false)

  document.activeElement = { matches: () => true }
  document.dispatchEvent(new Event('focusin'))
  assert.equal(attributes.has('data-keyboard-open'), false, 'Focus alone is not treated as a visible keyboard')

  viewport.height = 480
  viewport.dispatchEvent(new Event('resize'))
  assert.equal(attributes.has('data-keyboard-open'), true, 'A keyboard-sized viewport reduction marks the app frame')
  assert.equal(styles.get('--app-viewport-height'), '480px')

  viewport.height = 800
  viewport.dispatchEvent(new Event('resize'))
  assert.equal(attributes.has('data-keyboard-open'), false, 'Hiding the keyboard restores the footer even while the textarea retains focus')

  viewport.height = 480
  viewport.dispatchEvent(new Event('resize'))
  document.activeElement = { matches: () => false }
  document.dispatchEvent(new Event('focusout'))
  assert.equal(attributes.has('data-keyboard-open'), false)
  assert.equal(styles.has('--app-viewport-height'), false)

  const globalCss = readFileSync(new URL('../src/app/global.css', import.meta.url), 'utf8')
  const metrics = readFileSync(new URL('../src/components/chatInput/ComposerMetrics.tsx', import.meta.url), 'utf8')
  const sessionView = readFileSync(new URL('../src/components/session/SessionView.tsx', import.meta.url), 'utf8')
  const welcome = readFileSync(new URL('../src/components/session/Welcome.tsx', import.meta.url), 'utf8')
  assert.match(globalCss, /\[data-keyboard-open\]\s+\[data-composer-metrics\]/)
  assert.match(globalCss, /\[data-keyboard-open\]\s+\[data-input-caveat\]/)
  assert.doesNotMatch(globalCss, /\[data-keyboard-open=['"]true['"]\]/, 'A boolean data attribute is matched by presence, not by a string value')
  assert.match(metrics, /data-composer-metrics=/)
  assert.match(sessionView, /data-input-caveat=/)
  assert.match(welcome, /data-input-caveat=/)
  console.log('Mobile keyboard regression passed: viewport state hides only composer metrics and caveats, then restores them on keyboard dismissal or blur.')
} finally {
  hooksWithReact.deregister()
  hooks.deregister()
}
