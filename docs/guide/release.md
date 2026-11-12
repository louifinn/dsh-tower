# Release checklist

One page, in order. A release is a claim — `npm run release:check` is the mechanical half of it, and
the only **human-only** step is `npm publish` (npm credentials + 2FA). An agent can do everything
else in this repository.

The guard has three modes, all run by the same script:

| Mode | When | Behavior |
|---|---|---|
| `pr` (default) | every push/PR | warns about a version that has not moved, missing notes or a tag that does not match `v<version>`; never blocks the PR |
| `--mode tag` | after you create the release tag, before you push it | **fails closed** on everything below and exits 1 |
| `--mode prepublish` | before `npm publish`, through `prepublishOnly` | **fails closed** on the release claim, but allows the tag to be absent or already published |

`--mode tag` checks that `refs/tags/<tag>` exists, that `git cat-file -t refs/tags/<tag>` answers
`tag` (an **annotated tag**, never a lightweight `commit`), that the tag's commit is in HEAD's
history, that the tree is clean, that `package.json` agrees with the tag, that `CHANGELOG.md` has a
non-empty `## <version>` section, and that `scripts/support.json` agrees with its restatements.
`--mode prepublish` runs the same release-claim checks (dirty tree, version/tag agreement, the
version's CHANGELOG section, support drift) but tolerates a version whose tag does not exist yet —
publishing precedes tagging — and rejects a lightweight or foreign tag at HEAD. `npm publish` runs
it automatically through `prepublishOnly`; the mode is also available as
`npm run release:prepublish`.

## Milestone rule (before step 1)

A release may not be tagged while its milestone holds an open P0/P1, unless the release notes say
why it was accepted:

```bash
gh issue list --state open --search 'milestone:2.1.0-beta.1 label:P0,P1' --json number,title
```

Empty output → proceed. Non-empty → close the issues (with the two-line closure contract in
[CONTRIBUTING.md](../../CONTRIBUTING.md#the-two-line-closure-contract)), or name each accepted
issue and the reason in the release notes. The same query is saved in [the board](../board.md);
comma means OR inside `--search`, while `--label P0,P1` matches one literal label name and returns
nothing.

## 1. Prepare the release commit

Everything an agent can do belongs in one release PR against protected `main`:

- bump the version in `package.json`;
- move the Unreleased entries under a `## <version>（YYYY-MM-DD）` heading in `CHANGELOG.md`. Keep
  the `## 未发布（Unreleased）` heading (it may be empty). The tag and prepublish guards require a
  non-empty section for the released version; the PR-mode warning treats a non-empty Unreleased
  section as notes-in-progress;
- add the `COMPATIBILITY.md` row. The file keeps the columns
  `| dsh version | tag / commit | verified on | what was run |`: put the **host build in cell 0**
  and the **tag in cell 1**:

  ```markdown
  | 0.2.2-rc.1 | v2.8.0 | 2026-11-11 | `npm test`, `npm run support:check`, `npm run docs:check`, mount smoke |
  ```

  `host/compatibility.js#parseCompatibility` reads cells 0–3 only: never insert a column before the
  tag and never add one before "what was run", or `tower_inspect` with `view: "doctor"` stops seeing the row. The host pin
  in `scripts/mount-smoke/host.json` must equal cell 0 of the newest row (a unit test enforces it).
  Bump `scripts/support.json` first when the floor moves: `npm run support:check` fails unless the
  package engines, the mount host pin, the live CI matrix and this row all state the same Node/DSH
  pair;
- run the offline gates and commit the result.

Merge the release PR, then continue from a **clean clone/worktree at the merge commit** — not the
integration worktree. The guards refuse a dirty tree, so run the remaining steps from a checkout
whose `git status --porcelain` is empty.

## 2. Run the prepublish gate

```bash
npm ci
npm run release:prepublish
```

That command is the same `prepublishOnly` hook `npm publish` runs, and it is deliberately
read-only and offline: the release guard in `--mode prepublish`, `support:check`, every
`docs:check:generated*` check and `pack:check`. It never writes the tree, installs, publishes,
touches git/gh or reaches the network, so it is safe to run on a laptop and fast enough to run on
every publish. It fails closed on a dirty tree, a version/tag mismatch, a missing CHANGELOG section
for the version and support drift; if it is red, publish nothing.

## 3. Publish — human-only (2FA)

```bash
git status --porcelain          # must be empty: files:["docs/"] packs untracked docs too
npm test && npm run docs:check && npm run pack:check
npm pack --dry-run              # inspect the published file list
npm publish --tag next --otp <code>
npm view dsh-tower dist-tags --json
npm view dsh-tower@next version
```

- `npm publish` re-runs the prepublish gate through `prepublishOnly`; a red gate aborts the publish.
- Publish pre-releases with `--tag next`, **never** `latest`; `latest` moves only for a stable
  minor.
- Publish **before tagging**. If publishing fails, do not tag. If you already tagged, delete it
  (`git tag -d <tag>` and `git push --delete origin <tag>`) instead of leaving a tag on an
  unpublished commit.
- Both checks must name the version just published, and `next` must differ from `latest`.

## 4. Annotated tag on the published commit

```bash
git tag -a "v2.1.0-beta.1" -m "dsh-tower 2.1.0-beta.1"
node scripts/release-check.mjs --mode tag --tag v2.1.0-beta.1
git push origin "v2.1.0-beta.1"
git for-each-ref refs/tags/v2.1.0-beta.1 --format='%(objecttype)|%(subject)'
git cat-file -t refs/tags/v2.1.0-beta.1   # tag, never commit
# tag|dsh-tower 2.1.0-beta.1      (a lightweight tag prints commit, and is not allowed)
```

Run the guard **after** creating the tag (it inspects the tag object) and **before** pushing it.
Invoke it directly with `node`: the `npm` PowerShell shim does not forward `--`-prefixed flags
reliably (`npm.cmd` and bash do). CI never passes flags — it runs `npm run release:check` and
derives the mode from `GITHUB_REF_TYPE`/`GITHUB_REF_NAME` — so the same guard runs on the tag push
too.
It prints one facts line — `… tag-type=tag|commit|- reachable=yes|no|- worktree=clean|N-dirty|unavailable` —
followed by any findings, and exits 1 instead of passing when: the tag is not exactly `v<version>`,
`refs/tags/<tag>` does not exist, the object is a lightweight tag, the tag's commit is not in HEAD's
history, the tree is dirty, the version did not move past the previous version tag, the CHANGELOG
has no section for the version, or the support manifest disagrees with its restatements. A probe
that cannot answer (`git status --porcelain`, `git tag --list`, `git tag --points-at HEAD`) is an
error in the release modes — never a skipped check — so a corrupt index or an unreadable tag
namespace fails the guard instead of passing it. A tag push in CI re-runs the same mode with
`GITHUB_REF_TYPE=tag`, so the check is not only local.

The pushed tag must be exactly `v<version>`. The guard resolves the previous tag from `<tag>^`; this
is why tagging a commit whose `package.json` did not move fails.

## 5. GitHub Release with cumulative notes

A Release body is not just its own CHANGELOG section: it carries **every** section after the
previous GitHub Release (see [Cumulative Release notes](#cumulative-release-notes--累积发布说明)
below). `scripts/release-notes.mjs` is the authority for that body — do not hand-extract a single
section. The checklist step is `npm run release:notes -- --version <v> --since <prev-release> --output notes.md`, then pass that file to `gh release create`/`gh release edit` with `--notes-file notes.md`.

```bash
# Stable release (the common case): no pre-release flags.
VERSION=2.3.0
SINCE=2.1.0                 # the previous GitHub Release, not the previous tag
npm run release:notes -- --version "$VERSION" --since "$SINCE" --output notes.md
npm run release:notes -- --version "$VERSION" --since "$SINCE" --check notes.md
gh release create "v$VERSION" --title "dsh-tower $VERSION" --notes-file notes.md --verify-tag
# editing a Release that already exists (for example, to correct its window):
gh release edit "v$VERSION" --notes-file notes.md
gh release view "v$VERSION" --json tagName,isPrerelease,body
```

```bash
# Pre-release variant (a beta, for example 2.5.0-beta.1): mark the Release and keep "latest"
# on the previous stable Release.
VERSION=2.5.0-beta.1
SINCE=2.4.2                 # the previous GitHub Release; a pre-release counts as one too
npm run release:notes -- --version "$VERSION" --since "$SINCE" --output notes.md
gh release create "v$VERSION" --title "dsh-tower $VERSION" --notes-file notes.md \
  --prerelease --verify-tag --latest=false
```

`--check notes.md` exits 1 when the file differs from the generated text (it prints the first
differing line and both byte counts), so a correction is verifiable. The script exits 2 on a
missing/unknown flag, an invalid version, `since >= version`, or an empty window; it never emits a
Release body it cannot justify.

`--verify-tag` refuses to create the tag at the default branch when the pushed tag is missing. A
beta Release adds `--prerelease --latest=false`: GitHub marks it as a pre-release and keeps the
"latest" marker on the stable Release. Releases are what consumers and the plugin directory can
see — a tag alone is not a release.

## Cumulative Release notes / 累积发布说明

A GitHub Release is cumulative: it aggregates every CHANGELOG section **after the previous
Release**, up to and including the version being released.

- The **previous Release** is the latest published GitHub Release by version. Pre-releases created
  with `--prerelease` count as Releases, so a `2.1.0-beta.1` Release is a boundary too.
- **Tag-only versions have no Release.** A version that was tagged or published to npm without
  creating a GitHub Release — 2.1.1 and 2.1.2 were tag-only, and 2.2.0 too — would otherwise lose
  its notes; its CHANGELOG section rolls into the next Release.
- Example: once 2.1.0 is the previous Release, the 2.3.0 Release includes 2.1.1, 2.1.2, 2.2.0 and
  2.3.0:

  ```bash
  npm run release:notes -- --version 2.3.0 --since 2.1.0 --output notes.md
  ```

  The window is `(2.1.0, 2.3.0]`; `2.1.0-beta.1` sorts before 2.1.0 and therefore stays out.
- `npm run release:notes` (`scripts/release-notes.mjs`) is the authoritative generator: it reads
  `CHANGELOG.md`, filters the window, orders sections by SemVer (pre-release identifiers included),
  and emits the `# dsh-tower <v>` title, a provenance quote naming the previous Release and the
  included versions, then the sections separated by `---`.
- `--check <file>` re-verifies an existing notes file byte-for-byte (exit 1 on a mismatch), so the
  body of a published Release can be audited without editing it. Use `--root <dir>` to check
  another checkout.

Never hand-extract only the current version's section: that is what produced single-section
Releases whose tag-only predecessors were invisible.
