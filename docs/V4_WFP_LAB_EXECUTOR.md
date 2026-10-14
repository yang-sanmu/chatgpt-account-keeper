# v4 专用 WFP 实验执行器

2026-10-14。执行器与离线生命周期测试已实现，**尚未运行真实 WFP 安装、冻结或回收**。它用于 [M1-B 最小实验清单](M1B_MINIMAL_LAB_CHECKLIST.md)，不提供生产启动授权。用户目前没有专用 Windows 测试环境，日常主机上只运行离线测试。

## 输入与准备

输入必须由当前 `compileWfpResourcePlan()` 生成，格式为 `offline_wfp_resources / group_path_v1 / schemaVersion: 1`。禁止手工删改规则后当成完整保护策略。执行器做必要的结构、资源归属、两端冻结集合、文件/目录哈希和端口核对；它不是接收不可信客户端策略的服务，也不重新实现 JavaScript 编译器全部语义。原 `run/inspect/cleanup` 仍仅接受旧 v3 策略，两套命令不能混用。

先在测试机准备独立程序根目录、各组完整 Chrome 副本、每代 mihomo、测试 Agent 副本和根目录标记文件 `NETWORK_ISOLATION_LAB_ONLY`。所有登记程序必须位于根目录下。报告及回执保存到 Chrome 目录之外，实验期间冻结程序更新。完整布局和准入条件仍按 M1-B 清单执行，标记文件和命令行参数不证明这台机器是专用环境。

以下路径只是示例，不是当前主机上的已配置资源：

```powershell
$lab = (Resolve-Path tools/network-isolation/bin/Release/net10.0-windows/win-x64/publish/network-isolation-lab.exe).Path
& $lab v4-prepare C:\LabEvidence\resources.json C:\NetworkLab C:\LabEvidence\run-01.json
if ($LASTEXITCODE -ne 0) { throw 'Preparation failed' }
& $lab v4-test C:\LabEvidence\run-01.json
if ($LASTEXITCODE -ne 0) { throw 'Offline lifecycle tests failed' }
```

`v4-prepare` 不打开 WFP engine。它核对标记、实际程序 SHA-256、Chrome 全文件清单哈希和 IPv4/IPv6 TCP 端口范围/占用，生成随机 `runId`，将源资源与原生条件描述保存到一个新回执文件并刷新落盘。已有文件不覆盖。回执包含设备路径和用户 SID，应保存在受控证据目录；它没有签名，也不是授权凭证。文件写入中断后不使用残缺回执，改用新的输出文件重新准备。

`v4-test` 只运行内存后端，测试事务故障、生命周期及回收，不打开 BFE、不创建浏览器或代理。它允许原程序文件已经删除，用于验证回收逻辑依赖保存内容而非重新解析文件路径。测试成功不证明 Windows 接受这些规则。

## 仅在专用环境执行

完成 M1-B 清单第 2 节后，以管理员身份运行：

```powershell
& $lab v4-run C:\LabEvidence\run-01.json --isolated-lab
```

该命令要求 Windows 11 x64，重做文件与端口检查，然后在一个事务中安装持久 provider、sublayer 和全部默认拒绝。安装报错时中止事务，不采用已存在的资源；如错误发生在默认拒绝提交后，已提交的拒绝保留。随后建立动态会话，等待标准输入命令；此时尚无业务许可。

分组参数使用回执 `resources.groups[].key`，不能使用界面名称：

| 输入命令 | 行为 |
| --- | --- |
| `listen <group-key>` | 事务增加本组活动/候选入口的监听归属许可及登记 CDP 许可；不增加业务出口 |
| `activate <group-key>` | 确认全部默认拒绝及本组支持许可的内容/状态，事务增加 Chrome→本组入口、活动 mihomo→批准上游两条许可 |
| `freeze <group-key>` / `freeze-all` | 同一事务撤销指定组/全部组的两端业务许可，保留监听/CDP 供关闭使用 |
| `inspect` | 查询回执中每个对象的实际内容，输出 `matches / missing / mismatch` 及预期/实际值 |
| `quit` / 输入结束 | 关闭动态会话，持久默认拒绝继续保留，等待定向清理 |

