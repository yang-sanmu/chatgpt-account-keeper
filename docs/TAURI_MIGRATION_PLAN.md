# 管理端从 Avalonia 迁移到 Rust + Tauri 的落地计划

本文是这次迁移的执行文档。范围只有**管理端**：`desktop/`（12151 行 C# + 2663 行
axaml）被一个 Rust + Tauri 2 的新客户端取代。

## 零、前提与既定决策

- **Agent 不动。** `src/`（19715 行 Node）、私有 Node 24、playwright-core、SQLite、
  mihomo 编排、chrome-launcher broker 全部保持现状。
- **IPC v1 契约不动。** `contracts/ipc-v1.schema.json` 与
  `contracts/ipc-v1.methods.schema.json` 是冻结的边界：50 个方法、18 个事件、
  12 个稳定错误码、协议 1.3、4 字节小端长度帧、8 MiB 上限。协议变更是独立变更，
  不与本迁移混在一起（包括"`revision` 字段能否在下个大版本移除"那个待决问题）。
- **不考虑已安装用户。** 分发从 VeloPack 换成 Tauri updater，不保留升级路径。
- **Rust 版可用之前不发布。** C# 版留在 `main` 且保持可发布，直到 M6。
- **前端栈：React + Vite + TypeScript。**

### 反转的旧决策

`README.md` 与 `docs/PLAN.md` 现在写着"管理界面是 Avalonia 原生窗口，不打开浏览器、
不使用 WebView"，`docs/REFACTOR_STATUS.md` 把 "No browser/WebView management panel"
记为 `DONE`。这条被显式反转，M1 一并改文档。

替换成三条等价且可验收的约束：

- 发布包里的管理界面**不监听任何端口**（Tauri 用自定义协议加载编进二进制的资源，
  不起 TCP 服务器）。开发模式用 Vite dev server 是正常的，不受此约束。
- 发布包的 WebView **只加载内嵌资源**，CSP 不允许任何远端源。
- 管理界面**永远不访问 chatgpt.com**。那是真实 Chrome 的活。

AGPL §13 不新增义务：自定义协议不构成"通过网络向用户提供功能"。
`scripts/verify-package.mjs` 里禁止 `public/index.html` 那条规则不用改——Tauri 把前端
编进二进制，不落散文件。

## 一、目标架构

```text
keeper-app  (Tauri 2.11 · Rust 1.98 · React + Vite + TS)
├─ src-tauri/   Rust 核心：IPC 客户端 / Agent 进程纳管 / 更新 / 单实例 / 路径 / 托盘
└─ src/         前端：8 个页面
                        │
            Named Pipe (Windows) / Unix Domain Socket (macOS, Linux)
            IPC v1 · 协议 1.3 · 4 字节小端长度帧 · 8 MiB 上限
                        │
Keeper.Agent   私有 Node 24 + playwright-core + SQLite + mihomo   ← 不动
                        │
                本机真实 Google Chrome
```

### 依赖（版本均已核实存在）

| 组件 | 版本 | 说明 |
| --- | --- | --- |
| tauri | 2.11.5 | feature `tray-icon`, `image-png`, `image-ico` |
| tauri-plugin-updater | 2.10 | 替代 VeloPack |
| tauri-plugin-autostart | 2 | 开机自启，含 AppImage 稳定路径与启动参数 |
| tauri-plugin-window-state | 2 | 窗口位置尺寸持久化，自带显示器相交校验 |
| tauri-plugin-opener | 2 | `open_path` / `open_url` / `reveal_item_in_dir` |
| tauri-plugin-dialog | 2 | 文件夹选择器 |
| tauri-plugin-process | 2 | 重启（换数据目录、非 Windows 装完更新） |
| tokio | 1.53 | feature `net`（命名管道与 UDS 都在 `net` 下） |
| windows | 0.62 | feature `Win32_System_JobObjects` + `Win32_System_Threading` |
| serde / serde_json | 1 | IPC 载荷透传 |

**不用官方 single-instance 插件**：它的锁标识固定由 app identifier 派生
（`org.{id}.SingleInstance`），无法按数据目录分域。现有 `SingleInstanceGuard.cs`
的语义是：不同数据目录可同时运行（开发模式与安装模式共存），同一目录的第二实例
只把已有窗口带到前台。这个必须保留，所以自己写。

**不用 shell 插件的 sidecar**：`externalBin` 要求目标三元组后缀命名，且用它 spawn
拿不到 `PROC_THREAD_ATTRIBUTE_JOB_LIST`。Agent 走 `bundle.resources` + 自己的
`CreateProcessW`。

## 二、Rust / 前端的边界

切错了就会得到"用 Rust 写的 C# ViewModel"。

### Rust 侧持有全部有状态、有安全语义的东西

