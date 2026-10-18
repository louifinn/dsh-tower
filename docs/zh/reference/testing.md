# 测试、发现与证据

[English](../../reference/testing.md) | **简体中文**

Tower 2.1 可以执行仓库声明的测试发现，并把结果变成持久的完成证据。发现是**按配置选择性启用**的：
worktree 没有 `package.json.tower.testDiscovery` 块时，行为与之前完全一致。

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

- `tower_test({repoRoot,missionId})` 按需运行发现并记录回执。
- `tests.autoChecks` 开启时，`tower_complete` 会添加一条 `tests` 检查。
- `gates.requireChecks` 要求任意完成检查；`gates.requireTests` 要求针对被审查 tip 的通过回执
  （`tests-missing`）。

## 信任边界

发现命令是仓库控制的代码。`tests.allowPackageDiscovery:false` 会禁用 package 块；CI 或策略 profile
在克隆不受信任仓库时应设置它。命令以与 DSH 相同的 OS 权限、在 mission worktree 中运行，Tower 不会
为它增加网络访问。输出上限为 `tests.maxBytes`（默认 16 MiB），每条命令受 `tests.timeoutMs`
（默认 60 秒）限制；超出预算的运行 fail closed。
