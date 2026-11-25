# 工具参考

[English](../../reference/tools.md) | **简体中文**

仓库级工具不再接受 `repoRoot` 参数，只有 `tower_init` 保留该字段（它负责引导仓库）。其他所有
工具都在同一处解析仓库，顺序为：调用会话通过 workspace 锁绑定的仓库 → 会话工作目录 → 显式
`repoRoot` 字段（headless/嵌入式调用仍可使用）。位于 linked worktree 内的会话目录会解析到主
checkout，因此 worker 不会把 Tower 状态或看板写进自己的 mission worktree。
`tower_mode` 与 `tower_reload` 不需要仓库；`tower_reload` 是仓库可选的逃生通道（可在没有
仓库时重载损坏的 profile）。
## 工具集

本构建最多 23 个工具（全开）；默认 profile 注册 **18 个工具**：`tower_init`（`op:"init"`/`"adopt"`）、`tower_plan`、
`tower_spawn`、`tower_mission`、`tower_interrupt`、`tower_merge`、`tower_rebase`、
`tower_teardown`、`tower_send`、`tower_inbox`、`tower_finding`、`tower_inspect`（五个只读视图）、
`tower_complete`、`tower_review`、`tower_verify`、`tower_mode`、`tower_recover` 与 `tower_wait`。全部开启的构建面为
**23 个工具**：18 个默认工具加 `tower_batch`（`tower-batch`）、`tower_import`（`tower-import`）、
`tower_resource`（`tower-leases`）、`tower_test`（`tower-tests`）和 `tower_reload`
（`tower-hmr`）。`tower_inspect` 把 status、roster、diff、preflight、doctor 五个只读视图收进
一个工具，用 `view` 选择；`tower_init`、`tower_finding` 和 `tower_import` 把同一资源的动作
收进各自的 `op`。

每个 profile **实际挂载**的工具比构建面更窄。控制塔会话不挂载 `tower_complete`、`tower_review`
与 `tower_verify`——它们分别属于 worker/survey 与 reviewer 角色会话（#163 Phase 5、#202）。
从控制塔会话强行调用会得到可执行的 `not-authorized` 提示（指出
`tower_spawn({role:"worker"})` 或 `tower_spawn({role:"reviewer"})` 入口），
而不是 unknown tool。实测 profile：tower 15 个工具 / 20,903 B 输入 schema，worker 6 / 13,986 B，
reviewer 6 / 7,601 B；基线记录在 `docs/reference/surface-budget.md`。

## 默认关闭的子系统

下表的五个组件行在随附的 `cordis.patch.yml` 中带 `disabled: true`。关闭一行只会移除它的工具；
`tower_inspect` 的 `doctor` 视图会逐行列出工具与开启步骤，并报告
“disabled by component <id>”。开启方法是把该行的 `disabled` 设为 `false`（或删掉该标记）并
重启 DSH。

| 组件行 | 工具 | 开启方式 |
|---|---|---|
| `tower-batch` | `tower_batch` | 删除 `tower-batch` 行的 `disabled: true` 并重启 DSH |
| `tower-import` | `tower_import` | 删除 `tower-import` 行的 `disabled: true` 并重启 DSH |
| `tower-leases` | `tower_resource` | 删除 `tower-leases` 行的 `disabled: true` 并重启 DSH |
| `tower-tests` | `tower_test` | 删除 `tower-tests` 行的 `disabled: true` 并重启 DSH |
| `tower-hmr` | `tower_reload` | 删除 `tower-hmr` 行的 `disabled: true` 并重启 DSH |

工具仍然存在并留在全开 23 个之中：它们是关闭，不是删除。

## Reviewer 验证白名单（#202）

reviewer preset 没有 shell，因此 #202 之前评审只能复述 worker 的文字。`tower_verify` 给 reviewer
三件可在 mission worktree 中执行的只读检查——没有命令字符串、没有 shell，也没有任意参数列表：

| `kind` | 执行内容 | 参数 |
|---|---|---|
| `tests` | `node --test <files>` | `files`：1–30 个仓库相对的 `tests/*.test.mjs` 路径；绝对路径、`..` 段和 shell 文本都会在执行前被拒绝 |
| `tsc` | 用 worktree 自己的 `typescript` 运行 `--noEmit` | 无 |
| `shards` | 对默认 25 文件分片计划的某一批运行 `node --test` | `batch`：1 起的批次号（默认 1）；它不会跑完整套件 |

```
tower_verify({missionId:"M7", checks:[
  {kind:"tests", files:["tests/verify.test.mjs"]},
  {kind:"tsc"},
], timeoutMs:120000})
```

每个检查依次在 mission worktree 中运行，并以各自的 `runId` 记录进 `mission.testRuns`。结果行是
`{check, kind, command, status, exitCode, durationMs, summary, truncated, runId}`；`status` 为
`passed`、`failed`、`timeout`、`error` 或 `unavailable`。`timeoutMs` 默认 120000，必须在
5000–600000 之间；超时会先杀掉整个进程树再记录 `status: "timeout"`。两个平台的保证不同，但整次尝试
都以 2 秒为上限：

- **Windows**：只要被启动的 orchestrator 的 pid 仍可打开，就先对它执行 `taskkill /T`；只有在
  taskkill 无法运行、以非零退出或超出上限时，才回退到直接 kill。因为 `node --test` 会为每个测试
  文件启动一个子进程，先杀父进程会让 taskkill 以 128 退出而不枚举任何东西，把它们留成孤儿
  （F104/F105）。
- **POSIX（Linux、macOS）**：在发出任何信号**之前**先读取进程表（`ps -A -o pid=,ppid=`），从表中收集
  orchestrator 的传递闭包子孙，然后依次杀进程组（这也覆盖 orchestrator 自身）、杀收集到的每个子孙。
  只杀进程组不够：以 `detached: true` 启动的子孙会调用 `setsid(2)`，进入新的会话和进程组，进程组信号
  会报告成功而它仍在运行（F107）。`ps` 无法运行、以非零退出、输出无法解析或超出上限时，退化为进程组
  kill 加对 orchestrator 的直接 kill。worktree 缺少 `node_modules` 时 `tsc` 记录 `unavailable` 并给出补救：
  安装依赖，或用 M166 的 `spawn.nodeModules: "link"` 启动。该工具是只读的：不改变 mission 状态，除了 run
  收据之外不写任何东西。

证据是可引用的编号，不是自由文本。`tower_complete` 的 checks 支持 `{name, runId}`，
`normalizeChecks` 会拒绝不在该 mission `testRuns` 中的 `runId`；reviewer 可以在 `tower_review`
的 checks 中引用同一个 id（例如 `checks: ["run-3"]`，因为 review 的 checks 是字符串列表）。
只有 reviewer 角色能调用 `tower_verify`；worker 会话用自己的 `tower_test` 做 discovery，
控制塔 profile 不挂载该工具。

`tower_mission` 使用 `id`（别名 `missionId`）；其他所有 mission 级工具使用 `missionId`
（别名 `id`）。其他输入别名：`task_done`/`taskDone`、`task_drop`/`taskDrop`、
`task_drop_reason`/`taskDropReason`、`clear_blockers`/`clearBlockers`、
`include_read`/`includeRead`、`dry_run`/`dryRun`、`timeoutMs`/`timeout_ms`、
`tower_finding` 上的 `mission_id`/`missionId`、interrupt 上的
`agent_id`/`agentId`、`tower_inspect` status 视图上的 `include_gate`/`includeGate` 与
`include_archived`/`includeArchived`、`tower_init({op:"adopt"})` 上的
`retire_missing`/`retireMissing`。
别名仍被服务端接受，但不再出现在工具 schema 中（#163 Phase 2），因此不会在每次请求中占用字节。
输出始终使用规范的 camelCase 字段名。

## 基线一致性检查

`tower_plan` 与 `tower_spawn` 在检出不是记录的基线时拒绝执行。它们在任何状态写入或启动 agent 之前
比较实时 HEAD 与 `state.base`；分支不同（或 HEAD detached）会抛出 `[tower:base-mismatch]`，同时给出
两侧与两种补救方式：检出记录的基线，或在确认该检出就是目标基线且没有进行中的 mission 时运行
`tower_init({base:"<branch>", reanchor:true})`。被拒绝的调用不写任何状态，因此在错误分支上规划不会
再“成功”到合并时才让 mission 搁浅（#215）。`tower_inspect` 的 `status` 并排显示 `base` 与 `head`，
两者不同时追加 `baseWarning`；`headDetached` 标记 detached 检出。`tower_init({reanchor:true})` 在存在
非终态 mission 时仍会拒绝，并列出阻塞的 mission id。

## 每个仓库只有一个姿态

