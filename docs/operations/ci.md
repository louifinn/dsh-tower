# CI: the canonical gate and the one-cycle cutover

This repository has one CI workflow, [`.github/workflows/test.yml`](../../.github/workflows/test.yml). Its
job is not to re-test things `npm run check` already tests; its job is to **be** `npm run check` on the
runtime the package supports, plus the evidence that only a real runner can produce (a mounted tarball,
a booted host, a browser) and the nightly failure report.

## What runs

| Context | Runner | What it proves |
|---|---|---|
| `test (24.9)`, `test (25)`, `test (24.9, windows)` | Ubuntu / Ubuntu / Windows, Node 24.9 / 25 / 24.9 | One canonical `npm run check` per leg. The Ubuntu 24.9 leg also runs the tag-only release check, the coverage table and the live-harness environment check. |
| `test (22)`, `test (24)`, `test (22, windows)` | Ubuntu / Ubuntu / Windows, Node 22 / 24 / 22 | **Legacy transition contexts.** The frozen step-by-step gate list, kept byte-for-byte so the current branch protection still reports while the canonical legs prove themselves. |
| `mount` | Ubuntu, Node 24.9 | The packed tarball mounts in a throwaway profile and registers its surface (`npm run smoke:mount`). Required context, unchanged by this transition. |
| `mount-fixtures` | Ubuntu, Node 24.9 | Seeded mount-smoke failures against one cached host install. Evidence only, never a merge gate. |
| `live (0.2.2-rc.1)` | Ubuntu, Node 24.9 | Nightly/manual-only real Web runtime pinned by the matrix; never gates a push or PR. |
| `property-long` | Ubuntu, Node 24.9 | Nightly/manual-only 2000-run property tier. Evidence only. |
| `nightly failure report` | Ubuntu | Schedule-only reporter: opens or updates **one** issue with the failing job names and the run URL. |

The legacy `test` job is frozen on purpose. It is the evidence the old context names still claim
(Node 22/24 hands-on), and `tests/live-harness.test.mjs` and `tests/mount-smoke.test.mjs` assert its
shape. Do not add gates to it; new gates belong in `npm run check`. It is deleted in step 2 below.

## The canonical gate

