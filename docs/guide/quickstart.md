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

## 4. Review

```
tower_spawn repoRoot=D:\work\repo missionId=M1 role=reviewer
```

Reviewers use the read-only `tower-reviewer` preset. They inspect `tower_diff` and submit
`tower_review`. A `clean` + `merge` verdict is required to merge.

## 5. Gate, merge, clean up

```
tower_preflight repoRoot=D:\work\repo missionId=M1
tower_merge     repoRoot=D:\work\repo missionId=M1
tower_teardown  repoRoot=D:\work\repo
```

`tower_preflight` before review is expected to report `no-review`; after a clean review it should be
`ok:true`. `tower_merge` refuses while blockers remain. `tower_teardown` removes merged/abandoned
worktrees and branches.

```
/tower off
```

## If something fails

Read the blocker code and use [the blocker reference](reference/blockers.md). The most common cases:
`stale-base` (run `tower_rebase`), `no-review` (spawn a reviewer), `merge-hook-failed` (retry, or raise
`timeoutMs`), `tip-moved` (the branch changed after review; review again).

A complete copy-paste example: [examples/first-mission.md](../examples/first-mission.md).
