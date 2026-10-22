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
[CONTRIBUTING.md](../CONTRIBUTING.md#the-two-line-closure-contract)), or name each accepted
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

`lib/compatibility.js#parseCompatibility` reads cells 0–3 only: never insert a column before
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

## 6. GitHub Release from the CHANGELOG section

```bash
VERSION=2.1.0-beta.1
awk -v v="$VERSION" '$0 ~ "^##[[:space:]]+.*" v {s=1; next} s && /^##[[:space:]]/ {exit} s {print}' \
  CHANGELOG.md > release-notes.md
test -s release-notes.md || { echo "empty section for $VERSION" >&2; exit 1; }
gh release create "v$VERSION" --title "dsh-tower $VERSION" --notes-file release-notes.md \
  --prerelease --verify-tag --latest=false
gh release view "v$VERSION" --json tagName,isPrerelease,body
```

PowerShell extraction of the same section:

```powershell
$version = '2.1.0-beta.1'; $lines = Get-Content CHANGELOG.md
$start = ($lines | Select-String -Pattern "^##\s+.*$([regex]::Escape($version))" | Select-Object -First 1).LineNumber
if (-not $start) { throw "CHANGELOG has no section for $version" }
$next = ($lines | Select-String -Pattern '^##\s+' | Where-Object LineNumber -gt $start | Select-Object -First 1).LineNumber
$end = if ($next) { $next - 2 } else { $lines.Count - 1 }
($lines[$start..$end] -join "`n").Trim() | Set-Content release-notes.md -Encoding utf8
```

`--verify-tag` refuses to create the tag at the default branch when the pushed tag is missing;
`--prerelease --latest=false` keeps the GitHub "latest" marker on the stable release. Releases
are what consumers and the plugin directory can see — a tag alone is not a release.
