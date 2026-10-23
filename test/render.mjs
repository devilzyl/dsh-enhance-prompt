/**
 * Render-level check for the prompt-enhance Client half.
 *
 * The motion is opacity-only: the anchor keeps its box in every state, so no
 * element slides, shrinks, or reflows. These checks prove that, plus that the
 * button itself keeps its size, structure, and behavior.
 */
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const CLIENT_URL = new URL('../client.js', import.meta.url)
const source = fs.readFileSync(fileURLToPath(CLIENT_URL), 'utf8')

const React = {
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children }
  },
  Fragment: Symbol('Fragment'),
  useState(initial) { return [initial, () => {}] },
  useRef(initial) { return { current: initial } },
  useEffect() {},
  useMemo(fn) { return fn() },
  useCallback(fn) { return fn },
  memo(x) { return x },
}

let plugin
globalThis.window = {
  __ModuleLoader__: { load(def) { plugin = def.factory((name) => (name === 'react' ? React : {})) } },
}
await import(`${CLIENT_URL.href}?v=${Date.now()}`)

let registered
function applyWithLocale(locale, { ready = true } = {}) {
  let available = ready
  const pending = []
  const ctx = {
    get: (name) => (name === 'locale' ? (available ? locale : undefined) : undefined),
    effect: (fn) => { fn() },
    inject: (deps, cb) => {
      if (deps.every((dep) => dep !== 'locale' || available)) cb(ctx)
      else pending.push(cb)
    },
    slots: {
      inject: (_key, cb) => { cb() },
      register: (options, component) => { registered = { options, component }; return () => {} },
    },
  }
  plugin.apply(ctx)
  return {
    provide() {
      available = true
      for (const cb of pending.splice(0)) cb(ctx)
    },
  }
}

applyWithLocale({ register: () => () => {} })

const { component } = registered
const props = (draft, t) => ({
  useInput: (selector) => selector({ draft }),
  inputActions: { setDraft() {} },
  // The host translator misses our namespace and returns the bare key.
  t: t ?? ((key) => key),
})

function parts(tree) {
  const style = tree.children[0]
  const anchor = tree.children[1]
  const button = anchor.children[0]
  return { css: style.children[0], anchor, button }
}

const opened = parts(component(props('帮我写一个登录页')))
const closed = parts(component(props('')))

const css = opened.css
const closedRule = (css.match(/\.dsh-pe-anchor\[data-open='false'\] \{[^}]*\}/) ?? [''])[0]

