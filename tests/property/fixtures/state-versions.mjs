// Frozen schema-version fixtures for the roundtrip/migration property (#130).
//
// These are copies of the shapes the state store has actually written:
//   * v1: the original mission-list document (no revision, no tasks/deps);
//   * v2: adds `revision` and the top-level collections;
//   * v3: the current document (also the fixed-point target).
//
// They live here, under tests/property, so the property owns them; the unit
// tests in tests/state-migration.test.mjs may pin the same shapes independently.
// Fixtures are plain data: tests clone them before handing them to domain code,
// and the property asserts the domain does not mutate its input.

/** The v1 document shape: missions with no tasks/deps and no revision. */
export const V1_FIXTURE = {
  schemaVersion: 1,
  repoRoot: '/repo',
  commonDir: '/repo/.git',
  base: 'main',
  missions: [
    {
      id: 'M1',
      title: 'Legacy mission',
      status: 'planned',
      scope: ['src/**'],
    },
  ],
}

/** The v2 document shape: adds `revision` and the collection fields. */
export const V2_FIXTURE = {
  schemaVersion: 2,
  revision: 4,
  repoRoot: '/repo',
  commonDir: '/repo/.git',
  base: 'main',
  missions: [],
}

/** A valid current-version (v3) document; migrating it must be a no-op. */
export const V3_FIXTURE = {
  schemaVersion: 3,
  revision: 2,
  base: 'main',
  repoRoot: '/repo',
  commonDir: '/repo/.git',
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  dirtyBase: false,
  caseInsensitive: null,
  towerAgentId: null,
  snapshotCommit: null,
  snapshotRef: null,
  missions: [
    {
      id: 'M1',
      title: 'Current mission',
      status: 'active',
      kind: 'build',
      scope: ['tests/property/**'],
      deps: [],
      tasks: [{ text: 'property fixture task', status: 'open' }],
      blockers: [],
      notes: [],
      owner: null,
      reviewPolicy: 'required-clean',
      reviewExemptionReason: null,
      scopeGeneration: 0,
      ownerGeneration: 0,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
      pauseCause: null,
      completionReport: null,
    },
  ],
  roster: [],
  reviews: [],
  findings: [],
  messages: [],
  batches: [],
  messageSeq: 0,
  reviewSeq: 0,
  findingSeq: 0,
  batchSeq: 0,
  deliverySeq: 0,
  mergeIntent: null,
  rebaseIntent: null,
}

/** Every fixture the migration fixed-point property iterates. */
export const MIGRATION_FIXTURES = [V1_FIXTURE, V2_FIXTURE, V3_FIXTURE]
