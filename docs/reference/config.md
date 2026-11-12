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

The shipped `cordis.patch.yml` overrides three code defaults: `init.autoGitInit`,
`mode.workspaceLock` and `send.interruptDefault` are `true` in the bundled patch. Every other value
in the generated page is what the resolver returns before repository config.

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
