# 0.2.12 普通模式本地检查记录

日期：2026-10-14。分支：`codex/browser-network-v3`。本次完成普通模式代码与本地检查包收尾，未发布 GitHub Release。用户选择暂缓 WFP，更新签名私钥只存于 GitHub Actions。

## 交付范围

账号环境继承/固定、下一次启动生效、普通模式代理及两个付款直连例外保持可用。Tauri 与 Agent 配套使用 IPC 1.4、schema 7；Avalonia 不维护。严格能力仍为 `available: false / M1_NOT_ACCEPTED`，没有安装 WFP 服务、写入规则、迁移真实 Profile 或新增 TUN。

版本同步为 0.2.12，新增更新摘要。Windows Authenticode 从正常 Draft 的必需条件改为可选；正式 updater 签名、公钥、其它平台签名和人工更新验收要求保持。增加对应门禁回归，扩展 staged Agent 烟测和数据库备份恢复回归，修正 Rust IPC 文件的两处格式检查问题。

## 验证结果

| 检查 | 结果与边界 |
| --- | --- |
| 全量 Node，4 并发 | 714 项：703 通过、11 跳过、0 失败；日志 `node-tests.tap` |
| 全量前端 | 28 文件、240 项通过；TypeScript/Vite 构建通过 |
| Rust | fmt、clippy（warnings as errors）通过；141 项测试通过 |
| IPC 与版本 | 生成类型无漂移，五处 Tauri 版本一致 |
| 真实 Chrome 环境 | 显式开启后台/有头两项实验，首脚本、弹窗、Worker 的语言和时区均通过；只用临时 Profile 与本机测试页面 |
| staged Agent | 私有 Node 启动、IPC 1.4、SQLite、环境查询/保存/恢复继承、登录参数契约、正常关闭通过 |
| NSIS 产物 | 构建成功；提取后 1080 个资源文件哈希与原清单一致；文件版本 0.2.12；无 WFP 工具或 updater 签名 |
| 实际客户端启动 | 从 NSIS 提取的客户端使用隔离目录启动，确认随包私有 Node、IPC 1.4、环境读写和 schema 7；关闭所属客户端进程后 Agent 被 Job 回收 |
| 旧库升级与恢复 | 使用 main `9e6465e3b81e18afed5974076089bdb71c00c4c1` 的实际 v6 仓储代码创建与重新打开合成旧库；八类表升级后保持，旧版拒绝 v7，保留升级后副本，再恢复 v6 备份后旧版打开成功；合成 Profile 文件保持 |

Node 的跳过项包含需显式开启的实验集成；其中两项普通浏览器环境验证已单独补跑，不将其余跳过项算为通过。WFP、冷代理认证和各协议网络隔离验收仍未完成。

客户端包烟测验证的是进程启动与实际 IPC，不是界面逐项点击验收。退出回收用例终止了该次测试拥有的客户端进程；正常 Agent 关闭另外由 staged 烟测覆盖。本机未执行 NSIS 安装/卸载、托盘交互、真实付款或正式 updater 更新流程。

构建过程遇到本机 NuGet 的不可达旧内网源，使用官方源仅对 broker 本次 restore 完成依赖还原；没有修改全局源。NSIS 首次工具解压遇到拒绝访问，单独重试 bundle 成功，没有修改系统目录权限。测试夹具中一次错误地把 hello 的默认 schema 元数据当作实际库版本，已改为读取关闭后数据库的 `user_version` 验证；未为此改变产品行为。

## 本地产物与使用

产物在 `artifacts/ordinary-release-0.2.12/`：

- `gpt-account-keeper-0.2.12-win-x64-inspection.zip`：实际 NSIS 提取文件、隔离启动脚本及说明。
- `gpt-account-keeper-0.2.12-win-x64-inspection-setup.exe`：本次 NSIS 检查安装包，未在本机执行。
- `SHA256SUMS.inspection.txt`：以上两个文件的 SHA-256。
- `inspection.conf.json`：临时构建配置，使用 Inspection 产品名称/标识，仅关闭本次 updater 产物生成；生产配置继续 `createUpdaterArtifacts: true`。
- `desktop-smoke-result.json`、`rollback-result.json` 及测试日志：本轮证据。

先解压 ZIP，再在 PowerShell 中运行 `./Start-Inspection.ps1`。脚本只为子进程指定独立设置、数据和 WebView 目录 `inspection-user-data`，首次进入初始化界面；检查期间保留这个测试数据目录，不选择日常数据。检查包需要本机 Chrome，未捆绑浏览器。

直接运行 `extracted/keeper-app.exe` 或安装后使用普通快捷方式仍会使用默认账号数据目录。Inspection 名称只区分产品，不自动区分数据库。不得把本包用于正式更新源；它没有 `.sig` 和 `latest.json`，也没有生成替代密钥或修改生产公钥。

## 数据库回退说明

schema 6→7 自动备份位于数据目录的 `backups/keeper-v6-<时间>.db`。数据库恢复只回到备份时点，不合并升级后的新增数据。

1. 完整退出客户端、Agent 和受管浏览器，确认该数据目录没有写入进程。
2. 完整保留当前数据目录、数据库及可能存在的 WAL/SHM，不覆盖唯一的升级后数据副本。
3. 核对对应的升级前备份。在停机状态恢复该备份，不能把旧数据库与升级后的 WAL/SHM 混用；Profile 不删除或替换。
4. 使用配套旧客户端与 Agent 打开恢复后的库，核对账号、分组和历史。需要返回新版时使用此前保留的数据副本。

演练只证明合成数据库的升级与恢复；没有宣称对所有真实 Chrome 登录态或浏览器版本降级做过验收。

## 正式发布前

本轮本地检查范围已完成。正式版本仍需 GitHub Actions 使用原 updater 密钥生成四平台候选，按 [RELEASE_VERIFY.md](RELEASE_VERIFY.md) 完成安装、N-1→N 与 N→N+1 更新验证后再发布。Windows 不需要购买代码签名证书。WFP 专用测试环境只在恢复该功能开发时需要，不阻塞普通模式本地检查。
