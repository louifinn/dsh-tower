// dsh-tower-ui 0.2.2 — tool vocabulary and the defensive payload helpers.
//
// Every helper is defensive: a tool result is durable user-facing data and may
// be an older shape, a partial stream, an error, or plain text instead of
// JSON. Package-local chunk loaded by client.js (#71); the translation helpers
// are injected once so the module stays free of top-level state.
window.__ModuleLoader__.load({
  id: 'dsh-tower-ui',
  chunk: 'client.helpers.js',
  factory() {
    const MAX_TEXT = 150
    const TOOL_NAMES = [
      'tower_status',
      'tower_roster',
      'tower_spawn',
      'tower_mission',
      'tower_complete',
      'tower_review',
      'tower_preflight',
      'tower_merge',
      'tower_teardown',
      'tower_interrupt',
      'tower_doctor',
      'tower_batch',
    ]
    const TOOL_SET = new Set(TOOL_NAMES)
    // Mirrors lib/config.js DEFAULT_DENY_TOOLS; overridden by the
    // `deniedWhileActive` list of the latest `tower_mode` output when present.
    const DEFAULT_DENIED_TOOLS = [
      'create_goal',
      'todo_write',
      'team_task_create',
      'team_task_update',
      'team_task_reopen',
      'team_task_list',
      'spawn_teammate',
      'wait_agent',
      'workflow',
      'ralph',
      'subagent',
      'subagent_fork',
    ]

    function createHelpers(translate) {
      function isTowerTool(name) {
        return typeof name === 'string' && TOOL_SET.has(name)
      }
      function truncate(value, max) {
        const text = String(value === undefined || value === null ? '' : value)
          .replace(/\s+/g, ' ')
          .trim()
        const limit = max === undefined ? MAX_TEXT : max
        return text.length > limit ? text.slice(0, limit - 1) + '…' : text
      }
      function firstLine(value, max) {
        const text = String(value === undefined || value === null ? '' : value)
        const line = text.split('\n')[0]
        return truncate(line, max)
      }
      function shortCommit(value) {
        if (typeof value !== 'string' || value === '') return ''
        return value.slice(0, 7)
      }
      function isPlainObject(value) {
        return value !== null && typeof value === 'object' && !Array.isArray(value)
      }
      function textOfBlock(block) {
        if (!isPlainObject(block)) return ''
        const parts = []
        if (Array.isArray(block.content)) {
          for (const item of block.content) {
            if (!isPlainObject(item)) continue
            if (typeof item.text === 'string') parts.push(item.text)
          }
        }
        if (parts.length === 0 && typeof block.text === 'string') parts.push(block.text)
        return parts.join('\n')
      }
      function errorOfBlock(block) {
        if (!isPlainObject(block)) return null
        if (isPlainObject(block.error)) return block.error
        if (block.isError === true) return { name: 'ToolError', code: 'error' }
        return null
      }
      function parsePayload(block) {
        if (!isPlainObject(block)) return null
        const error = errorOfBlock(block)
        if (error !== null) return { __error: true, error }
        const text = textOfBlock(block).trim()
        if (text === '') return null
        if (text[0] === '{' || text[0] === '[') {
          try {
            const parsed = JSON.parse(text)
            if (isPlainObject(parsed)) return parsed
            if (Array.isArray(parsed)) return { items: parsed }
          } catch (error) {
            /* fall through to text */
          }
        }
        return { text }
      }
      function blockersOf(value) {
        if (!Array.isArray(value)) return []
        const out = []
        for (const entry of value) {
          if (typeof entry === 'string' && entry.trim() !== '') out.push(entry.trim())
          else if (isPlainObject(entry)) {
            const code = typeof entry.code === 'string' ? entry.code : 'blocker'
            const detail = typeof entry.detail === 'string' ? entry.detail : ''
            out.push(detail === '' ? code : code + ': ' + detail)
          }
        }
        return out
      }
      function missionBlocksOf(value) {
        if (!Array.isArray(value)) return []
        return value.filter((entry) => typeof entry === 'string' && entry.trim() !== '').map((entry) => entry.trim())
      }
      function countsOf(payload) {
        if (!isPlainObject(payload) || !isPlainObject(payload.counts)) return null
        const counts = payload.counts
        let total = 0
        const byStatus = {}
        let hasAny = false
        for (const key of Object.keys(counts)) {
          const value = counts[key]
          if (typeof value !== 'number' || !Number.isFinite(value)) continue
          hasAny = true
          byStatus[key] = value
          total += value
        }
        if (!hasAny) return null
        return { total, byStatus, active: typeof byStatus.active === 'number' ? byStatus.active : 0 }
      }
      function taskCountsOf(tasks) {
        if (Array.isArray(tasks)) {
          const counts = { total: tasks.length, done: 0, open: 0, dropped: 0 }
          for (const task of tasks) {
            const status = isPlainObject(task) ? task.status : undefined
            if (status === 'done') counts.done += 1
            else if (status === 'dropped') counts.dropped += 1
            else counts.open += 1
          }
          return counts
        }
        if (isPlainObject(tasks)) {
          const total = typeof tasks.total === 'number' ? tasks.total : null
          if (total === null) return null
          const done = typeof tasks.done === 'number' ? tasks.done : 0
          const open = typeof tasks.open === 'number' ? tasks.open : Math.max(0, total - done - (typeof tasks.dropped === 'number' ? tasks.dropped : 0))
          return { total, done, open, dropped: typeof tasks.dropped === 'number' ? tasks.dropped : 0 }
        }
        return null
      }
      function toneForStatus(status) {
        if (typeof status !== 'string') return 'none'
        if (/^(merged|completed|clean|done|fixed|ok)$/.test(status)) return 'ok'
        if (/^(blocked|abandoned|failed)$/.test(status) || /^p1-/.test(status)) return 'error'
        if (/^(paused|stale|missing|p2-)/.test(status)) return 'warn'
        return 'idle'
      }
      function toneForPayload(payload) {
        if (!isPlainObject(payload)) return 'none'
        if (payload.ok === false) return 'error'
        if (blockersOf(payload.blockers).length > 0) return 'error'
        if (payload.ok === true) return 'ok'
        if (isPlainObject(payload.review)) return toneForStatus(payload.review.status)
        if (isPlainObject(payload.mission)) return toneForStatus(payload.mission.status)
        if (isPlainObject(payload.review) === false && payload.review === null) return 'idle'
        return 'idle'
      }
      function checkEntries(checks) {
        if (!Array.isArray(checks)) return []
        const out = []
        for (const entry of checks) {
          if (typeof entry === 'string') {
            const text = entry.trim()
            if (text !== '') out.push({ name: truncate(text, 80), ok: null, code: null, detail: '' })
            continue
          }
          if (!isPlainObject(entry)) continue
          const name =
            typeof entry.name === 'string' && entry.name !== ''
              ? entry.name
              : typeof entry.id === 'string' && entry.id !== ''
                ? entry.id
                : 'check'
          const code = typeof entry.exitCode === 'number' ? entry.exitCode : null
          const ok =
            code !== null
              ? code === 0
              : entry.status === 'pass'
                ? true
                : entry.status === 'fail'
                  ? false
                  : entry.ok === true
                    ? true
                    : entry.ok === false
                      ? false
                      : null
          out.push({
            name: truncate(name, 80),
            ok,
            code,
            detail: typeof entry.detail === 'string' ? entry.detail : typeof entry.evidence === 'string' ? entry.evidence : '',
          })
        }
        return out
      }
      function checkText(t, entry) {
        const base =
          entry.code !== null
            ? translate(t, entry.ok ? 'card.checkOk' : 'card.checkFail', {
                name: entry.name,
                code: entry.code,
              })
            : entry.name
        return entry.detail ? truncate(base + ': ' + entry.detail, 120) : base
      }
      function checkSummary(t, checks) {
        const entries = checkEntries(checks)
        if (entries.length === 0) return ''
        const passed = entries.filter((entry) => entry.ok === true).length
        const known = entries.filter((entry) => entry.ok !== null).length
        if (known > 0) return translate(t, 'card.checksCount', { passed, total: known })
        return String(entries.length)
      }
      function missionLine(t, mission) {
        if (!isPlainObject(mission)) return ''
        const id = typeof mission.id === 'string' ? mission.id : translate(t, 'card.missionMissing')
        const status = typeof mission.status === 'string' ? mission.status : translate(t, 'card.unknown')
        const parts = [translate(t, 'card.missionLine', { id, status })]
        const tasks = taskCountsOf(mission.tasks)
        if (tasks !== null && tasks.total > 0) {
          parts.push(translate(t, 'card.tasks', { done: tasks.done, total: tasks.total }))
        }
        if (missionBlocksOf(mission.blockers).length > 0) {
          parts.push(String(missionBlocksOf(mission.blockers).length) + ' ⚠')
        }
        return parts.join(translate(t, 'card.sep'))
      }

      return {
        MAX_TEXT,
        TOOL_NAMES,
        TOOL_SET,
        DEFAULT_DENIED_TOOLS,
        isTowerTool,
        truncate,
        firstLine,
        shortCommit,
        isPlainObject,
        textOfBlock,
        errorOfBlock,
        parsePayload,
        blockersOf,
        missionBlocksOf,
        countsOf,
        taskCountsOf,
        toneForStatus,
        toneForPayload,
        checkEntries,
        checkText,
        checkSummary,
        missionLine,
      }
    }

    return { MAX_TEXT, TOOL_NAMES, TOOL_SET, DEFAULT_DENIED_TOOLS, createHelpers }
  },
})
