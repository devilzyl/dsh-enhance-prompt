/**
 * Client half of the prompt-enhance bundle.
 *
 * One composer tool-row button. Idle: rewrite the draft. Working: cancel.
 * Applied: restore the draft the rewrite replaced. Failure: the tooltip says
 * why and the next click tries again. The rewrite itself is the Host half's
 * single POST route, so this file never talks to a model.
 */
window.__ModuleLoader__.load({
  id: 'dsh-enhance-prompt',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'dsh-enhance-prompt'
    const ROUTE = '/prompt-enhance/v1/enhance'
    /** A stalled rewrite becomes a visible error instead of an endless spinner. */
    const TIMEOUT_MS = 60000
    /** Composer reference chips (U+E100..U+E11D or U+FFFC) cannot survive a rewrite. */
    const CHIP_RE = /[\uE100-\uE11D\uFFFC]/u

    const EN = {
      'enhance.tooltip': 'Optimize prompt',
      'enhance.enhancing': 'Enhancing prompt…',
      'enhance.revert': 'Revert to the original draft',
      'enhance.failed': 'Enhance failed',
      'enhance.timeout': 'Enhance timed out; try again',
      'enhance.unauthorized': 'Session not authorized; refresh the page and retry',
      'enhance.chips': 'Remove @ references before enhancing',
      'enhance.changed': 'The draft changed; the result was not applied',
      'enhance.empty': 'The model returned an empty prompt',
    }
    const ZH = {
      'enhance.tooltip': '优化提示词',
      'enhance.enhancing': '正在优化提示词…',
      'enhance.revert': '还原原始草稿',
      'enhance.failed': '优化失败',
      'enhance.timeout': '优化超时，请重试',
      'enhance.unauthorized': '会话未授权，请刷新页面后重试',
      'enhance.chips': '请先移除 @ 引用，再优化提示词',
      'enhance.changed': '草稿已修改，结果未应用',
      'enhance.empty': '模型返回了空内容',
    }

    /**
     * The slot's `t` is bound to the declaring slot's namespace, not to ours, so
     * a miss returns the bare key ("enhance.failed"). These dictionaries are the
     * authority for our own copy; the host translator is only preferred when it
     * actually resolves the key.
     */
    let activeLocale = 'en'
    /** Set once the locale service is reachable (may arrive after this plugin). */
    let localeService
    /** Re-render hooks so a live locale switch repaints the tooltip immediately. */
    const localeListeners = new Set()
    function setActiveLocale(next) {
      if (activeLocale === next) return
      activeLocale = next
      for (const listener of [...localeListeners]) listener()
    }
    /** Assignment without notification: safe to call while rendering. */
    function syncLocaleSilently() {
      const next = detectLocale()
      if (activeLocale !== next) activeLocale = next
    }
    function normalizeLocale(value) {
      return String(value ?? '').toLowerCase().startsWith('zh') ? 'zh' : 'en'
    }
    /**
     * The interface language, from the most reliable source available.
     *
     * The `locale` service is provided by the client-locale bundle, which may
     * activate after this plugin; binding to it at activation time left the copy
     * English forever. The locale runtime keeps `<html lang>` in sync on every
     * switch, so the document is the fallback that always reflects the setting.
     */
    function detectLocale() {
      try {
        const snapshot = localeService?.getSnapshot?.()
        if (snapshot?.active) return normalizeLocale(snapshot.active)
      } catch {
        // fall through to the document
      }
      if (typeof document !== 'undefined') {
        const lang = document?.documentElement?.lang
        if (lang) return normalizeLocale(lang)
      }
      // Browser language is deliberately not a fallback: it does not follow the
      // app's language setting, which is what this copy must match.
      return 'en'
    }
    function dictionary() {
      return activeLocale === 'zh' ? ZH : EN
    }
    function localize(key, params) {
      const template = dictionary()[key] ?? EN[key] ?? key
      if (params === undefined) return template
      return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
    }

    const CSS = `
/* Opacity-only motion: the anchor keeps its 28px box in every state, so neither
   the button nor the controls beside it ever move — the space is reserved and
   only the visibility changes. */
.dsh-pe-anchor {
  position: relative;
  display: inline-flex;
  flex: none;
  width: 28px;
  height: 28px;
  opacity: 1;
  transition: opacity 150ms ease-in-out;
}
.dsh-pe-anchor[data-open='false'] {
  opacity: 0;
  pointer-events: none;
}
.dsh-pe-btn {
  all: unset;
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 28px;
  height: 28px;
  border-radius: 999px;
  cursor: pointer;
  color: var(--dsw-alias-label-secondary);
  transition:
    background-color 120ms ease,
    color 120ms ease;
}
.dsh-pe-btn:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.dsh-pe-btn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -2px; }
.dsh-pe-btn[aria-disabled='true'] { cursor: default; opacity: 0.45; }
.dsh-pe-btn[aria-disabled='true']:hover { background: none; color: var(--dsw-alias-label-secondary); }
.dsh-pe-btn[data-state='error'] { color: var(--dsw-alias-state-error-primary); }
.dsh-pe-btn[data-state='error']:hover { color: var(--dsw-alias-state-error-primary); }
.dsh-pe-spin { animation: dsh-pe-rotate 900ms linear infinite; }
@keyframes dsh-pe-rotate { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
.dsh-pe-anchor::after {
  content: attr(data-tip);
  position: absolute;
  bottom: calc(100% + 8px);
  right: 0;
  max-width: 260px;
  width: max-content;
  padding: 5px 8px;
  border-radius: 6px;
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-overlay);
  color: var(--dsw-alias-label-primary);
  font-size: 12px;
  line-height: 16px;
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.18);
  opacity: 0;
  visibility: hidden;
  transition: opacity 120ms ease;
  pointer-events: none;
  z-index: 40;
}
.dsh-pe-anchor:hover::after,
.dsh-pe-anchor:focus-within::after { opacity: 1; visibility: visible; }
@media (prefers-reduced-motion: reduce) {
  .dsh-pe-spin { animation: none; }
  .dsh-pe-anchor { transition: none; }
}
`

    function SparkleIcon() {
      return h('svg', {
        viewBox: '0 0 16 16', width: 15, height: 15, 'aria-hidden': true, focusable: false,
      },
      h('path', {
        fill: 'currentColor',
        d: 'M6.6 1.9c.16-.4.72-.4.88 0l1.1 2.86a.5.5 0 0 0 .28.29l2.86 1.1c.4.16.4.72 0 .88l-2.86 1.1a.5.5 0 0 0-.28.29l-1.1 2.86c-.16.4-.72.4-.88 0l-1.1-2.86a.5.5 0 0 0-.28-.29l-2.86-1.1c-.4-.16-.4-.72 0-.88l2.86-1.1a.5.5 0 0 0 .28-.29z',
      }),
      h('path', {
        fill: 'currentColor',
        d: 'M11.9 9.4c.12-.3.54-.3.66 0l.5 1.3a.4.4 0 0 0 .23.23l1.3.5c.3.12.3.54 0 .66l-1.3.5a.4.4 0 0 0-.23.23l-.5 1.3c-.12.3-.54.3-.66 0l-.5-1.3a.4.4 0 0 0-.23-.23l-1.3-.5c-.3-.12-.3-.54 0-.66l1.3-.5a.4.4 0 0 0 .23-.23z',
      }))
    }

    function RevertIcon() {
      return h('svg', {
        viewBox: '0 0 16 16', width: 15, height: 15, fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, focusable: false,
      },
      h('path', { d: 'M3.4 7.6a4.6 4.6 0 1 1 1.34 3.6' }),
      h('path', { d: 'M3.1 2.9v3.3h3.3' }))
    }

    function SpinnerIcon() {
      return h('svg', {
        viewBox: '0 0 16 16', width: 15, height: 15, fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.6, strokeLinecap: 'round', 'aria-hidden': true, focusable: false,
        className: 'dsh-pe-spin',
      },
      h('path', { d: 'M8 2.2a5.8 5.8 0 1 1-4.1 1.7', opacity: 0.9 }))
    }

    function normalize(text) {
      return typeof text === 'string' ? text.trim() : ''
    }

    /** Stable selector used when a scope supplies no input channel. */
    function readDraft(state) {
      return state && typeof state.draft === 'string' ? state.draft : ''
    }
    function useNothing() {
      return undefined
    }

    /** Turn one failed response into copy the user can act on. */
    /** Longest slice of an upstream message that may reach the UI. */
    const MAX_DETAIL = 200

    function failureMessage(response, payload, translate) {
      const code = payload !== null && typeof payload.code === 'string' ? payload.code : ''
      if (code === 'unauthorized') return translate('enhance.unauthorized')
      const raw = payload !== null && typeof payload.message === 'string' ? payload.message.trim() : ''
      const detail = raw.length > MAX_DETAIL ? `${raw.slice(0, MAX_DETAIL)}…` : raw
      const status = `HTTP ${response.status}`
      return detail === '' ? `${translate('enhance.failed')} (${status})` : `${detail} (${status})`
    }

    function EnhanceButton(props) {
      // Pick up a locale change that this entry was not notified about; the
      // assignment is silent, so it is safe during render.
      syncLocaleSilently()
      const translate = (key) => {
        if (typeof props.t === 'function') {
          try {
            const resolved = props.t(key)
            if (typeof resolved === 'string' && resolved !== '' && resolved !== key) return resolved
          } catch {
            // fall through to the bundled dictionary
          }
        }
        return localize(key)
      }
      const inputActions = props.inputActions
      const useInputChannel = typeof props.useInput === 'function' ? props.useInput : useNothing
      const draft = useInputChannel(readDraft)

      const [phase, setPhase] = React.useState('idle')
      const [message, setMessage] = React.useState('')
      // Repaint when the client language switches, so the tooltip copy follows
      // the active locale without waiting for the next draft change.
      const [, setLocaleRevision] = React.useState(0)
      const backupRef = React.useRef(null)
      const abortRef = React.useRef(null)
      const runRef = React.useRef(0)
      const draftRef = React.useRef(draft)
      draftRef.current = draft

      const hasDraft = normalize(draft).length > 0
      const hasChip = CHIP_RE.test(draft)
      const usable = typeof inputActions === 'object' && inputActions !== null
        && typeof inputActions.setDraft === 'function'

      React.useEffect(() => () => {
        const controller = abortRef.current
        abortRef.current = null
        if (controller !== null) controller.abort()
      }, [])

      // The tooltip copy is read from the active locale, so a language switch
      // must re-render this entry even when the draft is unchanged.
      React.useEffect(() => {
        const listener = () => setLocaleRevision((value) => value + 1)
        localeListeners.add(listener)
        return () => {
          localeListeners.delete(listener)
        }
      }, [])

      // Dropping the revert offer once the applied text is edited keeps the
      // button honest: it only restores what the user last saw replaced.
      React.useEffect(() => {
        if (phase !== 'done') return
        const snapshot = backupRef.current
        if (snapshot === null) return
        // The new draft reaches this component one render after setDraft.
        if (normalize(draft) === normalize(snapshot.before)) return
        if (normalize(draft) !== normalize(snapshot.after)) {
          backupRef.current = null
          setPhase('idle')
          setMessage('')
        }
      }, [draft, phase])

      if (!usable) return null

      const busy = phase === 'busy'
      const disabled = busy ? false : (!hasDraft || hasChip)
      // The entry never unmounts: emptying the draft collapses it instead, so
      // both directions are CSS transitions on the same element. Reversing
      // mid-flight (clear, then type again) resumes from the current width
      // rather than restarting or stacking.
      const open = hasDraft || busy

      const start = async () => {
        const source = draftRef.current
        if (normalize(source) === '' || CHIP_RE.test(source)) return
        const previous = abortRef.current
        if (previous !== null) previous.abort()
        const controller = new AbortController()
        abortRef.current = controller
        const run = runRef.current + 1
        runRef.current = run
        setPhase('busy')
        setMessage('')
        // A silent stall must end in a visible failure, never in an endless spinner.
        const deadline = setTimeout(() => {
          if (runRef.current !== run) return
          runRef.current = run + 1
          abortRef.current = null
          controller.abort()
          setPhase('error')
          setMessage(translate('enhance.timeout'))
        }, TIMEOUT_MS)
        try {
          const response = await fetch(ROUTE, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ text: source }),
            signal: controller.signal,
          })
          clearTimeout(deadline)
          let payload
          try {
            payload = await response.json()
          } catch {
            payload = null
          }
          if (run !== runRef.current) return
          if (!response.ok || payload === null || payload.ok !== true || typeof payload.text !== 'string') {
            setPhase('error')
            setMessage(failureMessage(response, payload, translate))
            return
          }
          const next = payload.text.trim()
          if (next === '') {
            setPhase('error')
            setMessage(translate('enhance.empty'))
            return
          }
          if (normalize(draftRef.current) !== normalize(source)) {
            setPhase('error')
            setMessage(translate('enhance.changed'))
            return
          }
          backupRef.current = { before: source, after: next }
          inputActions.setDraft(next)
          setPhase('done')
        } catch (error) {
          if (run !== runRef.current) return
          if (error && error.name === 'AbortError') {
            setPhase('idle')
            setMessage('')
            return
          }
          setPhase('error')
          setMessage(error instanceof Error && error.message !== '' ? error.message : translate('enhance.failed'))
        } finally {
          clearTimeout(deadline)
          if (run === runRef.current) abortRef.current = null
        }
      }

      const onClick = () => {
        if (busy) {
          const controller = abortRef.current
          abortRef.current = null
          runRef.current += 1
          if (controller !== null) controller.abort()
          setPhase('idle')
          setMessage('')
          return
        }
        if (phase === 'done') {
          const snapshot = backupRef.current
          backupRef.current = null
          if (snapshot !== null) inputActions.setDraft(snapshot.before)
          setPhase('idle')
          setMessage('')
          return
        }
        if (disabled) return
        void start()
      }

      const tooltip = busy
        ? translate('enhance.enhancing')
        : phase === 'done'
          ? translate('enhance.revert')
          : phase === 'error'
            ? (message === '' ? translate('enhance.failed') : message)
            : hasChip
              ? translate('enhance.chips')
              : translate('enhance.tooltip')

      return h(React.Fragment, null,
        h('style', { key: 'style' }, CSS),
        h('span', {
          className: 'dsh-pe-anchor',
          'data-tip': tooltip,
          'data-open': open ? 'true' : 'false',
          'aria-hidden': open ? undefined : 'true',
        },
        h('button', {
          type: 'button',
          className: 'dsh-pe-btn',
          'data-state': phase,
          title: phase === 'error' ? tooltip : undefined,
          'aria-label': tooltip,
          'aria-disabled': disabled ? 'true' : 'false',
          tabIndex: open ? undefined : -1,
          onClick,
        }, busy ? h(SpinnerIcon) : phase === 'done' ? h(RevertIcon) : h(SparkleIcon))))
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const attachLocale = (locale) => {
          localeService = locale
          const syncLocale = () => setActiveLocale(detectLocale())
          syncLocale()
          if (typeof locale?.subscribe === 'function') {
            ctx.effect(() => {
              const unsubscribe = locale.subscribe(syncLocale)
              return () => {
                if (typeof unsubscribe === 'function') unsubscribe()
              }
            }, 'prompt-enhance: locale sync')
          }
          // Registration keeps the host translator authoritative when it resolves
          // our namespace; the bundled dictionaries cover it when it does not.
          if (typeof locale?.register === 'function') {
            try {
              ctx.effect(() => locale.register(NS, 'en', EN), 'prompt-enhance: en locale')
              ctx.effect(() => locale.register(NS, 'zh', ZH), 'prompt-enhance: zh locale')
            } catch {
              // The bundled dictionary still renders the copy.
            }
          }
        }

        // The locale service may be provided after this plugin, so bind through
        // `inject` instead of reading it once; `detectLocale` also reads the
        // document, which the locale runtime keeps in sync either way.
        const locale = ctx.get('locale')
        if (locale !== undefined) attachLocale(locale)
        else if (typeof ctx.inject === 'function') {
          try {
            ctx.inject(['locale'], (child) => attachLocale(child.get('locale')))
          } catch {
            // Fall back to the document-derived locale below.
          }
        }
        setActiveLocale(detectLocale())
        if (typeof document !== 'undefined' && typeof MutationObserver === 'function') {
          const observer = new MutationObserver(() => setActiveLocale(detectLocale()))
          observer.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] })
          ctx.effect(() => () => observer.disconnect())
        }

        ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
          name: 'conversation.input.right',
          id: 'prompt-enhance',
          order: 20,
          locale: NS,
        }, EnhanceButton))
      },
    }
  },
})
