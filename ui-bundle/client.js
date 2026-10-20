// dsh-tower-ui 0.2.1 — optional Web Client surfaces for the Tower plugin.
//
// Registrations, all plain React (no iframe, no DOM writes, no Host RPC, no
// Harness Client package imports):
//   1. `tool.call.toolview`  keyed cards for the twelve Tower tools.
//   2. `conversation.composer.dock` — a history-derived Tower-mode chip while
//      the displayed session is in Tower mode; otherwise the static `/tower`
//      hint when the conversation has no Tower result, or a compact
//      latest-status summary derived from the `useChat` standard prop.
//   3. `shell.overlay` — a transient, non-blocking status strip for Tower tool
//      start/result. The overlay slot is root-scoped, so it cannot read chat
//      state itself; the chat-driven keyed toolview components publish the
//      transition into a module-local observable that the overlay injects.
//   4. Dynamic `tool.call.toolview` entries for the tools Tower mode denies:
//      registered at a lower priority than the native views while the
//      displayed session is in Tower mode, disposed when it leaves the mode so
//      the native toolviews return. Denial results render as a distinct
//      `Tower mode · disabled` row instead of a generic tool error.
//   5. locale dictionaries for the `tower-ui` namespace (en/zh).
//
// Tower mode has no Client RPC. The dock derives it from the durable session
// history projected into the `useChat` legacy slice: the `/tower on|off`
// command node and the `tower_mode` / `tower_control` result blocks. A page
// refresh therefore re-derives the same stance from the loaded history window;
// history older than the loaded window yields the unknown/off fallback.
//
// The bundle is a plain-JS artifact loaded by `window.__ModuleLoader__`; React
// comes from the browser module table. Theme references are restricted to
// `--dsw-alias-*` tokens. `window.__TOWER_UI_DIAG__` is a read-only diagnostic
// object used by tests (it is not DOM and changes nothing).
window.__ModuleLoader__.load({
  id: 'dsh-tower-ui',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'tower-ui'
    const VERSION = '0.2.1'
    const DIAG_KEY = '__TOWER_UI_DIAG__'
    const NOTICE_MS = 4500
    const MAX_TEXT = 150
    // Native toolviews register at priority 0; the slot core renders the
    // lowest priority, so a negative priority shadows them only while this
    // registration is alive.
    const DENIED_PRIORITY = -10

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
    const TOOL_LABEL_KEYS = {
      tower_status: 'tool.status',
      tower_roster: 'tool.roster',
      tower_spawn: 'tool.spawn',
      tower_mission: 'tool.mission',
      tower_complete: 'tool.complete',
      tower_review: 'tool.review',
      tower_preflight: 'tool.preflight',
      tower_merge: 'tool.merge',
      tower_teardown: 'tool.teardown',
      tower_interrupt: 'tool.interrupt',
      tower_doctor: 'tool.doctor',
      tower_batch: 'tool.batch',
    }

    // ---------------------------------------------------------------------
    // Locale dictionaries (the Client locale service owns activation/language;
    // the slot registration's `locale` option supplies the bound `t` prop).
    // ---------------------------------------------------------------------
    const EN = {
      'card.title': 'Tower',
      'card.running': 'running…',
      'card.done': 'done',
      'card.failed': 'failed',
      'card.error': 'Error',
      'card.blockers': 'Blockers',
      'card.noBlockers': 'no blockers',
      'card.checks': 'Checks',
      'card.warnings': 'Warnings',
      'card.checkOk': '{name} ✓',
      'card.checkFail': '{name} (exit {code})',
      'card.checksCount': '{passed}/{total} checks passed',
      'card.tasks': 'tasks {done}/{total}',
      'card.openTasks': '{count} open task(s)',
      'card.noOpenTasks': 'no open tasks',
      'card.statusHeadline': '{total} missions · {active} active',
      'card.statusDetail': 'roster {roster} · findings {findings} · rev {revision}',
      'card.rosterHeadline': '{live} live / {total} agents',
      'card.staleCount': '{count} stale',
      'card.otherCount': '{count} inactive',
      'card.agentLine': '{name} · {role} · {mission} · {activity}',
      'card.reviewLine': '{status} · merge {merge} · round {round}',
      'card.mergeReady': 'ready to merge',
      'card.mergeBlocked': '{count} blocker(s)',
      'card.merged': 'merged {commit}',
      'card.alreadyMerged': 'already merged',
      'card.spawnLine': '{role} {name} → {mission}',
      'card.worktreeLine': 'worktree {branch}',
      'card.completeLine': '{mission} completed · {commits} commit(s)',
      'card.unread': '{count} unread',
      'card.interruptYes': 'interrupted {name}',
      'card.interruptNo': '{name} is not running',
      'card.previousActivity': 'previous activity {activity}',
      'card.teardownLine': '{removed} removed · {kept} kept',
      'card.dryRun': 'dry run',
      'card.doctorLine': 'doctor {status}',
      'card.doctorChecks': '{pass} pass · {warn} warn · {fail} fail',
      'card.batchLine': 'batch {status}',
      'card.batchMembers': '{count} member(s) · batch {status}',
      'card.batchMissing': '{count} missing check(s)',
      'card.batchFailed': '{count} failed check(s)',
      'card.missionLine': '{id} {status}',
      'card.missionMissing': 'mission',
      'card.reviewPolicy': 'review {policy}',
      'card.owner': 'owner {owner}',
      'card.unknown': 'unknown',
      'card.summary': '{text}',
      'card.sep': ' · ',
      'tool.status': 'Status',
      'tool.roster': 'Roster',
      'tool.spawn': 'Spawn',
      'tool.mission': 'Mission',
      'tool.complete': 'Complete',
      'tool.review': 'Review',
      'tool.preflight': 'Preflight',
      'tool.merge': 'Merge',
      'tool.teardown': 'Teardown',
      'tool.interrupt': 'Interrupt',
      'tool.doctor': 'Doctor',
      'tool.batch': 'Batch',
      'dock.hint.title': '/tower · /tower on [message] · /tower off [message]',
      'dock.running': '{tool} running…',
      'dock.statusCounts': '{total} missions · {active} active · {open} open',
      'dock.rosterCounts': '{live} live / {total} agents',
      'dock.review': 'review {status} · {merge}',
      'dock.ready': 'ready to merge',
      'dock.blocked': '{count} blocker(s)',
      'dock.merged': 'merged {commit}',
      'dock.complete': '{mission} completed · {commits} commit(s)',
      'dock.spawn': '{role} {name} → {mission}',
      'dock.removed': '{count} worktree(s) removed',
      'dock.interrupt': '{name} interrupted',
      'dock.mission': '{id} {status}',
      'dock.preflight': 'preflight {status}',
      'dock.batch': 'batch {status}',
      'dock.doctor': 'doctor {status}',
      'dock.generic': 'done',
      'dock.mode.onLabel': 'on',
      'dock.mode.unknownLabel': 'mode unknown',
      'dock.mode.unknownTooltip': 'The loaded history has Tower activity but no mode event. Run /tower or tower_mode to confirm the current stance.',
      'dock.mode.tooltip': 'Tower mode is on for this session. Run /tower off in the composer to leave Tower mode.',
      'dock.mode.lastKnown': 'last known from this browser session; run /tower or tower_mode to confirm',
      'dock.mode.repo': 'repo {repo}',
      'dock.mode.lockHeld': 'workspace lock held',
      'dock.mode.lockFree': 'workspace lock free',
      'dock.mode.lastBy': 'last change by {by}',
      'deny.label': 'Tower mode · disabled',
      'deny.hint': 'Run /tower off in the composer to use this tool again.',
      'deny.running': 'Tower mode blocks this tool while it is active',
      'deny.generic': '{tool} (Tower mode active)',
      'deny.error': 'Tool error while Tower mode is active',
      'strip.started': 'Tower · {tool} started',
      'strip.finished': 'Tower · {tool} finished',
      'strip.failed': 'Tower · {tool} failed',
    }
    const ZH = {
      'card.title': 'Tower',
      'card.running': '运行中…',
      'card.done': '已完成',
      'card.failed': '失败',
      'card.error': '错误',
      'card.blockers': '阻塞项',
      'card.noBlockers': '无阻塞',
      'card.checks': '检查',
      'card.warnings': '警告',
      'card.checkOk': '{name} ✓',
      'card.checkFail': '{name}（退出码 {code}）',
      'card.checksCount': '通过 {passed}/{total} 项检查',
      'card.tasks': '任务 {done}/{total}',
      'card.openTasks': '{count} 个未完成任务',
      'card.noOpenTasks': '无未完成任务',
      'card.statusHeadline': '{total} 个任务线 · {active} 活跃',
      'card.statusDetail': '名册 {roster} · 发现 {findings} · 修订 {revision}',
      'card.rosterHeadline': '{live} 个运行中 / 共 {total} 个',
      'card.staleCount': '{count} 个疑似停滞',
      'card.otherCount': '{count} 个非活跃',
      'card.agentLine': '{name} · {role} · {mission} · {activity}',
      'card.reviewLine': '{status} · 合并建议 {merge} · 第 {round} 轮',
      'card.mergeReady': '可以合并',
      'card.mergeBlocked': '{count} 个阻塞',
      'card.merged': '已合并 {commit}',
      'card.alreadyMerged': '已合并（补记录）',
      'card.spawnLine': '{role} {name} → {mission}',
      'card.worktreeLine': '工作树 {branch}',
      'card.completeLine': '{mission} 已完成 · {commits} 个提交',
      'card.unread': '{count} 条未读',
      'card.interruptYes': '已中断 {name}',
      'card.interruptNo': '{name} 未在运行',
      'card.previousActivity': '先前活动 {activity}',
      'card.teardownLine': '移除 {removed} · 保留 {kept}',
      'card.dryRun': '演练',
      'card.doctorLine': '体检 {status}',
      'card.doctorChecks': '通过 {pass} · 警告 {warn} · 失败 {fail}',
      'card.batchLine': '批量 {status}',
      'card.batchMembers': '{count} 个成员 · 批次 {status}',
      'card.batchMissing': '{count} 项缺失检查',
      'card.batchFailed': '{count} 项失败检查',
      'card.missionLine': '{id} {status}',
      'card.missionMissing': '任务线',
      'card.reviewPolicy': '评审 {policy}',
      'card.owner': '负责人 {owner}',
      'card.unknown': '未知',
      'card.summary': '{text}',
      'card.sep': ' · ',
      'tool.status': '状态',
      'tool.roster': '名册',
      'tool.spawn': '派发',
      'tool.mission': '任务线',
      'tool.complete': '完成',
      'tool.review': '评审',
      'tool.preflight': '预检',
      'tool.merge': '合并',
      'tool.teardown': '清理',
      'tool.interrupt': '中断',
      'tool.doctor': '体检',
      'tool.batch': '批量',
      'dock.hint.title': '/tower · /tower on [message] · /tower off [message]',
      'dock.running': '{tool} 运行中…',
      'dock.statusCounts': '{total} 个任务线 · {active} 活跃 · {open} 未完成',
      'dock.rosterCounts': '{live} 个运行中 / 共 {total} 个',
      'dock.review': '评审 {status} · {merge}',
      'dock.ready': '可以合并',
      'dock.blocked': '{count} 个阻塞',
      'dock.merged': '已合并 {commit}',
      'dock.complete': '{mission} 已完成 · {commits} 个提交',
      'dock.spawn': '{role} {name} → {mission}',
      'dock.removed': '移除 {count} 个工作树',
      'dock.interrupt': '已中断 {name}',
      'dock.mission': '{id} {status}',
      'dock.preflight': '预检 {status}',
      'dock.batch': '批量 {status}',
      'dock.doctor': '体检 {status}',
      'dock.generic': '已完成',
      'dock.mode.onLabel': '已开启',
      'dock.mode.unknownLabel': '模式未知',
      'dock.mode.unknownTooltip': '已加载的历史中有 Tower 活动，但没有模式事件。执行 /tower 或 tower_mode 以确认当前状态。',
      'dock.mode.tooltip': '此会话已开启 Tower 模式。在输入框中执行 /tower off 可退出。',
      'dock.mode.lastKnown': '来自此浏览器会话的最后已知状态；请执行 /tower 或 tower_mode 确认',
      'dock.mode.repo': '仓库 {repo}',
      'dock.mode.lockHeld': '工作区锁已持有',
      'dock.mode.lockFree': '工作区锁空闲',
      'dock.mode.lastBy': '最近变更者 {by}',
      'deny.label': 'Tower 模式 · 已禁用',
      'deny.hint': '在输入框中执行 /tower off 后即可重新使用该工具。',
      'deny.running': 'Tower 模式启用期间该工具被禁用',
      'deny.generic': '{tool}（Tower 模式启用中）',
      'deny.error': 'Tower 模式启用期间的工具错误',
      'strip.started': 'Tower · {tool} 开始',
      'strip.finished': 'Tower · {tool} 完成',
      'strip.failed': 'Tower · {tool} 失败',
    }

    // ---------------------------------------------------------------------
    // Diagnostics (read-only test seam; not DOM, not Host state).
    // ---------------------------------------------------------------------
    const diagnostics = {
      plugin: 'dsh-tower-ui',
      version: VERSION,
      namespace: NS,
      applied: false,
      slots: [],
      toolviews: [],
      denied: { active: false, keys: [] },
      mode: { known: false, on: null, denied: null },
      errors: [],
    }
    if (typeof window !== 'undefined') window[DIAG_KEY] = diagnostics
    function recordSlot(slot, detail) {
      const duplicate = diagnostics.slots.some(
        (entry) => entry.slot === slot && entry.id === detail.id && entry.key === detail.key,
      )
      if (!duplicate) diagnostics.slots.push(Object.assign({ slot }, detail))
    }
    function guard(where, fn) {
      try {
        return fn()
      } catch (error) {
        diagnostics.errors.push({
          where,
          message: String(error && error.message ? error.message : error),
        })
        return undefined
      }
    }
    // A slot declaration can collapse and later return; its inject callback may
    // therefore run more than once. Guarding the callback body records a failed
    // registration instead of letting the declaration-lifetime effect throw
    // asynchronously into the page.
    function guardedCallback(where, fn) {
      return function () {
        try {
          return fn()
        } catch (error) {
          diagnostics.errors.push({
            where,
            message: String(error && error.message ? error.message : error),
          })
          return function () {}
        }
      }
    }

    // ---------------------------------------------------------------------
    // Theme: only `--dsw-alias-*` tokens are referenced.
    // ---------------------------------------------------------------------
    const TONE = {
      ok: 'var(--dsw-alias-state-success-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
      error: 'var(--dsw-alias-state-error-primary)',
      idle: 'var(--dsw-alias-state-idle-primary)',
      none: 'var(--dsw-alias-label-tertiary)',
    }
    const ST = {
      card: {
        display: 'flex',
        flexDirection: 'column',
        gap: '4px',
        minWidth: 0,
        maxWidth: '100%',
        boxSizing: 'border-box',
        margin: '2px 0 2px 4px',
        padding: '8px 10px',
        border: '0.5px solid var(--dsw-alias-border-l1)',
        borderRadius: '8px',
        background: 'var(--dsw-alias-bg-layer-1)',
        color: 'var(--dsw-alias-label-secondary)',
        fontSize: '12px',
        lineHeight: '18px',
      },
      header: { display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 },
      title: { color: 'var(--dsw-alias-label-primary)', flex: 'none' },
      dim: {
        color: 'var(--dsw-alias-label-tertiary)',
        minWidth: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      row: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      rowError: { color: 'var(--dsw-alias-state-error-primary)' },
      rowWarn: { color: 'var(--dsw-alias-state-warn-primary)' },
      rowOk: { color: 'var(--dsw-alias-state-success-primary)' },
      hint: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '4px',
        padding: '0 6px',
        fontSize: '11px',
        lineHeight: '18px',
        color: 'inherit',
        opacity: 0.55,
        userSelect: 'none',
        whiteSpace: 'nowrap',
      },
      dock: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        minWidth: 0,
        maxWidth: '100%',
        padding: '1px 8px',
        fontSize: '11px',
        lineHeight: '18px',
        color: 'var(--dsw-alias-label-tertiary)',
        whiteSpace: 'nowrap',
      },
      dockTool: { color: 'var(--dsw-alias-label-secondary)', flex: 'none' },
      dockText: {
        minWidth: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        color: 'var(--dsw-alias-label-tertiary)',
      },
      stripWrap: {
        position: 'fixed',
        left: '50%',
        bottom: '16px',
        transform: 'translateX(-50%)',
        display: 'flex',
        justifyContent: 'center',
        pointerEvents: 'none',
        zIndex: 9100,
        maxWidth: 'calc(100vw - 32px)',
      },
      stripCard: {
        pointerEvents: 'none',
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        maxWidth: '100%',
        padding: '4px 10px',
        border: '0.5px solid var(--dsw-alias-border-l1)',
        borderRadius: '999px',
        background: 'var(--dsw-alias-bg-overlay)',
        color: 'var(--dsw-alias-label-secondary)',
        fontSize: '12px',
        lineHeight: '18px',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      },
      modeChip: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        padding: '0 8px',
        border: '0.5px solid var(--dsw-alias-border-l2)',
        borderRadius: '999px',
        background: 'var(--dsw-alias-bg-layer-1)',
        color: 'var(--dsw-alias-label-secondary)',
        fontSize: '11px',
        lineHeight: '18px',
        whiteSpace: 'nowrap',
        userSelect: 'none',
      },
      modeChipLabel: { color: 'var(--dsw-alias-label-primary)' },
      modeChipOn: { color: 'var(--dsw-alias-state-success-primary)' },
      denyCard: {
        display: 'flex',
        flexDirection: 'column',
        gap: '4px',
        minWidth: 0,
        maxWidth: '100%',
        boxSizing: 'border-box',
        margin: '2px 0 2px 4px',
        padding: '8px 10px',
        border: '0.5px solid var(--dsw-alias-border-l2)',
        borderRadius: '8px',
        background: 'var(--dsw-alias-bg-layer-1)',
        color: 'var(--dsw-alias-label-secondary)',
        fontSize: '12px',
        lineHeight: '18px',
      },
      denyLabel: { color: 'var(--dsw-alias-state-warn-primary)', flex: 'none' },
      denyHint: { color: 'var(--dsw-alias-label-tertiary)' },
    }
    function dotStyle(tone) {
      return {
        width: '6px',
        height: '6px',
        flex: 'none',
        borderRadius: '999px',
        background: TONE[tone] || TONE.none,
      }
    }

    // ---------------------------------------------------------------------
    // Small pure helpers. Every one of them is defensive: a tool result is
    // durable user-facing data and may be an older shape, a partial stream, an
    // error, or plain text instead of JSON.
    // ---------------------------------------------------------------------
    function fill(template, params) {
      if (typeof template !== 'string') return String(template)
      if (params === undefined || params === null) return template
      return template.replace(/\{(\w+)\}/g, (match, name) =>
        Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
      )
    }
    function translate(t, key, params) {
      if (typeof t === 'function') {
        try {
          const value = t(key, params)
          if (typeof value === 'string') return value
        } catch (error) {
          /* fall through to the bundled English dictionary */
        }
      }
      return fill(EN[key] !== undefined ? EN[key] : key, params)
    }
    function seatT(props) {
      return props && typeof props.t === 'function' ? props.t : null
    }
    function toolLabel(t, name) {
      if (typeof name !== 'string' || name === '') return translate(t, 'card.title')
      return translate(t, TOOL_LABEL_KEYS[name] || 'card.title')
    }
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

    // ---------------------------------------------------------------------
    // Inline style helpers for generated rows.
    // ---------------------------------------------------------------------
    function rowElement(t, key, row) {
      const style =
        row.tone === 'error'
          ? Object.assign({}, ST.row, ST.rowError)
          : row.tone === 'warn'
            ? Object.assign({}, ST.row, ST.rowWarn)
            : row.tone === 'ok'
              ? Object.assign({}, ST.row, ST.rowOk)
              : ST.row
      return h('div', { key, style }, row.text)
    }

    // ---------------------------------------------------------------------
    // Tool cards. Owner props supplied by the Chat tool-call tree:
    //   callId, toolName, phase ('preparing' | 'start' | 'result'), block,
    //   cwd, home, openFile, loadImage, inspect, useDisclosure — plus the
    //   session-scope standard kit (useSession/useSessions/useChat/…).
    // `phase === 'result'` means `block` is the settled `tool/result` block.
    // ---------------------------------------------------------------------
    function cardModel(toolName, payload, t) {
      const rows = []
      if (!isPlainObject(payload)) {
        return { tone: 'ok', headline: translate(t, 'card.done'), rows }
      }
      if (payload.__error === true) {
        const error = isPlainObject(payload.error) ? payload.error : {}
        const name = typeof error.name === 'string' ? error.name : translate(t, 'card.error')
        const code = typeof error.code === 'string' ? error.code : ''
        const message = typeof error.message === 'string' ? error.message : ''
        const line = truncate([name, code, message].filter((part) => part !== '').join(': '))
        return { tone: 'error', headline: translate(t, 'card.failed'), rows: [{ text: line, tone: 'error' }] }
      }
      if (typeof payload.text === 'string' && payload.text.trim() !== '') {
        return { tone: 'ok', headline: firstLine(payload.text), rows }
      }
      const blockers = blockersOf(payload.blockers)
      let tone = toneForPayload(payload)
      let headline = translate(t, 'card.done')

      if (toolName === 'tower_status') {
        const counts = countsOf(payload)
        const openTasks = typeof payload.openTasks === 'number' ? payload.openTasks : null
        if (counts !== null) {
          headline = translate(t, 'card.statusHeadline', { total: counts.total, active: counts.active })
        }
        if (openTasks !== null) {
          rows.push({
            text: openTasks > 0 ? translate(t, 'card.openTasks', { count: openTasks }) : translate(t, 'card.noOpenTasks'),
            tone: openTasks > 0 ? 'warn' : 'ok',
          })
        }
        if (typeof payload.roster === 'number' || typeof payload.findings === 'number') {
          rows.push({
            text: translate(t, 'card.statusDetail', {
              roster: typeof payload.roster === 'number' ? payload.roster : '?',
              findings: typeof payload.findings === 'number' ? payload.findings : '?',
              revision: typeof payload.revision === 'number' ? payload.revision : '?',
            }),
          })
        }
        if (Array.isArray(payload.missions)) {
          for (const mission of payload.missions.slice(0, 3)) {
            const line = missionLine(t, mission)
            if (line !== '') rows.push({ text: line, tone: toneForStatus(isPlainObject(mission) ? mission.status : undefined) })
          }
        }
        if (isPlainObject(payload.detail) && isPlainObject(payload.detail.mission)) {
          const line = missionLine(t, payload.detail.mission)
          if (line !== '') rows.push({ text: line, tone: toneForStatus(payload.detail.mission.status) })
        }
        if (headline === translate(t, 'card.done')) {
          headline = translate(t, 'card.statusHeadline', { total: 0, active: 0 })
        }
      } else if (toolName === 'tower_roster') {
        const roster = Array.isArray(payload.roster) ? payload.roster : []
        let live = 0
        let stale = 0
        let missing = 0
        let other = 0
        for (const entry of roster) {
          if (!isPlainObject(entry)) continue
          const activity = entry.activity
          if (activity === 'running') live += 1
          else if (entry.stale === true) stale += 1
          else if (activity === 'missing' || activity === 'unknown') missing += 1
          else other += 1
        }
        headline = translate(t, 'card.rosterHeadline', { live, total: roster.length })
        tone = live > 0 ? 'ok' : stale > 0 ? 'warn' : 'idle'
        if (stale > 0) rows.push({ text: translate(t, 'card.staleCount', { count: stale }), tone: 'warn' })
        if (missing + other > 0) rows.push({ text: translate(t, 'card.otherCount', { count: missing + other }) })
        for (const entry of roster.slice(0, 4)) {
          if (!isPlainObject(entry)) continue
          rows.push({
            text: translate(t, 'card.agentLine', {
              name: typeof entry.name === 'string' ? entry.name : '?',
              role: typeof entry.role === 'string' ? entry.role : '?',
              mission: typeof entry.missionId === 'string' ? entry.missionId : '?',
              activity: typeof entry.activity === 'string' ? entry.activity : '?',
            }),
            tone: entry.stale === true ? 'warn' : entry.activity === 'running' ? 'ok' : undefined,
          })
        }
        if (isPlainObject(payload.parentStatus)) {
          const unavailable = Object.keys(payload.parentStatus).filter((key) => payload.parentStatus[key] !== 'ok')
          if (unavailable.length > 0) {
            rows.push({ text: 'parent catalog unavailable: ' + unavailable.length, tone: 'warn' })
          }
        }
      } else if (toolName === 'tower_spawn') {
        headline = translate(t, 'card.spawnLine', {
          role: typeof payload.role === 'string' ? payload.role : '?',
          name: typeof payload.name === 'string' ? payload.name : '?',
          mission: typeof payload.missionId === 'string' ? payload.missionId : '?',
        })
        tone = 'ok'
        if (isPlainObject(payload.worktree) && typeof payload.worktree.branch === 'string') {
          rows.push({ text: translate(t, 'card.worktreeLine', { branch: payload.worktree.branch }) })
        }
        if (payload.created === false) rows.push({ text: 'reused worktree' })
        if (typeof payload.agentId === 'string') rows.push({ text: truncate(payload.agentId, 60) })
        if (payload.timedOut === true) rows.push({ text: 'timed out', tone: 'warn' })
      } else if (toolName === 'tower_mission') {
        const mission = isPlainObject(payload.mission) ? payload.mission : null
        headline = mission !== null ? missionLine(t, mission) : translate(t, 'card.done')
        tone = mission !== null ? toneForStatus(mission.status) : 'ok'
        if (mission !== null) {
          const tasks = taskCountsOf(mission.tasks)
          if (tasks !== null) rows.push({ text: translate(t, 'card.tasks', { done: tasks.done, total: tasks.total }) })
          for (const blocker of missionBlocksOf(mission.blockers).slice(0, 3)) {
            rows.push({ text: truncate(blocker), tone: 'error' })
          }
          if (typeof mission.reviewPolicy === 'string') {
            rows.push({ text: translate(t, 'card.reviewPolicy', { policy: mission.reviewPolicy }) })
          }
          if (isPlainObject(mission.owner) && typeof mission.owner.name === 'string') {
            rows.push({ text: translate(t, 'card.owner', { owner: mission.owner.name }) })
          }
        }
      } else if (toolName === 'tower_complete') {
        const mission = isPlainObject(payload.mission) ? payload.mission : null
        headline = translate(t, 'card.completeLine', {
          mission: mission !== null && typeof mission.id === 'string' ? mission.id : '?',
          commits: typeof payload.commits === 'number' ? payload.commits : 0,
        })
        tone = 'ok'
        if (typeof payload.unread === 'number' && payload.unread > 0) {
          rows.push({ text: translate(t, 'card.unread', { count: payload.unread }), tone: 'warn' })
        }
        if (mission !== null && isPlainObject(mission.completionReport)) {
          const checks = checkEntries(mission.completionReport.checks)
          if (checks.length > 0) {
            rows.push({ text: translate(t, 'card.checks') + ': ' + checkSummary(t, checks) })
            for (const entry of checks.slice(0, 3)) rows.push({ text: checkText(t, entry), tone: entry.ok === false ? 'error' : 'ok' })
          }
          if (typeof mission.completionReport.report === 'string') {
            rows.push({ text: firstLine(mission.completionReport.report) })
          }
        }
      } else if (toolName === 'tower_review') {
        const review = isPlainObject(payload.review) ? payload.review : {}
        headline = translate(t, 'card.reviewLine', {
          status: typeof review.status === 'string' ? review.status : '?',
          merge: typeof review.mergeVerdict === 'string' ? review.mergeVerdict : '?',
          round: typeof payload.round === 'number' ? payload.round : typeof review.round === 'number' ? review.round : '?',
        })
        tone = toneForStatus(review.status)
        const checks = checkEntries(review.checks)
        if (checks.length > 0) {
          rows.push({ text: translate(t, 'card.checks') + ': ' + checks.slice(0, 4).map((entry) => checkText(t, entry)).join(translate(t, 'card.sep')) })
        }
        if (typeof review.findings === 'string' && review.findings.trim() !== '' && review.findings.trim().toLowerCase() !== 'none') {
          rows.push({ text: firstLine(review.findings), tone: 'warn' })
        }
        if (typeof review.decision === 'string' && review.decision.trim() !== '') {
          rows.push({ text: firstLine(review.decision) })
        }
        if (typeof payload.branchTip === 'string') rows.push({ text: 'tip ' + shortCommit(payload.branchTip) })
      } else if (toolName === 'tower_preflight') {
        headline =
          payload.ok === true
            ? translate(t, 'card.mergeReady')
            : translate(t, 'card.mergeBlocked', { count: blockers.length })
        tone = payload.ok === true ? 'ok' : 'error'
        if (Array.isArray(payload.changedFiles)) {
          rows.push({ text: 'changed files ' + payload.changedFiles.length })
        }
        if (isPlainObject(payload.review)) {
          rows.push({
            text: translate(t, 'card.reviewLine', {
              status: typeof payload.review.status === 'string' ? payload.review.status : '?',
              merge: typeof payload.review.mergeVerdict === 'string' ? payload.review.mergeVerdict : '?',
              round: typeof payload.review.round === 'number' ? payload.review.round : '?',
            }),
            tone: toneForStatus(payload.review.status),
          })
        }
      } else if (toolName === 'tower_merge') {
        if (payload.ok === true) {
          headline = payload.alreadyMerged === true
            ? translate(t, 'card.alreadyMerged')
            : translate(t, 'card.merged', { commit: shortCommit(payload.mergedCommit) })
          tone = 'ok'
        } else {
          headline = translate(t, 'card.mergeBlocked', { count: blockers.length })
          tone = 'error'
        }
        if (payload.recoveredFromFailure === true) rows.push({ text: 'recorded after a failed merge attempt', tone: 'warn' })
        if (Array.isArray(payload.warnings)) {
          for (const warning of payload.warnings.slice(0, 2)) rows.push({ text: truncate(warning), tone: 'warn' })
        }
        if (typeof payload.baseTip === 'string') rows.push({ text: 'base ' + shortCommit(payload.baseTip) })
      } else if (toolName === 'tower_teardown') {
        const removed = Array.isArray(payload.removed) ? payload.removed.length : 0
        const decisions = Array.isArray(payload.decisions) ? payload.decisions : []
        const kept = decisions.filter((entry) => isPlainObject(entry) && entry.action === 'keep').length
        headline = translate(t, 'card.teardownLine', { removed, kept })
        tone = payload.ok === false ? 'error' : 'ok'
        if (payload.dryRun === true) rows.push({ text: translate(t, 'card.dryRun') })
        for (const decision of decisions.slice(0, 3)) {
          if (!isPlainObject(decision)) continue
          const reason = typeof decision.reason === 'string' ? ' · ' + truncate(decision.reason, 60) : ''
          rows.push({
            text: (typeof decision.action === 'string' ? decision.action : '?') + ' ' + (typeof decision.missionId === 'string' ? decision.missionId : '?') + reason,
            tone: decision.action === 'keep' ? 'warn' : 'ok',
          })
        }
      } else if (toolName === 'tower_interrupt') {
        tone = payload.interrupted === true ? 'warn' : 'idle'
        headline =
          payload.interrupted === true
            ? translate(t, 'card.interruptYes', { name: isPlainObject(payload.entry) && typeof payload.entry.name === 'string' ? payload.entry.name : '?' })
            : translate(t, 'card.interruptNo', { name: isPlainObject(payload.entry) && typeof payload.entry.name === 'string' ? payload.entry.name : '?' })
        if (typeof payload.previousActivity === 'string') {
          rows.push({ text: translate(t, 'card.previousActivity', { activity: payload.previousActivity }) })
        }
        if (typeof payload.reason === 'string' && payload.reason !== '') rows.push({ text: truncate(payload.reason) })
      } else if (toolName === 'tower_doctor') {
        const checks = checkEntries(payload.checks)
        const passed = checks.filter((entry) => entry.ok === true).length
        const warned = checks.filter((entry) => entry.ok === null).length
        const failed = checks.filter((entry) => entry.ok === false).length
        headline = translate(t, 'card.doctorLine', { status: payload.ok === true ? 'ok' : 'issues' })
        tone = payload.ok === true ? 'ok' : failed > 0 ? 'error' : 'warn'
        if (checks.length > 0) {
          rows.push({
            text: translate(t, 'card.doctorChecks', { pass: passed, warn: warned, fail: failed }),
            tone: failed > 0 ? 'error' : warned > 0 ? 'warn' : 'ok',
          })
          for (const entry of checks.filter((candidate) => candidate.ok !== true).slice(0, 4)) {
            rows.push({ text: checkText(t, entry), tone: entry.ok === false ? 'error' : 'warn' })
          }
        }
      } else if (toolName === 'tower_batch') {
        const summary = isPlainObject(payload.summary)
          ? payload.summary
          : isPlainObject(payload.batch)
            ? payload.batch
            : null
        const status =
          summary !== null && typeof summary.status === 'string'
            ? summary.status
            : payload.ok === true
              ? 'ok'
              : 'issues'
        headline = translate(t, 'card.batchLine', { status })
        tone = payload.ok === true ? 'ok' : 'warn'
        if (summary !== null) {
          if (Array.isArray(summary.members)) {
            rows.push({
              text: translate(t, 'card.batchMembers', {
                count: summary.members.length,
                status: typeof summary.status === 'string' ? summary.status : '?',
              }),
            })
          }
          if (Array.isArray(summary.missingChecks) && summary.missingChecks.length > 0) {
            rows.push({ text: translate(t, 'card.batchMissing', { count: summary.missingChecks.length }), tone: 'warn' })
          }
          if (Array.isArray(summary.pendingChecks) && summary.pendingChecks.length > 0) {
            rows.push({ text: translate(t, 'card.batchMissing', { count: summary.pendingChecks.length }), tone: 'warn' })
          }
          if (Array.isArray(summary.failedChecks) && summary.failedChecks.length > 0) {
            rows.push({ text: translate(t, 'card.batchFailed', { count: summary.failedChecks.length }), tone: 'error' })
          }
          const checks = checkEntries(summary.checks)
          if (checks.length > 0) {
            rows.push({
              text: translate(t, 'card.checks') + ': ' + checkSummary(t, checks),
              tone: checks.some((entry) => entry.ok === false) ? 'error' : 'ok',
            })
          }
        } else if (Array.isArray(payload.batches)) {
          rows.push({ text: 'batches ' + payload.batches.length })
        }
      } else {
        tone = toneForPayload(payload)
      }

      if (!TOOL_SET.has(toolName)) {
        const checks = checkEntries(payload.checks)
        if (checks.length > 0) {
          rows.push({ text: translate(t, 'card.checks') + ': ' + checkSummary(t, checks), tone: checks.some((entry) => entry.ok === false) ? 'error' : 'ok' })
        }
        if (Array.isArray(payload.warnings) && payload.warnings.length > 0) {
          rows.push({ text: translate(t, 'card.warnings') + ': ' + payload.warnings.slice(0, 2).map((item) => truncate(item, 60)).join(translate(t, 'card.sep')), tone: 'warn' })
        }
        const counts = countsOf(payload)
        if (counts !== null) {
          rows.push({ text: translate(t, 'card.statusHeadline', { total: counts.total, active: counts.active }) })
        }
        if (Array.isArray(payload.missions)) {
          for (const mission of payload.missions.slice(0, 3)) {
            const line = missionLine(t, mission)
            if (line !== '') rows.push({ text: line, tone: toneForStatus(isPlainObject(mission) ? mission.status : undefined) })
          }
        }
      }

      for (const blocker of blockers.slice(0, 3)) {
        rows.push({ text: truncate(blocker), tone: 'error' })
      }
      return { tone, headline, rows }
    }

    // Publish a transient overlay notice when this chat-driven Tool row changes
    // lifecycle. Mounting an already-settled result (history) stays silent; a
    // live preparing/start row and a start→result transition publish.
    let publishNotice = function () {}
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

    // ---------------------------------------------------------------------
    // Dynamic denied-tool rows (#12). These entries exist only while the
    // displayed session is in Tower mode, registered at DENIED_PRIORITY so the
    // native toolviews (priority 0) return the moment the mode turns off. A
    // real guard denial renders the distinct `Tower mode · disabled` row;
    // anything else landing in these slots while the mode is on gets a
    // defensive generic row instead of the native view.
    // ---------------------------------------------------------------------
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
      // Defensive fallback: the slot is ours only while Tower mode is on, so a
      // non-denial result here has no native view to delegate to.
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

    // ---------------------------------------------------------------------
    // Composer dock: a history-derived Tower-mode chip while the displayed
    // session is in Tower mode; otherwise the static `/tower` hint until this
    // conversation has a Tower tool result or a running Tower call, then a
    // compact latest summary. Everything is derived only from the `useChat`
    // session-standard selector hook (the durable Chat legacy projection).
    // ---------------------------------------------------------------------
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
    // Fold the durable history the dock can see into one Tower-mode model. The
    // last recognized event wins; `/tower reload|base` and failed commands do
    // not change the stance. This is a loaded-history-window inference, not a
    // Host read: entries older than the window yield `known: false`.
    function modeModelFromLegacy(legacy) {
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
    // Module-local mode observable. The dock (session scope) publishes the
    // stance it derived from history; the plugin uses it only to add/remove
    // the dynamic denied-tool toolviews. It never holds or fetches Host state.
    let modeValue = Object.assign({}, EMPTY_MODE)
    const modeListeners = new Set()
    let modeWriterSeq = 0
    function nextDockWriter() {
      modeWriterSeq += 1
      return 'dock-' + modeWriterSeq
    }
    function modeSnapshot() {
      return modeValue
    }
    function subscribeMode(listener) {
      modeListeners.add(listener)
      return function () {
        modeListeners.delete(listener)
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
      for (const listener of Array.from(modeListeners)) {
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
      if (sameMode(value, modeValue)) {
        modeValue = value
        return
      }
      modeValue = value
      notifyMode()
    }
    function clearMode(writer) {
      if (modeValue.writer !== writer) return
      const empty = Object.assign({}, EMPTY_MODE, { writer })
      if (sameMode(empty, modeValue)) {
        modeValue = empty
        return
      }
      modeValue = empty
      diagnostics.mode = { known: false, on: null, denied: null }
      notifyMode()
    }
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
        const mode = modeModelFromLegacy(legacy)
        let summary = null
        // While Tower mode is on the chip is the dock's message; the latest
        // tool summary stays available again after /tower off.
        if (!(mode.known === true && mode.on === true)) {
          const signal = latestTowerSignal(legacy)
          if (signal !== null) {
            summary =
              signal.phase !== 'result'
                ? { tool: signal.name, running: true, tone: 'idle' }
                : dockResultModel(signal.name, parsePayload(signal.block))
          }
        }
        return JSON.stringify({
          mode,
          summary,
          // A Tower tool result with no recognized mode event means the loaded
          // history window cannot prove the stance. Surface that explicitly
          // instead of pretending the session is off.
          uncertain: mode.known !== true && summary !== null && summary.running !== true,
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
    function writeStoredMode(sessionId, mode) {
      if (typeof sessionId !== 'string' || sessionId === '') return
      try {
        if (!globalThis.localStorage) return
        if (mode.known === true && (mode.on === true || mode.on === false)) {
          globalThis.localStorage.setItem(modeStorageKey(sessionId), JSON.stringify({
            on: mode.on,
            denied: mode.denied ?? null,
            repo: mode.repo ?? null,
            lock: mode.lock ?? null,
            lastBy: mode.lastBy ?? null,
            lastReason: mode.lastReason ?? null,
            at: Date.now(),
          }))
        }
      } catch {
        // storage is best effort; the history-derived model remains the source
      }
    }
    function modeTooltip(t, mode) {
      const parts = [translate(t, 'dock.mode.tooltip')]
      if (mode.source === 'stored') parts.push(translate(t, 'dock.mode.lastKnown'))
      if (typeof mode.repo === 'string' && mode.repo !== '') parts.push(translate(t, 'dock.mode.repo', { repo: mode.repo }))
      if (isPlainObject(mode.lock)) {
        parts.push(translate(t, mode.lock.held === true ? 'dock.mode.lockHeld' : 'dock.mode.lockFree'))
      }
      if (typeof mode.lastBy === 'string' && mode.lastBy !== '') parts.push(translate(t, 'dock.mode.lastBy', { by: mode.lastBy }))
      return parts.join(translate(t, 'card.sep'))
    }
    function renderModeChip(t, mode) {
      // Non-interactive on purpose: the existing inputActions.submit() submits
      // the composer draft, so a programmatic /tower off would clobber what the
      // user is typing. The tooltip is the actionable affordance instead.
      return h(
        'div',
        {
          'data-tower-ui': 'dock-mode',
          'data-tower-mode': mode.on === true ? 'on' : 'off',
          role: 'status',
          'aria-live': 'polite',
          title: modeTooltip(t, mode),
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
      const mode = stored
        ? Object.assign({}, modeFromHistory, stored, { known: true, source: 'stored' })
        : modeFromHistory
      writeStoredMode(props.sessionId, modeFromHistory)
      const writerState = React.useState(function () {
        return nextDockWriter()
      })
      const writer = writerState[0]
      const modeKey = JSON.stringify(mode)
      React.useEffect(
        function () {
          // Publish only the history-derived stance. A stored last-known value
          // is display-only: it must not shadow native toolviews when the Host
          // stance is actually unknown.
          publishMode(writer, modeFromHistory)
          return function () {
            clearMode(writer)
          }
        },
        [JSON.stringify(modeFromHistory)],
      )
      if (mode.known === true && mode.on === true) return renderModeChip(t, mode)
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

    // ---------------------------------------------------------------------
    // shell.overlay: transient status strip. Root-scoped, so it receives no
    // chat hooks; the chat-driven toolview publishes into this local
    // observable and the strip entry injects it. Auto-dismiss is a single
    // timer owned by `apply`'s ctx.effect.
    // ---------------------------------------------------------------------
    let noticeValue = null
    const noticeListeners = new Set()
    function noticeSnapshot() {
      return noticeValue
    }
    function subscribeNotice(listener) {
      noticeListeners.add(listener)
      return function () {
        noticeListeners.delete(listener)
      }
    }
    function setNotice(next) {
      if (Object.is(next, noticeValue)) return
      noticeValue = next
      for (const listener of Array.from(noticeListeners)) {
        try {
          listener()
        } catch (error) {
          /* a broken subscriber must not break the strip */
        }
      }
    }
    const noticeSource = { getSnapshot: noticeSnapshot, subscribe: subscribeNotice }

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
        h('div', { style: ST.stripCard }, h('span', { 'aria-hidden': true, style: dotStyle(tone) }), h('span', null, text)),
      )
    }

    // ---------------------------------------------------------------------
    // Plugin body.
    // ---------------------------------------------------------------------
    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        diagnostics.applied = true

        // Locale dictionaries for the slot entries' bound `t` seat.
        guard('locale', function () {
          return ctx.effect(
            function () {
              return ctx.locale.register(NS, { en: EN, zh: ZH })
            },
            'tower-ui: dictionaries',
          )
        })

        // One auto-dismiss timer for the overlay strip, owned by ctx.effect.
        let dismissTimer = null
        publishNotice = function (notice) {
          if (!isPlainObject(notice)) return
          setNotice(Object.assign({}, notice, { seq: Date.now() }))
          if (dismissTimer !== null) clearTimeout(dismissTimer)
          dismissTimer = setTimeout(function () {
            dismissTimer = null
            setNotice(null)
          }, NOTICE_MS)
        }
        guard('timer', function () {
          return ctx.effect(
            function () {
              return function () {
                if (dismissTimer !== null) {
                  clearTimeout(dismissTimer)
                  dismissTimer = null
                }
              }
            },
            'tower-ui: status strip timer',
          )
        })

        // 1. Keyed per-tool cards. `key` is the wire tool name selected by the
        //    Chat tool-call tree through `entryKey`.
        for (const tool of TOOL_NAMES) {
          guard('toolview:' + tool, function () {
            return ctx.slots.inject(
              'tool.call.toolview',
              guardedCallback('toolview:' + tool, function () {
                const dispose = ctx.slots.register(
                  {
                    name: 'tool.call.toolview',
                    key: tool,
                    locale: NS,
                  },
                  TowerToolCard,
                )
                if (!diagnostics.toolviews.includes(tool)) diagnostics.toolviews.push(tool)
                recordSlot('tool.call.toolview', { key: tool })
                return dispose
              }),
            )
          })
        }

        // 2. Composer dock: hint until this conversation has a Tower tool result.
        guard('dock', function () {
          return ctx.slots.inject(
            'conversation.composer.dock',
            guardedCallback('dock', function () {
              const dispose = ctx.slots.register(
                {
                  name: 'conversation.composer.dock',
                  id: 'tower-hint',
                  order: 6,
                  locale: NS,
                },
                TowerDock,
              )
              recordSlot('conversation.composer.dock', { id: 'tower-hint', order: 6 })
              return dispose
            }),
          )
        })

        // 3. Shell overlay: transient start/result strip, pointer-transparent.
        guard('overlay', function () {
          return ctx.slots.inject(
            'shell.overlay',
            guardedCallback('overlay', function () {
              const dispose = ctx.slots.register(
                {
                  name: 'shell.overlay',
                  id: 'tower-status-strip',
                  order: 20,
                  locale: NS,
                  inject: function () {
                    return { hooks: { towerNotice: noticeSource } }
                  },
                },
                TowerStatusStrip,
              )
              recordSlot('shell.overlay', { id: 'tower-status-strip', order: 20 })
              return dispose
            }),
          )
        })

        // 4. Mode-aware denied-tool rows (#12). The dock publishes the Tower
        //    stance it derives from the displayed session's history; while it
        //    is on, shadow the denied tools' native keyed views at a lower
        //    priority (the slot core renders the lowest priority). Disposing
        //    these entries restores the native views exactly when mode is off.
        guard('denied-toolviews', function () {
          return ctx.slots.inject(
            'tool.call.toolview',
            guardedCallback('denied-toolviews', function () {
              const disposers = new Map()
              let currentKey = null
              const reconcile = function () {
                const mode = modeSnapshot()
                const active = mode.known === true && mode.on === true
                const names = active ? deniedNames(mode.denied) : []
                const nextKey = names.join('\n')
                if (nextKey === currentKey) return
                currentKey = nextKey
                for (const name of Array.from(disposers.keys())) {
                  if (names.includes(name)) continue
                  const dispose = disposers.get(name)
                  disposers.delete(name)
                  try {
                    if (typeof dispose === 'function') dispose()
                  } catch (error) {
                    diagnostics.errors.push({
                      where: 'denied-toolview-dispose:' + name,
                      message: String(error && error.message ? error.message : error),
                    })
                  }
                }
                for (const name of names) {
                  if (disposers.has(name)) continue
                  try {
                    disposers.set(
                      name,
                      ctx.slots.register(
                        {
                          name: 'tool.call.toolview',
                          key: name,
                          priority: DENIED_PRIORITY,
                          locale: NS,
                        },
                        DeniedToolRow,
                      ),
                    )
                  } catch (error) {
                    diagnostics.errors.push({
                      where: 'denied-toolview:' + name,
                      message: String(error && error.message ? error.message : error),
                    })
                  }
                }
                diagnostics.denied = { active, keys: names.slice() }
                recordSlot('tool.call.toolview', { denied: names.slice(), priority: DENIED_PRIORITY })
              }
              const unsubscribe = subscribeMode(reconcile)
              reconcile()
              return function () {
                try {
                  unsubscribe()
                } catch (error) {
                  /* already disposed */
                }
                for (const dispose of Array.from(disposers.values())) {
                  try {
                    if (typeof dispose === 'function') dispose()
                  } catch (error) {
                    /* registration already gone */
                  }
                }
                disposers.clear()
                currentKey = null
              }
            }),
          )
        })
      },
    }
  },
})
