# 浏览器环境与网络隔离改进计划 v3

本版替代 v2；实施中。M1 未通过不得开放严格保护。实施证据见 [NETWORK_ISOLATION_PROGRESS.md](NETWORK_ISOLATION_PROGRESS.md)。

## 产品与范围

每账号独立 Profile、每分组指定出口，单账号独享出口通过单账号分组实现；节点不同不保证公网 IP 不同。环境/基础诊断覆盖现有平台，严格保护首版 Windows 11 x64。新旧分组默认普通模式，严格模式显式开启；组件失效/节点缺失则阻断，不降级。

普通模式保留 gw.alipayobjects.com、sv.creditcard.ecitic.com 两个付款直连例外并展示；不新增第三模式。严格模式取消例外，切模式先关闭浏览器。不创建 TUN、不修改系统代理、默认路由和全机 DNS。Chrome 禁外部直连/UDP，代理协议必要 UDP 单独放行。

威胁模型是正常应用误配置、故障、意外绕过，不抵抗管理员/恶意软件/不可信上游，不承诺完全替代指纹浏览器或零风控。取消卡死5秒冻结/休眠立即失效硬要求；原规则持续约束，控制失联不批准新启动/配置提交。

## 受管运行时、WFP 和认证

同一数据目录严格分组共享项目专用 Chrome，账号仍独立 Profile；普通/日常 Chrome 原路径。完整复制本机 Chrome，不改二进制/不硬链接。固定活动路径，候选暂存，更新先预览并关闭所有使用该副本的实例。路径变更的 Cookie、Local Storage、IndexedDB、登录态兼容是 M1 门槛；应用绑定加密失败不关闭加密/清空 Profile/冻结安全更新。

每组独立 mihomo 进程、路径、配置、端口、随机凭据，候选新代次。Chrome/mihomo 当前用户运行，由 broker Job 管理。沿用4浏览器，代理空闲60秒回收，每组最多额外1候选。

新增 .NET NativeAOT 服务和提权安装器，首选系统 WFP，无自研驱动。管理员保护程序目录、签名安装产物/固定哈希校验，凭据配置保留用户边界。受限服务身份和 Service SID，安装器授予 WFP 权限；管道验证用户/会话/Agent与broker归属，只提供登记、应用、冻结、查询、释放，不提供任意命令/路径/进程控制。

持久化默认阻断、动态会话放行，阻断不依赖服务存活；WFP事务和私有sublayer权重验证，不覆盖其他防火墙阻断。Chrome仅可访问已登记严格入口与必要控制连接，禁止整段回环放行。每组mihomo仅可访问批准上游IP/端口/协议。入口绑定限定归属，冲突换端口不杀其他软件，释放前清理进程/连接。BFE/规则/组件状态不明拒绝启动；用户/会话/数据目录授权隔离。

凭据绑定账号组/入口/版本启动快照，不能按挑战端口查询其他组密码。listener users必非空，空列表代表免认证必须拒绝。CDP有头/后台统一安装，只应答预期Proxy挑战，不把代理密码交给网站Server挑战。初始化完成才业务导航，认证失败/CDP异常关闭实例。验证页面、iframe、Worker、CONNECT、WS、缓存、断连。轮换/换组/端口复用先关旧实例，密码更新不代表连接撤销。认证在公网转发前拒绝错误凭据，不承诺操作系统逐账号隔离。

## 配置与故障

受控模板只含选定上游，内部名upstream，listener显式指定，兜底MATCH,REJECT，无业务DIRECT/其他节点回退。两种Chrome启动路径验证 --host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1，数值回环、保留WebRTC原生偏好、取消付款bypass，WFP限制隐式回环。

业务DNS默认 https://1.1.1.1/dns-query#upstream，无直连fallback/H3优先。管理侧只解析节点域名，固定批准IP并保留TLS校验/SNI/Host；mihomo无额外公网bootstrap DNS放行。多IP候选验证，运行新地址不得自动扩大规则，替换经过协调器。

协议矩阵覆盖现有AnyTLS、Hysteria2、TUIC、VLESS/XHTTP、VMess/WS，以及HTTP/HTTPS/SOCKS5。逐类验证完整连接集合；不确定端点的链式、插件、跳端口、额外下载端点严格模式不支持，普通保持兼容。

