# ChatGPT Account Keeper

ChatGPT 多账号的桌面管理与后台自动对话工具。每个账号使用独立的 Google Chrome Profile；管理端不监听任何端口，也不加载任何远端内容。

> Windows、Linux x64、macOS Apple Silicon/Intel 均有独立发布门禁。仓库仍保留旧 Express 管理页作为过渡兼容入口；正式安装包只包含管理端、私有 Node Agent 和本地 IPC，不会包含旧管理页。

## 架构

管理端已迁移到 Rust + Tauri（见 [迁移计划](docs/TAURI_MIGRATION_PLAN.md)）。`app/` 是当前
0.2.x 客户端，`desktop/` 仅保留旧 0.1.x Avalonia 历史代码，已停止维护和验收。首个 Tauri `v0.2.0` 不提供从
Avalonia 应用内升级的桥接包，旧版用户需退出 Avalonia 后手动安装；两条版本线继续使用
相同的数据目录和 IPC v1 契约。

```text
管理端
desktop/  Avalonia 12 · .NET 10 NativeAOT · VeloPack   ← 历史 0.1.x，不再维护
app/      Tauri 2 · Rust · React                       ← 当前版 0.2.x
                    │
        Named Pipe / Unix Domain Socket
        IPC v1 · 协议 1.7 · 79 方法 / 20 事件
                    │
Keeper.Agent
私有 Node 24 · playwright-core · SQLite · 调度 · mihomo
                    │
           本机 Google Chrome
```

- 管理端：托盘常驻，独立功能页。Tauri 把前端资源编进二进制，
  经自定义协议加载——**不监听任何端口，CSP 不允许任何远端源，且永不访问 chatgpt.com**。
  访问 ChatGPT 是真实 Chrome 的职责，管理界面不参与。
- 后台端：独立的每用户 Agent；管理窗口隐藏到托盘后，自动对话、巡检和调度继续运行。
- 本地通信：Windows Named Pipe；macOS/Linux Unix Domain Socket。帧为 4 字节小端长度加 UTF-8 JSON，最大 8 MiB。
- 持久化：SQLite（WAL、外键、幂等命令回执）和平台用户数据目录；安装与更新不触碰 Profile/数据库。
- 浏览器：只使用本机真实 Google Chrome。未安装时返回稳定错误 `CHROME_NOT_FOUND`，不下载或回退 Chromium。
- 更新：当前客户端用 Tauri updater，从公开 GitHub Releases
  检查，默认只提醒，安装前调用 Agent drain 和 SQLite checkpoint。Linux 上只有 AppImage
  参与应用内更新，deb/rpm 由发行版包管理器升级（它们的安装路径会要求 root 授权，不适合
  由后台更新器发起）。

## 当前可用功能

- 账号新增、启用/停用、登录、明确强制重登、状态刷新和立即运行；状态刷新同时检查并区分
  Plus 免费试用与 1/2/3 个月半价优惠资格，账号页可按优惠结果筛选。
- 用对应账号 Profile 打开/关闭真实 Google Chrome。
- 在“打开网页”窗口完成登录后，会自动同步已验证的邮箱、昵称与会话状态；邮箱尚未识别时显示“邮箱未识别”，可单独筛选，不再当作未登录。普通“登录”保留现有会话，强制重登需确认清除已保存的登录态。
- 新增账号默认在登录成功后保留 Chrome 窗口，可勾选“登录成功后自动关闭浏览器”。首次登录成功会复用当前页面检查一次优惠资格，不受自动巡检优惠开关影响；勾选自动关闭时会等检查结束后再关闭。
- 自动调度启停、持久化与重启恢复；错过任务每账号最多补跑一次并增加抖动。
- 独立 Profile、账号锁、WAF/unknown 状态保护、Headless Chrome 身份覆盖。
- 侧栏对应独立页面：总览、账号、临时窗口、iCloud 隐私邮箱、任务、分组与代理、网络配置、会话、Profile、历史和设置。
- 账号搜索/筛选/编辑/删除，分组与代理管理，会话集编辑，Profile 扫描/清理/归档/永久删除，已删除账号历史和 Agent 设置均已接入 IPC v1。
- 旧 JSON/JSONL/Profile 到 SQLite 的原生预览、空间/运行锁检查、进度显示和校验式复制迁移；失败不修改旧数据。
- Agent 自行写入用户状态目录的脱敏诊断日志，不依赖 Desktop 输出管道；桌面断线会自动重连并在事件缺口后重新获取完整快照。

