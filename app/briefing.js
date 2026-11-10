// Mission briefings: pure text builders for worker/reviewer prompts.
import { shapeFor } from '../domain/shapes/index.js'

function clip(text, max = 2000) {
  const value = String(text ?? '')
  return value.length > max ? `${value.slice(0, max)}\n… truncated` : value
}

/**
 * Dependency lines shared by the worker and reviewer briefings. A survey
 * dependency carries its recorded result (#148 D6) alongside its status, with
 * bounded formatting so a large evidence set cannot crowd out the mission.
 * @param {any[]} deps
 * @returns {string[]}
 */
function dependencyLines(deps) {
  const lines = []
  for (const dep of deps) {
    lines.push(`- ${dep.id} ${dep.title ?? ''} (${dep.status}${dep.kind ? `, ${dep.kind}` : ''})`)
    const result = dep.result
    if (!result || typeof result !== 'object') continue
    const evidence = []
    if (Array.isArray(result.paths) && result.paths.length > 0) evidence.push(`paths: ${result.paths.slice(0, 20).join(', ')}`)
    if (Array.isArray(result.symbols) && result.symbols.length > 0) evidence.push(`symbols: ${result.symbols.slice(0, 20).join(', ')}`)
    if (Array.isArray(result.plan) && result.plan.length > 0) evidence.push(`plan: ${clip(result.plan.slice(0, 20).join('; '), 1200)}`)
    if (typeof result.notes === 'string' && result.notes.trim()) evidence.push(`notes: ${clip(result.notes.trim(), 1200)}`)
    if (evidence.length > 0) lines.push(`  evidence: ${evidence.join(' | ')}`)
  }
  return lines
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
  const shape = shapeFor(mission.kind)
  // The checkout the worker actually runs in: a recorded detached sandbox wins
  // over the (absent) worktree, then a build worktree, then the shared main
  // checkout. The spawn cwd uses the same precedence, so the prompt matches the
  // process the agent is started in.
  const cwd = mission.sandbox ?? worktree?.path ?? repoRoot
  const lines = []
  lines.push(`# Tower mission ${mission.id} — ${mission.title}`)
  lines.push('')
  lines.push(`You are the tower worker for mission ${mission.id} in repository ${repoRoot}.`)
  lines.push('')
  lines.push(
    ...shape.briefing(mission, {
      repoRoot,
      base,
      worktree,
      readCommit: /** @type {string | undefined} */ (mission.readCommit),
      readDirty: mission.readDirty,
    }),
  )
  lines.push('')
  lines.push(`Kind: ${mission.kind}`)
  // The empty scope means different things by shape: a build still owns its
  // worktree, a detached survey owns a disposable writable sandbox, and only a
  // shared survey is strictly read-only.
  const emptyScope = shape.fields.worktree
    ? '(none declared — stay inside your worktree)'
    : shape.fields.sandbox && mission.sandbox
      ? '(none declared — the detached survey sandbox is disposable: write and run commands inside it, but never commit or leave it)'
      : '(none — survey is read-only)'
  lines.push(`Scope (only files you may touch): ${mission.scope.length > 0 ? mission.scope.join(', ') : emptyScope}`)
  if (mission.tasks.length > 0) {
    lines.push('Tasks:')
    for (const task of mission.tasks) lines.push(`- [${task.status}] ${task.text}`)
  }
  if (deps.length > 0) {
    lines.push('Dependencies:')
    lines.push(...dependencyLines(deps))
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
  if (mission.result) {
    lines.push('')
    lines.push('Recorded evidence (from a previous completion):')
    lines.push(`- ${JSON.stringify(mission.result)}`)
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
  if (shape.fields.worktree) {
    lines.push(`- Pass workdir="${cwd}" on every shell command; never edit the main checkout.`)
    lines.push('- Stay inside the declared scope; out-of-scope changes are rejected later.')
    lines.push('- Commit your work on the mission branch. Do not merge, push, or spawn other agents.')
  } else if (shape.fields.sandbox && mission.sandbox) {
    lines.push(`- Pass workdir="${mission.sandbox}" on every shell command; that checkout is a disposable detached sandbox, not the main checkout.`)
    lines.push('- You may write files and run commands inside the sandbox, but never commit: completion requires the sandbox HEAD to still equal the recorded commit and zero new commits.')
    lines.push(`- Stay inside the sandbox; never edit the main checkout ${repoRoot}. Do not merge, push, or spawn other agents.`)
  } else {
    lines.push(`- Read the shared checkout at ${cwd}; it is the main checkout, not your own worktree.`)
    lines.push(
      '- Make no commits: this mission reads one fixed commit. Do not write, edit, merge, push, rebase, or spawn other agents.',
    )
  }
  lines.push(
    `- Update progress: tower_mission({repoRoot:"${repoRoot}",id:"${mission.id}",task_done:"..."}) or blocker:"...".`,
  )
  const resultHint = shape.acceptsResult
    ? ' Optionally record evidence as result:{paths?:string[],symbols?:string[],plan?:string[],notes?:string}.'
    : ''
  lines.push(
    `- When the work is finished and every task is closed, call tower_complete({repoRoot:"${repoRoot}",missionId:"${mission.id}",report:"<full handoff>",checks:[{name,command,exitCode,evidence}]}).${resultHint} Unread inbox messages block completion, so read them with tower_inbox first.`,
  )
  lines.push(
    shape.fields.worktree
      ? '- Your final message is the full handoff: files changed, how you verified, what remains.'
      : '- Your final message is the full handoff: what you inspected, how you verified it, what remains.',
  )
  if (instructions) {
    lines.push('')
    lines.push('Extra tower instructions:')
    lines.push(instructions)
  }
  return lines.join('\n')
}

/**
 * @param {{ repoRoot: string, base: string, mission: any, deps: any[],
 *   worktree: any, review?: { commit: string, path: string } | null,
 *   instructions?: string, reviews?: any[], findings?: any[],
 *   completionReport?: any }} input
 */
export function reviewerBriefing({
  repoRoot,
  base,
  mission,
  deps,
  worktree,
  review = null,
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
  if (review) {
    lines.push(`Review commit: ${String(review.commit).slice(0, 12)} (the evidence your verdict is stamped with)`)
    lines.push(`Checkout: ${review.path}`)
    lines.push('')
    lines.push(`Read and inspect the review commit in ${review.path}; that checkout is removed after your verdict.`)
  }
  lines.push('')
  lines.push(`Kind: ${mission.kind}`)
  if (mission.tasks.length > 0) {
    lines.push('The worker was asked to complete:')
    for (const task of mission.tasks) lines.push(`- [${task.status}] ${task.text}`)
  }
  if (deps.length > 0) {
    lines.push('Dependencies:')
    lines.push(...dependencyLines(deps))
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
  if (review) {
    lines.push(`- Pass workdir="${review.path}" on every command: the checkout is a detached read of commit ${String(review.commit).slice(0, 12)}, not the mutable mission worktree.`)
    lines.push('- tower_diff shows the recorded commit your verdict will stamp; do not review anything newer.')
  }
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