| 责任 | 对应现有实现 | 为什么不能下沉到前端 |
| --- | --- | --- |
| IPC 客户端 + 长度帧 + 8 MiB 上限 | `AgentIpcClient.cs` | 传输层，WebView 碰不到管道 |
| `system.hello`：协议协商、`authToken`、`dataRoot` 一致性 | `AgentConnectionService.cs:284-316` | 安全边界，凭据不进 WebView |
| 事件 `seq` 缺口 / `instanceId` 变化 → 全量 bootstrap | `AgentIpcClient.cs:289-303` | 前端可能被 reload，连续性状态必须在进程侧 |
| IPC 凭据文件（256 位随机 + 移除 ACL 继承） | `IpcCredentialStore.cs` | 同上 |
| Agent 启动 + Job Object 创建时纳管（Windows） | `WindowsJobLauncher.cs` | fail-closed 保证，见 §三 |
| 单实例（按规范化数据根分域）+ 窗口激活 | `SingleInstanceGuard.cs` | 官方插件做不到分域 |
| 数据根解析（`bootstrap.json` / 环境变量 / 平台默认） | `AppPaths.cs` | 决定连哪个 Agent，进程最早期就要 |
| 数据目录校验（绝对路径、非根、非网络共享、本地固定盘、不与安装目录重叠） | `DataLocationService.cs` | 会写 GB 级 Profile，错了很贵 |
| 更新编排（预检 → 下载 → 排空 → 关 Agent → 安装） | `UpdateService.cs` | 见 §四 |
| 迁移进度 JSONL 读取（容忍不完整尾行、共享 delete） | `AgentConnectionService.cs:407-468` | 有真实 bug 史（Alpha 3） |
| 托盘（跟随真实调度状态） | `TrayIconController.cs` | 原生对象 |
| `desktop.json` 读写（原子重命名） | `DesktopSettingsStore.cs` | |

### Rust 侧不做 DTO 建模

**本次迁移最大的一笔净减。** `Models/AgentData.cs`（1315 行、61 个 record）加
`Serialization/AppJsonContext.cs`（79 行注册）**整体消失**。

它们存在的唯一原因是 NativeAOT 禁反射序列化，每个字段要在三处同时出现：record 定义、
`[JsonSerializable]` 注册、axaml 绑定。Rust 侧用 `serde_json::Value` 透传，类型约束
搬到 TypeScript interface——结构类型、零运行时成本、改一个字段只改一处。

### 桥接分两组，不是一个全量白名单

前端只有一个通用桥接：

```rust
#[tauri::command]
async fn agent_call(
    state: State<'_, AppState>,
    method: String,
    params: serde_json::Value,
    command_id: Option<String>,
) -> Result<serde_json::Value, ApiError>
```

方法名分两组，`agent_call` 只接受第二组：

- **`INTERNAL_METHODS`（5 项）**：`system.hello`、`system.bootstrap`、
  `system.getActivity`、`system.prepareUpdate`、`system.shutdown`。只由 Rust 调用。
  前端能调它们等于能绕过连接协商、更新编排和退出流程——与"Rust 持有生命周期语义"
  直接冲突。bootstrap 快照由 Rust 在连接成功和检测到 seq 缺口时主动取，再推给前端。
- **`UI_METHODS`（45 项）**：其余业务方法，走 `agent_call`。

一个测试断言：两组无交集，并集等于 `contracts/ipc-v1.schema.json` 的
`$defs.method.enum`（50 项）。不为每个方法造独立 command。

契约漂移要在测试期炸掉，而不是运行期被 Agent 的出站契约校验判成 `INTERNAL` 然后销毁
socket——`AgentProtocol.cs` 里关于 minor 3 的注释记的就是这个坑。

`ApiError` 保留 12 个稳定错误码与 `retryable`，前端据此显示可复制的
`[CHROME_NOT_FOUND] ...`。

### 前端负责

8 个页面，以及三条**行为**（不是三个类的 API）：

1. **刷新不破坏正在进行的编辑。** 用稳定 `key` + 按账号 ID 保存草稿的 reducer 表达；
   不要求"保持同一对象引用"——那是 Avalonia `ObservableCollection` + `SelectedItem`
   耦合的产物，React 里不存在。
2. **提交期间继续编辑不丢新值。** 请求返回时若当前值已不等于提交值，只更新服务端
   基线，保留用户的新草稿。
3. **增量事件只更新受影响的行**，筛选、选中、滚动不被刷新破坏。12 个事件能增量应用，
   其余 6 个落到全量 `system.bootstrap`；哪个走哪条照 `ShellViewModel.cs:809-928`。

这三条的由来见 `docs/REFACTOR_STATUS.md` 的 Alpha 5 段落：状态巡检默认 15 分钟一次，
近三十个账号并发推事件，用户改备注时撞上是常态。

前端还负责：toast（三类，失败停留更久并显示错误码）、确认对话框（文案必须说明具体
后果与影响范围）、空状态、Enter 提交。

## 三、Windows Job Object 纳管（最危险的一块）

`WindowsJobLauncher.cs`（419 行）逐条移植，不简化。顺序：

