## What changed

<!-- One or two sentences. Link the issue with Refs #n or Fixes #n in the commit, not here. -->

## Which principle does this change touch, or which new one does it require?

<!-- Required. Read PRINCIPLES.md first. Name the principle number and how this
change honours it, or explain why the change requires a new principle and why no
existing refusal already answers it. "None" is not an answer. -->

Principle:

## Surface budget

- [ ] I did not add a config key or tool.
- [ ] I added a config key/tool, and `scripts/surface-baseline.json` carries a
      matching ADR under `docs/adr/` or deletions that no longer exist.
- [ ] `docs/reference/surface-budget.md` classifies every new key/tool and a niche
      key carries a removal note.

## Two-key paths only

Complete this four-line body in order if the change touches `domain/**`,
`app/**`, `adapters/store.js`, `adapters/persistence.js`, `adapters/*lock*.js`,
`scripts/architecture.mjs`, `scripts/architecture-waivers.json` or
`cordis.patch.yml`:

```text
Failure mode: <what breaks for a user if this is wrong>
Change: <what changed, one sentence>
Test: <test file and case that fails without this change>
Blast radius: <repositories, state files or tools that can be affected>
```

## Regression?

- [ ] This fixes a regression: something that worked in a released version and
      then stopped. I added the six-field record from
      [docs/operations/incident.md](docs/operations/incident.md) and a
      `Regression test:` path that exists.

## Checks

- [ ] `npm test`
- [ ] `npm run check` (docs, philosophy, generated references, surface, pack,
      architecture, types, domain)
- [ ] New behavior has a test; a bug fix adds the test that fails before the fix.
- [ ] Generated files were regenerated, not hand-edited.
