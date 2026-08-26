# Tauri 远端发布流程

GitHub Actions 在四个原生 runner 上构建 Windows x64、macOS arm64/x64 和
Linux x64，最后汇总为一个候选 artifact 或一个 Draft Release。本机只负责触发与真机验收。

## 首次启用

### 1. 生成并备份 Tauri 更新签名密钥

这套密钥与 Authenticode、Apple Developer ID、Minisign 都不同。私钥丢失后，已经安装
的客户端将永久无法验证后续更新。

在离线备份介质上选定目标路径，然后运行：

~~~powershell
cd app
npm run tauri signer generate -- -w D:\offline-backup\gpt-account-keeper-updater.key
~~~

使用强密码。完成后：

1. 将 CLI 生成/打印的公钥内容写入 app/src-tauri/tauri.conf.json 的
   plugins.updater.pubkey；公钥可以提交。
2. 将私钥文件内容保存为 Actions Secret TAURI_SIGNING_PRIVATE_KEY。
3. 将密码保存为 TAURI_SIGNING_PRIVATE_KEY_PASSWORD。
4. 私钥与密码分别离线备份并实际验证可以读取。不要把私钥放进仓库、.env 或发布资产。

工作流会在公钥为空或仍是占位符时于构建前直接失败。

### 2. 配置平台签名 Secrets

- Windows：WINDOWS_SIGNING_CERTIFICATE_BASE64、WINDOWS_SIGNING_CERTIFICATE_PASSWORD
- macOS：MACOS_APP_CERTIFICATE_BASE64、MACOS_P12_PASSWORD、MACOS_APP_IDENTITY、
  APPLE_ID、APPLE_APP_SPECIFIC_PASSWORD、APPLE_TEAM_ID
- Linux：LINUX_MINISIGN_SECRET_KEY_BASE64、LINUX_MINISIGN_PASSWORD、
  LINUX_MINISIGN_PUBLIC_KEY

同一平台的 Secrets 必须完整配置。缺失整组时仍可产出带 Tauri 更新签名的内部检查包，
但会生成 UNSIGNED-<rid>.txt，aggregate job 不允许据此创建 Draft。

## 每次发布

以下以 0.2.1 为例。

### 1. 同步版本并推送

Rust/Tauri 版本线独立于旧 C# 0.1.x。以下五处必须一致：

- app/package.json
- app/package-lock.json 顶层 version
- app/package-lock.json 的 packages[""].version
- app/src-tauri/Cargo.toml 的 package.version
- app/src-tauri/tauri.conf.json 的 version

~~~powershell
npm install --prefix app --package-lock-only --ignore-scripts
node scripts/verify-release-version.mjs 0.2.1
git add -A
git commit -m "chore: release 0.2.1"
git push origin main
~~~

### 2. 生成四平台候选

准备非空的 Markdown 更新摘要，然后运行：

~~~powershell
.\scripts\publish-windows-release.ps1 -Version 0.2.1 -Mode Candidate -ReleaseNotesFile .\release-notes-0.2.1.md
~~~

成功后，脚本把聚合 artifact 下载到 artifacts\candidate-0.2.1。Candidate 不创建 tag，
不创建 Release，也不会进入稳定更新源。

### 3. 候选安装与数据保留验收

按 RELEASE_VERIFY.md 完成四平台安装检查。至少覆盖 Windows NSIS、两种 macOS 架构、
AppImage、deb 和 rpm；用真实数据确认 Agent、Profile、SQLite、代理与历史均正常。

通过后创建 Draft：

~~~powershell
.\scripts\publish-windows-release.ps1 -Version 0.2.1 -Mode Release -NMinusOneVerified -ReleaseNotesFile .\release-notes-0.2.1.md
~~~

工作流只在 Authenticode、两种 macOS Developer ID + 公证 + stapling、Linux Minisign
全部通过时创建唯一 Draft。

### 4. 真实更新验收

Draft 还不会被 GitHub releases/latest 返回，因此不能把“Draft 已生成”等同于 updater
已验收。把 Draft 中的 updater 资产与 latest.json 原样放到临时 HTTPS 测试源，使用同一
生产更新公钥；用于 N 版验收的临时构建只通过 Tauri config overlay 把 updater endpoint
指向该测试源，不能修改发布资产或默认稳定 endpoint。然后完成：

- Windows：已安装 N 自动发现并升级到 N+1，NSIS 重启后数据完整。
- macOS arm64/x64：自动升级后应用显式 relaunch。
- AppImage：自动升级后应用显式 relaunch，原文件被正确替换。
- deb/rpm：检查更新返回“由系统包管理器升级”，且不请求 latest.json。
- AppImage：在干净 Ubuntu 22.04 和一台较新发行版各启动一次。

测试源只用于验收，不得复用另一套签名密钥，也不得修改已经签名的二进制。

### 5. 公开 Draft

确认 Release 页面资产完整且第 4 步通过后：

~~~powershell
.\scripts\publish-windows-release.ps1 -Version 0.2.1 -Mode PublishDraft -UpdaterVerified
~~~

该命令再次核对 Draft、版本和全部必需资产，然后公开并标记 latest。只有此时稳定客户端
才会从 releases/latest/download/latest.json 看到新版本。

## 必需资产

| 平台 | 安装/运行 | Tauri updater |
| --- | --- | --- |
| Windows x64 | NSIS setup.exe | 同一 exe + .sig |
| macOS arm64/x64 | 两份 DMG | 两份 app.tar.gz + .sig |
| Linux x64 | AppImage、deb、rpm | AppImage + .sig |

此外必须有：

- latest.json（只有 windows-x86_64、darwin-aarch64、darwin-x86_64、
  linux-x86_64-appimage 四个键）
- 四份 Agent CycloneDX SBOM
- 项目源码与对应 mihomo 源码归档
- Linux AppImage/校验清单的 Minisign 签名与公钥
- SHA256SUMS.release.txt

## 工作流关键门禁

.github/workflows/windows-release.yml 会：

1. 校验 Tauri 五处版本、非空更新摘要、公钥非占位符和 updater 私钥 Secret。
2. 下载固定版本 Node/mihomo 并校验 SHA-256；Windows 另构建 chrome-launcher。
3. 生成 Tauri release-resources，拒绝 Chromium、ms-playwright、旧管理页和 Avalonia
   可执行文件，随后用私有 Node 做 Agent IPC/SQLite 烟测。
4. 在 Windows、macOS arm64/x64、固定 ubuntu-22.04 上执行四次 tauri build。
5. 生成并验证 Tauri .sig；保留 Authenticode、Apple 公证/stapling 与 Minisign 门禁。
6. 从各 bundle 目录只收集唯一的本次产物，生成 latest.json、源码归档和总校验和。
7. Candidate 只上传 workflow artifact；Release 模式才创建 Draft。

不再保留“允许无签名并跳过人工验收”的直接公开工作流。
