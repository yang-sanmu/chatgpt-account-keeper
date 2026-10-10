# 冷 WSS 认证阻塞与后续方案评估

原始评估日期：2026-10-08。2026-10-10 用户已接受“每组独立 Chrome 副本＋WFP”，该决定已写入 [v4 计划](BROWSER_NETWORK_ISOLATION.md)。新路线尚未实现或验收，严格模式仍不可用。

以下保留 2026-10-08 的源码证据、候选比较和原始建议，供追溯决策；其中“尚未选择”和“先做方案评审”等阶段性描述，以 v4 的已接受决定及实施顺序为准。没有修改旧实验失败结果。

## 证据与结论

全新测试 Profile 从 `about:blank` 发起第一个 WSS 请求时，有头和后台都没有收到 `Fetch.authRequired`；Chrome 报告代理认证失败，原型关闭该运行并确认 Job 清零。另一全新 Profile 先通过 HTTPS 完成认证，再返回 `about:blank` 连接同一 WSS 端点则成功。原始记录为 `artifacts/network-lab/cold-auth-gate.tap` 及 `matrix-GQwfD1/report.json`、`matrix-ANepr6/report.json`。两项冷认证验收仍为失败；预热对照通过不能替代它们。

随后按本机版本 `155.0.8059.40` 核对 Chromium 源码，得到以下调用关系：

