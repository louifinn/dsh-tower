// tower_merge / tower_rebase / tower_teardown / tower_diff input contracts.
// Pure TypeBox only; no I/O.
//
// #163: no schema advertises `repoRoot`; alias fields stay accepted through the
// tool definitions' `aliases` maps but are no longer advertised.
import { Type } from './shared.js'

export const MergeInput = Type.Object({
  missionId: Type.Optional(Type.String({ description: 'Mission id, e.g. M1 (canonical; alias: id).' })),
  timeoutMs: Type.Optional(
    Type.Integer({
      minimum: 1000,
      description: 'Optional timeout for the merge command in milliseconds, including pre-merge hooks (default 15 minutes).',
    }),
  ),
}, { additionalProperties: false })

export const RebaseInput = Type.Object({
  missionId: Type.Optional(Type.String({ description: 'Mission id, e.g. M1 (canonical; alias: id).' })),
}, { additionalProperties: false })

export const TeardownInput = Type.Object({
  force: Type.Optional(Type.Boolean({ description: 'Remove worktrees that contain uncommitted changes (never a live agent).' })),
  exclude: Type.Optional(Type.Array(Type.String(), { description: 'Mission ids to keep.' })),
  dry_run: Type.Optional(Type.Boolean({ description: 'Preview remove/keep decisions without changing disk or state.' })),
}, { additionalProperties: false })

export const DiffInput = Type.Object({
  missionId: Type.Optional(Type.String({ description: 'Mission id, e.g. M1 (canonical; alias: id).' })),
  maxBytes: Type.Optional(Type.Integer({ minimum: 1024, description: 'Patch cap in bytes (default 65536).' })),
}, { additionalProperties: false })
