// Findings use cases.
import { TowerToolError } from '../lib/errors.js'
import { withLock, writeJsonAtomic, appendJsonl } from '../lib/store.js'
import { validateState } from '../domain/state.js'
import { FINDING_TYPES, FINDING_SEVERITIES, FINDING_STATUSES, FINDING_TRANSITIONS } from '../domain/mission.js'
import { findingSummary, countFindings } from '../domain/summary.js'

function fail(message, code = 'invalid-argument') {
  throw new TowerToolError(code, message)
}

export async function addFinding(tower, input) {
    return withLock(tower.paths, async () => {
      const state = await tower.load()
      if (!Array.isArray(state.findings)) state.findings = []
      if (!FINDING_TYPES.includes(input.type)) {
        fail(`finding type must be one of ${FINDING_TYPES.join('|')}`)
      }
      const title = String(input.title ?? '').trim()
      if (!title) fail('finding title is required')
      const summary = String(input.summary ?? '').trim()
      if (!summary) fail('finding summary is required')
      const details = String(input.details ?? '').trim()
      if (!details) fail('finding details are required')
      const suggestedFix = String(input.suggested_fix ?? '').trim()
      if (!suggestedFix) fail('finding suggested_fix is required')
      const severity = input.severity ?? null
      if (severity !== null && !FINDING_SEVERITIES.includes(severity)) {
        fail(`finding severity must be one of ${FINDING_SEVERITIES.join('|')}`)
      }
      let mission = null
      if (input.missionId !== undefined && input.missionId !== null && input.missionId !== '') {
        mission = state.missions.find((entry) => entry.id === input.missionId)
        if (!mission) fail(`unknown mission "${input.missionId}"`, 'mission-not-found')
      }
      const now = Date.now()
      const seq = (state.findingSeq ?? 0) + 1
      state.findingSeq = seq
      const finding = {
        id: `F${seq}`,
        seq,
        type: input.type,
        title,
        severity,
        summary,
        location: typeof input.location === 'string' && input.location.trim() ? input.location.trim() : null,
        details,
        suggested_fix: suggestedFix,
        missionId: mission ? mission.id : null,
        branch: mission && mission.worktree ? mission.worktree.branch : null,
        reportedBy: input.reportedBy,
        at: now,
        status: 'open',
      }
      state.findings.push(finding)
      state.revision += 1
      state.updatedAt = now

      validateState(state, tower.paths.state)
      await writeJsonAtomic(tower.paths.state, state)
      await appendJsonl(tower.paths.activity, {
        at: now,
        type: 'finding',
        missionId: finding.missionId,
        text: `${finding.id} ${finding.type}: ${finding.title}`,
      })
      return finding
    })
  }

  /** List or read findings. Read-only paths never take the writer lock. */
  export async function readFindings(tower, input = {}) {
    const state = await tower.load()
    const all = state.findings ?? []
    const counts = countFindings(all)
    if (input.id !== undefined && input.id !== null && input.id !== '') {
      const finding = all.find((entry) => entry.id === input.id)
      if (!finding) fail(`unknown finding "${input.id}"`, 'finding-not-found')
      return { finding: { ...finding }, counts, total: all.length, filtered: 1, action: 'read' }
    }
    if (input.status !== undefined && input.status !== 'all') {
      if (!FINDING_STATUSES.includes(input.status)) {
        fail(`finding status must be one of ${FINDING_STATUSES.join('|')}`)
      }
    }
    let visible = all
    if (input.status !== undefined && input.status !== 'all') {
      visible = visible.filter((finding) => (finding.status ?? 'open') === input.status)
    }
    if (input.type !== undefined) {
      if (!FINDING_TYPES.includes(input.type)) fail(`finding type must be one of ${FINDING_TYPES.join('|')}`)
      visible = visible.filter((finding) => finding.type === input.type)
    }
    if (input.severity !== undefined) {
      if (!FINDING_SEVERITIES.includes(input.severity)) {
        fail(`finding severity must be one of ${FINDING_SEVERITIES.join('|')}`)
      }
      visible = visible.filter((finding) => finding.severity === input.severity)
    }
    if (input.missionId !== undefined && input.missionId !== null && input.missionId !== '') {
      visible = visible.filter((finding) => finding.missionId === input.missionId)
    }
    if (input.open === true) {
      visible = visible.filter((finding) => !['fixed', 'wontfix'].includes(finding.status ?? 'open'))
    }
    const limit = Math.max(1, Math.min(200, Number.isInteger(input.limit) ? input.limit : 50))
    const page = visible.slice(-limit).reverse()
    return {
      findings: page.map((finding) => findingSummary(finding)),
      counts,
      total: all.length,
      filtered: visible.length,
      action: 'list',
    }
  }

  /**
   * List, read, or transition findings. Listing and reading are lock-free;
   * only a transition takes the writer lock. Reviewers may only read.
   */
  export async function findings(tower, input = {}) {
    const actor = input.actor ?? { name: 'tower', role: 'tower' }
    if (typeof actor.role !== 'string') fail('finding actor role must be a string')
    const hasId = input.id !== undefined && input.id !== null && input.id !== ''
    const wantsUpdate = hasId && (input.status !== undefined || input.note !== undefined)
    if (!wantsUpdate) return tower.readFindings(input)

    return withLock(tower.paths, async () => {
      const state = await tower.load()
      const all = state.findings ?? []
      const finding = all.find((entry) => entry.id === input.id)
      if (!finding) fail(`unknown finding "${input.id}"`, 'finding-not-found')
      if (actor.role === 'reviewer') {
        fail('reviewers may list and read findings, but only the tower or a worker may change finding status', 'not-authorized')
      }
      const now = Date.now()
      if (input.status !== undefined) {
        if (input.status === 'all') {
          fail('finding status "all" is only a list filter; pass a concrete status when updating')
        }
        if (!FINDING_STATUSES.includes(input.status)) {
          fail(`finding status must be one of ${FINDING_STATUSES.join('|')}`)
        }
        const current = finding.status ?? 'open'
        const allowed = FINDING_TRANSITIONS[current] ?? []
        if (!allowed.includes(input.status)) {
          fail(`finding ${finding.id} cannot move from ${current} to ${input.status}`, 'invalid-transition')
        }
        finding.status = input.status
        if (input.status === 'fixed' || input.status === 'wontfix') finding.closedAt = now
        else delete finding.closedAt
      }
      if (input.note !== undefined) {
        if (typeof input.note !== 'string' || input.note.trim().length === 0) {
          fail('finding note must be a non-empty string')
        }
        if (!Array.isArray(finding.notes)) finding.notes = []
        finding.notes.push({ by: actor.name, at: now, text: input.note.trim() })
      }
      finding.updatedAt = now
      state.revision += 1
      state.updatedAt = now
      validateState(state, tower.paths.state)
      await writeJsonAtomic(tower.paths.state, state)
      await appendJsonl(tower.paths.activity, {
        at: now,
        type: 'finding',
        missionId: finding.missionId,
        text: `${finding.id} ${finding.status}${input.note !== undefined ? ' +note' : ''} (${actor.name})`,
      })
      // Counts must reflect the transition just recorded.
      return { finding: { ...finding }, counts: countFindings(all), total: all.length, filtered: 1, action: 'updated' }
    })
  }
