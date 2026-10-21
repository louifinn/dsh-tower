// tower_merge / tower_rebase / tower_teardown / tower_diff input contracts.
// Pure TypeBox only; no I/O.
import { Type } from './shared.js'

export const MergeInput = Type.Object({
  repoRoot: Type.String({ description: 'Absolute path inside the target Git repository.' }),
  missionId: Type.Optional(Type.String({ description: 'Mission id, e.g. M1 (canonical; alias: id).' })),
  id: Type.Optional(Type.String({ description: 'Alias for missionId; both are accepted.' })),
  timeoutMs: Type.Optional(
    Type.Integer({
      minimum: 1000,
      description: 'Optional timeout for the merge command in milliseconds, including pre-merge hooks (default 15 minutes).',
    }),
  ),
  timeout_ms: Type.Optional(Type.Integer({ minimum: 1000, description: 'Alias for timeoutMs.' })),
}, { additionalProperties: false })

export const RebaseInput = Type.Object({
  repoRoot: Type.String({ description: 'Absolute path inside the target Git repository.' }),
  missionId: Type.Optional(Type.String({ description: 'Mission id, e.g. M1 (canonical; alias: id).' })),
  id: Type.Optional(Type.String({ description: 'Alias for missionId; both are accepted.' })),
}, { additionalProperties: false })

export const TeardownInput = Type.Object({
  repoRoot: Type.String({ description: 'Absolute path inside the target Git repository.' }),
  force: Type.Optional(Type.Boolean({ description: 'Remove worktrees that contain uncommitted changes (never a live agent).' })),
  exclude: Type.Optional(Type.Array(Type.String(), { description: 'Mission ids to keep.' })),
  dry_run: Type.Optional(Type.Boolean({ description: 'Preview remove/keep decisions without changing disk or state.' })),
  dryRun: Type.Optional(Type.Boolean({ description: 'Alias for dry_run.' })),
}, { additionalProperties: false })

export const DiffInput = Type.Object({
  repoRoot: Type.String({ description: 'Absolute path to the main checkout root.' }),
  missionId: Type.Optional(Type.String({ description: 'Mission id, e.g. M1 (canonical; alias: id).' })),
  id: Type.Optional(Type.String({ description: 'Alias for missionId; both are accepted.' })),
  maxBytes: Type.Optional(Type.Integer({ minimum: 1024, description: 'Patch cap in bytes (default 65536).' })),
}, { additionalProperties: false })
