# 什么时候用 Tower，以及它与其他工作流的区别

[English](../guide/scenarios-and-philosophy.md)

Tower 不是所有多代理模式的替代品。它是**面向 Git 仓库变更的交付协议**：少量边界清晰的 mission、隔离的写入者、可选独立审查、证据与合并门禁。本页解释这些设计取舍、适用场景，以及什么时候 Agent Teams、Ralph 循环、Workflow 编排或普通并行子代理更合适。

如果只记一句话：**输出是需要经过受控合并落地的仓库变更时用 Tower；输出是探索、重复尝试或程序化扇出时用其他模式。**如果还需要独立审查，开启 `review.requireReview`。

## 1. 设计哲学

Tower 做了一组刻意的取舍，这解释了它的优势和成本。

### 1.1 仓库是责任单位

mission 不是聊天线程或任务卡，而是绑定到分支与 worktree 的契约：有声明式写范围、依赖、完成证据和可选审查记录。"改了什么、谁改的、凭什么说改对了"有持久答案，位于 `<git-common-dir>/dsh-tower/state.json` 与 Git 历史，而不只在对话里。

### 1.2 一个 mission 一个写入者

两个 agent 同时写同一分支会产生审查无法修复的竞争。Tower 强制每个 mission 只有一个 live worker；停止/中断后接管必须显式；每个仓库有 worker 上限。并行来自**不同 mission**，不是同一 mission 的多个写入者。

### 1.3 先契约后代码

计划阶段固定 scope、任务、依赖与审查策略，之后 worker 才开始。这种前置是有意的：控制塔可以检测 scope 重叠、串行化依赖，并告诉 reviewer "完成"具体意味着什么。这也是 Tower 不适合需求仍在探索阶段的工作的原因。

### 1.4 集成是独立的特权步骤

worker 永远不合并。控制塔运行 preflight；只有之后 `tower_merge` 才执行 `--no-ff` 合并。门禁重新检查 scope、base 新鲜度、任务、worktree 归属、worker 状态、测试与证据。开启审查时，reviewer 还会审查特定分支 tip，门禁检查审查绑定；职责分离（写代码者不批准、批准者不合并）在审查开启时生效。

独立审查默认可选：设 `review.requireReview:true` 才会强制（此时已完成 mission 必须带有绑定 tip 的 clean/merge 审查）。对敏感仓库建议开启；全局开启时仍可用 `reviewPolicy:"none"` + 理由 + `gates.allowReviewExemption:true` 做单个 mission 豁免。无论开关如何，都可以提交并记录 review。

### 1.5 证据优先于断言

"完成了"是声明；commit、diff、通过的测试回执、审查结论都是证据。Tower 全部记录：`tower_doctor` 检查环境，`tower_test` 记录发现，`tower_complete` 记录 checks，`tower_review` 把结论绑定到提交（开启审查时），`tower_batch` 只有在有限 mission 集合的必需证据齐全时才允许收口。

### 1.6 失败关闭，显式恢复

Tower 宁可显示 blocker，也不静默修复。stale worker 被标记而不是假设已死；脏 base 阻止合并；开启审查时，审查后 tip 变化阻止合并；merge 期间崩溃会留下持久 intent，由下一次 `tower_merge` 对账。代价是偶尔需要人工清理，收益是状态不会谎报已集成的内容。

### 1.7 人类拥有模式

Tower 模式改变会话姿态：收窄工具面并注入 mission 协议。随包 patch 允许模型给出理由后切换，但该模式存在的前提是人类需要交付纪律。进入会暂停活跃 goal 并清除 plan mode；退出不会静默恢复。Tower 激活期间刻意拒绝 `goal`、`todo`、Team 任务板、Workflow、Ralph 与普通 subagent 工具，避免两套编排协议争夺同一会话。

### 1.8 本地优先，无隐藏服务

Tower 是 Host 插件，只使用本地 Git、本地文件和 DSH subagent 服务；不 push、不调用云服务、不发送遥测。持久状态位于仓库 Git 元数据，重启后仍在，人类用普通 Git 工具即可查看。

## 2. Tower 适合的场景

先看速查表；下文逐项解释。

