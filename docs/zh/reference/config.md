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

1. 代码默认值（生成的[配置参考](config.generated.md)），
2. profile 配置（挂载 `dsh-tower` 的 Cordis patch 传给 `apply()` 的配置），
3. 仓库配置 `<git-common-dir>/dsh-tower/config.json`（通常是 `.git/dsh-tower/config.json`），
4. 单次工具参数，例如 `worktreeRoot` 与 `timeoutMs`。

每次 Tower 工具打开仓库时都会读取仓库配置层，因此仓库可以在不修改 profile 的情况下调整 review、
merge、worktree 与 spawn 策略。它使用与 profile 配置相同的 JSON 形状（相同的分组与兼容别名），
并按分组合并：仓库设置的键优先，仓库未设置的 profile 键保留。`tower_status` 会报告
`config.path` 与 `config.repoConfigPresent`。

```json
{
  "review": { "mode": "required", "maxRoundsPerReviewer": 3 },
  "merge": { "timeoutMs": 1800000 },
  "worktrees": { "root": "D:/tower-worktrees" },
  "spawn": { "reviewerPreset": "tower-reviewer", "maxDepth": 2 }
}
```

`review.mode` 就是审查策略：`off`、`optional` 或 `required`。`review.requireReview` 仍是为 2.5 时期
配置保留的兼容别名（已弃用；`true` → `required`，`false` → `optional`），请优先使用 `review.mode`。
同一层同时设置两者时，`requireReview:true` 与任何非 `required` 的 mode 冲突，会以 `config-invalid`
拒绝并同时点名两个键。`requireReview:false` 与任何显式 mode 都不冲突：`off`、`optional`、`required`
都接受，且以 mode 为准（`required` 仍然强制门禁；只有该 mode 才会把解析后的别名镜像回 `true`）。
仓库层会独立解析：它可以放宽审查，但若 profile 已是 `review.mode:off`，`tower_review` 根本没有注册，
仓库层不能自行提高 mode。

插件页控件显示的正是运行时解析出的策略：`review.mode` 存在时以它为准；只设置了 `review.requireReview`
的配置会显示为「必需」（`true`）或「可选」（`false`）。保存任何选择都会在同一份 profile patch 中写入
`review.mode`，并把 `review.requireReview` 置为 `false`，因此该别名不可能与所选 mode 矛盾。

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
[配置参考（生成）](config.generated.md)。该页面是这些信息的唯一来源：在 schema 中增删键及其
`.description()`，再运行 `npm run docs:generate:config` 重新生成。若生成页漂移、缺少键或默认值，
或本页再次出现逐键默认值表，`npm run docs:check:generated:config` 会失败。

随包的 `cordis.patch.yml` 覆盖了三个代码默认值：`init.autoGitInit`、`mode.workspaceLock` 与
`send.interruptDefault` 在随包 patch 中为 `true`。生成页中的其他值都是解析器在合并仓库配置前
返回的值。

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
