# 安全模型

[English](../../operations/security.md) | **简体中文**

Tower 提供的是**协作层面的保证**，不是沙箱。需要理解哪些约束由插件强制执行、哪些依赖部署环境。

## 由插件强制执行的约束

- **审查绑定（策略为 required 时）。** `tower_review` 会记录它检查的分支 tip；策略为
  `review.mode:required` 时，tip 变化会被门禁拒绝（`tip-moved`），除非一次干净且无冲突的 rebase
  给予了豁免。reviewer 在 spawn 之后修改分支会被拒绝（`reviewer must not modify the mission branch`）。
- **审查默认可选，可由三态策略强制。** `review.mode` 取 `off`、`optional`（默认）或 `required`。
  设为 `required` 才启用独立审查门禁。策略为 required 时，mission 级 `reviewPolicy:"none"` + 理由是
  更窄的豁免。策略为 `off` 时审查被有意关闭；为 `optional` 时插件不强制职责分离，只应用于可信仓库或
  有人类监督的会话。该策略是插件页上的一个控件，不是组件行。
- **角色强制。** 调用方会根据 roster 解析。worker 的 mission 更新仅限于 task/blocker/note；
  `completed`、`abandoned`、扩大 scope 与清除 blocker 仅限控制塔，完成（连同未读消息/提交门禁）必须
  走 `tower_complete`。仅限控制塔的工具会以 `[tower:not-authorized]` 拒绝 roster 中的 worker。
  每个 mission 只能有一个活跃 worker；接管已停止的 worker 必须显式声明。
- **只读 reviewer preset。** `tower-reviewer` preset 从工具面移除 `write`、`edit`、`pwsh`、
  `tower_mission` 与 `tower_complete`；reviewer 只能读、看 diff、发消息、记录 finding 和提交审查。
- **Scope 门禁。** mission 只能修改其声明 scope glob 匹配的文件；越界改动会阻止合并。
- **模式控制显式且可配置。** `/tower` 始终可用。`mode.allowAgentControl:true`（默认）时，模型也可以
  带必填理由用 `tower_control` 进出；每次变更记录操作者与理由。设为 `false` 则仅人类可控制模式。
  重点是变更可归因，而不是固定由某一方拥有。
- **不自动恢复 goal。** 进入模式会暂停活跃 goal；退出时不会恢复它。
- **建议性 workspace 锁。** `mode.workspaceLock` 防止两个 Tower 会话意外驱动同一个仓库；它是同用户
  之间的协调锁，不是用户间的认证机制。

## 仓库保护

本节描述的是**本仓库**，不是 Tower 所操作的仓库。服务端分支保护不是插件功能——Tower 只写入本地基线分支，无法配置远端——但 `dsh-tower` 为自己的 `main` 开启了保护，因为门禁代码本身也是攻击者最想修改的代码：

- `main` 的所有变更都必须经过 pull request，且**对 admin 同样生效**，因此维护者也无法直接 push。
- 必需检查为 `test (22)`、`test (24)` 与 `mount`。mount 任务会打包压缩包并在一次性 profile 中启动，所以“测试通过”不能把一个安装后不出现的 bundle 合入。
- 禁止 force-push 与删除分支，已发布 tag 的历史不能被改写。
- 不要求强制审批：只有一个维护者时，自我审批只是橡皮图章。替代它的是 two-key 路径的四行 PR 正文（failure mode、change、test、blast radius），见 [CONTRIBUTING.md](../../../CONTRIBUTING.md#landing-changes)。

它带来的保证：未经验证的变更无法进入 `main`，必需检查变红或缺失时连所有者也不能绕过，历史只追加。它**不**提供：第二个审阅者、对泄露的维护者 token 的防护，或对 Tower 所操作仓库的任何保护——那些仍是部署关注点。设置、理由与校验命令记录在 [SECURITY.md](../../../SECURITY.md#repository-protection-on-main)。

## 模型主动进入模式的威胁模型

`mode.allowAgentControl:true` 意味着仓库文件、issue 文本或抓取页面中的提示注入可以让模型“进入
Tower 模式并修复它”。Tower **不认证**这句话背后的人类意图。它提供的是：

- 进入会记录操作者、动作、理由与时间；`tower_status.mode.history` 直接展示最近的模式切换，
  不必手工 grep 活动日志；
- 模型不能绕过 preflight 门禁、review policy、scope、测试与 clean-base 检查；自己写 plan 也不会
  自动获得合并权；
- worker 的工具面受限并被要求留在 worktree，但主检出保护来自 scope/merge 检查与 preset，
  **不是** OS 沙箱；
- `mode.workspaceLock` 防止第二个 Tower 会话驱动同一仓库。

它**不**防御：完全通过所有门禁但被恶意指令操纵的模型；仓库自己声明的 hooks/测试命令；或无视
指令、通过 shell 访问 worktree 之外文件的 worker。更高保证的团队应设
`mode.allowAgentControl:false`、保持审查策略为 `review.mode:required`、在运行 Tower 前审查仓库，
并用 OS 级隔离运行 host。

## 不由插件强制执行的约束（部署关注点）

- **Worktree 隔离是协议约定，不是 OS 沙箱。** worker 会被分配独立 worktree/分支并被要求留在其中，但
  `tower-worker` preset 仍包含 `pwsh`、`write`、`edit`；这些工具可写绝对路径或在主检出执行 Git。
  scope 门禁检查的是提交后的分支 diff，不是文件系统访问。硬隔离需要容器、独立 OS 用户或受限的 host
  工具策略。
- **沙箱。** Host 插件运行在文件系统沙箱之外；reviewer 的 shell 能力是在工具面层面移除的，但底层
  进程仍拥有 DSH 的 OS 权限。需要硬隔离的部署必须自行限制进程/用户。
- **reviewer 信任。** 审查是 reviewer agent/模型给出的背书；插件能把它绑定到提交，但无法证明
  reviewer 真的推理正确。高价值分支建议使用独立模型/角色。
- **仓库钩子。** `git merge` 会运行目标仓库的钩子（`pre-merge-commit` 等）。Tower 无法让这些钩子
  变安全；在不受信任的仓库上运行 Tower 前请先审查钩子。
- **测试发现是仓库代码。** `tests.admission` 默认 `off`，只有显式 `tower_test` 才会执行仓库
  `package.json` 的 `tower.testDiscovery` 命令；该命令以 DSH 的 OS 权限运行，不是沙箱。不可信仓库应
  设 `tests.allowPackageDiscovery:false`。
- **HMR 重载。** 开启 `tower-hmr` 组件行时，`/tower reload`/`tower_reload` 会让 DSH 从磁盘重新导入
  插件。只为你信任的检出配置 HMR 监视 root；重载会执行这些文件当前的代码。
- **提示注入。** reviewer 会读取不受信任的分支内容（diff/评论）。只读 preset 限制了影响面，但模型侧
  没有绝对防护。
- **基线分支保护。** Tower 会写入本地基线分支；服务端 branch protection/push 规则不属于本插件。本仓库自身 `main` 的保护见[仓库保护](#仓库保护)；为你运行 Tower 的仓库开启同等保护仍属于部署关注点。

## 报告问题

不要在公开 issue 中粘贴密钥、token 或会话日志。见 [SECURITY.md](../../../SECURITY.md)。
