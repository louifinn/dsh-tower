# dsh-tower

[![CI](https://github.com/louifinn/dsh-tower/actions/workflows/test.yml/badge.svg?branch=main)](https://github.com/louifinn/dsh-tower/actions/workflows/test.yml)
[![npm](https://img.shields.io/npm/v/dsh-tower.svg)](https://www.npmjs.com/package/dsh-tower)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[中文说明](README.md)

**Tower** is a multi-agent orchestration plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH). It turns one agent session into a small engineering team: the session acts as the *control tower*, worker agents do the implementation inside isolated Git worktrees, and nothing reaches your base branch without an independent review and a hard merge gate.

Tower mode and its mission/review workflow are inspired by the experimental **Tower mode in [Kimi Code](https://www.kimi.com/code)** by Moonshot AI. This is an independent implementation for DSH and is not affiliated with Moonshot AI; see [Acknowledgements](#acknowledgements).

The repository root **is** the DSH bundle: `package.json` declares `dsh.bundle.patch` and `cordis.patch.yml` lives at the root, as the DSH plugin specification expects.

## Features

- **Human-owned Tower mode.** `/tower` toggles a session-level stance that narrows the tool surface and injects the Tower protocol. `/tower on|off <instruction>` also forwards your instruction to the model in the same step.
- **Missions with real isolation.** Every mission gets its own branch and Git worktree; workers never touch your checkout.
- **Review-gated merges.** A reviewer bound to the current branch tip must submit a `clean` / `merge` verdict; the merge gate re-checks scope, staleness, task completion, review history, and worktree ownership before a `--no-ff` merge.
- **Durable coordination.** Roster, inbox, findings, reviews, and mission state are persisted under `.git/dsh-tower/`, so a restart does not lose the plan.
- **Safe by default.** While Tower mode is active, `create_goal`, `update_goal(resume)`, `todo_write`, the Team task board, and `spawn_teammate` are refused; a paused goal is never resumed automatically.
- **Traceable finding lifecycle.** `tower_findings` lists, reads, and moves findings through `open → triaged → fixed` / `wontfix` (and can reopen); only the tower or a worker may change state, while reviewers can only read.
- **Repository-level config.** Any repository can override review/merge/worktree/spawn policy in `<git-common-dir>/dsh-tower/config.json`; tool arguments override the repository layer, so no profile edit is needed per repository.
- **Stable error codes.** Tool failures carry a `[tower:<code>]` prefix (for example `mission-not-found`, `preset-missing`, `config-invalid`) so callers can branch deterministically.
- **Role enforcement and control.** Workers cannot complete/abandon a mission or widen its scope directly (completion goes through the `tower_complete` evidence gate); the tower can stop a runaway agent with `tower_interrupt`, and `tower_send(interrupt:true)` interrupts a running turn.
- **Workspace exclusivity and limits.** Optional `mode.workspaceLock` allows one Tower session per repository; `spawn.maxLiveWorkers`, `send.maxPerMinute` and roster stale flags bound concurrency and message bursts.
- **Hot reload.** In a profile with DSH HMR, `/tower reload`, `tower_reload` and `npm run dev:hmr` apply linked plugin changes without a restart; `plugin_manager` install/update already applies live.
- **Evidence gate and events.** Workers can record `checks` in `tower_complete` and `gates.requireChecks` can require them; every mutation emits `tower/*` events and refreshes `MISSIONS.md`.

## Requirements

- DeepSeek Harness `0.2.1-rc.2` (or a compatible newer build)
- Node.js 22 or newer
- Git (worktrees are created locally; no network access is required)

## Install

Install the published package into a DSH profile:

```bash
dsh plugin --profile web add dsh-tower
```

Inside DSH you can use the plugin manager with the same target:

```text
plugin_manager({ action: "install_bundle", target: "dsh-tower" })
```

For development, install from GitHub or link a local checkout:

```bash
dsh plugin --profile web add github:louifinn/dsh-tower
dsh plugin --profile <profile> add <absolute path to this repository>
```

The Host plugin is loaded when the DSH process starts, so **restart DSH after installing or updating**. Remove it with `remove_bundle` and the package name `dsh-tower`.

## Quick start

```text
/tower on

tower_init      repoRoot=D:\work\repo            # records the base (current branch by default)
tower_plan      repoRoot=D:\work\repo missions=[{"title":"Feature A","scope":["src/a/**"],"tasks":["implement","commit"],"kind":"build"}]
tower_spawn     repoRoot=D:\work\repo missionId=M1 role=worker
# the worker implements and commits in its worktree, calls tower_complete; its final report returns here
tower_spawn     repoRoot=D:\work\repo missionId=M1 role=reviewer
# the reviewer inspects read-only and calls tower_review (clean+merge, or p1-Nitems/p2-Nitems)
tower_preflight repoRoot=D:\work\repo missionId=M1    # expect no-review before review; ok:true after it
tower_merge     repoRoot=D:\work\repo missionId=M1
tower_teardown  repoRoot=D:\work\repo

/tower off
```

A small change usually takes one worker mission and one reviewer round. A full copy-paste example is in [docs/examples/first-mission.md](docs/examples/first-mission.md); per-tool parameters are in [docs/reference/tools.md](docs/reference/tools.md).

## Commands

| Input | Behavior |
|---|---|
| `/tower` | Enter Tower mode (stays on if already on) |
| `/tower on` | Enter or stay |
| `/tower on <instruction>` | Enter/stay **and** forward `<instruction>` as the next user message |
| `/tower off` | Leave Tower mode |
| `/tower off <instruction>` | Leave **and** forward `<instruction>` |
| `/tower <instruction>` | Ensure on, then forward `<instruction>` |

Image and file attachments are forwarded together with the instruction as one complete `UserMessage`.

## Configuration

```yaml
- id: tower
  name: 'dsh-tower'
  config:
    section: 'Optional legacy alias replacing the Tower-mode prompt text'
    allowAgentControl: true   # legacy alias for mode.allowAgentControl
    mode:
      allowAgentControl: true
      autoPauseGoal: true
      denyTools: [create_goal, todo_write, team_task_create, team_task_update, team_task_reopen, spawn_teammate]
    review:
      maxRoundsPerReviewer: 5
    merge:
      timeoutMs: 900000
    worktrees:
      root: ''                 # empty = <checkout parent>/.dsh-tower-worktrees/<hash>
    spawn:
      workerPreset: tower-worker
      reviewerPreset: tower-reviewer
      maxDepth: 1
```

- `mode.allowAgentControl` defaults to `false` in code; the bundled `cordis.patch.yml` enables it (`true`) so the model may enter/leave when the user intent or task state warrants it, always stating a reason.
- Repository-level config: put the same JSON shape in `<git-common-dir>/dsh-tower/config.json` (usually `.git/dsh-tower/config.json`) to override `review`/`merge`/`worktrees`/`spawn`. Precedence is code defaults < profile config < repository config < tool arguments. `mode.*` is session-scoped and only the profile layer controls it.
- Every key and default is in [docs/reference/config.md](docs/reference/config.md); unknown top-level keys are rejected so typos cannot silently disable security-relevant settings, while unknown keys inside a group are ignored. Tool error codes are in [docs/reference/errors.md](docs/reference/errors.md).

## Tools (20 core)

`tower_init` · `tower_plan` · `tower_mission` · `tower_status` · `tower_spawn` · `tower_roster` · `tower_adopt` · `tower_diff` · `tower_send` · `tower_inbox` · `tower_complete` · `tower_interrupt` · `tower_finding` · `tower_findings` · `tower_review` · `tower_preflight` · `tower_merge` · `tower_rebase` · `tower_teardown` · `tower_mode`

`tower_control` exists only when `allowAgentControl: true`; `tower_reload` is registered while `dev.hotReload` is on (default true) and returns `reload-unavailable` without an HMR service (so up to 22 tools). Mission-scoped tools also accept `id` as an alias for `missionId`; snake/camel spellings such as `task_done`/`taskDone` are both accepted.

## Safety and guardrails

- **No merge without a green gate.** `tower_preflight` is read-only and reports stable blocker codes; `tower_merge` refuses when any blocker remains.
- **Review is bound to a commit.** A moved tip reports `tip-moved` and requires a fresh review; reviewers use a read-only preset, and a branch change during review is rejected.
- **Scope enforcement.** A mission may only change files matched by its declared scope globs; `out-of-scope` blocks the merge.
- **Worktree ownership.** Dirty worktrees, a running worker, or a branch owned by a closed mission block teardown/merge.
- **Goal isolation.** Entering Tower mode pauses the active goal and records it; leaving does not resume it. Use `/tower off` and resume the goal yourself.

25 stable blocker/failure codes (including gate guards, `no-check-evidence`, and merge/rebase operation failures) — the complete list with triggers and fixes is in [docs/reference/blockers.md](docs/reference/blockers.md). Tool-level error codes are in [docs/reference/errors.md](docs/reference/errors.md); events are in [docs/reference/events.md](docs/reference/events.md).

## How it works

A mission moves through `planned → active → completed → merged` (or `blocked` / `paused` / `abandoned`). State lives in `<git-common-dir>/dsh-tower/`:

| Path | Contents |
|---|---|
| `.git/dsh-tower/state.json` | missions, roster, reviews, findings, inbox |
| `.git/dsh-tower/activity.jsonl` | append-only activity log |
| `<checkout parent>/.dsh-tower-worktrees/<hash>/<missionId>` | per-mission worktree |
| `$DSH_HOME/tower-mode/modes.json` | Tower mode state per agent/session |

Workers use the bundled `tower-worker` preset (writable worktree surface); reviewers use the separate read-only `tower-reviewer` preset and can only inspect (`tower_diff`) and submit `tower_review`. The reviewer records the branch tip at spawn; if the branch moves, the review is rejected. Neither preset can merge or spawn.

## Project layout

| Path | Contents |
|---|---|
| `package.json`, `cordis.patch.yml` | bundle manifest and loader patch (inserts the Host plugin and the `tower-worker` preset) |
| `index.js`, `lib/`, `worker.js`, `reviewer.js` | Host entry, protocol/config implementation, worker and reviewer preset policies |
| `skills.js`, `skills/` | bundled agent skills (worker protocol, review checklist, recovery playbook) |
| `docs/` | guides, reference, architecture, operations, FAQ and examples |
| `locale/`, `icon.svg` | localization and icon |
| `tests/` | pure-function, protocol end-to-end, and plugin-level tests; optional isolated Web-runtime scripts |
| `ui-bundle/` | optional Client widget (static `/tower` hint), not installed by default |
| `.github/workflows/test.yml` | CI running the offline suite on Node 22/24 |

## Development and testing

```bash
npm test        # node --test tests/*.test.mjs
```

Hot-reload development: `npm run dev:hmr` adds this checkout to the current profile's HMR watch roots
(one DSH restart); afterwards `/tower reload` or the automatic watcher applies `lib/` edits. See
[docs/guide/hot-reload.md](docs/guide/hot-reload.md).

The offline suite needs no DSH process and creates throwaway Git repositories in the OS temp directory. `tests/README.md` documents the isolated Web-runtime checks, model-driven acceptance, and the session-diagnostic scripts used while hardening the plugin.

## Documentation

- [docs/README.md](docs/README.md) — documentation index (new user / operator / maintainer paths)
- [Chinese docs](docs/zh/README.md) · [Quick start](docs/guide/quickstart.md) · [Install, upgrade and migration](docs/guide/install-upgrade-migration.md)
- [Tools reference](docs/reference/tools.md) · [Config reference](docs/reference/config.md) · [Blockers and failure codes](docs/reference/blockers.md) · [Error codes](docs/reference/errors.md) · [Events](docs/reference/events.md) · [Hot reload](docs/guide/hot-reload.md)
- [Architecture and state machine](docs/architecture/overview.md) · [Operations runbook](docs/operations/runbook.md) · [Security model](docs/operations/security.md)
- [FAQ](docs/faq.md) · [Examples](docs/examples/first-mission.md)

## Troubleshooting

- **The plugin does not appear after install/update.** Host plugins load at DSH startup; restart DSH. Confirm the entry point targets this repository root (the folder with `package.json` and `cordis.patch.yml`), not a subdirectory.
- **`tower_control` is missing.** The config `allowAgentControl` is `false`; set it to `true` and restart.
- **Merge is blocked.** Run `tower_preflight` and read the blocker codes above; `stale-base` means run `tower_rebase` first.
- **A mission branch is stale after base moved.** `tower_rebase` rebases inside the worktree; a clean conflict-free rebase waives re-review for the previous verdict.
- **A merge commit exists but `tower_merge` reported a failure.** Re-run `tower_merge`: it detects the landed merge commit (or a branch already contained in the base) and records it as reconciled instead of merging twice.
- **The repository runs a slow `pre-merge-commit` hook.** The merge timeout defaults to 15 minutes and can be raised per call with `tower_merge({ ..., timeoutMs: 900000 })`; hook output is buffered up to 64 MB. A hook failure returns `merge-hook-failed` (with `timeout: true` when it timed out) and leaves the repository clean for a retry.

## Contributing

Issues and pull requests are welcome. Please run `npm test` before opening a PR; see [CONTRIBUTING.md](CONTRIBUTING.md) for details. Security reports: please avoid opening a public issue with exploit details; open a minimal issue asking for a private channel.

## Acknowledgements

- **Kimi Code (Moonshot AI)** — the Tower mode concept, including human-owned activation, an isolated Git worktree per mission, and the review-gated merge protocol, is inspired by the experimental Tower mode in [Kimi Code](https://www.kimi.com/code) ([source](https://github.com/MoonshotAI/kimi-code)). This project re-implements those ideas on top of DeepSeek Harness services; it contains no Kimi Code source code and is not affiliated with or endorsed by Moonshot AI.
- **DeepSeek Harness** — for the plugin, tool, session, and subagent APIs this project is built on.

## License

MIT © Loui Finn

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
