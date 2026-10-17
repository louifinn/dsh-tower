# Changelog

## 1.0.1 — 2026-10-18

- **修复：`/tower <指令>` 会把一条没有 `role` 的消息写入会话，导致后续模型请求 422
  `messages[N]: missing field role`（会话表现为“损坏”）。** `agent.steer` 需要完整的
  `UserMessage`（`id` + `role` + `content` + `source`），不是 `{content, source}` 初始化对象；
  转发时改为本地构造完整消息（`randomUUID()` 作为 id），与 `createUserMessage()` 的形状一致。
- 新增回归测试：mock 上下文断言转发消息带 `role:"user"` 与唯一 `id`；
  隔离 Web 运行时用 `/tower 这是一条测试消息` 实测模型正常回复，会话日志中 spliced/user/message
  均带 `role`/`id`。
- 提供 `tower/tests/live/repair-session.cjs`：可修复已被旧版本写坏的会话日志（补 `role`/`id`，
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
