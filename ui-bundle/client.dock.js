// dsh-tower-ui 0.2.2 — the composer dock surface (#11 + latest summary).
//
// The chip is history-derived; the dock only reads the `useChat` legacy slice
// and never polls or fetches Host state. Package-local chunk (#71).
window.__ModuleLoader__.load({
  id: 'dsh-tower-ui',
  chunk: 'client.dock.js',
  factory() {
    function createDock(env) {
      const { React, h, translate, toolLabel, seatT, ST, dotStyle, helpers, mode } = env
      const { modeModelFromLegacy } = env
      const {
        isPlainObject,
        parsePayload,
        isTowerTool,
        countsOf,
        toneForStatus,
        shortCommit,
        blockersOf,
      } = helpers
      const { nextDockWriter, publishMode, clearMode } = mode

      function renderDockHint(t) {
        return h(
          'div',
          {
            'data-tower-ui': 'dock-hint',
            title: translate(t, 'dock.hint.title'),
            style: ST.hint,
          },
          h('span', { 'aria-hidden': true }, '⌘'),
          h('span', null, '/tower'),
        )
      }
      function latestTowerSignal(legacy) {
        if (!isPlainObject(legacy)) return null
        const running = Array.isArray(legacy.runningCalls) ? legacy.runningCalls : []
        for (let index = running.length - 1; index >= 0; index -= 1) {
          const block = running[index]
          if (isPlainObject(block) && isTowerTool(block.name)) return { name: block.name, phase: 'start', block }
        }
        const nodes = Array.isArray(legacy.nodes) ? legacy.nodes : []
        for (let index = nodes.length - 1; index >= 0; index -= 1) {
          const block = nodes[index]
          const name = isPlainObject(block) && isPlainObject(block.call) ? block.call.name : undefined
          if (isTowerTool(name)) return { name, phase: 'result', block }
        }
        return null
      }
      function dockResultModel(toolName, payload) {
        if (!isPlainObject(payload)) return { tool: toolName, running: false, tone: 'none', key: 'dock.generic' }
        if (payload.__error === true) return { tool: toolName, running: false, tone: 'error', key: 'dock.generic' }
        if (typeof payload.text === 'string') {
          return { tool: toolName, running: false, tone: 'idle', key: 'dock.generic' }
        }
        const blockers = blockersOf(payload.blockers)
        if (toolName === 'tower_status') {
          const counts = countsOf(payload)
          const open = typeof payload.openTasks === 'number' ? payload.openTasks : 0
          if (counts !== null) {
            return { tool: toolName, running: false, tone: open > 0 ? 'warn' : 'ok', key: 'dock.statusCounts', params: { total: counts.total, active: counts.active, open } }
          }
          return { tool: toolName, running: false, tone: 'ok', key: 'dock.generic' }
        }
        if (toolName === 'tower_roster') {
          const roster = Array.isArray(payload.roster) ? payload.roster : []
          let live = 0
          for (const entry of roster) if (isPlainObject(entry) && entry.activity === 'running') live += 1
          return { tool: toolName, running: false, tone: live > 0 ? 'ok' : 'idle', key: 'dock.rosterCounts', params: { live, total: roster.length } }
        }
        if (toolName === 'tower_review' && isPlainObject(payload.review)) {
          return {
            tool: toolName,
            running: false,
            tone: toneForStatus(payload.review.status),
            key: 'dock.review',
            params: {
              status: typeof payload.review.status === 'string' ? payload.review.status : '?',
              merge: typeof payload.review.mergeVerdict === 'string' ? payload.review.mergeVerdict : '?',
            },
          }
        }
        if (toolName === 'tower_preflight') {
          return payload.ok === true
            ? { tool: toolName, running: false, tone: 'ok', key: 'dock.ready' }
            : { tool: toolName, running: false, tone: 'error', key: 'dock.blocked', params: { count: blockers.length } }
        }
        if (toolName === 'tower_merge') {
          return payload.ok === true
            ? { tool: toolName, running: false, tone: 'ok', key: 'dock.merged', params: { commit: shortCommit(payload.mergedCommit) } }
            : { tool: toolName, running: false, tone: 'error', key: 'dock.blocked', params: { count: blockers.length } }
        }
        if (toolName === 'tower_complete' && isPlainObject(payload.mission)) {
          return {
            tool: toolName,
            running: false,
            tone: 'ok',
            key: 'dock.complete',
            params: { mission: typeof payload.mission.id === 'string' ? payload.mission.id : '?', commits: typeof payload.commits === 'number' ? payload.commits : 0 },
          }
        }
        if (toolName === 'tower_mission' && isPlainObject(payload.mission)) {
          return {
            tool: toolName,
            running: false,
            tone: toneForStatus(payload.mission.status),
            key: 'dock.mission',
            params: { id: typeof payload.mission.id === 'string' ? payload.mission.id : '?', status: typeof payload.mission.status === 'string' ? payload.mission.status : '?' },
          }
        }
        if (toolName === 'tower_spawn') {
          return {
            tool: toolName,
            running: false,
            tone: 'ok',
            key: 'dock.spawn',
            params: {
              role: typeof payload.role === 'string' ? payload.role : '?',
              name: typeof payload.name === 'string' ? payload.name : '?',
              mission: typeof payload.missionId === 'string' ? payload.missionId : '?',
            },
          }
        }
        if (toolName === 'tower_teardown') {
          return {
            tool: toolName,
            running: false,
            tone: 'ok',
            key: 'dock.removed',
            params: { count: Array.isArray(payload.removed) ? payload.removed.length : 0 },
          }
        }
        if (toolName === 'tower_interrupt') {
          const name = isPlainObject(payload.entry) && typeof payload.entry.name === 'string' ? payload.entry.name : '?'
          return payload.interrupted === true
            ? { tool: toolName, running: false, tone: 'warn', key: 'dock.interrupt', params: { name } }
            : { tool: toolName, running: false, tone: 'idle', key: 'dock.generic' }
        }
        if (toolName === 'tower_doctor') {
          return {
            tool: toolName,
            running: false,
            tone: payload.ok === true ? 'ok' : 'warn',
            key: 'dock.doctor',
            params: { status: payload.ok === true ? 'ok' : 'issues' },
          }
        }
        if (toolName === 'tower_batch') {
          const summary = isPlainObject(payload.summary) ? payload.summary : isPlainObject(payload.batch) ? payload.batch : null
          const failed = summary !== null && Array.isArray(summary.failedChecks) ? summary.failedChecks.length : 0
          const pending = summary !== null && Array.isArray(summary.pendingChecks) ? summary.pendingChecks.length : 0
          const tone = payload.ok === true && failed === 0 && pending === 0 ? 'ok' : failed > 0 ? 'error' : 'warn'
          return {
            tool: toolName,
            running: false,
            tone,
            key: 'dock.batch',
            params: { status: summary !== null && typeof summary.status === 'string' ? summary.status : payload.ok === true ? 'ok' : 'issues' },
          }
        }
        return { tool: toolName, running: false, tone: 'idle', key: 'dock.generic' }
      }
      function dockSelector(snapshot) {
        try {
          const legacy = snapshot ? snapshot.legacy : undefined
          const modeModel = modeModelFromLegacy(legacy, helpers)
          let summary = null
          // While the chip is on it is the dock's message; the summary returns
          // after /tower off.
          if (!(modeModel.known === true && modeModel.on === true)) {
            const signal = latestTowerSignal(legacy)
            if (signal !== null) {
              summary =
                signal.phase !== 'result'
                  ? { tool: signal.name, running: true, tone: 'idle' }
                  : dockResultModel(signal.name, parsePayload(signal.block))
            }
          }
          return JSON.stringify({
            mode: modeModel,
            summary,
            // A Tower result with no mode event cannot prove the stance; surface
            // that explicitly instead of pretending the session is off.
            uncertain: modeModel.known !== true && summary !== null && summary.running !== true,
          })
        } catch (error) {
          return ''
        }
      }
      function modeStorageKey(sessionId) {
        return 'dsh-tower-ui:mode:' + String(sessionId)
      }
      function readStoredMode(sessionId) {
        if (typeof sessionId !== 'string' || sessionId === '') return null
        try {
          const raw = globalThis.localStorage && globalThis.localStorage.getItem(modeStorageKey(sessionId))
          if (!raw) return null
          const parsed = JSON.parse(raw)
          if (!isPlainObject(parsed) || typeof parsed.at !== 'number') return null
          if (Date.now() - parsed.at > 7 * 24 * 60 * 60 * 1000) return null
          return parsed
        } catch {
          return null
        }
      }
      function writeStoredMode(sessionId, current) {
        if (typeof sessionId !== 'string' || sessionId === '') return
        try {
          if (!globalThis.localStorage) return
          if (current.known === true && (current.on === true || current.on === false)) {
            globalThis.localStorage.setItem(modeStorageKey(sessionId), JSON.stringify({
              on: current.on,
              denied: current.denied ?? null,
              repo: current.repo ?? null,
              lock: current.lock ?? null,
              lastBy: current.lastBy ?? null,
              lastReason: current.lastReason ?? null,
              at: Date.now(),
            }))
          }
        } catch {
          // storage is best effort; the history-derived model remains the source
        }
      }
      function modeTooltip(t, modeModel) {
        const parts = [translate(t, 'dock.mode.tooltip')]
        if (modeModel.source === 'stored') parts.push(translate(t, 'dock.mode.lastKnown'))
        if (typeof modeModel.repo === 'string' && modeModel.repo !== '') parts.push(translate(t, 'dock.mode.repo', { repo: modeModel.repo }))
        if (isPlainObject(modeModel.lock)) {
          parts.push(translate(t, modeModel.lock.held === true ? 'dock.mode.lockHeld' : 'dock.mode.lockFree'))
        }
        if (typeof modeModel.lastBy === 'string' && modeModel.lastBy !== '') parts.push(translate(t, 'dock.mode.lastBy', { by: modeModel.lastBy }))
        return parts.join(translate(t, 'card.sep'))
      }
      function renderModeChip(t, modeModel) {
        // Non-interactive on purpose: inputActions.submit() would submit (and
        // clobber) the composer draft; the tooltip is the affordance instead.
        return h(
          'div',
          {
            'data-tower-ui': 'dock-mode',
            'data-tower-mode': modeModel.on === true ? 'on' : 'off',
            role: 'status',
            'aria-live': 'polite',
            title: modeTooltip(t, modeModel),
            style: ST.modeChip,
          },
          h('span', { 'aria-hidden': true, style: dotStyle('ok') }),
          h('span', { style: ST.modeChipLabel }, translate(t, 'card.title')),
          h('span', { style: ST.dim }, '·'),
          h('span', { style: ST.modeChipOn }, translate(t, 'dock.mode.onLabel')),
        )
      }
      function renderModeUnknown(t) {
        return h(
          'div',
          {
            'data-tower-ui': 'dock-mode',
            'data-tower-mode': 'unknown',
            role: 'status',
            'aria-live': 'polite',
            title: translate(t, 'dock.mode.unknownTooltip'),
            style: ST.modeChip,
          },
          h('span', { 'aria-hidden': true, style: dotStyle('idle') }),
          h('span', { style: ST.modeChipLabel }, translate(t, 'card.title')),
          h('span', { style: ST.dim }, '·'),
          h('span', { style: ST.modeChipOn }, translate(t, 'dock.mode.unknownLabel')),
        )
      }
      function TowerDock(props) {
        const t = seatT(props)
        if (!props || typeof props.useChat !== 'function') return renderDockHint(t)
        return h(TowerDockLive, Object.assign({}, props, { t }))
      }
      function TowerDockLive(props) {
        const t = seatT(props)
        const raw = props.useChat(dockSelector)
        let model = null
        if (typeof raw === 'string' && raw !== '') {
          try {
            model = JSON.parse(raw)
          } catch (error) {
            model = null
          }
        }
        const modeFromHistory = isPlainObject(model) && isPlainObject(model.mode) ? model.mode : { known: false, on: null }
        const stored = modeFromHistory.known !== true ? readStoredMode(props.sessionId) : null
        const current = stored
          ? Object.assign({}, modeFromHistory, stored, { known: true, source: 'stored' })
          : modeFromHistory
        writeStoredMode(props.sessionId, modeFromHistory)
        const writerState = React.useState(function () {
          return nextDockWriter()
        })
        const writer = writerState[0]
        React.useEffect(
          function () {
            // Publish only the history-derived stance. A stored last-known value
            // is display-only: it must not shadow native toolviews.
            publishMode(writer, modeFromHistory)
            return function () {
              clearMode(writer)
            }
          },
          [JSON.stringify(modeFromHistory)],
        )
        if (current.known === true && current.on === true) return renderModeChip(t, current)
        if (isPlainObject(model) && model.uncertain === true) return renderModeUnknown(t)
        const summary = isPlainObject(model) ? model.summary : null
        if (!isPlainObject(summary)) return renderDockHint(t)
        const text = summary.running === true
          ? translate(t, 'dock.running', { tool: toolLabel(t, summary.tool) })
          : summary.key
            ? translate(t, summary.key, summary.params)
            : translate(t, 'dock.generic')
        const tone = summary.running === true ? 'idle' : summary.tone
        return h(
          'div',
          { 'data-tower-ui': 'dock', style: ST.dock, title: toolLabel(t, summary.tool) + translate(t, 'card.sep') + text },
          h('span', { 'aria-hidden': true, style: dotStyle(tone) }),
          h('span', { style: ST.dockTool }, toolLabel(t, summary.tool)),
          h('span', { style: ST.dim }, '·'),
          h('span', { style: ST.dockText }, text),
        )
      }

      return { TowerDock }
    }

    return { createDock }
  },
})
