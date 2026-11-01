# 快速开始

[English](../../guide/quickstart.md) | **简体中文**

前置要求：DSH `0.2.1-rc.2`+、Node.js 22+、Git。安装 `dsh-tower` 并重启 DSH（见
[安装](install-upgrade-migration.md)）。

## 1. 进入 Tower 模式

```
/tower
```

会话会报告 `Tower mode ON`。此时你是控制塔；goal/todo/team 委派工具保留给普通模式。

## 2. 初始化与计划

```
tower_init repoRoot=D:\work\repo
tower_plan repoRoot=D:\work\repo missions=[{"title":"Feature A","scope":["src/a/**"],"tasks":["implement the feature","commit the change"],"kind":"build"}]
```

`tower_plan` 返回 mission id（`M1`）。每个 mission 在 spawn 时获得独立分支和 worktree。
Tower 工具同时接受 `missionId` 与 `id` 两种写法（见[输入别名](../reference/tools.md#输入别名)）。

## 3. 运行 worker

```
tower_spawn repoRoot=D:\work\repo missionId=M1 role=worker
```

调用立即返回子代理 id。worker 在 mission worktree 内工作、提交、把任务标记完成，并调用
`tower_complete`；它的最终报告会送回本会话。用 `tower_roster` 观察活动，不要循环轮询。

## 4. 可选：审查

审查策略是插件页 `dsh-tower` 配置区里的一个三态控件：`off`、`optional`（默认）或 `required`；
也可以在 profile 或仓库配置中写 `review.mode`。它是一个控件，不是组件行，也不是三个行。需要严格
流程时设为 `required`，然后：

```
tower_spawn repoRoot=D:\work\repo missionId=M1 role=reviewer
```

reviewer 使用只读的 `tower-reviewer` preset，查看 `tower_diff` 并提交 `tower_review`。设为
`review.mode:required` 后，只有 `clean` + `merge` 的结论才允许合并。`optional` 会记录审查但从不
阻塞合并；`off` 是受支持的模式，不会注册 `tower_review`。

旧布尔审查开关是保留一个版本的别名（`true` → `required`，`false` → `optional`；不设置 →
`optional`）。请优先使用 `review.mode`。以 `off` 启动的 profile 需要
重启或重载后才会注册 `tower_review`，但合并门禁会立即改变。完整迁移说明见
[安装、升级与迁移](install-upgrade-migration.md)。

## 5. 门禁、合并与清理

```
tower_preflight repoRoot=D:\work\repo missionId=M1
tower_merge     repoRoot=D:\work\repo missionId=M1
tower_teardown  repoRoot=D:\work\repo
```

策略为 `review.mode:required` 时，审查前运行 `tower_preflight` 会报告 `no-review`；干净审查之后应为
`ok:true`。默认 `optional` 时没有审查 blocker。存在其他 blocker 时 `tower_merge` 拒绝合并。
`tower_teardown` 移除已 merged/abandoned 的 worktree 与分支。

```
/tower off
```

## 如果失败

阅读 blocker code 并查阅 [blocker 参考](../reference/blockers.md)。最常见的情况：`stale-base`
（执行 `tower_rebase`）、`no-review`（仅在 `review.mode:required` 时；spawn reviewer）、
`merge-hook-failed`（重试，或调大 `timeoutMs`）、`tip-moved`（仅在策略为 `required` 时；审查后
分支已变化，需要重新审查）。

工具抛出的错误带 `[tower:<code>]` 前缀；见[错误码](../reference/errors.md)（例如
`preset-missing` 表示安装 bundle 后需要重启 DSH，`not-initialized` 表示先运行 `tower_init`）。

## 可选：仓库级配置

不修改 DSH profile，仓库也能调整 review、merge、worktree 与 spawn 策略。把 JSON 文件放到
`<git-common-dir>/dsh-tower/config.json`（普通检出通常是 `.git/dsh-tower/config.json`）：

```json
{
  "review": { "mode": "required", "maxRoundsPerReviewer": 3 },
  "merge": { "timeoutMs": 1800000 },
  "worktrees": { "root": "D:/tower-worktrees" }
}
```

仓库配置层覆盖 profile 配置；单次工具参数又覆盖两者。完整键表与优先级见
[配置参考](../reference/config.md)。

## 可选：finding

scope 之外的观察用 `tower_finding` 记录。之后可以列出或关闭它们，而不必改代码：

```
tower_findings repoRoot=D:\work\repo
tower_findings repoRoot=D:\work\repo id=F1 status=fixed note="fixed in M2"
```

状态为 `open → triaged → fixed` / `wontfix`，且 `fixed`/`wontfix` 可重新打开为 `open`。只有控制塔
或 worker 可以修改 finding；reviewer 只能列出和读取。

完整可复制示例：[examples/first-mission.md](../../examples/first-mission.md)（英文）。
