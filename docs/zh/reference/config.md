# 配置参考

[English](../../reference/config.md) | **简体中文**

每个键都是可选的；默认值即随包行为。未知顶层键会被拒绝。
`section` 与 `allowAgentControl` 是 `mode.promptSection` 与 `mode.allowAgentControl` 的兼容别名。
兼容别名只用于补缺：同时设置两种写法时，规范的 `mode.*` 键优先。

两个组件形态的开关已离开配置（#133/#135）：`docs.board` 现在是 `tower-board` 组件行，
`archive.enabled` 现在是 `tower-archive` 组件行。仍设置其中任一个的配置会以 `config-unknown-key`
失败，并附上指明替代行的升级提示；调优键（`docs.boardLocation`、`archive.afterDays`、
`archive.maxMissions`）仍保留在这里。

## 层级与优先级

从低到高：

1. 代码默认值（下表中的默认值），
2. profile 配置（挂载 `dsh-tower` 的 Cordis patch 传给 `apply()` 的配置），
3. 仓库配置 `<git-common-dir>/dsh-tower/config.json`（通常是 `.git/dsh-tower/config.json`），
4. 单次工具参数，例如 `worktreeRoot` 与 `timeoutMs`。

每次 Tower 工具打开仓库时都会读取仓库配置层，因此仓库可以在不修改 profile 的情况下调整 review、
merge、worktree 与 spawn 策略。它使用与 profile 配置相同的 JSON 形状（相同的分组与兼容别名），
并按分组合并：仓库设置的键优先，仓库未设置的 profile 键保留。`tower_status` 会报告
`config.path` 与 `config.repoConfigPresent`。

```json
{
  "review": { "requireReview": true, "maxRoundsPerReviewer": 3 },
  "merge": { "timeoutMs": 1800000 },
  "worktrees": { "root": "D:/tower-worktrees" },
  "spawn": { "reviewerPreset": "tower-reviewer", "maxDepth": 2 }
}
```

`mode.*` 分组是会话级的，不是仓库级的：为兼容 schema，它可以在仓库文件中出现，但只有 profile
配置能控制 Tower 模式提示与模型切换开关。文件格式错误、值不是对象、未知顶层键，或违反声明 schema
的值（例如 `merge.timeoutMs` 小于 1000）会以稳定的 `config-invalid` / `config-unknown-key`
工具错误码失败。

