# dsh-tower

[![CI](https://github.com/louifinn/dsh-tower/actions/workflows/test.yml/badge.svg?branch=main)](https://github.com/louifinn/dsh-tower/actions/workflows/test.yml)
[![npm](https://img.shields.io/npm/v/dsh-tower.svg)](https://www.npmjs.com/package/dsh-tower)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[English](README.en.md)

**Tower** 是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的多代理编排插件。它把一个 agent 会话变成一个小型工程团队：会话本身是*控制塔*，worker agent 在隔离的 Git worktree 里实现任务，任何改动都必须经过独立审查和硬门禁才能合入基线分支。

Tower 模式与 mission/审查工作流的灵感来自 Moonshot AI 的 **Kimi Code** 中实验性的 Tower 模式（[Kimi Code](https://www.kimi.com/code)）。本项目是面向 DSH 的独立实现，与 Moonshot AI 无隶属关系；详见[致谢](#致谢)。

仓库根目录**就是** DSH bundle 包根：`package.json` 声明 `dsh.bundle.patch`，`cordis.patch.yml` 位于根目录，符合 DSH 插件规范。

## 特性

- **由人类掌握的 Tower 模式。** `/tower` 切换会话级模式：收窄工具面并注入 Tower 协议；`/tower on|off <指令>` 还能把指令作为下一步用户消息转发给模型。
- **任务级隔离。** 每个 mission 使用独立分支和 Git worktree，worker 不会碰到你的主检出。
- **审查门禁合并。** 审查者必须针对当前分支 tip 给出 `clean` / `merge` 结论；合并门禁重新校验 scope、分支新鲜度、任务完成度、审查记录与 worktree 归属，通过后才执行 `--no-ff` 合并。
- **可恢复的协作状态。** roster、inbox、findings、reviews 与 mission 状态持久化在 `.git/dsh-tower/` 下，重启不会丢计划。
- **默认安全。** Tower 模式开启期间拒绝 `create_goal`、`update_goal(resume)`、`todo_write`、Team 任务板与 `spawn_teammate`；被暂停的 goal 不会被自动恢复。

## 环境要求

- DeepSeek Harness `0.2.1-rc.2`（或兼容的新版本）
- Node.js 22+
- Git（worktree 在本地创建，不需要联网）

## 安装

把已发布的包安装到 DSH profile：

```bash
dsh plugin --profile web add dsh-tower
```

在 DSH 中也可以用插件管理器指定同一目标：

```text
plugin_manager({ action: "install_bundle", target: "dsh-tower" })
```

开发时改为从 GitHub 安装或链接本地 checkout：

```bash
dsh plugin --profile web add github:louifinn/dsh-tower
dsh plugin --profile <profile> add <本仓库的绝对路径>
```

Host 插件在 DSH 进程启动时加载，**安装或更新后需重启 DSH**。卸载使用 `remove_bundle`，包名 `dsh-tower`。

## 快速开始

```
/tower on

tower_init        <repoRoot>
tower_plan        <repoRoot> missions=[...]
tower_spawn       <repoRoot> missionId=M1 role=worker
# worker 实现并汇报完成
tower_preflight   <repoRoot> missionId=M1    # 必须全绿才能合并
tower_spawn       <repoRoot> missionId=M1 role=reviewer
tower_review      ...                        # 审查者提交结论
tower_preflight   <repoRoot> missionId=M1
tower_merge       <repoRoot> missionId=M1
tower_teardown    <repoRoot>

/tower off
```

小改动通常一轮 worker + 一轮 reviewer 即可完成。

## 命令

| 输入 | 行为 |
|---|---|
| `/tower` | 开启 Tower 模式（已开启则保持） |
| `/tower on` | 开启或保持 |
| `/tower on <指令>` | 开启/保持，并把 `<指令>` 作为下一条用户消息转发 |
| `/tower off` | 退出 Tower 模式 |
| `/tower off <指令>` | 退出并转发 `<指令>` |
| `/tower <指令>` | 确保开启，然后转发 `<指令>` |

图片与文件附件会随指令一起作为一条完整的 `UserMessage` 转发。

## 配置

```yaml
- id: tower
  name: 'dsh-tower'
  config:
    section: '（可选）覆盖 Tower 模式系统提示文案'
    allowAgentControl: true   # true 时注册 tower_control；false 时只有人类能切换
```

- 代码中 `allowAgentControl` 默认 `false`；仓库自带的 `cordis.patch.yml` 把它设为 `true`：当用户意图或任务状态明确时，模型可以自行进出 Tower 模式，但必须给出理由。
- 设为 `false` 时只有人类能切换模式。

## 工具（17 个）

`tower_init` · `tower_plan` · `tower_mission` · `tower_status` · `tower_spawn` · `tower_roster` · `tower_adopt` · `tower_send` · `tower_inbox` · `tower_complete` · `tower_finding` · `tower_review` · `tower_preflight` · `tower_merge` · `tower_rebase` · `tower_teardown` · `tower_mode`

`tower_control` 仅在 `allowAgentControl: true` 时存在。

## 安全与约束

- **门禁不全绿不合并。** `tower_preflight` 是只读检查，返回稳定的 blocker code；存在 blocker 时 `tower_merge` 拒绝合并。
- **审查绑定提交。** 审查后分支 tip 变化会报 `tip-moved`，必须重新审查；唯一的例外是干净 rebase 的免审豁免。
- **scope 强制。** mission 只能修改其 scope glob 匹配的文件，越界会以 `out-of-scope` 阻止合并。
- **worktree 归属。** 脏工作树、运行中的 worker、已关闭 mission 的分支都会阻止合并或 teardown。
- **goal 隔离。** 进入 Tower 模式会暂停活跃 goal 并记录；退出不会自动恢复，需要你自行恢复。

13 个稳定 blocker code：`branch-missing`、`deps-unmerged`、`read-only-survey`、`stale-base`、`no-review`、`review-hold`、`not-clean`、`review-not-approved`、`tip-moved`、`review-mission-mismatch`、`out-of-scope`、`base-dirty`、`branch-owned-by-closed-missions`（另有 mission/worker 守卫）。

## 工作原理

mission 生命周期：`planned → active → completed → merged`（或 `blocked` / `paused` / `abandoned`）。状态位置：

| 路径 | 内容 |
|---|---|
| `.git/dsh-tower/state.json` | missions、roster、reviews、findings、inbox |
| `.git/dsh-tower/activity.jsonl` | 只追加的活动日志 |
| `<主检出父目录>/.dsh-tower-worktrees/<hash>/<missionId>` | 每个 mission 的 worktree |
| `$DSH_HOME/tower-mode/modes.json` | 每个 agent/session 的 Tower 模式状态 |

worker 与 reviewer 是使用内置 `tower-worker` preset 的普通 DSH 子代理；它们的工具被限制在 mission 允许面（文件系统、shell、Tower 协议工具），不包含 merge/spawn。

## 项目结构

| 路径 | 内容 |
|---|---|
| `package.json`、`cordis.patch.yml` | bundle 清单与 loader patch（插入 Host 插件和 `tower-worker` preset） |
| `index.js`、`lib/`、`worker.js` | Host 入口、协议实现、worker preset 策略 |
| `locale/`、`icon.svg` | 本地化与图标 |
| `tests/` | 纯函数、协议 e2e、插件级测试；可选的真实 Web 运行时脚本 |
| `ui-bundle/` | 可选 Client 小挂件（静态 `/tower` 提示），默认不安装 |
| `.github/workflows/test.yml` | CI：Node 22/24 上跑离线套件 |

## 开发与测试

```bash
npm test        # node --test tests/*.test.mjs
```

离线套件不需要 DSH 进程，只在系统临时目录创建一次性 Git 仓库。隔离 Web 运行时检查、模型驱动验收和会话诊断脚本见 `tests/README.md`。

## 常见问题

- **安装/更新后插件不出现。** Host 插件在 DSH 启动时加载，请重启 DSH；并确认安装目标指向本仓库根目录（含 `package.json` 与 `cordis.patch.yml` 的那一层），而不是子目录。
- **没有 `tower_control`。** 配置 `allowAgentControl` 为 `false`；改为 `true` 并重启。
- **合并被阻止。** 运行 `tower_preflight` 查看 blocker code；`stale-base` 表示先执行 `tower_rebase`。
- **基线前进后分支过期。** `tower_rebase` 在 worktree 内完成 rebase；干净且无冲突的 rebase 可免去上一轮审查的重审。

## 贡献

欢迎 issue 与 pull request。提交 PR 前请先运行 `npm test`，细节见 [CONTRIBUTING.md](CONTRIBUTING.md)。安全相关问题请不要在公开 issue 里贴利用细节，先开一个最小化 issue 申请私下渠道。

## 致谢

- **Kimi Code（Moonshot AI）**：Tower 模式的整体概念——由人类开启的模式、每个 mission 独立 Git worktree、审查门禁合并协议——灵感来自 Kimi Code 的实验性 Tower 模式（[官网](https://www.kimi.com/code)、[源码](https://github.com/MoonshotAI/kimi-code)）。本项目在 DeepSeek Harness 的服务之上重新实现这些想法，不包含 Kimi Code 源码，也与 Moonshot AI 无隶属关系。
- **DeepSeek Harness**：本插件构建所依赖的插件、工具、会话与子代理 API。

## License

MIT © Loui Finn

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