const checks = [
  ['registration keeps the slot, cell id and order', registered.options.name === 'conversation.input.right'
    && registered.options.id === 'prompt-enhance' && registered.options.order === 20],

  // Button unchanged.
  ['button has no wrapper beyond the anchor', opened.anchor.children.length === 1
    && opened.button.props.className === 'dsh-pe-btn'],
  ['button keeps its click handler', typeof opened.button.props.onClick === 'function'],
  ['english tooltip is "Optimize prompt"', opened.button.props['aria-label'] === 'Optimize prompt'
    && opened.anchor.props['data-tip'] === 'Optimize prompt'],
  ['no raw key leaks into the label', !/^enhance\./.test(String(opened.button.props['aria-label']))],
  ['button keeps its disabled semantics', opened.button.props['aria-disabled'] === 'false'],
  ['anchor keeps the 28px box', /\.dsh-pe-anchor \{[^}]*width: 28px;[^}]*height: 28px;/s.test(css)],
  ['button keeps the 28px box', /\.dsh-pe-btn \{[^}]*width: 28px;[^}]*height: 28px;/s.test(css)],

  // Opacity-only motion.
  ['anchor transitions opacity only', /\.dsh-pe-anchor \{[^}]*transition: opacity 150ms ease-in-out;/s.test(css)],
  ['anchor has no width/margin/transform transition', !/transition:[^;]*(width|margin|transform)/.test(css)],
  ['closed state changes opacity and hit-testing only',
    /opacity: 0;/.test(closedRule) && /pointer-events: none;/.test(closedRule)
    && !/width|margin|transform|left|translate/.test(closedRule)],
  ['no slide or scale anywhere', !/translateX|translateY|scale\(/.test(css)],
  ['transform survives only in the spinner keyframes', (() => {
    const rotateLine = css.split('\n').find((line) => line.includes('@keyframes dsh-pe-rotate')) ?? ''
    const outside = css.replace(rotateLine, '')
    return rotateLine.includes('transform: rotate(0deg)') && rotateLine.includes('transform: rotate(360deg)')
      && !outside.includes('transform:')
  })()],
  ['no clipping shell is left behind', !/dsh-pe-shell/.test(css) && !/dsh-pe-shell/.test(source)],
  ['tooltip stays on the anchor', /\.dsh-pe-anchor::after/.test(css)],
  ['reduced motion disables the fade', /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.dsh-pe-anchor \{ transition: none; \}/.test(css)],

  // Both states render the same box.
  ['open state is marked', opened.anchor.props['data-open'] === 'true'],
  ['open state is announced', opened.anchor.props['aria-hidden'] === undefined],
  ['open button is tabbable', opened.button.props.tabIndex === undefined],
  ['collapsed state still renders the entry', closed.anchor !== undefined && closed.button !== undefined],
  ['collapsed state is marked closed', closed.anchor.props['data-open'] === 'false'],
  ['collapsed state is aria-hidden', closed.anchor.props['aria-hidden'] === 'true'],
  ['collapsed button leaves the tab order', closed.button.props.tabIndex === -1],
  ['collapsed anchor keeps the same box', /\.dsh-pe-anchor\[data-open='false'\] \{[^}]*\}/.test(css)
    && !/dsh-pe-anchor\[data-open='false'\] \{[^}]*width/.test(css)],

  // A stall must surface as an error, not an endless spinner.
  ['a bounded deadline exists', /const TIMEOUT_MS = (\d{4,})\b/.test(source)
    && Number((source.match(/const TIMEOUT_MS = (\d+)/) ?? [])[1]) >= 30000],
  ['the deadline invalidates the run and reports a timeout',
    /setTimeout\(\(\) => \{[\s\S]*?runRef\.current = run \+ 1[\s\S]*?setPhase\('error'\)[\s\S]*?translate\('enhance\.timeout'\)[\s\S]*?\}, TIMEOUT_MS\)/.test(source)],
  ['the deadline is always cleared', (source.match(/clearTimeout\(deadline\)/g) ?? []).length >= 2],

  // Privacy surface: the request carries the draft and nothing else, and an
  // upstream message cannot flood the UI.
  ['request carries only the draft', /body: JSON\.stringify\(\{ text: source \}\)/.test(source) && !/sessionId/.test(source)],
  ['upstream detail is truncated', /const MAX_DETAIL = 200/.test(source) && /slice\(0, MAX_DETAIL\)/.test(source)],
]

// Cold client boot: the locale service is provided after this plugin, so the
// binding must be deferred rather than read once at activation.
{
  const handle = applyWithLocale(
    { register: () => () => {}, getSnapshot: () => ({ active: 'zh' }), subscribe: () => () => {} },
    { ready: false },
  )
  const before = parts(component(props('hello')))
  checks.push(['english until the locale service arrives', before.button.props['aria-label'] === 'Optimize prompt'])
  handle.provide()
  const after = parts(component(props('hello')))
  checks.push(['deferred locale service switches the copy', after.button.props['aria-label'] === '优化提示词'])
}

// No reachable locale service at all: the document language the locale runtime
// keeps in sync still decides the copy.
{
  const saved = globalThis.document
  globalThis.document = { documentElement: { lang: 'zh-CN' } }
  applyWithLocale(undefined)
  const withDom = parts(component(props('hello')))
  checks.push(['document language drives the copy without a service', withDom.button.props['aria-label'] === '优化提示词'])
  globalThis.document = saved
}

// The bundled dictionary follows the active locale, and a host translator that
// actually resolves the key still wins.
applyWithLocale({ register: () => () => {}, getSnapshot: () => ({ active: 'zh' }) })
const zh = parts(component(props('帮我写一个登录页')))
checks.push(['zh dictionary follows the active locale', zh.button.props['aria-label'] === '优化提示词'
  && zh.anchor.props['data-tip'] === '优化提示词'])
const hostResolved = parts(component(props('帮我写一个登录页', (key) => `T:${key}`)))
checks.push(['a resolving host translator wins', hostResolved.button.props['aria-label'] === 'T:enhance.tooltip'])

let failed = 0
for (const [name, ok] of checks) {
  if (!ok) failed += 1
  console.log((ok ? 'ok   ' : 'FAIL ') + name)
}
console.log(failed === 0 ? 'ALL RENDER CHECKS PASSED' : failed + ' CHECK(S) FAILED')
process.exit(failed === 0 ? 0 : 1)
