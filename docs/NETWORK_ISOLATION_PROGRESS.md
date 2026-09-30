# v3 实施与验收记录

日期：2026-09-30。分支：`codex/browser-network-v3`。

**本次交付是独立环境管理和 M1 实验原型，不是完整 v3，也不是已经可用的严格网络保护。** 用户确认没有专用 Windows 测试机/虚拟机；没有在日常主机写入 WFP 策略，没有创建 TUN、改系统代理/路由/DNS，也没有迁移真实账号 Profile。`network.getCapabilities` 固定返回 `available: false / M1_NOT_ACCEPTED`。

## 已接入产品的环境管理

- schema 7 追加 `account_environments`；已有和新建账号默认继承，旧 DTO 不新增字段。固定配置保留账号语言、时区、版本；换组/删除组不清除固定值；恢复继承不删除 Profile。
- 环境修改校验语言标签和时区，使用 `expectedVersion` 拒绝冲突。每个浏览器保存不可变启动快照，页面查询显示当前运行值、下次使用值和待生效状态，不改已打开窗口。
- 继承继续使用既有分组手动/自动探测逻辑；探测失败的本次回退到系统值，查询标明来源，失败不被永久写成固定配置。
- 修复 broker 后台启动没有应用地区时区的问题；有头/后台启动均在首次业务导航前安装环境设置。语言同时使用 Chrome 参数及原生 CDP locale 设置；不新增 Canvas/WebGL/字体/音频伪造。
- 账号详细配置新增环境面板，可保存固定配置或显式恢复继承。详情每 2 秒查询、失败退避至 30 秒，多卡片串行查询，隐藏到托盘停止业务查询。显示两个既有付款直连域名以及严格保护暂不可用。
- IPC 升至 1.4，新增 `environments.get/update/reset` 与 `network.getCapabilities`。没有注册尚未实现的网络变更/恢复/诊断接口；不返回虚构的 Operation 或“已阻断”。全局事件流及旧错误 envelope 保持不变。
- 升级数据库在 Agent 启动、运行写入开始前 checkpoint 并创建一致性备份；未指定备份目录时使用数据库旁的 `backups`。回退程序需要停机恢复备份，不自动覆盖数据库。

## 已实现的 M1 原型

| 项目 | 当前实现 | 验收边界 |
| --- | --- | --- |
| 严格配置编译器 | 选定节点、数值上游地址、保留 SNI/WS Host、随机入口凭据、非空 users、MATCH,REJECT、DoH 经 upstream、拒绝未知端点配置 | 未接入生产代理管理；未验证真实外部协议/DNS |
| CDP 认证处理 | 固定入口/凭据快照，只应答匹配的 Proxy 挑战，错误挑战和断连触发关闭 | 本地 HTTP/WS 及 Worker 已测；完整矩阵未通过 |
| Chrome 启动参数 | 两条参数生成路径允许精确的 resolver 规则；严格参数构造器移除隐式回环绕过 | 普通模式不加严格参数；无 WFP 时不宣称禁止直连 |
| WFP NativeAOT 工具 | 独立 provider/sublayer、持久化默认拒绝、动态会话双端放行/撤销、绑定归属规则、事务与显式清理 | 仅构建和无写入自检通过，未在任何主机安装或实测规则 |
| Chrome 路径实验 | 完整复制安装目录；同一全新测试 Profile 先原路径重启，再副本路径重启 | 合成登录 Cookie/LocalStorage/IndexedDB 保留；v10 Cookie 不覆盖应用绑定加密迁移 |

原型使用现有 broker 的 Job 管理实验 Chrome/mihomo；它不是正式的每组代理生命周期管理器。实验发现 mihomo 标准输出会进入现有 Chrome broker 的协议输出流，生产接入前必须提供独立的受控输出通道；不能把实验的日志静音当成修复。

## 实际测试与发现

测试环境：Windows 11 x64 日常主机，仅执行普通本地测试；Google Chrome 155.0.8059.12、mihomo 1.19.29、Node 24.11.1、.NET 10。Chrome 副本主程序 SHA-256：`da88af71525f25fc28a34909b93ea06e72cc65307d90ec0abfccd1202e459efa`。这只是实验版本证据，不是发行白名单。