程序不自动启动目标进程、管理 Job、迁移 Profile、查询有效令牌权限或验证实际监听者。测试人员须按清单先完成合成入口的允许/拒绝对照，再手动进入真实代理实验；不能因 `activate` 成功直接启动面向公网的无密码入口。当前只支持整轮实验回收，不提供单账号/CDP 或单个候选代次的热回收。

许可添加/删除失败时回滚该事务，命令失败会退出执行器并关闭动态会话；持久拒绝不会在异常处理里删除。输出的 `*-committed` / `*-removed` 只说明规则操作成功，不代表存量流已经阻断，也不代表进程已关闭。会话生命周期与事务处理依据 [Microsoft WFP 对象管理](https://learn.microsoft.com/en-us/windows/win32/fwp/object-management)，实际清理时长和重新授权效果仍须测量。

## 查询、退出与异常回收

另一个终端可运行只读查询：

```powershell
& $lab v4-inspect C:\LabEvidence\run-01.json
```

查询使用保存的 GUID 与原生内容，不需要程序仍存在。它核对 provider、sublayer、规则层/条件、动作、权重、标志和本轮 `runId`；不只比较数量。显示名称、系统分配 ID 和有效权重不作为身份条件。逐项查询不是跨对象原子快照，操作中的状态须在操作结束后复查；发现不支持的原生表示或访问失败时返回错误，不报告通过。

所有对象的 `providerData` 写入本轮 `runId`。同一资源键已存在时不能隐式接管；旧回执遇到不同标记或内容会拒绝删除。默认拒绝或 provider 的 disabled 标志使就绪检查失败；显式清理可删除只多出该标志、其它内容仍完全一致的本轮对象。Microsoft 的[对象生命周期说明](https://learn.microsoft.com/en-us/windows/win32/fwp/object-management)与 [provider disabled 标志说明](https://learn.microsoft.com/en-us/windows/win32/api/fwpmtypes/ns-fwpmtypes-fwpm_provider0)对未关联服务的 provider 在 BFE 启动时的表述有差异。本实验不安装服务，也不据此承诺重启后拒绝已生效；BFE/系统重启后的状态与实际阻断须单独验收。

正常退出或崩溃后，先关闭测试准入、确认原进程/Job 与连接清理，并删除不再使用的受保护副本或撤销其执行权限，再运行：

```powershell
& $lab v4-cleanup C:\LabEvidence\run-01.json --isolated-lab --processes-stopped --resources-retired
if ($LASTEXITCODE -ne 0) { throw 'Cleanup incomplete; retain receipt and inspect' }
& $lab v4-inspect C:\LabEvidence\run-01.json
```

两个确认参数由实验人员根据证据提供，**执行器不会自动证明进程或资源已退役**。仍有动态许可时拒绝清理；清理在事务内核对全部现存对象，按过滤器→sublayer→provider 顺序删除。容许已不存在的本轮对象以支持重复清理；内容不符、仍被未知资源引用或删除失败则回滚，不做全局重置。文件已经删除不妨碍回收；清理后所有登记对象应为 `missing`，另按 B07 验证端口与其它软件恢复。

`v4-run` 与 `v4-cleanup` 在回执旁持有排他 `.lock` 文件句柄，避免同一回执的运行和清理并发。空锁文件保留，进程退出会释放句柄，不要靠删除锁文件解除占用。完整回执须保留到回收验证结束；遗失回执不自动枚举删除其它资源，应恢复证据备份并人工核对。

## 本轮验证范围

新增 `test/v4Lab.integration.test.js`：使用临时合成文件检查回执落盘/拒绝覆盖、全文件与程序哈希、标记/冻结集合拒绝、命令确认参数，以及内存后端的安装/激活/冻结/清理故障回滚、CDP 保留、组间独立、动态会话丢失、disabled/内容不符、旧回执与文件删除后的回收。NativeAOT 发布及相关测试记录见[进度文档](NETWORK_ISOLATION_PROGRESS.md)。

这些测试没有 WFP 写入。B01–B07 仍未执行；真实优先级、回环、绑定/入站、存量流、服务崩溃/BFE 重启与其它防火墙共存都未验收。生产能力继续为 `M1_NOT_ACCEPTED`，所有报告保持 `productionReady: false`、`launchAuthorization: not_issued`。