`canonical` is a real matrix job with three legs (`label`/`os`/`node`/`release`). Each leg runs exactly
one `npm run check`, the same command [CONTRIBUTING.md](../../CONTRIBUTING.md#landing-changes) gives a
human, so the CI list cannot drift from [`package.json`](../../package.json). A leg does not repeat a
gate step after `npm run check`; the only extra steps are CI-only reports:

- **release check** (`npm run release:check`) — tag-only behavior, so one Node 24.9 leg is enough;
- **coverage** (`npm run test:coverage`) — a table, not a threshold, so one leg is enough;
- **live-harness environment check** (`npm run test:live -- --check`) — no browser, no host install, and
  it must obey the `TMPDIR`/`DSH_HOME` pairing documented in
  [tests/README.md](../../tests/README.md#2-real-web-runtime-isolated-profile).

All three are gated by `matrix.release`, which is `true` only on the Ubuntu Node 24.9 leg. The Windows
leg runs `npm run check` exactly once as well: a platform branch is only measured if the *whole* gate
runs there. The canonical checkout uses `fetch-depth: 0` because the release check resolves the
previous tag with `git describe --tags`; a depth-1 clone would hide the tags and downgrade a tag
violation to a `[no-baseline]` warning.

### `npm run workflow:check`

`npm run check` runs `node scripts/check-workflow.mjs`, which machine-checks the contract in this
document against the workflow text:

- the canonical job carries the three supported contexts, checks out with `fetch-depth: 0` so the
  release check keeps its tag baseline, and runs `npm run check` exactly once per leg;
- the frozen legacy job still carries the four required context strings (`test (22)`, `test (24)`,
  `test (22, windows)`, `mount`) on their pinned OS/Node versions;
- every `uses:` is a 40-hex commit SHA with a `# vX.Y.Z` version comment;
- top-level `permissions` is exactly `contents: read`, `concurrency` is per-ref and per-event with
  `cancel-in-progress` limited to pushes/PRs, every job that runs `npm ci` sets `cache: npm` on
  `setup-node`;
- every artifact upload sets `retention-days` in 1–14;
- the `nightly-failure` job is schedule-only, needs every gated job, grants itself `issues: write` and
  `actions: read`, and opens/comments on one stable-titled issue with the run URL.

`tests/workflow-contract.test.mjs` proves each rule is load-bearing by tampering with the real workflow
text (unpinning an action, widening permissions, removing a required context, dropping the canonical
step, adding a second `npm run check`, dropping the canonical checkout's full history, sharing the
concurrency group with the nightly schedule, moving the Node-24-only extras onto the Windows leg,
unbounding artifact retention, breaking the issue dedupe). Run both gates locally with:

```bash
npm run workflow:check
node --test tests/workflow-contract.test.mjs
```

## Hardening

- **Least privilege.** The workflow declares `permissions: { contents: read }` at the top level; no
  job declares its own permissions except `nightly-failure`, which opts into
  `actions: read` (to name the failing jobs) and `issues: write` (to open/update the issue). Push/PR
  steps therefore cannot write to the repository or its issues.
- **Concurrency.** `group: ${{ github.workflow }}-${{ github.event_name }}-${{ github.ref }}` with
  `cancel-in-progress: ${{ github.event_name == 'push' || github.event_name == 'pull_request' }}`. The
  event name is part of the group because a push and the nightly schedule both use `refs/heads/main`;
  without it a push would cancel an in-flight scheduled run (the incoming run's `cancel-in-progress`
  decides). A superseded push/PR run is cancelled within its own event class; scheduled and manual
  runs have their own groups and always finish, so nightly evidence and its report are never
  interrupted.
- **Pinned actions.** Every `uses:` is a commit SHA with a version comment. The pins are

  | Action | Version | Commit |
  |---|---|---|
  | `actions/checkout` | v4.2.2 | `11bd71901bbe5b1630ceea73d27597364c9af683` |
  | `actions/setup-node` | v4.0.4 | `0a44ba7841725637a19e28fa30b79a866c81b0a6` |
  | `actions/cache` (mount-fixtures host install) | v4.2.3 | `5a3ec84eff668545956fd18022155c47e93e2684` |
  | `actions/upload-artifact` (property and live diagnostics) | v4.6.2 | `ea165f8d65b6e75b540449e92b4886f43607fa02` |

- **npm cache.** Every job that runs `npm ci` passes `cache: npm` to `actions/setup-node`.
- **Bounded artifacts.** Both uploads set `retention-days: 7`; the live diagnostics keep exactly the
  screenshot and log, and the property artifacts are failure evidence.
- **Nightly failure report.** On `schedule` only, when a needed job failed, `nightly-failure` reads the
  run's jobs from `GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs`, joins the failed/cancelled
  display names, and finds or creates the issue titled `Nightly test workflow failure`:

  ```bash
  gh issue list --state open --search 'in:title "Nightly test workflow failure"' --json number
  ```

  If it exists, the job comments with the run URL and failing names; otherwise it creates the issue.
  That is one issue per repository, not one per failure, and it is the only write in the workflow.

`docs/operations/ci.md` itself is repository-only this cycle: it is excluded from the published tarball
via a `files` negation in `package.json`, because the reviewed
[`scripts/pack-manifest.txt`](../../scripts/pack-manifest.txt) is updated in a separate packaging
change. Remove the negation and add the path to the manifest in one commit.

## The two-step cutover

`main` is protected, admin enforcement is on, and the protection setting is owned by the repository
admin. An agent token without admin permission must not attempt this. The current required contexts are
`test (22)`, `test (24)`, `test (22, windows)` and `mount`; the setting is authoritative (some prose
predates the Windows context becoming required), and the verification command is in
[SECURITY.md](../../SECURITY.md#repository-protection-on-main).

The canonical legs report from the moment the workflow change lands, but a required context that is not
yet in the protection setting is ignored, and removing an old context before its replacement is
required makes every open PR unmergeable. Hence two steps:

### Step 1 — add the transition contexts (admin, after the canonical legs have reported green once)

Record the current setting first:

```bash
gh api repos/louifinn/dsh-tower/branches/main/protection/required_status_checks \
  --jq '{strict: .strict, contexts: .contexts}'
```

Then keep all four legacy contexts and add the three supported ones (keep `strict` exactly as printed
above; the body below mirrors the current `strict: true`):

```bash
gh api --method PATCH \
  repos/louifinn/dsh-tower/branches/main/protection/required_status_checks \
  --input - <<'JSON'
{
  "strict": true,
  "contexts": [
    "test (22)",
    "test (24)",
    "test (22, windows)",
    "mount",
    "test (24.9)",
    "test (25)",
    "test (24.9, windows)"
  ]
}
JSON
```

Verify the seven contexts and let one full PR cycle merge green with both sets reporting:

```bash
gh api repos/louifinn/dsh-tower/branches/main/protection/required_status_checks \
  --jq '.contexts'
```

### Step 2 — drop the legacy contexts, then the legacy job (admin + one follow-up PR)

After a cycle in which all seven reported green on a merged PR, remove the three legacy `test` contexts
and keep the supported ones plus `mount` (again mirror the recorded `strict`):

```bash
gh api --method PATCH \
  repos/louifinn/dsh-tower/branches/main/protection/required_status_checks \
  --input - <<'JSON'
{
  "strict": true,
  "contexts": [
    "test (24.9)",
    "test (25)",
    "test (24.9, windows)",
    "mount"
  ]
}
JSON
```

The follow-up PR then deletes the frozen `test` job from the workflow and updates the gates that still
name it: `REQUIRED_CONTEXTS` in [`scripts/check-workflow.mjs`](../../scripts/check-workflow.mjs),
`tests/live-harness.test.mjs` (the push-level `test`-job assertions), `tests/mount-smoke.test.mjs` (the
matrix-name assertion) and the required-context tables in [CONTRIBUTING.md](../../CONTRIBUTING.md). No
other job changes: `mount`, `mount-fixtures`, `live`, `property-long` and `nightly-failure` are already
named for the supported runtime.

### Rollback

**Before step 2**, rollback is one settings change: `PATCH` the required contexts back to the four
legacy strings. Nothing else needs to change because the frozen `test` job still runs and still reports
the old names:

```bash
gh api --method PATCH \
  repos/louifinn/dsh-tower/branches/main/protection/required_status_checks \
  --input - <<'JSON'
{
  "strict": true,
  "contexts": ["test (22)", "test (24)", "test (22, windows)", "mount"]
}
JSON
```

**After step 2**, roll back the protection setting with the same command and `git revert` the
follow-up commit that deleted the frozen `test` job. Record that commit's SHA in the PR that performs
step 2; a branch protection change alone cannot resurrect a deleted job.

## Related

- [CONTRIBUTING.md](../../CONTRIBUTING.md#landing-changes) — the required-context table and the local
  checklist.
- [security.md](./security.md#repository-protection) — what the protection does and does not buy.
- [tests/README.md](../../tests/README.md) — the offline, live and property tiers the gates run.
- [runbook.md](./runbook.md) — operator recovery procedures.
