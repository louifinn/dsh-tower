// tower_recover: explicit stale state-lock diagnostics/repair.
import { Tower } from '../tower.js'
import { readStateLock } from '../store.js'
import { SCHEMAS, output } from '../schemas.js'
import { TowerToolError } from '../errors.js'
import { fsp } from '../adapters/store-fs.js'

export function registerRecoverTool(ctx, deps) {
  const { define, actorFor, requireTowerActor } = deps
  define(ctx, {
    name: 'tower_recover',
    description:
      'Read-only recovery diagnostics and an explicit stale-state-lock repair. status reports the state lock owner; clear-stale-lock requires confirm:"CLEAR_STALE_LOCK" and only moves a lock whose PID is provably dead to a backup file. It never resets Tower state or worktrees.',
    parameters: {
      type: 'object',
      properties: {
        repoRoot: { type: 'string', description: 'Absolute path inside the target Git repository.' },
        action: { type: 'string', enum: ['status', 'clear-stale-lock'], description: 'Recovery action.' },
        confirm: { type: 'string', description: 'Required literal CLEAR_STALE_LOCK for clear-stale-lock.' },
      },
      required: ['repoRoot', 'action'],
      additionalProperties: false,
    },
    output: output(SCHEMAS.recover),
    async execute(args, exec) {
      const tower = await Tower.open(args.repoRoot)
      const actor = await actorFor(tower, exec)
      requireTowerActor(actor, 'recover Tower state')
      const lock = await readStateLock(tower.paths)
      const publicLock = lock.record
        ? { pid: lock.record.pid ?? null, startedAt: lock.record.startedAt ?? null, at: lock.record.at ?? null, alive: lock.alive }
        : null
      if (args.action === 'status') {
        return { ok: true, action: 'status', stateLock: publicLock, cleared: false }
      }
      if (args.confirm !== 'CLEAR_STALE_LOCK') {
        throw new TowerToolError('invalid-argument', 'clear-stale-lock requires confirm:"CLEAR_STALE_LOCK"')
      }
      if (!lock.record) return { ok: true, action: 'clear-stale-lock', stateLock: null, cleared: false }
      if (lock.alive !== false) {
        throw new TowerToolError('state-locked', `state lock pid ${lock.record.pid ?? 'unknown'} is still alive; refusing to clear it`)
      }
      const backup = `${tower.paths.lock}.recovered-${Date.now()}`
      await fsp.rename(tower.paths.lock, backup)
      return { ok: true, action: 'clear-stale-lock', stateLock: publicLock, cleared: true, backup }
    },
  })
}
