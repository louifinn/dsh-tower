# FAQ

[English](../faq.md) | **简体中文**

**什么时候该用 Tower，而不是 Agent Teams、Ralph、Workflow 或普通子代理？**
当输出是单个 Git 仓库中需要集成的变更时，用 Tower（需要独立结论时再开启审查）。只读探索或快速独立子任务用普通子代理；
横切的人类协作/设计决策用 Agent Teams；对同一目标反复新鲜尝试用 Ralph；程序化高扇出分析用 Workflow。
完整选择路径、场景与对比表见[什么时候用 Tower](guide/scenarios-and-philosophy.md)。

**可以同时把 Tower 和 Team/Workflow/Ralph 组合使用吗？**
同一会话中不能并发：Tower 模式会拒绝这些工具并清除 plan mode。请按阶段组合——先用 Workflow/Team
分析与决策，再启动 Tower 执行（可选审查）仓库变更。详见[完整指南](guide/scenarios-and-philosophy.md#4-tower-与其他-dsh-工作流模式的区别)。

**为什么 worker 刚完成，`tower_preflight` 就因 `no-review` 失败？**
只有在 `review.requireReview:true` 开启时才会如此：已完成的 mission 在等待独立审查。spawn 一个
reviewer；干净审查后门禁就会变绿。默认 `review.requireReview:false` 时审查可选，不会产生
`no-review` blocker。

**需要轮询 worker 吗？**
不需要。worker 的最终报告会送回本会话；`tower_roster` 显示实时活动。轮询只会浪费回合。

**`/tower` 显示模式已开启，但没有 `tower_control`。**
`mode.allowAgentControl` 关闭了。在 profile patch 中把它设为 `true` 并重启 DSH。

**合并钩子要跑几分钟，`tower_merge` 失败了。**
用更大的 `timeoutMs` 重试：`tower_merge({ missionId, timeoutMs: 1800000 })`。默认超时是 15 分钟，
合并输出最多缓冲 64 MB。钩子失败返回 `merge-hook-failed`，并保持仓库干净以便重试。

**合并提交已存在，但 Tower 说 mission 未合并。**
再次调用 `tower_merge`。它会检测已落地的合并提交（`reconciled`），或恢复“命令失败但提交已存在”的
情况（`recoveredFromFailure`）并记录。

**`tower_rebase` 返回 `alreadyMerged` 且什么都没改。**
正确：分支已经包含在基线中。此时调用 `tower_merge` 记录已落地的合并，而不是 rebase。

**可以要求强制独立审查吗？**
可以。在 profile 或仓库配置中设 `review.requireReview:true` 可开启全局审查门禁（默认 `false`，
即审查可选）。开启后可用 mission 级 `reviewPolicy:"none"` + 理由 + `gates.allowReviewExemption:true`
做更窄的豁免。`tower_review` 始终可用并记录结论。

**reviewer 能修改文件吗？**
不能。reviewer 使用只读的 `tower-reviewer` preset（没有 write/edit/pwsh）；reviewer spawn 之后分支
被改动，审查会被拒绝。mission 之外的问题用 `tower_finding` 记录，不要直接改文件。

**`tower_finding` 与 `tower_findings` 有什么区别？**
`tower_finding` 创建单条 finding（`open`）。`tower_findings` 是生命周期工具：列出/读取，并在
`open → triaged → fixed`/`wontfix` 之间流转（允许重新打开）。只有控制塔或 worker 可以修改状态；
roster 中的 reviewer 只能列出和读取。

**如何只给一个仓库设置配置？**
创建 `<git-common-dir>/dsh-tower/config.json`（普通检出通常是 `.git/dsh-tower/config.json`），
使用与 profile 配置相同的 JSON 分组（`review`、`merge`、`worktrees`、`spawn`，以及兼容别名）。
仓库配置层优先于 profile；单次工具参数又优先于两者。不需要重启，因为每次 Tower 工具打开仓库时都会
读取该文件。

**worker 能用 Tower 工具 merge 或 spawn 吗？**
不能。worker preset 只包含 mission/进度工具；merge 与 spawn 属于上级控制塔。

**worker 卡住或失控了，怎么停下它？**
用 `tower_interrupt({to:"worker-m1",reason:"..."})`；它会调用宿主子代理中断，并把 roster 条目记录为
`interrupted`。如果你已经中断过它并想要一个全新的 owner，用 `takeover:true` spawn。仍在运行的 worker
不能被接管（`takeover-refused`）。

**两个会话想驱动同一个仓库。**
开启 `mode.workspaceLock:true`：第一个调用仓库级工具的 Tower 会话拥有
`<git-common-dir>/dsh-tower/tower.lock`；其他会话会得到 `[tower:workspace-busy]`，直到 owner 执行
`/tower off` 或锁过期（`mode.workspaceStaleMs`）。

**能否不重启 DSH 就重载插件？**
可以，在装有 DSH HMR 服务的 profile 中：`/tower reload` 或 `tower_reload` 工具会对账 profile 并替换
变更的 linked 包。先运行一次 `npm run dev:hmr` 把仓库加入 profile 的 HMR 监视 root（然后重启 DSH
一次）；见[热重载](guide/hot-reload.md)。`plugin_manager` 的安装/更新本身就会即时生效。

**如何让完成证据成为强制要求？**
worker 可以给 `tower_complete` 传 `checks`；设置 `gates.requireChecks:true` 后，没有 checks 的
completed mission 会被阻止合并（`no-check-evidence`）。

**Tower 把状态存在哪里？**
目标仓库的 `<git-common-dir>/dsh-tower/state.json`、`activity.jsonl`，以及可供人阅读的
`MISSIONS.md`；模式状态在 `$DSH_HOME/tower-mode/modes.json`。worktree 位于检出旁边的
`.dsh-tower-worktrees/`。

**如何修改审查轮数上限或 preset？**
使用 `review.maxRoundsPerReviewer` 与 `spawn.workerPreset`/`spawn.reviewerPreset`；见
[配置](reference/config.md)。修改 profile 配置后重启 DSH。

**Tower 会把数据发到别处吗？**
不会。它没有遥测，也没有网络服务；所有状态都在本地。
