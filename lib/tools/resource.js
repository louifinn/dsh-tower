// tower_resource: advisory resource leases.
import { Tower } from '../tower.js'
import { SCHEMAS, output } from '../schemas.js'
import { TowerToolError } from '../errors.js'
import { acquireLease, releaseLease, inspectLeases } from '../leases.js'

export function registerResourceTool(ctx, deps) {
  const { define, actorFor, requireTowerActor } = deps
  define(ctx, {
    name: 'tower_resource',
    description:
      'Advisory resource leases per repository (coordination only; no OS CPU/memory hard cap). acquire/release require a token and are tower-only; status is read-only. Expired leases are never taken over silently.',
    parameters: {
      type: 'object',
      properties: {
        repoRoot: { type: 'string', description: 'Absolute path inside the target Git repository.' },
        action: { type: 'string', enum: ['acquire', 'release', 'status'], description: 'Lease operation.' },
        name: { type: 'string', description: 'Lease name, e.g. plugin-load or heavy-ci.' },
        holder: { type: 'string', description: 'Holder label (defaults to the caller).' },
        token: { type: 'string', description: 'Release token; generated on acquire when omitted.' },
        ttlMs: { type: 'integer', minimum: 1000, description: 'Lease lifetime (default leases.ttlMs).' },
        force: { type: 'boolean', description: 'Explicitly release an expired lease (token still required).' },
      },
      required: ['repoRoot', 'action'],
      additionalProperties: false,
    },
    output: output(SCHEMAS.resource),
    async execute(args, exec) {
      const tower = await Tower.open(args.repoRoot)
      const actor = await actorFor(tower, exec)
      const redact = (leases) => leases.map(({ token, ...lease }) => lease)
      if (args.action === 'status') {
        const info = await inspectLeases(tower.commonDir)
        const leases = redact(info.leases ?? [])
        return { ok: true, action: 'status', ...info, leases }
      }
      requireTowerActor(actor, args.action === 'acquire' ? 'acquire a lease' : 'release a lease')
      if (typeof args.name !== 'string' || args.name.trim().length === 0) {
        throw new TowerToolError('invalid-argument', 'tower_resource requires name')
      }
      const name = args.name.trim()
      const ttlMs = Number(args.ttlMs ?? tower.config.leases?.ttlMs ?? 900000)
      if (args.action === 'acquire') {
        const lease = await acquireLease(tower.commonDir, {
          name,
          holder: args.holder ?? actor.name,
          token: args.token ?? crypto.randomUUID(),
          pid: process.pid,
          ttlMs,
        })
        return { ok: true, action: 'acquire', lease }
      }
      const token = args.token
      if (typeof token !== 'string' || token.length === 0) {
        throw new TowerToolError('invalid-argument', 'tower_resource release requires token')
      }
      const released = await releaseLease(tower.commonDir, { name, token, force: args.force === true })
      return { ok: true, action: 'release', released, leases: redact((await inspectLeases(tower.commonDir)).leases) }
    },
  })
}
