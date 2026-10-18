# Doctor

[English](../../reference/doctor.md) | **简体中文**

`tower_doctor({repoRoot})` 是只读的。它从不获取 state 锁、写状态或改动 Git。它返回：

```json
{
  "ok": true,
  "checks": [
    { "id": "git", "status": "pass", "detail": "git version 2.55.0" },
    { "id": "state", "status": "pass", "detail": ".../state.json revision 7" }
  ],
  "environmentContract": {
    "platform": "win32",
    "gitVersion": "git version 2.55.0",
    "repoRoot": "D:/repo",
    "commonDir": "D:/repo/.git",
    "stateDir": "D:/repo/.git/dsh-tower"
  }
}
```

检查覆盖：git 可用性、仓库身份、state schema/加载、仓库配置是否存在、worker/reviewer preset 名称、
subagents 与 HMR 服务、workspace 锁持有者/是否过期、实时 roster、worktree 是否存在/归属/是否脏、
test-discovery 策略、旧版快照、batch 与租约。`warn` 是提示；`fail` 表示仓库在 spawn/merge 前需要
处理。state 加载失败会作为失败的检查报告而不是抛出，因此 doctor 在损坏的仓库上仍然有用。

环境契约仅供参考；它不是身份或授权证明。`tower_init` 仍要求控制塔角色，`tower_spawn` 仍会检查
实时子代理目录。
