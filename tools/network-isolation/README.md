# Network isolation M1 lab

这是 **未验收的原型**，不是 Windows 服务或发行版安装器，不应安装到日常主机。当前没有专用 Windows 测试机，项目没有运行任何 WFP 写入命令。生产能力始终为 `M1_NOT_ACCEPTED`。

## 可运行的无策略写入检查

在仓库根目录执行：

```powershell
dotnet publish tools/network-isolation/NetworkIsolation.csproj -c Release -r win-x64
$lab = (Resolve-Path tools/network-isolation/bin/Release/net10.0-windows/win-x64/publish/network-isolation-lab.exe).Path
& $lab selftest
& $lab validate tools/network-isolation/policy.example.json
```

`selftest` 验证 Windows SDK 10.0.26100.0 的 x64 ABI、稳定资源键与路径拒绝；不打开 WFP。`validate` 只解析配置，不证明网络保护有效。示例中的 TEST-NET 地址不可作为实际代理使用。

## 隔离测试机上的操作

仅在专用 Windows 11 x64 测试机上执行以下步骤，使用新 Profile 和测试节点。保留原始 policy 文件；同一个 id 的配置不得改写，配置变更使用新 id。程序路径必须是 LabRoot 内的完整副本，不能是日常 Chrome、符号链接或 junction。程序主动拒绝根目录、UNC、目录外路径及重复代理路径。

1. 为实验生成新 UUID，准备 Chrome 完整副本、每组独立 mihomo 副本，以及 `NETWORK_ISOLATION_LAB_ONLY` 空标记文件。保存准确的路径、入口端口、已验证上游 IP/端口/协议。不复制账号凭据或真实 Profile。
2. 先确认所有测试进程已经停止，端口空闲；端口被占用就换新配置，不终止占用软件。
3. 在提权终端运行 `network-isolation-lab.exe run <policy.json> --isolated-lab`。收到 `installed-blocked` 只说明 WFP 事务提交，尚未证明实际数据路径阻断。
4. 该进程标准输入支持 `activate a`、`freeze a`、`freeze-all`、`quit`。激活和冻结同时更新 Chrome→指定回环入口、该组 mihomo→批准上游两段。EOF、退出或进程被终止只关闭动态会话，持久化拒绝规则继续存在。
5. 另一个终端可使用 `inspect <policy.json>` 读取预期持久化规则是否存在。计数不能证明规则内容、优先级和已有连接撤销正确，必须同时保存 WFP 状态与抓包证据。
6. 退出测试程序、关闭测试 Chrome 和 mihomo，并通过 broker Job 清零证明关闭后，执行 `cleanup <policy.json> --isolated-lab --processes-stopped`。标志是操作者对证明的确认，不是自动获得的关闭证明。先清理规则再删除实验文件。异常退出后用同一 policy 清理；不要删除整个系统防火墙策略。

这版尚无受限服务身份、Service SID ACL、身份校验管道、管理员保护安装目录、签名校验、配置变更协调器或运行恢复服务。它接受实验策略文件，**不能作为生产权限边界**。已有策略优先级、ALE_APP_ID 的绑定条件、回环、IPv6、动态会话退出清理及存量连接重新授权均待实测。

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
Remove-Item Env:GPT_ACCOUNT_NETWORK_LAB
```

需要先构建 `tools/chrome-launcher`，安装 Google Chrome，并准备 `artifacts/release-input/mihomo/mihomo-windows-amd64-compatible.exe`。可通过 `GPT_ACCOUNT_NETWORK_LAB_MIHOMO` 指定测试 mihomo。测试上游只允许该测试自己的回环源站，不转发其他目的地。

认证脚本覆盖无/错/跨组凭据、第一页面、网站 401、popup、同源 iframe、WS、三类 Worker、CDP 断开触发 Job 清零。它尚不覆盖真实 HTTPS/WSS、跨站 OOPIF、认证缓存清除后 Worker 的首次挑战、真实两组 Chrome 同时运行及 WFP 端口抢占。不得把这些通过项扩大成完整认证门槛通过。

参考：[WFP 对象生命周期](https://learn.microsoft.com/en-us/windows/win32/fwp/object-management)、[ALE 重新授权](https://learn.microsoft.com/en-us/windows/win32/fwp/ale-re-authorization)、[Playwright 的 Worker Fetch 归属处理](https://github.com/microsoft/playwright/blob/main/packages/playwright-core/src/server/chromium/crNetworkManager.ts)、[同 renderer 的 locale 处理](https://github.com/microsoft/playwright/blob/main/packages/playwright-core/src/server/chromium/crPage.ts)。
