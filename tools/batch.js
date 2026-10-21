// tower_batch: finite evidence batches.
import { Tower } from '../app/tower.js'
import { SCHEMAS, output } from './output-schemas.js'
import { TowerToolError } from '../lib/errors.js'
import { Type, enumOf } from './schema.js'

/**
 * Untyped JSON object entries (checks, receiptHashes) must keep their exact
 * `{ type: 'object' }` shape; Type.Object({}) would add a `properties: {}` key.
 * @param {string} [description]
 */
const untypedObject = (description) =>
  Type.Unsafe(description === undefined ? { type: 'object' } : { type: 'object', description })

/**
 * @param {any} ctx
 * @param {{ define: import('../types/index.js').DefineTool, actorFor: any, requireTowerActor: any, summarizeBatch: any, verifyBatchReceiptFiles: any }} deps
 */
export function registerBatchTool(ctx, deps) {
  const { define, actorFor, requireTowerActor, summarizeBatch, verifyBatchReceiptFiles } = deps
  define(ctx, {
    name: 'tower_batch',
    description:
      'Manage finite evidence batches: create freezes missionIds/requiredChecks/receiptPaths, status summarizes members, close verifies every required check and receipt hash, abandon retires a stale open batch. Membership and exclusions are immutable after create; close/abandon never remove missions.',
    parameters: Type.Object({
      repoRoot: Type.String({ description: 'Absolute path inside the target Git repository.' }),
      action: enumOf(['create', 'status', 'close', 'abandon'], { description: 'Batch operation.' }),
      missionIds: Type.Optional(Type.Array(Type.String(), { description: 'Exact mission ids in this batch (create).' })),
      exclusions: Type.Optional(Type.Array(Type.String(), { description: 'Paused legacy mission ids excluded from the batch.' })),
      requiredChecks: Type.Optional(Type.Array(Type.String(), { description: 'Check names every build member must record (default ["check"]).' })),
      receiptPaths: Type.Optional(Type.Array(Type.String(), { description: 'Exact relative receipt files checked at close.' })),
      batchId: Type.Optional(Type.String({ description: 'Batch id (status/close/abandon).' })),
      reason: Type.Optional(Type.String({ description: 'Reason recorded when abandoning a batch.' })),
      checks: Type.Optional(Type.Array(untypedObject(), { description: 'Close-time extra check evidence.' })),
      treeTip: Type.Optional(Type.String({ description: 'Expected reviewed/tested commit for close evidence.' })),
      receiptHashes: Type.Optional(untypedObject('Relative receipt path -> sha256 observed by the caller.')),
    }, { additionalProperties: false }),
    board: true,
    output: output(SCHEMAS.batch),
    async execute(args, exec) {
      const tower = await Tower.open(args.repoRoot)
      const actor = await actorFor(tower, exec)
      if (args.action === 'status') {
        const state = await tower.load()
        const batch = args.batchId
          ? (state.batches ?? []).find((entry) => entry.id === args.batchId)
          : null
        if (args.batchId && !batch) throw new TowerToolError('invalid-argument', `unknown batch "${args.batchId}"`)
        return {
          ok: true,
          action: 'status',
          batches: (state.batches ?? []).map((entry) => summarizeBatch(state, entry)),
          ...(batch ? { batch: summarizeBatch(state, batch) } : {}),
          ...(args.batchId ? { summary: summarizeBatch(state, batch) } : {}),
        }
      }
      requireTowerActor(actor, args.action === 'create' ? 'create a batch' : args.action === 'abandon' ? 'abandon a batch' : 'close a batch')
      if (args.action === 'create') {
        const batch = await tower.createBatch(args, actor.name)
        return { ok: true, action: 'create', batch, batches: (await tower.batchStatus()).batches }
      }
      if (typeof args.batchId !== 'string' || args.batchId.trim().length === 0) {
        throw new TowerToolError('invalid-argument', `tower_batch ${args.action} requires batchId`)
      }
      const batchId = args.batchId.trim()
      if (args.action === 'abandon') {
        const result = await tower.abandonBatch(batchId, actor.name, /** @type {any} */ (args.reason))
        return { ok: true, action: 'abandon', batch: result.batch, blockers: [] }
      }
      const closeState = await tower.load()
      const closeBatch = (closeState.batches ?? []).find((entry) => entry.id === batchId)
      if (closeBatch) {
        const receiptProblems = await verifyBatchReceiptFiles(tower.root, closeBatch, args)
        if (receiptProblems.length > 0) {
          return { ok: false, action: 'close', batch: closeBatch, blockers: receiptProblems, checks: [] }
        }
      }
      const result = await tower.closeBatch(batchId, {
        checks: args.checks,
        treeTip: args.treeTip,
        receiptHashes: args.receiptHashes,
      }, actor.name)
      return {
        ok: result.ok,
        action: 'close',
        batch: result.batch,
        blockers: (result.blockers ?? []).map((blocker) => ({
          code: blocker.code ?? 'batch-invalid',
          detail: blocker.detail ?? blocker.message ?? String(blocker),
          ...(blocker.cleanup ? { cleanup: blocker.cleanup } : {}),
          ...(blocker.timeout ? { timeout: true } : {}),
        })),
        checks: result.checks ?? [],
      }
    },
  })
}
