# Tower for DeepSeek Harness

DSH 原生的多代理工作流插件：任务规划、隔离 Git worktree、精确提交审查、门禁合并，以及由人类掌握的 **Tower 模式**。

## 安装

```text
plugin_manager({ action: "install_bundle", target: "<absolute path to this bundle>" })
```

安装会激活 Host 插件与 `tower-worker` preset。卸载用 `remove_bundle`，目标填包名 `@local/dsh-tower`。

## Tower 命令

| 输入 | 行为 |
|---|---|
| `/tower` | 开启 Tower 模式；已开启时保持开启 |
| `/tower on` | 开启（或保持）Tower 模式 |
| `/tower on <指令>` | 开启/保持，并把 `<指令>` 作为下一条用户消息发给模型 |
| `/tower off` | 退出 Tower 模式 |
| `/tower off <指令>` | 退出，并把 `<指令>` 发给模型 |
| `/tower <指令>` | 确保 Tower 模式开启，并把 `<指令>` 发给模型 |

命令支持图片/文件附件，附件会随指令一起转发。命令不会进入模型历史；转发的指令会。

## Config

```yaml
- id: tower
  name: '@local/dsh-tower'
  config:
    section: '（可选）覆盖 Tower 模式系统提示文案'
    allowAgentControl: false   # true 时注册 tower_control，允许模型在用户意图/任务状态明确时自行进出
```

- `allowAgentControl` 默认 `false`，即只有人类能切换模式。
- 为 `true` 时，模型可调用 `tower_control({action:"enter"|"exit", reason})`，必须给出理由；系统提示会同步告知这一能力。

## 模式行为

- 进入时若存在 **active goal**，通过 `ctx.goals.pause` 暂停该 goal，并在命令结果中提示用户自行恢复。
- 开启期间拒绝：`create_goal`、`update_goal(resume)`、`todo_write`、`team_task_create/update/reopen`、`spawn_teammate`。
- 开启期间通过 `tower:mode` 动态 system-prompt section 注入协议提醒。
- 模式按 agent/session 持久化到 `$DSH_HOME/tower-mode/modes.json`（原子写、最多保留 200 条），重启后恢复。

> 说明：持久化没有走 session projection，因为 projection 需要 zod schema，而本地 bundle 无法从 DSH 安装目录解析 zod；文件存储达到同样的跨重启效果。

## 工具（17）

`tower_init` · `tower_plan` · `tower_mission` · `tower_status` · `tower_spawn` · `tower_roster` · `tower_adopt` · `tower_send` · `tower_inbox` · `tower_complete` · `tower_finding` · `tower_review` · `tower_preflight` · `tower_merge` · `tower_rebase` · `tower_teardown` · `tower_mode`
（`tower_control` 仅在 `allowAgentControl: true` 时存在。）

## 工作流

```
/tower on
tower_init → tower_plan → tower_spawn(worker) → tower_inbox/tower_send
→ tower_complete → tower_spawn(reviewer) → tower_review
→ tower_preflight → tower_merge → tower_teardown
→ /tower off
```

关键门禁：13 个稳定 reason code（`stale-base`、`no-review`、`review-hold`、`not-clean`、`review-not-approved`、`tip-moved`、`out-of-scope`、`base-dirty` 等）、reviewer 每分支 5 轮上限、clean rebase 免重审、live agent 不可被 teardown。

## 状态位置

- 任务/审查/消息/发现：`<git-common-dir>/dsh-tower/`
- 工作树：`<主检出父目录>/.dsh-tower-worktrees/<hash>/<missionId>`
- 模式：`$DSH_HOME/tower-mode/modes.json`

## 已知限制

- 进入模式时暂停 goal 依赖 `ctx.goals` 服务；服务缺失时只记录原因，不阻断进入。
- 退出模式不会自动恢复被暂停的 goal（保留给人类决定）。
- 模式文件持久化不是 session-log 投影；跨会话共享同一 session id 才会恢复。
- 测试与 UI 见 `../tests/` 与 `../ui-bundle/`；UI 是 opt-in 且尚未在真实页面验证。
