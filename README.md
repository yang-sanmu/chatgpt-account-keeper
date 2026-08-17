# ChatGPT Account Keeper

ChatGPT 多账号的原生桌面管理与后台自动对话工具。每个账号使用独立的 Google Chrome Profile；管理界面是 Avalonia 原生窗口，不打开浏览器、不使用 WebView，也不监听 `localhost:5173`。

> Windows 原生 Alpha 已具备完整的首次迁移和主要管理流程。仓库仍保留旧 Express 管理页作为过渡兼容入口；正式 Windows 安装包只包含 NativeAOT Desktop、私有 Node Agent 和本地 IPC，不会包含旧管理页。

## 新架构

```text
GptAccountKeeper.Desktop
Avalonia 12 · .NET 10 NativeAOT · 托盘 · VeloPack
                    │
        Named Pipe / Unix Domain Socket
                    │
Keeper.Agent
私有 Node 24 · playwright-core · SQLite · 调度 · mihomo
                    │
           本机 Google Chrome
```

- 管理端：跨平台 Avalonia 原生窗口，编译绑定与 System.Text.Json 源生成，Windows 首发使用 NativeAOT。
- 后台端：独立的每用户 Agent；管理窗口隐藏到托盘后，自动对话、巡检和调度继续运行。
- 本地通信：Windows Named Pipe；macOS/Linux Unix Domain Socket。帧为 4 字节小端长度加 UTF-8 JSON，最大 8 MiB。
- 持久化：SQLite（WAL、外键、幂等命令回执）和平台用户数据目录；安装与更新不触碰 Profile/数据库。
- 浏览器：只使用本机真实 Google Chrome。未安装时返回稳定错误 `CHROME_NOT_FOUND`，不下载或回退 Chromium。
- 更新：VeloPack 从公开 GitHub Releases 检查；默认只提醒，安装前调用 Agent drain、SQLite checkpoint 和备份。

## 当前可用功能

- 账号新增、启用/停用、登录、明确强制重登、状态刷新和立即运行。
- 用对应账号 Profile 打开/关闭真实 Google Chrome。
- 自动调度启停、持久化与重启恢复；错过任务每账号最多补跑一次并增加抖动。
- 独立 Profile、账号锁、WAF/unknown 状态保护、Headless Chrome 身份覆盖。
- 原生侧栏对应八个独立页面：总览、账号、任务、分组与代理、会话、Profile、历史和设置。
- 账号搜索/筛选/编辑/删除，分组与代理管理，会话集编辑，Profile 扫描/清理/归档/永久删除，已删除账号历史和 Agent 设置均已接入 IPC v1。
- 旧 JSON/JSONL/Profile 到 SQLite 的原生预览、空间/运行锁检查、进度显示和校验式复制迁移；失败不修改旧数据。
- Agent 自行写入用户状态目录的脱敏诊断日志，不依赖 Desktop 输出管道；桌面断线会自动重连并在事件缺口后重新获取完整快照。

## Windows 开发

要求：

- Node.js `24.11.1`（见 `.node-version`）
- .NET SDK 10（见 `desktop/global.json`）
- 本机 Google Chrome

安装依赖并测试：

```powershell
$env:PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = '1'
npm ci --ignore-scripts
npm test
dotnet build desktop/GptAccountKeeper.Desktop.sln -c Release
```

发布 Windows x64 NativeAOT：

```powershell
dotnet publish desktop/src/GptAccountKeeper.Desktop/GptAccountKeeper.Desktop.csproj `
  -c Release -r win-x64 -o artifacts/desktop-win-x64
