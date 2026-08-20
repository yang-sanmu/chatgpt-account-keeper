# GptAccount Keeper 原生 C/S 与 AOT 重构计划

## 一、目标与技术定案

建议重构，但采用“保留浏览器自动化核心、替换管理与分发层”的渐进方案，不直接重写 Playwright/CDP。

```text
Keeper.Desktop
Avalonia 12 + .NET 10 NativeAOT
原生窗口 / 托盘 / 更新器
             │
       Named Pipe / Unix Socket
             │
Keeper.Agent
私有 Node 24 LTS + playwright-core
SQLite / 调度 / Profile / mihomo
             │
       本机真实 Google Chrome
```

固定决策：

- 管理端使用 Avalonia 原生桌面窗口，不包含 HTML、WebView 或浏览器壳。
- Desktop 自包含发布，无需用户安装 .NET。[Avalonia NativeAOT 官方说明](https://docs.avaloniaui.net/docs/deployment/native-aot)
  - **支持的 Release RID 必须通过真实 NativeAOT publish；功能/交互验收与 AOT 门禁分别计分。**
    日常 F5 和 UI 迭代可以使用普通 Debug 构建，但不能把非 AOT 的 Release 伪装成完成品。
  - 运行时反射扫描、动态 XAML 和反射式 DI 禁止进入发布路径。MVVM 可以使用轻量手写实现，
    也可以使用经过 AOT 验证的 source generator；计划不强制指定某一个 MVVM 包。
- 自动化 Agent 暂时保留 Node，但携带私有 Node 24 LTS；用户不需要 Node、npm、Git 或源码。
- Playwright 固定当前行为基线 `1.61.1`，改用 `playwright-core`，不下载或携带 Chromium。
- 登录、巡检、自动对话、打开网页全部只使用本机真实 Google Chrome；不存在时返回 `CHROME_NOT_FOUND` 并提示安装。
- 管理通信不使用 HTTP/TCP，不监听 `localhost:5173`。
- Windows x64 首发。**macOS/Linux 发行、Authenticode 签名、公证、SBOM 移出 v1**：
  这些依赖证书、Apple Developer ID 和目标平台机器，写进 v1 只会让六条验收项永久黄灯。
  v1 交付一个可用的、未签名的 Windows 内部版本；签名与多平台各自单列一期。
- 更新源使用当前公开的 [GitHub 仓库 Releases](https://github.com/yang-sanmu/chatgpt-account-keeper)，客户端不内嵌 GitHub Token。
- 更新默认“自动检查、只提醒”；另提供“后台下载后提醒”和“安全空闲时自动安装”。
- 开机启动可配置、默认关闭；启用后登录系统即隐藏到托盘并恢复调度。
- 首次关闭窗口询问“隐藏到托盘”或“退出全部”，允许记住选择。
- 固定发行标识：
  - 显示名：`ChatGPT Account Keeper`
  - VeloPack Pack ID：`GptAccountKeeper.Desktop`
  - Bundle ID：`io.github.yang-sanmu.gptaccountkeeper`
  - 这些标识以后即使改品牌也不再修改。

## 一之二、界面与交互需求（可验收）

第一版计划最大的缺口在这里：M4 只写了技术门禁（编译绑定、无反射、AOT 无警告）和一句
“保留完整功能但重新设计信息架构”，没有任何一条关于用什么控件、是否行内编辑、是否批量
操作、反馈机制、空状态、键盘操作。于是验收标准退化成“八个导航项显示八个不同页面”——
可测、可通过，但与好不好用零相关。**“功能存在”不等于“功能可用”。** 以下条目全部可验收。

### 布局与滚动

- 每个导航页是独立的 `UserControl` + ViewModel，由 Shell 按需承载；禁止八页共用一棵
  可见性树（会导致所有控件常驻绑定、切页不重置滚动位置）。
- 每页最多一个纵向滚动容器。**列表禁止写死 `MinHeight` 后再套外层 `ScrollViewer`**：
  这会造成嵌套滚动，鼠标滚轮必须滚到列表底部才能带动页面。列表用 `Grid` 星号行撑满。
- 操作反馈必须浮在窗口顶层，不能放在页面底部（账号页第一屏看不到）。

### 数据刷新不得破坏正在进行的编辑

- 集合更新按稳定 key 增量 diff（见 `CollectionSync`），未变化的项保持同一实例引用；
  禁止 `Clear()` + 逐个 `Add()`——它会置空 `SelectedItem`，再经选中项 setter 用服务端
  数据覆盖用户草稿，同时丢失滚动位置。
- 可编辑字段用脏标记承载（见 `EditableField<T>`）：数据刷新时脏草稿一律保留。
  状态巡检默认 15 分钟一次，26 个账号并发推事件，用户改备注时撞上的概率不低。
- 能增量应用的事件一律增量应用，只有拿不到足够信息时才排一次全量 `system.bootstrap`。

### 账号页必须显示的字段

行内可见且可编辑：备注、启用开关、分组、轮换方式、最少/最多窗口数。
行内只读显示：状态徽章（含颜色点与“· 待复核”）、相对时间（悬停显示完整时间戳与详情）、
出口标签（跟随系统／节点名／节点已失效）、轮换进度（当前主题 + 已完成/目标窗口）、
下次运行时间、上次运行结果。

### 批量操作

账号支持多选 + 批量启用、停用、刷新状态、立即运行、删除。管 26 个账号时任何批量意图
都不应退化成点 26 次。

### 其它页面

- 代理节点行显示服务器:端口、分组本地端口、延迟（带颜色分级）；测速结果实时回填到
  节点行，不能只进任务中心。
- 分组、会话集的“新建”与“编辑”必须是两个明确状态，禁止用“选中项为空”表示新建。
- 会话集重命名是非原子的（先 upsert 后 remove），执行前必须告知失败后果。
- 历史记录展示结构化问答气泡并支持复制；**禁止在取不到字段时把原始 JSON 铺给用户看**。
- Profile 页首次进入自动扫描，不要求用户先手点“扫描”。
- 任务页可按状态筛选，失败任务的稳定错误码可复制。

### 反馈、确认与键盘

- 成功／失败／提示三类 toast，失败停留更久并显示稳定错误码。
- 所有破坏性操作二次确认，确认文案必须说明**具体后果与影响范围**（涉及几个账号、
  Profile 会被保留还是删除、是否可恢复）。
- 登录需要用户在真实 Chrome 里操作，必须有前台进度窗消费 `waiting_user` 阶段，
  而不是只留一句“已提交：queued · &lt;guid&gt;”。
- 备注等文本框支持 Enter 提交；数据目录与日志路径支持“打开所在文件夹”和“复制路径”。
- 每个列表都有空状态：说明为什么是空的、下一步该做什么。

### 新增账号后的下一步

创建账号后必须直接拉起登录窗口。新账号唯一有意义的下一步就是登录，旧网页面板也是
创建成功后立刻 `doLogin`。少了这一步用户会盯着一个空账号，不知道还要再点一次"登录"。

## 一之三、路径与端口的硬约束

这两类问题在开发模式下完全不可见，但装好后必坏，且报错信息通常指不到真正原因。

### 双根不可混用

`DATA_ROOT`（用户数据）与 `ROOT`（安装目录）在安装后是两个不同的目录，在 CLI/开发
模式下相同。任何"相对路径 + 基准根"的组合都必须明确属于哪一类：

- 随版本分发的只读资源（`config/selectors.json`）→ `readResourceJson()`，
  数据目录覆盖优先、回落安装目录。升级要能替换它，用户改过的又不能被丢掉。
- 用户数据（Profile、数据库、状态缓存）→ `fromRoot()`。
- 只读程序资源 → `fromInstallRoot()`。

组合两个根的地方要在构造时断言同根（例如 `createProfileManager` 校验 `profilesRoot`
必须位于 `workspaceRoot` 之内），而不是等用户点删除时才报一句指不到原因的错误。

**测试必须在分离布局下跑。** `paths.js` 把根冻结成模块级常量，模块缓存无法在同一
进程里重置（目标模块内部的 `import "./paths.js"` 不带 query 一定命中缓存），所以要
用子进程注入 `GPT_ACCOUNT_KEEPER_DATA_ROOT`。

### 端口

- 本项目的端口段会和用户自己的 Clash Verge 重叠。撞上时**自己让路**，探测到空闲段
  再启动；绝不按进程名结束占用者的进程 —— 那会切断用户的网络。
- 边车必须等**每一个**入站端口就绪才能报告启动成功。只等第一个会让用到后面端口的
  账号间歇性拿到 `ERR_PROXY_CONNECTION_FAILED`，且重试一次往往就好，极难定位。
- 判定就绪时若自己的进程已退出，要立刻放弃，不能把第三方在同号端口上的监听
  当成自己启动成功。

### 显示值与模型值分离

下拉、筛选器的模型值必须是枚举或稳定标识，显示值单独给中文文案。禁止用中文字符串
当模型值（改文案即静默失效），也禁止把 `random`／`sequential` 这类内部值直接给用户看。

## 二、分阶段实施

### M0：基线冻结和技术验证

- 保留制定本计划时已有的 122 个 Node 测试（当前套件已继续扩充），增加一份关键行为清单：账号锁、强制重登、WAF/unknown 状态、真实 Chrome 身份覆盖、Profile 操作和调度退出。
- CI 固定 Node 24 最新 LTS 补丁版本、Playwright 1.61.1；Node 大版本或 Playwright 升级不得与 UI 重构混在同一变更中。
- 创建最小 Avalonia NativeAOT 验证程序，验证：
  - Windows x64 冷启动、托盘、中文与时区；
  - Named Pipe 通信；
  - VeloPack 安装、更新 Hook 和 NativeAOT 共存；
  - 无反射绑定、无裁剪警告。
- 若 VeloPack 托管 SDK不能通过 AOT/裁剪门禁，改用其原生 C ABI，不关闭 NativeAOT。
- 建立三个边界目录：`desktop/`、`contracts/`、Node `application/agent`；此阶段不改变现有用户行为。

### M1：抽离 Node 应用服务

- 将 `server.js` 中的业务逻辑下沉为与 Express 无关的 Application Services：
  - Account、Browser、History、Group、Proxy；
  - Conversation、Scheduler、Settings、Profile、Operation；
  - Store、Clock、Process、BrowserAutomation 等基础端口。
- Express 暂时只作为旧 REST 适配器；IPC 适配器调用同一批服务，避免维护两套业务逻辑。
- 收紧现有宽松行为：
  - 账号更新仅允许 `note/groupId/enabled/switchRule/minWindows/maxWindows`；
  - 分组只能绑定存在、启用且未 missing 的节点；
  - 代理失效时明确失败，绝不静默直连；
  - 只有用户明确选择强制重登时才允许清 Session。
- REST 与新服务层运行契约对照测试；全部通过后才开始替换前端。

**M1/M2 完成后设一个中间验证点：继续用旧 Web UI 实际使用一段时间。** 业务逻辑此时已
下沉，Express 只是薄适配器，这一步几乎零成本，却能在 UI 是唯一变量之前先确认数据层
和服务层没问题。第一版缺了这个检查点，语言、UI 框架、存储、传输、分发五样东西在同
一次变更里全换，等做到 UI 时预算已经耗尽。

### M2：稳定数据目录、SQLite 与无损迁移

Agent 成为业务数据唯一写入者，Desktop 不直接操作数据库、Profile、Chrome 或 mihomo。

默认目录：

- Windows：
  - 数据：`%LOCALAPPDATA%\GptAccountKeeper\data`
  - 引导配置：`%APPDATA%\GptAccountKeeper\bootstrap.json`
  - 缓存：`%LOCALAPPDATA%\GptAccountKeeper\cache`
- macOS：`~/Library/Application Support/GptAccountKeeper`
- Linux：`${XDG_DATA_HOME:-~/.local/share}/gpt-account-keeper`
- 安装目录与数据目录严格分离，更新和卸载不得覆盖 Profile/数据库。
- 首次迁移允许选择其他本地固定磁盘；拒绝把 SQLite/Profile 放在安装目录、网络盘或旧源码目录。

SQLite 使用 `better-sqlite3`，按 RID 在 CI 预编译，不在用户机器编译。核心表：

- `schema_migrations`、`command_receipts`
- `app_settings`、`proxy_settings`、`proxy_nodes`
- `groups`、`conversation_sets`
- `accounts`、`account_status`
- `scheduler_state`、`run_history`
- `profile_maintenance_state`、`profile_fs_operations`
- `migration_imports`、`migration_rejects`

关键约束：

- 账号只存 Profile 子目录名，不存安装目录绝对路径。
- 会话集、账号、分组和代理节点保存 `sort_order`。
- `run_history.account_id`不设强制外键，保留已删除账号的历史。
- 代理原始配置作为不透明 JSON 保存；订阅地址、代理密钥不返回 UI、不写普通日志。
- 启用 WAL、外键、5 秒 busy timeout 和一致性备份。
- 调度器持久化 `enabled/nextAt/lastAt`；错过的任务重启后每账号最多补跑一次，并加入抖动避免同时启动。

首次迁移流程：

1. 获取单实例锁，确认旧 Node 服务及正在使用目标 Profile 的 Chrome 已退出。
2. 自动检查安全候选目录；找不到旧项目时只要求用户选择一次旧项目根目录。
3. 对旧 JSON、JSONL 和 Profile 生成 SHA-256 清单；配置 JSON 损坏则中止，损坏历史行原样保存到 rejects。
4. 在迁移 staging 中构造新数据库，保留账号 ID、顺序、轮换进度、状态缓存和全部历史。
5. Profile 只复制、不移动；排除 `Singleton*`、`DevToolsActivePort` 等运行锁，保留 Cookie、Local Storage、IndexedDB 和 Service Worker 数据。
6. 迁移前要求可用空间不低于“待复制大小 + max(1 GB, 10%)”；复制后校验目录、大小和哈希。
7. 执行 `quick_check`、外键检查和计数核对，再同卷原子提升为正式数据。
8. 失败只清理本次 staging，旧源码目录保持原样；程序永不自动删除旧数据。
9. 迁移验收用 fixture 驱动的计数一致性测试（账号、Profile、分组、会话集、节点、状态、
   历史逐项核对，并覆盖已删除账号的历史保留）。**不把某次实盘的具体数字写进计划**：
   那种基线只能验收一次、无法重复，且会随用户数据变化而失效。
10. 由于旧版本没有持久化 scheduler running 状态，首次迁移后调度默认停止；用户开启一次后才永久保存。

### M3：每用户 Agent 与 IPC v1

- Agent 是当前桌面用户下的独立单实例进程，不安装成 Windows Session 0 系统服务，因此可以弹出真实 Chrome。
- **单实例必须有内核强制手段，不能依赖 PID 文件。** Agent 按规范化数据目录持有命名管道
  （Windows）或 Unix Socket（macOS/Linux）作为进程存活期锁；内核会在进程退出时释放，
  不受 PID 复用和崩溃残留影响。数据目录下的 `agent.lock` 只保存 pid、lockId 和锁端点供诊断，
  绝不作为互斥真相。Desktop 使用同样按数据目录命名的互斥量和窗口激活信号。按进程名杀
  进程永远不是可接受的实现。
- Desktop 启动时连接已有 Agent；不存在时无控制台窗口启动私有 Node Agent。
- Desktop 崩溃或窗口隐藏不影响 Agent 和自动对话；只有“退出全部”才执行 drain 并停止 Agent。
- Windows 使用当前用户 SID ACL 的 Named Pipe；macOS/Linux 使用权限 `0600` 的 Unix Domain Socket。
- 帧格式固定为“4 字节小端长度 + UTF-8 JSON”，单帧最大 8 MiB。

协议：

```text
Request  { id, method, params, commandId? }
Success  { id, result }
Failure  { id, error: { code, message, retryable, details? } }
Event    { event, seq, instanceId, revision, occurredAt, payload }
```

- 首帧执行 `system.hello`，协商 `protocol major/minor`、能力、Agent/Client/数据版本；major 不一致拒绝连接。
- 修改命令必须带 UUID `commandId`；结果在 SQLite 保留24小时，Agent 重启后重试也不会重复创建。
- Canonical JSON Schema 放在 `contracts/`：
  - Node 运行时验证输入输出；
  - C# 使用 System.Text.Json source generation；
  - 禁止动态反序列化和运行时类型扫描。

方法组：

- `system.hello/bootstrap/getActivity/prepareUpdate/shutdown`
- `accounts.list/create/update/remove/getStatus/refreshStatus/runNow`
- `browser.startLogin/getTask/openPage/closePage/listOpenPages`
- `history.query/listAccounts`
- `groups.list/create/update/remove`
- `proxies.getState/importSubscription/refreshSubscription/setRuntimeDirectory/setNodeEnabled/testNode/testAll`
- `profiles.scan/cleanCache/archiveOrphan/purgeOrphan`
- `conversations.list/upsert/remove`
- `scheduler.getState/start/stop`
- `settings.get/update`
- `operations.get/list/listActive`

长任务统一返回 Operation：

```text
Operation {
  id, kind, resourceId?,
  state: queued|running|waiting_user|succeeded|failed|timed_out|cancelled,
  stage?, message?, progress?,
  startedAt, updatedAt, finishedAt?,
  result?, error?, blocksUpdate
}
```

登录、立即运行、刷新状态、代理操作和 Profile 操作都使用 Operation；“打开网页”启动成功后转为长期 `OpenPageSession`。

Operation 的两条硬要求（第一版只定义了结构、没规定谁上报，结果除登录外全是黑盒，
进度条永久停在 0 或 1）：

- **每类长任务必须声明自己上报哪些 `stage`，可分步的必须上报 `progress` 数值。**
  一百多个节点串行测速若不报进度，就是十几分钟的黑盒。成功时 `progress` 一律置 1
  （不要沿用中途的最后一个中间值）。
- **Operation 必须持久化到 SQLite。** 只存内存意味着 Agent 重启后任务结果和错误详情
  全部消失，而“错误中心”恰恰是用户排查失败的唯一入口。重启时把上次遗留的
  `queued`/`running` 标记为 `cancelled`，不能让它们伪装成仍在运行。

事件替代原来的 2/8/10 秒轮询：

- `account.changed/removed`
- `accountStatus.changed`
- `openPage.changed`
- `operation.changed`
- `group/proxyState/profile/conversation.changed`
- `scheduler/settings.changed`
- `agent.draining/readyForUpdate`

第一版漏掉了三类高频变化，导致它们只能靠客户端主动刷（等于变相轮询），必须补齐：

- `scheduler.accountChanged`：每次持久化某账号的 `nextAt`/`lastAt`/上次结果时发出。
  否则“下次运行时间”和“刚跑完的结果”拿不到。
- `proxyNode.tested`：单个节点测完立刻发出，让界面回填延迟，不必等整批任务结束。
- `history.appended`：新增运行记录时发出。

断线、事件序号缺口或 Agent instance 改变时，Desktop 重新获取一次 `system.bootstrap` 全量快照。

`seq` 是单个 `instanceId` 生命周期内的单调序号，用于检测事件缺口；发现缺口后全量
`system.bootstrap`，不承诺持久化重放。`revision` 表示生成快照/事件时的内存状态版本；若后续
没有快照一致性消费者，应在下一个协议 major 删除。二者不得再被描述为“没有重放就没有用途”。

稳定错误码至少包括：

- `VALIDATION_FAILED`
- `NOT_FOUND`
- `RESOURCE_BUSY`
- `PROFILE_IN_USE`
- `PROXY_UNAVAILABLE`
- `ALREADY_OPEN`
- `LOGIN_FORCE_CONFLICT`
- `CHROME_NOT_FOUND`
- `AGENT_DRAINING`
- `PROTOCOL_MISMATCH`
- `INTERNAL`

### M4：Avalonia NativeAOT 管理端

- 使用 Avalonia 12、.NET 10、AOT 可验证的轻量 MVVM 实现和手工 Composition Root；不强制引入 CommunityToolkit.Mvvm。
- 启用：
  - `PublishAot=true`
  - `SelfContained=true`
  - `PublishTrimmed=true`
  - `IsAotCompatible=true`
  - `AvaloniaUseCompiledBindingsByDefault=true`
- 所有 XAML 设置 `x:DataType` 并使用编译绑定；禁止 ReflectionBinding、动态 XAML、Assembly 扫描和反射式 DI。
- 视图模型暴露 `IBrush` 而不是颜色字符串：字符串到 Brush 依赖运行时 TypeConverter，
  在裁剪/AOT 下不可靠。
- **本阶段的验收标准是“一之二、界面与交互需求”那一节，逐条对照。**
  “八个导航项显示八个不同页面”这类断言不构成验收 —— 它可测、可通过，但与好不好用无关。
- 保留完整功能但重新设计信息架构：
  - 账号列表、搜索、分组和状态筛选；
  - 登录/强制重登、打开/关闭网页、刷新状态、立即运行；
  - 历史记录及已删除账号历史；
  - 分组管理、代理导入/刷新/启停/测速；
  - 会话主题和轮换配置；
  - 调度、风控、状态巡检设置；
  - Profile 扫描、缓存清理、孤儿归档/删除；
  - 活动任务中心、错误详情、更新页和诊断日志。
- 托盘菜单提供显示窗口、调度状态、启动/停止调度、检查更新和退出全部。
- “退出全部”遇到登录窗口、打开网页或运行任务时列出阻塞项；默认等待或取消退出，不直接强杀 Chrome/Profile。
- Desktop 专属设置单独原子写入 `desktop.json`：窗口位置、关闭选择、开机启动、更新策略；不与 Agent 业务数据混写。

### M5：安装、更新与 Windows 首发

- 使用 VeloPack 整体打包 Desktop、Agent、私有 Node、原生 SQLite 模块、只读资源和各平台 mihomo。[VeloPack 支持 GitHub Releases 和增量包](https://docs.velopack.io/distributing/github-actions)
- Node Agent v1 不使用 SEA/单文件封装，优先保证 Playwright和原生模块稳定；用户仍看不到 npm 或控制台。
- 打包时设置 `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`，产物中检测到 Chromium 即让 CI 失败。
- 携带未修改、固定版本的 mihomo；Release 同时提供对应 GPLv3 文本、版本、哈希和源代码获取方式。
- 更新检查：启动后立即检查一次，此后每30分钟检查一次；网络失败静默退避，不影响后台任务。
- 更新策略：
  1. `NotifyOnly`：默认，只显示新版本，点击后才下载和安装；
  2. `DownloadAndPrompt`：后台下载，用户确认后安装；
  3. `InstallAtSafePoint`：下载后在无阻塞项时自动安装。
- 安装前调用 `system.prepareUpdate`：
  - 暂停新调度和巡检；
  - 拒绝新写操作；
  - 等待运行任务完成；
  - 打开网页和交互登录必须先关闭；
  - SQLite checkpoint、在线备份并关闭；
  - 停止 Agent 后整体替换版本，重启并完成 hello/数据库健康检查。
- 数据库升级前保留最近3份一致性备份；稳定版不承诺直接降级，回退二进制时必须恢复对应数据库备份。
- CI 先产出不可公开更新的签名候选 artifact。完成一次可追溯的 N-1 安装并更新到 N 验收后，
  才允许人工确认并上传 GitHub Draft；在全自动安装升级测试完成前，不把人工确认描述成 CI 自动门禁。
- Windows 正式包执行 Authenticode SHA-256 和可信时间戳签名；无证书只产内部测试包，不进入稳定更新通道。[VeloPack 签名说明](https://docs.velopack.io/packaging/signing)
- Windows 稳定版验收后删除生产入口中的 Express、`app.listen`、`public/` 和浏览器管理页；开发仓库仍可保留 npm 作为构建/测试工具，但最终用户不再接触。

### M6：macOS 与 Linux 收尾

- macOS 分别发布 arm64/x64 NativeAOT 包；签名所有嵌套 Mach-O、Node、mihomo 和原生模块，启用 Hardened Runtime，完成 Developer ID 签名、公证和 stapling。
- Linux x64 发布自更新 AppImage；IPC 使用 Unix Socket，开机启动使用 XDG autostart。
- Linux Release 清单和 AppImage 增加独立 Minisign 签名与 SHA-256 校验。
- 补齐 Chrome 与 mihomo 平台发现：
  - Windows 注册表和标准安装目录；
  - macOS `/Applications/Google Chrome.app`；
  - Linux `google-chrome-stable` 标准路径/PATH。
- 每个平台均执行独立 NativeAOT、真实 Chrome、安装升级和签名验收，不能用跨平台编译成功代替实机测试。

## 三、测试与发布门禁

必须通过以下层级：

- 单元测试：保留既有 Node 行为测试，并覆盖 Application Services、SQLite repository、
  调度恢复、更新 drain、单实例锁、Operation 持久化与 store 后端切换保护。
- 契约测试：旧 REST 与 IPC 对同一输入产生等价结果；JSON Schema、major/minor 兼容、错误码稳定。
- IPC 测试：分帧/粘包、8 MiB 限制、断线、重连、事件缺口、权限隔离、幂等重试。
- 迁移测试：fixture 计数一致性、损坏 JSON/JSONL、重复 ID、磁盘不足、Chrome 占用、路径穿越、跨卷、每阶段崩溃恢复。
- 浏览器测试：真实 Chrome、有头/无头、iframe/popup/worker 身份、WAF、Session 清理、账号锁、Profile 登录态。
- UI 测试（ViewModel 层，必须包含以下回归，它们对应第一版实际踩到的问题）：
  - 数据刷新／事件到达时不丢弃正在编辑的草稿；
  - 增量更新保留行实例、选中项与勾选状态；
  - 单条事件只影响对应的那一行（调度进度、窗口开关、节点测速）；
  - 出口、轮换进度、待复核标记、相对时间等字段确实呈现；
  - 新建与编辑是两个独立状态；
  - 破坏性操作二次确认。
- AOT 门禁：每个**当前声明支持的 Release RID**均执行真实 `dotnet publish`；裁剪/AOT 警告视为错误，
  发布机不安装 .NET 也能启动。它与功能验收并列，任一失败都不能发布该 RID。
- 安装更新测试分层：内部 unsigned Alpha 覆盖全新安装、阻塞和安全退出；进入稳定更新通道前
  必须完成签名候选的 N-1→N、Agent 重启、增量包和数据目录/数据库保留验证。
- 安全测试：系统用户外无法连接 IPC；订阅 Token、代理密码、Cookie和 Profile 内容不进入日志、事件或诊断包。
- 发布物检查：第三方许可证、Node/Playwright/mihomo 哈希、无 Chromium、无开发依赖、
  不包含旧网页管理面板。（签名、公证、SBOM 随签名发行阶段一起做。）

最终验收标准：

- 干净机器只下载一个 Release 安装包即可运行，无需 Git、Node、npm、.NET 或 Playwright 浏览器下载。
- 管理面板是原生桌面程序，不打开浏览器、不使用 WebView、不监听5173或其他管理 TCP 端口。
- 隐藏到托盘后自动对话、巡检、代理和调度继续执行。
- “打开网页”始终使用对应账号 Profile 的系统 Google Chrome。
- 首次迁移可验证、可重试、旧数据不被修改，现有账号/Profile/历史不丢失。
- 更新默认只提醒；任何更新都不能在登录窗口、打开网页或关键操作运行时强制安装。
- **交互不得相对旧网页面板退化**：逐条对照“一之二”验收。点击次数只是辅助指标；更高优先级的
  硬条件是不丢草稿、异步响应不覆盖新输入、批量结果与实际成功数一致、失败原因和稳定错误码可见。
- 同一数据目录不可能同时跑起两个 Agent 或两个管理端。
- macOS/Linux 与签名发行各自完成本期门禁后才声明支持，不由 Windows 版本隐含。

## 四、明确边界与默认假设

- AOT仅适用于 Avalonia Desktop；Node Agent不是 AOT。完全零 Node 作为后续可选项目，通过 `BrowserAutomation` 接口逐步替换，不纳入本次首发。
- 本机 NativeAOT 链接依赖 MSVC。若 ILCompiler 自带的 `findvcvarsall.bat` 在某台机器的
  Visual Studio 布局下解析失败（表现为把报错文本当成 link.exe 路径），先执行 `vcvarsall.bat`
  再加 `-p:IlcUseEnvironmentalTools=true` 发布。这是环境问题，不代表 AOT 兼容性回退。
- “不使用 localhost”按“不提供本地网页管理服务”理解。为保留现有 Headless 身份逻辑，Chrome内部可暂时使用随机、仅回环可见的短生命周期 CDP 端口；若连内部临时端口也禁止，另立阶段迁移到 `--remote-debugging-pipe`。
- Profile 登录态只承诺同一机器、同一 OS 用户迁移；跨用户、跨机器或跨系统可能因 DPAPI/Keychain/密钥环而要求重新登录。
- v1 使用操作系统用户 ACL保护数据库、Profile和代理秘密，不额外引入数据库加密；无遥测，诊断包只能由用户主动导出。
- 首发只开放稳定更新通道；beta、灰度比例发布和静默强制更新不在 v1。
- 第一个交付点是 **Windows 未签名内部版本，且交互不低于旧网页面板**；签名发行、
  macOS/Linux 各自单列一期。把签名和多平台压进 v1 只会让验收永久黄灯。
