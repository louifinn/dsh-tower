# Quick start

Prerequisites: DSH `0.2.1-rc.2`+, Node.js 22+, Git. Install `dsh-tower` and restart DSH (see
[install](install-upgrade-migration.md)).

## 1. Enter Tower mode

```
/tower
```

The session reports `Tower mode ON`. You are now the control tower; goal/todo/team delegation tools are
reserved for normal mode.

## 2. Initialize and plan

```
tower_init repoRoot=D:\work\repo
tower_plan repoRoot=D:\work\repo missions=[{"title":"Feature A","scope":["src/a/**"],"tasks":["implement the feature","commit the change"],"kind":"build"}]
```

`tower_plan` returns mission ids (`M1`). Each mission gets a branch and a worktree when spawned.

## 3. Run the worker

```
tower_spawn repoRoot=D:\work\repo missionId=M1 role=worker
```

The call returns immediately with the child agent id. The worker works inside the mission worktree,
commits, marks tasks done, and calls `tower_complete`; its final report is delivered back to this
session. Use `tower_roster` to observe activity; do not poll in a loop.

## 4. Optional: review

Independent review is optional by default. If you want the strict workflow, enable it in the profile
or repository config first (`review.requireReview:true`), then:

```
tower_spawn repoRoot=D:\work\repo missionId=M1 role=reviewer
```

Reviewers use the read-only `tower-reviewer` preset. They inspect `tower_diff` and submit
`tower_review`; with `review.requireReview:true`, a `clean` + `merge` verdict is required to merge.

## 5. Gate, merge, clean up

```
tower_preflight repoRoot=D:\work\repo missionId=M1
tower_merge     repoRoot=D:\work\repo missionId=M1
tower_teardown  repoRoot=D:\work\repo
```

With the review gate enabled, `tower_preflight` before review reports `no-review`, and after a clean
review it should be `ok:true`. With the default (`review.requireReview:false`), no review blocker is
required. `tower_merge` refuses while blockers remain. `tower_teardown` removes merged/abandoned
worktrees and branches.

```
/tower off
```

## If something fails

Read the blocker code and use [the blocker reference](../reference/blockers.md). The most common cases:
`stale-base` (run `tower_rebase`), `no-review` (only with `review.requireReview:true`; spawn a
reviewer), `merge-hook-failed` (retry, or raise `timeoutMs`), `tip-moved` (only with the review gate;
the branch changed after review, review again).

Thrown tool failures carry a `[tower:<code>]` prefix; see [error codes](../reference/errors.md)
(e.g. `preset-missing` means restart DSH after installing the bundle, `not-initialized` means run
`tower_init` first).

## Optional: per-repository config

A repository can tune review, merge, worktree and spawn policy without touching the DSH profile. Put a
JSON file at `<git-common-dir>/dsh-tower/config.json` (usually `.git/dsh-tower/config.json`):

```json
{
  "review": { "requireReview": true, "maxRoundsPerReviewer": 3 },
  "merge": { "timeoutMs": 1800000 },
  "worktrees": { "root": "D:/tower-worktrees" }
}
```

The repository layer overrides the profile config; per-call tool arguments override both. See the
[config reference](../reference/config.md) for the full table and precedence.

## Optional: findings

Out-of-scope observations go to `tower_finding`. Later, list or close them without editing code:

```
tower_findings repoRoot=D:\work\repo
tower_findings repoRoot=D:\work\repo id=F1 status=fixed note="fixed in M2"
```

Statuses are `open → triaged → fixed` / `wontfix`, and `fixed`/`wontfix` can reopen to `open`. Only the
tower or a worker may change a finding; reviewers can list and read.

A complete copy-paste example: [examples/first-mission.md](../examples/first-mission.md).

## Component rows, runtime preconditions and message language

The optional component rows are the only switches in this bundle (#121, #136). Three runtime rules
follow from that, plus the language policy for everything a tool prints.

### A row is the only switch

`tests.enabled` was removed (#136). Discovery is on exactly while the `tower-tests` row is mounted:
with the row off there is no `tower_test` tool and no test receipt to gate on, so a second boolean
could only disagree with the mounted profile. A repository config that still writes
`tests.enabled` is rejected as `config-unknown-key`; delete the key and enable or disable the row
instead.

The same reasoning covers the other rows:

- `tower-leases` owns `tower_resource`. `spawn.requireLease` is satisfied through that tool, so a
  config that requires a lease while the row is off is refused by the runtime preconditions with
  `config-invalid`, naming the row and both remedies ("re-enable the tower-leases component or clear
  spawn.requireLease") instead of failing every spawn at `lease-busy` with advice to use a tool that
  is not registered (#131).
- `tower-tests` must stay mounted while `gates.requireTests` is true. Planning and mode entry refuse
  the combination; the merge gate's `tests-missing` blocker also names the disabled row as the cause
  (#140).
- `tower-hmr` ships off; `/tower reload` reports it by row name.

No runtime path may claim a repository is "not configured" when a component row is the reason.
Component causes are reported as `disabled by component <id>` and come with the fix (`enable the
<id> row in the plugin page and restart DSH`).

### Preconditions run on mode entry, not on every `/tower` input (#142)

`/tower` re-validates the runtime preconditions (presets, component/config contradictions) only when
it **enters** Tower mode:

| Input | Preconditions |
|---|---|
| `/tower`, `/tower on`, `/tower <text>` while the mode is off | validated |
| `/tower off`, `/tower off <text>` | not validated |
| `/tower <text>` while the mode is already on | not validated |
| `/tower ack`, `/tower base <branch>`, `/tower reload` | not validated |

The reason: a row disabled after the session started (or a profile reloaded with a stricter config)
must not make `/tower off` — the command a human needs to leave the mode — or an ordinary forwarded
instruction fail. Capability guards still run where the work happens: `tower_spawn`, planning and
merge/preflight evaluate their own preconditions, so the checks cannot be bypassed by entering the
mode first.

### Language of tool output

Machine-facing output is **English only**, regardless of the request locale:

- tool errors (`[tower:<code>] ...`), `nextAction`, blocker `detail` strings, `tower_status` /
  `tower_doctor` detail lines, and completion reports;
- anything that a script, a log search or another agent is expected to pattern-match.

Localized, human-facing copy lives in `locale/*.json` (component descriptions, UI labels) and is the
only translated surface. Two rules keep the split honest:

1. New detail/error strings are written in English even when the surrounding UI is Chinese; they are
   not added to `locale/*.json`.
2. A localized label never shadows a machine-readable cause. The row id, the error code and the
   English remedy phrase stay verbatim inside the message, so a grep for
   `disabled by component tower-tests` works in every locale.

`tower_status` and `tower_doctor` follow this policy: both print `disabled by component <id>` and the
English "enable the ... row in the plugin page and restart DSH" action, and neither interpolates a
translated label.
