# 工具错误码

[English](../../reference/errors.md) | **简体中文**

工具失败是抛出的错误，不是 `{ok:false}` 结果（门禁结果是例外：见 [blockers.md](blockers.md)）。
每个抛出的错误都以稳定 code 作为消息前缀。本版本定义 33 个工具错误码。

```
[tower:mission-not-found] unknown mission "M9"
```

调用方可以匹配前缀，而不必匹配文案。下面的 code 保留给对应条件；没有更具体匹配的消息会报告为
`tool-internal`。

| Code | 含义 | 典型触发 |
|---|---|---|
| `invalid-argument` | 工具参数缺失、格式错误或不被允许。 | 缺少 `missionId`/`id`；未知状态；空 report；非法 scope glob；`timeoutMs < 1000`；更新时传入 `status: "all"`。 |
| `repo-invalid` | `repoRoot` 缺失、是相对路径，或不在 Git 仓库内。 | 传入的路径所在目录不是仓库 |
| `not-initialized` | 该仓库尚未初始化 Tower。 | 在 `tower_init` 之前调用读取类工具 |
| `mission-not-found` | 不存在该 id 的 mission。 | 过期或拼错的 `M9` |
| `finding-not-found` | 不存在该 id 的 finding。 | `tower_findings({id:"F99"})` |
| `invalid-transition` | 请求的状态转换不被允许。 | 尝试 blocked→merged；finding 状态图之外的流转；reviewer 修改 finding；在还有未完成任务、blocker、无提交或未读消息时完成 mission。 |
| `stale-base` | 操作准备期间仓库状态已变化，需要重试。 | two-phase mutation 重校验 |
| `worktree-dirty` | mission worktree 有未提交改动，不能完成。 | `tower_complete` 前遗留 staged/modified/untracked 文件 |
| `state-locked` | 另一个 Tower 写入者持有 state 锁。 | 锁超时后的并发写 |
| `state-corrupt` | Tower state 文件不可读或无效。 | 手工编辑过的 `state.json` |
| `config-invalid` | Tower 配置无效。 | 格式错误的仓库 `config.json`、违反 schema 的值 |
| `config-unknown-key` | Tower 配置存在未知顶层键。 | 例如把键拼成 `allowAgentToggle` |
| `git-failed` | git 命令因未归入其他分类的原因失败。 | 被拒绝的合并命令、非法 ref |
| `git-timeout` | git 命令超时或输出超出缓冲区。 | 慢 pre-merge 钩子、超大 diff |
| `spawn-unavailable` | subagents 服务不可用。 | 没有 `subagents` 的 Host |
| `provider-missing` | 没有注册的 subagent provider。 | provider 列表为空 |
| `provider-cooldown` | 连续可重试的 provider 失败后，spawn 进入短暂冷却。 | 等待 `blockedUntil` 后重试 |
| `preset-missing` | 配置的 agent preset 未注册。 | 缺少 `tower-worker`/`tower-reviewer` preset 行、DSH 未重启 |
| `reviewer-prerequisite` | reviewer spawn 的前置条件未满足。 | mission 尚未 `completed` 或还没有 worktree 就 spawn reviewer |
| `not-authorized` | 调用方 agent 角色无权执行该操作。 | worker 调用仅限控制塔的工具，或修改 mission 状态/scope；reviewer 修改 finding |
| `workspace-busy` | 另一个 Tower 会话持有该仓库的 workspace 锁。 | `mode.workspaceLock:true` 时第二个会话调用仓库级工具 |
| `worker-limit` | 仓库达到 `spawn.maxLiveWorkers` 个活跃 worker。 | 默认上限下 spawn 第五个 worker |
| `rate-limited` | 达到 `tower_send` 的每分钟速率限制。 | 超出 `send.maxPerMinute`；稍后重试 |
| `takeover-refused` | mission 仍有运行中的 worker。 | 在 `tower_interrupt` 之前调用 `tower_spawn({takeover:true})` |
| `reload-unavailable` | 当前 profile 中没有可用的 DSH HMR 服务。 | 在没有 HMR 的 profile 上调用 `tower_reload` / `/tower reload` |
| `reload-failed` | HMR reload 失败。 | `reconcileProfile` 抛错；检查 DSH 日志并重启 |
| `tests-failed` | 声明的测试发现失败，或不满足准入要求。 | 命令非零退出、输出格式错误、minCount/required 不足 |
| `tests-timeout` | 测试发现超出时间或输出预算。 | `tests.timeoutMs`，或 stdout 超过 `tests.maxBytes` |
| `lease-busy` | 另一个持有者拥有请求的咨询式租约。 | `heavy-ci` 被持有时调用 `tower_resource acquire` |
| `lease-token` | 租约释放 token 与持有者不匹配。 | 用另一个会话的 token 释放 |
| `batch-invalid` | batch 请求或其 close 证据无效。 | 未知成员、重复 id、不安全的回执路径、缺少回执哈希 |
| `legacy-invalid` | 旧版快照或映射无效。 | 未知 schema、源路径位于 Tower state 目录内、映射重写 |
| `tool-internal` | 意外失败。 | bug；阅读消息与 activity 日志 |

## 为什么抛出？

返回 `{ok:false}` 的形状保留给控制塔能决定的预期策略结果（`tower_merge`/`tower_rebase` 的门禁
blocker 以及 `tower_preflight`）。任何阻止工具给出决策的问题都会抛出，以免模型把它误当成正常的
否定结果。
