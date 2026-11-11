// The stable blocker/failure vocabulary (#M62 W2-A).
//
// Every blocker code a gate, merge, rebase, or batch operation can report lives
// here exactly once, with the two languages the reference pages ship. Generated
// docs (`scripts/generate-blockers-reference.mjs`) and the static emission check
// (`scripts/check-blockers.mjs`) derive from this module; `scripts/check-docs.mjs`
// imports it instead of keeping a second hand-written list. Emitters call
// `blocker(code, detail)` so an unknown code fails closed at runtime as well.
//
// Kinds are the reference sections, not ownership: `worker-busy` is shared by
// the gate and rebase paths, so it appears in both tables and is counted once.
// @ts-check
import { TowerToolError } from '../errors.js'

/** @typedef {'gate' | 'merge' | 'rebase'} BlockerKind */
/** @typedef {{ en: string, zh: string }} BlockerSummary */
/**
 * @typedef {object} BlockerDefinition
 * @property {string} code
 * @property {readonly BlockerKind[]} kinds
 * @property {BlockerSummary} summary
 * @property {boolean} [reviewOnly] only produced when `review.mode` is `required`
 * @property {boolean} [warningByDefault] a stable warning unless a gate promotes it
 */
/**
 * The source rows; optional flags default to false when the frozen registry is
 * built, so a plain gate row does not have to spell them out.
 * @typedef {{ code: string, kinds: BlockerKind[], summary: BlockerSummary, reviewOnly?: boolean, warningByDefault?: boolean }} BlockerDefinitionInput
 */

export const BLOCKER_KINDS = Object.freeze(/** @type {BlockerKind[]} */ (['gate', 'merge', 'rebase']))

