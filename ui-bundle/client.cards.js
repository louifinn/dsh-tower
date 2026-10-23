// dsh-tower-ui 0.2.2 — the per-tool card models (toolview surface).
//
// One model per Tower tool plus the shared fallbacks for foreign/older result
// shapes. Package-local chunk loaded by client.js (#71).
window.__ModuleLoader__.load({
  id: 'dsh-tower-ui',
  chunk: 'client.cards.js',
  factory() {
    function createCards(env) {
      const { h, translate, ST, helpers } = env
      const {
        isPlainObject,
        truncate,
        firstLine,
        blockersOf,
        toneForPayload,
        countsOf,
        missionLine,
        toneForStatus,
        taskCountsOf,
        missionBlocksOf,
        checkEntries,
        checkSummary,
        checkText,
        shortCommit,
        TOOL_SET,
      } = helpers

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

      // Owner props supplied by the Chat tool-call tree: callId, toolName,
      // phase ('preparing' | 'start' | 'result'), block, cwd, home, openFile,
      // loadImage, inspect, useDisclosure — plus the session-scope standard kit.
      // `phase === 'result'` means `block` is the settled `tool/result` block.
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

      return { rowElement, cardModel }
    }

    return { createCards }
  },
})
