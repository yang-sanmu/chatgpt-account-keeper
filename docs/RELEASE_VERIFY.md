# N-1 → N 验收

发布前唯一的人工闸门。两条发布流程（[远端](RELEASE_REMOTE.md) / [本地](RELEASE_LOCAL.md)）都要求先做完这一步，才允许创建 Draft Release。

## 名字的含义

`N` 是即将发布的新版本，`N-1` 是当前线上版本。"N-1 → N 验收"就是：**在真实安装的旧版本之上，用新版本安装包覆盖升级一次，确认用户数据完好、程序正常工作。**

不是测新版本能不能装，而是测**从旧版本升上来**这条路径。

## 为什么必须做

因为绝大多数发布事故只在升级路径上出现，全新安装测不出来。

**1. 全新安装和升级走的是完全不同的代码路径**

全新安装：空数据目录 → 建库 → 初始化。
升级安装：已有数据目录 → 打开旧库 → **执行 schema 迁移** → 继续用。

`src/persistence/schema.js` 里有 `schema_migrations` 迁移账本（记录 `version` / `checksum` / `applied_at`），`sqliteRepository.js` 在启动时按版本号增量应用迁移。这段逻辑**只在存在旧库时才会跑**。你装一个全新的 N，它建的是最新 schema，一行迁移代码都不会执行 —— 迁移写错了也测不出来。

**2. 数据目录故意不随卸载删除**

`AppPaths.cs` 把数据放在 `%APPDATA%\GptAccountKeeper`（与安装目录分离），卸载时故意保留，这样重装/升级不会静默毁掉 Profile 数据。好处是数据安全，代价是：**旧数据会一直留在那里等着新版本去读**。新版本读不懂旧数据的问题，只有升级测试能暴露。

顺带一个已知的坑：这个项目历史上反复出现 `DATA_ROOT` 与 `ROOT` 混用的 bug，而它在 CLI 布局下测不出来 —— 正是这类"布局差异导致的问题"，只有装出来跑才会现形。

**3. 升级过程本身要停掉正在运行的 Agent**

`UpdateService.cs` 用的是 VeloPack 的 `WaitExitThenApplyUpdates(target, silent: true, restart: true)`：等进程退出 → 替换文件 → 重启。而 Agent 是独立进程，还持有 SQLite 连接、Chrome 上下文、mihomo 内核。升级前必须让它干净退出（`prepareUpdate` 会检查阻塞项、drain 调度、做数据库 checkpoint），否则可能留下锁文件、半写入的库，或者残留进程导致新版本起不来。

这段协调逻辑跨 Desktop 和 Agent 两个进程，**只有真的装起来升一次才能验证**，单元测试覆盖不到。

**4. 未签名安装包的 SmartScreen 行为**

