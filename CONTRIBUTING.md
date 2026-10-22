# Contributing

Thanks for your interest in `dsh-tower`. This is a DeepSeek Harness plugin; the repository root is the bundle itself (`package.json` + `cordis.patch.yml`).

## Development setup

```bash
git clone https://github.com/louifinn/dsh-tower.git
cd dsh-tower
npm test        # no dependencies to install; Node's built-in test runner only
```

Requirements: Node.js 22+, Git. No package installation is needed for the offline suite.

## What to change

- `index.js` — Host entry: `/tower` command, mode guard, dynamic prompt section, `tower_control`.
- `lib/` — the Tower domain (`tower.js`), tool definitions (`tools.js`), persistence (`store.js`, `modeStore.js`), Git helpers (`git.js`).
- `worker.js` — the `tower-worker` preset policy (tool surface + protocol text).
- `tests/` — add a regression test for every behavior change. The offline suite is `tests/*.test.mjs`; live-runtime scripts are documented in `tests/README.md`.

## Pull request checklist

1. `npm test` passes locally (368 tests today, including protocol end-to-end against a real temporary Git repository and mock spawn coverage) and `npm run docs:check` passes.
2. New behavior has a test. Bug fixes should add a test that fails before the fix.
3. No secrets, tokens, personal paths, session logs, or generated artifacts are added. `.gitignore` covers local acceptance output; do not force-add it.
4. Keep the public API and state-file formats compatible; if a change is breaking, call it out in `CHANGELOG.md` and bump the version.
5. Update `README.md` / `README.en.md` when the user-visible behavior changes.
6. If you touched `cordis.patch.yml`, `index.js`, `skills.js`, or `tools/`, run `npm run smoke:mount` (see below).

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
than only counting rows.

Coverage is reported by `npm run test:coverage` in CI. It is a signal, not a gate: no threshold,
no baseline, no badge.

## Commit style

Conventional-commit prefixes are preferred: `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`. Keep the subject line in the imperative mood.

## Reporting issues

Include the DSH version, Node.js version, the exact `/tower` or tool input, and the relevant error text. Redact paths, tokens, session ids, and any personal data from logs before posting. For security issues, see [SECURITY.md](SECURITY.md).
