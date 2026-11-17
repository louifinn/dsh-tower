// tower_recover: explicit stale state-lock / commit-mutex diagnostics and repair.
import { SCHEMAS, output } from '../domain/contracts/outputs.js'
import { TowerToolError } from '../domain/errors.js'
import { RecoverInput } from '../domain/contracts/tool-inputs/index.js'
import { RECOVERY_ACTION, RECOVERY_CONFIRM, ROLE } from '../domain/vocabulary.js'

/**
 * The lock fields a caller can act on, without the raw record or token.
 * @param {{ record: any, alive?: boolean | null } | null} lock
 * @param {{ ageMs?: number | null, heartbeatAgeMs?: number | null, staleAfterMs?: number | null, stale?: boolean | null }} timing
 */
function publicLock(lock, timing) {
  if (!lock?.record) return null
  return {
    pid: lock.record.pid ?? null,
    startedAt: lock.record.startedAt ?? lock.record.since ?? null,
    at: lock.record.at ?? null,
    alive: lock.alive ?? null,
    ageMs: timing.ageMs ?? null,
    heartbeatAgeMs: timing.heartbeatAgeMs ?? null,
    staleAfterMs: timing.staleAfterMs ?? null,
    stale: timing.stale ?? null,
  }
}

/**
 * @param {any} ctx
 * @param {{ define: import('../types/index.js').DefineTool, openTower: any, actorFor: any, requireTowerActor: any, readStateLock: any, lockTiming: any }} deps
 */
export function registerRecoverTool(ctx, deps) {
  const { define, actorFor, requireTowerActor, readStateLock, lockTiming } = deps
  define(ctx, {
    name: 'tower_recover',
    description:
      'Recovery diagnostics and stale state-lock repair. status reports the lock owner with age, heartbeat, and staleness; clear-stale-lock needs confirm:CLEAR_STALE_LOCK and only moves a lock whose PID is dead (force also clears a live-but-silent PID) to a backup. Never resets state.',
    parameters: RecoverInput,
    output: output(SCHEMAS.recover),
    async execute(args, exec) {
      const tower = await deps.openTower(args.repoRoot)
      const actor = await actorFor(tower, exec)
      requireTowerActor(actor, 'recover Tower state')
      const now = Date.now()
      const lock = await readStateLock(tower.paths, { now })
      const timing = lockTiming(lock.record, { now })
      const stateLock = publicLock(lock, timing)
      // #F71: the state-commit mutex is an optional store capability. The
      // durable store exposes it; an in-memory store has no second writer to
      // fence and reports no commit lock. Both reads go through the declared
      // optional methods (with optional chaining) so the port-call guard sees
      // the capability and a store without it still works.
      const commit =
        typeof tower.deps?.store?.readStateCommitLock === 'function'
          ? await tower.deps?.store?.readStateCommitLock(tower.paths, { now })
          : null
      const commitTiming = commit ?? timing
      const commitLock = commit?.record
        ? { ...publicLock(commit, commitTiming), token: commit.record.token ?? null, kind: commit.record.kind ?? null }
        : null
      if (args.action === RECOVERY_ACTION.status) {
        return { ok: true, action: RECOVERY_ACTION.status, stateLock, commitLock, cleared: false }
      }
      if (args.confirm !== RECOVERY_CONFIRM) {
        throw new TowerToolError('invalid-argument', 'clear-stale-lock requires confirm:"CLEAR_STALE_LOCK"')
      }
      if (!lock.record && !commit?.record) {
        return {
          ok: true,
          action: RECOVERY_ACTION.clearStaleLock,
          stateLock: null,
          commitLock: null,
          cleared: false,
          backup: null,
          commitBackup: null,
          forced: false,
        }
      }
      const forced = args.force === true
      // Validate every live record before moving anything: a partial repair is
      // worse than a refusal, so a live holder of either lock refuses the whole
      // action until force (and the confirmation string) says otherwise.
      if (lock.record && lock.alive !== false && !forced) {
        // A live PID is not proof of a live writer (#92): report the heartbeat
        // and require the explicit force opt-in before moving the record.
        throw new TowerToolError(
          'state-locked',
          `state lock pid ${lock.record.pid ?? ROLE.unknown} is still alive (last heartbeat ${timing.heartbeatAgeMs ?? 'unknown'}ms ago, stale after ${timing.staleAfterMs}ms); pass force:true with confirm:"CLEAR_STALE_LOCK" to move it to a backup after confirming no writer is active`,
        )
      }
      if (commit?.record && commit.alive !== false && !forced) {
        throw new TowerToolError(
          'state-locked',
          `the state commit mutex is still held by pid ${commit.record.pid ?? ROLE.unknown} (token ${commit.record.token ?? 'missing'}, held for ${commitTiming.ageMs ?? 'unknown'}ms); a live commit holder is never reclaimed automatically because it may be between the last state check and its rename; pass force:true with confirm:"CLEAR_STALE_LOCK" to move the record to a backup after confirming no writer is active`,
        )
      }
      // Recover the commit mutex first: if that refuses (the record changed
      // after inspection) the primary writer fence has not moved yet. A failure
      // to move the state lock afterwards leaves the commit backup visible and
      // the state lock in place (still blocking writers), so the next recovery
      // can finish without a window in which both fences are gone.
      let commitBackup = null
      if (commit?.record) {
        if (typeof tower.deps?.store?.clearStateCommitLock !== 'function') {
          throw new TowerToolError(
            'state-locked',
            `the store cannot move the commit mutex at ${commit.path}; confirm no writer is active and remove that file by hand`,
          )
        }
        // expectedRaw closes the read→rename gap: a record that changed after
        // the inspection above is refused instead of moving a newer holder.
        const cleared = await tower.deps?.store?.clearStateCommitLock(tower.paths, {
          force: forced,
          now,
          expectedRaw: commit.raw ?? undefined,
        })
        commitBackup = cleared.backup ?? null
      }
      // Always rename, never unlink: the recovered bytes stay auditable. Use the
      // plain port primitive, not `renameWithRetry`: the retrying helper has
      // temp-file semantics and unlinks its source when the rename finally
      // fails, which would destroy the record we are trying to preserve.
      let backup = null
      if (lock.record) {
        backup = `${tower.paths.lock}.recovered-${Date.now()}`
        await tower.deps.store.rename(tower.paths.lock, backup)
      }
      return {
        ok: true,
        action: RECOVERY_ACTION.clearStaleLock,
        stateLock,
        commitLock,
        cleared: backup !== null || commitBackup !== null,
        backup,
        commitBackup,
        forced,
      }
    },
  })
}
