// Tool schema primitives and output schemas.

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
      caseInsensitive: S.any,
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
      mode: S.any,
      spawn: S.any,
      towerAgentId: S.any,
      ownerMissing: S.bool,
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
  interrupt: S.obj(
    {
      ok: S.bool,
      interrupted: S.bool,
      previousActivity: S.str,
      entry: S.obj(),
      reason: S.str,
    },
    ['ok', 'interrupted'],
  ),
  reload: S.obj(
    {
      ok: S.bool,
      scheduled: S.bool,
      delayMs: S.int,
      requiredIds: S.arr(S.str),
      error: S.str,
      restartHint: S.str,
    },
    ['ok', 'scheduled'],
  ),
  doctor: S.obj(
    {
      ok: S.bool,
      checks: S.arr(S.obj()),
      stateSchema: S.obj({
        currentVersion: S.any,
        supportedVersion: S.int,
        migrations: S.arr(S.obj({ from: S.int, to: S.int })),
        status: S.str,
      }),
      environmentContract: S.obj(),
    },
    ['ok', 'checks'],
  ),
  recover: S.obj(
    { ok: S.bool, action: S.str, stateLock: S.any, cleared: S.bool, backup: S.any, error: S.str },
    ['ok', 'action'],
  ),
  test: S.obj(
    {
      ok: S.bool,
      configured: S.bool,
      treeTip: S.any,
      tests: S.arr(S.obj()),
      commands: S.arr(S.obj()),
      error: S.str,
      receipt: S.obj(),
      checks: S.arr(S.obj()),
    },
    ['ok', 'configured'],
  ),
  batch: S.obj(
    { ok: S.bool, action: S.str, batch: S.obj(), batches: S.arr(S.obj()), blockers: S.arr(blockerSchema), summary: S.obj() },
    ['ok', 'action'],
  ),
  resource: S.obj(
    { ok: S.bool, action: S.str, lease: S.obj(), leases: S.arr(S.obj()), released: S.bool },
    ['ok', 'action'],
  ),
  importLegacy: S.obj({ ok: S.bool, summary: S.obj(), snapshot: S.obj() }, ['ok', 'summary']),
  legacyMap: S.obj({ ok: S.bool, map: S.obj(), maps: S.arr(S.obj()) }, ['ok']),
}

function renderValue(_args, value) {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

function output(schema) {
  return { schema, render: renderValue }
}

export { S, SCHEMAS, output }