优惠检查使用当前账号 `/api/auth/session` 返回的 accessToken，在页面内携带
`Authorization: Bearer …` 请求 `/backend-api/promo_campaign/check_coupon`，并设置
`is_coupon_from_query_param=true`。半价券标识分别为 `plus-1-month-50-pct-off`、
`plus-2-months-50-pct-off`、`plus-3-months-50-pct-off`（1 个月用单数 `month`）。
任一期限符合资格都归入现有“半价优惠”标签和筛选。直接在地址栏打开接口不等同于
带认证的检查；`offline` 不能据此判定账号无优惠，程序会保留上次可信结果并标记待复核。

## 临时窗口

“临时窗口”页面独立管理浏览器窗口，支持名称、备注、默认主页和出口节点。直接选择可用的订阅或自定义节点，无需创建账号或分组；前置连接沿用“网络配置”。默认主页为 `https://chatgpt.com/`，也可填写其他 HTTP/HTTPS 网址。

保存后可自动探测出口 IP 和时区；每次打开前再次通过所选节点探测，并在加载主页前应用时区。页面显示出口 IP、IANA 时区及最近探测时间。探测失败可重试，不使用本机时区冒充结果；节点失效时阻止打开，不回退到其他出口。

每个窗口使用数据目录下独立的 `temporary-windows/<窗口 ID>` Chrome Profile。关闭窗口或重启应用会保留 Cookie、登录态和浏览数据。关闭窗口后，可选择“清理浏览数据”重置该窗口的全部浏览器数据（包括书签与扩展设置），保留名称、备注、主页及节点配置；“删除”同时删除窗口配置和浏览数据。两项操作均须在页面确认，且仅在 Chrome 已确认完全关闭后执行。临时窗口也参与浏览器容量、退出清理和更新阻塞检查。

## iCloud 隐私邮箱

在“iCloud 隐私邮箱”点击“打开 iCloud / 登录”，手动完成 Apple 账号登录和验证；若有“保持登录”或“信任此浏览器”选项，请选择，进入“隐藏邮件地址”后点击“同步列表”。登录态保存在数据目录下独立的 `icloud-profiles/primary` Chrome Profile，不会复用 ChatGPT 账号或其他浏览器的登录态。未保持登录的会话可能在关闭 Chrome 后失效，此时会暂停并提示重新登录。第一版适配中国大陆 `icloud.com.cn` 页面，并绑定首次成功同步的 Apple 账号；登录不同账号时暂停，防止混合列表和本地使用状态。

设置固定标签（必填，默认 `G`）、固定 iCloud 备注（可选），选择申请模式并开启“自动申请”：

- **每次 1 个**：按单个申请间隔循环，默认 15 分钟；已有配置继续使用此模式。
- **每轮固定数量**：每轮连续申请 1–5 个，默认 5 个；例如轮次间隔 60 分钟，表示本轮完成后等待 60 分钟再申请下一轮。
- **申请到 iCloud 提示上限**：逐个申请到服务端返回限额；明确的临时限额按设定等待时间和服务端冷却时间中较晚者恢复，总量上限或无法判断的限额则暂停。

每个地址确认成功后才申请下一个，整轮复用同一个浏览器；出错或点击停止会结束本轮，已提交的地址先完成结果核对。开启或保存设置后先等待设定间隔，页面展示下次自动申请时间。手动“申请 1 个”始终只申请一个。手动浏览器打开期间等待，关闭后继续；最小化到托盘后继续，完全退出或电脑休眠期间不运行，恢复后不集中补跑。

