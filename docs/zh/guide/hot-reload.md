# 热重载（开发）

[English](../../guide/hot-reload.md) | **简体中文**

Tower 是 Host 插件：它的工具与提示段落在 DSH 启动时加载。DSH 已内置 `@deepseek-ai/dsh-hmr` 服务，
它**在原位对账 profile**——重新读取 profile 的 patch 层，替换文件已变更的模块（包括 `dsh-tower`
检出这样的 linked 包），重启受影响的 Loader 条目，并报告哪些情况需要完整重启。Tower 在开发中使用
该服务，因此 Host 侧改动无需重启 DSH 即可生效。

本页讲的是开发循环，使用 Tower 本身并不需要它。

## HMR 做什么、不做什么

`dsh --profile <name> --dump-config` 会打印组合后的 hmr 行：

```yaml
- id: hmr
  name: '@deepseek-ai/dsh-hmr'
  disabled: !!js '!ctx.get(''profileContext'')'
  config:
    root: []
```

- `root: []` 是随包默认值：**不监视任何源码文件**。HMR 已挂载，但文件监视处于空闲状态，因此编辑
  检出后运行中的 DSH 不会自动重载。
- 仍然可以显式请求对账（`/tower reload`、`tower_reload` 或 `plugin_manager`）；即使 `root: []`，
  它也会比较已加载模块与磁盘，并替换发生变化的模块。监视只是让保存后自动触发这次对账。
- HMR 只为 profile 启动挂载（没有 `profileContext` 时 `disabled`）。没有 profile 启动的进程会报告
  reload 不可用（`dev.hotReload` 开启时 `tower_reload` 仍注册，因此返回 `reload-unavailable`，
  而不是消失）。
- profile patch 层在 DSH 启动时加载。编辑它——实际就是 hmr 的 `root` 列表——需要**重启一次 DSH**
  才生效。运行中的进程不会重新读取 HMR 行自身的配置。

## 为检出开启监视

在本仓库的检出目录中执行：

```powershell
npm run dev:hmr
# equivalent to:
node scripts/enable-dev-hmr.mjs
```

脚本会向 profile 的用户 patch 层
`<DSH_HOME>/profiles/<profile>/cordis.patch.yml` 追加一个带标记的块（`DSH_HOME` 默认 `~/.dsh`；
Windows 上通常是 `C:\Users\<you>\.dsh`）：

```yaml
# dsh-tower:dev-hmr
- id: hmr
  config:
    root:
      - 'D:/work/dsh-tower'
```

选项：

| 参数 | 含义 |
|---|---|
| `--profile <name>` | 要编辑的 profile。默认 `desktop`（桌面应用启动的 profile）。 |
| `--root <dir>` | 要监视的仓库目录。默认：当前工作目录的规范路径。 |
| `--dry-run` | 打印 patch 文件的 diff 后退出，不写入。 |
| `--remove` | 再次删除该标记块。 |

说明：

- 脚本是幂等的：重复运行会替换标记块，且不触碰 patch 文件的其余行。请在仓库根目录运行，或传入
  `--root D:\work\dsh-tower`。
- 写入的值是 root 的 `realpath`，使用正斜杠。**HMR 的 `root` 接受绝对路径**；相对路径会相对
  profile 目录解析，很容易出错，因此脚本总是写入绝对路径。
- profile 必须已存在。脚本不会创建 profile，也不会在 `<DSH_HOME>/profiles/<profile>/` 之外创建目录。
- 选择桌面应用实际启动的 profile（默认 `desktop`）。desktop profile 由 Electron 应用管理，请退出并
  重新启动 DSH 来完成重启。

写入该块后**重启一次 DSH**。重启之后：

- HMR 会监视检出（`node_modules`、点目录、`cache` 与 `data` 被随包 `ignored` 列表排除），并在 DSH
  保持打开时于编辑后对账 profile。
- `/tower reload`（以及注册后的 `tower_reload` 工具）可以按需对账，即使文件不在监视范围内。

停止监视：运行 `npm run dev:hmr -- --remove`，再重启一次 DSH。

## 编辑循环

1. 编辑 `lib/*.js`、`index.js`、`worker.js`、`reviewer.js` 或 `skills.js`。
2. 保存文件。监视器会去抖（DSH 默认 100 ms）并对账 profile；变更的模块被替换，受影响的 Loader
   条目重启。
3. 观察 DSH 日志中的 `reload plugin at <path>` / `restart required: …` 消息。
4. 可选：调用 `/tower reload` 或 `tower_reload` 立即对账，而不必等监视器。

编辑仓库的 bundle patch（`cordis.patch.yml`）会改变插件声明本身；此类改动后请重启 DSH，不要假设
热替换会生效。

工具背后的桥接遵循 `dev` 配置组：

| 配置键 | 含义 |
|---|---|
| `dev.hotReload` | 注册 `tower_reload`；关闭时 `/tower reload` 也被禁用（默认 `true`）。无 HMR 服务时工具仍注册，以便返回 `reload-unavailable`。 |
| `dev.reloadDelayMs` | 计划中的对账运行前的延迟，单位毫秒（默认 `50`），让工具/命令结果先送达模型，再替换插件。 |
| `dev.reloadRequiredIds` | profile 必须保持活跃的 Loader 条目 id（默认 `tower-bundle`、`tower`、`tower-skills`、`preset-tower-worker`、`preset-tower-reviewer`）。即使某个 required 条目早已处于非活跃状态，也会被报告为重载失败。 |

