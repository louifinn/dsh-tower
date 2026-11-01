# GLOSSARY

The canonical bilingual vocabulary for Tower's user-facing copy. Plain language
first: a component label says what a person can do, then what changes when the
component is off. The reader should not need to know a config key, a tool id or
an internal module name.

This file is enforced. `npm run docs:check:components` fails when a label field
in `locale/`, the generated `locale/<specifier>/` row labels or
`ui-bundle/locale/` uses a different Chinese term, leaves the English word
untranslated, or drifts from the table below. The gate that enforces it is
described in [ADR 0005](docs/adr/0005-component-surface.md) (wave-4 addendum,
#137).

## Canonical vocabulary

One term per concept, in both languages. Use these in every label, summary and
off-state sentence.

| Concept | English | 中文 | Notes |
|---|---|---|---|
| mission | mission | 任务线 | The unit of work a Tower session plans, executes and merges. Reserve 任务 for a single task inside a mission. |
| task | task | 任务 | One checklist item inside a mission. Not a substitute for 任务线. |
| batch | batch | 批次 | A finite evidence batch. Do not mix 批量 into label copy; that word describes bulk actions, not the component. |
| doctor | doctor | 体检 | The read-only health check. Do not use 诊断 as a noun for the health tool. |
| board | board | 看板 | The human-readable mission board (`MISSIONS.md`). |
| archive | archive | 归档 | Moving finished missions out of the live state file. |
| preset | preset | 预设 | A shipped role definition. Never leave the English word in Chinese copy. |
| worktree | worktree | 工作树 | The isolated checkout a worker runs in. |
| review | review | 审查 | The review contract and the act of reviewing. Do not use 评审 in plugin-page copy. |
| review policy | review policy | 审查策略 | The one tri-state control on the plugin-page configuration form: off, optional (default) or required. It is not a component row and never three mutually exclusive rows. |
| lease | lease | 租约 | Advisory resource coordination. Never 咨询式租约: the lease coordinates, it does not consult. |
| worker | worker | 执行代理 | The role that executes a mission. "Tower Worker" is a product name and stays as-is. |
| reviewer | reviewer | 审查代理 | The role that independently reviews a mission. "Tower Reviewer" is a product name and stays as-is. |

## Product names and other surfaces

Brand and product names are not translated: Tower, DSH, Tower Worker, Tower
Reviewer, Tower UI, MISSIONS.md. On first use in a sentence, gloss an unfamiliar
one parenthetically — for example "Tower Codex (Tower's earlier state format)".

The Web client has its own string catalogue (`ui-bundle/client.locales.js`).
When its wording disagrees with this table, this table wins and the client copy
is migrated separately under the same glossary.

## Copy rules

1. One sentence for the capability, one sentence for the off consequence.
2. No config-key syntax (`gates.requireTests:true`), no bare tool ids
   (`tower_batch`), no slash commands (`/tower reload`) and no module specifiers
   in a label field. Describe the capability and the effect instead.
3. Say "Tower mode", not just "模式", and "refused with an explanation", not
   "locked": the user needs to know they will get the reason.
4. The off sentence must be truthful. A lease is coordination only, but a worker
   configured to require one cannot start while the lease row is off — planning
   and Tower-mode entry are refused with an explanation until the setting is
   cleared or the row is re-enabled. Say that, and say that everything else keeps
   working.
5. English and Chinese must agree field by field. Chinese copy reads as Chinese:
   no untranslated English common nouns, no machine-translated calques — say
   关闭该批次, not 收口; 当前状态文件, not 在线状态文件; 某一具体工作, not
   一项命名工作; and 卡住的锁如何恢复, not 锁状态的恢复出口.
6. When turning a row off makes an operation impossible under the current
   settings, name that operation (planning, entering Tower mode, merging) and how
   the user clears the requirement. Never claim a blocked operation keeps
   working: a reviewer preset needed for merging is a precondition, not an
   optional extra, and test evidence that cannot be recorded keeps merges blocked
   until the requirement is cleared.
7. Describe the review policy as one tri-state control (off / optional /
   required), never as three rows and never as a capability that is permanently
   on. In required mode it is a merge precondition; in off mode review is
   intentionally unavailable. The deprecated boolean alias maps true → required,
   false → optional, and unset → optional.
