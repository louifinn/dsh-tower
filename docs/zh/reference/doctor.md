# Doctor

[English](../../reference/doctor.md) | **简体中文**

`tower_doctor({repoRoot})` 是只读的。它从不获取 state 锁、写状态或改动 Git。它返回：

```json
{
  "ok": true,
  "checks": [
    { "id": "git", "status": "pass", "detail": "git version 2.55.0" },
    { "id": "state", "status": "pass", "detail": ".../state.json revision 7" },
    { "id": "activity-log", "status": "pass", "detail": "activity.jsonl 1024 B live + 2 rotated segment(s) 8192 B (cap 4194304 B, retention 5)" },
    { "id": "ralph-stance", "status": "pass", "detail": "no live Ralph loop in this repository" }
  ],
  "stateLock": {
    "held": true,
    "pid": 4242,
    "startedAt": 1761280000000,
    "at": 1761280120000,
    "alive": true,
    "ageMs": 121000,
    "heartbeatAgeMs": 1000,
    "staleAfterMs": 3000,
    "stale": false
  },
  "gitLock": {
    "held": true,
    "pid": 4242,
    "phase": "merge",
    "heldMs": 92000
  },
  "ownership": {
    "owner": "session-abc",
    "caller": null,
    "sameOwner": false,
    "ownerMode": "off",
    "modeStoreStatus": "ok",
    "modeStoreFile": "D:/home/tower-mode/modes.json",
    "modeStoreError": null,
    "ownerLock": false,
    "foreignLock": false,
    "liveRoster": [],
    "unreadMessages": 0,
    "orphanLock": false,
    "blockers": [],
    "takeoverAvailable": true
  },
  "archive": {
    "missions": 3,
    "archivedMissions": 12,
    "stateBytes": 48211,
    "archiveBytes": 190244,
    "years": [2026],
    "files": 2,
    "unreadable": [],
    "policy": { "enabled": true, "afterDays": 30, "maxMissions": 100 }
  },
  "environmentContract": {
    "platform": "win32",
    "gitVersion": "git version 2.55.0",
    "repoRoot": "D:/repo",
    "commonDir": "D:/repo/.git",
    "stateDir": "D:/repo/.git/dsh-tower",
    "caseInsensitive": true,
    "comparisonMode": "case-insensitive",
    "ralphLoop": {
      "scopedRounds": 0,
      "liveScopedRounds": 0,
      "processRuns": 0,
      "detail": null
    }
  }
}
```

`stateLock`（以及 `state-lock` 检查）报告锁的年龄（`ageMs`，从记录的 `since` 起算）与心跳新鲜度
（`heartbeatAgeMs`，从最后一次 `at` 起算），并对照过期窗口（`staleAfterMs = 3 × 1000 ms`）。
PID 存活并不等于写者存活：停止心跳的持有者会报告 `stale: true`，但“存活但静默”的持有者
**绝不会被自动回收**。只有 PID 被证实已死亡的锁才会由下一次 mutation 原子回收。要回收
“存活但静默”的锁，需要操作者确认进程已消失，并运行
`tower_recover clear-stale-lock force:true` 且提供 `confirm:"CLEAR_STALE_LOCK"`；该操作会把锁记录
移到备份，而不是删除它。这样无需手工读取 `state.lock` 就能诊断 PID 被复用的情况。

`ownership`（以及 `tower-owner`/`workspace-lock` 检查）与 `tower_status` 返回同一个只读所有权快照；
state 或所有权事实无法读取时为 `null`。字段包括 `owner`、`caller`、`sameOwner`、`ownerMode`、
`modeStoreStatus`、`modeStoreFile`、`modeStoreError`、`ownerLock`、`foreignLock`、`liveRoster`、
`unreadMessages`、`orphanLock`、`blockers` 与 `takeoverAvailable`。`modeStoreStatus` 为
`missing`、`ok` 或 `corrupt`。为 `corrupt` 时，`ownerMode` 是 `unknown`（绝不会是 `off`），
`blockers` 的第一项为 `mode-store-corrupt` 并附带修复动作，`takeoverAvailable` 为 `false`：
takeover 会 fail closed，而不会把不可读的模式存储误判为属主不活动。doctor 与 status 通过
这个字段保持一致。

