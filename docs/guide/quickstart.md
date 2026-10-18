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
