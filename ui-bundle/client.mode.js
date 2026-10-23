// dsh-tower-ui 0.2.2 — the history-derived Tower-mode model and observable.
//
// The dock folds the durable history into one stance model; the store publishes
// it so the denied-tool toolviews can be added/disposed. No Host state is read
// or fetched. Package-local chunk (#71).
window.__ModuleLoader__.load({
  id: 'dsh-tower-ui',
  chunk: 'client.mode.js',
  factory() {
    function towerCommandAction(args) {
      const raw = String(args === undefined || args === null ? '' : args).trim()
      if (/^reload$/i.test(raw)) return null
      if (/^base\s+\S+\s*$/i.test(raw)) return null
      const match = /^(on|off)(?:\s+[\s\S]*)?$/i.exec(raw)
      if (match) return match[1].toLowerCase()
      // Bare `/tower` and `/tower <message>` both mean "ensure on".
      return 'on'
    }
    function repoNameOf(value) {
      if (typeof value !== 'string' || value === '') return null
      let cleaned = value.replace(/[\\/]+$/, '')
      if (/[\\/]\.git$/i.test(cleaned)) cleaned = cleaned.replace(/[\\/]\.git$/i, '')
      const index = Math.max(cleaned.lastIndexOf('/'), cleaned.lastIndexOf('\\'))
      const name = index >= 0 ? cleaned.slice(index + 1) : cleaned
      return name === '' ? null : name
    }
    // Fold the visible history into one model: the last recognized event wins,
    // and `/tower reload|base` or a failed command leaves the stance unchanged.
    function modeModelFromLegacy(legacy, helpers) {
      const { isPlainObject, parsePayload } = helpers
      const model = {
        known: false,
        on: null,
        denied: null,
        repo: null,
        lock: null,
        lastBy: null,
        lastReason: null,
        source: null,
      }
      const nodes = isPlainObject(legacy) && Array.isArray(legacy.nodes) ? legacy.nodes : []
      for (const node of nodes) {
        if (!isPlainObject(node)) continue
        if (node.kind === 'command') {
          if (node.name !== 'tower') continue
          const outcome = isPlainObject(node.outcome) ? node.outcome : null
          if (outcome !== null && outcome.kind === 'error') continue
          const action = towerCommandAction(node.args)
          if (action === null) continue
          model.known = true
          model.on = action === 'on'
          model.source = 'command'
          model.lastBy = 'user'
          model.lastReason = null
          continue
        }
        const toolName = isPlainObject(node.call) ? node.call.name : null
        if (toolName === 'tower_mode') {
          const payload = parsePayload(node)
          if (!isPlainObject(payload) || payload.__error === true) continue
          if (payload.mode === 'on' || payload.mode === 'off') {
            model.known = true
            model.on = payload.mode === 'on'
            model.source = 'tower_mode'
          }
          if (Array.isArray(payload.deniedWhileActive)) {
            const names = []
            for (const entry of payload.deniedWhileActive) {
              if (typeof entry !== 'string') continue
              const name = entry.trim()
              if (name !== '' && !names.includes(name)) names.push(name)
            }
            if (names.length > 0) model.denied = names
          }
          const workspace = isPlainObject(payload.workspaceLock) ? payload.workspaceLock : null
          if (workspace !== null) {
            model.lock = { enabled: workspace.enabled === true, held: workspace.held === true }
            const name = repoNameOf(workspace.commonDir)
            if (name !== null) model.repo = name
          }
          if (isPlainObject(payload.lastChange)) {
            if (typeof payload.lastChange.by === 'string') model.lastBy = payload.lastChange.by
            if (typeof payload.lastChange.reason === 'string' && payload.lastChange.reason.trim() !== '') {
              model.lastReason = payload.lastChange.reason.trim()
            }
          }
          continue
        }
        if (toolName === 'tower_control') {
          const payload = parsePayload(node)
          if (!isPlainObject(payload) || payload.__error === true || payload.ok === false) continue
          const mode =
            payload.mode === 'on' || payload.mode === 'off'
              ? payload.mode
              : payload.action === 'enter'
                ? 'on'
                : payload.action === 'exit'
                  ? 'off'
                  : null
          if (mode === null) continue
          model.known = true
          model.on = mode === 'on'
          model.source = 'tower_control'
          if (typeof payload.changedBy === 'string') model.lastBy = payload.changedBy
          if (typeof payload.reason === 'string' && payload.reason.trim() !== '') model.lastReason = payload.reason.trim()
          continue
        }
        if (toolName === 'tower_status') {
          const payload = parsePayload(node)
          if (isPlainObject(payload)) {
            const name = repoNameOf(payload.repoRoot)
            if (name !== null) model.repo = name
          }
        }
      }
      return model
    }
    const EMPTY_MODE = {
      writer: null,
      known: false,
      on: null,
      denied: null,
      repo: null,
      lock: null,
      lastBy: null,
      lastReason: null,
      source: null,
    }
    function createModeStore(diagnostics, helpers) {
      const { isPlainObject } = helpers
      // All mutable client state lives in this closure, never at module scope
      // (client-ambient).
      const state = { value: Object.assign({}, EMPTY_MODE), seq: 0 }
      const listeners = new Set()

      function nextDockWriter() {
        state.seq += 1
        return 'dock-' + state.seq
      }
      function modeSnapshot() {
        return state.value
      }
      function subscribeMode(listener) {
        listeners.add(listener)
        return function () {
          listeners.delete(listener)
        }
      }
      function sameMode(left, right) {
        return (
          left.known === right.known &&
          left.on === right.on &&
          JSON.stringify(left.denied) === JSON.stringify(right.denied) &&
          left.repo === right.repo &&
          JSON.stringify(left.lock) === JSON.stringify(right.lock) &&
          left.lastBy === right.lastBy &&
          left.source === right.source
        )
      }
      function notifyMode() {
        for (const listener of Array.from(listeners)) {
          try {
            listener()
          } catch (error) {
            /* a broken registration reconciler must not break the dock */
          }
        }
      }
      function publishMode(writer, next) {
        const value = {
          writer,
          known: next.known === true,
          on: next.known === true && next.on === true,
          denied: Array.isArray(next.denied) ? next.denied.slice() : null,
          repo: typeof next.repo === 'string' && next.repo !== '' ? next.repo : null,
          lock: isPlainObject(next.lock) ? { enabled: next.lock.enabled === true, held: next.lock.held === true } : null,
          lastBy: typeof next.lastBy === 'string' && next.lastBy !== '' ? next.lastBy : null,
          lastReason: typeof next.lastReason === 'string' && next.lastReason !== '' ? next.lastReason : null,
          source: typeof next.source === 'string' ? next.source : null,
        }
        diagnostics.mode = { known: value.known, on: value.on, denied: value.denied }
        if (sameMode(value, state.value)) {
          state.value = value
          return
        }
        state.value = value
        notifyMode()
      }
      function clearMode(writer) {
        if (state.value.writer !== writer) return
        const empty = Object.assign({}, EMPTY_MODE, { writer })
        if (sameMode(empty, state.value)) {
          state.value = empty
          return
        }
        state.value = empty
        diagnostics.mode = { known: false, on: null, denied: null }
        notifyMode()
      }

      return { nextDockWriter, modeSnapshot, subscribeMode, publishMode, clearMode, sameMode }
    }

    return { EMPTY_MODE, towerCommandAction, repoNameOf, modeModelFromLegacy, createModeStore }
  },
})
