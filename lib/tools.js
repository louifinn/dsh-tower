// Tower tools: init, plan, mission, status, spawn, roster, adopt, findings.
import { Tower } from './tower.js'
import { TowerToolError, classifyError } from './errors.js'

const S = {
  str: { type: 'string' },
  int: { type: 'integer' },
  bool: { type: 'boolean' },
  arr: (items) => ({ type: 'array', items }),
  obj: (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: true }),
  any: {},
}

const blockerSchema = S.obj({ code: S.str, detail: S.str, cleanup: S.str, timeout: S.bool }, ['code', 'detail'])
const worktreeSchema = S.obj({ path: S.str, branch: S.str, baseCommit: S.str })
const missionSummarySchema = S.obj({
  id: S.str,
  title: S.str,
  kind: S.str,
  status: S.str,
  scope: S.arr(S.str),
  deps: S.arr(S.str),
  owner: S.any,
  worktree: S.any,
  blockers: S.arr(S.str),
  tasks: S.any,
  scopeGeneration: S.int,
  mergedCommit: S.any,
  mergedAt: S.any,
  updatedAt: S.any,
})
const findingSummarySchema = S.obj({
  id: S.str,
  seq: S.int,
  type: S.str,
  title: S.str,
  severity: S.any,
  status: S.str,
  missionId: S.any,
  branch: S.any,
  reportedBy: S.any,
  at: S.any,
  updatedAt: S.any,
  closedAt: S.any,
})