| 场景 | 具体例子 | 为什么用 Tower |
|---|---|---|
| 可拆成独立切片的特性 | 加 OAuth：`token 模型` → `callback 路由` → `UI 按钮` + 迁移，四个 scope 基本独立的 mission | 写入隔离、scope 预留、最终统一合并（可选审查） |
| 有顺序的迁移/重构 | monorepo 重命名 `oldApi`：codemod → import 清理 → 快照 → 文档，每步依赖前一步合并 | `deps`、分支新鲜度、合并串行 |
| 先调查再修改 | survey mission 映射已弃用 crypto API 的所有调用者；两个 build mission 迁移与补测试 | survey 不能改文件；findings 喂给 build |
| 敏感或发布绑定变更 | 支付服务改动或公共库发布，需要测试证据与可审计合并（需要独立结论时开启审查） | checks/testRuns、可选审查绑定、人类可审计 |
| 长期工作 | 多日依赖升级，期间重启、换会话、上下文重置 | mission/roster/review/worktree 持久 |
| 硬集成边界 | monorepo 四个服务各有 owner，最后统一发布合并 | 多 mission 并行，单一合并门禁 |
| 可检查的完成定义 | 任务清单 + 必需测试 + 可选独立审查结论 | 另一个 agent 能检查证据 |

### 2.1 能自然拆成独立切片的特性

例：OAuth 登录拆成"token 模型"、"callback 路由"、"UI 按钮"、"迁移 + 测试"。切片大多改不同文件，可以并行，最后统一合并（需要时再加审查）。Tower 的 scope 预留与重叠自动依赖可以避免碰撞。

**为什么用 Tower：** 并行写入被隔离；每个切片有 owner，需要时再审查；合并在最后统一门禁，而不是逐段即兴处理。

### 2.2 有顺序约束的迁移或重构

例：重命名包、更新 import、重生成快照、再更新文档。部分工作可并行，但后续 mission 依赖前面的合并。Tower 记录 `deps`，依赖未合并时拒绝合并当前 mission，控制塔用 `tower_status`/preflight 检查图，而不是靠聊天记忆。

**为什么用 Tower：** 依赖图和分支新鲜度是被执行的，不是建议。

### 2.3 变更前需要只读调查

例："找出这个 API 的所有调用者并写迁移计划" 之后 "执行迁移"。`survey` mission 不预留写范围，改了文件会被拒绝；findings 可以喂给 build mission。Tower 还允许用 `tower_finding` 记录 mission scope 之外的问题，而不静默扩界。

**为什么用 Tower：** 调查与修改有不同契约；survey 不会"顺手修一下"。

### 2.4 敏感仓库或与发布绑定的变更

例：支付服务、有外部用户的库、release 分支。你需要测试证据和人类可审计记录；开启审查时，还会得到独立 reviewer、特定被审查 commit 与绑定 tip 的结论。

**为什么用 Tower：** 证据门禁、`MISSIONS.md`、活动日志和可选测试发现提供了可辩护的记录；开启审查时，reviewer 是独立的只读 agent，不是作者，结论绑定 tip。

### 2.5 跨上下文压缩或重启的长期工作

例：多日重构，期间重启、开新会话或上下文重置。mission 状态、roster、inbox、reviews、worktree 都是持久的；`tower_adopt` 对账丢失的 roster；`tower_doctor` 报告问题；`tower_merge` 对账已落地的合并。

**为什么用 Tower：** 协议可以从本地状态与 Git 重建，而不是从对话窗口重建。

### 2.6 有硬集成边界的并行工作

例：monorepo 中四个独立服务，各有 owner，最后统一发布合并。Tower 给每个 mission 分支/worktree 并预留写范围；控制塔可用 `tower_batch` 审计有限的发布证据。

**为什么用 Tower：** 并行是真的，但集成仍然是一个统一的、带门禁的步骤。

### 2.7 需要另一个 agent 能检查的"完成定义"

例：任务清单 + 测试 + 可选审查结论。Tower 的 mission 契约与 completion/review 工具让"完成"可观察。如果你的完成定义只是"用户在聊天里满意"，Tower 是过度设计。

## 3. Tower 不适合的场景

| 场景 | 更合适的模式 | 原因 |
|---|---|---|
| 单文件修改、typo、小 hotfix | 普通会话中的单个 agent | worktree 与合并开销（开启审查时再加审查）大于收益。 |
| 需求仍在发现阶段 | 普通 agent、Plan mode 或 Agent Teams | Tower 要求先给 scope/tasks；错误契约会导致重新规划。 |
| 开放式研究或头脑风暴 | Agent Teams、Workflow 或普通子代理 | 没有要隔离和合并的仓库变更。 |
| 很多极小的独立任务 | Workflow 或普通并行子代理 | 每个 mission 的合并成本（开启审查时再加审查）太高。 |
| 交互式 UI 配对或探索式调试 | 普通 agent（或单个 worker） | 需要紧密反馈与频繁人工引导，开启审查时门禁增加延迟。 |
| 一次性生成、没有集成 | 普通子代理/Workflow | 不需要分支、审查、合并决策。 |
| 跨仓库产品工作 | Agent Teams + 普通工具 | Tower 只作用于单个 Git 仓库。 |

