// dsh-tower-ui 0.2.2 — the toolview card surface (one keyed view per tool).
//
// The chat-driven card publishes lifecycle transitions into the notice store
// the root-scoped overlay injects. Package-local chunk (#71).
window.__ModuleLoader__.load({
  id: 'dsh-tower-ui',
  chunk: 'client.toolview.js',
  factory() {
    function createToolview(env) {
      const { React, h, translate, toolLabel, seatT, ST, dotStyle, helpers, cards, notice } = env
      const { isTowerTool, parsePayload, isPlainObject, truncate } = helpers
      const { rowElement, cardModel } = cards
      const publishNotice = notice.publish

      // Mounting an already-settled result (history) stays silent; a live
      // preparing/start row and a start→result transition publish.
      function useToolviewLifecycle(props) {
        const phase = props ? props.phase : undefined
        const toolName = props ? props.toolName : undefined
        const callId = props ? props.callId : undefined
        const failed = Boolean(props && props.block && (props.block.isError === true || isPlainObject(props.block.error)))
        const previous = React.useRef ? React.useRef(null) : { current: null }
        React.useEffect(
          function () {
            const before = previous.current
            previous.current = { phase, callId }
            if (!isTowerTool(toolName)) return
            const sameCall = before !== null && before.callId === callId
            if (phase !== 'result') {
              if (!sameCall || before.phase !== phase) publishNotice({ tool: toolName, running: true })
            } else if (sameCall && before.phase !== 'result') {
              publishNotice({ tool: toolName, running: false, ok: failed !== true })
            }
          },
          [phase, callId, toolName, failed],
        )
      }

      function TowerToolCard(props) {
        const t = seatT(props)
        const toolName = props && typeof props.toolName === 'string' ? props.toolName : ''
        const phase = props && typeof props.phase === 'string' ? props.phase : 'start'
        const running = phase !== 'result'
        useToolviewLifecycle(props)
        let payload = null
        if (!running) payload = parsePayload(props ? props.block : undefined)
        const model = running
          ? { tone: 'idle', headline: translate(t, 'card.running'), rows: [] }
          : cardModel(toolName, payload, t)
        const title =
          toolLabel(t, toolName) +
          ' · ' +
          (running ? translate(t, 'card.running') : model.headline)
        return h(
          'div',
          {
            'data-tower-toolview': toolName === '' ? 'tower_unknown' : toolName,
            'data-tower-phase': phase,
            style: ST.card,
            title,
          },
          h(
            'div',
            { style: ST.header },
            h('span', { 'aria-hidden': true, style: dotStyle(running ? 'idle' : model.tone) }),
            h('span', { style: ST.title }, translate(t, 'card.title')),
            h('span', { style: ST.dim }, '·'),
            h('span', { style: ST.title }, toolLabel(t, toolName)),
            h('span', { style: running ? ST.dim : model.tone === 'error' ? ST.rowError : ST.dim }, truncate(model.headline, 100)),
          ),
          model.rows.slice(0, 6).map(function (row, index) {
            return rowElement(t, index, row)
          }),
        )
      }

      return { TowerToolCard }
    }

    return { createToolview }
  },
})
