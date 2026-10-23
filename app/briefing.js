// Mission briefings: pure text builders for worker/reviewer prompts.

function clip(text, max = 2000) {
  const value = String(text ?? '')
  return value.length > max ? `${value.slice(0, max)}\n… truncated` : value
}

export function workerBriefing({
  repoRoot,
  base,
  mission,
  deps,
  worktree,
  instructions,
  reviews = [],
  findings = [],
  completionReport = null,
}) {
  const completion = /** @type {import('../types/index.js').CompletionReport | null} */ (completionReport)
  const lines = []
  lines.push(`# Tower mission ${mission.id} — ${mission.title}`)
  lines.push('')
  lines.push(`You are the tower worker for mission ${mission.id} in repository ${repoRoot}.`)
  lines.push('')
  lines.push(`Work ONLY in this git worktree: ${worktree.path}`)
  lines.push(`Branch: ${worktree.branch} (based on ${base} @ ${String(worktree.baseCommit).slice(0, 12)})`)
  lines.push('')
  lines.push(`Kind: ${mission.kind}`)
  lines.push(
    `Scope (only files you may touch): ${mission.scope.length > 0 ? mission.scope.join(', ') : '(none — survey is read-only)'}`,
  )
  if (mission.tasks.length > 0) {
    lines.push('Tasks:')
    for (const task of mission.tasks) lines.push(`- [${task.status}] ${task.text}`)
  }
  if (deps.length > 0) {
    lines.push('Dependencies:')
    for (const dep of deps) lines.push(`- ${dep.id} ${dep.title ?? ''} (${dep.status})`)
  }
  if (mission.context) {
    lines.push('Context (verbatim from the user):')
    lines.push(mission.context)
  }
  if ((mission.references ?? []).length > 0) {
    lines.push('References (read-only pointers; read them before deciding):')
    for (const reference of mission.references) lines.push(`- ${reference}`)
  }
  if (mission.reviewPolicy === 'none') {
    lines.push(`Review policy: none (user exemption: ${mission.reviewExemptionReason ?? 'missing reason'})`)
  }
  if (completion) {
    lines.push('')
    lines.push(`Previous completion report (by ${completion.by ?? 'worker'}):`)
    lines.push(clip(completion.report, 1500))
    if ((completion.checks ?? []).length > 0) {
      lines.push('Previous checks:')
      for (const check of completion.checks ?? []) lines.push(`- ${check.name}${check.exitCode !== undefined ? ` (exit ${check.exitCode})` : ''}`)
    }
  }
  if (reviews.length > 0) {
    lines.push('')
    lines.push('Previous review rounds for this branch (newest first) — address every finding:')
    for (const review of reviews) {
      lines.push(`- R${review.round} by ${review.reviewer}: ${review.status} / ${review.mergeVerdict}`)
      if (review.findings) lines.push(`  findings: ${clip(review.findings, 1200).replaceAll('\n', '\n  ')}`)
      if (review.decision) lines.push(`  decision: ${clip(review.decision, 600)}`)
    }
  }
  if (findings.length > 0) {
    lines.push('')
    lines.push('Findings related to this mission:')
    for (const finding of findings) lines.push(`- ${finding.id} [${finding.status}] ${finding.severity ?? 'severity?'} ${finding.title}`)
  }
  lines.push('')
  lines.push('Rules:')
  lines.push(`- Pass workdir="${worktree.path}" on every shell command; never edit the main checkout.`)
  lines.push('- Stay inside the declared scope; out-of-scope changes are rejected later.')
  lines.push('- Commit your work on the mission branch. Do not merge, push, or spawn other agents.')
  lines.push(
    `- Update progress: tower_mission({repoRoot:"${repoRoot}",id:"${mission.id}",task_done:"..."}) or blocker:"...".`,
  )
  lines.push(
    `- When the work is finished and every task is closed, call tower_complete({repoRoot:"${repoRoot}",missionId:"${mission.id}",report:"<full handoff>",checks:[{name,command,exitCode,evidence}]}). Unread inbox messages block completion, so read them with tower_inbox first.`,
  )
  lines.push('- Your final message is the full handoff: files changed, how you verified, what remains.')
  if (instructions) {
    lines.push('')
    lines.push('Extra tower instructions:')
    lines.push(instructions)
  }
  return lines.join('\n')
}