一个有用的判断：**如果你不会为它开 PR，Tower 很可能太重了。**

## 4. Tower 与其他 DSH 工作流模式的区别

这些模式可以共用同一个 subagent 运行时；区别在于**什么是持久的、谁拥有集成、以及"完成"意味着什么。**

| 维度 | Tower | Agent Teams | Ralph 循环 | Workflow 编排 | 普通并行子代理 |
|---|---|---|---|---|---|
| 主要目标 | 交付经门禁集成的仓库变更（可选独立审查） | 围绕共享目标协作 | 对同一目标用新鲜 agent 反复尝试 | 程序化扇出/流水线 | 并行探索或实现 |
| 工作单位 | mission（分支 + worktree + scope + 任务 + 可选审查） | 共享任务板上的任务/teammate | 轮次/尝试 | 脚本步骤/阶段 | 每个子代理一个 prompt/任务 |
| 隔离 | 每 mission 独立 worktree/分支；单写入者 | 共享工作区；靠任务归属协调 | 每轮新 child；无内置分支/合并契约 | 每步 child；无 Git 隔离 | 子会话；可能共享工作区 |
| 持久状态 | Git 元数据 + JSON state + 活动日志 + 看板 | Team 任务板 + 会话 | 很少；每轮从零开始 | 运行记录/结果；不是合并账本 | 会话/子代理记录 |
| 集成权限 | 仅控制塔，经 preflight/merge 门禁（可选再加审查） | 人类/teammate 手动合并或编辑 | 通常由父 agent/worker 应用结果 | 脚本应用结果 | 父 agent 应用结果 |
| 审查/门禁 | 可选独立审查（`review.requireReview` 开启）+ preflight/merge 门禁 | 审查是协作约定，不是硬门禁 | 无内置审查门禁 | 无内置审查门禁 | 无内置审查门禁 |
| 并行度 | 多 mission、互斥 scope、合并串行 | 多 teammate、共享任务板 | 顺序轮次（或外部扇出） | 高扇出，由脚本控制 | 高扇出 |
| 人的角色 | 拥有模式；可检查证据与发布 | 协作者/协调者 | 重复目标的作者 | 编排脚本作者 | 委派者 |
| 最适合 | 特性交付、迁移、发布绑定变更 | 设计、研究、横切协作 | 迭代搜索/修复，需要新鲜上下文 | 大规模审计、批量分析、确定性流水线 | 快速探索或独立子任务 |
| 主要成本 | mission/审查/合并开销；合并串行 | 协调开销；无隔离保证 | 重复劳动；集成契约弱 | 脚本复杂度；无审查/合并语义 | 无隔离/审查；手动集成 |

### 4.1 Tower vs 普通并行子代理

普通 `subagent`/`subagent_fork` 便宜灵活，适合"并行读五个文件"或"试三种方案"。它们不提供写范围、专用 worktree、持久 mission、独立审查或合并门禁。Tower 用这些契约包装同一个子代理原语，因此每个 child 更贵。

只读、短生命周期、或你准备自己集成结果时，用普通子代理；结果必须落到分支并经受控合并时，用 Tower；需要独立审查时再开启 `review.requireReview`。

### 4.2 Tower vs Agent Teams

Agent Teams 是**协作**模式：共享任务板、持久 teammate、消息、wait/interrupt，以及人类/Lead 协调。它适合横切、探索性或需要多视角的工作，且集成决定通常由人类做。

Tower 是**交付**模式：mission 契约、Git 隔离、可选审查门禁与硬合并门禁。它的点对点协作更少、结构更多。Agent Teams 可以决定"做什么、是否继续"；Tower 可以把决定执行成 mission。二者应顺序或互补，而非并发：Tower 模式会拒绝 Team 任务板工具，避免两套协议争抢同一会话。

### 4.3 Tower vs Ralph 循环

Ralph 用新鲜 agent 一轮轮执行**同一目标**，以工作区为长期记忆。它适合迭代搜索、修复 flaky、以及"换上下文再试一次"。它没有 mission 契约、独立审查或合并门禁。

Tower 是增量的：每个 mission 有边界清晰的交付物，并经合并门禁落地（开启审查时再经审查）。如果问题是"我不知道能不能做成，反复新鲜尝试也许能找到路"，Ralph 往往更合适；如果问题是"我知道切片，需要安全地构建并集成"，Tower 更合适。可以在 Tower 模式之外先用 Ralph 找到方案，再把结果编码成 Tower mission。

### 4.4 Tower vs Workflow 编排

