// tower_spawn: provision and start a worker/reviewer.
import { Tower, ROSTER_INACTIVE_STATES, ROLES as ROLE_ENUM } from '../tower.js'
import { SCHEMAS, output } from '../schemas.js'
import { TowerToolError, classifyError } from '../errors.js'
import { workerBriefing, reviewerBriefing } from '../briefing.js'
import { inspectLeases } from '../leases.js'

export function registerSpawnTool(ctx, deps) {
  const {
    define, actorFor, requireTowerActor, enqueueSpawn, observeActivity,
    spawnBackoffState, spawnBackoffView, recordSpawnThrottle, recordSpawnSuccess,
    runMissionDiscovery, textOf,
  } = deps
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
        waitMs: { type: 'number', description: 'Max wait with wait=true, default 180000; clamped to spawn.maxWaitMs (default 90000).' },
        wait_ms: { type: 'number', description: 'Alias for waitMs.' },
        takeover: { type: 'boolean', description: 'Replace a live worker entry that is no longer running (increments ownerGeneration).' },
        includeDirtyBase: { type: 'boolean', description: 'Use the recorded snapshotCommit baseline when true (default true).' },
      },
      required: ['repoRoot'],
      additionalProperties: false,
    },
    aliases: {"missionId":["id"],"waitMs":["wait_ms"]},
    requiresMissionId: true,
    board: true,
    output: output(SCHEMAS.spawn),
    async execute(args, exec) {
      const tower = await Tower.open(args.repoRoot)
      const actor = await actorFor(tower, exec)
      requireTowerActor(actor, 'spawn tower agents')
      const role = args.role ?? 'worker'
      if (!ROLE_ENUM.includes(role)) throw new TowerToolError('invalid-argument', `role must be one of ${ROLE_ENUM.join('|')}`)
      // Repository config (if any) already overrides the profile config here.
      const config = tower.config
      const preset = role === 'reviewer' ? config.spawn.reviewerPreset : config.spawn.workerPreset
      const model = role === 'reviewer' ? config.spawn.reviewerModel : config.spawn.workerModel
      const context = await tower.missionContext(args.missionId)
      if (role === 'reviewer') {
        if (!context.mission.worktree) {
          throw new TowerToolError('reviewer-prerequisite', 'reviewer needs an existing mission worktree; spawn a worker first')
        }
        if (context.mission.status !== 'completed') {
          throw new TowerToolError('reviewer-prerequisite', `reviewer requires a completed mission; ${context.mission.id} is ${context.mission.status}`)
        }
      }
      if (role === 'worker' && ['merged', 'abandoned'].includes(context.mission.status)) {
        throw new TowerToolError(
          'invalid-transition',
          `mission ${context.mission.id} is ${context.mission.status}; a worker can only be spawned for a planned or active mission`,
        )
      }
      const spawned = await enqueueSpawn(tower.root, async () => {
        const observed = await observeActivity(ctx, tower)
        await tower.reconcileObservedInactive(observed.activity)
        const backoff = spawnBackoffState(tower.root, config.spawn.maxLiveWorkers)
        if (backoff.blockedUntil > Date.now()) {
          const seconds = Math.ceil((backoff.blockedUntil - Date.now()) / 1000)
          throw new TowerToolError('provider-cooldown', `provider cooldown active; retry in ${seconds}s (${backoff.failures} recent failures)`)
        }
        const view = await tower.rosterView()
        const inactiveStates = ROSTER_INACTIVE_STATES
        // Resolve a unique roster name BEFORE any activation. The default name
        // is derived per role/mission and gets a numeric suffix on rework rounds.
        let name
        if (typeof args.name === 'string' && args.name.trim()) {
          name = args.name.trim()
          if (view.roster.some((entry) => entry.name === name)) {
            throw new TowerToolError('invalid-argument', 'roster name already used: ' + name)
          }
        } else {
          const base = role + '-' + args.missionId.toLowerCase()
          let candidate = base
          let suffix = 2
          while (view.roster.some((entry) => entry.name === candidate)) {
            candidate = base + '-' + suffix
            suffix += 1
          }
          name = candidate
        }
        let takeover = args.takeover === true
        if (role === 'worker') {
          // Pre-check the single-owner and live-worker rules BEFORE provisioning
          // or starting a child: a rejection must not leak an activation/worktree.
          const liveWorkers = view.roster.filter(
            (entry) => entry.role === 'worker' && !inactiveStates.includes(entry.state),
          )
          const sameMission = liveWorkers.filter((entry) => entry.missionId === args.missionId)
          if (sameMission.length > 1) {
            throw new TowerToolError(
              'invalid-transition',
              'mission ' + args.missionId + ' has ' + sameMission.length + ' live worker entries; inspect tower_roster before spawning',
            )
          }
          if (sameMission.length === 1 && !takeover) {
            throw new TowerToolError(
              'invalid-transition',
              'mission ' + args.missionId + ' already has a live worker "' + sameMission[0].name + '"; stop it with tower_interrupt, or pass takeover:true after it is no longer running',
            )
          }
          if (takeover) {
            if (sameMission.length === 1) {
              const worker = sameMission[0]
              const observed = await observeActivity(ctx, tower)
              if (observed.parentStatus[worker.parentSessionId] !== 'ok') {
                throw new TowerToolError(
                  'takeover-refused',
                  'cannot verify that worker ' + worker.name + ' stopped: its parent catalog is unavailable',
                )
              }
              const activity = observed.activity[worker.agentId]
              if (activity === 'running') {
                throw new TowerToolError(
                  'takeover-refused',
                  'worker ' + worker.name + ' is still running; call tower_interrupt (or wait) before takeover',
                )
              }
              if (activity === undefined) {
                throw new TowerToolError(
                  'takeover-refused',
                  'worker ' + worker.name + ' is not in the live catalog; run tower_adopt before takeover',
                )
              }
            } else {
              takeover = false
            }
          }
          const replacing = takeover ? sameMission : []
          const remaining = liveWorkers.filter((entry) => !replacing.includes(entry))
          const max = Math.min(Number(config.spawn.maxLiveWorkers) || 4, backoff.budget)
          if (remaining.length >= max) {
            throw new TowerToolError(
              'worker-limit',
              'live worker limit reached (' + max + '); stop a worker with tower_interrupt or raise spawn.maxLiveWorkers',
            )
          }
        }

        // Service/provider/preset checks happen before provisioning, so a failed
        // precheck cannot leave a worktree or roster revision behind.
        const subagents = ctx.get('subagents')
        if (!subagents) throw new TowerToolError('spawn-unavailable', 'subagents service is unavailable; cannot spawn')
        const providers = subagents.list()
        const provider = config.spawn.provider || (providers.includes('spawn') ? 'spawn' : providers[0])
        if (!provider) throw new TowerToolError('provider-missing', 'no subagent provider is registered')
        const presets = ctx.get('agentPresets')
        if (presets && typeof presets.list === 'function') {
          const available = await presets.list()
          if (!available.some((entry) => String(entry.id) === preset)) {
            throw new TowerToolError('preset-missing', 'agent preset "' + preset + '" is not registered; check the Tower bundle preset rows and restart DSH')
          }
        }
        if (typeof config.spawn.requireLease === 'string' && config.spawn.requireLease.trim()) {
          const requiredLease = config.spawn.requireLease.trim()
          const info = await inspectLeases(tower.commonDir)
          const lease = info.leases.find((entry) => entry.name === requiredLease && entry.expired !== true)
          if (!lease) {
            throw new TowerToolError(
              'lease-busy',
              `spawn.requireLease="${requiredLease}" is not held; acquire it with tower_resource before spawning`,
            )
          }
          if (lease.holder !== actor.name && lease.holder !== String(exec.agent.id)) {
            throw new TowerToolError(
              'lease-busy',
              `spawn.requireLease="${requiredLease}" is held by "${lease.holder}", not by this tower`,
            )
          }
        }

        const provisioned = await tower.provision({
          missionId: args.missionId,
          worktreeRoot: args.worktreeRoot,
          includeDirtyBase: args.includeDirtyBase !== false,
        })
        const { mission, worktree } = provisioned
        const contextWithWorktree = {
          ...context,
          mission: {
            ...context.mission,
            worktree: { path: worktree.path, branch: worktree.branch, baseCommit: worktree.baseCommit },
          },
        }
        const briefing =
          role === 'worker'
            ? workerBriefing({
                repoRoot: tower.root,
                base: context.base,
                mission: contextWithWorktree.mission,
                deps: context.deps,
                worktree,
                instructions: args.instructions,
                reviews: context.reviews,
                findings: context.findings,
                completionReport: context.completionReport,
              })
            : reviewerBriefing({
                repoRoot: tower.root,
                base: context.base,
                mission: contextWithWorktree.mission,
                deps: context.deps,
                worktree,
                instructions: args.instructions,
                reviews: context.reviews,
                findings: context.findings,
                completionReport: context.completionReport,
              })

        const agentOptions = {}
        for (const key of ['provider', 'model', 'reasoningEffort', 'maxTokens']) {
          if (model && model[key] !== undefined && model[key] !== null && model[key] !== '') agentOptions[key] = model[key]
        }

        if (role === 'worker' && tower.config.tests?.admission === 'spawn') {
          const discovery = await runMissionDiscovery(tower, mission)
          if (discovery.configured && discovery.receipt.ok !== true) {
            throw new TowerToolError(
              'tests-failed',
              `test admission failed for ${mission.id}: ${discovery.receipt.error}; no child was started`,
            )
          }
        }

        let activation = null
        let agentId = null
        let entry = null
        await tower.reserveRoster({
          missionId: mission.id,
          name,
          role,
          parentSessionId: String(exec.agent.id),
          cwd: worktree.path,
          branch: worktree.branch,
        })
        try {
          activation = await subagents.startActivation({
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
          agentId = String(activation.childId)
          entry = await tower.recordSpawn({
            missionId: mission.id,
            name,
            role,
            agentId,
            parentSessionId: String(exec.agent.id),
            cwd: worktree.path,
            branch: worktree.branch,
            takeover,
          })
          recordSpawnSuccess(tower.root, config.spawn.maxLiveWorkers)
        } catch (error) {
          if (classifyError(error).retryable === true) {
            recordSpawnThrottle(tower.root, config.spawn.maxLiveWorkers)
          }
          // The child may already be running even when recordSpawn failed: stop
          // it and mark the reserved entry failed so it cannot keep writing
          // unobserved.
          if (agentId) {
            try {
              await Promise.resolve(subagents.interrupt(agentId, { kind: 'ancestor', agent: exec.agent }))
            } catch {
              // best effort; the error below is the actionable one
            }
          }
          await tower
            .recordSpawnOutcome({
              missionId: mission.id,
              name,
              state: 'failed',
              detail: `spawn failed${agentId ? ` after activation ${agentId}` : ' before activation'}: ${String(error?.message ?? error).slice(0, 300)}`,
            })
            .catch(() => {})
          throw error
        }

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
          takeover,
          rosterEntry: entry,
        }

        return { report, activation, recordOutcome }
      })
      const { report, activation, recordOutcome } = spawned
      if (args.wait !== true) {
        activation.result
          .then((result) => {
            const state = result?.stopReason === 'completed' ? 'inactive' : 'failed'
            return recordOutcome(state, result?.diagnostic ?? result?.stopReason ?? null)
          })
          .catch((error) => recordOutcome('failed', String(error?.message ?? error)))
        return report
      }
      const waitMs = Math.max(1000, Math.min(config.spawn.maxWaitMs ?? 90000, args.waitMs ?? 180000))
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
      return report

    },
  })
}
