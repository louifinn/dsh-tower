# Doctor

`tower_inspect({ view: "doctor" })` is read-only. It never takes the state lock, writes state, or changes Git.
It returns:

```json
{
  "ok": true,
  "checks": [
    { "id": "git", "status": "pass", "detail": "git version 2.55.0" },
    { "id": "surface", "status": "pass", "detail": "config keys: 58 · sections: 16 · tools: 21 (baseline 2026-11-12)" },
    { "id": "state", "status": "pass", "detail": ".../state.json revision 7" },
    { "id": "state-schema", "status": "pass", "detail": "schemaVersion 5 is current" },
    { "id": "activity-log", "status": "pass", "detail": "activity.jsonl 1024 B live + 2 rotated segment(s) 8192 B (cap 4194304 B, retention 5)" },
    { "id": "host-version", "status": "pass", "detail": "0.2.2-rc.3: 0.2.2-rc.3 verified on 2026-11-17. Source: 0.2.2-rc.3 from the package.json at D:/app/dsh/node_modules/@deepseek-ai/dsh named by DSH_INSTALL_DIR." },
    { "id": "ralph-stance", "status": "pass", "detail": "no live Ralph loop in this repository" },
    { "id": "foreign-capabilities", "status": "pass", "detail": "no non-Tower capability is available; 4 known types checked" },
    { "id": "case-mode", "status": "pass", "detail": "caseInsensitive: true; scope matching uses case-insensitive comparison" }
  ],
  "surface": {
    "configKeys": 58,
    "sections": 16,
    "tools": 21,
    "baselineDate": "2026-11-12",
    "line": "config keys: 58 · sections: 16 · tools: 21"
  },
  "stateLock": {
    "held": true,
    "pid": 4242,
    "startedAt": 1761280000000,
    "at": 1761280120000,
    "alive": true,
    "ageMs": 121000,
    "heartbeatAgeMs": 1000,
    "staleAfterMs": 3000,
    "stale": false
  },
  "gitLock": {
    "held": true,
    "pid": 4242,
    "phase": "merge",
    "heldMs": 92000
  },
  "ownership": {
    "owner": "session-abc",
    "caller": null,
    "sameOwner": false,
    "ownerMode": "off",
    "modeStoreStatus": "ok",
    "modeStoreFile": "D:/home/tower-mode/modes.json",
    "modeStoreError": null,
    "ownerLock": false,
    "foreignLock": false,
    "liveRoster": [],
    "unreadMessages": 0,
    "orphanLock": false,
    "blockers": [],
    "takeoverAvailable": true
  },
  "stateSchema": {
    "currentVersion": 5,
    "supportedVersion": 5,
    "migrations": [],
    "status": "current"
  },
  "archive": {
    "missions": 3,
    "archivedMissions": 12,
    "stateBytes": 48211,
    "archiveBytes": 190244,
    "years": [2026],
    "files": 2,
    "unreadable": [],
    "policy": { "enabled": true, "afterDays": 30, "maxMissions": 100 }
  },
  "environmentContract": {
    "platform": "win32",
    "gitVersion": "git version 2.55.0",
    "repoRoot": "D:/repo",
    "commonDir": "D:/repo/.git",
    "stateDir": "D:/repo/.git/dsh-tower",
    "caseInsensitive": true,
    "comparisonMode": "case-insensitive",
    "hostVersion": "0.2.2-rc.3",
    "hostVersionSource": "DSH_INSTALL_DIR",
    "hostVersionSourceDetail": "0.2.2-rc.3 from the package.json at D:/app/dsh/node_modules/@deepseek-ai/dsh named by DSH_INSTALL_DIR",
    "hostVersionAuthoritative": true,
    "hostVersionProbes": [
      { "source": "env:DSH_VERSION", "target": null, "status": "skipped", "reason": "DSH_VERSION is unset; treated as absent", "authoritative": true },
      { "source": "DSH_INSTALL_DIR", "target": "D:/app/dsh/node_modules/@deepseek-ai/dsh", "status": "hit", "reason": "D:/app/dsh/node_modules/@deepseek-ai/dsh/package.json declares 0.2.2-rc.3", "authoritative": true },
      { "source": "DSH_INSTALL_DIR(parent)", "target": "D:/app/dsh/node_modules/@deepseek-ai", "status": "miss", "reason": "the parent of DSH_INSTALL_DIR; no readable package.json at D:/app/dsh/node_modules/@deepseek-ai/package.json (ENOENT)", "authoritative": true }
    ],
    "hostAsar": null,
    "hostCompatibility": "verified",
    "ralphLoop": {
      "scopedRounds": 0,
      "liveScopedRounds": 0,
      "processRuns": 0,
      "detail": null
    }
  }
}
```