顺带确认一下用户首次运行会遇到什么，见 [无签名发布](RELEASE_REMOTE.md#无签名发布)。

## 怎么做

### 准备

拿到两个安装包：

- **N-1**：当前线上版本，从 [Releases](https://github.com/yang-sanmu/chatgpt-account-keeper/releases) 下载 `GptAccountKeeper.Desktop-win-Setup.exe`
- **N**：本次候选包
  - 远端流程：`artifacts\candidate-<版本>\GptAccountKeeper.Desktop-win-Setup.exe`
  - 本地流程：`artifacts\Releases\GptAccountKeeper.Desktop-win-Setup.exe`

> 在日常使用的机器上做要小心：安装 N-1 会覆盖你现有的安装，而数据目录是共用的。如果本机数据重要，先备份 `%APPDATA%\GptAccountKeeper`，或改用虚拟机 / 另一个 Windows 用户账户。

### 1. 装 N-1 并造出真实数据

装完之后**别只是打开看一眼就关**，要造出足以覆盖各类数据的状态：

- 添加至少 2 个账号，其中 1 个完成登录（产生真实 Chrome Profile 和 Cookie）
- 建 1 个分组，配 1 个代理节点
- 编辑 1 个会话集
- **手动"立即运行"一次任务**，让它产生对话历史
- 让调度至少跑过一轮，或手动触发一次状态刷新

目的是让数据库里有真实数据、磁盘上有真实 Profile。空数据库升级是不会出问题的 —— 有数据才有迁移风险。

### 2. 覆盖安装 N

直接运行 N 的 `Setup.exe`，不要先卸载 N-1。**先卸载再装就变成全新安装了，等于没测。**

首次运行会出现 SmartScreen「未知发布者」，点「更多信息 → 仍要运行」。

### 3. 逐项确认

| 检查项 | 期望 | 失败意味着 |
|---|---|---|
| 账号列表 | 数量、备注、启用状态与升级前一致 | 数据库迁移丢数据 |
| 已登录账号的登录态 | 仍是已登录，不要求重新登录 | Profile 路径或 DPAPI 处理有问题 |
| 分组与代理 | 配置、节点、启停状态都在 | 代理配置迁移有问题 |
| 会话集 | 内容完整 | 会话数据迁移有问题 |
| 历史记录 | 升级前跑的那次任务记录还在 | 历史表迁移有问题 |
| Agent 状态 | 自动重启，界面能连上，不报连接错误 | IPC 或 Agent 启动有问题 |
| 调度 | 恢复到升级前的启停状态 | 调度状态未持久化 |
| 版本号 | 界面左上角显示 N | 更新没真正生效 |
| 设置页「关于与许可」 | 能打开 `licenses\`，含 LICENSE / THIRD_PARTY_NOTICES.md / PRIVACY.md / SOURCE.md | 许可材料没打进包 |
| 用一次核心功能 | 「立即运行」能跑通，Chrome 正常启动 | 运行时被升级破坏 |

再打开一次设置页的诊断日志，确认没有迁移失败或数据库错误的告警。

### 4. 通过后才创建 Draft

确认全部通过，再执行对应流程的 `-NMinusOneVerified` 那一步。这个开关是强制的，不带脚本会直接拒绝 —— 它的作用就是让"我验过了"变成一个显式动作，而不是默认假设。

## 如果发现问题

**还没公开**（只有 Draft）：直接删掉 Draft 和 tag，修完换一个版本号重新走流程。同一版本号不能重发。

```powershell
gh release delete v<版本> --repo yang-sanmu/chatgpt-account-keeper --yes
git push origin :refs/tags/v<版本>
git tag -d v<版本>
```

**已经公开**：立刻改回 Draft，这会马上把它从客户端可见的更新源里移除。

```powershell
gh release edit v<版本> --repo yang-sanmu/chatgpt-account-keeper --draft=true
```

已经升级到坏版本的用户不会自动回滚，需要发一个更高版本号的修复版把他们带出来。这就是为什么这一步不能跳。

## 多版本跨越

客户端可能从更早的版本直接升上来（比如 N-3 → N），VeloPack 支持跳版本升级。如果本次改了数据库 schema 或数据目录布局，建议**额外测一次从最早还有用户的版本升级**，因为迁移是按版本号逐级应用的，跨多级时会连续执行多个迁移脚本，出错概率更高。

日常小改动（只改 UI、修 bug、不动 schema）测 N-1 → N 就够。

## 不要降级安装

Agent 会拒绝打开比自己更新的数据库，报 `DATABASE_TOO_NEW`。所以装了 N 之后再装回 N-1，程序会起不来（数据没坏，但旧版本读不了新 schema）。

验收时如果需要重复测多轮，每轮都要先删掉数据目录再从 N-1 装起，不能直接降级回去。

另外 `sqliteRepository.js` 还会校验迁移账本：迁移脚本的 checksum 与账本记录不一致会报 `MIGRATION_CHECKSUM_MISMATCH`。这意味着**已发布版本的迁移脚本不能再改动**，需要修正就追加一个新迁移。
