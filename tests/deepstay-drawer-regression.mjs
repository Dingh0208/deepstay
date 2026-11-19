import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerHooks, stripTypeScriptTypes } from 'node:module'

const source = new URL('../src/components/sider/mobileSiderState.ts', import.meta.url)
const hook = registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL === source.href && specifier === 'react') {
      return { url: 'data:text/javascript,export const useRef=value=>({current:value})', shortCircuit: true }
    }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (url === source.href) {
      return { format: 'module', source: stripTypeScriptTypes(readFileSync(source, 'utf8')), shortCircuit: true }
    }
    return next(url, context)
  },
})
globalThis.window = { getSelection: () => ({ isCollapsed: true }) }
globalThis.Element = class {
  constructor(blocked = false, drawer = false) { this.blocked = blocked; this.drawer = drawer }
  closest(selector) {
    return selector.includes('[data-mobile-drawer-layer]') ? this.drawer : this.blocked
  }
}
const attrs = new Map()
const properties = new Map()
const frame = {
  getBoundingClientRect: () => ({ left: 0 }),
  querySelector: () => ({ clientWidth: 300, getBoundingClientRect: () => ({ width: 300 }) }),
  hasAttribute: key => attrs.has(key),
  setAttribute: (key, value) => attrs.set(key, value),
  removeAttribute: key => attrs.delete(key),
  style: { setProperty: (key, value) => properties.set(key, value), removeProperty: key => properties.delete(key) },
}
const event = (x, y = 200, target = new Element(), touches = 1) => ({
  target, currentTarget: frame,
  touches: Array.from({ length: touches }, (_, index) => ({ clientX: x, clientY: y, identifier: index })),
  changedTouches: [{ clientX: x, clientY: y, identifier: 0 }],
})
try {
  const { useMobileSiderSwipe, useMobileSider, closeMobileSider } = await import(source)
  const handlers = useMobileSiderSwipe(true)
  handlers.onTouchStart(event(10))
  handlers.onTouchMove(event(160))
  assert.equal(properties.get('--drawer-translate'), '-50%')
  assert.equal(properties.get('--drawer-opacity'), '0.5')
  handlers.onTouchEnd(event(160))
  assert.equal(useMobileSider.getState().open, true)
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(attrs.size, 0)
  assert.equal(properties.size, 0)

  const drawer = new Element(false, true)
  handlers.onTouchStart(event(220, 200, drawer))
  handlers.onTouchMove(event(100, 200, drawer))
  assert.equal(properties.get('--drawer-translate'), '-40%')
  handlers.onTouchEnd(event(100, 200, drawer))
  assert.equal(useMobileSider.getState().open, false)
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(attrs.size, 0)
  assert.equal(properties.size, 0)

  // A short drag returns to the previous state; text selection and vertical scroll stay usable.
  handlers.onTouchStart(event(10))
  handlers.onTouchMove(event(45))
  assert.equal(attrs.size, 1)
  handlers.onTouchEnd(event(45))
  assert.equal(useMobileSider.getState().open, false)
  assert.equal(attrs.size, 0)
  for (const target of [new Element(true), new Element(false)]) {
    handlers.onTouchStart(event(10, 200, target))
    handlers.onTouchMove(event(20, 280, target))
    handlers.onTouchEnd(event(150, 280, target))
    assert.equal(useMobileSider.getState().open, false)
  }
  handlers.onTouchStart(event(10))
  handlers.onTouchMove(event(160))
  handlers.onTouchMove(event(160, 200, new Element(), 2))
  handlers.onTouchEnd(event(160))
  assert.equal(useMobileSider.getState().open, false)
  assert.equal(attrs.size, 0)
  window.getSelection = () => ({ isCollapsed: false })
  handlers.onTouchStart(event(10))
  handlers.onTouchMove(event(160))
  handlers.onTouchEnd(event(160))
  assert.equal(useMobileSider.getState().open, false)
  window.getSelection = () => ({ isCollapsed: true })
  const desktop = useMobileSiderSwipe(false)
  desktop.onTouchStart(event(10))
  desktop.onTouchEnd(event(160))
  assert.equal(useMobileSider.getState().open, false)
  closeMobileSider()
  console.log('Drawer gesture regression passed: follow drag, settle both directions, short drag, blocked input, vertical scroll, multitouch, selection and desktop')
} finally {
  hook.deregister()
}