export function reviewerBriefing({
  repoRoot,
  base,
  mission,
  deps,
  worktree,
  instructions,
  reviews = [],
  findings = [],
  completionReport = null,
}) {
  const completion = /** @type {import('../types/index.js').CompletionReport | null} */ (completionReport)
  const lines = []
  lines.push(`# Tower review — mission ${mission.id} — ${mission.title}`)
  lines.push('')
  lines.push(`You are the independent reviewer for mission ${mission.id} in repository ${repoRoot}.`)
  lines.push('')
  lines.push(`Review branch: ${worktree.branch}`)
  lines.push(`Worktree: ${worktree.path}`)
  lines.push(`Reviewed base: ${base} @ ${String(worktree.baseCommit).slice(0, 12)}`)
  lines.push('')
  lines.push(`Kind: ${mission.kind}`)
  if (mission.tasks.length > 0) {
    lines.push('The worker was asked to complete:')
    for (const task of mission.tasks) lines.push(`- [${task.status}] ${task.text}`)
  }
  if (deps.length > 0) {
    lines.push('Dependencies:')
    for (const dep of deps) lines.push(`- ${dep.id} ${dep.title ?? ''} (${dep.status})`)
  }
  if (mission.context) {
    lines.push('Context (verbatim from the user):')
    lines.push(mission.context)
  }
  if ((mission.references ?? []).length > 0) {
    lines.push('References (read-only pointers):')
    for (const reference of mission.references) lines.push(`- ${reference}`)
  }
  if (completion) {
    lines.push('')
    lines.push(`Completion report (by ${completion.by ?? 'worker'}):`)
    lines.push(clip(completion.report, 2000))
    if ((completion.checks ?? []).length > 0) {
      lines.push('Completion checks the worker ran:')
      for (const check of completion.checks ?? []) {
        lines.push(
          `- ${check.name}${check.exitCode !== undefined ? ` (exit ${check.exitCode})` : ''}${check.evidence ? ` — ${clip(check.evidence, 400)}` : ''}`,
        )
      }
    }
  }
  if (reviews.length > 0) {
    lines.push('')
    lines.push('Prior review rounds for this branch (newest first):')
    for (const review of reviews) {
      lines.push(`- R${review.round} by ${review.reviewer}: ${review.status} / ${review.mergeVerdict}`)
      if (review.findings) lines.push(`  findings: ${clip(review.findings, 1200).replaceAll('\n', '\n  ')}`)
    }
  }
  if (findings.length > 0) {
    lines.push('')
    lines.push('Related findings:')
    for (const finding of findings) lines.push(`- ${finding.id} [${finding.status}] ${finding.severity ?? 'severity?'} ${finding.title}`)
  }
  lines.push('')
  lines.push('Rules:')
  lines.push('- Read-only: do not modify files, commit, or merge.')
  lines.push('- Inspect the diff from the reviewed base to the branch tip and map every task to the diff.')
  lines.push('- Check scope, correctness, tests, and security. Report severity and concrete evidence.')
  lines.push(
    `- Submit the formal verdict with tower_review({repoRoot:"${repoRoot}",missionId:"${mission.id}",status:"clean",merge:"merge",findings:"none",checks:["..."],decision:"..."}). Use status "p1-Nitems"/"p2-Nitems" and merge "fix-then-merge"/"hold" for problems; a non-clean verdict returns the mission to active.`,
  )
  lines.push(
    `- File out-of-scope issues with tower_finding({repoRoot:"${repoRoot}",type:"bug",title:"...",summary:"...",details:"...",suggested_fix:"..."}) instead of fixing them.`,
  )
  lines.push('- Your final message is the review report; the tool call above is the formal verdict.')
  if (instructions) {
    lines.push('')
    lines.push('Extra tower instructions:')
    lines.push(instructions)
  }
  return lines.join('\n')
}
