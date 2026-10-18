# 批次、租约与旧版导入

[English](../../reference/operations.md) | **简体中文**

## 证据批次

`tower_batch` 把有限的 mission 完成证据分组。

- `create` 冻结 `missionIds`、`exclusions`、`requiredChecks`（默认 `["check"]`）与精确的相对
  `receiptPaths`。成员必须是已知 mission，且只有暂停的旧版 mission 可以被排除；创建后成员关系不可变。
- `status` 汇总成员与待处理/失败的检查。
- `close` 校验已完成成员的每条必需检查（来自 `completionReport.checks`、`testRuns` 或 close 时的
  `checks`），在提供 `treeTip` 时校验它，并要求每个冻结的回执路径都在
  `receiptHashes`/`receipts` 中提供（或通过 `receiptHash` 绑定到通过的检查）。缺少证据会返回
  `{ok:false, blockers}`；不会删除任何内容。

close 失败不是部分关闭：batch 保持 `open`，修复证据后可以重试。

## 咨询式租约

`tower_resource` 管理每个仓库的租约，位于 `<git-common-dir>/dsh-tower/leases.json`：

```text
tower_resource({action:"acquire", name:"heavy-ci", ttlMs:900000})
tower_resource({action:"status"})
tower_resource({action:"release", name:"heavy-ci", token:"<token from acquire>"})
```

- acquire 仅限控制塔；调用方会得到 token、pid、holder、创建/过期时间戳；
- 同一个 token 可以续租；另一个持有者会得到 `[tower:lease-busy]`；
- release 需要 token；**已过期**的租约仍需要 token 与显式 `force:true`（不会静默接管）；
- `spawn.requireLease` 要求持有该租约，否则 worker spawn 失败。

租约用于协调本地任务与 CI 窗口。它们**不是** OS CPU/内存硬上限：DSH 没有公开的 Job Object 配额
API，Tower 无法强制每进程资源限制；这类限制请使用 live-worker 上限以及你的 OS/CI 调度器。

## 旧版导入与映射

`tower_import_legacy({repoRoot,sourcePath})` 接受 Tower Codex `schemaVersion:1` state 文件或 DSH
旧版 state。它会：

- 要求绝对源路径，且位于 `<git-common-dir>/dsh-tower` 之外；
- 校验 schema（上限 16 MiB），把原始 payload 逐字节保存到
  `<git-common-dir>/dsh-tower/legacy/<sha256>.json`，并在 `state.legacySnapshots` 中只记录摘要；
- 绝不激活、接管或恢复暂停的 mission。

`tower_legacy_map` 记录仅审计用途的 `sourceHash + oldId → newMissionId?` 映射。映射只追加；把已有
映射改写到另一个 mission 会被拒绝。映射不会改变 mission 状态。
