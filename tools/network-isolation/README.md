# Network isolation M1 lab

这是 **未验收的原型**，不是 Windows 服务或发行版安装器，不应安装到日常主机。当前没有专用 Windows 测试机，项目没有运行任何 WFP 写入命令。生产能力始终为 `M1_NOT_ACCEPTED`。

**2026-10-10 方案已更新为 [v4：每组独立 Chrome 路径](../../docs/BROWSER_NETWORK_ISOLATION.md)。本目录代码和示例仍是 v3 的共享 `chromePath` 原型。** 下列步骤只用于旧实验复现与只读检查，不具备 v4 的逐组路径、入口客户端默认拒绝及完整入站保护。不能只删除 mihomo 的 `users` 就运行新路线；新策略模型和启动门槛需先实现，再在专用环境验收。

M1-A 已新增独立的 JavaScript [离线分组模型](../../docs/GROUP_PATH_PLAN.md)：生成逐组程序路径、校验清单和代次冲突，输出四项策略意图与受控配置草案。它不是本 C# 工具的 WFP 策略格式，不能传给 `run`。本工具新加的 `runtime-*` 命令提供目录与容量的只读检查，`encode-wfp` 提供 v4 资源清单的内存编码检查，所有输出仍缺少启动授权。

## 可运行的无策略写入检查

在仓库根目录执行：

```powershell
dotnet publish tools/network-isolation/NetworkIsolation.csproj -c Release -r win-x64
$lab = (Resolve-Path tools/network-isolation/bin/Release/net10.0-windows/win-x64/publish/network-isolation-lab.exe).Path
& $lab selftest
& $lab validate tools/network-isolation/policy.example.json
& $lab ports
```

`selftest` 验证 Windows SDK 10.0.26100.0 的 x64 ABI、稳定资源键、程序清单与哈希、端口解析和路径拒绝；不打开 WFP。`validate` 只验证配置结构。`ports` 只读取 IPv4/IPv6 TCP 动态范围、排除范围及已占用端口，不修改主机配置。这些检查均不证明网络保护有效。

示例中的 TEST-NET 地址与占位 SHA-256 不可直接运行。准备副本后，`manifest <Chrome副本目录>` 输出该目录内全部 `.exe` 的路径及哈希，填入 policy 的 `chromePrograms`；每组代理还必须填写自身 `proxySha256`。`preflight <policy.json>` 校验实际文件、完整清单、标记文件和入口端口，同样不打开 WFP。

