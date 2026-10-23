# 0002 — One state.json is the mission persistence contract

- Date: 2026-10-23
- Status: Accepted
- Deciders: maintainer
- Supersedes: none

## Context

Mission state carries active missions, roster entries, reviews, findings, messages
and batches. The obvious alternative is one file per mission (or one directory
per mission), which would make every mission a small git-diffable record. Tower is
not a git-backed issue tracker: it mutates state from several tools on every
operation, under one process, and a crash between two file writes must not leave
missions half-valid.

## Decision

One `<git-common-dir>/dsh-tower/state.json` holds the active document. It is
read/written through one token-checked lock and one atomic temp+rename write with
a heartbeat-based stale window. Terminal missions whose worktree is gone are moved
out to `archive/<year>.json` files under the archive policy; that keeps `state.json`
bounded without changing the live contract. `modes.json` is a separate per-agent
mode store and follows the same atomic-write primitives.

## Consequences

- A mutation is one lock acquisition and one atomic write, so a reader never sees a
  half-applied mission graph.
- Cross-mission invariants (unique mission ids, dependencies, roster ownership,
  review binding) are checked in one place before the write.
- `state.json` is not line-diffable per mission. The board (`MISSIONS.md`), the
  read tools and the archive year files are the human- and diff-facing views.
- Archiving is a move, never a delete: an unreadable archive pauses archiving
  rather than losing the entries.
- Two writers are prevented by the lock, not by "please run one tower".

## Rejected alternatives

- **One JSON file per mission** — makes each mission diffable, but every command
  that touches several missions (plan, roster, batch, gate) must coordinate N
  files with no cross-file atomicity; a crash leaves a partial graph.
- **A database (SQLite or a bundled store)** — adds a native dependency to a plugin
  that must mount inside arbitrary host builds, and moves the schema migration
  problem out of a file that a user can inspect and back up.
- **Append-only event log as the source of truth** — good for audit, bad for the
  read path this plugin actually has: every status call would replay history, and
  compaction would become a second correctness problem.
- **Git-committed mission records** — would make Tower write to the user's history
  on every tool call, which the "never modify the main checkout" boundary refuses.