Tower 模式与 Ralph 循环（`@deepseek-ai/dsh-tool-ralph`、社区版 `dsh-ralph`，或同一姿态的任何其他实现）
在每个仓库上互斥：Tower 模式激活期间 `/ralph` 命令会被遮蔽（命令不是工具，由命令属主表覆盖）、
其工具名由 #161 的属主派生 `mode.denyTools` 默认值拒绝、带活跃循环进入 Tower 模式会停止并记录该循环或拒绝进入
（`mode.ralphPolicy`，默认 `stop`），且仓库处于 Tower 模式期间 round agent 会被拒绝——因此改名的入口
无法在活跃控制塔下重启循环。`tower_inspect` 的 `doctor` 视图把活跃循环报告为环境事实。Tower worker **内部**的
Ralph 循环不是冲突：worker 在自己的隔离 worktree 里拥有一个 mission，并通过 `tower_complete` 汇报。
见 [ADR 0010](../../adr/0010-tower-ralph-mutual-exclusion.md)。

## 角色

roster 角色由 `exec.agent` 与 roster 共同决定。mission 级工具（`tower_interrupt`、
`tower_init`、`tower_plan`、`tower_spawn`、`tower_merge`、`tower_rebase`、`tower_teardown`）
**仅限控制塔**，`tower_init({op:"adopt"})` 与 `tower_mode` 的写操作也一样。`tower_complete` 与 `tower_review` 分别由 worker/survey 与 reviewer 角色会话挂载；控制塔会话不挂载它们，误用会得到 `not-authorized` 提示并给出 `tower_spawn` 角色入口或切换模式的替代路径。`tower_reload`
仅限控制塔，并且是 `host/tool-profiles.js` 中唯一登记为仓库可选的工具：它可以在没有仓库时
运行以重载损坏的 profile；传入 `repoRoot` 不会改变这一行（仍受 `tower-hmr` 组件行控制）。
`tower_batch` 的 create/close/abandon、`tower_resource` 的 acquire/release、`tower_import`
以及 review-exemption 规划仅限控制塔；`tower_import` 的只读 `status` 动作对 roster 角色开放。worker 调用 `tower_mission` 时只能使用
`task_done`/`task_drop`/`blocker`/`note`；状态变更、scope 编辑与扩大、`deferred`、`clear_blockers` 与 `completed`
仅限控制塔（完成必须走 `tower_complete`）。roster 中的 reviewer 可以读取 finding，但不能修改。
违规会抛出 `[tower:not-authorized]` 或 `[tower:invalid-transition]`。

## 工具