/** @type {BlockerDefinitionInput[]} */
const DEFINITIONS = [
  {
    code: 'mission-missing',
    kinds: ['gate'],
    summary: {
      en: 'Unknown mission id. Check `tower_status`.',
      zh: '未知 mission id。用 `tower_status` 查看。',
    },
  },
  {
    code: 'mission-not-completed',
    kinds: ['gate'],
    summary: {
      en: 'Mission is not `completed`; only a completed mission (ready for preflight/merge) merges.',
      zh: 'mission 不是 `completed`；只有 `completed`（可进入 preflight/合并）的 mission 才能合并。',
    },
  },
  {
    code: 'tasks-open',
    kinds: ['gate'],
    summary: {
      en: 'Open tasks remain; the worker must finish or `task_drop` with a reason.',
      zh: '仍有未完成任务；worker 必须先完成，或带理由 `task_drop`。',
    },
  },
  {
    code: 'blockers-present',
    kinds: ['gate'],
    summary: {
      en: 'The mission has blockers; clear them after resolving.',
      zh: 'mission 仍有 blocker；解决后清除。',
    },
  },
  {
    code: 'no-check-evidence',
    kinds: ['gate'],
    summary: {
      en: '`gates.requireChecks` is enabled and the completion report has no `checks`. Return the completed mission to `active`, re-run `tower_complete` with checks, then review again.',
      zh: '启用了 `gates.requireChecks` 且完成报告没有 `checks`。把 completed mission 退回 `active`，带 checks 重新调用 `tower_complete`，然后重新审查。',
    },
  },
  {
    code: 'branch-missing',
    kinds: ['gate'],
    summary: {
      en: 'No worktree/branch yet: spawn a worker first.',
      zh: '还没有 worktree/分支：先 spawn worker。',
    },
  },
  {
    code: 'stale-base',
    kinds: ['gate'],
    summary: {
      en: 'The branch does not contain the base tip: run `tower_rebase`.',
      zh: '分支不包含基线 tip：执行 `tower_rebase`。',
    },
  },
  {
    code: 'out-of-scope',
    kinds: ['gate'],
    summary: {
      en: 'Changed files outside the mission scope; widen scope deliberately or revert. On a case-sensitive checkout a case-only mismatch is still rejected and the detail names the scope entry it would match if case were folded.',
      zh: '改动文件超出 mission scope；有意为之就扩大 scope，否则回退。在大小写敏感的检出上，仅大小写不同的路径仍会被拒绝，detail 会指出折叠大小写后本可匹配的 scope 条目。',
    },
  },
  {
    code: 'base-dirty',
    kinds: ['gate'],
    summary: {
      en: 'The main checkout has uncommitted changes the merge would overwrite.',
      zh: '主检出存在未提交改动，合并会覆盖它们。',
    },
  },
  {
    code: 'deps-unmerged',
    kinds: ['gate'],
    summary: {
      en: 'A dependency mission is not satisfied: a build dependency must be `merged`/`abandoned`, while a survey dependency is satisfied at `completed` (archived entries included).',
      zh: '依赖 mission 尚未满足：build 依赖须 `merged`/`abandoned`；survey 依赖在 `completed` 即视为满足（含归档记录）。',
    },
  },
  {
    code: 'survey-stale',
    kinds: ['gate'],
    warningByDefault: true,
    summary: {
      en: 'A build dependency on a survey whose `readCommit` is not ancestor-or-equal of the build base. Default: a `warnings[]` entry, plan and preflight only. With `gates.requireFreshSurvey:true` the same code blocks the merge; re-plan the survey against the current base, or record why the read is still valid.',
      zh: 'build 依赖的 survey 的 `readCommit` 不是 build base 的祖先或同一提交。默认只是 `plan`/`preflight` 的 `warnings[]` 条目；`gates.requireFreshSurvey:true` 时同一 code 阻止合并。针对当前 base 重新规划 survey，或记录为何该读取仍然有效。',
    },
  },
  {
    code: 'no-review',
    kinds: ['gate'],
    reviewOnly: true,
    summary: {
      en: '`review.mode:required` and no review exists on the branch: spawn a reviewer (or disable the review gate).',
      zh: '`review.mode:required` 且分支上没有审查：spawn reviewer（或关闭审查门禁）。',
    },
  },
  {
    code: 'review-mission-mismatch',
    kinds: ['gate'],
    reviewOnly: true,
    summary: {
      en: '`review.mode:required` and the latest review belongs to another mission.',
      zh: '`review.mode:required` 且最新审查属于另一个 mission。',
    },
  },
  {
    code: 'not-clean',
    kinds: ['gate'],
    reviewOnly: true,
    summary: {
      en: '`review.mode:required` and latest review is `p1-Nitems`/`p2-Nitems`; another round is required. Verdicts from later routes of the same round are appended to it instead of flipping the mission again.',
      zh: '`review.mode:required` 且最新审查是 `p1-Nitems`/`p2-Nitems`；需要再来一轮（同一轮的各 route 结论会追加记录，不会让状态反复翻转）。',
    },
  },
  {
    code: 'review-hold',
    kinds: ['gate'],
    reviewOnly: true,
    summary: {
      en: '`review.mode:required` and latest review recommends hold; a later clean review must supersede it.',
      zh: '`review.mode:required` 且最新审查建议 hold；必须由后续的干净审查取代。',
    },
  },
  {
    code: 'review-not-approved',
    kinds: ['gate'],
    reviewOnly: true,
    summary: {
      en: '`review.mode:required` and latest clean review says `fix-then-merge` or `hold`; only `merge` approves.',
      zh: '`review.mode:required` 且最新干净审查给出的是 `fix-then-merge` 或 `hold`；只有 `merge` 才算批准。',
    },
  },
  {
    code: 'tip-moved',
    kinds: ['gate'],
    reviewOnly: true,
    summary: {
      en: '`review.mode:required` and the branch changed after review; review again (or use a clean rebase waiver).',
      zh: '`review.mode:required` 且审查之后分支发生变化；重新审查（或使用干净 rebase 的免审豁免）。',
    },
  },
  {
    code: 'worker-busy',
    kinds: ['gate', 'rebase'],
    summary: {
      en: 'A roster agent for this mission is running; wait or retire it.',
      zh: '该 mission 的 roster agent 正在运行；等待或让其退役。',
    },
  },
  {
    code: 'worker-status-unknown',
    kinds: ['gate'],
    summary: {
      en: 'The parent catalog is unavailable, so a live roster agent cannot be proven stopped; retry after the catalog recovers or adopt it.',
      zh: '父目录不可用，无法证明 live roster agent 已停止；等目录恢复后重试，或先 adopt。',
    },
  },
  {
    code: 'base-wrong-branch',
    kinds: ['gate'],
    summary: {
      en: 'The main checkout is not on the recorded base branch.',
      zh: '主检出不在记录的基线分支上。',
    },
  },
  {
    code: 'branch-owned-by-closed-missions',
    kinds: ['gate'],
    summary: {
      en: 'The mission is already merged/abandoned; re-plan under a new title.',
      zh: 'mission 已 merged/abandoned；用新标题重新 plan。',
    },
  },
  {
    code: 'worker-stale',
    kinds: ['gate'],
    summary: {
      en: 'A roster worker for this mission has no catalog activity beyond `spawn.staleMs`; adopt it (or interrupt it only if it is actually running) before merge.',
      zh: '该 mission 的 roster worker 超过 `spawn.staleMs` 没有目录活动；合并前 adopt（只有确实还在运行时才 interrupt）。',
    },
  },
  {
    code: 'tests-missing',
    kinds: ['gate'],
    summary: {
      en: '`gates.requireTests` is enabled and there is no passing discovery receipt for the current branch tip; run `tower_test` or `tower_complete`.',
      zh: '启用了 `gates.requireTests` 且没有针对当前分支 tip 的通过测试回执；运行 `tower_test` 或 `tower_complete`。',
    },
  },
  {
    code: 'tests-failed',
    kinds: ['gate'],
    summary: {
      en: 'The latest discovery receipt failed or did not meet minCount/required checks. Fix the tests and re-run.',
      zh: '最新测试发现回执失败，或不满足 minCount/required 检查。修复测试并重跑。',
    },
  },
  {
    code: 'review-exemption-invalid',
    kinds: ['gate'],
    reviewOnly: true,
    summary: {
      en: '`review.mode:required` and the mission requests `reviewPolicy:"none"` while `gates.allowReviewExemption` is off (or the reason is missing).',
      zh: '`review.mode:required` 且 mission 请求 `reviewPolicy:"none"`，但 `gates.allowReviewExemption` 关闭（或缺少理由）。',
    },
  },
  {
    code: 'merge-intent-pending',
    kinds: ['gate'],
    summary: {
      en: 'A merge intent was recorded before a crash/failure; run `tower_merge` to reconcile before another gate.',
      zh: '崩溃/失败前记录了合并意图；先运行 `tower_merge` 对账，再进行其他门禁。',
    },
  },
  {
    code: 'merge-conflict',
    kinds: ['merge'],
    summary: {
      en: 'Real index conflict; the mission is `blocked`. Resolve the conflict, then `tower_mission({clear_blockers:true})` resumes the mission to `active`; retry.',
      zh: '真实的 index 冲突；mission 变为 `blocked`。解决后把 mission 恢复为 `active`/`completed`，再重试。',
    },
  },
  {
    code: 'merge-hook-failed',
    kinds: ['merge'],
    summary: {
      en: 'A hook/process failed before a commit existed; repository restored, mission stays `completed`. Retry; `timeout: true` means the git process timed out. Raise `timeoutMs` for slow hooks.',
      zh: '在产生提交之前钩子/进程失败；仓库已恢复，mission 保持 `completed`。重试；`timeout: true` 表示 git 进程超时，慢钩子请调大 `timeoutMs`。',
    },
  },
  {
    code: 'merge-shape',
    kinds: ['merge'],
    summary: {
      en: 'Git produced unexpected merge parents; inspect the repository, do not force.',
      zh: 'Git 产生了意外的合并父提交；检查仓库，不要强推。',
    },
  },
  {
    code: 'batch-invalid',
    kinds: ['merge'],
    summary: {
      en: 'A batch id/member/receipt/check reference is invalid or close evidence is incomplete.',
      zh: 'batch id/成员/回执/检查引用无效，或 close 证据不完整。',
    },
  },
  {
    code: 'review-stale',
    kinds: ['merge'],
    summary: {
      en: 'The reviewed commit is contained in the base but the branch tip is not: the branch was partially landed or moved. Re-review or repair the branch manually; `tower_merge` does not force.',
      zh: '已审查的提交包含在基线中，但分支 tip 不在：分支被部分合入或移动过。重新审查或手工修复分支；`tower_merge` 不会强制合并。',
    },
  },
  {
    code: 'worktree-dirty',
    kinds: ['rebase'],
    summary: {
      en: 'Commit or discard worktree changes, then retry.',
      zh: '提交或丢弃 worktree 改动后重试。',
    },
  },
  {
    code: 'rebase-conflict',
    kinds: ['rebase'],
    summary: {
      en: 'A real conflict; the mission is `blocked`. Resolve manually, then `clear_blockers` resumes it to `active`; retry.',
      zh: '真实冲突；mission 变为 `blocked`。手工解决后把 mission 恢复为 `active`，再重试。',
    },
  },
]

