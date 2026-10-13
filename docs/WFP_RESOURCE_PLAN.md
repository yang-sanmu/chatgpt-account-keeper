# v4 离线 WFP 资源编译

2026-10-13，M1-A。`src/network/wfpResourcePlan.js` 的 `compileWfpResourcePlan(input, { runtimeObservations, programObservations, portObservation })` 将 `group_path_v1` 原始登记输入编译成可检查的规则资源清单。三个观测选项均可省略，省略时相应检查保留未观测。它内部先运行 `compileGroupPathPlan()`，不接受调用方改写好的放行意图；旧 v3 的 C# `run` 命令不接受这份新清单。

输出固定 `kind: offline_wfp_resources`、`schemaVersion: 1`、`launchAuthorization: not_issued`。这不是原生 `FWPM_FILTER0`，不打开 WFP、不登记端口、不生成启动许可，不包含上游密码或完整 mihomo 配置。严格模式仍不可用。

## 规则与生命周期

每条描述包含确定的资源 GUID、所属组和适用代次、层名、条件、动作、权重及持久/动态生命周期。同一安装及相同规则内容产生相同 GUID，输入分组/文件顺序变化不改变规则清单。Chrome 的默认规则在活动/候选代次间只生成一次。程序清单保留预期文件哈希，但 WFP 应用匹配本身不验证哈希。

| 规则 | 层与条件 |
| --- | --- |
| 程序默认拒绝 | 每个 Chrome 主程序/辅助 exe 及 mihomo 在 IPv4/IPv6 的 CONNECT、LISTEN、RECV_ACCEPT 层按程序路径阻断 |
| 入口客户端默认拒绝 | CONNECT 层按已登记 TCP 端口及 IPv4 回环、IPv6 回环、IPv4 映射回环地址阻断其它客户端；不阻断其它回环端口或同端口的公网连接 |
| 入口监听归属 | RESOURCE_ASSIGNMENT、LISTEN、RECV_ACCEPT 对已登记入口端口默认拒绝；动态例外仅给对应 mihomo 路径、用户和 `127.0.0.1`。接收例外还要求远端为 `127.0.0.1` |
| 活动链路放行 | CONNECT 层允许本组主 Chrome 路径和用户到本组入口，以及本组 mihomo 路径和用户到批准上游；后者单独区分 TCP/UDP |

