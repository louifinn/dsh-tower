// dsh-tower-ui 0.2.2 — the mode-aware denied-tool row surface (#12).
//
// The entries exist only while the session is in Tower mode and register at a
// negative priority so the native toolviews return when the mode turns off.
// Package-local chunk (#71).
window.__ModuleLoader__.load({
  id: 'dsh-tower-ui',
  chunk: 'client.denied.js',
  factory() {
    function createDenied(env) {
      const { h, translate, seatT, ST, dotStyle, helpers } = env
      const { isPlainObject, textOfBlock, truncate, firstLine, parsePayload, DEFAULT_DENIED_TOOLS } = helpers

      function denialMessageOf(block) {
        if (!isPlainObject(block)) return null
        const candidates = []
        if (isPlainObject(block.error) && typeof block.error.message === 'string') candidates.push(block.error.message)
        const text = textOfBlock(block)
        if (text !== '') candidates.push(text)
        if (typeof block.text === 'string') candidates.push(block.text)
        for (const raw of candidates) {
          const message = normalizeDenialText(raw)
          if (message !== null) return message
        }
        return null
      }
      function normalizeDenialText(raw) {
        let value = String(raw === undefined || raw === null ? '' : raw).trim()
        if (value === '') return null
        if (value[0] === '{') {
          try {
            const parsed = JSON.parse(value)
            if (isPlainObject(parsed) && typeof parsed.message === 'string') value = parsed.message.trim()
          } catch (error) {
            /* keep the raw text */
          }
        }
        value = value.replace(/^Error:\s*/i, '')
        const lower = value.toLowerCase()
        if (!lower.includes('tower mode')) return null
        const specific =
          lower.includes('is disabled while tower mode is active') ||
          lower.includes('goals cannot be resumed while tower mode is active')
        if (!specific && !lower.includes('/tower off')) return null
        return truncate(value, 400)
      }
      function deniedNames(configured) {
        const source = Array.isArray(configured) && configured.length > 0 ? configured : DEFAULT_DENIED_TOOLS
        const names = []
        for (const entry of source) {
          if (typeof entry !== 'string') continue
          const name = entry.trim()
          if (name === '' || names.includes(name)) continue
          names.push(name)
        }
        // update_goal is denied only for action:"resume", but the guard special
        // case exists regardless of the configured denyTools list.
        if (!names.includes('update_goal')) names.push('update_goal')
        return names
      }
      function DeniedToolRow(props) {
        const t = seatT(props)
        const toolName = props && typeof props.toolName === 'string' ? props.toolName : ''
        const phase = props && typeof props.phase === 'string' ? props.phase : 'start'
        if (phase !== 'result') {
          return h(
            'div',
            { 'data-tower-toolview': toolName, 'data-tower-denied-view': 'running', style: ST.denyCard },
            h(
              'div',
              { style: ST.header },
              h('span', { 'aria-hidden': true, style: dotStyle('idle') }),
              h('span', { style: ST.denyLabel }, translate(t, 'deny.label')),
              h('span', { style: ST.dim }, '·'),
              h('span', { style: ST.title }, toolName),
              h('span', { style: ST.dim }, translate(t, 'deny.running')),
            ),
          )
        }
        const denial = denialMessageOf(props ? props.block : undefined)
        if (denial !== null) {
          return h(
            'div',
            {
              'data-tower-toolview': toolName,
              'data-tower-denied-view': 'denied',
              role: 'note',
              style: ST.denyCard,
              title: denial,
            },
            h(
              'div',
              { style: ST.header },
              h('span', { 'aria-hidden': true, style: dotStyle('warn') }),
              h('span', { style: ST.denyLabel }, translate(t, 'deny.label')),
              h('span', { style: ST.dim }, '·'),
              h('span', { style: ST.title }, toolName),
            ),
            h('div', { style: ST.row }, denial),
            h('div', { style: ST.denyHint }, translate(t, 'deny.hint')),
          )
        }
        // Defensive fallback: the slot is ours only while Tower mode is on, so
        // a non-denial result here has no native view to delegate to.
        const payload = parsePayload(props ? props.block : undefined)
        const error =
          isPlainObject(props) && isPlainObject(props.block) && isPlainObject(props.block.error) ? props.block.error : null
        let text = translate(t, 'deny.generic', { tool: toolName })
        let tone = 'ok'
        if (isPlainObject(payload) && payload.__error === true) {
          tone = 'error'
          const reason =
            error !== null && typeof error.message === 'string'
              ? error.message
              : error !== null && typeof error.code === 'string'
                ? error.code
                : 'error'
          text = translate(t, 'deny.error') + ': ' + firstLine(reason)
        } else if (isPlainObject(payload) && typeof payload.text === 'string' && payload.text.trim() !== '') {
          text = translate(t, 'deny.generic', { tool: toolName }) + translate(t, 'card.sep') + firstLine(payload.text)
        }
        return h(
          'div',
          { 'data-tower-toolview': toolName, 'data-tower-denied-view': 'generic', style: ST.denyCard },
          h(
            'div',
            { style: ST.header },
            h('span', { 'aria-hidden': true, style: dotStyle(tone) }),
            h('span', { style: ST.title }, translate(t, 'card.title')),
            h('span', { style: ST.dim }, '·'),
            h('span', { style: ST.title }, toolName),
            h('span', { style: tone === 'error' ? ST.rowError : ST.dim }, truncate(text, 120)),
          ),
        )
      }

      return { denialMessageOf, normalizeDenialText, deniedNames, DeniedToolRow }
    }

    return { createDenied }
  },
})
