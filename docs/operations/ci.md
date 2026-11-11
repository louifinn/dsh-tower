# CI: the canonical gate and the completed branch-protection cutover

This repository has one CI workflow, [`.github/workflows/test.yml`](../../.github/workflows/test.yml). Its
job is not to re-test things `npm run check` already tests; its job is to **be** `npm run check` on the
runtime the package supports, plus the evidence that only a real runner can produce (a mounted tarball,
a booted host, a browser) and the nightly failure report.

## What runs

| Context | Runner | What it proves |
|---|---|---|
| `test (24.9)`, `test (25)`, `test (24.9, windows)` | Ubuntu / Ubuntu / Windows, Node 24.9 / 25 / 24.9 | One canonical `npm run check` per leg. The Ubuntu 24.9 leg also runs the tag-only release check, the coverage table and the live-harness environment check. |
| `mount` | Ubuntu, Node 24.9 | The packed tarball mounts in a throwaway profile and registers its surface (`npm run smoke:mount`). Required context. |
| `mount-fixtures` | Ubuntu, Node 24.9 | Seeded mount-smoke failures against one cached host install. Evidence only, never a merge gate. |
| `live (0.2.2-rc.1)` | Ubuntu, Node 24.9 | Nightly/manual-only real Web runtime pinned by the matrix; never gates a push or PR. |
| `property-long` | Ubuntu, Node 24.9 | Nightly/manual-only 2000-run property tier. Evidence only. |
| `nightly failure report` | Ubuntu | Schedule-only reporter: opens or updates **one** issue with the failing job names and the run URL. |

There is no legacy job. The workflow reports exactly the four required contexts — the three canonical
legs above and `mount` — and the branch-protection setting requires exactly those four.

## The canonical gate