// Per-tool output schemas. `additionalProperties: true` keeps future fields
// additive; `required` lists only fields every successful path returns.
const SCHEMAS = {
  init: S.obj(
    {
      created: S.bool,
      repoRoot: S.str,
      commonDir: S.str,
      statePath: S.str,
      base: S.str,
      revision: S.int,
      missions: S.int,
    },
    ['created', 'repoRoot', 'commonDir', 'statePath', 'base', 'revision', 'missions'],
  ),
  plan: S.obj({ revision: S.int, missions: S.arr(missionSummarySchema) }, ['revision', 'missions']),
  mission: S.obj({ revision: S.int, mission: S.obj() }, ['revision', 'mission']),
  status: S.obj(
    {
      repoRoot: S.str,
      commonDir: S.str,
      statePath: S.str,
      base: S.str,
      revision: S.int,
      counts: S.obj(),
      openTasks: S.int,
      roster: S.int,
      messages: S.int,
      unreadTower: S.int,
      findings: S.int,
      findingsByStatus: S.obj(),
      reviews: S.int,
      config: S.obj({ path: S.any, repoConfigPresent: S.bool, spawn: S.obj() }),
      recentFindings: S.arr(S.obj()),
      missions: S.arr(S.obj()),
      activity: S.arr(S.obj()),
    },
    ['repoRoot', 'commonDir', 'statePath', 'base', 'revision', 'counts', 'missions', 'activity'],
  ),
  spawn: S.obj(
    {
      name: S.str,
      agentId: S.str,
      role: S.str,
      missionId: S.str,
      preset: S.str,
      provider: S.str,
      maxDepth: S.int,
      agentOptions: S.any,
      worktree: worktreeSchema,
      created: S.bool,
      briefingChars: S.int,
      rosterEntry: S.obj(),
      stopReason: S.any,
      timedOut: S.bool,
      output: S.any,
      diagnostic: S.any,
    },
    ['name', 'agentId', 'role', 'missionId', 'preset', 'provider', 'worktree'],
  ),
  roster: S.obj(
    { revision: S.int, roster: S.arr(S.obj()), parentStatus: S.obj(), missions: S.arr(S.obj()) },
    ['revision', 'roster', 'parentStatus', 'missions'],
  ),
  diff: S.obj(
    {
      missionId: S.str,
      branch: S.str,
      baseTip: S.str,
      branchTip: S.str,
      mergeBase: S.str,
      files: S.arr(S.str),
      commits: S.arr(S.str),
      truncated: S.bool,
      patch: S.str,
    },
    ['missionId', 'branch', 'baseTip', 'branchTip', 'mergeBase', 'files', 'commits', 'truncated', 'patch'],
  ),
  adopt: S.obj(
    { retired: S.arr(S.str), skippedUnknownParents: S.arr(S.str), roster: S.arr(S.obj()), parentStatus: S.obj() },
    ['retired', 'skippedUnknownParents', 'roster', 'parentStatus'],
  ),
  send: S.obj({ message: S.obj(), deliveries: S.arr(S.obj()) }, ['message', 'deliveries']),
  inbox: S.obj(
    { reader: S.str, messages: S.arr(S.obj()), pageSize: S.int, unreadRemaining: S.int },
    ['reader', 'messages', 'pageSize', 'unreadRemaining'],
  ),
  complete: S.obj({ mission: S.obj(), commits: S.int, unread: S.int }, ['mission', 'commits', 'unread']),
  finding: S.obj(
    {
      id: S.str,
      seq: S.int,
      type: S.str,
      title: S.str,
      severity: S.any,
      summary: S.str,
      location: S.any,
      details: S.str,
      suggested_fix: S.str,
      missionId: S.any,
      branch: S.any,
      reportedBy: S.any,
      at: S.any,
      status: S.str,
      updatedAt: S.any,
      closedAt: S.any,
      notes: S.arr(S.obj()),
    },
    ['id', 'type', 'title', 'summary', 'details', 'suggested_fix', 'status'],
  ),
  findings: S.obj(
    {
      findings: S.arr(findingSummarySchema),
      finding: S.obj(),
      counts: S.obj(),
      total: S.int,
      filtered: S.int,
      action: S.str,
    },
    ['counts', 'total'],
  ),
  review: S.obj(
    { review: S.obj(), branchTip: S.str, missionStatus: S.str, round: S.int, reviewerRounds: S.int },
    ['review', 'branchTip', 'missionStatus', 'round', 'reviewerRounds'],
  ),
  preflight: S.obj(
    {
      ok: S.bool,
      blockers: S.arr(blockerSchema),
      missionId: S.str,
      branchTip: S.any,
      baseTip: S.any,
      changedFiles: S.any,
      review: S.any,
    },
    ['ok', 'blockers', 'missionId'],
  ),
  merge: S.obj(
    {
      ok: S.bool,
      missionId: S.str,
      mergedCommit: S.any,
      baseTip: S.any,
      branchTip: S.any,
      parents: S.any,
      blockers: S.arr(blockerSchema),
      warnings: S.any,
      alreadyMerged: S.bool,
      recoveredFromFailure: S.bool,
    },
    ['ok'],
  ),
  rebase: S.obj(
    {
      ok: S.bool,
      oldTip: S.any,
      newTip: S.any,
      baseTip: S.any,
      alreadyMerged: S.bool,
      alreadyUpToDate: S.bool,
      skipped: S.bool,
      reviewWaived: S.bool,
      note: S.str,
      blockers: S.arr(blockerSchema),
    },
    ['ok'],
  ),
  teardown: S.obj(
    { ok: S.bool, dryRun: S.bool, removed: S.arr(S.str), decisions: S.arr(S.obj()) },
    ['ok', 'dryRun', 'removed', 'decisions'],
  ),
}