| 键 | 默认值 | 含义 |
|---|---|---|
| `section` | `''` | 兼容别名：替换整段 Tower 模式提示文案。空值保留内置提醒。 |
| `allowAgentControl` | `true`（`mode.allowAgentControl` 的别名） | 兼容别名：注册 `tower_control`，允许模型切换模式。 |
| `init.autoGitInit` | `false`（随包 patch：`true`） | 当 `repoRoot` 是绝对、已存在但不是仓库的目录时，`tower_init` 可以执行 `git init` 并创建一个空的初始提交。 |
| `init.snapshotDirty` | `false` | `tower_init` 可以把未提交的**已跟踪**改动快照为游离提交作为 mission 基线（不含未跟踪文件；该提交通过 `refs/tower/snapshot/*` 保持存活）。 |
| `init.autoExclude` | `true` | 把仓库内产物（`MISSIONS.md`、仓库内 worktree root）追加到 `.git/info/exclude`；绝不修改 `.gitignore`。 |
| `mode.promptSection` | `''` | 替换用的提示文案（与 `section` 同时设置时优先）。 |
| `mode.sectionAppend` | `''` | 追加在提醒之后的额外文本（团队约定）。 |
| `mode.allowAgentControl` | `true` | 注册 `tower_control`；模型可带理由进入/退出。设为 `false` 则仅人类可控制模式。 |
| `mode.autoPauseGoal` | `true` | 进入模式时暂停活跃 goal；退出时不会自动恢复。 |
| `mode.requireResumeAuthorization` | `false` | 恢复因 `pauseCause:user` 暂停的 mission 时，必须提供 `authorization` 引用。 |
| `mode.requireHumanAckOnFirstEntry` | `false` | 要求人类先执行 `/tower ack`，模型才能在当前会话首次进入 Tower 模式。 |
| `mode.workspaceLock` | `false`（随包 patch：`true`） | 每个仓库只允许一个 Tower 会话（`tower.lock`）；其他会话得到 `workspace-busy`。 |
| `mode.workspaceLockScope` | `all` | `all` 锁定所有仓库工具；`mutations` 对只读工具跳过 workspace 锁。 |
| `mode.planModePolicy` | `clear` | 进入 Tower 模式会清除活跃的 plan mode（或 `refuse` 直到退出计划）；前置步骤也会清除稍后激活的计划。 |
| `mode.workspaceStaleMs` | `300000` | 超过该时长的 workspace 锁可以被接管。 |
| `mode.heartbeatMs` | `10000` | workspace 锁的心跳间隔。 |
| `mode.denyTools` | goal/todo/team/workflow/subagent 工具（默认 12 个） | 模式激活期间被拒绝的工具。 |
| `mode.storePath` | `$DSH_HOME/tower-mode` | `modes.json` 所在目录。 |
| `mode.maxEntries` | `200` | 最多持久化的模式条目数（1–2000）。 |
| `review.requireReview` | `false` | 合并前是否强制独立 clean 审查。默认 `false`（审查可选）；设为 `true` 则要求 `no-review`/`not-clean`/`review-hold`/`review-not-approved`/`tip-moved`/`review-mission-mismatch` 全部通过。`tower_review` 始终可用。 |
| `review.maxRoundsPerReviewer` | `5` | 每个 reviewer 对每条分支的审查轮数上限。 |
| `merge.timeoutMs` | `900000`（15 分钟） | `tower_merge` 默认超时，包含钩子；单次调用的 `timeoutMs` 优先。 |
| `merge.maxBufferBytes` | `67108864`（64 MB） | 合并输出缓冲区。 |
| `git.timeoutMs` | `15000` | 除 merge 外 Git 命令的默认超时；merge 使用 `merge.timeoutMs`。 |
| `worktrees.root` | `''` | 默认 worktree 父目录；空值推导为 `<主检出父目录>/.dsh-tower-worktrees/<hash>`。 |
| `spawn.workerPreset` | `tower-worker` | `role=worker` 使用的 preset。 |
| `spawn.reviewerPreset` | `tower-reviewer` | `role=reviewer` 使用的 preset。 |
| `spawn.maxDepth` | `1` | spawn 时请求的子代理深度。 |
| `spawn.provider` | `''` | 子代理 provider id；空值优先 `spawn`，否则取第一个 provider。 |
| `spawn.workerModel` | `{}` | worker 可选模型路由 `{provider, model, reasoningEffort, maxTokens}`。 |
| `spawn.reviewerModel` | `{}` | reviewer 可选模型路由；使用不同模型可获得更强的独立审查。 |
| `spawn.maxLiveWorkers` | `4` | 每个仓库同时存活的 worker 上限（空闲 `inactive`、failed/interrupted/missing/stale/retired 不计入）；超过返回 `worker-limit`。 |
| `spawn.staleMs` | `15000` | 超过该时长没有目录活动的 roster 条目会被标记为 `stale` 并阻止合并（`worker-stale`）；0 关闭。 |
| `spawn.maxWaitMs` | `90000` | `tower_spawn.waitMs` 的上限（与 Kimi 兼容的 90s 默认值）。 |
| `spawn.requireLease` | `''` | worker spawn 前必须持有的可选租约名。 |
| `send.maxPerMinute` | `120` | 每个仓库的 `tower_send` 每分钟速率限制（0 关闭）；超出返回 `rate-limited`。 |
| `send.interruptDefault` | `false`（随包 patch：`true`） | `tower_send.interrupt` 的默认值（投递前先中断运行中的回合）。 |
| `tests.admission` | `off` | `spawn` 在启动 worker 前运行发现（fail-closed，不启动子代理）；`complete` 在 `tower_complete` 时运行；`off` 只在显式 `tower_test` 时运行（默认；不会自动执行仓库代码）。 |
| `tests.timeoutMs` | `60000` | 每条发现命令的超时。 |
| `tests.maxBytes` | `16777216`（16 MiB） | 每条命令捕获的 stdout 上限。 |
| `tests.autoChecks` | `true` | 向完成报告附加自动 `tests` 检查。 |
| `tests.allowPackageDiscovery` | `true` | 允许仓库控制的 `tower.testDiscovery` 命令（会执行 worktree 代码；见安全页）。 |
| `gates.requireChecks` | `false` | 合并前要求至少一条 `tower_complete.checks` 证据（`no-check-evidence`）。 |
| `gates.requireTests` | `false` | 要求针对当前 mission 分支 tip 的通过测试回执（`tests-missing`）；与审查门禁独立。`tower-tests` 组件行关闭时，规划/进入模式会带解释拒绝该组合。 |
| `gates.allowReviewExemption` | `false` | 在 `review.requireReview:true` 时，允许用 `reviewPolicy:"none"` + 非空理由跳过审查 blocker；默认故意关闭；全局审查关闭时无影响。 |
| `gates.maxReportBytes` | `32768`（32 KiB） | `tower_complete.report` 的 UTF-8 字节硬上限。超出时以 `invalid-argument` 拒绝并给出可执行的 `nextAction`（把全文写进 mission worktree 的文件并引用路径），绝不截断。已存在的超限报告仍可读取。 |
| `docs.boardLocation` | `common` | `common` = `<git-common-dir>/dsh-tower/MISSIONS.md`；`repo` = `<repoRoot>/MISSIONS.md`。是否写出看板由 `tower-board` 组件行决定（#133）；`docs.board` 已移除，会作为未知键被拒绝。 |
| `archive.afterDays` | `30` | 年龄触发：终态任务超过这么多天未更新，会在下次变更时归档（`0` 表示立即归档）。归档本身由 `tower-archive` 组件行决定（#135）；`archive.enabled` 已移除，会作为未知键被拒绝。 |
| `archive.maxMissions` | `100` | 数量触发：热状态中的终态任务超过此数时，从最旧的开始归档直到满足上限（`0` 表示归档所有符合条件的终态任务）。worktree 仍存在的任务永不归档。 |
| `leases.ttlMs` | `900000` | 默认咨询式租约寿命；过期不会自动释放。 |
| `dev.reloadDelayMs` | `50` | 计划中的 reload 延迟，先让工具结果送达。属于可选的 `tower-hmr` 组件。 |
| `dev.reloadRequiredIds` | 三个 Tower loader id | `tower-hmr` 组件作为 required 传给 `reconcileProfile` 的条目 id。可选组件行刻意不在 required 中。 |

## 示例

```yaml
- id: tower-host
  name: 'dsh-tower'
  config:
    mode:
      allowAgentControl: true
      sectionAppend: 'Team conventions: tests are mandatory.'
      workspaceLock: true
    review:
      maxRoundsPerReviewer: 3
    merge:
      timeoutMs: 1800000
    spawn:
      reviewerModel:
        provider: deepseek-account
        model: deepseek-flash
```

可选能力（`tower-skills`、`tower-batch`、`tower-import`、`tower-leases`、
`tower-tests`、`tower-hmr`、`preset-tower-reviewer`）在插件页切换，而不是用配置键。
原先用于切换它们的键（`tools.expose*`、`dev.hotReload`）已在 2.4.0 移除，会作为未知键被拒绝。

## 查看实际生效的 schema

插件声明 `Config` 后（本版本已声明），用 `cordis_inspect_query` 调用
`Config.listConfigs({ name: "dsh-tower" })` 可返回投影后的 JSON Schema。