const seen = new Set()
for (const entry of DEFINITIONS) {
  if (!/^[a-z][a-z0-9-]+$/.test(entry.code)) throw new Error(`blocker registry: invalid code "${entry.code}"`)
  if (seen.has(entry.code)) throw new Error(`blocker registry: duplicate code "${entry.code}"`)
  seen.add(entry.code)
  if (!entry.kinds.every((/** @type {string} */ kind) => BLOCKER_KINDS.includes(/** @type {BlockerKind} */ (kind)))) {
    throw new Error(`blocker registry: unknown kind for "${entry.code}"`)
  }
  for (const locale of /** @type {const} */ (['en', 'zh'])) {
    if (typeof entry.summary?.[locale] !== 'string' || entry.summary[locale].trim().length === 0) {
      throw new Error(`blocker registry: "${entry.code}" is missing a ${locale} summary`)
    }
  }
}

/** @type {ReadonlyArray<Readonly<BlockerDefinition>>} */
export const BLOCKER_DEFINITIONS = Object.freeze(
  DEFINITIONS.map((entry) =>
    Object.freeze({
      ...entry,
      kinds: Object.freeze([...entry.kinds]),
      summary: Object.freeze({ en: entry.summary.en, zh: entry.summary.zh }),
      reviewOnly: entry.reviewOnly === true,
      warningByDefault: entry.warningByDefault === true,
    }),
  ),
)

