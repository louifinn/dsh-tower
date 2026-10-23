# Engineering principles

These are the refusals this project makes. A principle with no refusal and no
enforcement pointer is a slogan, so every entry below names what it refuses and
the file plus test or gate that makes the refusal real. `npm run
docs:check:philosophy` fails when a pointer no longer resolves.

The product philosophy — when to use Tower, and when not to — is a separate
document: [docs/guide/scenarios-and-philosophy.md](docs/guide/scenarios-and-philosophy.md).
Decisions already made are recorded in [docs/adr/README.md](docs/adr/README.md).

## 1. Evidence before done

We do not accept "done" as an assertion. A change is done when a named test,
command, or receipt can be re-run by someone else, and the closure names that
pointer instead of describing the work.

Refused because of this: one-line closures, "implemented on main, trust me",
and completion reports that list prose without an exit code.

Enforced by: `scripts/issue-audit.mjs` and `scripts/regression-audit.mjs`, with
the fixtures in `tests/issue-audit.test.mjs` and `tests/regression-audit.test.mjs`;
gate: `npm run audit:issues`.

## 2. Gates before prose

We do not add a rule to a document that a machine could enforce. If a sentence
says "always" or "never", the same change must either point at an existing check
or admit that the sentence is `unowned`.

Refused because of this: warnings-only lint rules, "please remember to bump the
version", and instructions that only a careful reader can follow.

Enforced by: `scripts/architecture.mjs` and `scripts/check-docs.mjs`; tests in
`tests/architecture.test.mjs`; gate: `npm run architecture:check`.

## 3. Ports are data, not a DI container

We do not add a service locator, decorators, or a reflection-driven container.
The adapter seam is a table of frozen runtime contracts that a test asserts, so a
reader can see every effectful call without booting the app.

Refused because of this: `reflect-metadata`, string-keyed service lookup, and
"the container will wire it" as an explanation for a dependency.

Enforced by: `ports/index.js` and `scripts/architecture.mjs`; contract tests in
`tests/memory-adapters.contract.test.mjs`; ADR:
`docs/adr/0001-ports-adapters-as-data.md`.

## 4. One state file, one writer

We do not split mission state across per-mission files for diffability. One
`state.json` with one lock and one atomic write is the persistence contract;
archived missions move to year files only after they are terminal.

Refused because of this: per-mission JSON files, append-only forks of the state
tree, and any write that does not go through the lock.

Enforced by: `adapters/store.js` and `adapters/persistence.js`; tests in
`tests/persistence-contract.test.mjs`; ADR: `docs/adr/0002-single-state-json.md`.

## 5. The human owns the mode

The model may toggle Tower mode, but it may not acquire ownership of it, resume a
user-paused goal, or merge without the gate. The default that lets the model
enter is paired with lock, ack, and resume-authorization checks rather than with
trust.

Refused because of this: an autonomous "always on" mode, auto-resuming a paused
goal, and a model-initiated merge that skips preflight.

Enforced by: `index.js` and `host/modeState.js`; tests in `tests/plugin.test.mjs`;
ADR: `docs/adr/0003-allow-agent-control-default-true.md`.

## 6. The surface is a budget

We do not treat "highly configurable" as a feature. Every config key and tool is
a promise, so the counts are committed in `scripts/surface-baseline.json` and a
count may grow only with an ADR or a provably matching deletion.

Refused because of this: a new config key added because it was easy, and a tool
added without deciding which tool it replaces.

Enforced by: `scripts/surface-baseline.mjs` and
`docs/reference/surface-budget.md`; tests in `tests/surface.test.mjs`; gate:
`npm run surface:check`.

## 7. Read-only means no writes

A tool that says read-only may not create a temp file, migrate state, or probe the
filesystem. Diagnostics either report the absence or return a warning; they never
make the repository healthier as a side effect.

Refused because of this: doctor probes, lazy migrations during inspection, and
"read-only" tools that repair things on first call.

Enforced by: `host/doctor.js` and `adapters/store.js`; tests in
`tests/lock-heartbeat.test.mjs` and `tests/state-migration.test.mjs`; gate:
`npm test`.

## 8. Offline tests are the contract

`npm test` does not need a network, a browser, credentials, or a live host. A
proof that can only run on one machine is evidence for that machine, not a gate.

Refused because of this: a test that calls GitHub, a required model run in the
offline suite, and a live-only check that blocks a merge.

Enforced by: `tests/live-harness.test.mjs` and `scripts/mount-smoke/fixtures.mjs`;
gate: `npm run smoke:fixtures`.

## 9. Generated references are generated

We do not hand-maintain a list that the source already knows. Docs under
`docs/reference/*.generated.md` are written by a generator, their count line
comes from `scripts/surface-baseline.json`, and a mismatch is a failed check
rather than a review comment.

Refused because of this: hand-editing a generated table, and two references that
disagree about the same count.

Enforced by: `scripts/generate-config-reference.mjs` and
`scripts/generate-tools-reference.mjs`; tests in `tests/surface.test.mjs`; gate:
`npm run docs:check:generated:config`.

## 10. A regression keeps its test

We do not close a shipped regression with a sentence. A `regression` is anything
that worked in a released version and then stopped, and its closure carries the
six-field incident record plus a test path that exists.

Refused because of this: "fixed in the next release", a regression closed
without a test path, and a postmortem that names the cause but not the proof.

Enforced by: `docs/operations/incident.md`, `scripts/regression-audit.mjs`, and
`tests/regression-audit.test.mjs`; gate: `npm run audit:regressions`.

## Non-goals

This file is not a governance process: there is no RFC queue, no architecture
review board, and no required approval. The list stays useful only while its
pointers resolve, which is exactly what `scripts/check-philosophy.mjs` checks.

Enforced by: `scripts/check-philosophy.mjs`; tests in
`tests/philosophy.test.mjs`; gate: `npm run docs:check:philosophy`.