1. `CreateJobObject`
2. **先**用 `SetInformationJobObject` 武装 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`
   （必须在任何进程加入之前，否则存在成员已存在但限制未生效的窗口）
3. `InitializeProcThreadAttributeList` + `UpdateProcThreadAttribute` 设
   `PROC_THREAD_ATTRIBUTE_JOB_LIST`（它存的是指针，存储必须活过 `CreateProcessW`）
4. `CreateProcessW` 带 `EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT`
5. `IsProcessInJob` **验证**，不信任标志位
6. 任何一步失败 → `TerminateProcess` 并拒绝返回（fail-closed）

**为什么不能用 `Process.Start` + `AssignProcessToJobObject` 的等价写法**
（`AgentProcessLauncher.cs:116-123` 已记录）：assign 不追溯，而 Agent 启动后第一件事
就是拉起 chrome-launcher broker。实测 broker 会落在 job 外面
（agentInJob=true, brokerInJob=false）并在外层 job 终止后存活——它持有每次运行的
per-run Job 句柄，于是 `KILL_ON_JOB_CLOSE` 永不触发，Desktop 崩溃时 Chrome 全泄漏。

一并移植：

- `BuildCommandLine` / `AppendArgument`：`CommandLineToArgvW` 引号转义规则。数据根和
  可执行文件路径经常带空格。
- `BuildEnvironmentBlock`：`NAME=VALUE\0...\0\0` Unicode 环境块，从父环境继承再叠
  8 个 `GPT_ACCOUNT_KEEPER_*` 变量 + `GPTACCOUNTKEEPER_AGENT_ENDPOINT`。
- 世代管理（`_generationGate` / `generationId`）：迟到的 Exited 回调不能与下一次启动
  竞争；每个世代的回调**无条件**关闭自己的 job 句柄（跳过会泄漏句柄，导致该世代的
  遗留进程永不被回收）。

非 Windows 保持现状语义：用进程组，不声称与 Windows Job 同等保证。

## 四、更新与分发（VeloPack → Tauri updater）

### 已核实的事实

- **updater 2.10 支持 NSIS、MSI、macOS `.app`、AppImage、deb、rpm。** 目标键查找顺序
  是 `{os}-{arch}-{installer}` 再回退 `{os}-{arch}`（`updater.rs:618-626`）。
- **deb / rpm 的 `install()` 走 `pkexec`，失败则退到 zenity / kdialog 图形化 sudo**
  （`updater.rs:1120-1200`）。
- **`install()` 只在 Windows 内部退出进程**（`updater.rs:876` 的
  `std::process::exit(0)`），NSIS 装完按 `restart_after_install`（默认 true）重启。
  **macOS 与 Linux 的 `install()` 返回后不退出，必须我们自己重启。**
- **签名**：`tauri signer generate` 生成密钥对；私钥经环境变量
  `TAURI_SIGNING_PRIVATE_KEY` 与 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` 在构建时提供，
  不能放 `.env`；
  公钥**内联**进 `tauri.conf.json` 的 `plugins.updater.pubkey`，不能是路径。
  丢失私钥 = 已安装的客户端永久收不到更新。
- **`bundle.createUpdaterArtifacts`**：新客户端用 `true`，Linux 直接复用 `.AppImage`
  并生成 `.AppImage.sig`；只有兼容 Tauri v1 的 `"v1Compatible"` 才额外生成
  `.AppImage.tar.gz`。本项目没有 Tauri v1 用户，不使用兼容模式。
- **NSIS `installMode` 默认 `currentUser`**，装到 `%LOCALAPPDATA%`，不需要管理员权限，
  与现在的每用户模型一致。
- **`Update`** 有分离的 `download()` 与 `install()`，不只有 `download_and_install()`。

### 平台与自更新范围

| 平台 | 分发格式 | 自更新 |
| --- | --- | --- |
| Windows x64 | NSIS（`currentUser`） | 是 |
| macOS arm64 / x64 | `.app` + `.dmg`，签名 + 公证 + stapling | 是（`.tar.gz`，需显式重启） |
| Linux x64 | AppImage（自更新）、deb + rpm（附，不自更新） | 仅 AppImage |

**`latest.json` 只放四个平台键**：`windows-x86_64`、`darwin-aarch64`、
`darwin-x86_64`、`linux-x86_64-appimage`。**绝不放通用 `linux-x86_64` 键**——deb/rpm
客户端会回退到它，拿到 AppImage 的包。

**deb/rpm 客户端禁用更新检查**（用 `bundle_type()` 判断，非 AppImage 就不启动检查
循环，界面显示"由发行版包管理器升级"）。理由不只是清单键有歧义：一个后台更新器给
用户弹 root 密码框，比让他跑 `apt upgrade` 更糟。这是产品取舍，不是能力缺失。

`signature` 字段必须是 `.sig` 文件的**内容**，不是路径或 URL。

### 与 VeloPack 的实际差异