| 工具 | 参数 | 用途 / 说明 |
|---|---|---|
| `tower_init` | `op?`（`init` 默认 / `adopt`）、`repoRoot`、`base?`、`auto_git_init?`、`snapshot_dirty?`、`reanchor?`、`retire_missing?` | `op:"init"` 创建 `<git-common-dir>/dsh-tower/state.json`。唯一声明 `repoRoot` 的工具（引导）；它优先于会话目录，以便显式初始化指定目标。`auto_git_init` 执行 `git init` 并创建空的初始提交；`snapshot_dirty` 记录一个游离快照提交作为 mission 基线；`reanchor` 仅在没有非终态 mission 时修改基线（拒绝时会列出阻塞的 mission id）。`op:"adopt"` 把 roster 与持久目录对账：可证明已消失的 agent 会被标记为 retired（默认），或标记为 `missing`（`retire_missing:false`）。`op:"adopt"` 还会返回 `missions[]`：对每个有 worktree 记录的非终态 mission 做只读残留报告，字段为 `{id, status, branch, tip, lastCommit:{sha, at}, worktreePath, dirty:{files, paths, sample}, lastActivityAt, class, suggestedAction}`；`class` 为 `dirty`、`clean`、`unmerged`、`missing`、`external` 或 `unknown`，`suggestedAction` 给出下一步（干净时为 `none`）。它不改变 `retire_missing` 语义。两个 op 都仅限控制塔。 |
| `tower_plan` | `missions[]`（`title`——可打印 Unicode，NFC 规范化，≤120 字符、`scope[]`、`tasks[]?`、`deps[]?`、`kind?`——`build`/`survey`/`artifact`、`artifacts[]?` ≤20、`context?`、`references[]?` ≤20、`reviewPolicy?`、`reviewExemptionReason?`、`allowMissingScope?`、`key?`），`dry_run?` | 创建 mission `M1..`；重叠的 build scope 会自动加依赖；拒绝未知依赖与依赖循环。`dry_run:true` 执行全部校验但不写状态、不创建 mission、不递增 revision：返回 `{dry_run, ok, revision, missions:[{index, key?, wouldBeId, title, kind, scope, deps, overlaps}], problems}`，其中 `wouldBeId` 是该 mission 将获得的 id，`deps` 已解析为 id，`overlaps` 列出与之 scope 重叠的已规划或开放 mission，`problems` 是完整问题列表（`kind` 为 `scope`/`mission`/`key`/`deps`/`cycle`/`component`），而不是只报第一个错误。真实创建失败时也会在 `details.problems` 中给出同一完整问题集。每个 mission 的 `key` 是本次调用中供 `deps` 引用的 plan 局部句柄（去除首尾空白、≤64 字符、不能呈 `M<n>` 形态、必须唯一且不会持久化）；依赖可以写已有 mission id、key 或 would-be id，循环仍会在创建任何内容之前被拒绝。它会先检查检出：HEAD 不是 `state.base` 时以 `[tower:base-mismatch]` 拒绝（同时给出两侧与补救路径），且不写任何状态。mission id 保持 ASCII（`M1`、`M2`）；不可见字符与超长标题会以 `invalid-argument` 拒绝。`kind:"artifact"` 在 `artifacts[]` 声明具体的交付物路径（不能是 glob，且必须位于 scope 内）；完成前这些路径必须已提交在分支末端，合并还要求人类接受该末端。`reviewPolicy:"none"` 需要非空理由；审查门禁开启时，preflight 还要求 `gates.allowReviewExemption`。`scope` 是相对仓库根目录的文件 glob 列表；目录形态的条目（`docs/guide/`，或规划时已存在的裸 `docs/guide`）会存成显式的子树 glob `docs/guide/**`——见下文“scope 条目”。规划时每个条目都会与 `git ls-files` 对照：落在已跟踪目录内却匹配不到任何已跟踪文件的条目会以 `invalid-argument` 拒绝，并指出最近的已存在前缀与该目录下最多 5 个已跟踪候选。若该路径确实是 mission 将要创建的，在对应 mission 上传 `allowMissingScope:true`；接受行为会记录为一条 `scope.unverified` 活动条目，存储的 scope 不变。在已有 planned/active build 工作时规划 `**` mission 还会返回非阻塞的 `broad-scope` 警告（见下文“planned 编辑、defer 与暂停”），指出它会把哪些 mission 挡在围栏外。 |
| `tower_mission` | `id`（别名 `missionId`）或 `missions[]`（每项 `{id, ...同名字段}`）/ `ids[]` 简写、`atomic?`、`status?`、`task_done?`、`task_drop?`+`task_drop_reason?`、`task_add?`、`blocker?`、`clear_blockers?`、`note?`、`scope?`、`allowMissingScope?`、`widen?`、`deferred?`、`pause_cause?`、`authorization?`、`fold_notes?`、`accept?`、`accept_note?` | 更新单个 mission。`task_add` 在任务列表尾部追加 1–20 个非空字符串（每个 ≤200 字符），状态为 `open`，且不会重排既有任务索引；planned、active、paused、blocked 的 mission 都允许，completed、merged、abandoned 会以 `invalid-transition` 拒绝且不改变状态。因此追加的 `open` 任务会一直阻止 `tower_complete`，直到被完成或丢弃。worker 可安全使用的字段是 task/blocker/note；不能在这里设置 `merged`。暂停的 mission 记录 `pause_cause`（user/failure/resource/dependency）；planned mission 暂停时必须显式给出原因，`status:"planned"` 会把暂停的 mission 退回规划（清除原因，无需授权），而恢复到 `active` 仍遵循 `mode.requireResumeAuthorization`。`scope` 编辑 planned mission 的围栏（保持 planned）、扩大 active 或 completed 的围栏（并启动它），遵循与规划相同的“必须匹配已跟踪文件”规则与目录展开。`scope` 搭配 `allowMissingScope:true` 可接受尚不匹配任何已跟踪文件的条目（mission 将要创建的路径），适用于 plan、planned 编辑或扩大；接受行为记录为一条 `scope.unverified` 活动条目，该标志不会写入 mission。`deferred` 让 planned 或 active 的拥有路径（build 或 artifact）mission 退出 widen 排序：为 true 时，其他 mission 的编辑或扩大可以与其 scope 重叠，传 false 重新加入；该标志只在 mission 处于 planned/active 时影响排序决策。`fold_notes:true`（仅控制塔、仅单条形式）是 review note 通道的审计动作：把本 mission 自己的 open review note 标为 `folded`，并为每条 note 追加一条 `done` 历史任务（`folded review note N3.2: …`），供发版准备引用为完成证据。整个调用只提升一个 revision、只记一条 activity，从不重开或阻塞 mission，并拒绝 review 行属于其他 mission 的 note。详见[阻塞性 finding、review note 与 filed finding](#阻塞性-findingreview-note-与-filed-finding)。`accept:true` 记录人类对 artifact mission 已提交末端的接受：工具会通过 DSH 审批通道询问人类，并把当前分支末端写入记录；没有该通道时以 `approval-unavailable` 拒绝，任何参数都不能让接受变成 agent 自批（worker 调用会以 `acceptance-human-only` 拒绝）。批量形式是一个封闭对象：`missions` 每项携带与单条形式相同的字段（除 `accept`/`accept_note`，接受仍只限单条），`ids` 只应用生命周期字段，`atomic`（仅批量、默认 `true`）使整批 all-or-nothing——只增加一个 revision，每个 mission 一条活动外加一条 `mission.bulk` 记录，非法或未知 id 会在任何写入前回滚整批；`atomic:false` 按顺序应用并逐项报告 `{id, ok, mission?, error?, code?}` 与成功的 mission。单条输出保持不变。 |
| `tower_inspect` | `view`（`status`/`roster`/`diff`/`preflight`/`doctor`）、`missionId?`（diff/preflight 必填）、`maxBytes?`、`offset?`、`limit?`、`includeGate?`、`includeArchived?`、`format?`、`checks?`、`compact?`、`fields?`、`sinceRevision?`（别名 `since_revision`）、`agent?`、`tail?`、`stat?` | 五个只读视图共用一个工具：`status`（面板、单个 mission 详情、分页与 markdown 看板；`offset`/`limit` 分页（缺省 20，最大 100；回复包含 `total`/`offset`/`limit`/`nextOffset`——一页绝不是整张表，见 [status 的分页契约](#status-的分页契约)）；`fields` 把每个 mission 精确投影为指定字段；`format:"markdown"` 始终渲染完整看板，`sinceRevision` 只过滤 JSON 输出；`sinceRevision` 只保留在该 state revision 之后被逐行标记的行：`missions` 是过滤后的 mission 列表，`roster` 是过滤后的 roster 行**数**——roster 行本身来自 `roster` 视图（`agent`/`tail`），该视图忽略 `sinceRevision`；只有 spawn、interrupt 与 roster 写路径会给行打标记，而 `tower_plan`、`tower_mission`、`tower_complete`、`tower_test`（test-run 回执）、merge、review 与 worktree 写路径不写标记，正数时会漏掉这些变化（`0` 表示不过滤并返回全部行）；带 `missionId` 的 `status` 返回完整详情并忽略 `sinceRevision`；归档摘录不带标记，因此正数时 `includeArchived` 不会追加任何归档；test-run 回执（`testRuns`）只出现在 `missionId` 详情中，列表行里没有；每条回执带有持久 `id`（`run-N`），completion check 可用 `runId` 引用；带 worktree 的非终态 mission 还带 `worktreeDirty` 与 `uncommittedPathCount`，每个 mission 最多做一次有界 `git status` 读取，读不到时值为 null）、`roster`（子代理目录的实时活动、`stale` 标记、`lastObservedAt`（最后一次权威目录观测），以及死 agent 诊断字段 `failureReason`（最近一次激活失败的原因；任何非失败结果都会清除它）与 `previousOutcome`（被替换者退休前的 outcome）；`agent` 按名称或 agent id 选一行，`tail` 只保留最新 N 行；带 `agent` 时，`roster` 只返回该行的 `{agent, activity: [{at, event, text}]}`，不返回整张表（`tail` 默认 5，最大 50），`status` 带 `agent` 时只返回该行及其绑定 mission 与有界活动，而不是整个面板（`agent` 与 `missionId` 互斥；`status` 不带 `agent` 时是面板，没有可截断的 tail：`status` 上的 `tail` 必须搭配 `agent`，否则以 `invalid-argument` 拒绝而不是静默忽略（`roster` 不带 `agent` 时 `tail` 仍只保留最新 N 行）。带 `compact:true` 时，这两个 agent 视图只保留身份 `{name, role, missionId, state}`（`status` 还保留绑定 mission 的 `{id, status, kind}`），有界活动仍作为独立字段。）、`diff`（mission 分支的 merge-base diff；`stat:true` 用逐文件 `{path, added, deleted}` 计数替代 `patch`/`truncated`，二进制文件两项的值是 `null`，绝不返回 patch 字节）、`preflight`（合并门禁结果 `{ok, blockers[], warnings[], order[], cycle, ...}`；`warnings` 只作提示，绝不进入 `blockers[]`，也不改变 `ok`——例如 completion check 声称的 `command`/`exitCode` 没有任何已记录 test run 佐证时给出 `checks-unverified`；每个 blocker 带有序的 `resolution`，结果顶层带 `order`——依赖合并按祖先优先，随后是 `rebase`，再是其余步骤——以及 `cycle`：`null`，或一个指出相关 mission id 的 `dependency-cycle` 结论与 `break-dependency-cycle` 步骤；不能合并的依赖（survey）给出的步骤是完成它（`complete-mission`），而不是合并它；这里只做诊断，绝不自动 merge 或 rebase；artifact mission 报 `acceptance-missing`/`acceptance-stale`，而不是 review blockers）、`doctor`（环境与 state/git 锁健康，含 Ralph 姿态；`checks:true` 只返回 `{ok, checks}` 且保留完整检查行，`compact:true` 只返回 `{ok, checks}`，通过的检查收缩为 `{id, status}`，未通过的检查额外保留 `detail`；两者同时给出时 compact 优先）。从不写状态或 git；输出与原来的独立工具一致，并带 `view` 字段。diff/preflight 需要 `missionId`；roster/diff 仅对已知 roster 角色开放。 |
| `tower_spawn` | `missionId`（别名 `id`）、`op?`（`spawn` 默认 / `takeover`）、`role`（`worker`/`reviewer`）、`name?`、`instructions?`、`worktreeRoot?`、`wait?`、`includeDirtyBase?` | 准备或复用 worktree 并启动子代理。worker 使用 `tower-worker`；reviewer 要求 mission 为 `completed`，并使用只读的 `tower-reviewer`；`review.mode:off` 时 reviewer 角色会以 `[tower:review-disabled]` 被拒绝。`op:"takeover"` 替换已不再运行的 worker 条目（ownerGeneration 递增）；旧的 `takeover:true` 字段会以替代路径报错。`wait:true` 等待结果，上限由 `spawn.maxWaitMs`（默认 90000）决定；旧的 `waitMs` 字段会指向该配置路径报错。每个 mission 只能有一个活跃 worker；`spawn.maxLiveWorkers` 限制整个仓库。报告在 `worktree` 里给出放置方式：分支工作树为 `{path, branch, baseCommit}`，读取共享检出或游离 sandbox 的 survey 为 `null`。spawn 在准备前执行同样的基线检查，检出不匹配时不会启动任何 agent。`spawn.nodeModules:"link"` 时，spawn 会把 `<worktree>/node_modules` 创建为指向基线检出已安装 `node_modules` 的 junction，并在 `mission.worktree.nodeModulesLink` 与 roster 行上记录 `{target, path, createdAt}`；目标必须已经存在（否则以 `invalid-argument` 与补救建议拒绝），报告中的 `nodeModulesLink` 与之相同。 |
| `tower_send` | `to`、`subject`、`body`、`scope?`、`interrupt?`、`wake?`、`consentRef?` | 向 roster 名称、`tower` 或 `all` 发送持久消息。运行中的 roster agent 会被 steer 进当前回合；已停止的 agent 会保留消息，等下次运行时读取。`interrupt:true`（仅 tower）先中断运行中的回合并投递。`wake:true` 为已停止的 agent 启动新回合；若该 agent 无法恢复，则抛出 `agent-not-resumable`。无法观测的活动状态（目录报错或返回空列表）绝不会被当成已停止：此时 `wake:true` 返回 `woke:false` 并说明未声称唤醒；显式 `interrupt:true` 仍会尝试并如实回报，而不是被静默跳过。`consentRef` 记录用于审计。受 `send.maxPerMinute` 限速。 |
| `tower_inbox` | `limit?`、`include_read?` | 读取并确认发给调用者的消息；未读消息会阻止 `tower_complete`。 |
| `tower_complete` | `missionId`（别名 `id`）、`report`、`checks?`、`files?` | worker 报告完成（mission 变为 `completed`，可进入 preflight 与可选审查）。要求当前 owner、无未完成任务/blocker、≥1 个提交、无未读消息；artifact mission 还要求全部声明的交付物都出现在已提交的末端。`report` 受 `gates.maxReportBytes`（默认 32768 UTF-8 字节）硬上限约束：超限会以 `invalid-argument` 拒绝并给出 `nextAction`（把全文写进 mission worktree 的文件），绝不截断；存储时会记录 `reportBytes`。`checks` 记录 `{name, runId?, command?, exitCode?, evidence?}` 证据：`runId` 指向本 mission `testRuns` 中的回执（由 `tower_test` 产生），未知或属于其他 mission 的 id 会在任何状态写入之前以 `invalid-argument` 拒绝；`command`/`exitCode` 声称没有任何已记录 run 佐证时，preflight 会给出提示性 `checks-unverified` 警告，而不是 blocker。`gates.requireChecks` 可以强制要求 checks。配置了测试发现时还会自动运行并添加 `tests` 检查；失败会抛出 `[tower:tests-failed]`。若该 mission 的 worker 已经停止——该行状态为 `retired`、`failed`、`interrupted`、`missing` 或 `stale`——则以 `[tower:invalid-transition]` 拒绝，消息为 `agent <name> is <state>; a stopped worker cannot report completion`，绝不会被静默接受。这条拒绝带有 `nextAction`（渲染为 `— next: …`），指明受支持的路径：在同一个 mission 上 spawn 一个短命的记账 worker，重新跑门禁并调用 `tower_complete`；绝不手工把状态设为 `completed`，因为手工设置的完成不会记录 report、checks 与证据（#232）。当死掉的行带有 `residue` 时，`nextAction` 会引用它（`the stopped worker left 3 file(s) changed on <branch>`）。`files` 是 worker 自己声明的、它碰过哪些路径（1–500 个仓库相对路径，每个 ≤400 字符，去重并排序）。它只是声明，不是权威：记录的 footprint 由完成时的分支 diff 推导。该 diff 以已记录基线与 mission 分支末端的 merge base 为锚点——与 `tower_inspect({ view: "preflight" })` 使用同一锚点——因此当其他 mission 落地后又被 rebase 的分支只会报告它自己的文件，绝不会把 rebase 重放到其下的基线侧路径算进来。存储的 report 带有 `footprint: {scope, scopeGeneration, widenAt, widenedTo, changed, insideScope, outsideScope, declared, mismatch, mismatchNote}`。`changed` 是 diff 与声明的并集，因此 worker 声明过但从未提交的文件仍会被点名；`insideScope`/`outsideScope` 用完成时的 mission 围栏、按该 checkout 检测到的大小写比较模式切分这个并集，因此记录与合并门禁不可能给出相反结论（只读形态会把全部路径放进 outsideScope）；`declared` 回显归一化后的声明；`widenAt` 是抬高 `scopeGeneration` 的那次 widen 活动记录的 `at` 时间戳，从未 widen 时为 `null`；当 `scopeGeneration > 1` 时 `widenedTo` 是完成时的 scope，否则为 `null`，这样后来的读者能区分计划内的围栏与 widen 后的围栏。声明与 diff 的不一致绝不会导致拒绝：`mismatch` 列出 `<file> (declared, absent from the branch diff)` 与 `<file> (changed, not declared)`（只有在存在声明时才产生），`mismatchNote` 用一句话重复它们。diff 无法读取时 footprint 会被省略，因为 git 失败绝不会让完成被拒绝。当完成落在围栏之外时，`tower_inspect` 的 `preflight` 视图会在 `out-of-scope` blocker 的 `detail` 中点名这些路径，并把完整列表放在 `blocker.details.outsideScope` 中。reviewer 简报只有在存在内容时才渲染 outside-scope 切分、mismatch 说明与 widen 说明，因此围栏内的完成不会给提示词增加噪音。footprint 搭载在既有的 `tower.mission.completed` 事件（`{missionId, revision, at}`）上；本次发布不为它新增事件。 |
| `tower_interrupt` | `to?`（roster 名称）、`agentId?`、`reason?` | 通过 `subagents.interrupt` 中断一个运行中的 roster agent，并记录 `state:"interrupted"`。幂等（未运行 → `interrupted:false`）。 |
| `tower_finding` | `op?`（`report` / `list` 默认 / `update`）、`id?`、`status?`、`note?`、过滤（`type?`、`severity?`、`missionId?`、`open?`、`limit?`）、`title?`、`summary?`、`details?`、`suggested_fix?`、`location?` | 一个 finding 生命周期（#163 Phase 4）。`report` 需要 `type`（bug/improve/vuln/idea）、`title`、`summary`、`details`、`suggested_fix`，新 finding 初始为 `open`；`list` 按 `id` 或过滤条件读取/列出；`update` 需要 `id` 加 `status`/`note`，状态为 `open → triaged → fixed`/`wontfix`，允许重新打开。只有控制塔或 worker 能修改；reviewer 只能列出/读取。 |
| `tower_review` | `missionId`（别名 `id`）、`status`（`clean`/`p1-Nitems`/`p2-Nitems`）、`merge`（`merge`/`fix-then-merge`/`hold`）、`findings`、`decision`、`checks?`、`notes?`（≤10 条，每条 ≤400 字符）、`breakGlassReason?` | 绑定当前 tip 的 reviewer 结论。reviewer 必须是获派的 reviewer（或由控制塔使用 break-glass）。`review.mode:off` 时不注册；仓库层为 `off` 时提交会以 `[tower:review-disabled]` 被拒绝。非 clean 结论使 mission 回到 active 后，其他 route 仍可为同一 reviewed tip 提交结论：追加到同一轮（`appended:true`），不再改变状态；tip 已移动时会被明确拒绝。同一轮内以记录顺序（`seq` 最大）最新的结论为准，merge gate、已落地合并检测、status 与 briefing 使用同一规则：同一轮中较晚的 clean 结论会取代较早的非 clean 结论。`notes` 是非阻塞通道：一组记录在 review 行上的简短观察，永远不属于 `findings`、不构成状态，也不被门禁读取——`clean` + `merge` 的结论可以携带 note 并照常合并。详见[阻塞性 finding、review note 与 filed finding](#阻塞性-findingreview-note-与-filed-finding)。 |
| `tower_merge` | `missionId`（别名 `id`）、`timeoutMs?`（别名 `timeout_ms`） | 门禁全绿后合并。若合并提交已落地则记录（`reconciled`）；若命令失败但提交已存在则恢复（`recoveredFromFailure`）；区分 `merge-hook-failed` 与 `merge-conflict`。 |
| `tower_rebase` | `missionId`（别名 `id`） | 在 worktree 内把分支 rebase 到基线。worker 运行中或 worktree 脏时拒绝。分支已包含在基线中时返回 `alreadyMerged` 且保持分支不动。 |
| `tower_teardown` | `force?`、`exclude?`、`orphans?`、`dry_run?`（别名 `dryRun`） | 移除符合条件的 merged/abandoned worktree 与分支；运行中的 agent 始终保留。每次移除对临时锁（EPERM/EBUSY/EACCES）最多重试三次，决策中带有 `attempts`；永久失败会保留 mission 记录并报告最终错误。最后一次归档扫描在 `tower-archive` 组件行挂载时按 `archive` 策略执行，`archived` 列出被归档的 mission id。`dry_run` 不写入任何内容，并返回 `archivePreview`（`{missions: [{missionId, reason}], year}`），它由同一策略输入计算，并按本次运行计划完成的 worktree 移除与 detached sandbox 清理后的状态投影，因此在清理成功的前提下，相同输入的真实运行会归档同一批 id。`orphans: true` 显式启用对配置 root 下、没有任何 mission/sandbox/review 记录引用的 git worktree 的清扫（#185）：每个 git 登记项各得到一条决策，只移除干净的检出（脏检出保留，目录已消失的登记会被 prune），主检出、所有被 state 引用的路径以及 root 之外的路径始终保留。报告为 `orphanWorktrees: {root, decisions, removed, pruned, leftovers, leftoversRemoved, leftoversReleased}`，dry run 只预览、不移除也不 prune。不传 `orphans` 的调用从不查看这些检出。已登记的 `node_modules` junction（`spawn.nodeModules:"link"`）会在 git 移除前被 unlink，其目标绝不会被触碰；工作树顶层出现未登记的链接或 junction 时，整个检出会以 `keep` 决策保留，并在 `links` 中给出原因（teardown 绝不跟随或删除不是自己创建的链接）。移除后，顶层残留项会在不递归的前提下处理：登记过的链接被 unlink，未登记的链接与文件保留，只删除已证明为空的目录；每个结果列在 `residuals` 中，被删除的登记链接列在 `nodeModulesLink` 中。同一次清扫也会删除 git 已不再登记的 review checkout 空壳：root 下直属目录只有在为空、或其中每一项都是规范目标位于仓库内或工作树根内的链接时（即 `spawn.nodeModules:"link"` 留下的形态）才可移除。这类链接只会被 unlink、绝不跟随，其目标不受影响；其他任何项（真实文件、目录，或指向别处的链接）都会保留该空壳，并在原因中点名该项。`leftoversReleased` 统计因 `worktreeRemovedAt` 标记被释放给清扫的已登记 worktree 路径，因此 `leftovers` 为空时语义不含糊。未匹配任何 mission 或 roster 行的 `exclude` id 会出现在 `unmatchedExclude` 中，并附带 `keep` 决策（原因为 `exclude did not match any mission`）。不会删除任何数据；`archive.afterDays:0` 会立即归档刚拆除的 mission。 |
| `tower_mode` | `active?`（`true`/`false`/`"takeover"`）、`reason?`、`authorization?` | 不传 `active`：报告模式、最近修改、被暂停的 goal、被拒绝的工具、store 路径、插件版本、HMR 可用性、workspace 锁持有者，以及进入策略所依据的 Ralph 姿态（`ralph: {policy, runs, rounds, liveRounds, detail}`）。传 `active`：`true` 进入、`false` 退出、`"takeover"` 在获得用户明确批准后从已停用的属主转移仓库所有权。写操作需要非空 `reason` 且 `mode.allowAgentControl:true`；`takeover` 还必须提供 `authorization`（记录在活动条目上的审计引用）。进入时如有活跃 Ralph 循环：默认 `mode.ralphPolicy:"stop"` 会释放循环并在结果中报告 `ralphReleased`，设为 `"refuse"` 时以 `[tower:invalid-transition]` 拒绝进入。 |
| `/tower takeover <reason>` | — | 人类专用的所有权转移命令；即使 `mode.allowAgentControl:false` 也可用。 |
| `/tasks`、`/tower tasks` | — | 人类可用的只读实时 roster 面板：每个存活 roster agent 一行（mission、角色、名称、短分支名、状态、距其最近一条记录事件的静默时长、该事件本身），最静默者在前，最多 20 行，页脚给出 `N live, M stale` 计数与 `tower_interrupt` 处置提示。不消耗模型回合，也不做任何写入（不触碰 `state.json`、activity 日志或 modes store）。过期判定与 `tower_inspect` 的 `roster` 视图及合并门禁使用同一条 `spawn.staleMs` 规则。仅当宿主 profile 未定义其他 `tasks` 命令时插件才注册 `/tasks`；`/tower tasks` 是始终可用的别名，当前 profile 实际采用哪个会在命令描述中说明（#160）。 |
| `tower_reload` | — | 仅开发用：请求 DSH HMR 对账 profile 并从磁盘重载 Host 插件。`tower-hmr` 组件行开启时注册（该行随包关闭）；在工具结果返回后调度（默认 50 ms）；没有 HMR 时以 `reload-unavailable` 失败。它在 `host/tool-profiles.js` 中登记为唯一的仓库可选工具，因此可以在没有仓库时修复损坏的 profile；决定这一路径的是工具身份，而不是调用者是否传了 `repoRoot`。 |
| `tower_recover` | `action`（`status`/`clear-stale-lock`/`clear-workspace-lock`）、`confirm?`、`force?` | 恢复诊断，以及针对 state 写锁、短暂存在的 state 提交互斥锁（`state.commit.lock`）和仓库 workspace 锁（`<git-common-dir>/dsh-tower/tower.lock`）的显式 stale 锁修复。当变更报 `state-locked`/`state-commit-busy`，或 `tower_inspect` 的 doctor 报告遗留 `commit-lock` 时，用 `status` 查看 `stateLock` 与 `commitLock`：能解析时返回持有者 `{pid, startedAt, ageMs, heartbeatAgeMs, stale}`，文件存在但无法解析（撕裂写入）时返回 `{unreadable:true, path, error}`（不可读记录是死锁，不是“没有锁”）。`clear-stale-lock` 需要 `confirm:"CLEAR_STALE_LOCK"`，只把 PID 已被证明死亡的记录改名为唯一的数字备份 `.recovered-<timestamp><tick>`（同一毫秒内的两次恢复也不会互相覆盖；输出中的 `backup` 为 state 锁备份，`commitBackup` 为提交互斥锁备份）。`force:true` 还能清理 PID 仍存活但心跳静默（PID 被复用或进程已停止）的记录以及不可读记录；不带 `force` 时不可读记录会以 `state-commit-lock-unreadable`/`state-lock-unreadable` 拒绝并给出可执行的 `nextAction`。被移动的记录始终只改名、绝不 unlink。`status` 还会返回仓库 workspace 锁的 `workspaceLock`：`{path, bytes, mtime, held, self, stale, corrupt, unreadable, torn, aged, reclaimable, pid, sessionId}`。撕裂记录（空、纯空白或不是锁对象）只有在 mtime 超过 30 秒 torn 宽限期后，才会被下一次获取自动回收并改名为 `tower.lock.recovered-<ts>`；新产生的撕裂文件以及所有可解析记录保持原有行为。`clear-workspace-lock` 需要 `confirm:"CLEAR_WORKSPACE_LOCK"`；不带 `force` 时只移动超过宽限期的撕裂记录或 PID 已被证明死亡的记录，活着的持有者、无法证明死亡、新撕裂文件和不可读文件都会被拒绝，并给出路径、字节数、mtime 与可执行的 `nextAction`。`tower_recover` 在 workspace 锁门之前运行（其他仓库工具仍会报 `workspace-busy`，消息现在会带上锁路径、大小与 mtime），但恢复仍绑定 Tower 属主。恢复不会重置状态或 worktree；清理提交互斥锁不替代写者围栏：每次提交仍会校验 state 锁 token 与 `state.json` 的确切字节并对落地修订号分类，因此竞争失败的写者会失败关闭。 |
| `tower_wait` | `missionId?`（别名 `id`）或 `agent?`（二者恰好一个）、`until?`（默认 `settled` / `completed` / `inactive` / `any-change`）、`timeoutMs?`（1000–600000，默认 30000） | 针对单个 mission 或 roster agent 的一次有界阻塞等待（#201）。每轮只读一次 `state.json`，等待期间从不持有 state 锁，从不写入 state 或 activity，并在轮次之间让出事件循环。只返回一种结论：条件满足时为 `{status:"reached", waitedMs, target, detail}`；超时未满足时为 `{status:"timeout", waitedMs, target, last}`（最后一次有界观测，绝不返回整表）；目标不存在或目录在等待中变为不可读时为 `{status:"unknown", waitedMs, target, reason}`——目标不存在绝不会被伪装成 timeout。仅限控制塔；见下文“等待单个目标”。 |
| `tower_test` | `missionId`（别名 `id`） | 运行 worktree 的 `package.json` 中 `tower.testDiscovery` 配置的发现命令并记录回执；失败时 `ok:false`。自动准入检查请用 `tower_complete`。 |
| `tower_batch` | `action`（`create`/`status`/`close`/`abandon`）、`missionIds?`、`exclusions?`、`requiredChecks?`、`receiptPaths?`、`batchId?`、`checks?`、`treeTip?`、`receiptHashes?`、`reason?` | 有限证据批次。create 冻结成员/检查/回执；close 校验每条必需检查与回执哈希；`merged` 成员也可参与 close；abandon 可退掉过期的 open batch 且不删除 mission。成员关系不可变。 |
| `tower_resource` | `action`（`acquire`/`release`/`status`）、`name?`、`holder?`、`token?`、`ttlMs?`、`force?` | 每个仓库的咨询式租约，位于 `<common>/dsh-tower/leases.json`。没有 OS CPU/内存硬上限；过期的租约需要显式 `force` 与正确 token。 |
| `tower_import` | `op?`（有 `sourcePath` 时推断为 `snapshot`，否则 `map`）、`sourcePath?`、`action?`（`map`/`status`）、`sourceHash?`、`oldId?`、`newMissionId?` | 一个遗留资源工具（#163 Phase 4）。`snapshot`：只读导入 Tower Codex `schemaVersion:1` 或 DSH 旧版 state，完整 payload 存到 `<common>/dsh-tower/legacy/<sha256>.json`，state 中只保存摘要。`map`：仅审计用途的旧 id 映射，映射只追加；`action:"status"` 列出映射。绝不激活/接管/恢复暂停的 mission。除只读 `status` 动作外仅限控制塔。 |

### 未声明的参数会被拒绝，而不是被丢弃

每个工具都声明封闭的输入对象，调用中若带有该工具未声明的顶层键，会在处理函数运行之前以
`[tower:invalid-argument]` 被拒绝，并指出这些键、工具名和插件版本，绝不会返回 `ok:true`
（#230：2.9.7 把 `task_add` 发给并未声明它的 `tower_plan`，所有 task 都被丢弃，而调用仍报告成功）。
接受集合是该工具自己声明的键，加上上表所列的别名，以及运行时继续为无头调用者接受的显式 `repoRoot`
（[#163](https://github.com/ranxianglei/dsh-tower/issues/163) 第一阶段）。嵌套值不会被重新校验。

### 只读取视图的一部分

只读视图支持可选的投影，调用方可以在不改变任何默认输出的前提下压缩大响应。每行都是一个工具的一种调用：

```json
{"tool":"tower_inspect","arguments":{"view":"doctor","compact":true}}
{"tool":"tower_inspect","arguments":{"view":"doctor","checks":true}}
{"tool":"tower_inspect","arguments":{"view":"status","missionId":"M7"}}
{"tool":"tower_inspect","arguments":{"view":"status","fields":["id","status","owner"]}}
{"tool":"tower_inspect","arguments":{"view":"status","sinceRevision":41}}
{"tool":"tower_inspect","arguments":{"view":"status","offset":20,"limit":20}}
{"tool":"tower_inspect","arguments":{"view":"roster","agent":"worker-m1","tail":5}}
{"tool":"tower_inspect","arguments":{"view":"diff","missionId":"M7","stat":true}}
```

`sinceRevision` 使用逐行的 `revision` 标记。只有 spawn、interrupt 与 roster 写路径会给行打标记（spawn 的 reserve/outcome、interrupt，以及 roster 的观测/退休/watchdog 变更）；`tower_plan`、`tower_mission`、`tower_complete`、`tower_test` 的 test-run 回执、merge、review 与 worktree 写路径（`tower_spawn` 的 worktree 供给、`tower_rebase`、`tower_teardown`）只递增 `state.revision` 而不会给行打标记，因此正数会漏掉这些变化。test-run 回执存放在 `testRuns` 中，只出现在 `missionId` 详情里，列表行中没有。在 JSON 看板中，`missions` 是过滤后的 mission 列表，`roster` 是过滤后的 roster 行**数**；roster 行本身来自 `roster` 视图（`agent`/`tail`），该视图忽略 `sinceRevision`。带 `missionId` 的 `status` 返回完整详情并忽略 `sinceRevision`；归档摘录不带标记，因此正数时 `includeArchived` 不会追加任何归档。传 `0` 读取全部行（不过滤）。该过滤只作用于 JSON 输出：`format:"markdown"` 始终渲染完整看板。`compact` 会保留每个未通过检查及其 `detail`，因此更小的 doctor 报告绝不会隐藏失败。

`tail` 一次只截断一个目标：带 `agent` 时截断 `status` 与 `roster` 里该 agent 的活动摘要；
`roster` 不带 `agent` 时保留最新 N 行。`status` 不带 `agent` 时渲染的是面板，没有可截断的
tail，因此该组合会以指出 `agent` 的 `invalid-argument` 拒绝，而不是被静默忽略。

### status 的分页契约

不带 `missionId` 的 `status` 只返回一页 JSON，并把这个页描述清楚，因此调用方仅凭回复就能预测下一次调用（#233）。
指名一个 mission 仍然是最省的读法；只有在不得不列清单时才需要分页。`format:"markdown"` 是例外：它渲染完整看板，不分页。

| 字段 | 含义 |
|---|---|
| `limit` | 实际生效的页大小：调用方请求的 `limit` 被夹到 1–100，缺省为 **20**。每个分页响应都会回显，因此被夹过的请求不会成为意外。 |
| `offset` | 实际生效的页起点：请求的 `offset` 是正整数时取该值，否则为 `0`。 |
| `total` | 当前过滤条件（`includeArchived`、`sinceRevision` 等）命中的 mission 总数，不是本页行数。 |
| `nextOffset` | 下一页的 `offset`；已是最后一页时为 `null`。等价判断是 `offset + missions.length < total`。 |

由此有三条性质，且都不取决于 state 有多大：

- **一页是有界的。** `missions.length <= limit`，而且即使调用方要求更大，`limit <= 100`，
  因此没有任何一次调用能返回整张大表——#233 背后的事故就是一次回复 104 行 mission 与 422 行 roster。
- **分页必然结束。** 沿 `nextOffset`（`0, nextOffset, …`）走，会在 `ceil(total / limit)` 次调用内到达
  `total`，最后一页报 `nextOffset: null`。offset 超出末尾得到空页加 `nextOffset: null`，不是错误。
- **分页是稳定的。** 所有页都从同一份有序 id 列表上切分，因此一次遍历的并集恰好是全部命中的 mission，
  各出现一次，顺序与看板一致。

`missionId` 是替代分页而不是与分页叠加：它返回那一个 mission 的行加 `detail`，并忽略
`offset`/`limit`/`sinceRevision`。`roster` 视图的同类收窄是 `agent`（一行加该 agent 的有界活动 tail），
`tail` 截断这个 tail（缺省 5，最大 50）；不带 `agent` 时 `tail` 改为保留最新 N 行。`doctor` 用
`compact`/`checks` 得到它的有界形态。消息从不属于 status 页：用 `tower_inbox` 读取，它按自己的
`limit` 分页。

### 死掉的 worker 留下什么

当 watchdog 把一行标记为 `stale`（子代理目录超过 `spawn.staleMs` 仍无活动回答）时，这次扫描同时记录该
worker 留下的残留，这样就不必再用 `git status` 加逐 hunk 读 diff 去重建死亡现场（#231）。只有一条记录，
且只含计数与 sha：

```json
{"at":1760000000000,"filesChanged":3,"branch":"tower/m7-…","tip":"4f2a…","dirty":true,"cause":"interrupted"}
```

`filesChanged` 是 `git status --porcelain` 的条目数，`tip` 是 worktree 的 `HEAD`，`dirty` 等于
`filesChanged > 0`，`cause`（没有则缺省）是该行原本就带的有界原因。每个字符串字段上限 120 字符；记录
绝不包含文件内容、diff 或逐文件清单，worktree 不存在时退化为 `filesChanged: 0`，而不是让整次扫描失败。

它只出现在两处，且都不是默认页面：

- **仅限单 agent 详情。** `tower_inspect({view:"roster",agent:"worker-m1"})` 以 `agent.residue` 返回；
  `compact:true` 只保留身份字段、不含残留。默认 `roster` 表格、`/tasks` 面板与 `status` 看板都绝不携带
  它，因此长 mission 不会把它们撑大。
- **后继 spawn。** worker 的死亡会被写到 mission 上作为 `predecessorResidue`，`tower_spawn` 再把它写到新的
  roster 行（`report.rosterEntry.predecessorResidue`），worker briefing 会渲染出
  `A previous worker on this mission died before completing:` 段落，并带上真实计数、分支与 tip。干净的
  前驱不留记录，也不产生段落。

只有 worker 的死亡才算 mission 消息：死掉的 reviewer 保留自己的行级残留，但绝不会出现在 worker briefing 的
“previous worker” 段落里。这条记录代表最近一次 worker 死亡，而不是历史档案——带残留的死亡会替换上一条记录，
干净的死亡会删掉它，因此段落始终描述紧邻的前驱。F73 复活会删除该行的残留，并在 mission 记录指向该行时一并
删除 mission 上的副本：被证明还活着的 worker 不是死亡。成功接受的 `tower_complete` 也会清除这条记录，因为
后继已经解决了警告所指的问题；之后为 review 修复轮 spawn 的 worker 不会再听到旧的死亡消息。

每次死亡会在通常的 `stale <names>; idle <names>` 行之后追加一条 `watchdog` 活动：
`residue worker-m1: 3 file(s) changed on tower/m7-… at 4f2a…`。恢复流程见运行手册的
“A worker died mid-mission”。

## 等待单个目标

`tower_wait` 是有界读取的另一半（#201）。调用方不必循环轮询 `tower_inspect`，只需指定一个 mission 或一个
roster agent，就能拿到唯一一种结论：

```json
{"tool":"tower_wait","arguments":{"missionId":"M7","until":"settled","timeoutMs":120000}}
{"tool":"tower_wait","arguments":{"agent":"worker-m7","until":"any-change"}}
```

| 结论 | 条件 | 载荷 |
|---|---|---|
| `reached` | 某轮观测时条件已满足：mission 达到 `completed`/`merged`（`completed`）、状态为 `completed`/`merged`/`blocked`/`paused`/`abandoned`（`settled`）或它的每一行都已结算且零行也算 inactive（`inactive`）；agent 行状态已结算（或该行已消失）；或观测投影发生变化（`any-change`——mission 摘要、agent 摘要，或该任务目标 mission 的 roster 行；不含任务列表、note、blocker 或 test-run 回执）。 | `status`、`waitedMs`、`target`、`detail`（`until` 值及 mission/agent 摘要）。 |
| `timeout` | 超时前条件始终未满足。 | `status`、`waitedMs`、`target`、`last`——最后一次有界观测（revision、目标行，以及最多 5 行 roster；绝不返回完整 mission/roster 表）。 |
| `unknown` | 目标不存在，或目录在等待期间变为不可读/被移除。 | `status`、`waitedMs`、`target`、`reason`。不要盲目重试同一目标；先重新读取 roster 或 mission 列表。 |

`until:"settled"` 是默认值。对 agent 目标，它表示该 roster 行处于 `inactive`、`retired`、`failed`、`interrupted`
或 `missing` 之一——与绑定的 mission 状态无关，且等待期间行消失按 `missing` 计（`settled`、`inactive` 与 `any-change` 都是如此）；`stale`、`reserved` 与 `active`
不是已结算，因为 stale 是观测健康事实而非生命周期事实（#210/#211）。对 mission 目标，已结算表示 mission 状态为
`completed`、`merged`、`blocked`、`paused` 或 `abandoned`；`until:"inactive"` 表示该 mission 的每一行都已结算，
因此没有任何行的 mission 会立即被视为 inactive。`until:"completed"` 表示绑定的 mission 已 `completed` 或
`merged`，目标为 agent 时同样如此。

`until:"any-change"` 每轮比较目标的一个有界投影：mission 摘要（`id`、`status`、`kind`、`owner`、`title`）、
agent 摘要（`name`、`agentId`、`role`、`missionId`、`state`），以及 mission 目标下该 mission 的每一行 roster。
任务列表、note、blocker 与 test-run 回执不在其中，因此只改动这些不会唤醒等待；需要它们时用带 `missionId`
的 `status` 读取。

保证：

- **有界。** `timeoutMs` 是 1000–600000 的整数（默认 30000）。等待绝不会无限阻塞；越界值以及同时给出
  `missionId` 与 `agent` 的目标会以 `invalid-argument` 拒绝，并指出边界。
- **只读。** 等待每轮只读一次 `state.json`，不持有 state 锁，不写 state 或 activity，并在轮次之间让出
  事件循环（`min(500 ms, remaining)`），因此不会饿死并发写者。
- **仅限控制塔。** 该工具只暴露在 tower profile 与 `host:active`；worker、reviewer 与 survey preset 都不
  挂载它。worker 通过 `tower_complete` 汇报进度，角色 preset 必须保持非阻塞。

## scope 条目

`scope` 条目是相对仓库根目录的**文件 glob**，由 `fileInScope` 作为纯 glob 匹配：
`*` 只匹配同一路径段内的字符，`**` 匹配任意深度（包括零层），`?` 匹配一个非分隔符
字符，其余字符都按字面处理。因此 scope 条目命名的是文件，而不是目录：字面条目
`docs/guide` 只匹配名字恰好是 `docs/guide` 的文件，不会匹配该目录下的任何文件。

`tower_plan` 不改变这个匹配器，只在保存新计划时把目录形态的条目规范化；通过
`tower_mission` 编辑 planned mission 的 scope 或扩大 scope 时也做同样处理：

| 写入的条目 | 存储的 scope | 原因 |
|---|---|---|
| `docs/guide/` | `docs/guide/**` | 尾部分隔符明确表示“目录”，即使它尚不存在。 |
| `docs/guide` | `docs/guide/**` | 规划时所在的 checkout 在该路径上确有目录（规划时探测一次）。 |
| `docs/guide`（不存在该目录） | `docs/guide` | 它可能是已有文件，也可能是 mission 将要创建的文件；保持字面。 |
| `docs/guide/**` | `docs/guide/**` | 已经是显式的子树 glob；保持不变。 |
| `docs/*.md` | `docs/*.md` | glob 条目是文件模式；保持不变。 |
| `.` | `**` | 仓库根就是整棵树。 |

存储的 scope 始终是显式 glob，而不是目录写法，因此门禁、briefing 和
`tower_inspect` 看到的围栏完全一致。只有**新输入**会被规范化：mission 上已经存储的
scope 永远不会被改写，因此在新规则之前规划、仍保存字面条目的 mission 会继续拒绝该
目录下的文件，直到控制塔显式扩大 scope。目录探测失败时条目保持字面，不会让规划失败。

目录子树推荐写成 `docs/guide/**` 或 `docs/guide/`。避免只写裸 `docs/guide`：它只有在
规划时该目录已经存在才会展开，因此同一段文本可能随仓库状态代表一个文件或整棵子树。

### scope 条目必须指向真实内容

上文的展开只决定条目如何存储；“是否存在”决定它能否被规划。规划会先把原始条目与
`git ls-files` 对照，再规范化，因此拼写错误会在 mission 建立前被发现，而不是在 spawn
之后——那时只能放弃并重新规划（#200）。

以下条目直接通过：`**`、`.`、目录形态条目（尾部分隔符，或规划 checkout 中确实存在的
裸路径），以及至少匹配一个已跟踪文件的条目。若条目的静态前缀（第一个 `*`、`?`、`[`
之前、到最后一个分隔符为止的文本）不在任何已跟踪树内，也通过：规划无法知道 mission
是否会创建该树，因此 README-only 仓库中的 `src/**` 是未来树，不是拼写错误。根级字面
条目（没有目录前缀）同样无法验证，保持合法，这样未知依赖仍保留自己的错误，门禁也
照旧围栏该路径。

其余情况属于“存在但无匹配”的已知区域：前缀已被跟踪（或 checkout 中存在），但条目
匹配不到任何已跟踪文件时，以 `invalid-argument` 拒绝。只匹配被忽略文件的 glob 也在
此列。错误会指出第一个失败条目、最近的已存在前缀，以及该目录下最多 5 个已跟踪候选；
`details.problems` 逐条给出 `{entry, reason, closestPrefix, candidates}`，
`details.operation` 则标明被拒绝的是规划（`plan`，包括 planned mission 的 scope 编辑）还是扩大（`widen`）：

```text
[tower:invalid-argument] no tracked file matches "tests/teardown*.test.mjs"; nearest
existing prefix "tests"; tracked files there: tests/cleanup.test.mjs — next: use a
tracked path such as "tests/cleanup.test.mjs", or pass allowMissingScope: true to
accept a path a mission will create
```

存在性比对会折叠大小写：仅大小写不一致属于门禁的比较判定（#90），不是路径缺失，且
不会改写任何内容。若条目确实是 mission 将创建的路径，在 `tower_plan` 的对应 mission
上传 `allowMissingScope:true`，或在 `tower_mission` 的 `scope` 中同时传入该标志。调用会
接受这些条目而不做证明，并记录一条 `scope.unverified` 活动条目列出它们。该标志是输入
决策，不会写入 mission，存储的 scope 也不变。`tower_mission` 使用同一规则校验新条目：
planned mission 是编辑围栏并保持 planned 排序，active 或 completed 是扩大围栏并启动它；
`allowMissingScope:true` 在两种情况下都可用。两者只在被拒绝条目的 `details.operation`
（`"plan"` 或 `"widen"`）上不同：两种拒绝都会说明上文的“存在性”规则，且 next action
明确命名 `allowMissingScope:true`，因此确知 mission 会创建该路径的调用者仍可显式选择接受。

scope 为 `**` 的 mission 拥有未来所有路径，因此其他在途 mission 之后的规划编辑或扩大都会与
它重叠。于是 `tower_plan` 在已有 planned/active 的拥有路径 mission 时规划新的整仓库
mission，会返回非阻塞的 `broad-scope` 警告：警告列出会被该围栏挡住的 mission，并建议把
release 准备 mission 放到最后规划、标记 deferred，或在其他 mission 扩大前暂停它。规划本身
仍然成功。

### planned 编辑、defer 与暂停

planned mission 尚未开始，因此 `tower_mission` 把它的 `scope` 当作规划编辑：替换围栏、
`scopeGeneration` 递增，mission 保持 `planned`。存在性与目录规则与规划相同，
`allowMissingScope:true` 同样适用于 mission 将要创建的路径。

planned 或 active 的拥有路径（build 或 artifact）mission 可以设置 `deferred:true` 退出
widen 排序：deferred 期间它的 scope 不再阻止其他 mission 的规划编辑或扩大，因此可以把
release 准备放在最后规划，而不必重写围栏。`deferred:false` 重新加入排序；mission 进入终态后该标志不再影响
任何决策。

从 `planned` 暂停必须显式提供 `pause_cause`。`status:"planned"` 会把暂停的 mission
退回规划、清除原因且无需授权；只有 `status:"active"` 遵循
`mode.requireResumeAuthorization`。暂停的 mission 会被 widen 重叠检查跳过，因此暂停也是
解除排序阻塞的一种方式。

### widen 模式：一次调用取代手工编排（#219）

过去扩大围栏会被任何一个重叠的 planned 或 active 邻居挡住：调用方若确实需要该围栏，只能先手工
defer 邻居、扩大、恢复自身状态、再逐个 un-defer——N 个邻居就要 2N+2 次 `tower_mission`，
而且在 spawn reviewer 之前还得手工补一次状态。单 mission 形式新增一个可选的 `widen` 对象，
让同一次调用决定这些行为：

| `widen` 字段 | 含义 |
|---|---|
| `mode:"refuse"`（默认） | 不改变任何状态。新围栏与邻居重叠时调用失败，并**逐个**列出每个冲突邻居及其状态与 kind——`widened scope overlaps mission M2, M3; retire them, pause them, mark them deferred, or add an explicit ordering (M2: planned build, M3: active build)`。不写入任何内容。 |
| `mode:"defer-conflicts"` | 在同一次调用里先 defer 可 defer 的邻居再扩大：每个冲突的 **planned** 邻居获得 `deferred:true`，接收方把它们记入 `deferralsCreated`，`scopeGeneration` 只递增一次，整个调用只产生一次 revision 递增。 |
| `restoreDeferrals:true` | 只清除本接收方记录在 `deferralsCreated` 里的标志，并删除该记录。人工手动 defer 的邻居不受影响。可带 `scope`，也可单独使用。 |
| `keepStatus:true` | 已启动的接收方保持原状态，而不是被打回 `active`。对 completed mission 即保持 `completed` 且 `scopeGeneration+1`，于是 `tower_spawn role:"reviewer"` 可立即使用，无需中间状态补丁。planned 编辑忽略该字段（本来两种情况都保持 `planned`）。 |

只有 planned 邻居会被自动 defer。**active 或 blocked** 的邻居有正在进行的工作，
`defer-conflicts` 会拒绝而不会 defer 它：`a deferral would strand in-flight work: M3: active build; only a planned neighbour can be deferred`。
completed 邻居则以 `only a planned neighbour can be deferred` 拒绝。所有拒绝都发生在第一次
变更之前，因此失败的 widen 会让状态保持原样——邻居保留其标志，接收方保留其 scope 与状态。

返回值在 `{revision, mission}` 之外携带 widen 描述 `{mode, deferred, restored, statusKept}`，
调用方能看出它移动了哪些邻居。planned mission 的 scope 编辑返回同样的 `{revision, mission}`
形状，其中 `scope` 与 `scopeGeneration` 已更新而状态不变（`widen` 为 `null`），调用方据此区分
两条路径：编辑保持 `planned`，扩大则启动 mission（或凭 `keepStatus` 保持原状态）。

本次调用移动的每个邻居都会在 `<git-common-dir>/dsh-tower/activity.jsonl` 留下自己的
activity 记录（`{at, type:"mission", missionId, text}`）：接收方记录 `scope widened`
（以及 defer/restore 句子），被 defer 的邻居记录 `deferred by widen of M<n>`，被恢复的邻居记录
`deferral restored by M<n>`。它们共享同一个 `revision`，因为整个调用是一次原子写入——
[events.md](events.md) 里的进程内事件不携带按邻居拆分的记录，邻居变更的审计要查 activity 日志。

`widen` 仅限单 mission 形式：批量 `missions[]` 会以
`tower_mission widen is only available on the single-mission form` 拒绝，因为一次调用修改邻居
无法按批次逐项应用；`ids` 简写也只接受生命周期字段。

当 `git ls-files` 失败或返回空列表时，无法证明存在性，规划会跳过该检查；门禁仍按
原样围栏存储的 scope。

## 阻塞性 finding、review note 与 filed finding

reviewer 有三个地方可以放观察，选错通道正是让一次 review 要么昂贵、要么不诚实的根源（#221）：

| 通道 | 何时使用 | 代价 |
|---|---|---|
| **阻塞性 finding** —— `status:"p1-Nitems"` / `"p2-Nitems"` 配 `findings` 与 `merge:"hold"` 或 `"fix-then-merge"` | 分支是错的：改变行为的缺陷，或让某条有文档的声明变成假话 | mission 退回 `active`，worker 需要一轮返工；`review.mode:required` 下在记录 clean 结论前合并被阻塞 |
| **review note** —— 任何结论（包括 `clean` + `merge`）上的 `notes:["…"]` | 分支可以正常落地，但仍有值得一看的东西：过期计数、措辞小问题、重复注释、润色 | 没有代价：结论、mission 状态和合并门禁都不变；note 留在 review 行上，直到控制塔 fold 它 |
| **filed finding** —— `tower_finding({op:"report"})` | 观察对象不是这个分支（别的 mission 的文件、仓库级模式、工具缺陷） | 一条独立于本分支存在的 finding 行，可单独分诊 |

note 不是"更弱的 finding"，而是另一条通道：`notes` 不能携带结论、不能设置状态，
`tower_inspect({ view: "preflight" })` 与 `tower_merge` 从不读取它。钉住这一点的两个测试是 `tests/review-modes.test.mjs`（带 note 的
clean 结论产生的 blocker 集合与不带 note 的完全相同，`gates.requireChecks` 开关两种情况都测）
和 `tests/review-lifecycle.test.mjs`（带 note 的 clean 结论仍让 `gate.ok:true`）。
不要用沉默代替 note：2.9.8 那一波里，被要求"只报阻塞缺陷"的 reviewer 让中文 README 里过期的
工具数一路带进发版，因为沉默没有归属人。

note 有上限（每份结论最多 10 条，每条最多 400 字符），并按 round 累积：`p1` 返工保留 `R1`
上的第 1 轮 note，第 2 轮结论把新的 note 追加到 `R2`，不会替换任何东西。`tower_inspect` 的
`view:"status", missionId:"M1"` 返回带 `notes` 的 review 行（`{id, reviewId, round, reviewer, at, text, state}`）；
分页的 mission 行只保留紧凑的 `{id, round, status, mergeVerdict, reviewer, reviewerRole, reviewedCommit, at}`
摘要，从不携带 note。

note 从不阻塞任何东西，因此也不能被悄悄遗忘：`tower_inspect({ view: "doctor" })` 报告一条
`review-notes` 检查，只要有
note 处于 open 就是 `warn`（点名 mission id 与 note id），全部处理完则 `pass`；`warn` 从不改变
`ok`。清除它的审计动作是 fold：

```text
tower_mission({ id: "M42", fold_notes: true })
```

该调用把本 mission 自己的 open note 标为 `folded`（写 `foldedAt`），为每个 note 追加一条 `done`
任务，使任务列表携带已 fold 的历史，并记录一条 activity 记录——总共只提升一个 revision。
它仅限控制塔（`only the tower can fold review notes`）且仅限单 mission 形式：批量形式会按字段名
拒绝，而 review 行属于别的 mission 的 note 会被拒绝而不是被认领。发版准备 mission 因此可以引用
`folded N review notes into the task list` 作为完成证据。

## workspace 锁

当 `mode.workspaceLock:true` 时（随包 patch 开启），Tower 模式会话的第一次仓库级 Tower 工具调用会
获取 `<git-common-dir>/dsh-tower/tower.lock`；另一个会话会得到 `[tower:workspace-busy]`，直到持有
者执行 `/tower off` 或锁超过 `mode.workspaceStaleMs`。`mode.workspaceLockScope:"mutations"` 会跳过
只读工具的锁。代码默认关闭；随包 patch 开启，以提供与 Kimi 兼容的“单活跃控制塔”行为。

## 失败结果

门禁类工具返回 `{ok:false, blockers:[{code, detail}]}`；code 列表见 [blockers.md](blockers.md)。
抛出的工具错误带稳定的 `[tower:<code>]` 前缀（见 [errors.md](errors.md)）。成功的变更会发出进程内
事件（见 [events.md](events.md)），并在挂载 `tower-board` 组件行时刷新
`<git-common-dir>/dsh-tower/MISSIONS.md`。看板位置仍由 `docs.boardLocation` 决定；原先的
`docs.board` 开关现在是组件行（#133）。