The `environmentContract.hostVersionProbes` array in this example is an excerpt: it shows the install-dir
probes but omits, for example, the other two version-variable probes. `probes` records one entry for every
attempt actually made, including unset variables and readable candidates a higher-precedence source displaced.

### When config resolution fails

Doctor is the one diagnostic that stays reachable when the configuration cannot be resolved: an unknown
key, an invalid value, or an unreadable/corrupt repository config. Every other tool opens the Tower
first, so config resolution runs before the handler and the call fails closed. For `tower_inspect` with `view: "doctor"` only,
`config-invalid`/`config-unknown-key` from that open path is not rethrown: the call continues with an
anonymous actor, the handler opens the repository without the layer that failed, and it returns a
degraded report instead:

```json
{
  "ok": false,
  "configError": "[tower:config-unknown-key] Tower config has unknown key(s) ...",
  "checks": [
    {
      "id": "config",
      "status": "fail",
      "detail": "[tower:config-unknown-key] Tower config has unknown key(s) ...",
      "action": "repair the config named in the detail (profile config or <git-common-dir>/dsh-tower/config.json), then re-run tower_inspect with view: \"doctor\""
    },
    { "id": "state", "status": "pass", "detail": ".../state.json revision 7" }
  ]
}
```

`configError` carries the resolution error verbatim, and the `config` check is replaced (never
duplicated) with a `fail` whose `detail` is the same error and whose `action` names the repair. The rest
of the report is still computed without the failed layer: the profile config when it still resolves,
otherwise the code defaults. The call is read-only: it never writes, never
migrates, and does not normalise `<git-common-dir>/dsh-tower/config.json`. The doctor row also skips the
lazy workspace-lock hook, which would resolve the config it just reported and could acquire a lock; a
read-only diagnostic must not write.

The exception is opt-in per authorization-matrix row (`configDiagnostic: true`, set only on the public
`tower_inspect` with `view: "doctor"` row). `tower_inspect` with `view: "status"`, `tower_plan`, every writer and every other read-only tool still fail
closed with `[tower:config-invalid]`/`[tower:config-unknown-key]`, so a broken config is never reported
as a healthy repository.

`surface` (and the `surface` check) reports the concept budget in the same format
as the generated references: `config keys: N · sections: N · tools: N`, plus the
committed baseline date from `scripts/surface-baseline.json`. The counts are live:
the config schema and every tool the build ships — `define()`-registered tools,
the `tower_mode` tool the Host entry registers directly (#118),
and the capability tools whose optional component row may be off (#121) —
independent of the operational switches. The `tools` count is therefore the full
build surface (21 in 2.9.0, 16 default), even though the shipped profile mounts 16 because the
five subsystem rows ship off; the `components` check names the mounted subset and every
disabled row.

`subsystems` lists the five default-off rows (`tower-batch`, `tower-import`,
`tower-leases`, `tower-tests`, `tower-hmr`) as `{id, enabled, tool, enable}`; each
row's tool stays in the 21 all-on surface. The `components` check detail names each
row as off, not deleted, with its enable step. A `deprecated-tool-names` check scans
`mode.denyTools` for names that #163 merged or removed (`tower_control`, `tower_adopt`,
`tower_findings`, `tower_import_legacy`, `tower_legacy_map`, `tower_status`,
`tower_roster`, `tower_diff`, `tower_preflight`, `tower_doctor`) and reports
`<old> -> <replacement>` instead of silently ignoring them. `npm run surface:check` is what fails when a count grew without an
ADR, a matching deletion or a recorded measurement correction. See
[surface-budget.md](surface-budget.md) for the classification table.

`stateSchema` describes the file **on disk**, not the in-memory document: `currentVersion` is the
`schemaVersion` doctor read, `supportedVersion` is the build's `SCHEMA_VERSION`, and `migrations` is
the ordered v→v path a write would apply (`[]` when current). `status` is one of `current`,
`migratable`, `newer`, `unmigratable`, `invalid`. Doctor never migrates, so a `migratable` file stays
byte-identical and the `state-schema` check is a `warn` (the next locked write applies the migration
and keeps a `state.json.v<N>.bak` backup). A file written by a newer plugin reports `newer` and a
`fail`: this build refuses to downgrade it. A state-load failure is reported as a failed check rather
than thrown so doctor remains useful on a broken repository.

`stateLock` (and the `state-lock` check) reports the held lock's age (`ageMs`, from the record's
`since`) and heartbeat freshness (`heartbeatAgeMs`, from its last `at`) against the stale window
(`staleAfterMs = 3 × 1000 ms`). A live PID is not proof of a live writer: a holder that stopped
heartbeating is reported as `stale: true`, but a live-but-silent holder is **never reclaimed
automatically**. Only a lock whose PID is provably dead is reclaimed, atomically, by the next
mutation. Recovering a live-but-silent lock requires the operator to confirm the process is gone and
run `tower_recover clear-stale-lock force:true` with `confirm:"CLEAR_STALE_LOCK"`; that moves the
lock record to a backup instead of deleting it. This makes a recycled PID diagnosable without
reading `state.lock` by hand. A lock file that exists but cannot be parsed (a torn write) is reported
as `unreadable: true` with `path` and the reader `error`; the `state-lock` check is a `warn` (never a
pass) and names the same force recovery, which renames the unreadable bytes to a unique numeric
`.recovered-<timestamp><tick>` backup instead of deleting them.