| 方面 | VeloPack（现在） | Tauri updater |
| --- | --- | --- |
| 增量更新 | 有 delta | **无，每次完整下载** |
| Linux 自更新 | AppImage（从未真机验收） | AppImage |
| 构建期依赖 | `vpk` 需要 .NET 8 SDK | 无 |
| 通道 | 四个 per-RID 通道 | 一个 `latest.json` |
| 签名密钥 | Authenticode / Apple / Minisign | **新增**一套 Tauri 更新签名密钥 |

包体主要是私有 Node + Agent + mihomo，"无 delta"是真实代价：每次更新完整下载。可接受
——更新频率低，delta 从未是验收项。

**Authenticode / Apple Developer ID / 公证 / stapling / Minisign 门禁全部保持现状。**
Tauri 更新签名与 OS 代码签名用途不同，两者都要。

### 安装流程：下载放在预检之后

```
check() → Some(update)                      [Rust：启动首检 + 每 30 分钟]
  ↓ 用户点"立即更新"，或安全空闲监控命中
system.prepareUpdate(commit=false)          预检阻塞项（Chrome 窗口 / 运行任务）  [可取消]
  ↓
update.download(on_chunk, on_done) → bytes  下载                                  [可取消]
  ↓ ────────────────── 以下不可取消 ──────────────────
system.prepareUpdate(commit=true)           排空 + SQLite 检查点
system.shutdown                             等 Agent 完整释放句柄
update.install(bytes)
  Windows : 内部 exit(0)，NSIS 装完自动重启
  macOS/Linux : 返回后我们自己 relaunch
```

**下载在预检之后、排空之前**，理由有两条：有阻塞项时不浪费一次完整下载；下载结果
（完整安装包的字节）只在一次安装流程内存活，不会因为等待安全空闲点而常驻内存几小时。

因此 **`UpdatePolicy` 从三档并成两档**：

- `NotifyOnly`（默认）：发现新版本弹窗，用户确认后走上面这条流程。
- `InstallAtSafePoint`：后台等到没有登录窗口、打开的网页和运行中的任务，命中后自动
  走同一条流程。

删掉 `DownloadAndPrompt`。它的唯一价值是"点安装时已经下好了"，而要保住这个就必须
在等待用户应答期间持有完整包字节——用户可能不在机器旁，那就是几小时的常驻内存；
加超时+重下则是为一条薄收益造新机制。去掉它只是多一条进度条。这条决策可逆：要加回
第三档就得接受持有字节。

`UpdateGate` 不整类搬。它的复杂度大半来自 VeloPack 的两个具体缺陷（一次检查会把
"已下载"降级、进度回调在下载返回后才投递），下载移入安装流程后这些分支不可达。保留
三条行为及其测试：忽略只压制那一个版本（更高版本仍提示）、手动检查始终弹窗、
自动检查不对同一版本重复提示。

不需要 `on_before_exit`：Agent 的排空与关闭发生在 `install()` 之前。

### 数据目录与安装目录不重叠

NSIS `currentUser` 装到 `%LOCALAPPDATA%\<productName>`，数据在
`%LOCALAPPDATA%\GptAccountKeeper\data`。两者不同，但 `DataLocationService.Validate`
那条"数据目录不能与安装/程序目录重叠"的校验必须保留，并**加一个测试用 NSIS 的实际
默认安装路径断言它通过**。这类问题只在装好之后可见。

## 五、Linux 打包

Linux 上 Tauri 用系统 WebKitGTK 4.1，不能像 NativeAOT 那样自包含。核实过的实际行为：

- **deb / rpm 自动声明依赖** `libwebkit2gtk-4.1-0`、`libgtk-3-0`、
  `libappindicator3-1`（用托盘时）。apt/dnf 装包时自动拉，用户不需要手动装任何东西。
  额外依赖可用 `bundle.linux.deb.depends` / `bundle.linux.rpm.depends` 追加。
- **AppImage 不裸依赖宿主**：`tauri-bundler` 会把 `WebKitNetworkProcess`、
  `WebKitWebProcess`、`injected-bundle/libwebkit2gtkinjectedbundle.so` 从构建机复制
  进 AppDir（`crates/tauri-bundler/src/bundle/linux/appimage/linuxdeploy.rs:134-148`），
  `linuxdeploy-plugin-gtk` 再带上整个 GTK3 栈。
- **真正的约束是 glibc 基线**：必须在 `ubuntu-22.04` 上构建，否则新构建机的产出在老
  系统起不来。
- linuxdeploy 不支持交叉编译 ARM AppImage。本计划不做 ARM。

## 六、目录结构

