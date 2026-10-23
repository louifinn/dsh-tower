// tower_resource: advisory resource leases.
import { SCHEMAS, output } from '../domain/contracts/outputs.js'
import { TowerToolError } from '../domain/errors.js'
import { ResourceInput } from '../domain/contracts/tool-inputs/index.js'
import { LEASE_ACTION } from '../domain/vocabulary.js'

/**
 * @param {any} ctx
 * @param {{ define: import('../types/index.js').DefineTool, openTower: any, actorFor: any, requireTowerActor: any, acquireLease: any, releaseLease: any, inspectLeases: any }} deps
 */
export function registerResourceTool(ctx, deps) {
  const { define, actorFor, requireTowerActor, acquireLease, releaseLease, inspectLeases } = deps
  define(ctx, {
    name: 'tower_resource',
    description:
      'Advisory resource leases per repository (coordination only; no OS CPU/memory hard cap). acquire/release require a token and are tower-only; status is read-only. Expired leases are never taken over silently.',
    parameters: ResourceInput,
    output: output(SCHEMAS.resource),
    async execute(args, exec) {
      const tower = await deps.openTower(args.repoRoot)
      const actor = await actorFor(tower, exec)
      const redact = (leases) => leases.map(({ token, ...lease }) => lease)
      if (args.action === LEASE_ACTION.status) {
        const info = await inspectLeases(tower.commonDir)
        const leases = redact(info.leases ?? [])
        return { ok: true, action: LEASE_ACTION.status, ...info, leases }
      }
      requireTowerActor(actor, args.action === LEASE_ACTION.acquire ? 'acquire a lease' : 'release a lease')
      if (typeof args.name !== 'string' || args.name.trim().length === 0) {
        throw new TowerToolError('invalid-argument', 'tower_resource requires name')
      }
      const name = args.name.trim()
      const ttlMs = Number(args.ttlMs ?? tower.config.leases?.ttlMs ?? 900000)
      if (args.action === LEASE_ACTION.acquire) {
        const lease = await acquireLease(tower.commonDir, {
          name,
          holder: args.holder ?? actor.name,
          token: args.token ?? crypto.randomUUID(),
          pid: process.pid,
          ttlMs,
        })
        return { ok: true, action: LEASE_ACTION.acquire, lease }
      }
      const token = args.token
      if (typeof token !== 'string' || token.length === 0) {
        throw new TowerToolError('invalid-argument', 'tower_resource release requires token')
      }
      const released = await releaseLease(tower.commonDir, { name, token, force: args.force === true })
      return { ok: true, action: LEASE_ACTION.release, released, leases: redact((await inspectLeases(tower.commonDir)).leases) }
    },
  })
}
