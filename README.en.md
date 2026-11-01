# dsh-tower

[![CI](https://github.com/louifinn/dsh-tower/actions/workflows/test.yml/badge.svg?branch=main)](https://github.com/louifinn/dsh-tower/actions/workflows/test.yml)
[![npm](https://img.shields.io/npm/v/dsh-tower.svg)](https://www.npmjs.com/package/dsh-tower)
[![Listed on dsh-plugin.org](https://dsh-plugin.org/badges/listed.svg)](https://dsh-plugin.org/plugins/louifinn/dsh-tower)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[中文说明](README.md)

**Tower** is a multi-agent orchestration plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH). It turns one agent session into a small engineering team: the session acts as the *control tower*, worker agents do the implementation inside isolated Git worktrees, and changes pass scope/merge gates into the base branch; independent review can be enforced by config.

Tower mode and its mission/review workflow are inspired by the experimental **Tower mode in [Kimi Code](https://www.kimi.com/code)** by Moonshot AI. This is an independent implementation for DSH and is not affiliated with Moonshot AI; see [Acknowledgements](#acknowledgements).

The repository root **is** the DSH bundle: `package.json` declares `dsh.bundle.patch` and `cordis.patch.yml` lives at the root, as the DSH plugin specification expects.

## Features

- **Configurable Tower mode.** `/tower` toggles a session-level stance that narrows the tool surface and injects the Tower protocol. `/tower on|off <instruction>` also forwards your instruction to the model in the same step. By default the model may also enter/leave with `tower_control` and a concrete reason; set `mode.allowAgentControl:false` for human-only control.
- **Missions with real isolation.** Every mission gets its own branch and Git worktree; workers never touch your checkout.
- **Review-gated merges.** The review policy is one tri-state control on the plugin page: `off`, `optional` (the default) or `required` (`review.mode` in config). With `required`, a reviewer bound to the current branch tip must submit a `clean` / `merge` verdict before merge; the merge gate re-checks scope, staleness, task completion, review history, and worktree ownership before a `--no-ff` merge. Independent review is optional by default; use `reviewPolicy:"none"` + reason plus `gates.allowReviewExemption:true` for a single mission when the policy is required. Multi-route review is recorded per round: while a non-clean round keeps the mission `active`, a later reviewer may still submit its verdict for the same reviewed tip and it appends to that round. A completed `survey` dependency satisfies the dependency gate (a build dependency still must be merged). Upgrade note: the old boolean review toggle is a one-release alias; the mapping is in [install, upgrade and migration](docs/guide/install-upgrade-migration.md).
- **Durable coordination.** Roster, inbox, findings, reviews, and mission state are persisted under `.git/dsh-tower/`, so a restart does not lose the plan.
- **Bounded state growth.** Terminal missions whose worktree is gone move to `.git/dsh-tower/archive/` once `archive.afterDays`/`archive.maxMissions` says so, keeping their tasks, reviews, findings and completion report; mutations then rewrite only active work. `tower_status includeArchived` lists compact archived summaries, and `tower_doctor` reports archive size, count and policy.
- **Safe by default.** While Tower mode is active, `create_goal`, `update_goal(resume)`, `todo_write`, the Team task board, and `spawn_teammate` are refused; a paused goal is never resumed automatically.
- **Traceable finding lifecycle.** `tower_findings` lists, reads, and moves findings through `open → triaged → fixed` / `wontfix` (and can reopen); only the tower or a worker may change state, while reviewers can only read.
- **Repository-level config.** Any repository can override review/merge/worktree/spawn policy in `<git-common-dir>/dsh-tower/config.json`; tool arguments override the repository layer, so no profile edit is needed per repository.
- **Stable error codes.** Tool failures carry a `[tower:<code>]` prefix (for example `mission-not-found`, `preset-missing`, `config-invalid`) so callers can branch deterministically.
- **Role enforcement and control.** Workers cannot complete/abandon a mission or widen its scope directly (completion goes through the `tower_complete` evidence gate); the tower can stop a runaway agent with `tower_interrupt`, and `tower_send(interrupt:true)` interrupts a running turn.
- **Workspace exclusivity and limits.** Optional `mode.workspaceLock` allows one Tower session per repository; `spawn.maxLiveWorkers`, `send.maxPerMinute` and roster stale flags bound concurrency and message bursts.
- **2.1 verification and operations.** `tower_test` runs the worktree's `tower.testDiscovery` (TAP/json-array, admission at spawn or complete), `tower_doctor` is a read-only health contract, `tower_batch` closes finite evidence batches, `tower_resource` manages advisory leases, and `tower_import_legacy`/`tower_legacy_map` import old snapshots and audit-map ids. Adds `worker-stale`, test gates, plan/Tower mutual exclusion, `workspaceLockScope`, `docs.boardLocation` and delivery acknowledgements.
- **Hot reload.** In a profile with DSH HMR, `/tower reload`, `tower_reload` and `npm run dev:hmr` apply linked plugin changes without a restart; `plugin_manager` install/update already applies live.
- **Evidence gate and events.** Workers can record `checks` in `tower_complete` and `gates.requireChecks` can require them; every mutation emits `tower/*` events and refreshes `MISSIONS.md`.

## When to use Tower

Tower is a **delivery protocol for changes to a Git repository**, not the default answer for every multi-agent task. It fits when:

- a feature or refactor splits into 2–8 missions with clear scopes that can be reviewed independently;
- ordering matters (migrations, dependencies, branch freshness, scope reservations);
- the repository is sensitive or release-bound, and you need an auditable merge plus test evidence (enable independent review when required);
- work spans context compaction, restarts, or multiple days and must be recoverable from local state;
- "done" means tasks + tests (and optionally an independent review), not just a confident message in chat.

It is a poor fit for one-file or one-line hotfixes, requirements still being discovered, open-ended research, many tiny independent tasks, interactive UI pairing, or cross-repository work. Rule of thumb: **if you would not open a PR for it, Tower is probably too heavy.**

How it differs (full guide: [When to use Tower](docs/guide/scenarios-and-philosophy.md)):

- **Ordinary parallel subagents**: cheap and flexible for read-only exploration or trying approaches; no worktree, review, or merge gate.
- **Agent Teams**: shared task board and peer collaboration for design, research, and cross-cutting decisions; integration is usually human, with no hard Git gate.
- **Ralph loop**: fresh agents retry one objective, good for iterative search/repair; no mission contract or merge review.
- **Workflow orchestration**: scripted high fan-out/pipelines for audits, batch analysis, and verification; no branch isolation or merge gate.
- **Tower**: a few missions + isolated writers + optional independent review + evidence + a merge gate, for "we have decided; land it safely".

Tower mode refuses Team/Workflow/Ralph/ordinary subagent tools and clears plan mode so two orchestration protocols do not drive one session. Compose by phase instead: use Workflow/Team to analyze and decide, then Tower to execute the repository change.

## Requirements

- DeepSeek Harness `0.2.1-rc.2` (see [COMPATIBILITY.md](COMPATIBILITY.md) for the verified host builds)
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

The optional Web UI ships inside the npm package at `ui-bundle/`: for an npm install the target is
`<profile>/node_modules/dsh-tower/ui-bundle`, or `ui-bundle/` in a source checkout. Install it with
`plugin_manager({action:"install_bundle", target:"<that directory>"})`, restart DSH, then refresh the page.

### Known conflicts

Do not install `dsh-plugins-tower` (third-party) alongside this package. Its loader row also uses
`name: dsh-tower`, so it resolves to this package: this package may load twice or the other package
never runs. `tower_doctor` reports this as `loader-conflicts`; uninstall the conflicting package and
restart DSH.

## Quick start

```text
/tower on

tower_init      repoRoot=D:\work\repo            # records the base (current branch by default)
tower_plan      repoRoot=D:\work\repo missions=[{"title":"Feature A","scope":["src/a/**"],"tasks":["implement","commit"],"kind":"build"}]
tower_spawn     repoRoot=D:\work\repo missionId=M1 role=worker
# the worker implements and commits in its worktree, calls tower_complete; its final report returns here
# Optional: set review.mode:required first if you need mandatory independent review
tower_spawn     repoRoot=D:\work\repo missionId=M1 role=reviewer
# the reviewer inspects read-only and calls tower_review (clean+merge, or p1-Nitems/p2-Nitems)
tower_preflight repoRoot=D:\work\repo missionId=M1    # review optional by default (review.mode:optional); with review.mode:required expect no-review before review and ok:true after
tower_merge     repoRoot=D:\work\repo missionId=M1
tower_teardown  repoRoot=D:\work\repo

/tower off
```

A small change usually takes one worker mission; add one reviewer round when independent review is required. A full copy-paste example is in [docs/examples/first-mission.md](docs/examples/first-mission.md); per-tool parameters are in [docs/reference/tools.md](docs/reference/tools.md).

## Commands

| Input | Behavior |
|---|---|
| `/tower` | Enter Tower mode (stays on if already on) |
| `/tower on` | Enter or stay |
| `/tower on <instruction>` | Enter/stay **and** forward `<instruction>` as the next user message |
| `/tower off` | Leave Tower mode |
| `/tower off <instruction>` | Leave **and** forward `<instruction>` |
| `/tower ack` | Record human acknowledgement for `mode.requireHumanAckOnFirstEntry` |
| `/tower <instruction>` | Ensure on, then forward `<instruction>` |

Image and file attachments are forwarded together with the instruction as one complete `UserMessage`.

## Component model

The bundle ships a **mandatory host anchor plus individually switchable optional
rows** (#121): `cordis.patch.yml` inserts a top-level `tower` group that mounts
the Host plugin and the mandatory `preset-tower-worker`, then the optional
components `tower-skills`, `tower-batch`, `tower-import`, `tower-leases`,
`tower-tests`, `tower-hmr` (shipped off) and `preset-tower-reviewer`. Turn a row
off from the Plugins page and exactly that capability goes away; the mode, the
planning tools, `tower_status`, and the remaining tools keep working.

Mode entry and `tower_plan` validate the required presets before work starts. The
worker preset is mandatory; the reviewer preset is required only when
`review.mode` is `required`, so the reviewer row may be off while the policy is
`off` or `optional` and is locked with an explanatory `preset-missing` error when
the policy is `required`. `tower-tests` off with `gates.requireTests:true` is
refused the same way. `tower_doctor` and `tower_recover` are not components and
have no config key: they are registered for every configuration (#122).

[Principle 11](PRINCIPLES.md) and
[ADR 0005](docs/adr/0005-component-surface.md) say a component may exist only for
a capability whose off state leaves the rest intact; the host, health, recovery
and merge-gate capabilities are never switches. The review policy is the one
tri-state configuration control (off/optional/required), not a row. The per-key
answer is the generated [component surface](docs/reference/component-surface.md),
enforced by `npm run docs:check:components`.

## Configuration

```yaml
- id: tower-host
  name: 'dsh-tower'
  config:
    section: 'Optional legacy alias replacing the Tower-mode prompt text'
    allowAgentControl: true   # legacy alias for mode.allowAgentControl
    mode:
      allowAgentControl: true
      autoPauseGoal: true
      denyTools: [create_goal, todo_write, team_task_create, team_task_update, team_task_reopen, spawn_teammate]
    review:
      mode: optional            # one tri-state control: off, optional (default) or required
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

- `mode.allowAgentControl` defaults to `true` in code; the bundled `cordis.patch.yml` also sets it explicitly to `true` so the model may enter/leave when the user intent or task state warrants it, always stating a reason. Set it to `false` for human-only control. The bundled patch also enables `mode.workspaceLock` (single-active tower), `send.interruptDefault`, `init.autoGitInit`, and sets `spawn.staleMs` to 15s.
- `/tower base <branch>` records a session-level init base preference; `/tower on` clears an active plan mode (`mode.planModePolicy:"refuse"` instead refuses entry), keeping plan and Tower mutually exclusive.
- Repository-level config: put the same JSON shape in `<git-common-dir>/dsh-tower/config.json` (usually `.git/dsh-tower/config.json`) to override `review`/`merge`/`worktrees`/`spawn`. Precedence is code defaults < profile config < repository config < tool arguments. `mode.*` is session-scoped and only the profile layer controls it.
- Every key and default is in [docs/reference/config.md](docs/reference/config.md); unknown keys are rejected (top-level and inside a group) so typos cannot silently disable security-relevant settings. The three review modes, where the plugin-page control lives, and the one-release alias migration are in [install, upgrade and migration](docs/guide/install-upgrade-migration.md). Tool error codes are in [docs/reference/errors.md](docs/reference/errors.md).

## Tools (29: 22 core + 7 optional)

`tower_init` · `tower_plan` · `tower_mission` · `tower_status` · `tower_spawn` · `tower_roster` · `tower_adopt` · `tower_diff` · `tower_send` · `tower_inbox` · `tower_complete` · `tower_interrupt` · `tower_finding` · `tower_findings` · `tower_review` · `tower_preflight` · `tower_merge` · `tower_rebase` · `tower_teardown` · `tower_mode` · `tower_doctor` · `tower_recover` · `tower_test` · `tower_batch` · `tower_resource` · `tower_import_legacy` · `tower_legacy_map`

The list above is the 22 core tools plus 5 of the component-owned optional tools. `tower_control` is the sixth optional tool, registered by default (`allowAgentControl:true`); set it to `false` to disable it. `tower_reload` is the seventh, registered only while the `tower-hmr` component row is on (shipped off) and returning `reload-unavailable` without an HMR service (so up to 29 tools: 22 core + 7 optional). `tower_doctor` and `tower_recover` are core: they are registered for every configuration (#122). Mission-scoped tools also accept `id` as an alias for `missionId`; snake/camel spellings such as `task_done`/`taskDone` are both accepted.

## Safety and guardrails

- **No merge without a green gate.** `tower_preflight` is read-only and reports stable blocker codes; `tower_merge` refuses when any blocker remains.
- **Review is bound to a commit when required.** With `review.mode:required`, a moved tip reports `tip-moved` and requires a fresh review; reviewers use a read-only preset, and a branch change during review is rejected. `off` is a documented mode that removes `tower_review`; `optional` records reviews but never blocks a merge.
- **Scope enforcement.** A mission may only change files matched by its declared scope globs; `out-of-scope` blocks the merge.
- **Worktree ownership.** Dirty worktrees, a running worker, or a branch owned by a closed mission block teardown/merge.
- **Goal isolation.** Entering Tower mode pauses the active goal and records it; leaving does not resume it. Use `/tower off` and resume the goal yourself.

32 stable blocker/failure codes (including gate guards, `no-check-evidence`, `worker-stale`, test gates, and merge/rebase operation failures) — the complete list with triggers and fixes is in [docs/reference/blockers.md](docs/reference/blockers.md). Tool-level error codes are in [docs/reference/errors.md](docs/reference/errors.md); events are in [docs/reference/events.md](docs/reference/events.md).

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
| `package.json`, `cordis.patch.yml` | bundle manifest and loader patch (a mandatory `tower` host group plus the optional capability rows) |
| `index.js`, `host/`, `adapters/`, `app/`, `domain/`, `ports/`, `tools/`, `worker.js`, `reviewer.js` | Host entry; `domain/` pure core; `ports/` contracts; `adapters/` the only I/O; `app/` use cases; `host/` composition root and session glue; `tools/` one handler per tool; worker and reviewer preset policies |
| `skills.js`, `skills/` | bundled agent skills (worker protocol, review checklist, recovery playbook) |
| `docs/` | guides, reference, architecture, operations, FAQ and examples |
| `locale/`, `icon.svg` | localization and icon |
| `tests/` | pure-function, protocol end-to-end, and plugin-level tests; optional isolated Web-runtime scripts |
| `ui-bundle/` | optional Client widget (Tower tool cards, persistent Tower-mode chip, mode-aware denied rows, dock summary, transient overlay strip), not installed by default |
| `.github/workflows/test.yml` | CI running the offline suite on Node 22/24 (Ubuntu) and Node 22 (Windows), the release and coverage checks, and the Node 22 mount smoke and seeded fixtures |

## Development and testing

```bash
npm test        # node --test tests/*.test.mjs
```

Hot-reload development: `npm run dev:hmr` adds this checkout to the current profile's HMR watch roots
(one DSH restart); afterwards `/tower reload` or the automatic watcher applies `host/`, `adapters/`, `app/` and `domain/` edits. See
[docs/guide/hot-reload.md](docs/guide/hot-reload.md).

The offline suite needs no DSH process and creates throwaway Git repositories in the OS temp directory. `tests/README.md` documents the isolated Web-runtime checks, model-driven acceptance, and the session-diagnostic scripts used while hardening the plugin.

## What CI proves

Every push and PR runs the same set of jobs; each job backs one checkable claim instead of a README promise.

| Job | Claim | Evidence |
|---|---|---|
| `test (22)`, `test (24)` (Ubuntu) | the offline suite, documentation consistency, generated references, the published file list, architecture, types, and domain purity all hold | `npm test`, `npm run docs:check`, the five `docs:check:generated*` checks (including the generated type vocabulary), `pack:check`, `architecture:check`, `types:coverage`, `types:strict:check`, `types:check`, `domain:check` |
| `test (22, windows)` (`windows-latest`, not required) | the same offline suite and offline gates hold on a real Windows filesystem, so path casing, the `pwsh` shell, and the rename/unlink retries are measured instead of assumed | `npm test` plus the same offline gates as Ubuntu (no release/coverage) |
| `test`'s `Coverage (Node 22)` step | coverage is actually measured in CI (reported only: no threshold, no badge) | `npm run test:coverage` |
| `test`'s `Release check` step (Node 22) | a tag is a claim: the version moved past the previous version tag, a pushed tag is `v<version>`, and the changelog carries release content | `npm run release:check` |
| `mount` (Node 22) | the packed tarball, added through the plugin CLI to a throwaway profile, mounts in the real loader and registers the surface the bundle claims | `npm run smoke:mount` |
| `mount-fixtures` (Node 22, not required) | the mount smoke still goes red for the right seeded reasons (a renamed tool id, a removed skills section), with one cached host install shared by all runs | `npm run smoke:fixtures -- --host-dir <cached host>` |
| `live (<pinned host build>)` (nightly/manual, not required) | the browser live suite still drives a real Web runtime on the pinned host-version matrix; push/PR runs only the browserless environment and resolution check | nightly runs `npm run test:live -- --script nightly`; push runs `npm run test:live -- --check` |

The `test` matrix pins each leg's context string through `matrix.name`: `test (22)`, `test (24)` and the new `test (22, windows)`. The first two are `main`'s required checks and keep their exact names; adding an `os` matrix key without an explicit name would rename them to `test (22, ubuntu-latest)`, and protected `main` would wait for a context that never reports. The Windows leg is Node 22 only and runs the offline suite and offline gates (no browser, no live suite, no release/coverage), in parallel with the existing jobs, so it does not extend the critical path. It is not a required context yet: making it green is the acceptance for #86, while adding it to the protection setting is a human step in #94.

The live suite downloads a browser and boots a real host, so it is out of push/PR: it runs on a nightly `schedule` (also `workflow_dispatch`) on a pinned host-version matrix, and its first output line prints the resolved `DSH_HOME` and host version. Push keeps only `--check` (environment + Playwright resolution, no browser). Playwright is pinned by `tests/live/package-lock.json`; the root `npm ci` downloads no browsers.

`tests/platform.test.mjs` injects `platform`/`rename`/`unlink` so both the win32 and POSIX branches are asserted on any OS; the only case that needs a real Windows filesystem (renaming over an open destination) is counted as `# SKIP` on Linux (`tests 11`, `skipped 1`), never silently absent. There is no macOS runner: macOS follows the same POSIX branch as Linux, which is a #86 non-goal.

`mount` asserts the throwaway profile's **loaded surface**, never the text of `cordis.patch.yml`: 28 `tower_*` tools in the shipped profile (27 `tools/*.js` modules plus `tower_mode` / `tower_control`, minus `tower_reload` because `tower-hmr` ships off; 29 with every optional capability row on), the 3 bundled skills, both the `tower-worker` and `tower-reviewer` presets, the `/tower` command, one top-level `tower` host group, and the optional top-level rows (`tower-hmr` is shipped off). It calls no model and opens no browser. Measured on the maintainer's Windows machine: about 100 seconds on a cold host (install included) and about 85 seconds with a cached host; the CI step allows 3 minutes (`timeout-minutes: 3`) inside the 5-minute `mount` job. A red run prints the resolved profile path, the host build, the loaded counts, and every unmet claim.

The host build is pinned in exactly one place, `scripts/mount-smoke/host.json`; a unit test keeps the newest `COMPATIBILITY.md` row equal to it, so a release never retypes it. `npm run smoke:fixtures` proves the smoke still fails for the right seeded reasons (a renamed tool id, a removed skills section). CI runs it as the non-required `mount-fixtures` job, where the control and both seeds share one cached host install through `--host-dir` (about 2 minutes warm here).

## Documentation

- [docs/README.md](docs/README.md) — documentation index (new user / operator / maintainer paths)
- [Chinese docs](docs/zh/README.md) · [Quick start](docs/guide/quickstart.md) · [When to use Tower](docs/guide/scenarios-and-philosophy.md) · [Install, upgrade and migration](docs/guide/install-upgrade-migration.md)
- [Tools reference](docs/reference/tools.md) · [Config reference](docs/reference/config.md) · [Blockers and failure codes](docs/reference/blockers.md) · [Error codes](docs/reference/errors.md) · [Events](docs/reference/events.md) · [Testing](docs/reference/testing.md) · [Batches/leases/legacy](docs/reference/operations.md) · [Doctor](docs/reference/doctor.md) · [Hot reload](docs/guide/hot-reload.md)
- [Architecture and state machine](docs/architecture/overview.md) · [Operations runbook](docs/operations/runbook.md) · [Security model](docs/operations/security.md)
- [FAQ](docs/faq.md) · [Examples](docs/examples/first-mission.md)

## Troubleshooting

- **The plugin does not appear after install/update.** Host plugins load at DSH startup; restart DSH. Confirm the entry point targets this repository root (the folder with `package.json` and `cordis.patch.yml`), not a subdirectory.
- **`tower_control` is missing.** The config sets `allowAgentControl:false`; set it back to `true` and restart.
- **Merge is blocked.** Run `tower_preflight` and read the blocker codes above; `stale-base` means run `tower_rebase` first.
- **A mission branch is stale after base moved.** `tower_rebase` rebases inside the worktree; a clean conflict-free rebase waives re-review for the previous verdict.
- **A merge commit exists but `tower_merge` reported a failure.** Re-run `tower_merge`: it detects the landed merge commit (or a branch already contained in the base) and records it as reconciled instead of merging twice.
- **The repository runs a slow `pre-merge-commit` hook.** The merge timeout defaults to 15 minutes and can be raised per call with `tower_merge({ ..., timeoutMs: 900000 })`; hook output is buffered up to 64 MB. A hook failure returns `merge-hook-failed` (with `timeout: true` when it timed out) and leaves the repository clean for a retry.

## Contributing

Issues and pull requests are welcome. Please run `npm test` before opening a PR; see [CONTRIBUTING.md](CONTRIBUTING.md) for details. Security reports: please avoid opening a public issue with exploit details; open a minimal issue asking for a private channel.

## Acknowledgements

- **Kimi Code (Moonshot AI)** — the Tower mode concept, including an explicit session-level mode switch, an isolated Git worktree per mission, and the review-gated merge protocol, is inspired by the experimental Tower mode in [Kimi Code](https://www.kimi.com/code) ([source](https://github.com/MoonshotAI/kimi-code)). This project re-implements those ideas on top of DeepSeek Harness services; it contains no Kimi Code source code and is not affiliated with or endorsed by Moonshot AI.
- **DeepSeek Harness** — for the plugin, tool, session, and subagent APIs this project is built on.

## License

MIT © Loui Finn

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