```

开发时直接启动原生 Desktop；它会从仓库向上查找 `src/agent/launcher.js`，用本机 Node 启动 Agent。安装包则从 `agent/runtime/node.exe` 启动私有 Node，用户无需安装 Git、Node、npm、.NET 或 Playwright 浏览器。

Visual Studio 打开 `desktop/GptAccountKeeper.Desktop.sln`，将 `GptAccountKeeper.Desktop` 设为启动项目并按 F5。内置的 Development 启动配置会使用独立的 `GptAccountKeeper-dev` 数据、IPC 和日志，不会连接或覆盖安装版数据。首次页面可选择“预览并导入旧项目”或“创建全新数据”；旧项目根目录和其中的 `profiles` 目录都可选择。

## Agent 与数据目录

Agent 可单独启动用于诊断：

```powershell
npm run start:agent -- --data-root C:\path\to\keeper-data
```

默认数据位置：

- Windows 数据：`%LOCALAPPDATA%\GptAccountKeeper\data`
- Windows Desktop 配置与引导：`%APPDATA%\GptAccountKeeper\desktop.json`、`bootstrap.json`
- Windows 缓存/状态：`%LOCALAPPDATA%\GptAccountKeeper\cache`、`state`
- macOS：`~/Library/Application Support/GptAccountKeeper`
- Linux：`${XDG_DATA_HOME:-~/.local/share}/gpt-account-keeper`

Desktop 是 Agent 的客户端，不直接写 SQLite、Profile、Chrome 或 mihomo。所有修改命令携带 UUID `commandId`，结果在 SQLite 中保留 24 小时，进程重启后重复提交也不会重复创建。

首次旧数据迁移可向 Agent 增加 `--legacy-root <旧项目目录>`。迁移在 staging 中构造并校验数据库，Profile 只复制、不移动，并排除 Chrome 运行锁；程序不会自动删除旧源码目录或旧数据。

## IPC v1

Canonical JSON Schema 位于 `contracts/ipc-v1.schema.json`（消息信封/共享类型）和 `contracts/ipc-v1.methods.schema.json`（所有方法输入/输出）。主要方法组：

- `system.hello/bootstrap/getActivity/prepareUpdate/shutdown`
- `accounts.*`、`browser.*`、`history.*`
- `groups.*`、`proxies.*`、`profiles.*`
- `conversations.*`、`scheduler.*`、`settings.*`、`operations.*`

登录、立即运行、状态刷新、代理与 Profile 长任务都返回 Operation；状态变化通过有序事件推送，Desktop 在断线、序号缺口或 Agent 实例变化后重新获取 bootstrap 快照。

## 发行与更新

`.github/workflows/windows-release.yml` 会：

1. 运行完整 Node 测试和真实 NativeAOT publish。
2. 下载固定版本的 Node 与 mihomo 并校验 SHA-256。
3. 使用 `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` 安装生产依赖。
4. 拒绝 Chromium、`ms-playwright` 和旧 `public/` 管理页进入产物。
5. 用私有 Node 对 staged Agent 执行 IPC/SQLite 启动烟测。
6. 将项目许可证、第三方声明、隐私和源码说明写入安装包的 `licenses/`。
7. 通过 VeloPack `GptAccountKeeper.Desktop` 打包。
8. 生成 SBOM、项目与 mihomo 对应源码归档，以及 `SHA256SUMS.release.txt`。

固定发行标识：

- 显示名：`ChatGPT Account Keeper`
- VeloPack Pack ID：`GptAccountKeeper.Desktop`
- Bundle ID：`io.github.yang-sanmu.gptaccountkeeper`

更新源是公开的 [GitHub Releases](https://github.com/yang-sanmu/chatgpt-account-keeper/releases)，客户端不含 GitHub Token。VeloPack 草稿不会被客户端看到，人工发布前应完成 N-1 → N 安装更新验收。

### 无签名发布

发行产物**不做 Authenticode 签名**。Windows SmartScreen 在首次下载或运行安装程序时可能提示"未知发布者"，用户需要点击"更多信息 → 仍要运行"；这对未签名软件是预期行为，不影响 VeloPack 自动更新（更新完整性由 `RELEASES` 中的 SHA 校验，与签名无关）。

每个 Release 附带 `SHA256SUMS.release.txt`，用户可据此核对下载。

如果以后配置了 `WINDOWS_SIGNING_CERTIFICATE_BASE64` 和 `WINDOWS_SIGNING_CERTIFICATE_PASSWORD` 两个 secret，工作流会自动改为签名打包并校验签名状态，发布流程本身不用改。

### 发布新版本

Windows 发布入口封装在 `scripts/publish-windows-release.ps1`。它要求当前 `main` 工作树干净且与 `origin/main` 一致，并把发布拆成三个显式阶段：

```powershell
# 1. 构建候选包并下载到本地做 N-1 → N 安装验收（不创建 Release）
.\scripts\publish-windows-release.ps1 -Version 0.1.2 -Mode Candidate

# 2. 验收通过后，构建正式包并创建 GitHub Draft Release
.\scripts\publish-windows-release.ps1 -Version 0.1.2 -Mode Release -NMinusOneVerified

# 3. 人工检查 Draft 中的安装包、完整包、更新清单、SBOM 与源码归档后公开
.\scripts\publish-windows-release.ps1 -Version 0.1.2 -Mode PublishDraft
```

使用 `-WhatIf` 可以只验证本地状态并显示将触发的操作。`Candidate` 不会创建 Release；`Release` 只创建 Draft；只有 `PublishDraft` 会使版本进入客户端的稳定更新通道。

## 过渡期旧入口

旧网页管理端暂时仅用于 REST/IPC 等价回归：

```powershell
npm run start:legacy
```

它会在 `127.0.0.1:5173` 启动旧 Express 页面，不属于最终安装包。生产 staging 脚本明确排除 `server.js`、`cli.js` 与 `public/`。

## 许可证、隐私与源码

Copyright © 2026 yang-sanmu。项目代码以 [GNU Affero General Public License v3.0 only](LICENSE) 发布。通过网络向用户提供修改版程序功能时，AGPL 第 13 条要求向这些用户提供相应版本的完整对应源码。

- [第三方组件与许可证](THIRD_PARTY_NOTICES.md)
- [隐私政策](PRIVACY.md)
- [对应源码与构建信息](SOURCE.md)

这些说明随安装包复制到 `licenses/`，也可在应用内"设置 → 关于与许可"打开。AGPL 不会把第三方组件改成 AGPL；Node.js、mihomo、Playwright、Avalonia 等仍各自遵循上游许可证。

本项目是非官方个人项目，与 OpenAI、Google 或其他服务提供方无隶属、赞助或背书关系。ChatGPT、OpenAI 和 Google Chrome 等名称仅用于说明兼容对象。

## 安全与限制

- Profile 包含 Cookie、Local Storage 与登录态，代理配置可能包含订阅 Token/密码；不要提交、分享或加入普通日志。
- 管理 IPC 以当前 OS 用户为信任边界。Unix Socket 权限为 `0600`；Windows 使用每用户命名管道，并在首次 hello 中验证一个 256 位随机凭据。凭据文件移除继承 ACL，只允许当前用户读取；无凭据的连接在任何业务调用前关闭。
- Headless 身份覆盖目前需要 Chrome DevTools Protocol，任务期间可能使用随机、仅回环的短生命周期 CDP 端口；它不是管理端口。
- 登录态只承诺同一机器、同一 OS 用户迁移；DPAPI、Keychain 或密钥环可能使跨用户/跨机器迁移需要重新登录。
- 自动化访问 ChatGPT 网页端可能违反服务条款并带来账号限制风险。本项目仅供个人学习与技术研究，使用风险自负。
