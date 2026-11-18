// dsh-tower-ui 0.2.2 — the mode-aware denied-tool row surface (#12).
//
// The entries exist only while the session is in Tower mode and register at a
// negative priority so the native toolviews return when the mode turns off.
// A denied tool is still an ordinary tool row: the primitives `DisclosureRow`
// is the collapsed (and running) chrome, and only the explanation — the
// localized reason and the `/tower off` next step — lives in the native
// io-card body while the row is expanded. The raw host denial sentence is a
// detection signal, never visible copy. Package-local chunk (#71).
window.__ModuleLoader__.load({
  id: 'dsh-tower-ui',
  chunk: 'client.denied.js',
  factory() {
    function createDenied(env) {
      const { h, translate, seatT, ST, helpers, primitives } = env
      const { isPlainObject, textOfBlock, truncate, firstLine, parsePayload, DEFAULT_DENIED_TOOLS } = helpers
      const DisclosureRow = primitives && primitives.DisclosureRow
      const RowIcon = primitives && primitives.IconChecklistOutlineRegular
      // The default deny list is a set of foreign orchestration tools whose wire
      // names are not user-facing copy. Every one of them gets a localized name
      // here; a custom denied tool keeps its own name, exactly like the native
      // row renders an unknown foreign tool.
      const FRIENDLY_NAMES = {
        wait_agent: 'deny.tool.wait_agent',
        send_message: 'deny.tool.send_message',
        list_agents: 'deny.tool.list_agents',
        interrupt_agent: 'deny.tool.interrupt_agent',
        spawn_teammate: 'deny.tool.spawn_teammate',
        subagent: 'deny.tool.subagent',
        subagent_fork: 'deny.tool.subagent_fork',
        workflow: 'deny.tool.workflow',
        ralph: 'deny.tool.ralph',
        todo_write: 'deny.tool.todo_write',
        create_goal: 'deny.tool.create_goal',
        get_goal: 'deny.tool.get_goal',
        update_goal: 'deny.tool.update_goal',
        team_task_create: 'deny.tool.team_task_create',
        team_task_get: 'deny.tool.team_task_get',
        team_task_list: 'deny.tool.team_task_list',
        team_task_update: 'deny.tool.team_task_update',
      }
      function noop() {}
      function friendlyName(t, toolName) {
        if (typeof toolName !== 'string' || toolName === '') return translate(t, 'card.title')
        const key = FRIENDLY_NAMES[toolName]
        return key === undefined ? toolName : translate(t, key)
      }

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
        // Legacy outputs from <= 2.8.0 omitted update_goal from the deny list
        // (the guard special-cased action:"resume" then); since #161 the whole
        // goal-owner surface is denied by default, so this only patches rows
        // built from an old tower_mode result.
        if (!names.includes('update_goal')) names.push('update_goal')
        return names
      }

      // One native ioSection: the ioLabel caption plus the ioText value. An
      // error value is marked with `data-error`, like the native generic row.
      function sectionElement(t, key, labelKey, value, error) {
        return h(
          'div',
          { key, style: ST.ioSection },
          h('span', { key: 'label', style: ST.ioLabel }, translate(t, labelKey)),
          h(
            'span',
            {
              key: 'text',
              style: error === true ? Object.assign({}, ST.ioText, ST.ioTextError) : ST.ioText,
              'data-error': error === true ? true : undefined,
            },
            value,
          ),
        )
      }
      function bodyOf(t, children) {
        return h('div', { key: 'body', style: ST.bodyWrap }, h('div', { key: 'card', style: ST.ioCard }, children))
      }
      function denialBody(t) {
        return bodyOf(t, [
          sectionElement(t, 'reason', 'deny.reasonLabel', translate(t, 'deny.reason'), false),
          h('span', { key: 'divider', 'aria-hidden': true, style: ST.ioDivider }),
          sectionElement(t, 'next', 'deny.nextLabel', translate(t, 'deny.hint'), false),
        ])
      }
      function errorBody(t, reason) {
        return bodyOf(t, [sectionElement(t, 'error', 'card.error', reason, true)])
      }
      function errorReasonOf(error) {
        if (!isPlainObject(error)) return ''
        if (typeof error.message === 'string' && error.message.trim() !== '') return firstLine(error.message, 400)
        if (typeof error.code === 'string' && error.code.trim() !== '') return firstLine(error.code, 120)
        return ''
      }

      function DeniedToolRow(props) {
        // The keyed entry replaces the host row, so without the native row
        // component the host's own row must stay in place (client.js does not
        // register these entries then); rendering nothing is the defensive
        // equivalent of that fallback, never a hand-built lookalike.
        if (!DisclosureRow) return null
        const t = seatT(props)
        const toolName = props && typeof props.toolName === 'string' ? props.toolName : ''
        const phase = props && typeof props.phase === 'string' ? props.phase : 'start'
        const running = phase !== 'result'
        const block = props ? props.block : undefined
        const disclosure = typeof props.useDisclosure === 'function' ? props.useDisclosure() : null
        const expanded = Boolean(disclosure && disclosure.expanded === true)
        const toggle = disclosure && typeof disclosure.toggle === 'function' ? disclosure.toggle : noop
        const denial = running ? null : denialMessageOf(block)
        const payload = running ? null : parsePayload(block)
        const failed = isPlainObject(payload) && payload.__error === true
        let view = 'generic'
        let summary = translate(t, 'card.done')
        let summaryStyle = ST.summary
        let expandable = false
        let body = undefined
        if (running) {
          view = 'running'
          summary = translate(t, 'deny.running')
          summaryStyle = Object.assign({}, ST.summary, ST.summaryWarn)
        } else if (denial !== null) {
          view = 'denied'
          summary = translate(t, 'deny.summary')
          summaryStyle = Object.assign({}, ST.summary, ST.summaryWarn)
          expandable = true
          if (expanded) body = denialBody(t)
        } else if (failed) {
          summary = translate(t, 'deny.error')
          summaryStyle = Object.assign({}, ST.summary, ST.summaryError)
          expandable = true
          const reason = errorReasonOf(payload.error)
          if (expanded) body = errorBody(t, reason === '' ? translate(t, 'deny.error') : reason)
        }
        const open = expanded && expandable
        return h(
          'div',
          { 'data-tower-toolview': toolName, 'data-tower-denied-view': view },
          h(DisclosureRow, {
            icon: RowIcon ? h(RowIcon, { size: 14 }) : undefined,
            title: friendlyName(t, toolName),
            running,
            open,
            expandable,
            expandOnRowClick: true,
            keepContentWhenOpen: true,
            onToggle: toggle,
            collapsedContent: [
              h('span', { key: 'sep', 'aria-hidden': true, 'data-shimmer-decoration': true, style: ST.sep }),
              h('span', { key: 'summary', style: summaryStyle }, summary),
            ],
            children: open ? body : undefined,
          }),
        )
      }

      return { denialMessageOf, normalizeDenialText, deniedNames, DeniedToolRow }
    }

    return { createDenied }
  },
})