/** @type {Readonly<Record<string, Readonly<BlockerDefinition>>>} */
export const BLOCKER_CODES = Object.freeze(
  Object.fromEntries(BLOCKER_DEFINITIONS.map((entry) => [entry.code, entry])),
)

/** @type {ReadonlyArray<string>} */
export const BLOCKER_CODE_VALUES = Object.freeze(BLOCKER_DEFINITIONS.map((entry) => entry.code))

export const BLOCKER_COUNT = BLOCKER_CODE_VALUES.length

/**
 * @param {string} code
 * @returns {boolean}
 */
export function isBlockerCode(code) {
  return Object.prototype.hasOwnProperty.call(BLOCKER_CODES, code)
}

/**
 * The registry entry for a code, or `undefined` for an unknown code.
 * @param {string} code
 * @returns {Readonly<BlockerDefinition> | undefined}
 */
export function blockerEntry(code) {
  return isBlockerCode(code) ? BLOCKER_CODES[code] : undefined
}

/**
 * Fail closed: an emitter that names a code outside the registry gets an
 * `invalid-argument` error naming the registry, not a silently undocumented
 * blocker. Keeping this check at the emitter is what makes the registry
 * load-bearing at runtime, not only in the docs/gate scripts.
 * @param {string} code
 * @returns {string}
 */
export function assertBlockerCode(code) {
  if (!isBlockerCode(code)) {
    throw new TowerToolError('invalid-argument', `unknown blocker code "${code}"`, {
      nextAction: 'add the code to domain/shapes/blockers.js before emitting it',
    })
  }
  return code
}

/**
 * Build one blocker record. This is the only constructor the gate and shapes
 * use, so every emitted code passes the registry check.
 * @param {string} code
 * @param {string} detail
 * @returns {{ code: string, detail: string }}
 */
export function blocker(code, detail) {
  assertBlockerCode(code)
  return { code, detail }
}

/**
 * Registry codes in declaration order for one reference section.
 * @param {BlockerKind} kind
 * @returns {ReadonlyArray<Readonly<BlockerDefinition>>}
 */
export function blockersOfKind(kind) {
  if (!BLOCKER_KINDS.includes(kind)) throw new Error(`blocker registry: unknown kind "${kind}"`)
  return BLOCKER_DEFINITIONS.filter((entry) => entry.kinds.includes(kind))
}

/**
 * Codes that appear in more than one reference section (`worker-busy`).
 * @returns {ReadonlyArray<string>}
 */
export function sharedBlockerCodes() {
  return BLOCKER_DEFINITIONS.filter((entry) => entry.kinds.length > 1).map((entry) => entry.code)
}

/** Codes gated behind `review.mode: required`. */
export const REVIEW_BLOCKER_CODES = Object.freeze(
  BLOCKER_DEFINITIONS.filter((entry) => entry.reviewOnly).map((entry) => entry.code),
)

/** Codes reported as a stable warning by default rather than a blocker. */
export const WARNING_BLOCKER_CODES = Object.freeze(
  BLOCKER_DEFINITIONS.filter((entry) => entry.warningByDefault).map((entry) => entry.code),
)