1. [FetchHandler::Enable](https://github.com/chromium/chromium/blob/155.0.8059.40/content/browser/devtools/protocol/fetch_handler.cc) 创建的是 `DevToolsURLLoaderInterceptor`。安装 Fetch 成功不能证明 WebSocket 的独立握手认证也被接管。
2. [WebSocketConnectorImpl](https://github.com/chromium/chromium/blob/155.0.8059.40/content/browser/websockets/websocket_connector_impl.cc) 在未被浏览器扩展拦截的路径中，把空的认证处理接口传给网络服务；这里的 DevTools 调用用于附加请求头，不安装 Fetch 认证处理。
3. [WebSocketEventHandler::OnAuthRequired](https://github.com/chromium/chromium/blob/155.0.8059.40/services/network/websocket.cc) 在缺少该接口时返回空凭据。[WebSocket 流实现](https://github.com/chromium/chromium/blob/155.0.8059.40/net/websockets/websocket_stream.cc) 随后取消认证，并将代理 407 报告为握手失败。
4. [ChromeContentBrowserClient::WillInterceptWebSocket](https://github.com/chromium/chromium/blob/155.0.8059.40/chrome/browser/chrome_content_browser_client.cc) 的另一条路径由扩展 webRequest 机制控制。这不是多安装一个 CDP Fetch 客户端就会启用的路径。

据此，当前失败与 Chrome 的认证路径相符，不能把它当作已经证明可由 CDP 附加顺序或超时调整修复的问题。结论限于本版本、当前启动方式和已测场景，不宣称所有 Chromium 版本或所有认证方案都不可能支持冷 WSS。没有修改 Chrome 二进制，也没有向 Chromium 发布问题或上传任何 Profile。

下载核对的源文件在忽略目录 `artifacts/network-lab/chromium-auth-source/`，使用版本标签而非仅对照 main。三个关键文件的 SHA-256 为：

| 文件 | SHA-256 |
| --- | --- |
| `services/network/websocket.cc` | `0c2604938fae9646378c94870abb8011b9e211877e8ed98209983022842c04e1` |
| `content/browser/websockets/websocket_connector_impl.cc` | `84f5761315f2fe132561e7a2ff447700de03d2ac3fd16dd0037212392e708508` |
| `content/browser/devtools/protocol/fetch_handler.cc` | `93aca72fbba5bd11081ac0c281e15378af81b46f25bb3c732a2038c5062b791a` |

## 候选路径及取舍

| 路径 | 对冷 WSS 的意义 | 新成本与门槛 | 本轮判断 |
| --- | --- | --- | --- |
| 保持单 Chrome、纯 CDP Fetch | 本版本没有接到对应认证回调 | 调整连接数量、超时、暂停顺序没有补齐回调的证据 | 当前原型不通过 M1，停止产品接入 |
| 启动时先访问页面建立认证缓存 | 已有本地阳性对照能工作 | 依赖缓存存活；不能覆盖运行中失效或真正的第一次 WSS，也不能自动重发不确定业务 | 只作为对照，不作为修复 |
| 正式安装的 MV3 认证扩展 | Chromium 存在 WebSocket 扩展认证路径，可作为实验候选 | 每个 Profile 安装/更新、权限、首次就绪、Service Worker 休眠重启、凭据装载和撤销；还需验证 CONNECT 与 Worker 覆盖 | 先证明发行方式和最小实验，不能直接宣布可行 |
| 每组独立 Chrome 可执行路径，由 WFP 隔离本组入口 | 将分组边界从 Chrome 认证移到路径规则，理论上可避免依赖 Chrome 的代理密码回调 | 多份完整副本的磁盘/更新成本，换组路径与 Profile 兼容，精确双端规则及所有入站限制 | 是值得重新评估的无驱动备选；须另立方案并在专用 Windows 环境验收 |
| 公共无认证本地转发器代替 Chrome 认证 | 可转发 WSS | 若所有项目 Chrome 都能连接所有组转发器，配错端口仍会串组；给转发器设置上游密码不能证明浏览器所属组 | 不能作为当前分组隔离修复 |

[Chrome webRequest 文档](https://developer.chrome.com/docs/extensions/reference/api/webRequest)提供 `webRequestAuthProvider` / `onAuthRequired`，并支持 WebSocket 握手拦截；这只证明存在候选接口，不能替代本项目对代理挑战、跨组密码与新目标的实测。该路径还需要请求目标及发起方的权限，不能假定只授权回环代理地址就覆盖所有业务目标。

扩展发行也不能沿用旧自动化示例：官方 Chrome 从 137 起移除了 `--load-extension` 的加载能力，参见 [Chromium 官方公告](https://groups.google.com/a/chromium.org/g/chromium-extensions/c/1-g8EFx2BBY/m/S0ET5wPjCAAJ)。CDP 的 [ExtensionsHandler::LoadUnpacked](https://github.com/chromium/chromium/blob/155.0.8059.40/chrome/browser/devtools/protocol/extensions_handler.cc) 同样有额外加载权限检查，不能假定普通运行连接即可安装。本轮没有开启额外扩展调试权限、修改企业策略，或改用未经计划的浏览器发行版。

## 下一阶段的具体边界

建议先做一次方案评审，再投入替代原型。若接受每组完整 Chrome 副本的成本，优先评估路径隔离：它直接表达“本组 Chrome 只能连接本组入口”，减少认证缓存和扩展生命周期对分组边界的影响。这是基于当前证据的工程判断，不是 WFP 已通过的结论。

路径隔离方案至少需要明确以下变更：

1. 将共享严格 Chrome 改为每组受保护的活动路径；关闭更新、候选目录、辅助 exe 清单和产物验证必须按组或版本管理。不采用指向源安装目录的硬链接。
2. 若浏览器入口不再使用密码，必须用已经实测的 WFP 路径和端口归属限制替代认证边界；这直接变更 v3 的非空 `users` 规则，不能仅在现有编译器里放宽校验。WFP 未验证前不得启用此入口。
3. 再验证冷 HTTP/HTTPS/WSS、账号换组、原路径/组路径迁移及升级。A 组配到 B 入口必须在业务数据转发前被拒绝；日常 Chrome、错误路径及端口抢占也必须有阳性对照。
4. 继续保留 mihomo 上游限制、DNS 地址固定、关闭证明、协调器和恢复日志。不能因为不使用 Chrome 认证而删除这些门槛。

如果坚持共享一份 Chrome，则先明确可发行的扩展安装方式，再验证冷 WSS、错误凭据、网站 401、跨组端口、扩展失效和凭据轮换；凭据不写入可公开加载的脚本，不按收到的挑战去查询其他组密码。未完成最小验证前，不开发严格模式产品集成。

当前没有专用 Windows 测试环境，路径隔离和既有 WFP 两端约束均不能验收。后续可以继续做只读准备和独立诊断；本记录不授权在日常主机写入 WFP，也不自动切换到驱动或全局 TUN。
