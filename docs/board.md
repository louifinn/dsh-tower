# Tracker board

The three questions an owner asks weekly, as commands that actually work. Run them from the
repository root (or add `--repo louifinn/dsh-tower`). Verified against the live tracker on
2026-10-22; the counts below are evidence for the commands, not a promise they stay fixed.

Priority lives in the `P0`–`P3` labels and area in `area/*`; issue titles carry no `[P*]`
prefix any more. Every open issue has exactly one `P*` label and at least one `area/*` label.

## Open P1

```bash
gh issue list --state open --label P1
```

Verified: **10** open on 2026-10-22 (#56, #69, #76, #77, #82, #94, #95, #96, #97, #98).

`--label` uses REST filters, so it does not wait for the search index after an edit. Do **not**
write `--label P0,P1`: `gh` treats that as one literal label name and returns nothing (verified).
For "P0 or P1" use `--search 'label:P0,P1'` — inside `--search`, the comma means OR, while
`label:P0 label:P1` (a space) means AND and returns only issues carrying both.

## Unmilestoned P0/P1

```bash
gh issue list --state open --search 'no:milestone label:P0,P1'
```

Verified: **0** on 2026-10-22 — every open P0/P1 is in a milestone. A non-zero result means a
release-scoped issue has no home; put it in the next release milestone or demote it to P2/P3.

## Closed this week by area

```bash
# week starts Monday; compute it rather than pasting yesterday's date
# GNU date (Linux/CI); on macOS use `gdate` or work the date out by hand
MONDAY=$(date -d 'last monday' +%F)
gh issue list --state closed --search "closed:>=$MONDAY label:area/ci"
```

```powershell
$MONDAY = (Get-Date).Date.AddDays(-(([int](Get-Date).DayOfWeek+6)%7)).ToString('yyyy-MM-dd')
gh issue list --state closed --search "closed:>=$MONDAY label:area/ci"
```

Swap `area/ci` for `area/state`, `area/tools`, `area/docs`, `area/release`, `area/process`,
`area/architecture`, or `area/scope`. Verified for `area/ci` with `closed:>=2026-10-19`:
**0**, because all **54** issues closed that week carry no `area/*` label at all. The query is
right; the history is unlabelled. Label a closure before you close it (or backfill) and the
by-area view starts working.

## Release rule query

A release may not be tagged while its milestone holds an open P0/P1 unless the release notes
say why. Check the milestone that is about to ship (see the [release checklist](guide/release.md)):

```bash
gh issue list --state open --search 'milestone:2.1.0-beta.1 label:P0,P1' --json number,title
```

Verified: **8** on 2026-10-22 (#76, #77, #82, #94, #95, #96, #97, #98) — the delivery gate's own
tickets block the release until they land. That is the rule doing its job, not a false positive.

## Milestones

```bash
gh api 'repos/louifinn/dsh-tower/milestones?state=all&per_page=100' \
  --jq '.[] | "\(.number)\t\(.title)\topen=\(.open_issues)\tclosed=\(.closed_issues)"'
```

Only issues that actually block a release belong in a milestone; everything else stays
unmilestoned and is queried by priority.
