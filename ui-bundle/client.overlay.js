// dsh-tower-ui 0.2.2 — the transient shell.overlay status strip.
//
// Root-scoped (no chat hooks), so the toolview publishes a notice into this
// observable and the strip injects it; the timer is owned by apply's ctx.effect.
// Package-local chunk (#71).
window.__ModuleLoader__.load({
  id: 'dsh-tower-ui',
  chunk: 'client.overlay.js',
  factory() {
    function createOverlay(env) {
      const { h, translate, toolLabel, seatT, ST, dotStyle, helpers } = env
      const { isPlainObject } = helpers
      // Mutable state lives in this closure; the module has no top-level state.
      const state = { value: null }
      const listeners = new Set()

      function snapshot() {
        return state.value
      }
      function subscribe(listener) {
        listeners.add(listener)
        return function () {
          listeners.delete(listener)
        }
      }
      function setNotice(next) {
        if (Object.is(next, state.value)) return
        state.value = next
        for (const listener of Array.from(listeners)) {
          try {
            listener()
          } catch (error) {
            /* a broken subscriber must not break the strip */
          }
        }
      }
      const source = { getSnapshot: snapshot, subscribe: subscribe }

      function TowerStatusStrip(props) {
        const t = seatT(props)
        if (!props || typeof props.useTowerNotice !== 'function') return null
        const notice = props.useTowerNotice(function (value) {
          return value
        })
        if (!isPlainObject(notice)) return null
        const running = notice.running === true
        const failed = notice.ok === false
        const tone = running ? 'idle' : failed ? 'error' : 'ok'
        const text = translate(t, running ? 'strip.started' : failed ? 'strip.failed' : 'strip.finished', {
          tool: toolLabel(t, notice.tool),
        })
        return h(
          'div',
          { 'data-tower-ui': 'status-strip', role: 'status', 'aria-live': 'polite', style: ST.stripWrap },
          h('div', { style: ST.stripCard }, h('span', { 'aria-hidden': true, style: dotStyle(tone) }, null), h('span', null, text)),
        )
      }

      return { source, setNotice, TowerStatusStrip }
    }

    return { createOverlay }
  },
})
