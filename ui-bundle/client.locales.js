// dsh-tower-ui 0.2.2 — locale dictionaries and the translation helpers.
//
// Package-local chunk: client.js loads it before the first slot registration.
// The Client locale service owns activation and language; each registration's
// `locale` option supplies the bound `t` seat, and `EN` is the missing-seat fallback (#71).
//
// Every entry is one [English, Chinese] pair, so both key sets are identical by
// construction; enum labels come from one compact table. #F22: user-facing copy
// under the plugin-page rules — plain language, the recorded glossary in both
// languages, no config keys and no internal tool ids. The copy gate reads both
// dictionaries; CLIENT_COMMAND_KEYS names the instructions that may quote /tower.
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
      'card.detail': ['Details', '详情'],
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
      'card.statusHeadline': ['{total} missions · {active} active', '{total} 个任务线 · {active} 个进行中'],
      'card.statusDetail': ['agents {roster} · findings {findings} · revision {revision}', '代理 {roster} · 发现 {findings} · 修订 {revision}'],
      'card.rosterHeadline': ['{live} live / {total} agents', '{live} 个运行中 / 共 {total} 个'],
      'card.staleCount': ['{count} stale', '{count} 个疑似停滞'],
      'card.otherCount': ['{count} inactive', '{count} 个非活跃'],
      'card.agentLine': ['{name} · {role} · {missionId} · {activity}', '{name} · {role} · {missionId} · {activity}'],
      'card.reviewLine': ['review {status} · merge verdict {merge} · round {round}', '审查 {status} · 合并结论 {merge} · 第 {round} 轮'],
      'card.mergeReady': ['ready to merge', '可以合并'],
      'card.mergeBlocked': ['{count} blocker(s)', '{count} 个阻塞'],
      'card.merged': ['merged {commit}', '已合并 {commit}'],
      'card.alreadyMerged': ['merged earlier — recorded now', '此前已合并，现补记'],
      'card.spawnLine': ['{role} {name} → {missionId}', '{role} {name} → {missionId}'],
      'card.worktreeLine': ['worktree {branch}', '工作树 {branch}'],
      'card.completeLine': ['{missionId} completed · {commits} commit(s)', '{missionId} 已完成 · {commits} 个提交'],
      'card.unread': ['{count} unread', '{count} 条未读'],
      'card.interruptYes': ['interrupted {name}', '已中断 {name}'],
      'card.interruptNo': ['{name} is not running', '{name} 未在运行'],
      'card.previousActivity': ['previous activity {activity}', '先前活动 {activity}'],
      'card.teardownLine': ['worktrees removed {removed} · kept {kept}', '移除 {removed} 个工作树 · 保留 {kept} 个'],
      'card.dryRun': ['preview only — nothing changed', '仅预览，未做任何更改'],
      'card.doctorLine': ['doctor {status}', '体检 {status}'],
      'card.doctorChecks': ['{pass} passed · {warn} warnings · {fail} failed', '{pass} 项通过 · {warn} 项警告 · {fail} 项失败'],
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
      'card.parentCatalogUnavailable': ['agent presets unavailable from the parent session: {count}', '无法从上级会话读取预设：{count}'],
      'card.reusedWorktree': ['reused worktree', '复用了工作树'],
      'card.timedOut': ['timed out', '已超时'],
      'card.branchTip': ['branch at commit {commit}', '分支提交 {commit}'],
      'card.changedFiles': ['changed files {count}', '变更文件 {count}'],
      'card.recoveredFromFailure': ['recorded after a failed merge attempt', '在合并尝试失败后已记录'],
      'card.baseTip': ['base at commit {commit}', '基线提交 {commit}'],
      'card.batches': ['batches {count}', '批次 {count}'],
      'card.tone.error': ['error', '错误'], 'card.tone.warn': ['warning', '警告'], 'card.tone.ok': ['ok', '正常'],
      'tool.inspect': ['Inspect', '查看'],
      'tool.spawn': ['Start agent', '派发代理'],
      'tool.mission': ['Mission', '任务线'],
      'tool.complete': ['Complete', '完成'],
      'tool.review': ['Review', '审查'],
      'tool.merge': ['Merge', '合并'],
      'tool.teardown': ['Remove worktrees', '清理工作树'],
      'tool.interrupt': ['Stop agent', '中断代理'],
      'tool.batch': ['Batch', '批次'],
      'dock.hint.title': ['/tower · /tower on [message] · /tower off [message]', '/tower · /tower on [message] · /tower off [message]'],
      'dock.running': ['{tool} running…', '{tool} 运行中…'],
      'dock.statusCounts': ['{total} missions · {active} active · {open} open', '{total} 个任务线 · {active} 个进行中 · {open} 个未完成'],
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
      'dock.preflight': ['pre-merge check {status}', '合并前检查 {status}'],
      'dock.batch': ['batch {status}', '批次 {status}'],
      'dock.doctor': ['doctor {status}', '体检 {status}'],
      'dock.generic': ['done', '已完成'],
      'dock.mode.onLabel': ['on', '已开启'],
      'dock.mode.unknownLabel': ['Tower mode unknown', 'Tower 模式未知'],
      'dock.mode.unknownTooltip': ['The loaded history shows Tower activity but never recorded whether Tower mode was on, so the current state is unknown. Run /tower to check the current Tower mode.', '已加载的历史中有 Tower 活动，但未记录 Tower 模式是否开启，因此当前状态未知。执行 /tower 可查看当前 Tower 模式。'],
      'dock.mode.tooltip': ['Tower mode is on for this session. Run /tower off in the composer to leave Tower mode.', '此会话已开启 Tower 模式。在输入框中执行 /tower off 可退出 Tower 模式。'],
      'dock.mode.lastKnown': ['last known from this browser session; run /tower to confirm', '来自此浏览器会话的最后已知状态；执行 /tower 可确认'],
      'dock.mode.repo': ['repository {repo}', '仓库 {repo}'],
      'dock.mode.lockHeld': ['workspace in use by a Tower run', '工作区正被某个 Tower 运行使用'],
      'dock.mode.lockFree': ['workspace free', '工作区空闲'],
      'dock.mode.lastBy': ['last change by {by}', '最近变更者 {by}'],
      'deny.summary': ['Unavailable in Tower mode', 'Tower 模式中不可用'],
      'deny.running': ['Blocked while Tower mode is on', 'Tower 模式开启期间不可用'],
      'deny.reasonLabel': ['Reason', '原因'],
      'deny.reason': ['This tool conflicts with Tower mode, so the call was blocked.', '该工具与 Tower 模式互斥，本次调用已被拦截。'],
      'deny.nextLabel': ['Next step', '下一步'],
      'deny.hint': ['Run /tower off in the composer to leave Tower mode, then use the tool again.', '在输入框中执行 /tower off，退出 Tower 模式后即可继续使用该工具。'],
      'deny.error': ['Tool failed', '工具出错'],
      'deny.tool.wait_agent': ['Wait for agent', '等待代理'],
      'deny.tool.send_message': ['Send message', '发送消息'],
      'deny.tool.list_agents': ['List agents', '代理列表'],
      'deny.tool.interrupt_agent': ['Interrupt agent', '中断代理'],
      'deny.tool.spawn_teammate': ['Spawn teammate', '派生队友'],
      'deny.tool.subagent': ['Subagent', '子代理'],
      'deny.tool.subagent_fork': ['Subagent fork', '子代理分支'],
      'deny.tool.workflow': ['Workflow', '工作流'],
      'deny.tool.ralph': ['Ralph loop', 'Ralph 循环'],
      'deny.tool.todo_write': ['Todo list', '待办清单'],
      'deny.tool.create_goal': ['Create goal', '创建目标'],
      'deny.tool.get_goal': ['View goal', '查看目标'],
      'deny.tool.update_goal': ['Update goal', '更新目标'],
      'deny.tool.team_task_create': ['Create team task', '创建团队任务'],
      'deny.tool.team_task_get': ['View team task', '查看团队任务'],
      'deny.tool.team_task_list': ['List team tasks', '列出团队任务'],
      'deny.tool.team_task_update': ['Update team task', '更新团队任务'],
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
      reviewStatus: { clean: ['clean', '通过'], p1: ['{count} blocking problem(s)', '{count} 个阻塞性问题'], p2: ['{count} advisory problem(s)', '{count} 个建议性问题'] },
      mergeVerdict: { merge: ['merge now', '现在合并'], 'fix-then-merge': ['fix first, then merge', '先修复再合并'], hold: ['hold for now', '暂缓合并'] },
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
