# 0001 — Ports and adapters are data, not a DI container

- Date: 2026-10-23
- Status: Accepted
- Deciders: maintainer
- Supersedes: none

## Context

Tower needs a real seam between the pure app/domain logic and the effectful
world (filesystem, Git, clocks, ids). The seam has to survive a test that replaces
every adapter with an in-memory double, and it has to be obvious to a reader why
a tool can run without touching a repository. A conventional dependency-injection
container would add a framework, decorators, and reflection to a plugin that must
load inside an arbitrary DSH host version.

## Decision

`ports/` declares a frozen `{ name, methods }` runtime contract per capability and
an `assert*Port` helper; `ports/index.js` exports the `PORTS` table and
`assertPorts(deps)`. The composition root builds one plain object of adapter
implementations (`createDefaultDeps`) and passes it explicitly. `app/**` imports
only app siblings, `domain/**`, `ports/**` and `node:path`. There is no service
locator and no runtime reflection; a missing method fails at the seam with a
readable error.

## Consequences

- Every effectful call is visible as `deps.<port>.<method>`, so the contract test
  can walk the source and assert each method is declared.
- Tests substitute the same plain object; the in-memory lifecycle is a real test
  rather than a mock framework feature.
- Adding a capability means adding a port and an implementation, not registering
  a class with a container.
- A downstream embedder that wants a different implementation passes a new
  object to `registerTowerTools`; it cannot monkey-patch module state.

## Rejected alternatives

- **A dependency-injection container** (`reflect-metadata`, decorators, a
  string-keyed registry) — adds a load-time framework dependency, hides the
  dependency graph behind reflection, and fails indistinguishably when a host
  bundle is mounted twice.
- **Direct adapter imports from `app/**`** — simpler at first, but it makes the
  pure app test need a filesystem and a Git binary, and the architecture rule
  `app-ports-only` would have nothing to enforce.
- **Module-level singletons** — one adapter instance would be shared across
  repositories and test cases, which is the ambient-state problem the host-scope
  rule exists to prevent.
