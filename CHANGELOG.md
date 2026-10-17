# Changelog

## 1.1.0 — 2026-10-18

- **包名改为 `dsh-tower`**：Host 插件名、`tower-worker` preset 插件名、`cordis.patch.yml`、
  可选 UI 包（`dsh-tower-ui`）与中英文 README 全部同步改名；移除 `package.json` 的 `private` 字段。
- `dsh-tower@1.1.0` 已提交 npm 发布；npm 对首次发布的包执行发布审核，审核放行后可用
  `dsh plugin --profile web add dsh-tower` 安装并进入 DSH 插件中心。审核期间可用
  `dsh plugin --profile web add github:louifinn/dsh-tower` 源码安装，或用本地 checkout 链接。
- 已安装 `@local/dsh-tower` 的用户需要 `remove_bundle` 后重新安装 `dsh-tower`；配置项 `id: tower`
  与 config 内容不变，运行行为无变化。

## 1.0.5 — 2026-10-18

- README 增加源码安装命令 `dsh plugin --profile web add github:louifinn/dsh-tower`，满足
  dsh-plugin.org 的收录要求（公开仓库 + `dsh-plugin` topic + README 安装命令 + 根 package.json）。
- 无运行时行为变化。

## 1.0.4 — 2026-10-18

- 版权署名统一为 **Loui Finn**：`LICENSE`、`README.md`、`README.zh.md` 与 `package.json` 的 author。
- 无运行时行为变化。

## 1.0.3 — 2026-10-18

- 开源前整理：README 改为英文主文档（中文版保留在 `README.zh.md`），补充特性、安装、安全约束、
  工作原理、排障与贡献说明；添加 CI/许可证徽章与 “powered by dsh” 徽章。
- `tests/README.md`、`ui-bundle/README.md` 改为英文并去掉与特定会话绑定的表述。
- 新增 `CONTRIBUTING.md`、`SECURITY.md`；`.gitignore` 增加 `.env`/密钥/覆盖率等防泄漏规则。
- `package.json` 补充 repository/homepage/bugs/keywords 元数据。
- 清理提交作者邮箱：历史提交改用 GitHub noreply 地址重新发布。
- 无运行时行为变化。

## 1.0.2 — 2026-10-18

- **仓库布局改为符合 DSH 插件规范**：仓库根目录即 bundle 包根目录，`package.json`（含
  `dsh.bundle.patch`）与 `cordis.patch.yml` 都在根目录；原先的 `bundle/` 子目录已移除。
- `package.json` 合并了插件包声明（name/version/exports/files/dsh）与开发脚本（`npm test`）。
- 测试与文档中的相对路径同步更新（`../bundle/...` → `../...`），README 更新为插件包说明。
- 无运行时行为变化。

## 1.0.1 — 2026-10-18

- **修复：`/tower <指令>` 会把一条没有 `role` 的消息写入会话，导致后续模型请求 422
  `messages[N]: missing field role`（会话表现为“损坏”）。** `agent.steer` 需要完整的
  `UserMessage`（`id` + `role` + `content` + `source`），不是 `{content, source}` 初始化对象；
  转发时改为本地构造完整消息（`randomUUID()` 作为 id），与 `createUserMessage()` 的形状一致。
- 新增回归测试：mock 上下文断言转发消息带 `role:"user"` 与唯一 `id`；
  隔离 Web 运行时用 `/tower 这是一条测试消息` 实测模型正常回复，会话日志中 spliced/user/message
  均带 `role`/`id`。
- 提供 `tests/live/repair-session.cjs`：可修复已被旧版本写坏的会话日志（补 `role`/`id`，
  原子写 + 备份 + 生成验证副本）。

## 1.0.0 — 2026-10-18

- `/tower` 命令支持裸调用、`on`/`off`、以及携带用户指令（`/tower on 继续`、`/tower off 继续`、`/tower 继续`）；指令与附件通过 `agent.steer` 转发。
- 新增 `allowAgentControl` 配置：开启后模型可通过 `tower_control` 自行进出模式，必须给出理由。
- 进入模式时通过 `ctx.goals.pause` 暂停活跃 goal，并在结果中提示用户自行恢复。
- 模式持久化到 `$DSH_HOME/tower-mode/modes.json`（原子写、保留 200 条）。
- 移除 P6 验收用的临时 `tower_mode_dev` 钩子。
- 新增 README、单元测试、协议 e2e 测试与 opt-in UI bundle。
- 版本从 0.1.0 提升到 1.0.0。

## 0.1.0 — 2026-10-17

- 首个可用版本：P1–P6（mission/worktree/spawn/inbox/review/merge/rebase/teardown/mode）。