Workflow 是**程序化编排**：JS 脚本把工作扇出到许多 subagent，带阶段、pipeline 与结构化结果。它适合审计、批量迁移、多角度研究与对抗性验证。它不为每一步提供 Git worktree、审查结论或合并门禁。

Tower 是**仓库交付协议**，mission 数量少，不是高扇出数据平面。用 Workflow "并行分析 200 个文件"；用 Tower "把分析证明需要的 6 个修改，经可选审查与合并门禁落地"。Tower 模式会拒绝 Workflow，避免脚本在 Tower 契约下制造竞争写入。

### 4.5 Tower vs Plan mode

Plan mode 决定做什么；Tower 把已决定的计划执行到仓库。进入 Tower 会清除活跃 plan（`mode.planModePolicy:"refuse"` 时拒绝进入），且 Tower 会话不能使用 goal/todo/team/workflow 工具。先规划，再执行；不要指望 Tower 替你发现计划。

### 4.6 审查默认可选

`review.requireReview:false` 是默认值，因此低风险仓库、临时工作或人类逐轮监督的会话可以在没有
reviewer 时合并已完成 mission。设为 `true` 才启用强制独立审查门禁；此时检查 `no-review`、
`not-clean`、`review-hold`、`review-not-approved`、`tip-moved`、`review-mission-mismatch`。
`tower_review` 始终可用并记录结论。只豁免单个 mission 时，在全局开启的前提下用
`reviewPolicy:"none"` + 理由 + `gates.allowReviewExemption:true`。

### 4.7 各工作流的具体例子

**Tower** —— 输出是必须经过隔离与合并门禁落地的仓库变更（可选独立审查）：

- **OAuth 登录**：四个 mission（`token 模型`、`callback 路由`、`接受/拒绝 API`、`UI`）；API 依赖 token 与邮件。
- **Node 18 → 22 升级**：先 survey 破坏性 API，再拆 codemod、测试更新、CI 配置、release notes 为独立 mission。
- **废弃 crypto 迁移**：只读 survey 映射调用点；build mission 按包替换。
- **发布硬化**：变更、迁移指南、release notes 三个 mission；打 tag 前用 `tower_batch` 收口必需测试。
- **monorepo 服务拆分**：每个包一个 scope 不重叠的 mission；最后一个审查 mission 检查集成。

**Agent Teams** —— 输出是决策、设计或横切协作，而不是单个可合并分支：

- 后端、前端、安全三个 teammate 做架构评审，把发现汇总到共享任务板。
- 事故复盘：一人重建时间线，一人查日志，一人起草行动项。
- 产品需求发现：多视角收敛成规格，由人类决定做什么。
- 没有单一仓库可隔离/合并的跨仓库调查。

**Ralph 循环** —— 输出是对*同一目标*的新鲜尝试：

- flaky 测试需要多轮独立复现与修复。
- 性能优化每轮换一个假设，对 eval 反复尝试。
- 父 agent 不知道路径的"找到任意可行方案"探索。
- 反复调 prompt/skill 直到 eval 阈值达标。

**Workflow 编排** —— 输出是大规模程序化扇出或流水线：

- 审计 200 个文件的不安全 API 用法并生成结构化报告。
- 对多包/多版本并行跑依赖升级矩阵。
- 多角度研究或对提案做对抗性验证。
- 批量生成/翻译/测试独立产物并聚合结果。

**普通并行子代理** —— 输出是快速的只读并行或独立探索：

- 并行读五个候选文件并分别总结。
- 同一函数写三种实现并比较。
- 扫描仓库中的风险模式但不修改。
- 父 agent 写答案前做独立的文档查找。

**混合阶段（推荐）** —— 用 Workflow/Teams 分析，用 Tower 交付：

1. Workflow 审计 200 个文件 → 结构化 findings。
2. Agent Teams 评审 findings，决定前六个改动。
3. Tower mission 实现这六个改动，经可选审查与合并门禁落地。
4. 合并后仍有一个顽固 flaky 测试、且不需要新 mission 契约时，再用 Ralph。

## 5. 具体场景示例

### 场景 A：四切片特性

要做"组织邀请"：token 模型、邮件发送、接受/拒绝 API、UI。

1. 规划四个 build mission，scope 分别 `src/tokens/**`、`src/email/**`、`src/api/invites/**`、`src/ui/invites/**`；让 API 依赖 token 与 email。
2. 对独立 mission 启动 worker；API 等依赖完成。
3. 每个 worker 在自己分支提交，带 checks 完成。
4. 若开启 `review.requireReview:true`，启动 reviewer 并要求 clean + merge；否则审查可选。
5. 逐 mission `tower_preflight` + `tower_merge`，处理 scope/base/review blocker。
6. `tower_teardown`；`MISSIONS.md` 是人类可读记录。

