// Tower tools: init, plan, mission, status, spawn, roster, adopt.
import { Tower } from './tower.js'

const OUTPUT = {
  schema: { type: 'object' },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
}

const ROLE_ENUM = ['worker', 'reviewer']

function define(ctx, definition) {
  ctx.effect(() => ctx.tools.register(definition))
}

function fail(message) {
  throw new Error(message)
}

function textOf(blocks) {
  if (!Array.isArray(blocks)) return null
  return blocks
    .map((block) => (block && block.type === 'text' ? block.text : `[${block && block.type}]`))
    .join('\n')
}

async function observeActivity(ctx, tower) {
  const view = await tower.rosterView()
  const subagents = ctx.get('subagents')
  const activity = {}
  const parentStatus = {}
  if (!subagents) return { activity, parentStatus }
  const parents = [...new Set(view.roster.map((entry) => entry.parentSessionId).filter(Boolean))]
  for (const parent of parents) {
    try {
      const rows = await subagents.listDescendants(parent)
      for (const row of rows) activity[String(row.id)] = row.activity ?? 'unknown'
      parentStatus[parent] = 'ok'
    } catch (error) {
      parentStatus[parent] = `unavailable: ${String(error?.message ?? error)}`
    }
  }
  return { activity, parentStatus }
}

function workerBriefing({ repoRoot, base, mission, deps, worktree, instructions }) {
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
  lines.push('')
  lines.push('Rules:')
  lines.push(`- Pass workdir="${worktree.path}" on every shell command; never edit the main checkout.`)
  lines.push('- Stay inside the declared scope; out-of-scope changes are rejected later.')
  lines.push('- Commit your work on the mission branch. Do not merge, push, or spawn other agents.')
  lines.push(
    `- Update progress: tower_mission({repoRoot:"${repoRoot}",id:"${mission.id}",task_done:"..."}) or blocker:"...".`,
  )
  lines.push(
    `- When the work is finished and every task is closed, call tower_complete({repoRoot:"${repoRoot}",missionId:"${mission.id}",report:"<full handoff>"}). Unread inbox messages block completion, so read them with tower_inbox first.`,
  )
  lines.push('- Your final message is the full handoff: files changed, how you verified, what remains.')
  if (instructions) {
    lines.push('')
    lines.push('Extra tower instructions:')
    lines.push(instructions)
  }
  return lines.join('\n')
}