function renderValue(_args, value) {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

function output(schema) {
  return { schema, render: renderValue }
}

const ROLE_ENUM = ['worker', 'reviewer']

function normalizeToolArgs(args, aliases = {}) {
  const out = { ...(args ?? {}) }
  for (const [canonical, names] of Object.entries(aliases)) {
    const current = out[canonical]
    if (current !== undefined && current !== null) continue
    for (const name of names) {
      if (out[name] !== undefined && out[name] !== null) {
        out[canonical] = out[name]
        break
      }
    }
  }
  return out
}

function define(ctx, definition) {
  const { aliases, requiresMissionId, execute, ...rest } = definition
  ctx.effect(() =>
    ctx.tools.register({
      ...rest,
      async execute(args, exec) {
        const normalized = normalizeToolArgs(args, aliases)
        if (requiresMissionId) {
          const id = normalized.missionId
          if (typeof id !== 'string' || id.trim().length === 0) {
            throw new TowerToolError('invalid-argument', `${rest.name} requires missionId (alias: id)`)
          }
          normalized.missionId = id.trim()
        }
        try {
          return await execute(normalized, exec)
        } catch (error) {
          throw classifyError(error)
        }
      },
    }),
  )
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
    output: output(SCHEMAS.init),
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
    output: output(SCHEMAS.plan),
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
        id: { type: 'string', description: 'Mission id, e.g. M1 (canonical; alias: missionId).' },
        missionId: { type: 'string', description: 'Alias for id; both are accepted.' },
        status: {
          type: 'string',
          enum: ['planned', 'active', 'completed', 'blocked', 'paused', 'abandoned'],
          description: 'New lifecycle status.',
        },
        note: { type: 'string', description: 'Append a decision-log note.' },
        blocker: { type: 'string', description: 'Report a blocker (also sets status to blocked).' },
        clear_blockers: { type: 'boolean', description: 'Clear all recorded blockers.' },
        clearBlockers: { type: 'boolean', description: 'Alias for clear_blockers.' },
        task_done: { type: 'string', description: 'Mark the first open task containing this text as done.' },
        taskDone: { type: 'string', description: 'Alias for task_done.' },
        task_drop: { type: 'string', description: 'Mark the first open task containing this text as dropped.' },
        taskDrop: { type: 'string', description: 'Alias for task_drop.' },
        task_drop_reason: { type: 'string', description: 'Required with task_drop: why the task is legitimately descoped.' },
        taskDropReason: { type: 'string', description: 'Alias for task_drop_reason.' },
        scope: { type: 'array', items: { type: 'string' }, description: 'Tower only: replacement scope globs; bumps scopeGeneration.' },
      },
      required: ['repoRoot'],
      additionalProperties: false,
    },
    aliases: {"id":["missionId"],"task_done":["taskDone"],"task_drop":["taskDrop"],"task_drop_reason":["taskDropReason"],"clear_blockers":["clearBlockers"]},
    output: output(SCHEMAS.mission),
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
    output: output(SCHEMAS.status),
    async execute(args) {
      const tower = await Tower.open(args.repoRoot)
      return tower.status()
    },
  })

  define(ctx, {
    name: 'tower_spawn',
    description:
      'Spawn a worker or reviewer for a mission. Workers use the tower-worker preset; reviewers require a completed mission and use the read-only tower-reviewer preset. Provisions (or reuses) the mission git worktree and branch, generates a self-contained briefing, and starts a background subagent in that worktree. The child final report is delivered back to this session; tower_roster shows authoritative activity. Records the agent in the roster; reviewer spawns record the branch tip so a reviewer that modifies the branch cannot submit a review. Returns immediately unless wait=true.',
    parameters: {
      type: 'object',
      properties: {
        repoRoot: { type: 'string', description: 'Absolute path inside the target Git repository.' },
        missionId: { type: 'string', description: 'Mission id, e.g. M1 (canonical; alias: id).' },
        id: { type: 'string', description: 'Alias for missionId; both are accepted.' },
        role: { type: 'string', enum: ROLE_ENUM, description: 'worker executes; reviewer audits the mission branch.' },
        name: { type: 'string', description: 'Unique roster name; defaults to <role>-<missionId>.' },
        instructions: { type: 'string', description: 'Extra tower instructions appended to the briefing.' },
        worktreeRoot: { type: 'string', description: 'Optional absolute parent directory for the worktree.' },
        wait: { type: 'boolean', description: 'Wait for the child result instead of returning immediately (testing/debug).' },
        waitMs: { type: 'number', description: 'Max wait with wait=true, default 180000.' },
        wait_ms: { type: 'number', description: 'Alias for waitMs.' },
      },
      required: ['repoRoot'],
      additionalProperties: false,
    },
    aliases: {"missionId":["id"],"waitMs":["wait_ms"]},
    requiresMissionId: true,
    output: output(SCHEMAS.spawn),
    async execute(args, exec) {
      const tower = await Tower.open(args.repoRoot)
      const role = args.role ?? 'worker'
      if (!ROLE_ENUM.includes(role)) fail(`role must be one of ${ROLE_ENUM.join('|')}`)
      // Repository config (if any) already overrides the profile config here.
      const config = tower.config
      const preset = role === 'reviewer' ? config.spawn.reviewerPreset : config.spawn.workerPreset
      const model = role === 'reviewer' ? config.spawn.reviewerModel : config.spawn.workerModel
      const context = await tower.missionContext(args.missionId)
      if (role === 'reviewer') {
        if (!context.mission.worktree) {
          fail('reviewer needs an existing mission worktree; spawn a worker first')
        }
        if (context.mission.status !== 'completed') {
          fail(`reviewer requires a completed mission awaiting review; ${context.mission.id} is ${context.mission.status}`)
        }
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
      const provider = config.spawn.provider || (providers.includes('spawn') ? 'spawn' : providers[0])
      if (!provider) fail('no subagent provider is registered')
      const presets = ctx.get('agentPresets')
      if (presets && typeof presets.list === 'function') {
        const available = await presets.list()
        if (!available.some((entry) => String(entry.id) === preset)) {
          fail(`agent preset "${preset}" is not registered; check the Tower bundle's preset rows and restart DSH`)
        }
      }

      const agentOptions = {}
      for (const key of ['provider', 'model', 'reasoningEffort', 'maxTokens']) {
        if (model && model[key] !== undefined && model[key] !== null && model[key] !== '') agentOptions[key] = model[key]
      }

      const activation = await subagents.startActivation({
        provider,
        label: name,
        request: {
          cwd: worktree.path,
          agentPreset: preset,
          prompt: [{ type: 'text', text: briefing }],
          parent: exec.agent,
          maxDepth: config.spawn.maxDepth ?? 1,
          ...(Object.keys(agentOptions).length > 0 ? { agentOptions } : {}),
        },
        signal: exec.signal,
        delivery: 'parent',
      })

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

      const recordOutcome = (state, detail) =>
        tower.recordSpawnOutcome({ missionId: mission.id, name, state, detail }).catch(() => {})

      const report = {
        name,
        agentId,
        role,
        missionId: mission.id,
        preset,
        provider,
        maxDepth: config.spawn.maxDepth ?? 1,
        ...(Object.keys(agentOptions).length > 0 ? { agentOptions } : {}),
        worktree: { path: worktree.path, branch: worktree.branch, baseCommit: worktree.baseCommit },
        created: provisioned.created,
        briefingChars: briefing.length,
        rosterEntry: entry,
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
        } catch (error) {
          report.stopReason = 'failed'
          report.diagnostic = String(error?.message ?? error)
          await recordOutcome('failed', report.diagnostic)
          throw error
        } finally {
          clearTimeout(timer)
        }
        if (result && result.__timeout) {
          report.timedOut = true
          recordOutcome('unknown', 'spawn wait timed out; check tower_roster')
        } else {
          report.stopReason = result?.stopReason ?? null
          report.output = textOf(result?.output)
          report.diagnostic = result?.diagnostic ?? null
          const state = report.stopReason === 'completed' ? 'inactive' : 'failed'
          if (state === 'failed') report.diagnostic = report.diagnostic ?? report.stopReason
          await recordOutcome(state, report.diagnostic ?? null)
        }
      } else {
        activation.result
          .then((result) => {
            const state = result?.stopReason === 'completed' ? 'inactive' : 'failed'
            return recordOutcome(state, result?.diagnostic ?? result?.stopReason ?? null)
          })
          .catch((error) => recordOutcome('failed', String(error?.message ?? error)))
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
    output: output(SCHEMAS.roster),
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
    name: 'tower_diff',
    description:
      'Read-only view of a mission branch for review: merge base, changed files, commits, and a capped patch against the recorded base. Safe for reviewers; it never modifies the repository.',
    parameters: {
      type: 'object',
      properties: {
        repoRoot: { type: 'string', description: 'Absolute path to the main checkout root.' },
        missionId: { type: 'string', description: 'Mission id, e.g. M1 (canonical; alias: id).' },
        id: { type: 'string', description: 'Alias for missionId; both are accepted.' },
        maxBytes: { type: 'integer', minimum: 1024, description: 'Patch cap in bytes (default 65536).' },
      },
      required: ['repoRoot'],
      additionalProperties: false,
    },
    aliases: {"missionId":["id"]},
    requiresMissionId: true,
    output: output(SCHEMAS.diff),
    async execute(args) {
      const tower = await Tower.open(args.repoRoot)
      return tower.diff({ missionId: args.missionId, maxBytes: args.maxBytes })
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
    output: output(SCHEMAS.adopt),
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
    output: output(SCHEMAS.send),
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
        includeRead: { type: 'boolean', description: 'Alias for include_read.' },
      },
      required: ['repoRoot'],
      additionalProperties: false,
    },
    aliases: {"include_read":["includeRead"]},
    output: output(SCHEMAS.inbox),
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
        missionId: { type: 'string', description: 'Mission id, e.g. M1 (canonical; alias: id).' },
        id: { type: 'string', description: 'Alias for missionId; both are accepted.' },
        report: { type: 'string', description: 'Full completion report for the tower and the next review round.' },
      },
      required: ['repoRoot', 'report'],
      additionalProperties: false,
    },
    aliases: {"missionId":["id"]},
    requiresMissionId: true,
    output: output(SCHEMAS.complete),
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
      'File a structured finding (bug / improve / vuln / idea) for the tower to route. Use this for anything notable OUTSIDE your mission scope instead of editing out-of-scope files. Severity is one of low|medium|high|critical. Use tower_findings to list, read, or close findings later.',
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
        missionId: { type: 'string', description: 'Optional mission this finding relates to (alias: mission_id).' },
        mission_id: { type: 'string', description: 'Alias for missionId.' },
      },
      required: ['repoRoot', 'type', 'title', 'summary', 'details', 'suggested_fix'],
      additionalProperties: false,
    },
    aliases: {"missionId":["mission_id"]},
    output: output(SCHEMAS.finding),
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
    name: 'tower_findings',
    description:
      'List, read, or update findings for a repository. Without id it lists findings newest-first with counts by status (filters: status, type, severity, missionId, open, limit). With id it returns that finding; with id plus status and/or note it records a lifecycle transition. Statuses are open -> triaged -> fixed|wontfix, and fixed/wontfix can be reopened to open. Only the tower or a worker may change a finding; reviewers may only list and read. Read-only when no id is given.',
    parameters: {
      type: 'object',
      properties: {
        repoRoot: { type: 'string', description: 'Absolute path inside the target Git repository.' },
        id: { type: 'string', description: 'Finding id, e.g. F1. When present the call reads or updates that finding.' },
        status: {
          type: 'string',
          enum: ['open', 'triaged', 'fixed', 'wontfix', 'all'],
          description: 'With id: target status. Without id: filter (default all).',
        },
        note: { type: 'string', description: 'Optional note recorded together with an update.' },
        type: { type: 'string', enum: ['bug', 'improve', 'vuln', 'idea'], description: 'Filter by finding type.' },
        severity: { type: 'string', enum: ['low', 'medium', 'high', 'critical'], description: 'Filter by severity.' },
        missionId: { type: 'string', description: 'Filter by mission id (alias: mission_id).' },
        mission_id: { type: 'string', description: 'Alias for missionId.' },
        open: { type: 'boolean', description: 'Only findings that are not fixed or wontfix.' },
        limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Max findings to list (default 50).' },
      },
      required: ['repoRoot'],
      additionalProperties: false,
    },
    aliases: {"missionId":["mission_id"]},
    output: output(SCHEMAS.findings),
    async execute(args, exec) {
      const tower = await Tower.open(args.repoRoot)
      const view = await tower.rosterView()
      const self = view.roster.find((entry) => entry.agentId === String(exec.agent.id))
      return tower.findings({
        id: args.id,
        status: args.status,
        note: args.note,
        type: args.type,
        severity: args.severity,
        missionId: args.missionId,
        open: args.open,
        limit: args.limit,
        actor: { name: self ? self.name : 'tower', role: self ? self.role : 'tower' },
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
        missionId: { type: 'string', description: 'Mission id, e.g. M1 (canonical; alias: id).' },
        id: { type: 'string', description: 'Alias for missionId; both are accepted.' },
        status: { type: 'string', description: 'Verdict: "clean", or "p1-Nitems" / "p2-Nitems" with the number of findings at that priority.' },
        merge: { type: 'string', enum: ['merge', 'fix-then-merge', 'hold'], description: 'Merge recommendation for the tower.' },
        findings: { type: 'string', description: 'Full findings text (markdown); write "none" when clean.' },
        checks: { type: 'array', items: { type: 'string' }, description: 'Checklist items you verified.' },
        decision: { type: 'string', description: 'The reasoning behind your verdict.' },
        breakGlassReason: { type: 'string', description: 'Tower-only exceptional self-review: why no independent reviewer was used.' },
      },
      required: ['repoRoot', 'status', 'merge', 'findings', 'decision'],
      additionalProperties: false,
    },
    aliases: {"missionId":["id"]},
    requiresMissionId: true,
    output: output(SCHEMAS.review),
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
        missionId: { type: 'string', description: 'Mission id, e.g. M1 (canonical; alias: id).' },
        id: { type: 'string', description: 'Alias for missionId; both are accepted.' },
      },
      required: ['repoRoot'],
      additionalProperties: false,
    },
    aliases: {"missionId":["id"]},
    requiresMissionId: true,
    output: output(SCHEMAS.preflight),
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
        missionId: { type: 'string', description: 'Mission id, e.g. M1 (canonical; alias: id).' },
        id: { type: 'string', description: 'Alias for missionId; both are accepted.' },
        timeoutMs: {
          type: 'integer',
          minimum: 1000,
          description: 'Optional timeout for the merge command in milliseconds, including pre-merge hooks (default 15 minutes).',
        },
        timeout_ms: {
          type: 'integer',
          minimum: 1000,
          description: 'Alias for timeoutMs.',
        },
      },
      required: ['repoRoot'],
      additionalProperties: false,
    },
    aliases: {"missionId":["id"],"timeoutMs":["timeout_ms"]},
    requiresMissionId: true,
    output: output(SCHEMAS.merge),
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
        missionId: { type: 'string', description: 'Mission id, e.g. M1 (canonical; alias: id).' },
        id: { type: 'string', description: 'Alias for missionId; both are accepted.' },
      },
      required: ['repoRoot'],
      additionalProperties: false,
    },
    aliases: {"missionId":["id"]},
    requiresMissionId: true,
    output: output(SCHEMAS.rebase),
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
        dryRun: { type: 'boolean', description: 'Alias for dry_run.' },
      },
      required: ['repoRoot'],
      additionalProperties: false,
    },
    aliases: {"dry_run":["dryRun"]},
    output: output(SCHEMAS.teardown),
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