```text
app/                              新增，与 desktop/ 并存直到 M6
├─ package.json                   React + Vite + TS
├─ vite.config.ts
├─ index.html
├─ src/
│  ├─ main.tsx
│  ├─ ipc/
│  │  ├─ client.ts                agent_call / 事件订阅的薄封装
│  │  ├─ methods.ts               UI_METHODS 常量（45 项）
│  │  └─ types.ts                 手写 TS interface，取代 AgentData.cs
│  ├─ state/
│  │  ├─ accountsReducer.ts       行归并 + 按 ID 保存草稿
│  │  ├─ eventReducer.ts          ← ShellViewModel.ApplyEventIncrementally
│  │  └─ session.ts               忙碌计数 / 统一失败提示
│  ├─ pages/
│  │  ├─ Overview/ Accounts/ Operations/ Proxies/
│  │  └─ Conversations/ Profiles/ History/ Settings/
│  └─ ui/                         toast、确认框、空状态、登录进度窗
└─ src-tauri/
   ├─ Cargo.toml
   ├─ tauri.conf.json
   ├─ build.rs
   ├─ capabilities/default.json   只授权实际用到的权限
   ├─ icons/                      复用现有 app-icon.*
   └─ src/
      ├─ main.rs                  单实例 → 数据根 → 插件 → 托盘 → 窗口
      ├─ paths.rs                 ← AppPaths.cs + DataLocationService.cs
      ├─ instance.rs              ← SingleInstanceGuard.cs
      ├─ settings.rs              ← DesktopSettingsStore.cs + DesktopSettings.cs
      ├─ tray.rs                  ← TrayIconController.cs
      ├─ update.rs                更新编排（见 §四）
      ├─ commands.rs              agent_call 等薄口径
      ├─ ipc/
      │  ├─ frame.rs              长度帧编解码 + 8 MiB 上限
      │  ├─ transport.rs          NamedPipeClient / UnixStream
      │  ├─ client.rs             ← AgentIpcClient.cs
      │  ├─ endpoint.rs           ← AgentEndpoint.cs（含 sun_path 长度上限）
      │  ├─ credential.rs         ← IpcCredentialStore.cs
      │  ├─ connection.rs         ← AgentConnectionService.cs
      │  └─ contract.rs           INTERNAL_METHODS / UI_METHODS / 事件 / 错误码
      └─ agent/
         ├─ launcher.rs           ← AgentProcessLauncher.cs
         ├─ job_windows.rs        ← WindowsJobLauncher.cs（见 §三）
         ├─ migration.rs          迁移进度 JSONL + migrationProbe 调用
         └─ resources.rs          定位打包内的 agent/ 与私有 Node
```

Agent 与私有 Node 通过 `bundle.resources` 打包，运行时用
`app.path().resource_dir()` 定位。

**版本号另起一条线**：Rust 版从 `0.2.0` 开始，C# 版留在 `0.1.x`。updater 比较版本号，
两条线混在一起会出奇怪的事。

## 七、分阶段实施

每个阶段结束时 `main` 必须仍然可发布 C# 版。

### M0 · 三个 spike（可并行，不写产品代码）

**S0-1 · Tauri updater 端到端**
用**一次性签名密钥**（生产密钥到 M5 首次真实发布前再生成并离线备份）。hello-world
应用打通：`tauri build` 产出 NSIS + `.sig` → 生成只含三个平台键的 `latest.json` →
上传 pre-release → 客户端 `check()` → 预检桩 → `download()` → `install()`。
验收：0.2.0 装好 → 0.2.1 上线 → 自动发现、下载、安装、重启，
`%LOCALAPPDATA%\GptAccountKeeper\data` 一个字节没动，快捷方式指向新 exe。
一并确认：`installer_args` 是否需要显式静默标志、`restart_after_install` 的实际行为。

**S0-2 · Windows Job Object 移植**
按 §三 用 `windows` 0.62 移植，配一个假 Agent（spawn 子进程再 spawn 孙进程）。
验收：外部强杀 Tauri 进程 → 子孙进程全部消失，零孤儿。再用真 Agent 复验：强杀 →
Agent + chrome-launcher broker + Chrome 全部死透。**这条不通过，迁移在 Windows 上
就是不安全的。**

**S0-3 · tokio IPC 打通真 Agent**
`ClientOptions` 连命名管道 / `UnixStream` 连 UDS，跑
`system.hello` → `system.bootstrap` → `accounts.list`。
顺手确认："管道尚未创建"在 Rust 侧是普通 `Err(ERROR_FILE_NOT_FOUND)`，不需要 C# 那套
`WaitNamedPipe(name, 0)` 规避首发异常刷屏的处理（`AgentIpcClient.cs:40-55`）——若确实
不需要，这段不移植。

**M0 门禁**：三个 spike 各自验收通过，结论写回本文档。

### M1 · Rust 核心 + 空壳窗口

- `app/` 骨架；`cargo fmt` + `clippy -D warnings` + `cargo test` 全绿。
- `paths.rs`、`instance.rs`、`settings.rs`、`tray.rs`；autostart 与 window-state 用
  官方插件接入。
- 完整 IPC 客户端：连接、hello 协商、事件连续性检测、断线重连（1/2/5/10/20/30 秒退避）。
- Agent 启动与纳管（S0-2 成果落地）。
- 托盘跟随真实调度状态（`TrayIcon::set_tooltip` / `MenuItem::set_enabled` 可用；
  注意 Linux 托盘左键事件不触发，激活只能靠菜单项）。
