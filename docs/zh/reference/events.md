# Tower 事件

[English](../../reference/events.md) | **简体中文**

Tower 在工具成功调用（变更与只读）后发出进程内 Cordis 事件，其他插件因此可以观察仓库，而不必轮询。
事件**不会**通过网络发送，也不包含遥测。

```js
ctx.on('tower/merge', (payload) => {
  // payload.tool, payload.repoRoot, payload.value (the tool's JSON result)
})
```

| 事件 | 触发时机 |
|---|---|
| `tower/init` | `tower_init` 创建或重新锚定 state 之后 |
| `tower/plan` | `tower_plan` 创建 mission 之后 |
| `tower/mission` | `tower_mission` 修改单个 mission 之后 |
| `tower/spawn` | `tower_spawn` 记录 worker/reviewer 之后 |
| `tower/complete` | `tower_complete` 记录完成报告之后 |
| `tower/review` | `tower_review` 记录审查结论之后 |
| `tower/merge` | `tower_merge` 返回之后（包括门禁失败；检查 `value.ok`） |
| `tower/rebase` | `tower_rebase` 返回之后 |
| `tower/teardown` | `tower_teardown` 移除 worktree 之后 |
| `tower/finding` | `tower_finding` 创建单条 finding 之后 |
| `tower/findings` | `tower_findings` 读取/列出/更新 finding 之后 |
| `tower/send` | `tower_send` 持久化消息之后 |
| `tower/inbox` | `tower_inbox` 确认消息之后 |
| `tower/interrupt` | `tower_interrupt` 停止运行中的 agent 之后 |
| `tower/diff` | `tower_diff` 读取 mission diff 之后 |
| `tower/adopt` | `tower_adopt` 对账 roster 之后 |
| `tower/roster` | `tower_roster` 读取 roster 之后 |
| `tower/status` | `tower_status` 读取面板之后 |
| `tower/preflight` | `tower_preflight` 评估门禁之后 |
| `tower/doctor` | `tower_doctor` 完成只读检查之后 |
| `tower/test` | `tower_test` 运行测试发现之后 |
| `tower/batch` | `tower_batch` 创建、查看或关闭 batch 之后 |
| `tower/resource` | `tower_resource` 获取/释放/查看租约之后 |
| `tower/import_legacy` | `tower_import_legacy` 保存旧版快照之后 |
| `tower/legacy_map` | `tower_legacy_map` 映射或列出旧 id 之后 |

`tower_mode`、`tower_control` 与 `tower_reload` 不发出 Tower 事件。payload 是 JSON：
`{tool, repoRoot, value}`。监听器抛错不会影响工具结果。

需要可持久审计的调用链时，请使用 `<git-common-dir>/dsh-tower/activity.jsonl` 与 `MISSIONS.md`；
事件是进程内的，不会重放。