`canonical` is a real matrix job with three legs (`label`/`os`/`node`/`release`). Each leg runs exactly
one `npm run check`, the same command [CONTRIBUTING.md](../../CONTRIBUTING.md#landing-changes) gives a
human, so the CI list cannot drift from [`package.json`](../../package.json). A leg does not repeat a
gate step after `npm run check`; the only extra steps are CI-only reports:

- **release check** (`npm run release:check`) — warns on a PR; on a tag push it fails closed unless
  the tag is an annotated tag object whose commit is in HEAD's history, the tree is clean, the tag
  matches `v<version>`, the version moved past the previous version tag, the CHANGELOG has a
  non-empty section for the version, and `scripts/support.json` agrees with its restatements.
  Tag-only behavior, so one Node 24.9 leg is enough; on a tag push the leg first restores the
  annotated tag ref (see [the tag-push checkout hazard](#the-tag-push-checkout-hazard-m79));
- **prepublish gate** (`npm run release:prepublish`, wired through `prepublishOnly`) — the same
  release claim in `--mode prepublish` plus `support:check`, the generated-docs checks and
  `pack:check`. It is read-only and offline and runs on `npm publish` itself, so a local publish
  fails closed on a dirty tree, a version/tag mismatch, a missing CHANGELOG section or support
  drift before npm talks to the registry;
- **coverage** (`npm run test:coverage`) — a table, not a threshold, so one leg is enough;
- **live-harness environment check** (`npm run test:live -- --check`) — no browser, no host install, and
  it must obey the `TMPDIR`/`DSH_HOME` pairing documented in
  [tests/README.md](../../tests/README.md#2-real-web-runtime-isolated-profile).

All three are gated by `matrix.release`, which is `true` only on the Ubuntu Node 24.9 leg. The Windows
leg runs `npm run check` exactly once as well: a platform branch is only measured if the *whole* gate
runs there. The canonical checkout uses `fetch-depth: 0` because the release check resolves the
previous tag with `git describe --tags`; a depth-1 clone would hide the tags and downgrade a tag
violation to a `[no-baseline]` warning.

### The tag-push checkout hazard (#M79)

On a tag push the checkout also rewrites the tag ref. `actions/checkout` runs with `fetch-tags: false`
and fetches `+<tag commit>:refs/tags/<tag>`, which replaces the annotated tag object with a lightweight
ref in the runner's checkout. The release check reads exactly that ref (`git cat-file -t
refs/tags/<tag>`), so the v2.8.0 tag run failed with `error [tag-lightweight] refs/tags/v2.8.0 is a
commit, not an annotated tag object` (run 43087228866) even though origin's tag was annotated. The
canonical job therefore re-fetches the pushed tag ref after the gate steps and before the release
check, on the release leg only:

```yaml
- name: Restore the annotated tag object
  if: matrix.release && github.ref_type == 'tag'
  run: git fetch --force origin "+refs/tags/${GITHUB_REF_NAME}:refs/tags/${GITHUB_REF_NAME}"
```

The explicit refspec and `--force` are load-bearing. Fetching the commit SHA again
(`+<sha>:refs/tags/<tag>`) recreates the lightweight ref, and `git fetch --tags` cannot be combined
with the commit-to-tag fetch that checkout performs (`fatal: Cannot fetch both <sha> and
refs/tags/<tag> to refs/tags/<tag>`), which is why this is a separate step rather than
`fetch-tags: true`. The annotation requirement is not weakened: a genuinely lightweight tag still
resolves to `commit` after the restore and the release check still refuses it.

### `npm run workflow:check`

`npm run check` runs `node scripts/check-workflow.mjs`, which machine-checks the contract in this
document against the workflow text:

- the canonical job carries the three supported contexts, checks out with `fetch-depth: 0` so the
  release check keeps its tag baseline, and runs `npm run check` exactly once per leg;
- the tag-push release leg re-fetches the pushed tag ref (`git fetch --force origin
  "+refs/tags/${GITHUB_REF_NAME}:refs/tags/${GITHUB_REF_NAME}"`) after checkout and before
  `npm run release:check`, gated by `matrix.release` and `github.ref_type == 'tag'`, so the release
  check inspects the annotated tag object instead of the lightweight ref the checkout writes;
- the required-context contract is exactly four contexts — the `canonical` job's three labels plus the
  `mount` job — and a reintroduced legacy `test` job is rejected;
- every `uses:` is a 40-hex commit SHA with a `# vX.Y.Z` version comment;
- top-level `permissions` is exactly `contents: read`, `concurrency` is per-ref and per-event with
  `cancel-in-progress` limited to pushes/PRs, every job that runs `npm ci` sets `cache: npm` on
  `setup-node`;
- every artifact upload sets `retention-days` in 1–14;
- the `nightly-failure` job is schedule-only, needs every gated job, grants itself `issues: write` and
  `actions: read`, and opens/comments on one stable-titled issue with the run URL.

`tests/workflow-contract.test.mjs` proves each rule is load-bearing by tampering with the real workflow
text (reintroducing the legacy `test` job, removing a required canonical context, adding an extra
matrix context, unpinning an action, widening permissions, dropping the canonical step, adding a
second `npm run check`, dropping the canonical checkout's full history, dropping or reordering the
annotated-tag restore step, ungating it, fetching the tag commit instead of the tag ref, dropping its
`--force`, sharing the concurrency group with the nightly schedule, moving the Node-24-only extras
onto the Windows leg, unbounding artifact retention, breaking the issue dedupe). Run the gates
locally with:

```bash
npm run workflow:check
node --test tests/workflow-contract.test.mjs
node --test tests/release-gate.test.mjs
```

The release-gate suite includes a local simulation of the hazard: an annotated tag in a real origin
repository, a clone whose checkout fetch overwrites `refs/tags/<tag>` with the commit (the release
check fails with `[tag-lightweight]` and `tag-type=commit`), then the workflow's own restore command
(which must still be present in the workflow text) puts the annotated object back, `git cat-file -t`
reports `tag`, and the release check passes.

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

## The branch-protection cutover

`main` is protected, admin enforcement is on, and the protection setting is owned by the repository
admin. An agent token without admin permission must not attempt to change it. The cutover is
**complete**: the required contexts are the four that remain — `mount`, `test (24.9)`, `test (25)` and
`test (24.9, windows)` — under `strict: true`, and the workflow no longer has a legacy `test` job. The
setting is authoritative, the verification command is in
[SECURITY.md](../../SECURITY.md#repository-protection-on-main), and this section records how the two
steps were applied and how to roll back.

The canonical legs report from the moment the workflow change lands, but a required context that is not
in the protection setting is ignored, and removing an old context before its replacement is required
makes every open PR unmergeable. Hence two steps: step 1 kept all four legacy entries and added the
three canonical contexts, and step 2 dropped the legacy contexts only after the canonical legs had
proven themselves.

### Step 1 — completed: seven contexts during the transition

The admin first changed the setting from the four legacy strings to seven contexts: the three legacy
`test (22)`-style contexts, `mount`, and the three canonical legs. This body is kept as the history of
the transition:

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

### Step 2 — applied: four contexts, no legacy job

After a full cycle in which all seven reported green on merged PRs, the admin applied the final
setting — the three canonical legs plus `mount`, mirroring the recorded `strict`:

```bash
gh api --method PATCH \
  repos/louifinn/dsh-tower/branches/main/protection/required_status_checks \
  --input - <<'JSON'
{
  "strict": true,
  "contexts": [
    "mount",
    "test (24.9)",
    "test (25)",
    "test (24.9, windows)"
  ]
}
JSON
```

The same change deletes the frozen `test` job from the workflow and updates the gates that named it:
the required-context contract and legacy-job rejection in
[`scripts/check-workflow.mjs`](../../scripts/check-workflow.mjs), the tamper cases in
`tests/workflow-contract.test.mjs`, the required-context tables in
[CONTRIBUTING.md](../../CONTRIBUTING.md#landing-changes), and the offline-suite assertions that pinned
the deleted job's shape in `tests/live-harness.test.mjs`, `tests/mount-smoke.test.mjs` and
`tests/support-manifest.test.mjs`. Those three suites now pin the final four-context contract, so the
canonical legs report green on the cutover itself. No other job changes: `mount`, `mount-fixtures`,
`live`, `property-long` and `nightly-failure` are already named for the supported runtime.

Verify the four contexts; every PR must merge green with all four reporting:

```bash
gh api repos/louifinn/dsh-tower/branches/main/protection/required_status_checks \
  --jq '{strict: .strict, contexts: .contexts}'
```

### Rollback

Rolling back means restoring the job before the protection setting: `git revert` the commit that
deleted the frozen `test` job, then `PATCH` the required contexts back to the seven-context body above.
A branch-protection change alone cannot resurrect a deleted job, so the revert must land (or at least
be ready) before the contexts point at names that no longer report.

If only the setting is wrong and the workflow is unchanged, `PATCH` the four-context body again; the
stored `strict` value must match the live setting.

## Related

- [CONTRIBUTING.md](../../CONTRIBUTING.md#landing-changes) — the required-context table and the local
  checklist.
- [security.md](./security.md#repository-protection) — what the protection does and does not buy.
- [tests/README.md](../../tests/README.md) — the offline, live and property tiers the gates run.
- [runbook.md](./runbook.md) — operator recovery procedures.