“每次 1 个”和“每轮固定数量”按本地滚动一小时最多尝试 5 次，同时参考同步列表中新建地址的时间；“申请到上限”不按本地 5 次估算提前结束，以服务端实际响应为准。所有模式均遵守已知冷却：429 使用 `Retry-After`，未提供时等待一小时；无法区分临时限额和总量上限时暂停，等待手动检查。登录失效暂停并提示登录；提交后的结果无法确认时暂停，保留待核对地址，重新同步确认后才能继续。冷却和待核对记录在重启后保留。

列表展示 iCloud 标签、云端备注、云端活跃状态，以及独立保存的本地备注和使用状态。已有邮箱初次同步为“待确认”，本软件创建并确认成功的新邮箱为“未使用”；刷新不会覆盖本地备注和使用状态。支持搜索、筛选、跨页多选和每行一个地址的批量复制。普通复制保持使用状态，“复制并标记已使用”仅在复制成功后更新。第一版不编辑已有地址的云端备注，也不删除或停用地址。

网络模式可选直连（默认）、跟随应用“网络配置”、系统代理。修改前须关闭 iCloud 浏览器；直连仍遵循操作系统路由和 TUN/VPN。系统代理使用可识别的固定入口，PAC 等无法识别的配置会提示失败。

同步读取当前登录浏览器实际发出的 `/v2/hme/list` 响应，创建使用官方页面操作，支持中英文界面；不硬编码账号 ID、分区主机、客户端版本或 Cookie。先确认管理窗口就绪，再等待专用地址控件生成候选邮箱，避免卡片遮挡或异步加载导致误操作。网页和私有接口变化可能需要更新适配。已用真实账号验证应用重启后复用登录态、后台创建及标签/备注/使用状态回读；真实账号的小时限额提示仍待验证。受控 Chrome 测试覆盖中英文页面、首页提前返回列表、卡片透明按钮、候选地址延迟生成、固定字段和 429，单元测试覆盖重启恢复、限额、登录失效及创建结果不确定等情况。

开发者可执行 `node --test test/icloud.test.js`；安装 Chrome 后设置 `GPT_ACCOUNT_ICLOUD_LAB=1` 并执行 `node --test test/icloudBrowser.integration.test.js`，验证所有请求均在本地拦截的浏览器流程。

## 导入自定义代理

“分组与代理”页面分别显示订阅节点和自定义节点。订阅节点列表默认折叠，可按需展开。点击“新增代理”或节点行的“编辑”，可在弹窗中填写名称、协议、服务器、端口、用户名和密码；无认证时账密均留空。编辑保留节点 ID、启停状态和分组绑定，修改已使用节点的连接信息会重新连接代理。自定义节点也可删除；重复导入保留已设置的名称。被分组引用的节点需先修改该分组出口后才能删除，删除闲置节点不会重启其他节点的代理连接。

“新增代理”弹窗合并了导入和手动新增入口。在顶部粘贴 `IP:PORT:USER:PWD` 或 `hostname:port@username:password` 格式节点（也支持 `\@` 分隔），点击“自动识别”后会回填下方文本框，可继续手动修改并保存。支持每行一条、最多 100 条批量识别；未指定协议时使用表单所选协议。用户名中的地区、会话参数和密码原样保留。例如：

```text
proxy.example.com:3000@user-region-Rand-sid-example-t-5:password
```

也支持以下格式（URL 或 curl 中的显式协议优先于手动选择）：

```text
http://user:password@proxy.example.com:3000
https://user:password@proxy.example.com:443
socks5://user:password@proxy.example.com:1080#我的节点
curl -x proxy.example.com:3000 -U "user:password" ipinfo.io
```

也可使用不带认证的 `主机:端口`（默认 HTTP）、`curl --proxy`、`--proxy-user`、`--socks5` 和 `--socks5-hostname`。curl 内容只解析代理参数，不会执行命令或访问其中的目标网址。URL 中用户名、密码的特殊字符需百分号编码；curl 的 `-U` 支持引号内的原始用户名和密码。每次最多导入 100 条，格式错误时整批不保存。

导入后可测速，并在分组中选择该节点作为账号出口。相同连接信息重复导入会去重，刷新 Clash 订阅会保留自定义节点。认证信息保存在本机代理配置中，不在节点列表或导入错误中回显；连接仍使用应用的私有 mihomo 内核。