条件按层分别生成。LISTEN 不添加该层不支持的 `IP_PROTOCOL`；接收侧应用条件只表示接收程序，入口客户端身份由 CONNECT 侧约束。依据是 Microsoft 的[逐层可用条件表](https://learn.microsoft.com/en-us/windows/win32/fwp/filtering-conditions-available-at-each-filtering-layer)。不按程序封锁全部 RESOURCE_ASSIGNMENT，否则会一起拒绝正常出站所需的临时端口绑定。

候选代次只声明对应入口的监听归属例外，没有浏览器入口及上游 CONNECT 放行。候选诊断通道尚未接入。上游若指向本清单任何已登记回环入口（含映射地址），编译直接拒绝，防止上游例外覆盖入口阻断；未指定地址也不能用作上游。

默认拒绝为持久规则，权重 10；精确例外为动态规则，权重 100，均属于同一私有子层。`clearActionRight` 固定为 false，不要求不可覆盖的强制放行。权重只用于本子层的候选规则次序，不能证明已与现有防火墙正确共存；见 [WFP 仲裁规则](https://learn.microsoft.com/en-us/windows/win32/fwp/filter-arbitration)。实际优先级与回环行为仍必须实测。

各组 `freezeKeys` 列出浏览器入口与代理上游两个动态规则的键，撤销后本组入口和出站默认拒绝继续保留；代理监听归属及 CDP 例外待进程关闭阶段撤销。`cleanupKeys` 分开列出整份清单的动态规则、持久规则、子层和 provider，供后续协调器保存与有序清理。当前只输出键，不执行删除，也不把删除清单当作已冻结或 Job 清零证据。

## 原生目录报告衔接

实验工具新增只读命令：

```powershell
& $lab runtime-report 'C:\NetworkLab\registered-chrome\active'
```

输出 `{ kind: "runtime_inventory_observation", directory, manifest }`，使用完整目录扫描、硬链接/重解析检查及扫描后复核。`manifest` 与原 `runtime-manifest` 格式相同。相对于只有文件清单的输出，新报告同时记录实际扫描目录。

编译器按已生成的组 Chrome 活动路径匹配报告，再比较版本及每个文件的相对路径、大小和 SHA-256。源安装目录的相同文件不能替代组副本报告。重复、未知目录或不匹配清单返回错误；缺少某组报告则保留 `not_observed`，匹配时仅标记 `matched_observation`。

报告是数据，不是签名证明或管理服务回执。离线匹配不验证报告来源/时效，也不保证检查后目录未变；因此不消除调用者身份、签名/ACL、更新锁、启动准入或其它待办门槛。代理和控制程序可通过下述独立文件报告核对，缺少报告时逐项保留 `not_observed`。输入不能通过传入 `true` 来宣称目录已验证。

## 程序文件与 TCP 端口报告

```powershell
& $lab program-report 'C:\NetworkLab\registered-proxy\mihomo.exe'
& $lab program-report 'C:\Keeper\node.exe'
& $lab ports-report
```

`program-report` 输出 `{ kind: "program_file_observation", path, sizeBytes, sha256, observedAt, productionReady: false }`。只读打开本地 NTFS 文件并计算 SHA-256，复用目录工具的硬链接和祖先重解析检查；拒绝备用数据流路径，哈希前后核对文件标识，并在持有读句柄时复查路径。命令不执行文件、不验证 PE 格式、签名或 ACL，结束后也不保留启动锁。

将文件报告数组传入 `programObservations`。编译器按已登记的代理代次路径、控制程序路径及预期哈希匹配，路径比较忽略大小写；同一路径的多个控制程序登记共用一份报告。未知路径、重复报告、哈希不符或缺失观测字段返回错误。`preflight.proxyFiles/controllerFiles` 为逐资源结果，包含路径、预期哈希及 `matched_observation / not_observed`；匹配时附带文件大小和观测时间。大小仅为观测信息，预期内容由哈希核对。

`ports-report` 输出 `{ kind: "tcp_port_observation", scope: "tcp_ipv4_ipv6", observedAt, dynamicRanges, excludedRanges, occupiedPorts, portsReserved: false, productionReady: false }`。复用现有只读查询，汇总 IPv4 和 IPv6 各自的 TCP 动态范围、两者的排除范围以及监听/连接表中的本地端口。任一家族查询或解析失败时整个命令失败；不将不完整结果当作空集合，也不检查或占用 UDP 端口。

将该报告传入 `portObservation`，`preflight.ports.entries` 覆盖所有代理代次入口和全部 CDP 端口。结果分别为 `not_observed`、`conflict_observed`、`no_conflict_observed`，冲突原因可同时包含 `dynamic_range / excluded_range / occupied`。不能仅依据固定的 49152 分界判断端口；两个家族的范围合并保守检查。冲突保留在离线报告中供调整草案，不自动换端口或终止占用程序。

观测时间只是查询完成时间，这些多步读取不是原子快照，也不证明报告新鲜或端口已预留。没有发现冲突不保证下一次绑定成功；管理侧准入锁、绑定时复查和实际监听归属仍待实现。观测不改变规则、`pendingChecks` 或 `launchAuthorization: not_issued`，签名/ACL 继续为 `not_checked`。

## 原生编码与验收边界

JavaScript 清单中的应用路径和用户身份保留为中间表示。独立原生工具现可将其编码为 WFP 应用 ID 和用户安全描述符；`ALE_USER_ID` 的原生类型是安全描述符，不能直接塞入 SID，见 [Microsoft 条件定义](https://learn.microsoft.com/en-us/windows/win32/fwp/filtering-condition-identifiers-)。编码结果仍不是管理服务授权。

Chrome 的监听/接收默认阻断，现可从可选运行登记生成精确 CDP 端口例外。文件哈希与端口快照可离线核对；实际控制程序授权登记、端口/进程归属、签名/权限核对及启动流程尚未实现，因此这份清单仍不能直接用于可用的浏览器启动。完成这些前置条件后，才进入专用环境的 WFP 安装与实测；原型不能为方便调试放行全部回环。

测试中的条件匹配器只检查这份清单内部的允许/拒绝逻辑，不模拟原生安全描述符、其它 provider、真实流、重授权或服务崩溃清理。IPv6/映射地址条件能在模型中匹配，也不等于实际 Windows 数据路径已通过。

## 资源清单验证（2026-10-13）

NativeAOT 发布、工具 `selftest` 和旧 v3 策略结构校验通过。以下 34 项定向测试全部通过，无跳过：

```powershell
node --test test/wfpResourcePlan.test.js test/runtimeCapacity.test.js test/runtimeInventory.integration.test.js test/groupPathPlan.test.js test/strictNetworkConfig.test.js
```

覆盖跨组/用户/辅助程序拒绝、入口别名、监听条件、通配绑定、出站临时端口、上游 TCP/UDP、候选与两端冻结描述、稳定清理键、密码不出现在清单中，以及真实目录报告的正确路径/错误路径/内容变化对照。报告集成使用临时合成文件，不启动 Chrome。测试曾因 TEMP 含 `ADMINI~1` 被原路径规则拒绝，修正为完整路径后通过，没有放宽生产路径校验。

本轮没有修改生产启动路径、系统网络规则、真实账号或客户端。没有重跑全量 Node、Tauri 前端或 Rust。下一步是原生条件编码与精确控制通道模型；M1-B 仍要求专用 Windows 环境，M1 整体验收尚未通过。

## 原生编码检查（2026-10-13 后续）

新增 `WfpResourceEncoding.cs` 和只读命令：

```powershell
& $lab encode-wfp 'C:\NetworkLab\resources.json'
```

输入为 `compileWfpResourcePlan()` 输出的完整 JSON。工具只接受 `offline_wfp_resources / group_path_v1 / schemaVersion: 1`，在内存中构造 `FWPM_FILTER0` 和条件，再从非托管结构回读生成 `offline_wfp_encoding` 报告。每条规则处理完即释放对应内存。它不打开 WFP engine、不调用规则安装接口、不创建进程或端口。旧 `run` 命令仍不接受 v4 清单。

- 程序路径使用 `FwpmGetAppIdFromFileName0` 转成应用 ID，检查会读取路径信息；不把传入路径字符串直接当作设备路径。它不验证文件哈希、ACL、签名或进程身份。
- 用户 SID 转成含单个 allow ACE 的自相对安全描述符，访问掩码为 `FWP_ACTRL_MATCH_FILTER`，再封装成 `FWP_BYTE_BLOB`。该掩码用于条件匹配，不是流量许可，依据 [Microsoft 应用和用户过滤示例](https://learn.microsoft.com/en-us/windows/win32/fwp/permitting-and-blocking-applications-and-users)。
- IPv4 地址和掩码编码为两个主机序 `UINT32`；IPv6 编码为 16 个地址字节及一个前缀长度字节。x64 布局检查覆盖这些结构以及现有过滤器/条件结构。
- 层、字段、值类型、地址族和前缀必须一致；拒绝未知类型、重复条件/规则及本模型未使用的强制放行标志。这里的校验服务于编码，不能替代管理侧重新编译与授权。

输出固定 `wfpModified: false`、`productionReady: false`、`launchAuthorization: not_issued`。报告含本机程序设备路径和用户 SID，供本地调试，不应直接当作可上传的脱敏诊断。原生指针仅在工具进程内使用，不序列化为可复用句柄。

NativeAOT 发布、工具自检、旧 v3 结构校验及以下 **36 项测试通过，无跳过**：

```powershell
node --test test/wfpResourceEncoding.integration.test.js test/wfpResourcePlan.test.js test/runtimeCapacity.test.js test/runtimeInventory.integration.test.js test/groupPathPlan.test.js test/strictNetworkConfig.test.js
```

新增两个原生集成测试使用临时合成文件，核对全部 8 个层 GUID、条件类型、应用 ID、用户 DACL、地址字节、权重及持久化标志，并验证错误输入不输出部分成功结果。工具未发布或不在 Windows 时明确跳过。首次测试命中了上轮旧工具（没有新命令），重新完成本次 NativeAOT 发布后全部通过。没有运行 BFE 接受性测试，未验证回环、真实流、重授权或动态会话退出行为；未重跑全量 Node、Tauri 或 Rust。

## 精确 CDP 控制通道（2026-10-13 后续）

现有 `ChromeProcessLauncher` 的后台启动使用 `--remote-debugging-port=0`，有头启动则预先选非零端口；实际 CDP 客户端是 Node Agent（含 Playwright 与原始屏障连接），不是仅负责创建进程的 broker。本轮不改变这些生产行为。

离线模型现按一次 BrowserRun 登记非零 CDP 端口、账号/runToken、组路径及 Agent 程序与用户身份，并检查与代理入口/其它运行端口的冲突。输入说明见[分组模型](GROUP_PATH_PLAN.md#cdp-控制程序与运行登记)。未来严格启动应先取得该端口的保护资源，再用确定端口创建 Chrome，不能先放行整个回环等待 Chrome 自选端口。端口检查至绑定之间的竞争仍须管理组件和专用环境验证。

每次运行新增 13 条规则，复用代理入口的逐层条件生成逻辑：

| 规则 | 条件及生命周期 |
| --- | --- |
| CDP 客户端默认拒绝（3 条） | CONNECT，登记 TCP 端口的 IPv4 回环、IPv6 回环及映射回环；持久化 |
| CDP 监听归属默认拒绝（6 条） | IPv4/IPv6 的 BIND、LISTEN、RECV_ACCEPT，登记本地端口；持久化 |
| Chrome 监听归属例外（3 条） | 本组主 Chrome 路径及用户，仅在 `127.0.0.1` 的登记端口绑定、监听、接收；接收的远端也须为 `127.0.0.1`；动态 |
| Agent 客户端例外（1 条） | 对应 Agent 路径及用户，TCP，两端地址都是 `127.0.0.1`，远端为该 CDP 端口；动态 |

CDP 例外不放行 Agent 访问业务代理入口，不给 Chrome 额外出站许可，也不影响 Agent 的其它未登记目的地。批准上游若指向任一登记 CDP 回环端口，直接拒绝，避免上游例外覆盖控制端口阻断。未提供运行登记时不生成 CDP 规则，原有代理过滤器及其键保持不变。

各组 `controlChannels` 输出运行元数据及各自 `cleanupKeys`（4 条动态、9 条持久化）。这些键不进入业务 `freezeKeys`，冻结业务时保留 CDP 用于正常关闭；确认该 BrowserRun 的进程与连接清理后再撤销控制例外及端口登记。程序默认阻断为组共享规则，不归单次运行清理。动态会话失效时，持久化的客户端/监听拒绝继续保留。当前仅输出资源键，不执行上述流程。

同一用户、同一 Agent 可控制其登记运行；程序路径和 SID 无法独自区分同组账号进程、使用相同 Agent 程序的不同数据目录、不同脚本或登录会话。账号/runToken 绑定、实际监听进程归属、单写 Agent 与调用者验证仍由管理侧承担，不能用清单里的标签宣称 WFP 已完成逐进程隔离。程序哈希可通过只读报告匹配，`preflight.controllerFiles` 逐项记录观测情况；`pendingChecks` 不因报告匹配自动清零。

相同路径、用户、端口和条件复用稳定规则键，runToken 不是 WFP 条件。因此端口重用仍须经过旧运行清理与管理侧版本校验，不能凭旧 token/旧清理清单删除新运行规则。当前既没有端口预留，也没有服务授权或生产启动接入。

本轮上述同一测试命令共 **43 项通过，无跳过**，工具自检和旧 v3 结构校验通过。新增覆盖四运行登记、控制程序/账号/token/端口冲突、跨组/用户/别名拒绝、通配监听拒绝、冻结保留控制通道、逐运行清理、动态规则全部移除，以及新 CDP 条件进入原生编码。测试仍是条件模型和合成文件回读，不证明存量连接撤销或真实 Chrome 控制。C# 源码未变，使用上轮已发布工具；未重跑全量 Node、Tauri 或 Rust，没有写入 WFP 或启动代理/浏览器。

程序与实际端口的只读预检查已按上节衔接。后续可继续 M1-A 的程序来源签名和安装目录权限核对；实际授权、启动锁和监听归属不能由快照替代。M1-B 的真实过滤和故障验收仍需要专用 Windows 环境。
