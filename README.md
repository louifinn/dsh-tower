# dsh-tower

[![CI](https://github.com/louifinn/dsh-tower/actions/workflows/test.yml/badge.svg?branch=main)](https://github.com/louifinn/dsh-tower/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[中文说明](README.zh.md)

**Tower** is a multi-agent orchestration plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH). It turns one agent session into a small engineering team: the session acts as the *control tower*, worker agents do the implementation inside isolated Git worktrees, and nothing reaches your base branch without an independent review and a hard merge gate.

The repository root **is** the DSH bundle: `package.json` declares `dsh.bundle.patch` and `cordis.patch.yml` lives at the root, as the DSH plugin specification expects.

## Features

- **Human-owned Tower mode.** `/tower` toggles a session-level stance that narrows the tool surface and injects the Tower protocol. `/tower on|off <instruction>` also forwards your instruction to the model in the same step.
- **Missions with real isolation.** Every mission gets its own branch and Git worktree; workers never touch your checkout.
- **Review-gated merges.** A reviewer bound to the current branch tip must submit a `clean` / `merge` verdict; the merge gate re-checks scope, staleness, task completion, review history, and worktree ownership before a `--no-ff` merge.
- **Durable coordination.** Roster, inbox, findings, reviews, and mission state are persisted under `.git/dsh-tower/`, so a restart does not lose the plan.
- **Safe by default.** While Tower mode is active, `create_goal`, `update_goal(resume)`, `todo_write`, the Team task board, and `spawn_teammate` are refused; a paused goal is never resumed automatically.

## Requirements

- DeepSeek Harness `0.2.1-rc.2` (or a compatible newer build)
- Node.js 22 or newer
- Git (worktrees are created locally; no network access is required)

## Install

Install from GitHub (available now):

```bash
dsh plugin --profile web add github:louifinn/dsh-tower
```

The package is also published to npm as `dsh-tower`; while its first release is still in npm's
publish review, the command below becomes available as soon as the release is live:

```bash
dsh plugin --profile web add dsh-tower
```

Inside DSH you can use the plugin manager with either target:

```text
plugin_manager({ action: "install_bundle", target: "dsh-tower" })
```

For development, link a local checkout instead:

```bash
dsh plugin --profile <profile> add <absolute path to this repository>
```

The Host plugin is loaded when the DSH process starts, so **restart DSH after installing or updating**. Remove it with `remove_bundle` and the package name `dsh-tower`.

## Quick start

```
/tower on

tower_init        <repoRoot>
tower_plan        <repoRoot> missions=[...]
tower_spawn       <repoRoot> missionId=M1 role=worker
# worker implements and reports completion
tower_preflight   <repoRoot> missionId=M1    # must be green before merging
tower_spawn       <repoRoot> missionId=M1 role=reviewer
tower_review      ...                        # reviewer submits verdict
tower_preflight   <repoRoot> missionId=M1
tower_merge       <repoRoot> missionId=M1
tower_teardown    <repoRoot>

/tower off
```

A typical run takes one worker mission and one reviewer round for a small change.

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
    section: 'Optional replacement for the Tower-mode system prompt text'
    allowAgentControl: true   # true registers tower_control; false makes the mode human-only
```

- `allowAgentControl` defaults to `false` in code. The bundled `cordis.patch.yml` enables it (`true`) so the model may enter/leave Tower mode when the user intent or task state clearly warrants it, always stating a reason.
- When disabled, only the human can change the mode.

## Tools (17)

`tower_init` · `tower_plan` · `tower_mission` · `tower_status` · `tower_spawn` · `tower_roster` · `tower_adopt` · `tower_send` · `tower_inbox` · `tower_complete` · `tower_finding` · `tower_review` · `tower_preflight` · `tower_merge` · `tower_rebase` · `tower_teardown` · `tower_mode`

`tower_control` exists only when `allowAgentControl: true`.

## Safety and guardrails

- **No merge without a green gate.** `tower_preflight` is read-only and reports stable blocker codes; `tower_merge` refuses when any blocker remains.
- **Review is bound to a commit.** If the branch tip moves after a review, the gate reports `tip-moved`; re-review is required (a clean rebase waiver is the only exception).
- **Scope enforcement.** A mission may only change files matched by its declared scope globs; `out-of-scope` blocks the merge.
- **Worktree ownership.** Dirty worktrees, a running worker, or a branch owned by a closed mission block teardown/merge.
- **Goal isolation.** Entering Tower mode pauses the active goal and records it; leaving does not resume it. Use `/tower off` and resume the goal yourself.

The 13 stable blocker codes are: `branch-missing`, `deps-unmerged`, `read-only-survey`, `stale-base`, `no-review`, `review-hold`, `not-clean`, `review-not-approved`, `tip-moved`, `review-mission-mismatch`, `out-of-scope`, `base-dirty`, `branch-owned-by-closed-missions` (plus mission/worker guards).

## How it works

A mission moves through `planned → active → completed → merged` (or `blocked` / `paused` / `abandoned`). State lives in `<git-common-dir>/dsh-tower/`:

| Path | Contents |
|---|---|
| `.git/dsh-tower/state.json` | missions, roster, reviews, findings, inbox |
| `.git/dsh-tower/activity.jsonl` | append-only activity log |
| `<checkout parent>/.dsh-tower-worktrees/<hash>/<missionId>` | per-mission worktree |
| `$DSH_HOME/tower-mode/modes.json` | Tower mode state per agent/session |

Workers and reviewers are ordinary DSH subagents started with the bundled `tower-worker` preset; their tools are restricted to the mission surface (filesystem, shell, and Tower protocol tools), never merge/spawn.

## Project layout

| Path | Contents |
|---|---|
| `package.json`, `cordis.patch.yml` | bundle manifest and loader patch (inserts the Host plugin and the `tower-worker` preset) |
| `index.js`, `lib/`, `worker.js` | Host entry, protocol implementation, worker preset policy |
| `locale/`, `icon.svg` | localization and icon |
| `tests/` | pure-function, protocol end-to-end, and plugin-level tests; optional isolated Web-runtime scripts |
| `ui-bundle/` | optional Client widget (static `/tower` hint), not installed by default |
| `.github/workflows/test.yml` | CI running the offline suite on Node 22/24 |

## Development and testing

```bash
npm test        # node --test tests/*.test.mjs
```

The offline suite needs no DSH process and creates throwaway Git repositories in the OS temp directory. `tests/README.md` documents the isolated Web-runtime checks, model-driven acceptance, and the session-diagnostic scripts used while hardening the plugin.

## Troubleshooting

- **The plugin does not appear after install/update.** Host plugins load at DSH startup; restart DSH. Confirm the entry point targets this repository root (the folder with `package.json` and `cordis.patch.yml`), not a subdirectory.
- **`tower_control` is missing.** The config `allowAgentControl` is `false`; set it to `true` and restart.
- **Merge is blocked.** Run `tower_preflight` and read the blocker codes above; `stale-base` means run `tower_rebase` first.
- **A mission branch is stale after base moved.** `tower_rebase` rebases inside the worktree; a clean conflict-free rebase waives re-review for the previous verdict.

## Contributing

Issues and pull requests are welcome. Please run `npm test` before opening a PR; see [CONTRIBUTING.md](CONTRIBUTING.md) for details. Security reports: please avoid opening a public issue with exploit details; open a minimal issue asking for a private channel.

## License

MIT © Loui Finn

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