`commitLock` (and the `commit-lock` check) reports the short-lived state-commit mutex
`state.commit.lock`: `{held, unreadable, path, error, pid, token, at, alive, ageMs, heartbeatAgeMs,
staleAfterMs, stale}`. This mutex fences one serialise→rename→read-back window, so a record that
outlives its process is a leftover fence and every later state write fails with `state-commit-busy`.
A dead holder is reclaimed atomically by the next mutation; a live-but-silent holder is never
reclaimed automatically. After confirming the writer is gone (or stopping it), run
`tower_recover clear-stale-lock force:true` with `confirm:"CLEAR_STALE_LOCK"`; the record is renamed
to a unique numeric `.recovered-<timestamp><tick>` backup (`commitBackup` in the recover output),
never deleted.
An unreadable mutex — a prefix of the JSON record left by a crash — is reported with
`unreadable: true` and its `error`, and its check is a `warn`, not a `pass`: the file is still a
fence that every write keeps failing on. Without `force` the recovery refuses it with
`state-commit-lock-unreadable`; with `force` the exact bytes are renamed to the same kind of backup.
Doctor only reports this record; it never clears it. Clearing the mutex does not weaken the writer
fence: every commit still verifies the state-lock token and the exact `state.json` bytes before the
rename and classifies the landed revision afterwards, so a stale writer that lost a race fails
closed instead of overwriting the successor's document.

`ownership` (and the `tower-owner`/`workspace-lock` checks) is the same read-only ownership snapshot
`tower_inspect` with `view: "status"` returns, or `null` when the state or ownership facts could not be read. It contains
`owner`, `caller`, `sameOwner`, `ownerMode`, `modeStoreStatus`, `modeStoreFile`, `modeStoreError`,
`ownerLock`, `foreignLock`, `liveRoster`, `unreadMessages`, `orphanLock`, `blockers` and
`takeoverAvailable`. `modeStoreStatus` is `missing`, `ok`, or `corrupt`. When it is `corrupt`,
`ownerMode` is `unknown` (never `off`), the first `blockers` entry is `mode-store-corrupt` with the
repair action, and `takeoverAvailable` is `false`: a takeover fails closed instead of transcribing
an unreadable mode store as an inactive owner. The `ownership` field is how doctor and status stay
consistent with each other.

`gitLock` (and the `git-lock` check) reports the repo-scoped git mutex: `{held, pid, phase, heldMs}`
while a merge/rebase/init/teardown/provision holds it, and `{held: false}` when free. A merge may hold
it for the configured merge timeout (15 minutes by default), so a held lock is a `warn` rather than a
failure; the holder's phase and age make a stalled tower diagnosable. `tower_inspect` with `view: "status"` returns the same
`gitLock` object.

`board` names the `MISSIONS.md` location (`docs.boardLocation`) and whether the `tower-board` component
row is mounted. With the row off the check is a `warn` that says the board is not written (an existing
board goes stale) and names the row; every state tool and gate still works.

