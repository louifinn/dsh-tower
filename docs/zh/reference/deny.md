# Tower 模式：被拒绝的能力与替代方案

[English](../../reference/deny.md) | **简体中文**

Tower 模式会关闭它并不拥有的编排面。外部编排工具会从 worker 与 reviewer preset 中移除，
另有少数兼容能力被允许挂载但会收到警告。本页是这笔取舍唯一的人类可读清单：对 Tower 拒绝
或警告的每项能力，它记录立场、替代方案、该替代的完整程度，以及用户放弃了什么。

表格与 `domain/generated/deny-surface.js`（deny surface）以及
`host/doctor-acceptance.js` 绑定。在 deny surface 中新增 owner 却不在此处补一行会导致
`npm run docs:check` 失败；改动已记录的清单构建版本却不重新生成会导致 `npm run deny:check`
失败。这两个文件都不应手工编辑：`domain/deny-owners.js` 保存 owner 列表与例外，两个检查
都由它派生。

## 立场词汇

立场取自 `domain/vocabulary.js` 的 `CAPABILITY_STANCE` 值：

- `deny` —— Tower 从 preset 中移除该能力；这些工具不会为会话注册。
- `warn+allow` —— 该能力可以被挂载，但 `tower_inspect`（doctor 视图）会警告，并且这一
  限制会被记录下来，而不是被静默接受。
- `compatibility` —— 仍可加载的已弃用写法。
- `deployment-config` —— 在会话之外配置。

下表只列出 `deny` 与 `warn+allow` 两类行。当替代方案在 Tower 协议中承接同样的工作时，
`coverage` 为 `full`；当能力中确有部分没有对应物时，为 `partial`；当 Tower 只能拒绝时，
为 `none`。

<!-- tower-deny-table:begin -->
| 能力 | 被拒绝的工具 | 立场 | 替代方案 | 覆盖度 | 代价 |
| --- | --- | --- | --- | --- | --- |
| `tool-agent-team` | `interrupt_agent`, `list_agents`, `send_message`, `spawn_teammate`, `team_task_create`, `team_task_get`, `team_task_list`, `team_task_update`, `wait_agent` | deny | `tower_spawn` 加上 roster（`tower_inspect`）、`tower_send`/`tower_inbox`、`tower_interrupt` 以及 mission 依赖 | full | worker 无法自行组建私有团队；每个子代理都是 tower 派生的 mission，并被记录 |
| `tool-goal` | `create_goal`, `get_goal`, `update_goal` | deny | `tower_mission` 的任务、状态、paused/blocked 与 note | full | mission 之外的目标无法追踪；worker 通过它的 mission 汇报进度 |
| `tool-todo` | `todo_write` | deny | `tower_mission` 任务 | full | 会话 todo 列表不复存在；任务状态保存在 mission 上，tower 可见 |
| `tool-subagent` | `subagent` | deny | `tower_spawn` 加上 `tower_send`/`tower_inbox` 与 mission 结果 | full | worker 不能自行委派；只有 tower 能打开子代理 |
| `tool-subagent-fork` | `subagent_fork` | deny | 使用全新上下文的 `tower_spawn` | partial | 没有当前对话的 fork；子代理从 briefing 开始，而不是父代理的上下文 |
| `tool-subagent-control` | `interrupt_agent`, `list_agents`, `send_message` | deny | `tower_inspect` roster、`tower_send`/`tower_inbox`、`tower_interrupt` | full | 寻址子代理是 tower 的动作；worker 升级问题并停下 |
| `tool-ralph` | `ralph` | deny | none —— Ralph 循环是第二个编排器；worker 必须停下并报告这一需求 | none | mission 以 blocker 或放弃任务结束，而不是自主循环 |
| `tool-workflow` | `workflow` | deny | none —— workflow 在 Tower 协议之外扇出子代理；`tower_plan` 是静态计划，不是 runner | none | 静态计划可以被记录，但没有 workflow 引擎执行它 |
| `forge` | — | warn+allow | none —— Tower 在其 mission 分支上落地变更，并在 review 后合并；它没有 change-request 模式 | none | forge 失去 change-request 与 merge-on-request 路径，Tower 也没有它的拒绝记录 |
| `liveshare` | — | warn+allow | none —— `tower_mode` takeover 转移所有权，而不是共享实时会话 | none | 共享会话失去查看与受限写入，Tower 也没有这次共享的记录 |
| `plugin-manager` | — | warn+allow | none —— 在 Tower 运行之外安装或启用插件；`tower_inspect`（doctor）会报告这一缺口 | none | profile 无法从会话内安装或启用插件，Tower 也没有这次变更的记录 |
| `auto-review` | — | warn+allow | `tower_review` 加上 `review.mode` 闸门：reviewer 会阅读分支，但工具调用的自动批准并未被替代 | partial | 被委派的子代理无法使用自动批准；被拒绝的调用失败关闭，只有 review 闸门评判结果 |
<!-- tower-deny-table:end -->

## 安全兼容与直接拒绝

只有当 Tower 拥有协议替代方案且能记录工作时，能力才会被拒绝；否则它会被警告并保持可挂载，
或被直接拒绝且拒绝写入 mission 结果或收件箱。这一顺序避免两种失败模式：静默降级工作
（移除了没有对应物的工具），以及为缺失后改变结果的能力声称兼容。

每个 owner 的构建例外遵循同一条规则。清单从 `DENY_OWNER_PACKAGE_BUILD`（`0.2.2-rc.1`）
记录的 owner 集合枚举，而 `scripts/support.json` 中受支持的宿主 pin 更新（`0.2.2-rc.5`）。
agent-team 包在 `0.2.2-rc.1` 之后未再发布，因此所有 owner 都保持在完整的 rc.1 集合上，
原因按包记录在 `domain/deny-owners.js` 的 `DENY_OWNER_BUILD_EXCEPTIONS` 中。当该包重新
发布时，删除这些例外，所有 owner pin 与清单构建版本一起移动，并由 `npm run deny:generate`
重写 surface。

## 决策点

- 新增外部 owner：加入 `FOREIGN_ORCHESTRATION_OWNERS`，重新生成，并在此处补一行——
  在这一行存在之前 `docs:check` 会失败。
- 已有 owner 新增工具：重新生成；该 owner 行的工具单元格必须列出它，因此过期的行会以同样的
  检查失败。
- Tower 开始支持某项能力：修改立场行，检查会跟随导出的词汇表，而不是手写字符串。
- 某项能力不应再被挂载：把该行从 `warn+allow` 移到 `deny` 并补上真正的替代方案，或把
  coverage 标为 `none` 并记录这次拒绝。

## 无法提问的限制

被委派的子代理不能询问用户。没有审批提示，也没有运行中的提问通道；需要审批的工具调用会
失败关闭。升级通过 mission 结果、记录下来的 blocker 或 tower 收件箱进行，由 tower 决定。
正因如此，被拒绝的工具绝不是“换个办法试试”的暗示：worker 要么在 briefing 中找到 Tower 的
替代方案，要么停下并报告。
