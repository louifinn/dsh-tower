# Tower tests

三层测试：纯函数、协议端到端、真实 DSH Web 运行时。前两层不依赖 DSH，第三层在**独立的临时 profile**里跑，不碰正在使用的 `desktop` profile。

下面的命令都在**本仓库根目录**（含 `package.json` 的目录）执行；`$DSH_HOME` 指 DSH 的数据目录（默认 `~/.dsh`，Windows 通常是 `C:\Users\<you>\.dsh`）。

## 1. 离线套件（每次改代码都先跑）

```powershell
npm test
# 等价于：node --test "tests/*.test.mjs"
```

> Node 的 `--test` 不再接受目录参数，必须给 glob；给目录会报 `Cannot find module`。

- `unit.test.mjs` — 纯函数：scope 重叠、scope 校验、ASCII 标题、glob 匹配。
- `protocol.e2e.test.mjs` — 通过 `Tower` 域类跑完整协议：init → plan → worktree → 任务 → 未读阻塞 → complete → finding → review → preflight → merge → teardown，以及 scope 重叠自动依赖、未知依赖拒绝。
- `plugin.test.mjs` — 用最小 mock Cordis context 直接加载 `bundle/index.js` 的 `apply()`：`/tower` 各写法的语义、附件转发、`agent.steer` 收到完整 `UserMessage`、guard 拒绝、动态提示段、goal 暂停、`tower_control` 开关与 reason 校验、模式持久化。测试会临时改 `$DSH_HOME`，不会写真实 store。

测试在系统临时目录创建仓库/状态并自动清理。

## 2. 真实 Web 运行时（隔离 profile）

用途：验证命令注册、真实 `agent.steer`、`ctx.goals`、guard、工具输出序列。用**另一个 profile + 另一个端口**，不影响正在使用的 profile。

```powershell
# 1) 从 shipped web 模板建一个一次性 profile（不要用 desktop：它只能由 Electron 启动）
dsh --profile towertest --from-default-profile web --dump-config
# 2) 把本仓库的 bundle 装进该 profile（会自动注册进 dsh.profile.bundles）
dsh plugin --profile towertest add <repo-root>\bundle
# 3) 启动隔离服务（记下打印的 token URL）
dsh --profile towertest --port 59001 --no-open
```

`tests/live/*.cjs` 依赖全局安装的 Playwright（`NODE_PATH` 指向全局 node_modules 即可；Windows 下用 `npm root -g` 查看路径）。浏览器默认用 Playwright 自带版本，也可用 `DSH_TEST_CHROME` 指定可执行文件。

### 命令语义（不需要模型）

```powershell
$env:DSH_TEST_URL='http://127.0.0.1:59001/?token=<启动时打印的 token>'
node tests/live/command.cjs
```

脚本会新建会话，依次提交 `/tower on 继续`、`/tower`、`/tower off 继续`、`/tower 继续`，截图与日志写到 `tests/live/`。

### 模型驱动的工具/GUARD（需要可用账号）

`towertest` 的 profile 名不是 `desktop`，默认拿不到账号 route。用 overlay 把 account platform 挂上：

```powershell
dsh --profile towertest --patch <repo-root>\tests\live\account.patch.yml --port 59002 --no-open
$env:DSH_TEST_URL='http://127.0.0.1:59002/?token=<上一步打印的 token>'
node tests/live/model.cjs
```

`model.cjs` 依次让模型：`tower_control enter` → 观察 `tower_mode` → `create_goal`（应被 guard 拒绝）→ `tower_control exit`。

### 清理

```powershell
# 停掉服务后：
Remove-Item -Recurse -Force "$env:USERPROFILE\.dsh\profiles\towertest"
# 只删除本次测试新建的 session 目录；别按时间批量删，会误删用户会话
# $DSH_HOME/tower-mode/modes.json 里本次测试留下的条目也一并清掉
```

`tests/live/` 下的 `*.log`、`*.png`、`backup/` 是本地验收产物，已在 `.gitignore` 中排除，不会进入仓库。

### 诊断与修复脚本（`tests/live/`）

这些脚本从环境解析 `$DSH_HOME`，默认按**当前工作目录**推导 session 目录；也可用 `DSH_SESSION_ROOT` 显式指定。

- `scan-session.cjs <文本>` — 在所有 session 日志里搜索一段文本（解码串联 zstd 帧）。
- `dump-session.cjs <session 后缀> <from> <to>` — 按 seq 导出事件，用于定位坏消息。
- `validate-messages.cjs <session 后缀>` — 检查所有 user/assistant/system/tool 消息与 inbox splice 是否带 `id`/`role`（problems=0 才算干净）。
- `repair-session.cjs <session 后缀>` — 修复 1.0.0 的 `missing field role` 损坏：只允许修“恰好两处”role-less user 消息，备份到 `tests/live/backup/` 后原子替换，并另写一个换 id 的验证副本。
- `steer-role.cjs` — 1.0.1 的隔离 Web 回归：`/tower 这是一条测试消息` 后模型必须正常回复。

## 3. 装到 desktop 后的手工验收清单

安装/重启 desktop 后（宿主插件在进程启动时加载，改完代码必须重启 DSH）。

> desktop 的 Web UI 对普通浏览器返回 401（需要启动时 token），自动化无法代打 `/tower`；第 1–4 项必须在 desktop 输入框里由人输入。第 5–8 项可以让人工或模型直接调用 `tower_control` / `tower_mode` 验证。

1. `/tower` → 模式 on；`tower_mode` 显示 `mode:"on"`。
2. `/tower on 继续` → 模式 on，且“继续”作为用户消息进入下一轮。
3. `/tower off 继续` → 模式 off，且“继续”进入下一轮。
4. `/tower 继续` → 模式 on + 指令转发。
5. 模式 on 时：`create_goal`、`todo_write`、`spawn_teammate`、`update_goal(resume)` 被 guard 拒绝。
6. 若有活跃 goal：`/tower on` 后 goal 变为 paused（`tower_mode.pausedGoal` 有值）。
7. `/tower off` 后 `todo_write` 恢复可用；`update_goal` 不再被 tower guard 拦截。
8. 重启后同 session id 的 `tower_mode` 仍为 on（`$DSH_HOME/tower-mode/modes.json`）。
9. 配置 `allowAgentControl: true` 时 `tower_control` 出现；默认 false 时不存在。
10. 全链路：`tower_init → plan → spawn(worker) → inbox → complete → spawn(reviewer) → review → preflight → merge → teardown`，并逐个触发 13 个 blocker code（见 `bundle/README.md`）。