function reviewerBriefing({ repoRoot, base, mission, deps, worktree, instructions }) {
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

export function registerTowerTools(ctx) {
  define(ctx, {
    name: 'tower_init',
    description:
      'Initialize Tower mission state for a repository (absolute repoRoot). Creates <git-common-dir>/dsh-tower/state.json and an activity log; idempotent on an existing workspace. Optionally records the local base branch missions will later fork from and merge back into.',
    parameters: {
      type: 'object',
      properties: {
        repoRoot: { type: 'string', description: 'Absolute path inside the target Git repository.' },
        base: { type: 'string', description: 'Optional local base branch (defaults to the checked-out branch).' },
      },
      required: ['repoRoot'],
      additionalProperties: false,
    },
    output: OUTPUT,
    async execute(args) {
      const tower = await Tower.open(args.repoRoot)
      return tower.init({ base: args.base })
    },
  })

  define(ctx, {
    name: 'tower_plan',
    description:
      'Plan one or more missions in an initialized repository. Each mission has a printable-ASCII title, relative scope globs, optional task checklist, optional mission-id dependencies, and kind build|survey. Assigns M1.. ids and auto-adds a dependency when build scopes overlap (serializes merges); rejects dependency cycles.',
    parameters: {
      type: 'object',
      properties: {
        repoRoot: { type: 'string', description: 'Absolute path inside the target Git repository.' },
        missions: {
          type: 'array',
          description: 'Missions to create, in intended order.',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: 'Printable ASCII title; used as the mission label.' },
              scope: { type: 'array', items: { type: 'string' }, description: 'Relative file globs this mission may touch; empty only for survey.' },
              tasks: { type: 'array', items: { type: 'string' }, description: 'Verifiable task items the worker ticks off.' },
              deps: { type: 'array', items: { type: 'string' }, description: 'Mission ids that must merge before this one.' },
              kind: { type: 'string', enum: ['build', 'survey'], description: 'survey = read-only investigation that reserves no scope.' },
              context: { type: 'string', description: "The user's own key sentences, verbatim (max 4096 chars)." },
            },
            required: ['title'],
            additionalProperties: false,
          },
        },
      },
      required: ['repoRoot', 'missions'],
      additionalProperties: false,
    },
    output: OUTPUT,
    async execute(args) {
      const tower = await Tower.open(args.repoRoot)
      return tower.plan({ missions: args.missions })
    },
  })

  define(ctx, {
    name: 'tower_mission',
    description:
      'Update one mission: lifecycle status, decision note, blocker, clear blockers, mark a task done, drop a task with a reason, or widen the scope (tower only). "merged" is never set here; only a future tower_merge records it. Merged and abandoned are terminal.',
    parameters: {
      type: 'object',
      properties: {
        repoRoot: { type: 'string', description: 'Absolute path inside the target Git repository.' },
        id: { type: 'string', description: 'Mission id, e.g. M1.' },
        status: {
          type: 'string',
          enum: ['planned', 'active', 'completed', 'blocked', 'paused', 'abandoned'],
          description: 'New lifecycle status.',
        },
        note: { type: 'string', description: 'Append a decision-log note.' },
        blocker: { type: 'string', description: 'Report a blocker (also sets status to blocked).' },
        clear_blockers: { type: 'boolean', description: 'Clear all recorded blockers.' },
        task_done: { type: 'string', description: 'Mark the first open task containing this text as done.' },
        task_drop: { type: 'string', description: 'Mark the first open task containing this text as dropped.' },
        task_drop_reason: { type: 'string', description: 'Required with task_drop: why the task is legitimately descoped.' },
        scope: { type: 'array', items: { type: 'string' }, description: 'Tower only: replacement scope globs; bumps scopeGeneration.' },
      },
      required: ['repoRoot', 'id'],
      additionalProperties: false,
    },
    output: OUTPUT,
    async execute(args) {
      const tower = await Tower.open(args.repoRoot)
      return tower.mission({
        id: args.id,
        status: args.status,
        note: args.note,
        blocker: args.blocker,
        clear_blockers: args.clear_blockers,
        task_done: args.task_done,
        task_drop: args.task_drop,
        task_drop_reason: args.task_drop_reason,
        scope: args.scope,
      })
    },
  })

  define(ctx, {
    name: 'tower_status',
    description:
      'Read the Tower dashboard for a repository: state path, base branch, revision, mission status counts, per-mission summary (scope/deps/tasks/worktree/owner), roster size, and the activity tail. Read-only.',
    parameters: {
      type: 'object',
      properties: {
        repoRoot: { type: 'string', description: 'Absolute path inside the target Git repository.' },
      },
      required: ['repoRoot'],
      additionalProperties: false,
    },
    output: OUTPUT,
    async execute(args) {
      const tower = await Tower.open(args.repoRoot)
      return tower.status()
    },
  })

  define(ctx, {
    name: 'tower_spawn',
    description:
      'Spawn a worker or reviewer for a mission. Provisions (or reuses) the mission git worktree and branch, generates a self-contained briefing (mission tasks, scope, deps, context, rules), and starts a background tower-worker subagent in that worktree. Records the agent in the roster and marks the mission active. Returns immediately unless wait=true.',
    parameters: {
      type: 'object',
      properties: {
        repoRoot: { type: 'string', description: 'Absolute path inside the target Git repository.' },
        missionId: { type: 'string', description: 'Mission id, e.g. M1.' },
        role: { type: 'string', enum: ROLE_ENUM, description: 'worker executes; reviewer audits the mission branch.' },
        name: { type: 'string', description: 'Unique roster name; defaults to <role>-<missionId>.' },
        instructions: { type: 'string', description: 'Extra tower instructions appended to the briefing.' },
        worktreeRoot: { type: 'string', description: 'Optional absolute parent directory for the worktree.' },
        wait: { type: 'boolean', description: 'Wait for the child result instead of returning immediately (testing/debug).' },
        waitMs: { type: 'number', description: 'Max wait with wait=true, default 180000.' },
      },
      required: ['repoRoot', 'missionId'],
      additionalProperties: false,
    },
    output: OUTPUT,
    async execute(args, exec) {
      const tower = await Tower.open(args.repoRoot)
      const role = args.role ?? 'worker'
      if (!ROLE_ENUM.includes(role)) fail(`role must be one of ${ROLE_ENUM.join('|')}`)
      const context = await tower.missionContext(args.missionId)
      if (role === 'reviewer' && !context.mission.worktree) {
        fail('reviewer needs an existing mission worktree; spawn a worker first')
      }
      const provisioned = await tower.provision({
        missionId: args.missionId,
        worktreeRoot: args.worktreeRoot,
      })
      const { mission, worktree } = provisioned
      const contextWithWorktree = {
        ...context,
        mission: {
          ...context.mission,
          worktree: { path: worktree.path, branch: worktree.branch, baseCommit: worktree.baseCommit },
        },
      }
      const name = (args.name ?? `${role}-${mission.id.toLowerCase()}`).trim()
      const briefing =
        role === 'worker'
          ? workerBriefing({
              repoRoot: tower.root,
              base: context.base,
              mission: contextWithWorktree.mission,
              deps: context.deps,
              worktree,
              instructions: args.instructions,
            })
          : reviewerBriefing({
              repoRoot: tower.root,
              base: context.base,
              mission: contextWithWorktree.mission,
              deps: context.deps,
              worktree,
              instructions: args.instructions,
            })

      const subagents = ctx.get('subagents')
      if (!subagents) fail('subagents service is unavailable; cannot spawn')
      const providers = subagents.list()
      const provider = providers.includes('spawn') ? 'spawn' : providers[0]
      if (!provider) fail('no subagent provider is registered')

      const activation = await subagents.startActivation({
        provider,
        label: name,
        request: {
          cwd: worktree.path,
          agentPreset: 'tower-worker',
          prompt: [{ type: 'text', text: briefing }],
          parent: exec.agent,
          maxDepth: 1,
        },
        signal: exec.signal,
        delivery: 'parent',
      })
      if (activation.result && typeof activation.result.catch === 'function') {
        activation.result.catch(() => {})
      }

      const agentId = String(activation.childId)
      const entry = await tower.recordSpawn({
        missionId: mission.id,
        name,
        role,
        agentId,
        parentSessionId: String(exec.agent.id),
        cwd: worktree.path,
        branch: worktree.branch,
      })

      const report = {
        name,
        agentId,
        role,
        missionId: mission.id,
        worktree: { path: worktree.path, branch: worktree.branch, baseCommit: worktree.baseCommit },
        created: provisioned.created,
        briefingChars: briefing.length,
        rosterEntry: entry,
        provider,
      }

      if (args.wait === true) {
        const waitMs = Math.max(1000, Math.min(600000, args.waitMs ?? 180000))
        let timer
        const timeout = new Promise((resolve) => {
          timer = setTimeout(() => resolve({ __timeout: true }), waitMs)
        })
        let result
        try {
          result = await Promise.race([activation.result, timeout])
        } finally {
          clearTimeout(timer)
        }
        if (result && result.__timeout) {
          report.timedOut = true
        } else {
          report.stopReason = result?.stopReason ?? null
          report.output = textOf(result?.output)
          report.diagnostic = result?.diagnostic ?? null
        }
      }
      return report
    },
  })

  define(ctx, {
    name: 'tower_roster',
    description:
      'List tower roster agents with authoritative live activity from the subagent catalog (running/inactive/missing/unknown). Read-only; never resumes children. Use before completion or merge decisions.',
    parameters: {
      type: 'object',
      properties: {
        repoRoot: { type: 'string', description: 'Absolute path inside the target Git repository.' },
      },
      required: ['repoRoot'],
      additionalProperties: false,
    },
    output: OUTPUT,
    async execute(args) {
      const tower = await Tower.open(args.repoRoot)
      const view = await tower.rosterView()
      const subagents = ctx.get('subagents')
      if (!subagents) fail('subagents service is unavailable; cannot observe roster')

      const parents = [...new Set(view.roster.map((entry) => entry.parentSessionId).filter(Boolean))]
      const activity = new Map()
      const parentStatus = {}
      for (const parent of parents) {
        try {
          const rows = await subagents.listDescendants(parent)
          for (const row of rows) activity.set(String(row.id), row.activity ?? 'unknown')
          parentStatus[parent] = 'ok'
        } catch (error) {
          parentStatus[parent] = `unavailable: ${String(error?.message ?? error)}`
        }
      }

      const roster = view.roster.map((entry) => {
        const observed = activity.get(entry.agentId)
        const known = parentStatus[entry.parentSessionId] === 'ok'
        return {
          ...entry,
          activity: observed ?? (known ? 'missing' : 'unknown'),
          observed: observed !== undefined,
        }
      })
      return { revision: view.revision, roster, parentStatus, missions: view.missions }
    },
  })

  define(ctx, {
    name: 'tower_adopt',
    description:
      'Reconcile the roster with the durable subagent catalog after a restart or new session. Agents that are provably gone are marked retired (records are kept); agents whose parent catalog cannot be read stay unknown and are never retired. Does not resume, reassign, or delete any mission or worktree.',
    parameters: {
      type: 'object',
      properties: {
        repoRoot: { type: 'string', description: 'Absolute path inside the target Git repository.' },
      },
      required: ['repoRoot'],
      additionalProperties: false,
    },
    output: OUTPUT,
    async execute(args) {
      const tower = await Tower.open(args.repoRoot)
      const view = await tower.rosterView()
      const subagents = ctx.get('subagents')
      if (!subagents) fail('subagents service is unavailable; cannot adopt')

      const parents = [...new Set(view.roster.map((entry) => entry.parentSessionId).filter(Boolean))]
      const activity = new Map()
      const parentStatus = {}
      for (const parent of parents) {
        try {
          const rows = await subagents.listDescendants(parent)
          for (const row of rows) activity.set(String(row.id), row.activity ?? 'unknown')
          parentStatus[parent] = 'ok'
        } catch (error) {
          parentStatus[parent] = `unavailable: ${String(error?.message ?? error)}`
        }
      }

      const retiredCandidates = []
      for (const entry of view.roster) {
        if (entry.state === 'retired') continue
        if (parentStatus[entry.parentSessionId] !== 'ok') continue
        if (!activity.has(entry.agentId)) retiredCandidates.push(entry.agentId)
      }
      const { retired } = await tower.markRetired(retiredCandidates)
      const after = await tower.rosterView()
      return {
        retired,
        skippedUnknownParents: Object.entries(parentStatus)
          .filter(([, status]) => status !== 'ok')
          .map(([parent]) => parent),
        roster: after.roster,
        parentStatus,
      }
    },
  })

  define(ctx, {
    name: 'tower_send',
    description:
      'Send a durable inbox message to a tower participant: a roster agent name, "tower", or "all" (broadcast). The message is persisted first; when the recipient is a currently running roster agent the tower also steers it into that child\'s current turn. Returns delivery results.',
    parameters: {
      type: 'object',
      properties: {
        repoRoot: { type: 'string', description: 'Absolute path inside the target Git repository.' },
        to: { type: 'string', description: 'Recipient: a roster agent name, "tower", or "all".' },
        subject: { type: 'string', description: 'One-line subject.' },
        body: { type: 'string', description: 'Full message body (markdown).' },
        scope: { type: 'string', description: 'Optional scope tag, e.g. the mission id.' },
      },
      required: ['repoRoot', 'to', 'subject', 'body'],
      additionalProperties: false,
    },
    output: OUTPUT,
    async execute(args, exec) {
      const tower = await Tower.open(args.repoRoot)
      const view = await tower.rosterView()
      const self = view.roster.find((entry) => entry.agentId === String(exec.agent.id))
      const from = self ? self.name : 'tower'
      if (typeof args.subject !== 'string' || args.subject.trim().length === 0) {
        fail('tower_send requires a subject')
      }
      if (typeof args.body !== 'string' || args.body.trim().length === 0) {
        fail('tower_send requires a body')
      }
      const message = await tower.recordMessage({
        from,
        to: args.to,
        subject: args.subject.trim(),
        body: args.body,
        scope: args.scope,
      })

      const subagents = ctx.get('subagents')
      const results = []
      if (!subagents) {
        results.push({ target: '*', pushed: false, reason: 'subagents service unavailable; persisted only' })
      } else {
        const roster = view.roster
        const parents = [...new Set(roster.map((entry) => entry.parentSessionId).filter(Boolean))]
        const activity = new Map()
        for (const parent of parents) {
          try {
            const rows = await subagents.listDescendants(parent)
            for (const row of rows) activity.set(String(row.id), row.activity ?? 'unknown')
          } catch {
            // an unreadable parent catalog only means "do not wake it"
          }
        }
        const targets =
          args.to === 'all' ? roster.map((entry) => entry.name) : [args.to]
        for (const targetName of targets) {
          if (targetName === 'tower') {
            results.push({ target: 'tower', pushed: false, reason: 'tower reads its inbox' })
            continue
          }
          const entry = roster.find((candidate) => candidate.name === targetName)
          if (!entry) {
            results.push({ target: targetName, pushed: false, reason: 'not in roster' })
            continue
          }
          if (activity.get(entry.agentId) !== 'running') {
            results.push({ target: targetName, pushed: false, reason: 'not running; queued in inbox' })
            continue
          }
          try {
            await subagents.sendMessage(
              exec.agent,
              entry.agentId,
              [
                {
                  type: 'text',
                  text: `[tower inbox ${message.id}] ${message.subject}\n\n${message.body}`,
                },
              ],
              { signal: exec.signal },
            )
            results.push({ target: targetName, pushed: true })
          } catch (error) {
            results.push({ target: targetName, pushed: false, reason: String(error?.message ?? error) })
          }
        }
      }
      if (results.length > 0) await tower.recordDelivery(message.id, results)
      return {
        message: { id: message.id, from, to: message.to, subject: message.subject },
        deliveries: results,
      }
    },
  })

  define(ctx, {
    name: 'tower_inbox',
    description:
      'Read your tower inbox: messages addressed to you plus broadcasts, newest first. Only returned messages are acknowledged; the result reports unreadRemaining, so keep reading until it reaches 0. Set include_read for history. Unread messages block tower_complete.',
    parameters: {
      type: 'object',
      properties: {
        repoRoot: { type: 'string', description: 'Absolute path inside the target Git repository.' },
        limit: { type: 'number', description: 'Max messages to return (default 20), newest first.' },
        include_read: { type: 'boolean', description: 'Include previously acknowledged messages for history lookup.' },
      },
      required: ['repoRoot'],
      additionalProperties: false,
    },
    output: OUTPUT,
    async execute(args, exec) {
      const tower = await Tower.open(args.repoRoot)
      const view = await tower.rosterView()
      const self = view.roster.find((entry) => entry.agentId === String(exec.agent.id))
      const reader = self ? self.name : 'tower'
      return tower.inbox({ reader, limit: args.limit, includeRead: args.include_read === true })
    },
  })

  define(ctx, {
    name: 'tower_complete',
    description:
      'Worker-only: report mission completion. Enforced by the store: every task done or dropped, no blockers, the mission branch has at least one commit since its spawn base, and no unread inbox messages. Stores the full report; completion means awaiting review, not merged.',
    parameters: {
      type: 'object',
      properties: {
        repoRoot: { type: 'string', description: 'Absolute path inside the target Git repository.' },
        missionId: { type: 'string', description: 'Mission id, e.g. M1.' },
        report: { type: 'string', description: 'Full completion report for the tower and the next review round.' },
      },
      required: ['repoRoot', 'missionId', 'report'],
      additionalProperties: false,
    },
    output: OUTPUT,
    async execute(args, exec) {
      const tower = await Tower.open(args.repoRoot)
      return tower.complete({
        missionId: args.missionId,
        agentId: String(exec.agent.id),
        report: args.report,
      })
    },
  })

  define(ctx, {
    name: 'tower_finding',
    description:
      'File a structured finding (bug / improve / vuln / idea) for the tower to route. Use this for anything notable OUTSIDE your mission scope instead of editing out-of-scope files. Severity is one of low|medium|high|critical.',
    parameters: {
      type: 'object',
      properties: {
        repoRoot: { type: 'string', description: 'Absolute path inside the target Git repository.' },
        type: { type: 'string', enum: ['bug', 'improve', 'vuln', 'idea'], description: 'Finding category.' },
        title: { type: 'string', description: 'Short finding title.' },
        severity: { type: 'string', enum: ['low', 'medium', 'high', 'critical'], description: 'Optional severity.' },
        summary: { type: 'string', description: 'What was found, in a sentence or two.' },
        location: { type: 'string', description: 'File/symbol the finding concerns.' },
        details: { type: 'string', description: 'Full details: evidence, reproduction, impact.' },
        suggested_fix: { type: 'string', description: 'What you would do about it.' },
        missionId: { type: 'string', description: 'Optional mission this finding relates to.' },
      },
      required: ['repoRoot', 'type', 'title', 'summary', 'details', 'suggested_fix'],
      additionalProperties: false,
    },
    output: OUTPUT,
    async execute(args, exec) {
      const tower = await Tower.open(args.repoRoot)
      const view = await tower.rosterView()
      const self = view.roster.find((entry) => entry.agentId === String(exec.agent.id))
      return tower.addFinding({
        type: args.type,
        title: args.title,
        severity: args.severity,
        summary: args.summary,
        location: args.location,
        details: args.details,
        suggested_fix: args.suggested_fix,
        missionId: args.missionId,
        reportedBy: self ? self.name : 'tower',
      })
    },
  })

  define(ctx, {
    name: 'tower_review',
    description:
      'Submit an independent review verdict for a completed mission, bound to the current branch tip. status is "clean", "p1-Nitems", or "p2-Nitems"; merge is "merge", "fix-then-merge", or "hold" (only clean + merge is later approval). Non-clean returns the mission to active. Reviewers are capped at 5 rounds per branch; a tower-submitted review is break-glass and requires breakGlassReason.',
    parameters: {
      type: 'object',
      properties: {
        repoRoot: { type: 'string', description: 'Absolute path inside the target Git repository.' },
        missionId: { type: 'string', description: 'Mission id, e.g. M1.' },
        status: { type: 'string', description: 'Verdict: "clean", or "p1-Nitems" / "p2-Nitems" with the number of findings at that priority.' },
        merge: { type: 'string', enum: ['merge', 'fix-then-merge', 'hold'], description: 'Merge recommendation for the tower.' },
        findings: { type: 'string', description: 'Full findings text (markdown); write "none" when clean.' },
        checks: { type: 'array', items: { type: 'string' }, description: 'Checklist items you verified.' },
        decision: { type: 'string', description: 'The reasoning behind your verdict.' },
        breakGlassReason: { type: 'string', description: 'Tower-only exceptional self-review: why no independent reviewer was used.' },
      },
      required: ['repoRoot', 'missionId', 'status', 'merge', 'findings', 'decision'],
      additionalProperties: false,
    },
    output: OUTPUT,
    async execute(args, exec) {
      const tower = await Tower.open(args.repoRoot)
      return tower.submitReview({
        missionId: args.missionId,
        agentId: String(exec.agent.id),
        status: args.status,
        merge: args.merge,
        findings: args.findings,
        checks: args.checks,
        decision: args.decision,
        breakGlassReason: args.breakGlassReason,
      })
    },
  })

  define(ctx, {
    name: 'tower_preflight',
    description:
      'Read-only merge gate for one mission: returns ok plus stable blocker codes (branch-missing, deps-unmerged, read-only-survey, stale-base, no-review, review-hold, not-clean, review-not-approved, tip-moved, review-mission-mismatch, out-of-scope, base-dirty, branch-owned-by-closed-missions, and mission/worker guards). Never changes anything.',
    parameters: {
      type: 'object',
      properties: {
        repoRoot: { type: 'string', description: 'Absolute path inside the target Git repository.' },
        missionId: { type: 'string', description: 'Mission id, e.g. M1.' },
      },
      required: ['repoRoot', 'missionId'],
      additionalProperties: false,
    },
    output: OUTPUT,
    async execute(args) {
      const tower = await Tower.open(args.repoRoot)
      const { activity } = await observeActivity(ctx, tower)
      const gate = await tower.evaluateGate({ missionId: args.missionId, activity })
      return {
        ok: gate.ok,
        blockers: gate.blockers,
        missionId: args.missionId,
        branchTip: gate.branchTip,
        baseTip: gate.baseTip,
        changedFiles: gate.changedFiles,
        review: gate.review
          ? {
              round: gate.review.round,
              status: gate.review.status,
              mergeVerdict: gate.review.mergeVerdict,
              reviewer: gate.review.reviewer,
              reviewedCommit: gate.review.reviewedCommit,
            }
          : null,
      }
    },
  })

  define(ctx, {
    name: 'tower_merge',
    description:
      'Merge a mission branch into the recorded base branch with --no-ff, after the hard gate passes. Verifies the two merge parents and records the mission as merged. If the merge commit already landed (manual merge, crashed or slow pre-merge hook), it detects the merge commit and records it as reconciled instead of merging again. A failed gate returns stable blocker codes without merging; a hook failure aborts cleanly and returns "merge-hook-failed" while a real content conflict returns "merge-conflict".',
    parameters: {
      type: 'object',
      properties: {
        repoRoot: { type: 'string', description: 'Absolute path inside the target Git repository.' },
        missionId: { type: 'string', description: 'Mission id, e.g. M1.' },
        timeoutMs: {
          type: 'integer',
          minimum: 1000,
          description: 'Optional timeout for the merge command in milliseconds, including pre-merge hooks (default 15 minutes).',
        },
      },
      required: ['repoRoot', 'missionId'],
      additionalProperties: false,
    },
    output: OUTPUT,
    async execute(args) {
      const tower = await Tower.open(args.repoRoot)
      const { activity } = await observeActivity(ctx, tower)
      return tower.merge({ missionId: args.missionId, activity, timeoutMs: args.timeoutMs })
    },
  })

  define(ctx, {
    name: 'tower_rebase',
    description:
      'Rebase a mission branch onto the current base tip inside its own worktree. Refuses while its worker is running or the worktree is dirty. A clean conflict-free rebase waives re-review for the old review; a conflict is aborted and the mission is marked blocked. If the branch is already contained in the base, it returns alreadyMerged and leaves the branch untouched so tower_merge can record the landed merge.',
    parameters: {
      type: 'object',
      properties: {
        repoRoot: { type: 'string', description: 'Absolute path inside the target Git repository.' },
        missionId: { type: 'string', description: 'Mission id, e.g. M1.' },
      },
      required: ['repoRoot', 'missionId'],
      additionalProperties: false,
    },
    output: OUTPUT,
    async execute(args) {
      const tower = await Tower.open(args.repoRoot)
      const { activity } = await observeActivity(ctx, tower)
      return tower.rebase({ missionId: args.missionId, activity })
    },
  })

  define(ctx, {
    name: 'tower_teardown',
    description:
      'Tear down eligible mission worktrees after their missions are merged or abandoned. A worktree whose roster agent is running is always kept (force cannot override); dirty worktrees need force; exclude keeps named missions. dry_run previews the remove/keep decisions without changing anything.',
    parameters: {
      type: 'object',
      properties: {
        repoRoot: { type: 'string', description: 'Absolute path inside the target Git repository.' },
        force: { type: 'boolean', description: 'Remove worktrees that contain uncommitted changes (never a live agent).' },
        exclude: { type: 'array', items: { type: 'string' }, description: 'Mission ids to keep.' },
        dry_run: { type: 'boolean', description: 'Preview remove/keep decisions without changing disk or state.' },
      },
      required: ['repoRoot'],
      additionalProperties: false,
    },
    output: OUTPUT,
    async execute(args) {
      const tower = await Tower.open(args.repoRoot)
      const { activity } = await observeActivity(ctx, tower)
      return tower.teardown({
        force: args.force === true,
        exclude: args.exclude,
        dryRun: args.dry_run === true,
        activity,
      })
    },
  })
}
