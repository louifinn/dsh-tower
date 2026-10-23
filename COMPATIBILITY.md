# Compatibility

Tower records the DeepSeek Harness host build each release was actually verified against. This file
is shipped in the npm package; doctor reads it locally and never contacts a registry.

| dsh version | tag / commit | verified on | what was run |
|---|---|---|---|
| 0.2.1-rc.2 | v2.3.0 | 2026-10-23 | mount smoke (29 tower tools, `/tower`, 3 skills, 2 presets, single bundle row), `npm test` (573), `npm run docs:check`, four generated docs checks, philosophy + surface gates, live `--check` |
| 0.2.1-rc.2 | v2.2.0 | 2026-10-23 | mount smoke (29 tower tools, `/tower`, 3 skills, 2 presets, single bundle row), `npm test` (536), `npm run docs:check`, four generated docs checks |
| 0.2.1-rc.2 | v2.1.2 | 2026-10-23 | mount smoke (29 tower tools, `/tower`, 3 skills, 2 presets, single bundle row), `npm test` (495), `npm run docs:check`, generated docs checks |
| 0.2.1-rc.2 | v2.1.1 | 2026-10-23 | mount smoke (29 tower tools, `/tower`, 3 skills, 2 presets, single bundle row), `npm test` (490), `npm run docs:check`, generated docs checks |
| 0.2.1-rc.2 | v2.1.0 | 2026-10-23 | mount smoke (29 tower tools, `/tower`, 3 skills, 2 presets, single bundle row), `npm test` (479), `npm run docs:check`, generated docs checks |
| 0.2.1-rc.2 | v2.1.0-beta.1 | 2026-10-22 | mount smoke (29 tower tools, `/tower`, 3 skills, 2 presets, single bundle row), `npm test` (413), `npm run docs:check`, generated docs checks |
| 0.2.1-rc.2 | 6ee19de | 2026-10-21 | `npm test` (229), `npm run docs:check`, offline `ui-bundle` tests |
| 0.2.1-rc.2 | 5b0accd | 2026-10-18 | `npm test` (219), `npm run docs:check` |

## How to read this

- **verified**: exact host version match; the row names the date and what ran.
- **untested-newer**: newer than every row. Normally safe to try; include the host version and the
  latest row in a bug report.
- **untested-older**: older than every row; upgrade the host or expect missing APIs.
- **unknown**: the host did not expose a parseable version.

`tower_doctor` reports this as a warning only: a newer host is the normal case and must not block
Tower work. This is provenance, not a feature-detection mechanism.

## Release process

Add a row in the release PR, before tagging, after running the offline suite and docs check on the
host build being shipped. Name the release tag in cell 1 and the host build in cell 0; the other
columns are read positionally by `host/compatibility.js`, so do not insert or reorder them. Do not
claim a live run that was not performed. The 2.1.0-beta.1 row is a pre-release: it becomes
installable on the `next` dist-tag only after the checklist's publish step, and `latest` stays on
2.0.4 until a stable release. The full six-step procedure is the
[release checklist](docs/guide/release.md).

## Pack provenance

Releases are currently published locally with npm 2FA. `publishConfig.provenance` is intentionally
not enabled because provenance requires a CI OIDC publisher; enabling it locally would fail the
release. The reviewed `scripts/pack-manifest.txt` and CI `pack:check` guard the published file list.
Move publishing to GitHub Actions before enabling provenance.
