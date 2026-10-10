# v4 分组资源离线模型

`src/network/groupPathPlan.js` 的 `compileGroupPathPlan()` 是 M1-A 的离线编译入口。它不读写文件、不启动 Chrome/mihomo、不调用 WFP，也没有接入生产启动路径。输出固定为 `kind: offline_group_path_plan`、`launchAuthorization: not_issued`；生产能力仍为 `M1_NOT_ACCEPTED`。这些标记是状态说明，不是防止外部程序擅自运行配置的权限机制。

## 输入与资源身份

入口只接受 `isolationModel: group_path_v1`，拒绝未知字段和旧策略格式。输入由安装登记信息和分组快照组成，不接受调用方指定的 Chrome/mihomo 可执行路径。

```js
{
  isolationModel: "group_path_v1",
  installationId: "00000000-0000-4000-8000-000000000001",
  programRoot: "C:\\Program Files\\GptAccountKeeper\\runtimes",
  registrations: [{
    userSid: "S-1-5-21-100-200-300-1001",
    dataDirectoryId: "00000000-0000-4000-8000-000000000002",
    groupId: "grp_a",
    chrome: {
      version: "155.0.8059.40",
      files: [/* 每个文件的 relativePath、sizeBytes、sha256；必须含 chrome.exe */]
    },
    proxies: [{
      generation: 1,
      role: "active", // 最多另有一个 candidate，且代次必须更大
      listenerPort: 23001,
      sha256: "...", // 64 位小写十六进制，示例占位符不能通过校验
      approvedAddress: "192.0.2.10",
      raw: { type: "http", server: "node.example", port: 443, tls: true }
    }]
  }]
}
```

身份使用不可变的用户 SID、数据目录登记 UUID 和分组 ID。程序目录按 `<programRoot>/<installationId>/<ownerKey>/<groupId>/` 生成，其中 `ownerKey` 是 SID 与数据目录登记 ID 的完整 SHA-256。这个摘要只用于命名，不是调用者认证或授权证明。活动 Chrome 位于 `chrome/active/chrome.exe`；各代理代次位于 `mihomo/<generation>/mihomo.exe`。账号 Profile 不进入此模型，不会被复制或迁移。

配置只给出 `userDataRelativeConfigPath`，须由后续服务相对于该身份已登记的数据目录解析；它不能相对于任意工作目录或程序目录落盘。不同数据目录可以有相同的相对配置路径，其身份和解析根必须同时校验。数据目录 UUID 到真实目录的登记、一用户/数据目录的 Agent 写入所有权和登录会话检查尚未实现。

模型拒绝重复身份、跨分组/用户/代次的入口端口冲突、无活动代次、多候选以及陈旧候选代次。端口检查只覆盖输入快照，未查询主机动态端口、保留端口或占用，也没有预留端口；后续服务必须合并完整登记表及待回收资源再做实际检查，不能用部分快照证明全局独占。

## 清单与路径检查的范围

程序根目录必须是本地盘符绝对路径。相对文件名和生成路径标识拒绝目录穿越、盘符/UNC/设备路径注入、ADS、DOS 保留名称、短名称写法、尾随空格或点及大小写冲突。清单必须含根目录的 `chrome.exe`，不能有文件/目录同名冲突，每个文件有非负安全整数大小和 SHA-256。所有 `.exe` 进入浏览器默认阻断资源清单，辅助程序不会自动得到主程序的访问许可。

这是对调用方提供的**清单数据**进行校验，尚未遍历真实目录或证明清单完整。返回的 `totalBytes` 是清单总量，`inventoryHash` 是版本与排序后文件清单的摘要，不代表签名、实际磁盘哈希或磁盘峰值。重解析点、硬链接、大小写/文件系统别名、ACL、来源签名、复制期间更新及磁盘容量必须通过后续只读预检查和服务侧锁定核对。单凭路径字符串符合格式不能证明目录受保护。

## 四项策略意图与配置草案

每个代次分别输出以下意图。这不是可加载的 WFP 过滤器，尚无层条件编译、优先级、事务或重新授权实现：

| 意图 | 草案内容 |
| --- | --- |
| `browserOutbound` | 清单内所有 Chrome exe 默认阻断；仅活动代次允许本组主程序和用户连接自己的精确 TCP 回环入口 |
| `entryClients` | 预留入口默认拒绝其它客户端；只列出本组主程序和用户，并记录 IPv4、IPv6、映射地址覆盖要求 |
| `listenerOwner` | 代理程序监听默认拒绝；只有指定程序和用户可绑定/监听/接收精确入口，同时要求拒绝其它程序使用预留入口及通配绑定 |
| `proxyOutbound` | 每个代理程序默认阻断；活动代次只列出固定上游地址、端口及实际传输协议的许可 |

候选代次的浏览器访问、入口客户端和上游放行集合均为空；它只保留声明的监听归属。候选探测通道尚未设计，不提供通用 Agent 转发例外。活动策略与候选策略中相同浏览器默认阻断资源应由后续策略编译器统一管理，不能把每一行机械转成独立 WFP 规则并推定优先级正确。

`proxyConfigDraft` 是独立的 v4 无密码配置草案：只有选定 `upstream`，入口固定 `127.0.0.1`，`users: []`，`MATCH,REJECT`，业务 DoH 经节点，禁用额外控制入口与 DNS fallback。复用已有上游适配器，继续拒绝跳过证书校验、XHTTP、外部插件及未经验证字段；保留固定 IP 前的 TLS/SNI/Host 语义。代理传输的 UDP 与浏览器业务 UDP 分开表达。

旧 `buildStrictProxyConfig()` 仍强制非空凭据；给旧接口附带新模型名不能绕过校验。草案可能包含上游用户名、密码或其它凭据，不能直接写入诊断报告、日志或界面。此次测试均使用合成节点；没有保存可运行的无密码配置或启动代理。

输出及嵌套对象均不可变，与输入对象分离。`active` 只表示期望的配置角色，不表示进程运行或规则已安装。`pendingChecks` 保留完整资源登记、调用者身份、真实文件/权限、磁盘、端口、WFP、Profile 锁、Job/监听归属、动态事务、CDP 及 M1 验收等待办条件；不能由前端提交布尔值消除这些门槛。

## 验证与下一步

`node --test test/groupPathPlan.test.js test/strictNetworkConfig.test.js` 共 20 项通过，覆盖身份与路径边界、跨组/代次冲突、候选默认阻断、辅助程序、七类上游编译、v3 认证兼容、证书校验和能力开关。本轮未修改现有运行路径，未重跑全量 Node、前端或 Rust；既有全量结果见进度记录。

下一步仍属于 M1-A：实现真实目录的只读清单核对、链接拒绝、容量峰值预览，以及新格式到 WFP 策略资源的编译与一致性检查。程序签名/ACL、端口和授权证据必须由管理侧产生。M1-B 的实际 WFP 四边界验证需要专用 Windows 测试环境；M1-C 再验证冷协议与路径迁移，不能从此离线模型推定网络保护通过。
