// dsh-tower-ui 0.2.2 — locale dictionaries and the translation helpers.
//
// Package-local chunk: client.js loads it once through require.async() before
// the first slot registration. The Client locale service owns activation and
// language; each slot registration's `locale` option supplies the bound `t`
// seat, and `EN` is the fallback for a missing seat (#71).
//
// Every entry is one [English, Chinese] pair. Keeping both languages on the
// same line makes the key sets identical by construction, so a copy change
// cannot silently land in one language only. Enum labels are generated from
// one compact table; the card/dock helpers translate a known enum value and
// fall back to the raw value for a foreign/older shape.
window.__ModuleLoader__.load({
  id: 'dsh-tower-ui',
  chunk: 'client.locales.js',
  factory() {
    const TOOL_LABEL_KEYS = {
      tower_inspect: 'tool.inspect',
      tower_spawn: 'tool.spawn',
      tower_mission: 'tool.mission',
      tower_complete: 'tool.complete',
      tower_review: 'tool.review',
      tower_merge: 'tool.merge',
      tower_teardown: 'tool.teardown',
      tower_interrupt: 'tool.interrupt',
      tower_batch: 'tool.batch',
    }
    const COPY = {
      'card.title': ['Tower', 'Tower'],
      'card.running': ['running…', '运行中…'],
      'card.done': ['done', '已完成'],
      'card.failed': ['failed', '失败'],
      'card.error': ['Error', '错误'],
      'card.blockers': ['Blockers', '阻塞项'],
      'card.noBlockers': ['no blockers', '无阻塞'],
      'card.checks': ['Checks', '检查'],
      'card.warnings': ['Warnings', '警告'],
      'card.checkOk': ['{name} ✓', '{name} ✓'],
      'card.checkFail': ['{name} (exit {code})', '{name}（退出码 {code}）'],
      'card.checksCount': ['{passed}/{total} checks passed', '通过 {passed}/{total} 项检查'],
      'card.tasks': ['tasks {done}/{total}', '任务 {done}/{total}'],
      'card.openTasks': ['{count} open task(s)', '{count} 个未完成任务'],
      'card.noOpenTasks': ['no open tasks', '无未完成任务'],
      'card.statusHeadline': ['{total} missions · {active} active', '{total} 个任务线 · {active} 活跃'],
      'card.statusDetail': ['roster {roster} · findings {findings} · rev {revision}', '名册 {roster} · 发现 {findings} · 修订 {revision}'],
      'card.rosterHeadline': ['{live} live / {total} agents', '{live} 个运行中 / 共 {total} 个'],
      'card.staleCount': ['{count} stale', '{count} 个疑似停滞'],
      'card.otherCount': ['{count} inactive', '{count} 个非活跃'],
      'card.agentLine': ['{name} · {role} · {missionId} · {activity}', '{name} · {role} · {missionId} · {activity}'],
      'card.reviewLine': ['review {status} · merge {merge} · round {round}', '审查 {status} · 合并建议 {merge} · 第 {round} 轮'],
      'card.mergeReady': ['ready to merge', '可以合并'],
      'card.mergeBlocked': ['{count} blocker(s)', '{count} 个阻塞'],
      'card.merged': ['merged {commit}', '已合并 {commit}'],
      'card.alreadyMerged': ['already merged', '已合并（补记录）'],
      'card.spawnLine': ['{role} {name} → {missionId}', '{role} {name} → {missionId}'],
      'card.worktreeLine': ['worktree {branch}', '工作树 {branch}'],
      'card.completeLine': ['{missionId} completed · {commits} commit(s)', '{missionId} 已完成 · {commits} 个提交'],
      'card.unread': ['{count} unread', '{count} 条未读'],
      'card.interruptYes': ['interrupted {name}', '已中断 {name}'],
      'card.interruptNo': ['{name} is not running', '{name} 未在运行'],
      'card.previousActivity': ['previous activity {activity}', '先前活动 {activity}'],
      'card.teardownLine': ['{removed} removed · {kept} kept', '移除 {removed} · 保留 {kept}'],
      'card.dryRun': ['dry run', '演练'],
      'card.doctorLine': ['doctor {status}', '体检 {status}'],
      'card.doctorChecks': ['{pass} pass · {warn} warn · {fail} fail', '通过 {pass} · 警告 {warn} · 失败 {fail}'],
      'card.batchLine': ['batch {status}', '批次 {status}'],
      'card.batchMembers': ['{count} member(s) · batch {status}', '{count} 个成员 · 批次 {status}'],
      'card.batchMissing': ['{count} missing check(s)', '{count} 项缺失检查'],
      'card.batchFailed': ['{count} failed check(s)', '{count} 项失败检查'],
      'card.missionLine': ['mission {id} {status}', '任务线 {id} {status}'],
      'card.missionMissing': ['mission', '任务线'],
      'card.reviewPolicy': ['review policy: {policy}', '审查策略：{policy}'],
      'card.owner': ['owner {owner}', '负责人 {owner}'],
      'card.unknown': ['unknown', '未知'],
      'card.summary': ['{text}', '{text}'],
      'card.sep': [' · ', ' · '],
      'card.parentCatalogUnavailable': ['parent catalog unavailable: {count}', '父级目录不可用：{count}'],
      'card.reusedWorktree': ['reused worktree', '复用了工作树'],
      'card.timedOut': ['timed out', '已超时'],
      'card.branchTip': ['branch tip {commit}', '分支末端 {commit}'],
      'card.changedFiles': ['changed files {count}', '变更文件 {count}'],
      'card.recoveredFromFailure': ['recorded after a failed merge attempt', '在合并尝试失败后已记录'],
      'card.baseTip': ['base tip {commit}', '基线末端 {commit}'],
      'card.batches': ['batches {count}', '批次 {count}'],
      'card.tone.error': ['error', '错误'], 'card.tone.warn': ['warning', '警告'], 'card.tone.ok': ['ok', '正常'],
      'tool.inspect': ['Inspect', '查看'],
      'tool.spawn': ['Spawn', '派发'],
      'tool.mission': ['Mission', '任务线'],
      'tool.complete': ['Complete', '完成'],
      'tool.review': ['Review', '审查'],
      'tool.merge': ['Merge', '合并'],
      'tool.teardown': ['Teardown', '清理'],
      'tool.interrupt': ['Interrupt', '中断'],
      'tool.batch': ['Batch', '批次'],
      'dock.hint.title': ['/tower · /tower on [message] · /tower off [message]', '/tower · /tower on [message] · /tower off [message]'],
      'dock.running': ['{tool} running…', '{tool} 运行中…'],
      'dock.statusCounts': ['{total} missions · {active} active · {open} open', '{total} 个任务线 · {active} 活跃 · {open} 未完成'],
      'dock.rosterCounts': ['{live} live / {total} agents', '{live} 个运行中 / 共 {total} 个'],
      'dock.review': ['review {status} · {merge}', '审查 {status} · {merge}'],
      'dock.ready': ['ready to merge', '可以合并'],
      'dock.blocked': ['{count} blocker(s)', '{count} 个阻塞'],
      'dock.merged': ['merged {commit}', '已合并 {commit}'],
      'dock.complete': ['{missionId} completed · {commits} commit(s)', '{missionId} 已完成 · {commits} 个提交'],
      'dock.spawn': ['{role} {name} → {missionId}', '{role} {name} → {missionId}'],
      'dock.removed': ['{count} worktree(s) removed', '移除 {count} 个工作树'],
      'dock.interrupt': ['{name} interrupted', '已中断 {name}'],
      'dock.mission': ['mission {id} {status}', '任务线 {id} {status}'],
      'dock.preflight': ['preflight {status}', '预检 {status}'],
      'dock.batch': ['batch {status}', '批次 {status}'],
      'dock.doctor': ['doctor {status}', '体检 {status}'],
      'dock.generic': ['done', '已完成'],
      'dock.mode.onLabel': ['on', '已开启'],
      'dock.mode.unknownLabel': ['mode unknown', '模式未知'],
      'dock.mode.unknownTooltip': ['The loaded history has Tower activity but no mode event. Run /tower or tower_mode to confirm the current stance.', '已加载的历史中有 Tower 活动，但没有模式事件。执行 /tower 或 tower_mode 以确认当前状态。'],
      'dock.mode.tooltip': ['Tower mode is on for this session. Run /tower off in the composer to leave Tower mode.', '此会话已开启 Tower 模式。在输入框中执行 /tower off 可退出。'],
      'dock.mode.lastKnown': ['last known from this browser session; run /tower or tower_mode to confirm', '来自此浏览器会话的最后已知状态；请执行 /tower 或 tower_mode 确认'],
      'dock.mode.repo': ['repo {repo}', '仓库 {repo}'],
      'dock.mode.lockHeld': ['workspace lock held', '工作区锁已持有'],
      'dock.mode.lockFree': ['workspace lock free', '工作区锁空闲'],
      'dock.mode.lastBy': ['last change by {by}', '最近变更者 {by}'],
      'deny.label': ['Tower mode · disabled', 'Tower 模式 · 已禁用'],
      'deny.hint': ['Run /tower off in the composer to use this tool again.', '在输入框中执行 /tower off 后即可重新使用该工具。'],
      'deny.running': ['Tower mode blocks this tool while it is active', 'Tower 模式启用期间该工具被禁用'],
      'deny.generic': ['{tool} (Tower mode active)', '{tool}（Tower 模式启用中）'],
      'deny.error': ['Tool error while Tower mode is active', 'Tower 模式启用期间的工具错误'],
      'strip.started': ['Tower · {tool} started', 'Tower · {tool} 开始'],
      'strip.finished': ['Tower · {tool} finished', 'Tower · {tool} 完成'],
      'strip.failed': ['Tower · {tool} failed', 'Tower · {tool} 失败'],
    }
    // Known enum values get human labels; enumLabel() falls back to the raw
    // value when an older or foreign payload carries one this table omits.
    const ENUMS = {
      role: { tower: ['tower', '控制塔'], worker: ['worker', '执行代理'], reviewer: ['reviewer', '审查代理'], unknown: ['unknown', '未知'] },
      activity: { running: ['running', '运行中'], inactive: ['inactive', '非活跃'], missing: ['missing', '缺失'], unknown: ['unknown', '未知'] },
      missionStatus: { planned: ['planned', '已规划'], active: ['active', '进行中'], completed: ['completed', '已完成'], blocked: ['blocked', '受阻'], paused: ['paused', '已暂停'], merged: ['merged', '已合并'], abandoned: ['abandoned', '已放弃'] },
      reviewStatus: { clean: ['clean', '通过'], p1: ['{count} P1 finding(s)', '{count} 个 P1 问题'], p2: ['{count} P2 finding(s)', '{count} 个 P2 问题'] },
      mergeVerdict: { merge: ['merge', '合并'], 'fix-then-merge': ['fix then merge', '先修复再合并'], hold: ['hold', '暂缓'] },
      reviewPolicy: { 'required-clean': ['clean review expected', '需要干净审查'], none: ['no review required', '无需审查'] },
      batchStatus: { open: ['open', '开放'], closed: ['closed', '已关闭'], abandoned: ['abandoned', '已放弃'] },
      doctor: { ok: ['ok', '正常'], issues: ['issues', '有问题'] },
      teardownAction: { keep: ['keep', '保留'], remove: ['remove', '移除'], removed: ['removed', '已移除'] },
    }
    for (const [kind, values] of Object.entries(ENUMS)) {
      for (const [value, pair] of Object.entries(values)) COPY[`enum.${kind}.${value}`] = pair
    }
    const EN = {}
    const ZH = {}
    for (const [key, pair] of Object.entries(COPY)) {
      EN[key] = pair[0]
      ZH[key] = pair[1]
    }

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

    return { EN, ZH, fill, translate, seatT, toolLabel }
  },
})
