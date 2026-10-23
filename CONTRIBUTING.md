# Contributing

Thanks for your interest in `dsh-tower`. This is a DeepSeek Harness plugin; the repository root is the bundle itself (`package.json` + `cordis.patch.yml`).

## Engineering philosophy and decisions

Two short documents say what this project refuses to do:

- [PRINCIPLES.md](PRINCIPLES.md) — the numbered refusals. Each one names what it
  refuses and the file plus test or gate that enforces it. A principle whose
  pointer does not resolve fails `npm run docs:check:philosophy`.
- [docs/adr/](docs/adr/README.md) — dated decision records for choices already
  made (ports as data, one `state.json`, `allowAgentControl`, the surface
  budget, the component surface).

Every pull request answers **"which principle does this change touch, or which new
one does it require?"** in the PR template. "None" is not an answer: if no
existing refusal covers the change, say why a new principle is needed. The
concept budget and its classification table are in
[docs/reference/surface-budget.md](docs/reference/surface-budget.md): a config key
or tool may grow only with an ADR or a provably matching deletion, checked by
`npm run surface:check`.

The component axis — who may be switched off — is principle 11 and
[ADR 0005](docs/adr/0005-component-surface.md). It is generated from
[scripts/component-surface.json](scripts/component-surface.json) into
[docs/reference/component-surface.md](docs/reference/component-surface.md) and
enforced by `npm run docs:check:components`: every visible component needs
`title`/`summary`/`disables` in both locales, the host/health/recovery/review/
merge-gate capabilities may not be gated by any row or boolean key (the
`gateableTools` allowlist is empty since #122), and the component count — 8
visible rows in 2.4.0 — is the fourth baselined surface.

## Landing changes

`main` is protected. Every change lands through a pull request; direct pushes to `main` are rejected,
including the maintainer's, because protection is enforced for admins. To merge, a PR must pass these
required checks:

| Required context | What it proves |
|---|---|
| `test (22)` | offline suite, docs/pack/architecture/types/domain checks on Node 22 |
| `test (24)` | the same jobs on Node 24 |
| `mount` | the packed tarball mounts in a throwaway profile and registers its surface (`npm run smoke:mount`) |

The context names come from the workflow job id and matrix values. Renaming a job or a matrix value
changes the required context; update the protection setting in the same PR, or the check never reports
and every PR stays unmergeable. The setting and its verification command are in
[SECURITY.md](SECURITY.md#repository-protection-on-main). The `mount-fixtures` job runs the seeded
smoke failures for evidence but is deliberately **not** a required context. The `live` job is nightly
(and manual-dispatch) only, runs on a pinned host matrix, and is evidence as well: it is never part of
a push or a PR gate.

The offline `test` matrix also has a `test (22, windows)` leg on `windows-latest` (Node 22). It runs the
offline suite and the offline gates, not the release/coverage steps, so the platform branches are
measured on a real Windows filesystem (see `tests/platform.test.mjs`). Its name is pinned through
`matrix.name` so the two required contexts above stay byte-identical. The Windows leg is **not** a
required context yet: #86 only asks that it exists and is green, and adding it to the protection setting
is a separate human step.

There are no mandatory approvals, no CODEOWNERS gate, and **merging your own PR is allowed**: there is
one maintainer, and a mandatory self-approval would be theatre. What replaces the second reviewer is a
written contract.

### Two-key paths and the four-line PR body

"Two-key" here means two independent keys of evidence — the written failure mode and the named test,
on top of the green required checks — not two approvals. A change touching any of these paths carries a
four-line body, in this order:

- `domain/**`
- `app/**`
- `adapters/store.js`, `adapters/persistence.js`, `adapters/*lock*.js`
- `scripts/architecture.mjs`, `scripts/architecture-waivers.json`
- `cordis.patch.yml`

```markdown
Failure mode: <what breaks for a user if this is wrong>
Change: <what changed, one sentence>
Test: <test file and case that fails without this change>
Blast radius: <repositories, state files or tools that can be affected>
```

Those paths decide whether a user's repository is modified or a gate can be bypassed. Every other path
still lands as a PR, but a one-line description is enough. The four lines are evidence, not ceremony:
if the "Test" line cannot name a file, the change needs one first.

### Direct push

There is none. Before the delivery gate (#94 / #96), `main` accepted direct pushes, and #77 proposed
the two-key rule as a path-scoped exception. GitHub branch protection cannot express "direct push
allowed for these paths only", so the exception was dropped instead of documented as a rule the server
would not enforce. An emergency bypass is not a workflow: repairing `main` means changing the setting
deliberately and recording why, not silently pushing.

## Development setup

```bash
git clone https://github.com/louifinn/dsh-tower.git
cd dsh-tower
npm test        # no dependencies to install; Node's built-in test runner only
```

Requirements: Node.js 22+, Git. No package installation is needed for the offline suite.

The opt-in live suite is the exception: install it once with
`npm ci --prefix tests/live && npx --prefix tests/live playwright install chromium`, then run it with `npm run test:live`
against a disposable `DSH_HOME` under the OS temp directory and a booted isolated profile. The guard
refuses the operator's real `DSH_HOME` and any profile under `DSH_HOME/profiles`. `npm run test:live --
--check` validates the environment and Playwright resolution without a browser. See
[tests/README.md](tests/README.md#2-real-web-runtime-isolated-profile). The live suite is not part of
the push gates; CI schedules it nightly.

## What to change

- `index.js` — Host entry: `/tower` command, mode guard, dynamic prompt section, `tower_control`.
- `host/` — the composition root and session/process glue (`tool-registry.js`, `config.js`, `hmr.js`, `modeStore.js`, `doctor.js`); `adapters/` — the only I/O implementations (store, git, archive, leases, locks); `app/` — use cases; `domain/` — the pure core.
- `worker.js` — the `tower-worker` preset policy (tool surface + protocol text).
- `tests/` — add a regression test for every behavior change. The offline suite is `tests/*.test.mjs`; live-runtime scripts are documented in `tests/README.md`.
- `scripts/architecture.mjs` — the fitness rules; `scripts/architecture-waivers.json` — the only exemptions, each with a `reason` and an `owner`/`ref`. An entry without a reason fails the blocking `waiver-contract` rule, The three layering rules that keep the core pure — `domain-pure`, `host-scope`, and `no-lib-from-core` — cannot be waived at all. The `let` scan behind `host-scope` is statement-aware: every binding of every top-level declaration is recorded, and only `host/**` may hold ambient state.
- `types/` — the published declaration surface (`package.json` `types` is `types/index.d.ts`). The vocabulary block in that file is generated from the runtime constants by `npm run types:generate` and gated by `npm run docs:check:generated:types`; never edit it by hand. `tsconfig.strict.json` turns `noImplicitAny` on for an explicit file list that may grow but never silently shrink: add a file, then record it with `npm run types:strict:write` (a removal also needs `--allow-shrink`). `npm run types:coverage` fails when a shipped runtime `.js` file is outside the `tsc` program.

## Pull request checklist

1. `npm test` passes locally (620 tests today, including protocol end-to-end against a real temporary Git repository and mock spawn coverage) and `npm run docs:check` passes.
2. New behavior has a test. Bug fixes should add a test that fails before the fix.
3. No secrets, tokens, personal paths, session logs, or generated artifacts are added. `.gitignore` covers local acceptance output; do not force-add it.
4. Keep the public API and state-file formats compatible; if a change is breaking, call it out in `CHANGELOG.md` and bump the version.
5. Update `README.md` / `README.en.md` when the user-visible behavior changes.
6. If you touched `cordis.patch.yml`, `index.js`, `skills.js`, or `tools/`, run `npm run smoke:mount` (see below).
7. A commit carries `Refs #n` or `Fixes #n`; a P0/P1 closure carries `verified-by:` and `commit:`, and `npm run audit:issues` reports no new failures.
8. A regression closure carries the six-field record from
   [docs/operations/incident.md](docs/operations/incident.md) and `npm run audit:regressions`
   reports no failure; a `Regression test:` path must exist.
9. If you added a config key or tool, `scripts/surface-baseline.json` and
   [docs/reference/surface-budget.md](docs/reference/surface-budget.md) are updated in the
   same PR, and `npm run surface:check` passes. A visible component change also updates
   `scripts/surface-baseline.json` (`components`), `scripts/component-surface.json` and
   `docs/reference/component-surface.md` (`npm run docs:generate:components`), and must pass
   `npm run docs:check:components`. A new visible capability row also ships its own
   `<specifier>/locale/*.json` row label via `npm run docs:generate:locale` and passes
   `npm run docs:check:generated:locale` (see
   [architecture/overview.md](docs/architecture/overview.md#row-display-metadata-121)).

## Mount smoke

The offline suite never loads a host, so it cannot see a bundle that fails to mount. The smoke
packs this package, installs the pinned host into a temp directory, adds the tarball through
`dsh plugin`, and boots the throwaway profile through the real loader:

```bash
npm run smoke:mount      # asserts the loaded surface; under two minutes
npm run smoke:fixtures   # proves the smoke still fails for the right seeded reasons
```

It needs network access the first time (the host install) and `pnpm` on `PATH` (the plugin CLI's
package manager). `scripts/mount-smoke/host.json` is the single host build pin: bump it and the
newest `COMPATIBILITY.md` row together — a unit test fails when the two disagree. The fixtures
rename one tool id and remove the `tower-skills` row to prove the red run names the cause rather
than only counting rows; CI runs them in the `mount-fixtures` job, sharing one cached host install
through `--host-dir`.

Coverage is reported by `npm run test:coverage` in CI. It is a signal, not a gate: no threshold,
no baseline, no badge.

## Releasing

A release is six steps: bump → changelog → COMPATIBILITY row → publish → annotated tag → GitHub
Release. The one-page procedure with exact commands is [docs/guide/release.md](docs/guide/release.md).
It carries the two rules that are easy to get wrong: **publish before tagging** (or delete the tag if
publish fails), and a release **may not be tagged while its milestone holds an open P0/P1** unless the
release notes say why. `npm publish` is the only human-only step (2FA).

`npm run release:check` prints `git describe`, the previous tag, the commits since it and whether
Unreleased is non-empty on every run. It warns on a PR and fails on a tag push whose
`package.json` version did not move past the last tag or whose tag is not `v<version>`.

## Tracker board

Priority lives in the `P0`–`P3` labels; open titles carry no `[P*]` prefix. The saved queries — open
P1, unmilestoned P0/P1, closed this week by area, and the milestone check that blocks a release — are
in [docs/board.md](docs/board.md).

## Commits, closures and evidence

### Trailers

Put the issue trailer on its own line at the end of the commit message:

- `Refs #n` — the commit touches issue n but does not complete it.
- `Fixes #n` — the commit completes the issue; GitHub closes it when the change reaches `main`.

One trailer per issue, and exactly one of the two per commit. `Fixes` is not decoration for work that a
later commit still has to finish.

### The two-line closure contract

A closure on a P0/P1 is a pointer, not prose. The closing comment starts with these two lines:

```text
verified-by: tests/<file>.test.mjs
commit: <sha>
```

- `verified-by:` names a test file that exists in the repository (under `tests/`, or named `*.test.*` /
  `*.spec.*`). A script or a doc is not a test.
- `commit:` names the commit that landed the change.

Prose may follow. A closure without the two lines is treated as unverified, and the audit below fails
on it.

### Checking closures offline

The audit reads a local export; it never calls GitHub, so it cannot pass because of a network outage or
a token. Produce the export once (network), then audit it offline:

```powershell
# 1) Export (PowerShell; no jq needed)
New-Item -ItemType Directory -Force tracker | Out-Null
$all = foreach ($n in (gh issue list --repo louifinn/dsh-tower --state all --limit 500 --json number --jq '.[].number')) {
  gh issue view $n --repo louifinn/dsh-tower --json number,title,state,labels,closedAt,body,comments | ConvertFrom-Json
}
@{ issues = @($all) } | ConvertTo-Json -Depth 8 | Set-Content tracker/issues.json -Encoding utf8

# 2) Audit (offline)
npm run audit:issues                          # every closed P0/P1 in tracker/issues.json
npm run audit:issues -- --since 2026-10-22    # only closures on/after the convention date
npm run audit:issues -- --tracker path/to/export.json --json
```

The bash equivalent of step 1 is the same `gh` calls piped through `jq -s '{issues: .}'`.

Exit codes: `0` — every checked closure names an existing test file (a missing `commit:` is a warning);
`1` — at least one pointer is missing, nonexistent, not a test, or outside the repository; `2` — the
export is missing or malformed. `--strict` promotes the missing-`commit:` warning to an error.
`tracker/` is a local snapshot and is gitignored; regenerate it instead of committing it.

## Regressions and incidents

The `regression` label means **"worked in a released version, then stopped"**. It is
narrower than `bug` and mutually exclusive with it for a shipped break: a user
could rely on the old behavior, so the record must say which release broke it and
which test prevents it from happening again.

A closed `regression` issue carries the six-field record from
[docs/operations/incident.md](docs/operations/incident.md) (symptom, introduced in,
blast radius, root cause and fix, regression test, released in). The one checkable
line is `Regression test:`, which must name a test file that exists. The same
`tracker/issues.json` export from above is audited offline:

```powershell
npm run audit:regressions
npm run audit:regressions -- --tracker path/to/export.json --json
```

Exit codes: `0` — every closed regression names an existing test; `1` — a line is
missing or the path is nonexistent/non-test; `2` — the export is missing or
malformed. The fixture in `tests/regression-audit.test.mjs` seeds a missing path
and a valid one, so the rule cannot quietly become prose.

## Commit style

Conventional-commit prefixes are preferred: `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`. Keep the subject line in the imperative mood. Add the issue trailer (`Refs #n` / `Fixes #n`) described above.

## Reporting issues

Include the DSH version, Node.js version, the exact `/tower` or tool input, and the relevant error text. Redact paths, tokens, session ids, and any personal data from logs before posting. For security issues, see [SECURITY.md](SECURITY.md).
