# Config reference

Every key is optional; defaults reproduce the shipped behavior. Unknown top-level keys are rejected.
`section` and `allowAgentControl` are legacy aliases for `mode.promptSection` and
`mode.allowAgentControl`. A legacy alias only fills a gap: when both forms are set, the canonical
`mode.*` key wins.

Two component-shaped switches left the config form (#133/#135): `docs.board` is now the `tower-board`
component row and `archive.enabled` is now the `tower-archive` component row. A config that still sets
either one fails with `config-unknown-key` and an upgrade note naming the replacing row; the tuning
keys (`docs.boardLocation`, `archive.afterDays`, `archive.maxMissions`) stay here.

## Layers and precedence

Lowest precedence first:

1. code defaults (the generated [Config reference](config.generated.md)),
2. profile config (the Cordis patch that mounts `dsh-tower` passes it to `apply()`),
3. repository config at `<git-common-dir>/dsh-tower/config.json` (usually `.git/dsh-tower/config.json`),
4. per-call tool arguments such as `worktreeRoot` and `timeoutMs`.

The repository layer is read every time a Tower tool opens a repository, so a repository can tune
review, merge, worktree and spawn policy without editing the profile. It uses the same JSON shape as
the profile config (the same groups and the legacy aliases) and is merged group by group: repo keys
win, profile keys survive when the repo does not set them. `tower_inspect` with `view: "status"` reports
`config.path` and `config.repoConfigPresent`.

```json
{
  "review": { "mode": "required", "maxRoundsPerReviewer": 3 },
  "merge": { "timeoutMs": 1800000 },
  "worktrees": { "root": "D:/tower-worktrees" },
  "spawn": { "reviewerPreset": "tower-reviewer", "maxDepth": 2 }
}
```

`review.mode` is the review policy: `off`, `optional` or `required`. The 2.6-era boolean alias
`review.requireReview` was physically removed in 2.8.0: a profile or repository config that still sets
it is rejected with `config-unknown-key`, and the error names `review.mode` plus the mapping (`true` →
`required`, `false` → `optional`) as the upgrade remedy. There is no second review key to keep
consistent any more. A repository layer is resolved on its own: it may relax review, but a profile
with `review.mode:off` never registered `tower_review`, so a repository cannot raise its own mode.

The Plugins-page control shows the policy exactly as the runtime resolves it: `review.mode` decides,
and an unset mode displays Optional (the default). Saving a choice writes only `review.mode` in the
same profile patch, so there is no deprecated alias to normalize.

The same three choices are available on the Plugins page, in the `dsh-tower` configuration
section: **Off**, **Optional** (the default) and **Required**, each with a one-line description of
its effect. That control writes the profile config through the Host settings form, so the accepted
value is reflected on the page without a manual file edit.

One live change cannot rebuild the mounted tool surface: a profile that started with review off did
not register `tower_review`. Switching to Optional or Required through the page immediately changes
the merge gate, but the review tool itself appears only after a restart (or a profile reload); the
control states that after such a save.

The `mode.*` group is session-scoped, not repository-scoped: it is accepted in the repository file
for schema compatibility but only the profile config controls the Tower-mode prompt and the
model-controlled toggle. A malformed file, a non-object value, unknown top-level keys, or a value that
violates the declared schema (for example `merge.timeoutMs` below 1000) fail with the stable
`config-invalid` / `config-unknown-key` tool error codes.

## All keys and defaults

The key list, each resolved default and the one-line meaning are generated from
`domain/config/schema.js` into [Config reference (generated)](config.generated.md). That page is the
single source for this information: add or change a key and its `.description()` in the schema, then
regenerate with `npm run docs:generate:config`. `npm run docs:check:generated:config` fails when the
generated page drifts, when a key or default is missing from it, or when this page grows a per-key
default table again.

The shipped `cordis.patch.yml` overrides two code defaults: `init.autoGitInit` and
`mode.workspaceLock` are `true` in the bundled patch. It also pins `send.interruptDefault` to
`false`, so a plain `tower_send` never stops a running agent; pass `interrupt:true` explicitly to
interrupt. Every other value in the generated page is what the resolver returns before repository
config.

`spawn.nodeModules` controls dependency visibility in a provisioned worktree (#218). It defaults to
`none`: the worktree has no `node_modules`, so dependency-installing or dependency-checking commands
cannot run there. `link` makes `tower_spawn` create `<worktree>/node_modules` as a junction to the
baseline checkout's installed `node_modules` before the roster reservation commits, and records
`{target, path, createdAt}` on `mission.worktree.nodeModulesLink` and the roster row. The target must
already exist: a missing target refuses the spawn with `invalid-argument` and a remedy, and an
existing unrecorded path is refused rather than overwritten. Teardown unlinks only the recorded link
(never its target or any directory), and `tower_inspect({view:"doctor"})` reports a dangling,
missing, replaced or unrecorded link under the `worktree-links` check. Because the link resolves to
the baseline install, the worktree sees the same dependency versions without a second install; a
worker that must install its own dependencies should keep `none`.

`spawn.preflightTimeoutMs` bounds the whole `tower_spawn` pre-flight with one deadline (#237): the
queue for the repository plus every read and write the spawn performs up to the roster reservation
committing — the descendant catalog, the roster, the ownership check, the preset list, provisioning
and test admission. It is not a per-await timeout, so a hundred fast reads share the same budget as
one slow one; the default is 30000 and both a floor (`1000`) and a ceiling (`600000`) refuse a bound
that cannot protect a call. When the deadline expires the call fails with
`[tower:spawn-unavailable]` and `details: {phase, elapsedMs, rollback}`, where `phase` is one of the
frozen names in `SPAWN_PREFLIGHT_PHASES` (`queue`, `open`, `resolve`, `observe`, `roster`,
`ownership`, `services`, `provision`, `discovery`, `reserve`, `activate`, `record`). The deadline
stops the pre-flight rather than just returning early: the writes it had already made are released
before the failure is returned — the roster reservation it wrote, the worktree it created, a detached
sandbox — and `details.rollback` reports each as released, removed, `none` or, when a step could not
be undone, `kept` with the path and the reason. A worktree the mission already owned before the call
is never removed; a child that was already started is never reported as unstarted. A reviewer is the
case that reads oddly but is correct: it borrows the reviewed mission's completed branch worktree for
its briefing and creates only the detached review checkout, so `details.rollback.worktree` says
`kept` and the checkout it did create is disposed of by path. A caller that
cancels its own signal gets the same error with a `cancelled` message instead of waiting for the
deadline. The same key bounds how long a spawn may wait behind another spawn for the same
repository; that failure reports `phase: "queue"` with `{waitedMs, depth}`, and
`tower_inspect({view:"status"})` exposes the live queue as `spawn.depth` and `spawn.oldestWaitMs`.

The release itself is bounded: the refusal waits up to two seconds for an in-flight phase to observe
the abort, and reports the release as it stands at that moment. When the unwind is still running,
`details.rollback` is `{status: "pending", note}` rather than a per-artifact report — the activity
log records what was released once it finishes, so a `pending` rollback is a reason to read the log,
not a reason to assume the writes survived. Phases before the first write (`pending`, `queue`,
`open`, `resolve`, `observe`, `roster`, `ownership`, `services`) carry no `rollback` key at all,
because nothing had been written yet.

## Example

```yaml
- id: tower-host
  name: 'dsh-tower'
  config:
    mode:
      allowAgentControl: true
      sectionAppend: 'Team conventions: tests are mandatory.'
      workspaceLock: true
    review:
      maxRoundsPerReviewer: 3
    merge:
      timeoutMs: 1800000
    spawn:
      reviewerModel:
        provider: deepseek-account
        model: deepseek-flash
```

The optional capabilities (`tower-skills`, `tower-batch`, `tower-import`,
`tower-leases`, `tower-tests`, `tower-hmr`, `preset-tower-reviewer`) are switched
from the plugin page, not from a config key. The keys that used to switch them
(`tools.expose*`, `dev.hotReload`) were removed in 2.4.0 and are rejected as
unknown keys.

## Looking up the effective schema

`cordis_inspect_query` with `Config.listConfigs({ name: "dsh-tower" })` returns the projected JSON
Schema once the plugin declares `Config` (this release does).