1. 两种 Chrome 模式均通过本地认证：无密码、错密码、A/B 组错误凭据不向上游转发；正确凭据阳性对照能访问；首导航、网站 401、popup、同源 iframe、WS、dedicated/shared/service Worker；CDP 断开触发 Job 清零。测试上游只转发本测试的回环源站。
2. 专用 Worker 不支持直接调用 `Fetch.enable`，最初原型因此关闭浏览器。修正为有明确父目标的 Worker 复用父页面拦截；无法确认已安装认证的父目标则拒绝恢复 Worker。两种模式复测通过。
3. 同 renderer 的 popup 重复设置 locale 会返回精确的 “Another locale override is already in effect”；按 Chromium/Playwright 的共享 renderer 语义处理，仅忽略该特定错误。页面最早脚本、popup 和 Worker 的语言/时区在真实 Chrome 中复测通过。
   认证请求清理使用 Network 事件时还发现：暂停中的 Service Worker 可能等恢复后才确认 `Network.enable`。现先装 Fetch，随后按顺序发送观察与恢复命令并共同等待，修正启动死锁；新增回归及有头/后台实测均通过。
4. 新建测试 Profile 的原路径重启和复制路径重启均保留 Cookie、Local Storage、IndexedDB 和合成登录。Cookie 密文前缀为 `v10`，**没有**验证应用绑定加密 `v20` 或真实账号迁移。前一运行完全结束后清理实验 Profile 中残留的 `DevToolsActivePort`，避免读取旧端点。
5. NativeAOT 发布及 `selftest` 通过；自检只验证 ABI、路径约束、资源键，不调用 WFP 写入 API。
6. 环境持久化、版本冲突、命令重放、换组/删除组、恢复继承、v6→v7 备份和旧账号默认值测试通过；IPC 参数/结果 schema 校验通过。
7. Node 全量回归第一次仅有旧 IPC 版本断言失败，更新断言后真实 Agent 与 minor 3 客户端兼容及关闭回归通过。Rust 全量 141 项测试通过，包含 1.3 客户端连接 1.4 Agent、新 1.4 客户端拒绝 1.3 Agent，以及旧 Agent 在 hello 阶段直接返回错误时的配套升级提示。前端构建和 28 个文件中的 239 项测试通过，覆盖环境保存/恢复、隐藏窗口停止查询、跨卡片串行查询。IPC 生成文件一致性和 diff 空白检查通过。
8. 最后一轮 Node 全量结果：642 项，634 通过、7 跳过、1 取消（`browserIdentity.integration.test.js` 的既有跨目标身份用例并行运行超过 120 秒）。超时后测试进程仅剩本地测试服务器，按已核验的 PID/父 PID/测试命令终止该测试进程，让报告收敛；没有终止日常浏览器。该文件单独重跑 2/2 通过（约 11 秒）。这是仍需关注的并行测试超时，不能记为全量无条件通过。原始结果保存在 `artifacts/network-lab/node-regression.tap`。

脱敏原始报告位于忽略目录 `artifacts/network-lab/*/report.json`，成功项由 `passed` 和 `checks` 指示；早期失败报告保留用于对照。故意断开 CDP 的成功测试也会记录预期的 `PROXY_AUTH_BARRIER_FAILED`，不能据此误判测试失败。测试文件不包含真实账号或订阅凭据。

## 未通过的门槛与后续顺序

**M1 仍未通过，暂停严格模式产品集成。** 尚缺：

- 独立 Windows 环境中的 WFP 双端约束、绑定条件与优先级、既有流重新授权、缓冲上传冻结、动态会话崩溃清理、VPN/IPv6/休眠/端口抢占与资源循环实测；NIC 抓包不能独自证明回环或其它虚拟路径。
- 实际应用绑定加密 Profile 的路径迁移/升级兼容证明，Chrome 辅助进程及更新路径的完整覆盖。
- HTTPS CONNECT/WSS、跨站 OOPIF、认证缓存清除后 Worker 首次挑战、两个真实 Chrome 分组并发等完整认证矩阵。
- 上游协议的真实连接集合与 TLS/SNI/Host 验证。目前只有本地 HTTP 上游跑通；AnyTLS、Hysteria2、TUIC、VMess/WS、HTTPS、SOCKS5 的编译器测试不算兼容验收。VLESS/XHTTP 当前明确拒绝，待适配和实测；不影响普通模式。

M1 通过后才实施：受限身份 Windows 服务与安装器、受保护运行目录和产物校验、跨用户/会话管道认证、每组运行代次及回收、DNS 固定地址管理、统一变更协调器、强事务日志和崩溃恢复、其余 network IPC、严格模式界面、完整自部署诊断服务及 M4 发行验收。这些功能本次未实现，不应通过能力开关对用户开放。

在测试环境可用之前，可继续完善不写系统策略的协议适配和实验用例；不得以环境管理已通过为由取消网络门槛，也不得改走全局 TUN 或自动转入驱动开发。实验准备及操作见 [WFP 实验说明](../tools/network-isolation/README.md)，完整目标见 [v3 计划](BROWSER_NETWORK_ISOLATION.md)。
