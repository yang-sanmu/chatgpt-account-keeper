# 本地 Windows Tauri 检查流程

本地脚本只构建 Windows x64 NSIS 检查包，不上传 Release，也不能替代 macOS/Linux
原生构建、签名、公证和真机更新验收。

## 准备

- Node.js：版本见 .node-version
- Rust stable 与 MSVC C++ 工具链
- .NET SDK：只用于 tools/chrome-launcher，版本见 desktop/global.json
- Git
- 已生成的生产 Tauri updater 私钥

在当前 PowerShell 会话中设置私钥和密码。私钥可以给出离线文件路径或文件内容；生产密钥
必须加密，脚本会在任一变量缺失时停止。

~~~powershell
$env:TAURI_SIGNING_PRIVATE_KEY = 'D:\offline-backup\gpt-account-keeper-updater.key'
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = '<password>'
~~~

tauri.conf.json 中还必须已经内联对应公钥。脚本会拒绝 M5 占位符。

## 构建

五处 Tauri 版本一致后运行：

~~~powershell
.\scripts\build-local-release.ps1 -Version 0.2.2
~~~

脚本执行：

1. 检查工作树与 Tauri 五处版本。
2. 安装 Agent/前端依赖并构建 Windows chrome-launcher。
3. 默认运行 Node、React 和 Rust fmt/clippy/test 门禁。
4. 下载固定版本 Node/mihomo 并校验 SHA-256。
5. 生成 release-resources、Agent SBOM 和 SHA256SUMS。
6. 拒绝浏览器、旧管理页、调试符号与旧 Avalonia Desktop 混入资源。
7. 用私有 Node 对 staged Agent 做 IPC/SQLite 烟测。
8. 使用 Tauri 生成 NSIS 与 updater .sig，再按稳定文件名收集。

输出目录为 artifacts\local-tauri-win-x64-<版本>。

常用开关：

| 开关 | 用途 |
| --- | --- |
| -SkipTests | 仅在同一 commit 已经跑过全部测试时重打检查包 |
| -AllowDirty | 允许脏工作树；产物只可丢弃性检查 |

本地包会带 Tauri updater 签名，但不会做 Authenticode，因此目录中包含
UNSIGNED-win-x64.txt，不能通过远端 Draft 门禁。SmartScreen 的未知发布者提示属于该
本地检查包的预期行为。

正式发布始终使用 RELEASE_REMOTE.md。publish-windows-release.ps1 的 UploadDraft 模式
会明确拒绝本地单平台上传。
