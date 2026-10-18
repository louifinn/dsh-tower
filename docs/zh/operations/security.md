# 安全模型

[English](../../operations/security.md) | **简体中文**

Tower 提供的是**协作层面的保证**，不是沙箱。需要理解哪些约束由插件强制执行、哪些依赖部署环境。

## 由插件强制执行的约束

- **审查绑定（开启审查时）。** `tower_review` 会记录它检查的分支 tip；开启 `review.requireReview` 后
  tip 变化会被门禁拒绝（`tip-moved`），除非一次干净且无冲突的 rebase 给予了豁免。reviewer 在 spawn
  之后修改分支会被拒绝（`reviewer must not modify the mission branch`）。
- **审查默认可选，可配置强制。** `review.requireReview:false` 是默认值；设为 `true` 才启用独立审查
  门禁。全局开启时，mission 级 `reviewPolicy:"none"` + 理由是更窄的豁免。关闭门禁时插件不强制职责
  分离；只应用于可信仓库或有人类监督的会话。
- **角色强制。** 调用方会根据 roster 解析。worker 的 mission 更新仅限于 task/blocker/note；
  `completed`、`abandoned`、扩大 scope 与清除 blocker 仅限控制塔，完成（连同未读消息/提交门禁）必须
  走 `tower_complete`。仅限控制塔的工具会以 `[tower:not-authorized]` 拒绝 roster 中的 worker。
  每个 mission 只能有一个活跃 worker；接管已停止的 worker 必须显式声明。
- **只读 reviewer preset。** `tower-reviewer` preset 从工具面移除 `write`、`edit`、`pwsh`、
  `tower_mission` 与 `tower_complete`；reviewer 只能读、看 diff、发消息、记录 finding 和提交审查。
- **Scope 门禁。** mission 只能修改其声明 scope glob 匹配的文件；越界改动会阻止合并。
- **Worktree 隔离。** worker 在独立 worktree 与分支上工作；主检出只会被 merge/teardown 触及。
- **人类掌握模式。** `/tower` 归用户所有。开启 `mode.allowAgentControl` 后模型可以切换，但必须
  给出理由；随包 patch 默认开启——设为 `false` 可让模式只由人类控制。
- **不自动恢复 goal。** 进入模式会暂停活跃 goal；退出时不会恢复它。
- **建议性 workspace 锁。** `mode.workspaceLock` 防止两个 Tower 会话意外驱动同一个仓库；它是同用户
  之间的协调锁，不是用户间的认证机制。

## 不由插件强制执行的约束（部署关注点）

- **沙箱。** Host 插件运行在文件系统沙箱之外；reviewer 的 shell 能力是在工具面层面移除的，但底层
  进程仍拥有 DSH 的 OS 权限。需要硬隔离的部署必须自行限制进程/用户。
- **reviewer 信任。** 审查是 reviewer agent/模型给出的背书；插件能把它绑定到提交，但无法证明
  reviewer 真的推理正确。高价值分支建议使用独立模型/角色。
- **仓库钩子。** `git merge` 会运行目标仓库的钩子（`pre-merge-commit` 等）。Tower 无法让这些钩子
  变安全；在不受信任的仓库上运行 Tower 前请先审查钩子。
- **HMR 重载。** 开启 `dev.hotReload` 时，`/tower reload`/`tower_reload` 会让 DSH 从磁盘重新导入
  插件。只为你信任的检出配置 HMR 监视 root；重载会执行这些文件当前的代码。
- **提示注入。** reviewer 会读取不受信任的分支内容（diff/评论）。只读 preset 限制了影响面，但模型侧
  没有绝对防护。
- **基线分支保护。** Tower 会写入本地基线分支；服务端的 branch protection/push 规则不属于本插件。

## 报告问题

不要在公开 issue 中粘贴密钥、token 或会话日志。见 [SECURITY.md](../../../SECURITY.md)。
