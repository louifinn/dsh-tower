# Release checklist

One page, six steps, in order. The only **human-only** step is `npm publish` (npm
credentials + 2FA); an agent can do everything else in this repository. A release is a claim —
`npm run release:check` is the mechanical half of it.

## Milestone rule (before step 1)

A release may not be tagged while its milestone holds an open P0/P1, unless the release
notes say why it was accepted:

```bash
gh issue list --state open --search 'milestone:2.1.0-beta.1 label:P0,P1' --json number,title
```

Empty output → proceed. Non-empty → close the issues (with the two-line closure contract in
[CONTRIBUTING.md](../../CONTRIBUTING.md#the-two-line-closure-contract)), or name each accepted
issue and the reason in the release notes. The same query is saved in [the board](../board.md);
comma means OR inside `--search`, while `--label P0,P1` matches one literal label name and
returns nothing.

`npm run release:check` prints `git describe`, the previous tag, the commit count since that
tag and whether Unreleased is non-empty on every run. On a PR it warns; on a tag push it fails
when `package.json` did not move past the last tag, when the tag is not `v<version>`, or when
the CHANGELOG has no release content. CI runs it on every push and PR.

## 1. Bump the version

Edit `package.json` (`"version": "2.1.0-beta.1"`). The previous tag is found from the pushed
tag's parent (`<tag>^`), so a tag push that repeats the old version fails.

```bash
npm run release:check -- --mode tag --tag v2.1.0-beta.1
```

## 2. Write the changelog

Move the Unreleased entries under a version heading, so the GitHub Release body can be
extracted mechanically. Keep the `## 未发布（Unreleased）` heading (it may be empty).

```markdown
## 未发布（Unreleased）

## 2.1.0-beta.1（2026-10-22）

- feat: ...
```

The gate accepts a non-empty Unreleased section (bump first, rename later) **or** a non-empty
section whose heading names the version. Write the version section as user-facing notes.

## 3. Add the COMPATIBILITY row

`COMPATIBILITY.md` keeps the columns `| dsh version | tag / commit | verified on | what was run |`.
Put the **host build in cell 0** and the **tag in cell 1**:

```markdown
| 0.2.1-rc.2 | v2.1.0-beta.1 | 2026-10-22 | `npm test`, `npm run docs:check`, mount smoke |
```

`host/compatibility.js#parseCompatibility` reads cells 0–3 only: never insert a column before
the tag and never add one before "what was run", or `tower_doctor` stops seeing the row. The
host pin in `scripts/mount-smoke/host.json` must equal cell 0 of the newest row (a unit test
enforces it).

Commit steps 1–3 as the release PR against protected `main`, merge it, then continue from a
**clean clone/worktree at the merge commit** — not the integration worktree.

## 4. Publish — human-only (2FA)

```bash
git status --porcelain          # must be empty: files:["docs/"] packs untracked docs too
npm ci
npm test && npm run docs:check && npm run pack:check
npm pack --dry-run              # inspect the published file list
npm publish --tag next --otp <code>
npm view dsh-tower dist-tags --json
npm view dsh-tower@next version
```

- Publish pre-releases with `--tag next`, **never** `latest`; `latest` moves only for a stable minor.
- Publish **before tagging**. If publishing fails, do not tag. If you already tagged, delete it
  (`git tag -d <tag>` and `git push --delete origin <tag>`) instead of leaving a tag on an
  unpublished commit.
- Both checks must name the version just published, and `next` must differ from `latest`.

## 5. Annotated tag on the published commit

```bash
npm run release:check -- --mode tag --tag v2.1.0-beta.1
git tag -a "v2.1.0-beta.1" -m "dsh-tower 2.1.0-beta.1"
git push origin "v2.1.0-beta.1"
git for-each-ref refs/tags/v2.1.0-beta.1 --format='%(objecttype)|%(subject)'
# tag|dsh-tower 2.1.0-beta.1      (a lightweight tag prints commit, and is not allowed)
```

The pushed tag must be exactly `v<version>`. The tag push re-runs `release:check` against
`<tag>^`; this is why tagging a commit whose `package.json` did not move fails.

## 6. GitHub Release with cumulative notes

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
missing/unknown flag, an invalid version, `since >= version`, or an empty window; it never emits
a Release body it cannot justify.

`--verify-tag` refuses to create the tag at the default branch when the pushed tag is missing.
A beta Release adds `--prerelease --latest=false`: GitHub marks it as a pre-release and keeps
the "latest" marker on the stable Release. Releases are what consumers and the plugin directory
can see — a tag alone is not a release.

## Cumulative Release notes / 累积发布说明

A GitHub Release is cumulative: it aggregates every CHANGELOG section **after the previous
Release**, up to and including the version being released.

- The **previous Release** is the latest published GitHub Release by version. Pre-releases
  created with `--prerelease` count as Releases, so a `2.1.0-beta.1` Release is a boundary too.
- **Tag-only versions have no Release.** A version that was tagged or published to npm without
  creating a GitHub Release — 2.1.1 and 2.1.2 were tag-only, and 2.2.0 too — would otherwise
  lose its notes; its CHANGELOG section rolls into the next Release.
- Example: once 2.1.0 is the previous Release, the 2.3.0 Release includes 2.1.1, 2.1.2, 2.2.0
  and 2.3.0:

  ```bash
  npm run release:notes -- --version 2.3.0 --since 2.1.0 --output notes.md
  ```

  The window is `(2.1.0, 2.3.0]`; `2.1.0-beta.1` sorts before 2.1.0 and therefore stays out.
- `npm run release:notes` (`scripts/release-notes.mjs`) is the authoritative generator: it reads
  `CHANGELOG.md`, filters the window, orders sections by SemVer (pre-release identifiers
  included), and emits the `# dsh-tower <v>` title, a provenance quote naming the previous
  Release and the included versions, then the sections separated by `---`.
- `--check <file>` re-verifies an existing notes file byte-for-byte (exit 1 on a mismatch), so
  the body of a published Release can be audited without editing it. Use `--root <dir>` to check
  another checkout.

Never hand-extract only the current version's section: that is what produced single-section
Releases whose tag-only predecessors were invisible.
