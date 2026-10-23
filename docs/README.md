# dsh-tower documentation

English is the source of truth; a Chinese translation lives in [zh/README.md](zh/README.md).

Choose a path:

| You are | Start here |
|---|---|
| New user | [When to use Tower](guide/scenarios-and-philosophy.md) → [Quick start](guide/quickstart.md) → [Tools](reference/tools.md) → [Example](examples/first-mission.md) |
| Choosing a workflow | [When to use Tower, and how it differs from Agent Teams, Ralph, Workflow and parallel subagents](guide/scenarios-and-philosophy.md) |
| Operator | [Runbook](operations/runbook.md) → [Blockers](reference/blockers.md) → [Error codes](reference/errors.md) → [Events](reference/events.md) → [Doctor](reference/doctor.md) → [Testing](reference/testing.md) → [Batches/leases/legacy](reference/operations.md) → [Security](operations/security.md) → [Incidents and regressions](operations/incident.md) |
| Maintainer | [Engineering principles](../PRINCIPLES.md) → [ADRs](adr/README.md) → [Architecture](architecture/overview.md) → [Surface budget](reference/surface-budget.md) → [Config](reference/config.md) → [Hot reload](guide/hot-reload.md) → [Release checklist](guide/release.md) → [Tracker board](board.md) → [Contributing](../CONTRIBUTING.md) |

Reference pages are the source of truth for the current release; the [tools reference](reference/tools.md),
[blocker list](reference/blockers.md) and [error codes](reference/errors.md) are checked against the
implementation by `npm run docs:check` in CI (including the Chinese pages).

Other useful pages: [When to use Tower](guide/scenarios-and-philosophy.md), [Install, upgrade and migration](guide/install-upgrade-migration.md), [Hot reload](guide/hot-reload.md), [FAQ](faq.md), [CHANGELOG](../CHANGELOG.md).

## All pages

**Guides**

- [When to use Tower, and how it differs from Agent Teams, Ralph, Workflow and parallel subagents](guide/scenarios-and-philosophy.md)
- [Quick start](guide/quickstart.md)
- [Install, upgrade and migration](guide/install-upgrade-migration.md)
- [Hot reload (development)](guide/hot-reload.md)

**Reference**

- [Tools](reference/tools.md)
- [Configuration](reference/config.md)
- [Blockers and failure codes](reference/blockers.md)
- [Tool error codes](reference/errors.md)
- [Events](reference/events.md)
- [Testing and evidence](reference/testing.md)
- [Batches, leases and legacy import](reference/operations.md)
- [Doctor](reference/doctor.md)
- [Surface budget and classification](reference/surface-budget.md)

**Operations and background**

- [Operations runbook](operations/runbook.md)
- [Incidents and regressions](operations/incident.md)
- [Security model](operations/security.md)
- [Release checklist](guide/release.md)
- [Tracker board](board.md)
- [Engineering principles](../PRINCIPLES.md)
- [Architecture decision records](adr/README.md)
- [Architecture and state machine](architecture/overview.md)
- [First mission example](examples/first-mission.md)
- [FAQ](faq.md)

Chinese pages: [中文文档索引](zh/README.md).