v4 目录检查使用 `runtime-manifest <Chrome目录>`（全文件清单、文件版本、SHA-256）、`runtime-verify <目录> <清单.json>`（完整复核）及 `runtime-space <已存在目录>`（当前用户可用空间）。这三个命令不打开 WFP，不启动扫描到的程序，不要求 `--isolated-lab`；当前只支持本地 NTFS，拒绝硬链接、目录及祖先的重解析跳转，变更中或无法读取的目录返回失败。将清单保存在扫描目录之外，避免自身成为额外文件。清单仅供后续 v4 编译器使用，不能当作来源签名、ACL、Profile 迁移或启动授权的证明。详细预算语义及测试记录见[分组模型说明](../../docs/GROUP_PATH_PLAN.md#只读目录预检查与容量)。

`selftest` 现也包含合成全文件清单、变更检测和容量查询；真实硬链接与 junction 对照通过 `node --test test/runtimeInventory.integration.test.js` 执行，需先发布本工具。工具是独立的网络实验组件，不属于已停止维护的 Avalonia 客户端。

`runtime-report <Chrome目录>` 在上述完整只读扫描上附带实际目录，输出可交给 JavaScript `compileWfpResourcePlan()` 的观测数据。新[离线 WFP 资源清单](../../docs/WFP_RESOURCE_PLAN.md)包含逐层条件、生命周期及清理键；清单匹配仍不是管理服务授权，缺少 CDP 例外及安装流程，不能传给旧 `run` 命令。不要把“报告匹配”显示成“网络已保护”。

`encode-wfp <resources.json>` 接收 `compileWfpResourcePlan()` 的离线输出，在内存中编码应用 ID、用户安全描述符、地址掩码及过滤器，再回读成 JSON 报告。它只读取输入及程序路径信息，不打开 WFP engine、不安装规则。报告含本机路径与 SID，仅供本地检查，始终 `productionReady: false`。运行 `node --test test/wfpResourceEncoding.integration.test.js` 验证真实 Windows API 编码，需先重新发布当前工具；测试仅创建临时合成文件，不执行它们。规则被 BFE 接受及实际网络行为仍须专用环境验证。

## 隔离测试机上的操作

仅在专用 Windows 11 x64 测试机上执行以下步骤，使用新 Profile 和测试节点。保留原始 policy 文件；同一个 id 的配置不得改写，配置变更使用新 id。程序路径必须是 LabRoot 内的完整副本，不能是日常 Chrome、符号链接或 junction。程序主动拒绝根目录、UNC、目录外路径及重复代理路径。

1. 为实验生成新 UUID，准备 Chrome 完整副本、每组独立 mihomo 副本，以及 `NETWORK_ISOLATION_LAB_ONLY` 空标记文件。保存准确的路径、全部 Chrome `.exe` 清单及哈希、代理哈希、入口端口、已验证上游 IP/端口/协议。不复制账号凭据或真实 Profile。
2. 先确认所有测试进程已经停止，执行 `preflight <policy.json>`。端口必须大于等于 1024，并避开本机实际 TCP 动态范围、排除范围及已占用端口；不能只假定 49152 以下就安全。遇到占用就换新配置，不终止占用软件。预检查不等于预留端口，检查至绑定之间的竞争仍需测试和后续协调器处理。
3. 在提权终端运行 `network-isolation-lab.exe run <policy.json> --isolated-lab`。收到 `installed-blocked` 只说明 WFP 事务提交，尚未证明实际数据路径阻断。
4. 该进程标准输入支持 `activate a`、`freeze a`、`freeze-all`、`quit`。激活和冻结同时更新 Chrome→指定回环入口、该组 mihomo→批准上游两段。EOF、退出或进程被终止只关闭动态会话，持久化拒绝规则继续存在。
5. 另一个终端可使用 `inspect <policy.json>` 读取预期持久化规则是否存在。计数不能证明规则内容、优先级和已有连接撤销正确，必须同时保存 WFP 状态与抓包证据。
6. 退出测试程序、关闭测试 Chrome 和 mihomo，并通过 broker Job 清零证明关闭后，执行 `cleanup <policy.json> --isolated-lab --processes-stopped`。标志是操作者对证明的确认，不是自动获得的关闭证明。先清理规则再删除实验文件。异常退出后用同一 policy 清理；不要删除整个系统防火墙策略。

Chrome 清单内每个程序都有默认出站阻断，只有主 `chrome.exe` 获得入口放行，辅助程序不自动获得联网许可。运行前发现新增/删除的 `.exe` 或哈希变化会拒绝，要求新的策略代次；不能在运行期间更新副本。清理使用原 policy 中稳定的清单与键，不依赖当前磁盘文件仍存在或哈希仍一致。务必保留原文件，否则可能无法完整回收持久化规则。

这版尚无受限服务身份、Service SID ACL、身份校验管道、管理员保护安装目录、签名校验、配置变更协调器或运行恢复服务。哈希只能验证文件与本次策略一致，不能替代可信发行来源或防止校验后被改写。它接受实验策略文件，**不能作为生产权限边界**。AUTH_LISTEN/AUTH_RECV_ACCEPT 入站限制和精确控制通道尚未实现；已有策略优先级、ALE_APP_ID 的绑定条件、回环、IPv6、动态会话退出清理及存量连接重新授权均待实测。

## 证据与阳性对照

在隔离测试机中记录 BFE 状态、系统版本、Secure Boot/HVCI、程序哈希、规则 GUID、代理配置代次、Job 进程树、开始结束时间及抓取组件。不得收集真实账号凭据。

系统 `pktmon start help` 可确认当前版本参数。一个有界捕获示例：

```powershell
pktmon start --capture --comp all --pkt-size 128 --file-size 128 --file-name C:\NetworkLab\capture.etl
# 执行一次明确标识的测试，然后停止。
pktmon stop
pktmon etl2pcap C:\NetworkLab\capture.etl --out C:\NetworkLab\capture.pcapng
```

先确认没有其他人在抓包并记录既有 pktmon 过滤条件，不清除他人的过滤器。全组件捕获仍需说明对回环、虚拟交换机/VPN、IPv6 的可见性；128 字节避免无必要的完整业务载荷，但原始捕获文件仍应限制访问。通过测试程序向受控目标的明确直连作阳性对照，确认检测器能看到该连接。之后对同一目标启用策略，结合 WFP 规则状态、5152/5157 审计及系统 DNS 观测判断。审计配置仅在实验机开启并记录原值；无日志不算通过。

必须分别测试：默认拒绝；A/B 两组并发；普通 Chrome 不受影响；错误入口与端口抢占；TCP/UDP/IPv6；DIRECT/DNS fallback 故意错误；长连接与缓冲上传冻结；动态管理进程崩溃/卡死；BFE 状态异常；重启/休眠；其他 VPN/防火墙；活动窗口关闭失败。持久化策略不能由一次 `inspect` 或一次连接失败替代验收。

## Chrome / mihomo 本地测试

这些测试只新建 `artifacts/network-lab/` 下的测试 Profile、运行副本和本地服务器，不安装 WFP，不修改系统代理/路由/DNS。自动清理 broker 管理的子进程；认证配置在结束时删除。报告不含代理密码，测试 Profile 保留以便复现。

```powershell
$env:GPT_ACCOUNT_NETWORK_LAB = '1'
node --test --test-concurrency=1 test/networkAuth.integration.test.js test/networkRuntime.integration.test.js test/browserEnvironment.integration.test.js
# 已覆盖的 HTTPS/WSS、真实跨进程 iframe、双组并发与关闭后换组；另需 PowerShell 7。
node --test --test-concurrency=1 --test-name-pattern='M1 HTTPS' test/networkAuthMatrix.integration.test.js
# M1 冷认证门槛：当前明确失败，不能跳过后宣称 M1 通过。
node --test --test-concurrency=1 --test-name-pattern='cold authentication' test/networkAuthMatrix.integration.test.js
Remove-Item Env:GPT_ACCOUNT_NETWORK_LAB
```

需要先构建 `tools/chrome-launcher`，安装 Google Chrome，并准备 `artifacts/release-input/mihomo/mihomo-windows-amd64-compatible.exe`。可通过 `GPT_ACCOUNT_NETWORK_LAB_MIHOMO` 指定测试 mihomo。测试上游只允许该测试自己的回环源站，不转发其他目的地。

认证脚本使用 `installBrowserStartupBarrier` 将身份、环境和代理认证放入一个原始 CDP 连接，由它统一自动附加目标；Playwright 仍有自己的控制连接。该原型尚未接入产品，不能同时给同一次运行再安装旧身份屏障。原脚本覆盖无/错/跨组凭据、第一页面、网站 401、popup、同源 iframe、WS、三类 Worker、CDP 断开触发 Job 清零。

`networkAuthMatrix.integration.test.js` 扩展 HTTPS CONNECT、WSS、跨站 OOPIF 和两组 Chrome 同时运行。各组使用不同代理、凭据和环境，在同一测试 HTTPS 站点验证 Cookie/Local Storage 隔离；源站按实际转发连接标识组别，不能仅凭浏览器配置推断出口。两个数值回环站点用于跨站 iframe，测试启用 `--site-per-process`，并断言确有 `iframe` 类型的 CDP Target。入口与快照不符、匹配入口但凭据来自另一组，均要求在到达上游前拒绝并关闭。旧 Job 清零后再复用测试 Profile 换组，校验 Cookie 保留与重新认证，以及另一组继续可用。

TLS 测试每次在内存生成有效期一天的临时 CA 和有效期 12 小时的站点证书，只向新建测试 Profile 的 `Default/ServerCertificate` 写入该 CA。该测试夹具依据 Chromium 的 [数据库实现](https://chromium.googlesource.com/chromium/src/+/main/components/server_certificate_database/server_certificate_database.cc) 和 [信任元数据定义](https://chromium.googlesource.com/chromium/src/+/main/components/server_certificate_database/server_certificate_database.proto)，依赖当前 schema 1，并非生产证书管理接口。不写 Windows/用户系统证书库，不使用忽略证书错误参数；不受信任的证书和主机名错误必须仍被 Chrome 拒绝。测试退出时删除生成的站点私钥，CA 私钥只在生成进程内存在。它验证的是 HTTPS 网页经 HTTP 上游代理的认证链路，不能替代 HTTPS 类型上游节点的 TLS/SNI 验收。

计划内主动关闭须调用统一屏障的 `requestBrowserClose()`，它保持认证处理并将状态改为 `closing`，避免正常 CDP 断开触发过早的 Job 强杀。随后仍须有界等待 Job 清零、失败时兜底回收，得到证明后才 `barrier.close()` 和复用 Profile。该方法不证明网络冻结或进程关闭；未请求关闭的 CDP 断开，以及请求关闭后通道仍连接但无响应，继续走故障处理。用户手动关闭窗口的生命周期接入仍待验证。

错误凭据不一定触发第二次认证挑战：[mihomo 1.19.29](https://github.com/MetaCubeX/mihomo/blob/v1.19.29/listener/http/proxy.go#L141) 返回 403 后，Chrome 的 CONNECT 请求可能直接产生 `ERR_TUNNEL_CONNECTION_FAILED`。原型关联本次凭据提交与尚未完成的请求，发生这种隧道失败就停止该次运行；这不代表所有隧道错误都能判定为密码错误。普通 HTTP 的 403 无法只凭状态码可靠区分入口拒绝与业务站点拒绝。

`probeMihomoAuthentication` 是独立的入口凭据诊断，不是网页响应来源分类器。它在三个新连接上向已登记的数值回环入口发送不含转发目标的 origin-form `GET /`：无密码必须返回 Basic 407、随机错误密码必须返回 403、指定密码按此版本 mihomo 的本地处理路径应返回 400。正确/错误凭据与未确认状态分别报告；未知响应、超时、免认证或忽略错误密码都不能判定通过。真实 mihomo 实验确认这些请求未到达上游；网页 403 仍交由网页处理。该检查不填充 Chrome 认证缓存，不证明端口归属或每个业务请求被认证，未接入生产启动流程，也不能替代 WFP 和进程代次检查。

**冷 WSS 是已复现的 M1 阻塞项。** 全新 Profile 从 `about:blank` 发起 WSS 时，Chrome 155 没有发送 `Fetch.authRequired`，只返回 `Network.webSocketFrameError: Proxy authentication failed`。另一个全新 Profile 先通过 HTTPS 完成代理认证，再回到 `about:blank` 连接同一 WSS 端点即可成功。有头/后台均复现。原型现在将该确切错误标为 `control_error` 并关闭 Job；这只是失败处理，未修复冷 WSS 支持，不自动重发请求。验收用例保留失败断言，输出 `passed: false`。

已按 `155.0.8059.40` 源码确认普通 WebSocket 认证路径未连接到 Fetch 处理器，不能用增加 CDP 客户端或延长超时作为已验证的修复。版本化源码证据和替代路线的门槛见 [冷 WSS 方案评估](../../docs/COLD_WSS_AUTHENTICATION_REVIEW.md)。每组 Chrome 路径已获用户接受并纳入 v4 计划，目前仅实现部分离线模型，运行保护尚未实现或启用；扩展替代方案未采用。

同一冷认证用例还单独验证了全新 Profile 中 dedicated Worker 的第一次 HTTPS fetch，确有新的代理挑战并成功抵达上游。它不覆盖 shared/service Worker，也不等于运行中清空认证缓存后的所有行为。[CDP 实现](https://chromium.googlesource.com/chromium/src/+/main/content/browser/devtools/protocol/network_handler.cc) 的清 Cookie 与清网页缓存不能当作清代理认证缓存。本轮使用全新 Profile 实证冷状态，尚未声称运行中缓存清除已经验收。

尚未覆盖运行中认证缓存失效后的恢复、shared/service Worker 冷状态、真实网络端点、WFP 端口抢占，也没有给出 ChatGPT 页面加载性能基线；不得把已有本地测试通过扩大成完整认证或网络保护门槛通过。运行整个认证矩阵会包含冷 WSS 两项失败，这是当前验收结果，不能改成预期成功、跳过或仅靠预热后通过。

页面请求等待初始化回执；Service Worker 安装阶段的 fetch 有不同约束：Fetch 认证拦截和递归附加必须先确认，随后将身份与观察命令按序排入同一通道，再允许请求继续，以免安装 fetch 和初始化回执互相等待。后续命令错误或无响应仍触发关闭处理；不能将“命令已经发出”记录成“网络已经冻结”。

路径实验先使用 `inspectProfileForRuntimeCopy` 做只读格式检查：要求 Job 清零证明，检查 Local State、各 Profile 的当前与旧 Cookie 位置以及 WAL，遇到应用绑定加密、未知密文、损坏、链接目录或待恢复数据库就拒绝。SQLite 只打开临时副本，不打开原数据库进行恢复。守卫结果始终为 `migrationVerified: false`；格式符合预期不代表解密或登录态验证成功。正式接入还必须在检查和切换全过程持有 Profile 准入锁，该锁尚未实现；不能直接将此原型用于真实账号迁移。

参考：[WFP 对象生命周期](https://learn.microsoft.com/en-us/windows/win32/fwp/object-management)、[ALE 重新授权](https://learn.microsoft.com/en-us/windows/win32/fwp/ale-re-authorization)、[Playwright 的 Worker Fetch 归属处理](https://github.com/microsoft/playwright/blob/main/packages/playwright-core/src/server/chromium/crNetworkManager.ts)、[同 renderer 的 locale 处理](https://github.com/microsoft/playwright/blob/main/packages/playwright-core/src/server/chromium/crPage.ts)。
