# dsh-tower

DeepSeek Harness (DSH) 原生的多代理工作流插件：**Tower** —— 任务规划、隔离 Git worktree、精确提交审查、门禁合并，以及由人类掌握的 **Tower 模式**。

- 当前版本：`1.0.2`（历史见 [CHANGELOG.md](CHANGELOG.md)）
- 兼容：DSH `0.2.1-rc.2`、Node.js ≥ 22
- 许可：[MIT](LICENSE)

## 仓库结构

仓库根目录**就是插件包根目录**（`package.json` 声明 `dsh.bundle.patch`，`cordis.patch.yml` 在根目录）：

| 路径 | 内容 |
|---|---|
| `package.json` · `cordis.patch.yml` | 插件包声明与 bundle 层：插入 Host 插件与 `tower-worker` preset |
| `index.js` · `lib/` · `worker.js` | Host 入口、协议实现（mission/worktree/review/gate）、worker preset 策略 |
| `locale/` · `icon.svg` | 本地化与图标 |
| `tests/` | 三层测试：纯函数、协议 e2e、隔离 Web 运行时；含诊断/修复脚本与手工验收清单 |
| `ui-bundle/` | 可选 UI 包 `@local/dsh-tower-ui`（输入框 `/tower` 提示）；opt-in，安装前先验证 slot API |
| `.github/workflows/test.yml` | CI：在 Node 22 / 24 上运行离线套件 |

## 安装

DSH 内使用插件管理器安装（会同时激活 Host 插件与 `tower-worker` preset）：

```text
plugin_manager({ action: "install_bundle", target: "<repo-root>" })
```

也可以让某个 profile 直接依赖本仓库：`dsh plugin --profile <name> add <repo-root>`。

卸载：`remove_bundle`，目标为包名 `@local/dsh-tower`。

> Host 插件在 DSH 进程启动时加载：首次安装或更新后需重启 DSH。

## Tower 命令

| 输入 | 行为 |
|---|---|
| `/tower` | 开启 Tower 模式；已开启时保持 |
| `/tower on` | 开启（或保持） |
| `/tower on <指令>` | 开启/保持，并把 `<指令>` 作为下一条用户消息发给模型 |
| `/tower off` | 退出 |
| `/tower off <指令>` | 退出，并转发 `<指令>` |
| `/tower <指令>` | 确保开启，并转发 `<指令>` |

命令支持图片/文件附件，附件随指令一起作为完整 `UserMessage` 转发。

## 配置

```yaml
- id: tower
  name: '@local/dsh-tower'
  config:
    section: '（可选）覆盖 Tower 模式系统提示文案'
    allowAgentControl: false   # true 时注册 tower_control，允许模型在用户意图明确时自行进出
```

- `allowAgentControl` 默认 `false`：只有人类能切换模式。
- 为 `true` 时模型可调用 `tower_control({action:"enter"|"exit", reason})`，必须给出理由。

## 工具（17）

`tower_init` · `tower_plan` · `tower_mission` · `tower_status` · `tower_spawn` · `tower_roster` · `tower_adopt` · `tower_send` · `tower_inbox` · `tower_complete` · `tower_finding` · `tower_review` · `tower_preflight` · `tower_merge` · `tower_rebase` · `tower_teardown` · `tower_mode`
（`tower_control` 仅在 `allowAgentControl: true` 时存在。）

## 工作流

```
/tower on
tower_init → tower_plan → tower_spawn(worker) → tower_inbox / tower_send
→ tower_complete → tower_spawn(reviewer) → tower_review
→ tower_preflight → tower_merge → tower_teardown
→ /tower off
```

关键门禁：13 个稳定 blocker code（`stale-base`、`no-review`、`review-hold`、`not-clean`、`review-not-approved`、`tip-moved`、`out-of-scope`、`base-dirty` 等）、每分支 5 轮评审上限、clean rebase 免重审、运行中的 agent 不可被 teardown。

## 测试

```powershell
npm test   # node --test tests/*.test.mjs
```

隔离 Web 运行时、模型驱动验收、诊断/修复脚本见 [tests/README.md](tests/README.md)。

## 状态位置

- 任务/审查/消息/发现：`<git-common-dir>/dsh-tower/`
- 工作树：`<主检出父目录>/.dsh-tower-worktrees/<hash>/<missionId>`
- 模式：`$DSH_HOME/tower-mode/modes.json`（原子写、最多 200 条）

## 已知限制

- 进入模式时暂停 goal 依赖 `ctx.goals` 服务；服务缺失时只记录原因，不阻断进入。
- 退出模式不会自动恢复被暂停的 goal（保留给人类决定）。
- 模式持久化是文件存储而非 session-log 投影（本地 bundle 无法解析 projection 所需的 zod）。
- `ui-bundle` 是 opt-in，尚未在真实页面验证。

## License

MIT © The dsh-tower authors
