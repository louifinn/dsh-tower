// dsh-tower-ui 0.2.2 — the toolview card surface (one keyed view per tool).
//
// A keyed `tool.call.toolview` entry REPLACES the native tool row (the host
// renderSlot in `dsh-client-ui-tool` only falls back when no keyed entry
// matches), so this chunk renders the native chrome itself: the UI-primitives
// `DisclosureRow` from the shell's static module table, driven by the
// host-supplied `useDisclosure()` seat hook (`{ expanded, toggle }`) exactly
// like the native `ToolRow`. Collapsed, it is the native row (icon, title,
// one-line summary, hover chevron); the curated detail rows live only in
// `children`, and `DisclosureRow` renders `open && children`, so the body
// exists only while expanded. The lifecycle transitions still publish into the
// notice store the root-scoped overlay injects. Package-local chunk (#71).
window.__ModuleLoader__.load({
  id: 'dsh-tower-ui',
  chunk: 'client.toolview.js',
  factory() {
    function createToolview(env) {
      const { React, h, translate, toolLabel, seatT, ST, helpers, cards, notice, primitives } = env
      const { isTowerTool, parsePayload, isPlainObject, truncate } = helpers
      const { rowElement, cardModel } = cards
      const publishNotice = notice.publish
      // Resolved once by the entry from the browser module table; the host
      // primitives namespace is a static seed word, not a package dependency.
      const DisclosureRow = primitives.DisclosureRow
      const RowIcon = primitives.IconChecklistOutlineRegular
      function noop() {}

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
        // `ToolCall` always supplies the seat hook; the fallback keeps an
        // unexpected caller collapsed instead of throwing.
        const disclosure = typeof props.useDisclosure === 'function' ? props.useDisclosure() : null
        const expanded = Boolean(disclosure && disclosure.expanded === true)
        const toggle = disclosure && typeof disclosure.toggle === 'function' ? disclosure.toggle : noop
        useToolviewLifecycle(props)
        let payload = null
        if (!running) payload = parsePayload(props ? props.block : undefined)
        const model = running
          ? { tone: 'idle', headline: translate(t, 'card.running'), rows: [] }
          : cardModel(toolName, payload, t)
        // Only a settled result with curated detail is expandable; native rows
        // get the same treatment from DisclosureRow (`expandOnRowClick`).
        const expandable = !running && model.rows.length > 0
        // The open body is the native generic tool-result surface:
        // bodyWrap > ioCard, one ioSection per curated row, with an ioDivider
        // between adjacent sections. It is built only while open, so the card
        // never exists in the collapsed state. The flat keyed list keeps React
        // keys on both the sections and the dividers.
        const rows = expanded && expandable ? model.rows.slice(0, 6) : []
        const bodyChildren = []
        for (let index = 0; index < rows.length; index += 1) {
          if (index > 0) {
            bodyChildren.push(h('span', { key: 'divider-' + index, 'aria-hidden': true, style: ST.ioDivider }))
          }
          bodyChildren.push(rowElement(t, index, rows[index]))
        }
        return h(
          'div',
          {
            'data-tower-toolview': toolName === '' ? 'tower_unknown' : toolName,
            'data-tower-phase': phase,
          },
          h(DisclosureRow, {
            icon: RowIcon ? h(RowIcon, { size: 14 }) : undefined,
            title: toolLabel(t, toolName),
            running,
            open: expanded && expandable,
            expandable,
            expandOnRowClick: true,
            keepContentWhenOpen: true,
            onToggle: toggle,
            collapsedContent: [
              h('span', { key: 'sep', 'aria-hidden': true, 'data-shimmer-decoration': true, style: ST.sep }),
              h(
                'span',
                { key: 'headline', style: running || model.tone !== 'error' ? ST.summary : Object.assign({}, ST.summary, ST.rowError) },
                truncate(model.headline, 100),
              ),
            ],
            children:
              rows.length > 0
                ? h(
                    'div',
                    { key: 'body', style: ST.bodyWrap },
                    h('div', { key: 'card', style: ST.ioCard }, bodyChildren),
                  )
                : undefined,
          }),
        )
      }

      return { TowerToolCard }
    }

    return { createToolview }
  },
})
