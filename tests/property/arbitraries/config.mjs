// Arbitraries for the raw (unresolved) Tower configuration object.
//
// Every generated object is accepted by `assertKnownKeys` and by the
// Schemastery `Config` schema, so callers can treat it as "the shape a
// repository config file may contain". Values are bounded by the schema's own
// min/max ranges; the groups are all optional, exactly like the real file.
//
// #136: the generator emits no `tests.enabled`. That key was removed — the
// `tower-tests` component row is the switch — so a generated config can no
// longer contain a cross-key contradiction, and the resolver has none to reject.
import fc from 'fast-check'

import { DEFAULT_DENY_TOOLS } from '../../../domain/config/schema.js'

const modelRouteArb = fc.record(
  {
    provider: fc.string({ minLength: 1, maxLength: 20 }),
    model: fc.string({ minLength: 1, maxLength: 40 }),
    reasoningEffort: fc.constantFrom('low', 'medium', 'high'),
    maxTokens: fc.integer({ min: 0, max: 200_000 }),
  },
  { requiredKeys: [] },
)

const initArb = fc.record(
  {
    autoGitInit: fc.boolean(),
    snapshotDirty: fc.boolean(),
    autoExclude: fc.boolean(),
  },
  { requiredKeys: [] },
)

const modeArb = fc.record(
  {
    promptSection: fc.string({ maxLength: 120 }),
    sectionAppend: fc.string({ maxLength: 120 }),
    allowAgentControl: fc.boolean(),
    autoPauseGoal: fc.boolean(),
    requireResumeAuthorization: fc.boolean(),
    requireHumanAckOnFirstEntry: fc.boolean(),
    workspaceLock: fc.boolean(),
    workspaceLockScope: fc.constantFrom('all', 'mutations'),
    planModePolicy: fc.constantFrom('clear', 'refuse'),
    workspaceStaleMs: fc.integer({ min: 1000, max: 86_400_000 }),
    heartbeatMs: fc.integer({ min: 1000, max: 3_600_000 }),
    denyTools: fc.array(fc.constantFrom(...DEFAULT_DENY_TOOLS), { maxLength: 4 }),
    storePath: fc.string({ maxLength: 80 }),
    maxEntries: fc.integer({ min: 1, max: 2000 }),
    lockTimeoutMs: fc.integer({ min: 10, max: 60_000 }),
  },
  { requiredKeys: [] },
)

const reviewArb = fc.record(
  {
    requireReview: fc.boolean(),
    maxRoundsPerReviewer: fc.integer({ min: 1, max: 20 }),
  },
  { requiredKeys: [] },
)

const mergeArb = fc.record(
  {
    timeoutMs: fc.integer({ min: 1000, max: 1_800_000 }),
    maxBufferBytes: fc.integer({ min: 65_536, max: 16 * 1024 * 1024 }),
  },
  { requiredKeys: [] },
)

const gitArb = fc.record({ timeoutMs: fc.integer({ min: 1000, max: 1_800_000 }) }, { requiredKeys: [] })

const worktreesArb = fc.record({ root: fc.string({ maxLength: 100 }) }, { requiredKeys: [] })

const spawnArb = fc.record(
  {
    workerPreset: fc.constantFrom('tower-worker', 'default', 'minimal'),
    reviewerPreset: fc.constantFrom('tower-reviewer', 'default', 'minimal'),
    maxDepth: fc.integer({ min: 1, max: 5 }),
    provider: fc.string({ maxLength: 40 }),
    workerModel: modelRouteArb,
    reviewerModel: modelRouteArb,
    maxLiveWorkers: fc.integer({ min: 1, max: 64 }),
    staleMs: fc.integer({ min: 0, max: 600_000 }),
    maxWaitMs: fc.integer({ min: 1000, max: 600_000 }),
    requireLease: fc.string({ maxLength: 40 }),
  },
  { requiredKeys: [] },
)

const sendArb = fc.record(
  {
    maxPerMinute: fc.integer({ min: 0, max: 6000 }),
    interruptDefault: fc.boolean(),
  },
  { requiredKeys: [] },
)

const testsArb = fc.record(
  {
    admission: fc.constantFrom('spawn', 'complete', 'off'),
    timeoutMs: fc.integer({ min: 1000, max: 1_800_000 }),
    maxBytes: fc.integer({ min: 1024, max: 16 * 1024 * 1024 }),
    autoChecks: fc.boolean(),
    allowPackageDiscovery: fc.boolean(),
  },
  { requiredKeys: [] },
)

const gatesArb = fc.record(
  {
    requireChecks: fc.boolean(),
    requireTests: fc.boolean(),
    allowReviewExemption: fc.boolean(),
    maxReportBytes: fc.integer({ min: 1024, max: 16 * 1024 * 1024 }),
  },
  { requiredKeys: [] },
)

const docsArb = fc.record(
  {
    board: fc.boolean(),
    boardLocation: fc.constantFrom('common', 'repo'),
  },
  { requiredKeys: [] },
)

const archiveArb = fc.record(
  {
    enabled: fc.boolean(),
    afterDays: fc.integer({ min: 0, max: 3650 }),
    maxMissions: fc.integer({ min: 0, max: 10_000 }),
  },
  { requiredKeys: [] },
)

const leasesArb = fc.record(
  { ttlMs: fc.integer({ min: 1000, max: 86_400_000 }) },
  { requiredKeys: [] },
)

const devArb = fc.record(
  {
    reloadDelayMs: fc.integer({ min: 1, max: 5000 }),
    reloadRequiredIds: fc.array(fc.stringMatching(/^[a-z][a-z0-9-]{0,20}$/), { maxLength: 4 }),
  },
  { requiredKeys: [] },
)

/**
 * A raw config object. `section` and `allowAgentControl` are the two legacy
 * top-level aliases the resolver still accepts.
 */
export const configArb = fc.record(
  {
    section: fc.string({ maxLength: 120 }),
    allowAgentControl: fc.boolean(),
    init: initArb,
    mode: modeArb,
    review: reviewArb,
    merge: mergeArb,
    git: gitArb,
    worktrees: worktreesArb,
    spawn: spawnArb,
    send: sendArb,
    tests: testsArb,
    gates: gatesArb,
    docs: docsArb,
    archive: archiveArb,
    leases: leasesArb,
    dev: devArb,
  },
  { requiredKeys: [] },
)

/**
 * A config object carrying only the legacy top-level aliases, which exercise
 * the alias-resolution half of `resolveTowerConfig`.
 */
export const legacyAliasConfigArb = fc.record(
  {
    section: fc.string({ maxLength: 120 }),
    allowAgentControl: fc.boolean(),
  },
  { requiredKeys: [] },
)
