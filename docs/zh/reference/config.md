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

1. 代码默认值（生成的[配置参考](../../reference/config.generated.md)），
2. profile 配置（挂载 `dsh-tower` 的 Cordis patch 传给 `apply()` 的配置），
3. 仓库配置 `<git-common-dir>/dsh-tower/config.json`（通常是 `.git/dsh-tower/config.json`），
4. 单次工具参数，例如 `worktreeRoot` 与 `timeoutMs`。

每次 Tower 工具打开仓库时都会读取仓库配置层，因此仓库可以在不修改 profile 的情况下调整 review、
merge、worktree 与 spawn 策略。它使用与 profile 配置相同的 JSON 形状（相同的分组与兼容别名），
并按分组合并：仓库设置的键优先，仓库未设置的 profile 键保留。`tower_inspect` 的 `view: "status"` 视图 会报告
`config.path` 与 `config.repoConfigPresent`。

```json
{
  "review": { "mode": "required", "maxRoundsPerReviewer": 3 },
  "merge": { "timeoutMs": 1800000 },
  "worktrees": { "root": "D:/tower-worktrees" },
  "spawn": { "reviewerPreset": "tower-reviewer", "maxDepth": 2 }
}
```

`review.mode` 就是审查策略：`off`、`optional` 或 `required`。2.6 时期的布尔别名
`review.requireReview` 已在 2.8.0 中彻底移除：仍在 profile 或仓库配置中设置它的配置会以
`config-unknown-key` 被拒绝，错误会点名 `review.mode` 并给出映射（`true` → `required`，`false` →
`optional`）作为升级办法。现在不再有第二个需要保持一致的 review 键。仓库层会独立解析：它可以放宽审查，
但若 profile 已是 `review.mode:off`，`tower_review` 根本没有注册，仓库层不能自行提高 mode。

插件页控件显示的正是运行时解析出的策略：以 `review.mode` 为准，未设置 mode 时显示「可选」（默认值）。
保存任何选择都只会在同一份 profile patch 中写入 `review.mode`，已不存在需要归一化的废弃别名。

同样的三个选项也出现在插件页的 `dsh-tower` 配置区：**关闭**、**可选**（默认）和 **必需**，每个选项都有一行效果说明。
该控件通过宿主设置表单写入 profile 配置，因此无需手动编辑文件，页面就会接受并显示所选值。

但已挂载的工具面无法实时重建：启动时审查为关闭的 profile 没有注册 `tower_review`。通过页面切换到「可选」
或「必需」会立即改变合并门禁，但审查工具本身需要重启（或重新加载配置）后才会出现；出现这种情况后控件会给出提示。

`mode.*` 分组是会话级的，不是仓库级的：为兼容 schema，它可以在仓库文件中出现，但只有 profile
配置能控制 Tower 模式提示与模型切换开关。文件格式错误、值不是对象、未知顶层键，或违反声明 schema
的值（例如 `merge.timeoutMs` 小于 1000）会以稳定的 `config-invalid` / `config-unknown-key`
工具错误码失败。

## 全部键与默认值

键列表、每个解析后的默认值与一行含义都从 `domain/config/schema.js` 生成到
[配置参考（生成）](../../reference/config.generated.md)。该页面是这些信息的唯一来源：在 schema 中增删键及其
`.description()`，再运行 `npm run docs:generate:config` 重新生成。若生成页漂移、缺少键或默认值，
或本页再次出现逐键默认值表，`npm run docs:check:generated:config` 会失败。

随包的 `cordis.patch.yml` 覆盖了两个代码默认值：`init.autoGitInit` 与 `mode.workspaceLock` 在随包
patch 中为 `true`。它还把 `send.interruptDefault` 固定为 `false`，因此普通的 `tower_send` 不会中断正在运行的
agent；需要中断时请显式传 `interrupt:true`。生成页中的其他值都是解析器在合并仓库配置前返回的值。

`spawn.nodeModules` 控制工作树中的依赖可见性（#218）。默认值为 `none`：工作树没有
`node_modules`，因此依赖安装或依赖检查命令无法在其中运行。设为 `link` 时，`tower_spawn` 会在 roster
预约提交之前，把 `<worktree>/node_modules` 创建为指向基线检出已安装 `node_modules` 的 junction，
并把 `{target, path, createdAt}` 记录到 `mission.worktree.nodeModulesLink` 与 roster 行上。目标必须
已经存在：目标缺失会以 `invalid-argument` 拒绝 spawn 并给出补救建议；若该路径已被占用但未登记，
也会拒绝而不是覆盖。teardown 只删除登记过的链接（绝不删除其目标或任何目录）；若链接悬挂、缺失、
被替换或未登记，`tower_inspect({view:"doctor"})` 的 `worktree-links` 检查会报告。由于链接直接指向
基线安装，工作树无需二次安装即可看到相同版本的依赖；需要自行安装依赖的 worker 应保持 `none`。

`spawn.preflightTimeoutMs` 用同一个截止时间约束整个 `tower_spawn` 预检（#237）：仓库的队列等待，
加上 roster 预约提交之前 spawn 执行的每一次读取与写入——子代理目录、roster、所有权检查、preset 列表、
准备工作树与测试准入。它不是每个 await 各自的超时，所以一百次快速读取和一个慢读取共享同一份预算；
默认值为 30000，下限（`1000`）与上限（`600000`）会拒绝无法真正保护调用的取值。截止时间到期时，
调用以 `[tower:spawn-unavailable]` 失败，并带有 `details: {phase, elapsedMs, rollback}`，其中 `phase`
是 `SPAWN_PREFLIGHT_PHASES` 中冻结的名字之一（`queue`、`open`、`resolve`、`observe`、`roster`、
`ownership`、`services`、`provision`、`discovery`、`reserve`、`activate`、`record`）。截止时间会真正
中止预检，而不只是提前返回：预检已经完成的写入会在失败返回之前被释放——它写入的 roster 预约、它创建的
worktree、分离的 sandbox——`details.rollback` 会逐项报告 released、removed、`none`，或无法撤销时的
`kept` 以及路径与原因。调用前就属于该 mission 的 worktree 不会被删除；已经启动的子代理也不会被报告为
未启动。reviewer 是看起来反常但正确的情况：它只为简报借用被评审 mission 已完成的 branch worktree，
自己创建的只是分离的 review checkout，因此 `details.rollback.worktree` 报告 `kept`，而它真正创建的
checkout 会按路径单独清理。调用方取消自己的 signal 时会得到同一个错误（消息为 `cancelled`），而不必等到
截止时间。同一个键也
限制一个 spawn 在等待同仓库其他 spawn 时的排队时长；该失败报告 `phase: "queue"` 与
`{waitedMs, depth}`，而 `tower_inspect({view:"status"})` 以 `spawn.depth` 与
`spawn.oldestWaitMs` 暴露实时队列。

释放本身是有界的：拒绝最多等待两秒，让进行中的阶段观察到中止，并报告那一刻的释放状态。若 unwind 仍在
运行，`details.rollback` 会是 `{status: "pending", note}`，而不是逐项报告——释放完成后活动日志会记录
结果，所以 `pending` 意味着应当去读日志，而不是假定那些写入仍然存在。第一次写入之前的阶段
（`pending`、`queue`、`open`、`resolve`、`observe`、`roster`、`ownership`、`services`）完全不携带
`rollback` 键，因为那时还没有任何写入。

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