重载是**调度而非等待**：`/tower reload` 与 `tower_reload` 立即返回 `scheduled`、`delayMs`、
`requiredIds`（以及存在待处理错误时的 `lastError`），随后 HMR 在延迟后对账 profile。这是有意为之——
工具结果必须先送达，Tower 插件才能替换自身。两个后果：

- 延迟窗口内的一批重载请求会合并为一次对账；
- 对账失败会记录为 `lastError`，而不会从工具调用返回，因此重载后请检查 `tower_mode.hotReload`
  与 DSH 日志。

### 阅读重载结果

计划中的对账结果会出现在：

- **DSH 日志** —— 被替换模块的 `reload plugin at <path>`，以及 HMR 自身的告警与
  `restart required: <reason>` 消息。
- **`tower_mode.hotReload`** —— `{available, requiredIds, delayMs, scheduled, lastRunAt, lastError}`；
  `lastError` 保留最近一次失败，并在下次成功重载后清除。

对账本身还会返回 `warnings`、`pending`（仍运行旧代码的模块）以及可选的 `restartReason`。由 Tower
触发重载时，这些不会返回给模型，因此把“新代码没有出现”视为需要重启 DSH 的信号，而不是反复重试。

没有 HMR 时，`/tower reload` 会回答不可用消息，且 `tower_reload` 根本不会注册（两者都在会话启动时
由 HMR 服务决定是否启用）。

## plugin_manager 与 linked 包

`plugin_manager` 操作（`install_bundle`、`set_plugin`、升级）会立即作用于运行中的 profile——它们
自己会对账 profile，因此安装或更新 bundle 不需要重启。开发时安装 `dsh-tower` 的推荐方式就是如此：
把检出作为 bundle 添加（`dsh plugin --profile <profile> add <repo-root>` 或 `install_bundle`），
然后让 HMR 与重载工具接住代码编辑。

检出作为 linked 包目标时，检出内的文件变更会在下一次 `reconcileProfile` 或 `plugin_manager` 操作时
被替换，**无需重启**——即使 `root: []` 意味着该变更没有被监视。真正需要重启的是：

- hmr 行自身的配置（`root`），因为该列表在服务激活时读取；
- 报告在 `pending` 下或带 `restartReason` 的模块。

## 故障恢复

| 症状 | 处理 |
|---|---|
| `[tower:reload-unavailable]` / “Tower reload is unavailable” | 该进程没有 HMR 服务（未带 profile 启动、profile 中 HMR 被禁用，或服务在关闭过程中已 dispose）。重启 DSH。要检查 hmr 行，在非 desktop profile 上运行 `dsh --profile <name> --dump-config`（desktop profile 由 Electron 应用管理，拒绝 dump）。 |
| `hotReload.lastError` 中出现 `[tower:reload-failed]` 且伴随语法/导入错误 | 修复文件后重启 DSH。替换失败会停掉旧插件实例，旧代码不再运行；重载本身不会回滚。 |
| `HMR is disposed` | 服务随进程关闭。重启 DSH。 |
| `HMR transactions cannot be nested` | 在另一个 HMR 事务内部请求了显式重载；请从普通工具回合调用。 |
| `pending` 非空或设置了 `restartReason` | 先重启 DSH，再相信重载结果。 |
| 已保存但没有任何重载 | 确认文件位于配置的 `root`（绝对路径）下，未被 `ignored`（`node_modules`、点目录、`cache`、`data`）排除，且 profile patch 包含标记块。运行 `/tower reload` 手动对账。 |
| 重载持续报告某个 required 条目非活跃 | 该 Loader 条目被禁用或启动失败：检查 profile 的插件/bundle（移除 Tower preset bundle 后 `preset-tower-*` 条目会缺失），修复后重启。 |

离线桥接测试属于常规测试套件：

```powershell
node --test tests/hmr.test.mjs
```

## Client bundle（`ui-bundle`）不同

HMR 替换的是 **Host** 插件与提示/工具代码。可选的 `ui-bundle` 是 Client 小部件：它的 JavaScript 由
Web 页面下载并执行，而不是 Host 进程。Host 重载或 Client bundle 安装/更新后，已打开的页面可能仍保留
旧小部件——在认为改动失败之前，先刷新 Web 页面（如果工具 schema 有变化，再打开新会话）。Tower UI
小部件只是一个提示，与热重载没有依赖关系。

要在隔离 profile 上对重载路径做实机检查，使用
[`tests/live/hmr.cjs`](../../../tests/live/hmr.cjs)，并把 `DSH_TEST_URL` 指向一次性服务器 URL
（见 [tests/README.md](../../../tests/README.md)）；它不会触碰 desktop profile 或在线会话。

## 安全

HMR 会在 **DSH Host 进程内**执行它在被监视 root 中找到的代码，使用你的操作系统用户权限，并在保存时
重载。请像对待 shell 启动文件一样对待 profile patch 层：

- 只把 `root` 指向你信任的仓库（本检出），并保持列表小而绝对；
- 不要加入主目录、下载目录或共享/网络路径；
- 被 patch 的 profile 属于同用户可信配置；能写它的人就能在你的 DSH 进程中执行代码；
- 不再需要监视时，移除该块（`--remove`）并重启一次。

另见：[安装、升级与迁移](install-upgrade-migration.md)、
[配置参考](../reference/config.md)、[错误码](../reference/errors.md)。
