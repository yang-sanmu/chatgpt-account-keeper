# Tauri 发布验收

自动测试只能证明构建、契约和 staged Agent 可运行；安装布局、更新器重启和真实 Profile
必须在原生系统上验收。发布分为 Draft 前的候选安装检查，以及公开前的真实更新检查。

> 发布者已针对 `v0.2.3` 明确接受平台未签名、不下载候选到本地以及跳过本页验收的风险；
> 该一次性例外不计作本页任何门禁通过，也不能用于其他版本。

## 一、候选安装与数据保留

先准备一份有真实数据的安装：

- 至少两个账号，其中一个有真实 Chrome 登录态
- 一个分组、一个代理节点、一个会话集
- 至少一条运行历史
- 调度启停状态与应用设置

记录升级前数据并备份数据根。不要用“空库能启动”代替真实数据检查。

### Windows x64

1. 安装现有 N，再直接运行候选 NSIS 覆盖安装；不要先卸载。
2. 确认 currentUser 安装不要求管理员权限。
3. 确认 Agent 被安全排空、安装后客户端重启并重新连接。
4. 检查账号、Profile 登录态、分组、代理、会话集、历史和调度状态。

### macOS arm64 与 x64

每种架构各用对应 DMG 安装一次：

- Gatekeeper 不报损坏；Developer ID、notarization 与 stapling 均有效。
- 架构匹配，不依赖 Rosetta 代替另一种构建。
- Agent、私有 Node、mihomo 与原生 SQLite 能启动。
- 退出、重启和自启动行为正常。

### Linux x64

- AppImage 在干净 Ubuntu 22.04 与一台较新发行版各启动一次。
- deb 在 Debian/Ubuntu 系安装一次；rpm 在 RPM 系安装一次。
- 三种包都能找到随包 Agent、私有 Node 和 mihomo。
- deb/rpm 的“检查更新”明确显示由 apt/dnf 管理，且不发起更新请求。

候选安装全部通过后，才可用 -NMinusOneVerified 创建 Draft。

## 二、真实 Tauri N → N+1 更新

必须使用与生产相同的 updater 公钥、签名私钥和最终产物。Draft 资产不会出现在 GitHub
releases/latest，因此应把 Draft 的 latest.json 与 updater 文件原样放到临时 HTTPS
测试源，不要重新签名或改写二进制。

分别验证：

| 平台 | 必须观察到的结果 |
| --- | --- |
| Windows NSIS | check → 预检 → 下载 → Agent 排空/退出 → 安装 → NSIS 重启 |
| macOS arm64/x64 | 安装返回后客户端显式 relaunch，版本与数据正确 |
| Linux AppImage | 当前 AppImage 被原位替换，权限保留，随后显式 relaunch |
| deb/rpm | 不进入 updater 下载/安装流程 |

更新前故意保留一个运行任务或 Chrome 窗口，确认预检阻塞且尚未下载；清空阻塞后再执行。
下载完成进入排空阶段后不可取消。更新完成逐项检查：

- 数据库迁移账本无 checksum/schema 错误
- 账号数量、备注、启用状态不变
- Profile 与登录 Cookie 保留
- 分组、代理、会话集、历史与调度状态不变
- Agent 自动重启并能运行一次核心任务
- licenses 目录包含项目/第三方许可、隐私与源码说明
- 界面版本为 N+1，日志中没有 IPC、资源根或数据库错误

Windows、两种 macOS 架构和 AppImage 全部通过后，公开 Draft 时必须显式传入
-UpdaterVerified。

## 三、失败处理

Draft 尚未公开时，删除 Draft 与 tag，修复后换新版本重新构建：

~~~powershell
gh release delete v<版本> --repo yang-sanmu/chatgpt-account-keeper --yes
git push origin :refs/tags/v<版本>
git tag -d v<版本>
~~~

已经公开时先改回 Draft，使其退出稳定 latest：

~~~powershell
gh release edit v<版本> --repo yang-sanmu/chatgpt-account-keeper --draft=true
~~~

已经升级的客户端不会自动降级，必须发布更高版本修复。Agent 会拒绝旧程序打开更新过的
数据库，因此验收重跑应恢复备份或从干净数据根重新开始，不要直接降级覆盖。