- 窗口能显示，Agent 事件转成 Tauri event 发给前端；前端只有一个调试页。
- **文档反转**：`README.md`、`docs/PLAN.md` 固定决策段、
  `docs/REFACTOR_STATUS.md` 对应行；`THIRD_PARTY_NOTICES.md` 加 Tauri / wry /
  WebView2 / WebKitGTK / React；`SOURCE.md` 加 Rust 构建说明。

**M1 静态门禁（三条，都要能红）**

1. `INTERNAL_METHODS`（5）与 `UI_METHODS`（45）无交集、并集等于契约
   `$defs.method.enum`（50）；事件名等于 `$defs.eventName.enum`（18）；错误码等于
   `$defs.errorCode.enum`（12）。
2. **release** 构建用 `frontendDist`，产物不含任何远端加载的资源，CSP 无远端源。
   （`devUrl` 与 `frontendDist` 并存是官方 Vite 配置的正常形态，不禁止。）
3. NSIS 默认安装路径通过 `paths.rs` 的"数据目录不与安装目录重叠"校验。

### M2 · 只读页面（含只读账号表）

总览、任务、历史、Profile，**加一个只读账号表**——风险表担心的是账号页的数据密度，
只验证四个轻页面等于没验证。编辑与批量操作留在 M3。

- 行归并与 `eventReducer` 落地并带 vitest 单元测试。
- 只读账号表显示：状态徽章（含颜色点与"· 待复核"）、相对时间（悬停显示完整时间戳）、
  出口标签（跟随系统 / 节点名 / 节点已失效）、轮换进度、下次运行、上次运行结果。
- 历史渲染结构化问答气泡并支持复制；**取不到字段时不许把原始 JSON 铺给用户**。
- Profile 页首次进入自动扫描；任务页可按状态筛选，稳定错误码可复制。
- 空状态：说明为什么空、下一步做什么。

**M2 止损判据（可判定）**：用当前真实数据（`config/accounts.json` 28 个账号、
`profiles/` 29 个目录）全量渲染账号表，滚动无可见卡顿，一条
`accountStatus.changed` 从收到到 DOM 更新 < 100 ms。不达标就在 M2 止损，不进 M3。

### M3 · 写路径页面

账号、分组与代理、会话、设置。

- 账号页：内联编辑（备注、启用、分组、轮换方式、最少/最多窗口数）、多选批量
  （启用/停用/刷新状态/立即运行/删除）。
- 批量操作串行执行（浏览器类操作一次一个）；增量状态/开页事件要重新应用当前筛选。
- 代理节点行显示 `server:port`、分组本地端口、颜色分级延迟，测速结果回填到行上。
- 分组与会话集的"新建"与"编辑"是两个明确状态。
- 会话集重命名非原子（先 upsert 后 remove），执行前告知失败后果。
- 创建账号后**直接拉起登录窗口**。
- 下拉/筛选器的模型值是枚举或稳定标识，中文只做显示值。

**M3 门禁**：§二 那三条行为各有测试，且按红-绿写——先用刻意朴素的实现
（整表替换、无脏值判断）确认三条测试变红，再换真实现变绿。不曾变红的测试是空转测试。
这不是"改坏已有代码"的仪式，是新代码的正常写法。

### M4 · 生命周期与更新

- 关闭窗口选择（隐藏托盘 / 退出全部 / 每次询问 + 记住选择）。
- 退出全部：先尝试接回已有 Agent，**绝不为了退出而启动新进程**。
- §四 的安装流程，含安全空闲监控。
- 登录前台进度窗，消费 `waiting_user` 阶段。
- 旧项目导入：只读预检（`migrationProbe.js`）→ 预览确认 → 迁移进度 → 完成；含
  "已建库则需换空数据目录 + 重启后续做"那条路径。

**M4 门禁**：三条更新提示行为有测试；迁移进度解析器对不完整尾行有测试；
"退出全部不会启动新 Agent"有测试。

### M4.5 · 跨层正确性收口（M5 前新增）

2026-08-25 对最后七次 Tauri 提交的复审证明，仅有方法名与信封的契约门禁不足以发现
payload 字段漂移，也不能区分“操作已入队”和“操作已完成”。因此在 M5 前增加以下门禁：

- [x] 根 Node 测试只收集 `test/**/*.test.js`，不再误收集 Vitest 的 TS/TSX；重型 Agent/
  Chrome 集成测试按最多 4 个文件并发，避免高核心数主机耗尽启动资源。CI 新增独立的
  Tauri 前端 build/test 与 Rust fmt/clippy/test job。
- [x] `group.changed`、`conversation.changed`、`scheduler.accountChanged` 按 Agent 的真实
  delta payload 增量更新；`operation.changed` 同步维护 active operations。Agent 与 React
  两侧都有真实 payload 回归测试。
- [x] 前端统一通过事件驱动的 `runOperation` 等待 terminal state；Profile 清理/归档/删除、
  代理订阅导入与节点启停不再把 queued response 报成成功。无轮询、无任意前端超时。