**为什么不用 Team/Workflow？** 这是已知的仓库变更集合，需要按顺序经受控合并落地（可选独立审查）。Team 任务板不隔离写入；Workflow 会分析但不会门禁合并。

### 场景 B：带 survey 的迁移

1. Survey mission："映射 `oldApi` 的所有调用者"，scope 为空，只读。
2. Build mission：codemod、测试更新、文档；依赖 survey 结果。
3. 开启审查时，Reviewer 对照 survey 检查 diff；测试门禁仍校验当前分支 tip。默认审查可选时，可跳过 reviewer，仍受门禁/测试约束。
4. 按依赖顺序合并。

**为什么不用普通子代理？** survey 不能误改；codemod 不能越界；开启审查时，审查必须绑定精确提交。

### 场景 C：事故 hotfix

生产一行修复。用普通 agent，按你正常的提交/推送流程处理。Tower 会额外增加 worktree、合并门禁与（开启时）reviewer；对一行紧急修复主要是延迟。如果"hotfix"实际是多个协调变更，Tower 才合理。

### 场景 D：大范围代码审计

"找出所有已弃用 crypto 的用法并总结风险。" 用 Workflow 或并行子代理；没有要合并的分支，也没有单一被审查变更。如果审计产出一组修复，再从这些 findings 创建 Tower mission。

### 场景 E：敏感发布

有外部用户的库发布。为变更、迁移指南、release notes 规划 mission；如发布需要独立审查，开启 `review.requireReview:true`；要求测试，并用 `tower_batch` 只有在所有必需检查齐全时才收口发布证据；按你的发布流程在 Tower 之外合并/打 tag。

## 6. 实践中的选择路径

1. **输出是 Git 变更吗？** 否 → 普通 agent、Agent Teams、Workflow 或 Ralph。
2. **你会为它开 PR 吗？** 否 → Tower 太重，用普通 agent。
3. **切片有稳定 scope 和已知完成定义吗？** 否 → 先规划/探索，再回到 Tower。
4. **需要合并门禁吗？** 有集成风险的仓库变更 → Tower；如果还需要独立审查，开启 `review.requireReview:true`。两者都不需要时，普通子代理可能足够。
5. **需要大量并行分析或重复新鲜尝试吗？** 那个阶段用 Workflow/Ralph；把结果编码成 Tower mission。
6. **需要横切的人类协作吗？** 用 Agent Teams 决定；用 Tower 执行决定的仓库工作。

## 7. 成本、限制与反模式

- **每个 mission 有真实开销**：worktree、spawn、完成检查、可选审查轮次、门禁、合并。mission 应有意义（大致 PR 大小），不要一个函数一个 mission。
- **合并会串行**：重叠 scope 自动加依赖；独立 mission 仍然逐个合入 base。合并密集的工作不要期待线性加速。
- **审查不是免费的（开启时）**：每个 mission 需要 reviewer 与 clean 结论；`review.requireReview:false`（默认）让审查可选；开启后豁免是显式且需要理由。
- **过细的 mission** 增加协调与合并成本；**过粗的 mission** 失去并行审查收益，scope 冲突概率高。
- **Tower 不是沙箱**：它是协调协议；Host 权限、仓库 hooks、测试命令仍以 DSH 用户的 OS 权限执行。
- **不要同时跑两套编排协议**：Tower 模式会拒绝 Team/Workflow/Ralph/subagent 工具并清除 plan mode；请顺序分阶段。
- **不要用 Tower 掩盖需求缺失**：错误的 mission 契约会产出错误分支，然后在审查失败。先探索。

## 8. 开始前的检查清单

- [ ] 工作会产生值得 PR 式审查的仓库变更。
- [ ] 我能列出 2–8 个 scope 不重叠、依赖顺序大致的 mission。
- [ ] 每个 mission 有可测试的完成定义（任务、checks/测试、可选审查）。
- [ ] 如果这次变更需要独立审查，已开启 `review.requireReview`（默认关闭）。
- [ ] 我知道哪些 mission 可并行、哪些必须等待。
- [ ] 我接受合并门禁开销（以及开启审查时的审查开销），并会检查 `MISSIONS.md`/分支。
- [ ] 当前没有在同一会话依赖 Team 任务板、Workflow 脚本、Ralph 循环或 plan mode。
- [ ] 如果 worker 卡住（interrupt/adopt）或合并冲突，我有恢复路径。

多数勾选时，Tower 很可能合适；否则先用更轻的模式，等变更成形后再回来。
