# 测试、发现与证据

[English](../../reference/testing.md) | **简体中文**

Tower 2.1 可以执行仓库声明的测试发现，并把结果变成持久的完成证据。发现是**按配置选择性启用**的：
worktree 没有 `package.json.tower.testDiscovery` 块时，行为与之前完全一致。

## 受支持的运行环境

Tower 只发布一条支持基线：Node.js 24.9+ 与 DeepSeek Harness `0.2.2-rc.5`（host 的
`engines.node` 声明为 `>=24.9.0`）。`scripts/support.json` 是唯一的清单；当 package engines、
lock 根 engines、mount-smoke host pin、live CI 矩阵或 [COMPATIBILITY.md](../../../COMPATIBILITY.md)
最新行与它不一致时，`npm run support:check` 会失败。离线套件就是 `node --test`；会启动固定 host
的 job 使用 Node 24。

## 配置

`package.json`（与 Tower Codex 兼容）：

```json
{
  "tower": {
    "testDiscovery": {
      "version": 1,
      "commands": [
        {
          "id": "unit",
          "command": "node --test dist/tests/*.test.js",
          "format": "node-tap",
          "minCount": 1,
          "required": ["smoke"]
        }
      ]
    }
  }
}
```

| 字段 | 含义 |
|---|---|
| `id` | 唯一，`[A-Za-z0-9][A-Za-z0-9._-]{0,63}`；也用于诊断文件名。 |
| `command` | 以 worktree 为 cwd 执行的 shell 命令（Windows 用 `pwsh`，POSIX 用 `bash`）。 |
| `format` | `node-tap`（TAP 的 `ok N - name` / `not ok`）或 `json-array`（`{name, ok?}` 的 JSON 数组）。 |
| `minCount` | 该命令至少应发现的测试数（默认 1）。 |
| `required` | 必须出现且通过的测试名。 |

Tower 配置中的 `tests.*` 控制准入、超时、输出上限以及是否允许 package discovery。
`tests.admission` 取 `spawn`（worker 启动前运行；fail-closed，不启动子代理）、`complete`
（在 `tower_complete` 时运行；默认）或 `off`（只在显式 `tower_test` 时运行）。

## 回执与门禁

每次运行都会在 `<git-common-dir>/dsh-tower/test-runs/<mission>-<stamp>/` 下保存回执，包含
stdout/stderr 文件、SHA-256 哈希、退出码、计数、required 名称、worktree tip 以及总体 `ok`。
`state.missions[].testRuns` 保留最近的 50 条回执。失败时工具返回带诊断的 `ok:false`；自动发现失败时
`tower_complete` 会抛出 `[tower:tests-failed]`。

- `tower_test({missionId})` 按需运行发现并记录回执。
- `testRuns` 中的回执是唯一的证据形态；`tower_complete` 不再向完成报告复制 `tests` 检查，完成检查、批次关闭
  与 `gates.requireChecks` 读取同一份回执。
- `gates.requireChecks` 要求任意已记录检查或回执；`gates.requireTests` 要求针对当前 mission 分支 tip 的
  通过回执（`tests-missing`）。测试门禁与审查独立：即使策略为 `review.mode:optional`（默认）或
  `off`，测试门禁仍检查分支 tip。

## 完成证据与 run id（#206）

完成检查只是一条声明，不是回执。旧形态 `{name, command?, exitCode?, evidence?}` 仍然可用，
手写检查不受影响；`checks` 正是 `gates.requireChecks` 读取、review 与 preflight 展示的内容。

`tower_test` 把每次运行记录为回执，并分配持久 `id`（`run-1`、`run-2`…），在 mission 内唯一，
并与回执同寿命（只保留最近 50 条）。`tower_complete` 接受 `checks: [{name, runId}]`，其中
`runId` 必须指向该 mission `testRuns` 中的回执：未知 id 或属于其他 mission 的 id 会在任何状态
写入之前以 `invalid-argument` 拒绝。存储的检查就是 `{name, runId}`；同时携带 `command`、
`exitCode` 或 `evidence` 也允许并会一并存储。

preflight 会把声称的 `command` 或 `exitCode` 没有任何 mission 回执中的命令佐证的检查，作为
提示性警告 `checks-unverified` 报告。它绝不进入 `blockers[]`，也不改变 `ok`，并在消息中给出
补救方式：用 `tower_test` 记录运行、以 `checks: [{name, runId}]` 引用它，或删除该声明。
`gates.requireChecks` 不变，默认仍为关闭；带 `missionId` 的 `tower_inspect`（`view:"status"`）
会展示该 mission 的 `testRuns`，每条都带 `id`。

## 信任边界

发现命令是仓库控制的代码。`tests.allowPackageDiscovery:false` 会禁用 package 块；CI 或策略 profile
在克隆不受信任仓库时应设置它。命令以与 DSH 相同的 OS 权限、在 mission worktree 中运行，Tower 不会
为它增加网络访问。输出上限为 `tests.maxBytes`（默认 16 MiB），每条命令受 `tests.timeoutMs`
（默认 60 秒）限制；超出预算的运行 fail closed。