- [x] `.gitignore` 明确放行 `app/src/pages/Profiles/`，避免 Windows 大小写不敏感规则把
  React 页面当成敏感的 `profiles/` 登录态目录忽略。
- [x] 把 53 个 `$defs` 写实并生成 `app/src/ipc/generated.ts`。本轮只封住已实证的事件和
  operation 语义，不声称已经完成全量 schema 代码生成。

### M5 · 分发

- [x] `tauri.conf.json`：`bundle.targets`、`createUpdaterArtifacts`、NSIS
  `installMode: currentUser`、Linux deb/rpm depends；发布时通过
  `tauri.release.conf.json` 映射生成的 resources，普通 cargo 门禁不依赖本地二进制。
- [x] 用 CLI 生成生产 updater 签名密钥对，把公钥替换进
  `plugins.updater.pubkey`。工作流在公钥为空或仍是占位符时 fail-closed。
- [x] 将 updater 私钥/密码存入仓库 Secrets；工作流在任一 Secret 缺失时 fail-closed。
  私钥与密码的长期分离备份仍由发布者离线维护。
- [x] 改造 `scripts/stage-release.mjs`：输出只含 Tauri `$RESOURCE` 下的 agent/licenses，
  不再复制旧 Desktop publish 目录。
- [x] 改造 `scripts/verify-package.mjs`：路径规则跟着新布局改；禁止 chromium /
  ms-playwright / 旧管理页那几条保留。
- [x] 新增 `scripts/write-latest-json.mjs`：从各平台 `.sig` 的**内容**生成 `latest.json`，
  键只有 `windows-x86_64` / `darwin-aarch64` / `darwin-x86_64` /
  `linux-x86_64-appimage`。加一个测试断言产物里没有通用 `linux-x86_64` 键。
- [x] CI：从"4 个 NativeAOT publish 门禁"变成"1 个 cargo 门禁 + 4 个 `tauri build`"。
  Linux 固定 `ubuntu-22.04`。
- [x] 保留：Node 测试矩阵、私有 Node/mihomo 固定版本 + SHA-256 校验、
  `smoke-staged-agent.mjs`、SBOM、licenses 复制、Authenticode / Apple 公证 / Minisign。
- **chrome-launcher 仍需 .NET SDK**（`tools/chrome-launcher`，1193 行 C# AOT）。它由
  Agent 启动而非管理端，本次不动；"移植到 Rust"记为后续独立任务。

**M5 门禁**：四平台 draft 产出；N → N+1 就地更新真机验收 **Windows、macOS、
AppImage 各一次**（macOS 与 AppImage 要确认 `install()` 后的显式重启真的发生）；
deb 与 rpm 各装一次并确认**没有**发起更新检查；AppImage 在干净 Ubuntu 22.04 与一台
较新发行版上各起一次。

2026-08-31 生产 updater 密钥、公钥和 Actions Secrets 已接入。发布者先后明确授权 `v0.2.0`
首发与 `v0.2.1` 修复版作为各自一次性的 unsigned 发布：跳过平台代码签名、候选下载及
N → N+1 真机门禁，但不跳过 updater `.sig`、四平台原生构建、SBOM 与校验和。这些例外
不把 M5 标为完成；平台签名和真机安装/更新验收仍是后续外部门禁。

2026-09-03 发布者针对 `v0.2.2` 再次明确授权同范围的一次性 unsigned 发布，并要求不下载
发布包到本地验证；当时的专用开关只允许 `v0.2.2`，不能用于其他版本。

2026-09-03 发布者针对 `v0.2.3` 再次明确授权同范围的一次性 unsigned 发布，并要求不下载
发布包到本地验证；当前专用开关只允许 `v0.2.3`，不能用于其他版本。

### M6 · 删除 `desktop/`

**只有在以下全部成立之后：**

1. 对着 `docs/PLAN.md` 一之二逐条打分的平价台账全绿。
2. 真实账号在打包版上日常使用过一段时间（不是"页面能渲染"）。
3. M5 的真机更新验收通过。

然后删 `desktop/`、`desktop/tests/`、`GptAccountKeeper.Desktop.sln`；CI 移除
`windows-native-aot` 与 `desktop-native-aot`；更新 `docs/REFACTOR_STATUS.md`。

## 八、工作量与预期

| 层 | 现在 | 迁移后 | 变化 |
| --- | --- | --- | --- |
| DTO + 序列化注册 | 1394 行 | ~250 行 TS interface | **净减** |
| 基础设施 | ~3200 行 C# | ~2500–3000 行 Rust | 持平 |
| 表现层 | 7100 行 ViewModel + 2663 行 axaml | ~6000–7000 行 TSX | 持平 |
| 测试 | 106 个 xunit | cargo test + vitest | 持平 |

**这次迁移不省代码。** 省的是两样：