冻结Chrome到入口和mihomo到上游两端，包含代理缓冲数据；WFP事务/重新授权证明阻断，BrowserRun/Job证明进程关闭，分别记录，已越界数据不可撤回。动态会话在服务退出后清理，实测时限不虚构保证。卡死允许原批准链路继续，禁止新启动/配置提交，显示控制异常而非已阻断。休眠复核规则/组件/版本，不扩大权限。不周期探测chatgpt.com；健康依据进程、规则、实际错误，公网诊断用户触发，不重发结果不确定的付款/对话。

## 协调、环境、迁移与 IPC

NetworkChangeCoordinator覆盖节点、订阅、启停、组绑定/删除、账号换组、模式、受管更新：
1. 预览活动实例/版本，明确关闭并应用。
2. 预留资源并关闭准入，重叠RESOURCE_BUSY。
3. 原子持久化commandId/operationId/回执/prepared日志，才执行外部动作。
4. 撤销排队许可、冻结两端、关闭Chrome、Job清零、清理代理。
5. 准备候选，失败清理并保持暂停。
6. SQLite事务提交配置/版本/阶段，发布映射、清旧资源、开放准入。

阶段prepared/frozen/drained/candidate_ready/committed/completed/failed；DB事务不跨外部等待，不持有关闭回调锁。OperationRegistry仅显示，独立强日志负责恢复；写失败停止，回执过期也不重放。恢复未提交保留旧配置、已提交用新配置，均回收遗留实例并保持暂停待明确恢复。close_failed不释放隔离/提交。旧修改接口影响活动受保护资源写库前RESOURCE_BUSY，其他修改也协调/检查版本。

环境继承分组为新旧默认，保留自动探测/手动设置，换组下次启动继承；账号固定保存语言/时区，出口/换组不改，reset恢复继承不删Profile。运行不可变快照，修改下次生效并显示。探测失败本次系统值并标明来源，后续重试。保留窗口/视口/实际UA，不做设备特征伪造或风控评分。

schema v6后追加环境/策略/配置版本/强日志/诊断，旧默认不变；迁移前停写/checkpoint/一致性备份。回退停机恢复配套备份，不覆盖最新数据/Profile。

IPC1.4：environments.get/update/reset；network.getCapabilities/getState、previewChange/applyChange、setGroupPolicy/resumeGroup、runDiagnostics/getDiagnostics。旧DTO/envelope/seq/revision不变，不过滤全局事件，commandId和版本校验。详情/操作2秒查询，其余活动界面10秒，托盘停止，单类1在途，失败退避30秒。Desktop/Agent配套；旧客户端连新Agent兼容，新连旧明确拒绝并提示升级。本机保护、控制异常、公网结果分开。

## 验收与阶段

专用Windows测试环境/测试Profile，不解除真实账号保护做对照、不真实付款。覆盖：基线直连/DNS/UDP；首包/多组/日常Chrome；错凭据/A到B/空users/401/Worker/WS/缓存；端口抢占/复用；DIRECT/漏listener/DNS fallback/缓冲；八类协议/SNI/Host；崩溃/卡死/休眠/VPN；并发/各日志阶段崩溃/磁盘失败/重放；环境换组/更新/登录态；权限/多用户/IPC/升级卸载/SecureBoot/HVCI；四浏览器100次开关资源回收。

pktmon、WFP规则/审计、系统DNS为早期证据，记录范围与阳性对照，无日志/无UDP不单独证明通过。M3交付自部署HTTPS回显/权威DNS/受限DoH/STUN，随机标识、不传账号凭据，本地7天远端15分钟，未配置为未验证。

| 阶段 | 交付 | 初估 |
| --- | --- | --- |
| M0 | 基线/协议/权限/路径兼容初验，签名资格并行核查 | 3–5人日 |
| M1 | WFP/两端/端口/认证/存量流/路径兼容原型 | 10–15人日 |
| M2 | 代理/协议/DNS/协调器/强日志/恢复/迁移 | 12–20人日 |
| M3 | 环境/UI/IPC/诊断/自部署端点 | 8–12人日 |
| M4 | 安装发行/兼容/资源/恢复验收 | 5–8人日 |

单名熟悉项目工程师38–60人日另25%缓冲，M1后重估，不含驱动/审批。M1有缺口即停止严格产品集成并给复现，不自动全局TUN/放宽回环/关闭安全功能/上驱动。必要缺口有证据后另立方案，独立验证的环境/诊断可交付。

用户确认没有专用Windows测试机/虚拟机；不把修改宿主机WFP作为实机验收替代。证据齐备前严格模式不可用。