`archive` reports the terminal-mission archive: active `missions`, `archivedMissions` and `stateBytes`,
the archive directory's `archiveBytes`/`years`/`files`, every `unreadable` diagnostic, and the tuning
`policy` (`afterDays`, `maxMissions`). `policy.enabled` reflects the `tower-archive` component row, not a
config key: with the row off the policy line says archival is disabled by the component, terminal
missions stay hot and `state.json` keeps growing. A missing archive directory is a healthy empty archive
(`archive` check `pass`); a truncated index or year file is a `warn` with the diagnostic, and archiving is
paused until it is repaired rather than overwriting it. Nothing is lost while the archive is unreadable:
the eligible missions stay in `state.json`.

`caseInsensitive` is the mode `tower_init` detected once on the checkout's filesystem; `null` means
"not detected yet" and the `case-mode` check is a `warn`. `comparisonMode` is the comparison scope
matching actually uses: `case-insensitive` folds both sides, `case-sensitive` stays byte-exact. Doctor
never probes — a probe creates a temporary file, and a read-only call must not write. Run
`tower_init` on a writable checkout to record the mode; until then the safe `case-sensitive` default
applies.

`environmentContract.ralphLoop` (and the `ralph-stance` check) reports a live Ralph loop as an
environment fact: this repository has a loop in progress and Tower cannot co-own it (see
[ADR 0010](../adr/0010-tower-ralph-mutual-exclusion.md)). Rounds are matched to the checkout by their
parent session's cwd (`scopedRounds`, `liveScopedRounds`); first-party workflow runs carry no cwd, so
`processRuns` counts them process-wide and the check warns on them only while no round has matched.
The `warn` action names both `mode.ralphPolicy` outcomes; the loop itself is not doctor's to stop.

### Host version provenance

The `host-version` check compares the running DeepSeek Harness version with the rows in `COMPATIBILITY.md`;
doctor reads that file from the installed package and never touches the network. The version is resolved in
trust order:

1. `DSH_VERSION`, `DSH_HOST_VERSION`, then `npm_config_dsh_version`. Each value is trimmed and must parse as a
   version; unset, empty and whitespace-only values are treated as absent, never as a version. The desktop
   host exports both version variables as empty strings, so that is the normal desktop shape, not a version.