1. "加一个字段要同时改 DTO record、source-gen 注册、axaml 绑定、ViewModel"这条链路。
2. NativeAOT 的持续约束——禁反射、禁动态 XAML、禁反射式 DI，且它不能交叉编译，每个
   RID 必须在对应架构的 runner 上跑一次 publish 门禁。

## 九、明确不做的事

- **不把 Agent 改成 Rust。** 19715 行，带 playwright-core 与 mihomo 编排，Alpha 6 刚
  修完四个安装布局 bug。一次迁移只换一层。
- **不改 IPC v1 协议。**
- **不在 M1 之前动 `desktop/`。**
- **不做 ARM Linux**（linuxdeploy 不支持交叉编译 ARM AppImage）。
- **不做移动端。** 这个产品要驱动本机真实 Chrome。
- **deb/rpm 不做自更新**，见 §四。

## 九之二、迁移收口与后续独立任务

以下分为 M4.5 尚未完成的迁移门禁，以及迁移完成后再做的独立任务。

### 从契约生成 TypeScript 类型（M4.5 剩余门禁，有四次实证）

2026-08-25 复审后，这项不再作为“迁移完成后再做”的独立优化：事件 delta 与 operation
终态已经先行收口，但完整 `$defs` 与生成类型仍须在 M5 分发前完成。

**问题**：前端的 TS interface 是手写的，而 `contracts/ipc-v1.methods.schema.json` 只约束
方法名和信封，payload 形状大多是 `{"type":"object"}` 或 `{"type":"array"}` 这类松约束
（例如 `proxyStateResult.nodes` 只声明是数组）。猜错字段名不会有任何东西报错，且症状
总是「界面上一片空白／某个值永远不出现」，而不是一个能指到原因的错误。

**已发生四次**，都是同一形状：

| 位置 | 猜的字段 | 真实字段 | 症状 |
| --- | --- | --- | --- |
| `inspect_legacy` | `accountCount` / `profileCount` / `totalSizeBytes` / `valid` | `counts.{accounts,profiles,…}` / `totalProfileBytes` / `ok` | 28 账号的项目预览成全 0 |
| `Operation.state` | 多了 `interrupted` | 契约只有 7 个值 | 三元链落到「排队中」，终止任务像还在跑 |
| `proxyNode.tested` | `latencyMs` / `error` | `delay` / `message` / `ok` | 测速延迟从不出现在节点行 |
| `profiles.scan` | `sizeBytes` / `isOrphan` / `linkedAccountId`，且当成同步返回值 | `bytes` / `linked` / `accountLabels`，结果在 `operation.changed` | 47 个 Profile 显示「无 Profile」 |

**已完成（2026-08-25）**：53 个 `$defs` 已按 `publicAccount`、`getNodes`、`scan` 等
Agent 投影写实；`src/agent/methodContracts.js` 成为运行时校验器与生成器共用的唯一方法
映射。`npm run ipc:generate` 通过固定版本的 `json-schema-to-typescript` 生成
`app/src/ipc/generated.ts`，`npm run ipc:check` 及 CI 会阻止提交结果漂移。本轮精确封住
`operation.changed`、`proxyNode.tested`、`profile.changed`、`group.changed`、
`conversation.changed`、`scheduler.accountChanged`；其余事件 payload 仍保持 `unknown`，
避免在没有实证前扩大全量事件模型。

生成结果同时导出 `OPERATION_METHODS` / `OperationMethod`：返回 `operationResult` 的方法
与普通同步结果在编译期分开，`runOperation` 只能接收前者，`profiles.scan` 那种把 queued
描述符当扫描数据的错误会直接成为编译错误。

### chrome-launcher 移植到 Rust

`tools/chrome-launcher`（1193 行 C# AOT）由 Agent 启动而非管理端，本迁移不动它。但只要
它还在，构建就仍然需要 .NET SDK——删掉 `desktop/` 之后这会是唯一的 .NET 依赖。

## 十、已知风险

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| Job Object 移植不完整 | Desktop 崩溃时 Chrome 泄漏，用户看到一堆孤儿浏览器 | S0-2 独立 spike + 真 Agent 复验 + fail-closed |
| 更新签名生产私钥丢失 | 已安装客户端永久收不到更新 | M5 生成后立即离线备份 |
| WebView 数据密度不如原生 | 账号页卡顿 | M2 含只读账号表，有可判定的止损判据 |
| macOS / AppImage 装完不重启 | 用户以为更新失败 | `install()` 后显式 relaunch；M5 真机各验一次 |
| `latest.json` 落了通用 Linux 键 | deb/rpm 客户端拿到 AppImage | 生成脚本 + 断言无通用键的测试 |
| Linux glibc 基线漂移 | 包在老系统起不来 | CI 固定 `ubuntu-22.04` |
| 三条行为语义走形 | 回到 Alpha 5 之前"改备注被冲掉"的状态 | M3 的红-绿门禁 |
| 双根混用（历史上踩过三次） | CLI/开发下正常，装好后必坏 | `paths.rs` 区分数据根与资源根，并在分离布局下测试 |