## 连接故障排查

- 账号“打开网页”和“临时窗口”使用轻量原生控制连接：按需导航和关闭窗口，保留独立 Profile、代理、语言/时区及 Cookie，不再为所有页面接入 Playwright、安装页面初始化脚本或启用 Runtime/Network 事件监听。账号页面仍仅在 ChatGPT 域名下按需检查会话。登录流程和后台任务继续使用 Playwright；有头登录窗口保留原生焦点、显示偏好和下载行为。更新后需退出并重启应用，再重新打开浏览器窗口才能生效。
- 若网站出现 `Access is temporarily restricted` 等访问限制，提示本身不能确定原因。对照时需核实浏览器版本、实际出口 IP、代理链路及 Profile 的 Cookie/登录态；选择相同名称的节点不一定意味着出口和会话条件相同。保留报错时间、页面提示和请求 ID，有助于进一步排查。不要把本地浏览器行为测试通过视为网站限制已解除。
- 启动时后台和界面共用串行的 Agent 连接流程。首次连接超时后按 1、2、5、10、20、30 秒间隔最多重试六次，仍在启动的 Agent 不会因重试而被回收。侧栏离线时的刷新按钮可手动重新连接，无需退出全部。
- Tauri 的“网络配置”页提供直连、系统代理、指定中转三种模式，并展示模式示意图与分组链路预览。绑定节点的账号最终仍经分组专用节点访问网站；指定中转可从订阅与自定义节点池中模糊搜索选择。
- 直连模式不配置前置代理；系统代理模式自动读取 Windows 固定代理入口，也可手动填写 HTTP/HTTPS/SOCKS5 入口；指定中转模式固定使用选定节点。分组跟随系统代理时只经过一次系统入口；分组节点与指定中转相同时只连接一次该节点。未绑定节点的账号在直连模式直接访问、在系统模式跟随系统代理、在中转模式使用中转节点作为出口。
- 网络配置保存前须关闭账号浏览器并等待运行任务结束，保存后下次启动生效；中转失效会阻止启动，使用中的中转节点不能直接删除。节点测速也使用当前网络链路。直连和指定中转仍受操作系统路由、TUN/VPN 和 DNS 接管影响，可选填物理网卡名称约束私有内核的第一跳；未绑定节点的浏览器直连仍遵循系统路由。PAC 场景须为分组专用节点提供固定代理入口。
- 如果系统节点失效会连带影响分组节点，先关闭系统代理软件的 TUN／虚拟网卡模式进行对照（仅关闭“系统代理”开关不够）。需要保留 TUN 时，可尝试在系统代理的规则模式中按代理内核的完整进程路径配置 `DIRECT`，并验证规则命中和实际出口；这不是应用已经验证的自动修复。如果工具复用 Clash Verge 的可执行文件，路径规则会匹配该路径下的所有内核实例，不能只区分工具的私有进程。
- TUN 全局路由和路由排除的含义见 [mihomo 官方文档](https://wiki.metacubex.one/en/config/inbound/tun/)。应用不会自动修改其他代理软件或系统路由。

## 开发与构建

要求：

- Node.js `24.11.1`（见 `.node-version`）
- 本机 Google Chrome
- Windows Chrome broker 与独立网络工具：.NET SDK 10（现有版本固定文件为 `desktop/global.json`，不要求构建 Avalonia）
- Tauri 客户端：Rust 稳定版 + 平台 WebView 依赖
  （Windows 需 MSVC C++ 生成工具与 WebView2；Linux 需 `libwebkit2gtk-4.1-dev`）

安装依赖并测试：

```powershell
$env:PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = '1'
npm ci --ignore-scripts
npm test
```

Tauri 客户端（`app/`）：

```powershell
cd app
npm ci
npm run typecheck; npm run test; npm run build
cd src-tauri
cargo fmt -- --check; cargo clippy --all-targets -- -D warnings; cargo test
```

两个迁移门禁 spike（只在 Windows 上有意义）：

```powershell
cargo run --example containment_spike   # 关闭 job 句柄必须回收整棵进程树
cargo run --example agent_handshake     # 用真 Agent 跑通 hello / bootstrap / accounts.list
```

开发 Tauri 客户端时，在 `app/` 下运行 `npm run tauri dev`。Avalonia 不再列入开发、构建或回归要求；旧代码仅供历史参考。安装包使用私有 Node，用户无需自行安装 Git、Node、npm、.NET 或 Playwright 浏览器。

## Agent 与数据目录

Agent 可单独启动用于诊断：

```powershell
npm run start:agent -- --data-root C:\path\to\keeper-data
```

默认数据位置：

- Windows 数据：`%LOCALAPPDATA%\GptAccountKeeper\data`
- Windows Desktop 配置与引导：`%APPDATA%\GptAccountKeeper\desktop.json`、`bootstrap.json`
- Windows 缓存/状态：`%LOCALAPPDATA%\GptAccountKeeper\cache`、`state`
- macOS：`~/Library/Application Support/GptAccountKeeper`
- Linux：`${XDG_DATA_HOME:-~/.local/share}/gpt-account-keeper`

Desktop 是 Agent 的客户端，不直接写 SQLite、Profile、Chrome 或 mihomo。所有修改命令携带 UUID `commandId`，结果在 SQLite 中保留 24 小时，进程重启后重复提交也不会重复创建。

首次旧数据迁移可向 Agent 增加 `--legacy-root <旧项目目录>`。迁移在 staging 中构造并校验数据库，Profile 只复制、不移动，并排除 Chrome 运行锁；程序不会自动删除旧源码目录或旧数据。

## IPC v1

Canonical JSON Schema 位于 `contracts/ipc-v1.schema.json`（消息信封/共享类型）和 `contracts/ipc-v1.methods.schema.json`（所有方法输入/输出）。主要方法组：

- `system.hello/bootstrap/getActivity/prepareUpdate/shutdown`
- `accounts.*`、`browser.*`、`temporaryWindows.*`、`history.*`
- `groups.*`、`proxies.*`、`profiles.*`
- `conversations.*`、`scheduler.*`、`settings.*`、`operations.*`

登录、立即运行、状态刷新、代理与 Profile 长任务都返回 Operation；状态变化通过有序事件推送，Desktop 在断线、序号缺口或 Agent 实例变化后重新获取 bootstrap 快照。

## 发行与更新

`.github/workflows/windows-release.yml` 会：

1. 用一个 Tauri 前端/Rust cargo 门禁和四平台 Node 测试矩阵验证源码。
2. 下载固定版本的 Node 与 mihomo 并校验 SHA-256。
3. 使用 `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` 安装生产依赖。
4. 拒绝 Chromium、`ms-playwright` 和旧 `public/` 管理页进入产物。
5. 用私有 Node 对 staged Agent 执行 IPC/SQLite 启动烟测。
6. 将项目许可证、第三方声明、隐私和源码说明写入安装包的 `licenses/`。
7. 在四个原生 runner 上执行 `tauri build`，生成 Windows NSIS、两种 macOS DMG、
   Linux AppImage/deb/rpm 以及各自的 updater `.sig`。
8. Windows Authenticode 可选；保留 Apple Developer ID/公证/stapling、Linux Minisign 门禁；
   `v0.2.11`、`v0.2.12` 各有版本限定的 unsigned 发布例外。
9. 生成只含四个允许目标的 `latest.json`，再汇总 SBOM、项目与 mihomo 对应源码及
   `SHA256SUMS.release.txt` 到同一个 Draft Release。

固定发行标识：

- 显示名：`ChatGPT Account Keeper`
- Bundle ID：`io.github.yang-sanmu.gptaccountkeeper`

更新源是公开的 [GitHub Releases](https://github.com/yang-sanmu/chatgpt-account-keeper/releases)，客户端不含 GitHub Token。正常版本的 GitHub Draft 不会被客户端看到；公开前必须完成候选安装与真实 Tauri N → N+1 更新验收。

### 签名发布门禁

Windows Authenticode 不再是发布前置条件，未配置时保留 `UNSIGNED-win-x64.txt` 并在更新摘要中说明。macOS Developer ID + Apple 公证及 Linux Minisign 仍是常规 Draft 门禁；这些平台缺少签名时只能生成内部检查产物。Tauri updater 私钥、公钥、四平台构建、`.sig`、SBOM、校验和及安装更新验收继续保留。用户分别授权 `v0.2.11`、`v0.2.12` 使用各自版本限定的 unsigned 直接公开开关，跳过平台签名及本地安装更新验收；保留 updater 签名。具体见 [远端发布流程](docs/RELEASE_REMOTE.md)。

### 发布新版本

正式发布与标准本地构建脚本要求 `main` 工作树干净且与 `origin/main` 一致。开发分支上的本地检查包须单独标记 inspection-only，不能用于正式更新；本次 [0.2.12 检查记录](docs/ORDINARY_MODE_RELEASE_0_2_12.md) 包含验证结果和隔离启动方式。

- **[远端发布流程](docs/RELEASE_REMOTE.md)** —— 用 GitHub Actions 构建。日常首选。
- **[本地 Windows 检查流程](docs/RELEASE_LOCAL.md)** —— 只用于 Windows 包诊断，不能替代四平台 Draft 发布。
- **[N-1 → N 验收](docs/RELEASE_VERIFY.md)** —— 两条路径共用的升级验收清单。

正常版本只有远端四平台流程能创建 Draft Release；真实更新验收后显式执行
`-Mode PublishDraft -UpdaterVerified`，版本才会进入客户端的稳定更新通道。`v0.2.11`
的一次性 unsigned 首发命令与风险边界单独记录在远端发布流程中。

## 过渡期旧入口

旧网页管理端暂时仅用于 REST/IPC 等价回归：

```powershell
npm run start:legacy
```

它会在 `127.0.0.1:5173` 启动旧 Express 页面，不属于最终安装包。生产 staging 脚本明确排除 `server.js`、`cli.js` 与 `public/`。

## 许可证、隐私与源码

Copyright © 2026 yang-sanmu。项目代码以 [GNU Affero General Public License v3.0 only](LICENSE) 发布。通过网络向用户提供修改版程序功能时，AGPL 第 13 条要求向这些用户提供相应版本的完整对应源码。

- [第三方组件与许可证](THIRD_PARTY_NOTICES.md)
- [隐私政策](PRIVACY.md)
- [对应源码与构建信息](SOURCE.md)

这些说明随安装包复制到 `licenses/`，也可在应用内"设置 → 关于与许可"打开。AGPL 不会把第三方组件改成 AGPL；Node.js、mihomo、Playwright、Avalonia、Tauri、wry、React 等仍各自遵循上游许可证。

Tauri 客户端把前端资源编进二进制并经自定义协议加载，不启动 HTTP 服务器，因此不构成
AGPL 第 13 条所指的"通过网络提供功能"。

本项目是非官方个人项目，与 OpenAI、Google 或其他服务提供方无隶属、赞助或背书关系。ChatGPT、OpenAI 和 Google Chrome 等名称仅用于说明兼容对象。

## 安全与限制

- Profile 包含 Cookie、Local Storage 与登录态，代理配置可能包含订阅 Token/密码；不要提交、分享或加入普通日志。
- 管理 IPC 以当前 OS 用户为信任边界。Unix Socket 权限为 `0600`；Windows 使用每用户命名管道，并在首次 hello 中验证一个 256 位随机凭据。凭据文件移除继承 ACL，只允许当前用户读取；无凭据的连接在任何业务调用前关闭。
- Headless 身份覆盖目前需要 Chrome DevTools Protocol，任务期间可能使用随机、仅回环的短生命周期 CDP 端口；它不是管理端口。
- 登录态只承诺同一机器、同一 OS 用户迁移；DPAPI、Keychain 或密钥环可能使跨用户/跨机器迁移需要重新登录。
- 自动化访问 ChatGPT 网页端可能违反服务条款并带来账号限制风险。本项目仅供个人学习与技术研究，使用风险自负。