2. The `version` field of the `package.json` in `DSH_INSTALL_DIR` and in its parent directory. The probes run
   in that order and **the first readable path answers**: `DSH_INSTALL_DIR` outranks its parent, so a parent's
   older, already-verified row can never stand in for a newer untested install. When `DSH_INSTALL_DIR` points
   inside an `app.asar` archive — as the desktop install does — ordinary fs cannot read through the container,
   so doctor substitutes the matching `app.asar.unpacked` path (the packager's readable sibling) and records
   one probe per path: the asar path itself, its parent, the unpacked substitution, and the unpacked parent
   (the unpacked package outranks the unpacked parent). Later readable candidates stay in the provenance as
   recorded-but-not-used probes.
3. The mounted `app`, `runtime` or `host` service's `version`/`build.version`.
4. Last, as a labelled **secondary source only**, a profile-installed `@deepseek-ai/dsh*` dependency
   (`@deepseek-ai/dsh` first — that is the host package itself — then `@deepseek-ai/dsh-tool-subagent` as the
   known lockstep package, then any other sibling; never this plugin's own `tower` package) under
   `DSH_HOME/profiles/*/node_modules/@deepseek-ai`. Those packages ship in lockstep with the host but are only
   a dependency and may lag it, so a hit from this source is never authoritative.

Every source is probed defensively: a missing file, unreadable directory, unparsable version or a lookup that
throws is recorded as a failed probe, never thrown. That includes a throwing `os.homedir()` while locating the
profile fallback: the profile is simply not scanned and the failure is a `miss` probe. `resolveHostVersion`
returns the provenance: `source` and `detail` name the source that answered (or an unknown report says why each
source failed), `authoritative` is `false` for the profile fallback, `probes` lists every attempt with `target`,
`status` (`hit`/`miss`/`skipped`), `reason` and `authoritative` — a readable candidate that a higher-precedence
source displaced keeps `status: "hit"` and says so in `reason` — and `asar` describes the container, install dir
and unpacked substitution plus whether the archive was directly readable and whether the unpacked copy
answered.

Doctor surfaces that provenance in the `host-version` detail (`<version>: <verdict>. Source: <detail>`), in
`environmentContract.hostVersionSource`/`hostVersionSourceDetail`/`hostVersionAuthoritative`/
`hostVersionProbes`/`hostAsar`, and in the action. A detected version is `pass` only when it is authoritative
and exactly matches a row (`verdict: "verified"`). A profile-fallback hit is always a `warn` — even when its
version matches a row — because that dependency may lag the host; its detail says so and its action asks for
`DSH_VERSION` or a readable install package. When no source answers, the check is a `warn` whose detail names
the asar container when relevant and every probed source, `environmentContract.hostVersion` is `null`, and the
action tells the operator to set `DSH_VERSION`, make the install package readable, or add a row. Newer, older
and unparsable versions are likewise advisory `warn`s (`untested-newer`, `untested-older`, `unknown`). This
contract is informational: doctor never blocks a tool on it.

Checks cover: git availability, repository identity, state schema/load, bounded activity-log rotation,
the detected case mode, repo config presence, worker/reviewer preset names, subagents and HMR services,
state lock age/heartbeat, workspace lock holder/staleness, live roster, worktree
existence/ownership/dirtiness, test-discovery policy, completion-report sizes, archive health, legacy
snapshots, batches, leases, the Ralph stance, and the stance for non-Tower capabilities that can
orchestrate agents or land changes. Missions intentionally cleaned up by `tower_teardown` are skipped (the
check notes the removed count) instead of being reported as missing. A **terminal** mission
(merged/abandoned) whose checkout directory no longer exists is likewise advisory: the `worktrees`
check is a `warn` naming the count and pointing at `tower_teardown` as the repair, so a merged mission
never fails the check merely because its directory was deleted. A missing or invalid worktree on a
**non-terminal** mission still fails: a live worker cannot work in it. `tower_teardown` repairs the
terminal case by pruning any surviving registration, deleting the branch when it still exists, and
stamping `worktreeRemovedAt`; the removal decision carries `repaired: true`.

A terminal mission that still owns its checkout while no live roster row names it is also a prompt
rather than a fault: the `worktrees` check reports `N terminal mission worktree(s) awaiting
teardown; run tower_teardown` and names the teardown step as the action. That keeps a finished
mission from sitting hot forever without a hook (#182). Two limits are deliberate: doctor never
removes a worktree itself, and there is no automatic teardown policy or config key — the operator
runs the teardown step when the finished mission's checkout can go. A mission whose roster row is
still live is never counted, and a checkout already removed by teardown is reported by the removed
count instead.

Git registrations that no state record owns are reported separately by the `worktrees-orphans`
check (#185): a `warn` names the count and the remedy — the teardown step's `orphans` option — while
zero is a `pass` reading `no unrecorded worktrees`. The check splits clean checkouts (removable),
dirty ones (kept) and registrations whose directory is gone (prunable), and it never removes
anything itself; only the explicit `orphans` option does, and only for clean paths inside the
worktree root. The main checkout, every path state references (mission worktree, sandbox, review
checkout) and every path outside the root are hard exclusions, so a checkout can be listed without
being removable. A checkout git records **outside** the worktree root is reported in the same check
and is never removed by Tower: that is the documented limit, and the operator either reclaims it
out of band or accepts it.

A checkout at the path a mission is expected to provision is reported as in flight, never as an
unrecorded defect: while a mission with no recorded worktree can still start a provision (planned,
active, paused or blocked), the check adds `N checkout(s) in flight (kept)` to its detail and applies
no remedy. A mission closed as `completed`, `merged` or `abandoned` cannot provision again and does
not reserve its path; neither does a shape that declares no worktree (a survey), so a clean checkout
left at `<worktree root>/<mission id>` is an ordinary removable orphan. The reservation also fails
closed: if a mission's kind cannot be read, its expected path is kept with the reason stated in the
decision instead of being removed. The bare `pass` text is used only when nothing is reserved;
otherwise the detail names the in-flight count while a reserved checkout exists.

Tower mode does not deny the worktree tool's `create_worktree` (#187). The stance is allow and make
visible: an unrecorded checkout is a fact this check reports, not an operation Tower tries to
forbid. A deny entry would break that tool for every repository regardless of mission need and still
would not give Tower a record of the checkout; orphan mode is the cleanup path, and it is opt-in.
Nothing here removes a checkout automatically.

The `loader-conflicts` check reads the mounted loader's configured rows. The shipped
`cordis.patch.yml` mounts the host plugin as a nested row (`id: tower-host`, `name: dsh-tower`)
inside the mandatory `tower` `cordis:group` anchor, so the anchor and the rows nested under it are
Tower itself and never count as a conflict. A single enabled `dsh-tower` row is always Tower's own
mount, wherever the loader reports it; a second enabled row outside that anchor — another installed
package declaring the same plugin row — is a `fail` that names the offending row id(s),
with the action to remove or disable the duplicate row in the profile's `cordis.patch.yml`,
restart DSH and re-run the environment health check. A disabled row is installed but not mounted, so
it is never a conflict. When the loader inventory cannot be read the
check is a `warn` (`loader inventory unavailable`), never a pass.

### Non-Tower capabilities (#188, #189)

Other capabilities can orchestrate agents or land changes without Tower. Doctor records a stance for
each known type in the `foreign-capabilities` check and in `foreignCapabilities`:

| capability | detection | stance | cost of denying it |
| --- | --- | --- | --- |
| Forge change requests | loader row for `@deepseek-ai/dsh-experimental-forge`, or a mounted `forge` service | warn+allow | forge loses its change-request and merge-on-request path, and Tower has no record of what it refused |
| Live sharing | loader row for `@deepseek-ai/dsh-experimental-liveshare`, or a mounted `liveshareShares` service | warn+allow | a shared session loses viewing and bounded writing, and Tower has no record of the share |
| Plugin manager | a visible `plugin_manager` tool, a mounted `pluginManager` service, or a loader row for `@deepseek-ai/dsh-plugin-manager` | warn+allow | the profile can no longer install or enable a plugin from a session, and Tower has no record of the change |
| Auto review | a registered `auto` permission preset, or the `auto-review` loader row | warn+allow | Auto is removed for every session, including unattended runs, and Tower does not replace the reviewer |

Denying is not the default: Tower does not replace any of these capabilities, so a deny entry would
break a real workflow and still leave Tower with no record of the change it refused. `warn+allow`
reports the capability, names the one-line cost of denying it, and leaves it working. Each row also
carries its remedy where an action is possible: keep the capability and land changes through one path
at a time, or turn its row off for a run that must land through Tower. Doctor is read-only here: it
never denies, disables or removes a capability, and it reads only the probes below.

The check passes only when the surface is provably clean and every type is detectable: the loader
inventory answers and lists no matching row, the tool registry lists no `plugin_manager` tool, the
permission preset catalog lists no `auto` preset, and no matching service is mounted. A present
`warn+allow` capability and any type doctor cannot detect both make the same check a `warn`, never a
pass — when the loader inventory is unavailable and no service is mounted, the type is reported as
undetectable instead of assumed absent. A disabled loader row is installed but not mounted: it is
reported in the pass detail and does not warn. The stance set also includes `deny`,
`compatibility` and `deployment-config`; a `deny` row that is present would be a `fail`, because
doctor cannot enforce a stance it only reports (no capability has that stance today). A present
`compatibility` row is reported as supported; a `deployment-config` row is reported as configured at
deployment, because its remedy — if any — was decided where the deployment is built, not here. No
row uses `deployment-config` today; adding one is a change in the same inventory.

Auto review is the combination #188 pins. Selecting the `auto` permission preset puts the reviewer
in front of every native and PTC tool call, and DSH pins a delegated child's approval policy to
`never`: a worker's denied call fails closed, with no approval prompt and no escalation path, while
the same denial in the parent asks the user. Doctor reports Auto as `warn+allow`, not
`compatibility`: compatibility would mean the reviewer already understands Tower protocol calls, and
teaching it that is a change in the auto-review package, not in Tower, so claiming it here would be a
promise Tower cannot keep. The row carries `failureMode` with that sentence, and when Auto is the
selected preset the check detail repeats it.

The inventory is closed only for the types it lists. A new capability that can orchestrate agents or
land changes gets its stance in the same change that introduces it; until then doctor cannot report
it, and the not-detectable warning is what keeps that gap visible instead of silent. Revisit a stance
when the capability's own contract changes — for example, if the reviewer learns Tower protocol
calls, the Auto stance can become compatibility.

`warn` is advisory; `fail` means the repository needs attention before spawning/merging.

The `reports` check names the largest completion report in the repository (`<bytes> B on <mission>`,
against the `gates.maxReportBytes` cap); the same numbers are returned as
`reports: { count, largest: { missionId, bytes } | null, capBytes }`. Reports written before the cap
only produce a `warn`; doctor never rewrites them.

The environment contract is informational; it is not an identity or authorization proof. `tower_init`
still requires the tower role, and `tower_spawn` still checks the live subagent catalog.
