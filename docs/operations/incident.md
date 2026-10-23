# Incidents and regressions

A **regression** is something that *worked in a released version, then stopped*.
It is not a feature request and not an ordinary bug: a user could rely on the old
behavior, so the record must say which release broke it, who was affected, and
which test now prevents it from happening again.

Only shipped regressions get this record. Ordinary bugs, missing features and
questions use the normal issue flow.

## The six-field record

Copy this into the issue body (or the closing comment) when a regression is
confirmed. All six lines are part of the closure; the `Regression test:` line is
the one a machine can check.

```text
Symptom:            what the user sees, with the exact error text
Introduced in:      version / commit range
Blast radius:       who is affected (all sessions? restored ones? one platform?)
Root cause:         one paragraph, mechanism not blame; include the fix
Regression test:    path to the test that fails without the fix
Released in:        version that carries the fix, and how it was verified
```

The fields answer, in order: what broke, which release introduced it, the user
impact, the cause and the fix, the proof, and the release that carries the fix.
`Introduced in` and `Released in` are different answers; do not fill both with the
current version.

## Label

The `regression` label means exactly **"worked in a released version, then
stopped"**. It is mutually exclusive with `bug` for a shipped break: the regression
label is the narrower claim. The issue title still describes the symptom.

## Closing rule

A `regression` issue may not be closed while any of these is true:

- no `Regression test:` line names a path;
- the path does not exist in the repository;
- the path is not a test file (a script or a doc is not evidence).

The offline audit reads a local tracker export, so it needs no network and no
token:

```powershell
# 1) Export (network, once) — same export as the P0/P1 audit
New-Item -ItemType Directory -Force tracker | Out-Null
$all = foreach ($n in (gh issue list --repo louifinn/dsh-tower --state all --limit 500 --json number --jq '.[].number')) {
  gh issue view $n --repo louifinn/dsh-tower --json number,title,state,labels,closedAt,body,comments | ConvertFrom-Json
}
@{ issues = @($all) } | ConvertTo-Json -Depth 8 | Set-Content tracker/issues.json -Encoding utf8

# 2) Audit (offline)
npm run audit:regressions
npm run audit:regressions -- --tracker path/to/export.json --json
```

Exit codes: `0` — every closed regression names an existing test; `1` — at least
one is missing or points at a nonexistent/non-test path; `2` — the export is
missing or malformed.

The audit is a script because a checklist is only as reliable as the reader.
`tests/regression-audit.test.mjs` proves the check fails for a seeded missing path
and passes for a real one, so the rule cannot silently become prose.

## Where the practice starts

The first real entry is #68 (all tower write tools failed with `unknown` after a
session restore). The tower retro-fills that issue with these six fields; this
document is the template it used.

## Non-goals

No blameless-postmortem ceremony for ordinary bugs, no SLA commitments, no
five-whys, and no incident commander. Only shipped regressions get the six fields.

Unowned. This is a writing habit and a closing convention; no runtime code
enforces it. The one checkable part — the `Regression test:` path — is enforced by
`scripts/regression-audit.mjs`.
