# dsh-tower documentation

English is the source of truth; a Chinese translation lives in [zh/README.md](zh/README.md).

Choose a path:

| You are | Start here |
|---|---|
| New user | [Quick start](guide/quickstart.md) → [Tools](reference/tools.md) → [Example](examples/first-mission.md) |
| Operator | [Runbook](operations/runbook.md) → [Blockers](reference/blockers.md) → [Error codes](reference/errors.md) → [Events](reference/events.md) → [Doctor](reference/doctor.md) → [Testing](reference/testing.md) → [Batches/leases/legacy](reference/operations.md) → [Security](operations/security.md) |
| Maintainer | [Architecture](architecture/overview.md) → [Config](reference/config.md) → [Hot reload](guide/hot-reload.md) → [Contributing](../CONTRIBUTING.md) |

Reference pages are the source of truth for the current release; the [tools reference](reference/tools.md),
[blocker list](reference/blockers.md) and [error codes](reference/errors.md) are checked against the
implementation by `npm run docs:check` in CI (including the Chinese pages).

Other useful pages: [Install, upgrade and migration](guide/install-upgrade-migration.md), [Hot reload](guide/hot-reload.md), [FAQ](faq.md), [CHANGELOG](../CHANGELOG.md).