`gitLock`（以及 `git-lock` 检查）报告仓库级 git 互斥锁：被 merge/rebase/init/teardown/provision 持有时为
`{held, pid, phase, heldMs}`，空闲时为 `{held: false}`。merge 可以合法持有到配置的 merge 超时（默认 15 分钟），
因此“被持有”是 `warn` 而不是失败；持有者的阶段与时长让卡住的控制塔可被诊断。`tower_status` 返回同一个
`gitLock` 对象。

`board` 报告 `MISSIONS.md` 位置（`docs.boardLocation`）以及 `tower-board` 组件行是否挂载。该行关闭时
检查为 `warn`，说明看板不会被写出（已有看板会变陈旧）并指出该行名；所有状态工具与门禁仍然工作。

`archive` 报告终态任务归档：活跃 `missions`、`archivedMissions` 与 `stateBytes`，归档目录的
`archiveBytes`/`years`/`files`，每条 `unreadable` 诊断，以及调优字段 `policy`（`afterDays`、
`maxMissions`）。`policy.enabled` 反映 `tower-archive` 组件行，而不是配置键：该行关闭时策略行说明
归档被组件禁用，终态任务留在热状态，`state.json` 持续增长。归档目录不存在是健康的空归档
（`archive` 检查为 `pass`）；截断的 index/year 文件是
`warn` 并附带诊断，且归档会暂停而不是覆盖它——归档不可读期间没有数据会丢失，符合条件的 mission 仍留在
`state.json`。

检查覆盖：git 可用性、仓库身份、state schema/加载、仓库配置是否存在、worker/reviewer preset 名称、
subagents 与 HMR 服务、workspace 锁持有者/是否过期、实时 roster、worktree 是否存在/归属/是否脏、
test-discovery 策略、完成报告大小、归档健康度、旧版快照、batch 与租约。被 `tower_teardown` 正常清理的 mission worktree 会被
跳过（检查中会注明已移除数量），不会被误报为 missing。`warn` 是提示；`fail` 表示仓库在 spawn/merge 前需要

`caseInsensitive` 是 `tower_init` 在检出目录所在文件系统上一次性探测的结果；`null` 表示“尚未探测”，
此时 `case-mode` 检查为 `warn`。`comparisonMode` 是 scope 匹配实际使用的比较方式：
`case-insensitive` 会折叠双方大小写，`case-sensitive` 则保持逐字节精确。doctor 从不执行探测（探测会
创建临时文件，只读调用不能写入）；在没有可用写权限的检出上运行 `tower_init` 会记录该模式，在此之前
使用安全的 `case-sensitive` 默认值。

`environmentContract.ralphLoop`（以及 `ralph-stance` 检查）把活跃的 Ralph 循环报告为环境事实：
本仓库有一个进行中的循环，Tower 无法与之共同持有它（见
[ADR 0010](../../adr/0010-tower-ralph-mutual-exclusion.md)）。round 按其父会话的 cwd 归属到本检出
（`scopedRounds`、`liveScopedRounds`）；第一方 workflow run 不携带 cwd，因此 `processRuns`
按进程计数，且仅当尚无 round 匹配到本仓库时才据此告警。`warn` 的 action 会说明
`mode.ralphPolicy` 的两种结果；循环本身不由 doctor 停止。

检查覆盖：git 可用性、仓库身份、state schema/加载、已探测的大小写模式、仓库配置是否存在、
worker/reviewer preset 名称、subagents 与 HMR 服务、state 锁年龄/心跳、workspace 锁持有者/是否过期、实时 roster、
worktree 是否存在/归属/是否脏、test-discovery 策略、旧版快照、batch 与租约。被 `tower_teardown`
正常清理的 mission worktree 会被跳过（检查中会注明已移除数量），不会被误报为 missing。`warn` 是提示；`fail` 表示仓库在 spawn/merge 前需要
处理。state 加载失败会作为失败的检查报告而不是抛出，因此 doctor 在损坏的仓库上仍然有用。

`reports` 检查会指出仓库中最大的完成报告（`<bytes> B on <mission>`，对照 `gates.maxReportBytes` 上限），
同样的数据也以 `reports: { count, largest: { missionId, bytes } | null, capBytes }` 返回。上限生效前写入的
报告只会产生 `warn`，doctor 绝不会重写它们。

环境契约仅供参考；它不是身份或授权证明。`tower_init` 仍要求控制塔角色，`tower_spawn` 仍会检查
实时子代理目录。
