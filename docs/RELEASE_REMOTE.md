# 远端发布流程（GitHub Actions）

用 GitHub Actions 在原生 runner 上同时构建 Windows x64、Linux x64、macOS arm64/x64，并汇总到同一个 Release。本机只负责触发和验收。脚本名 `publish-windows-release.ps1` 为兼容旧调用保留，实际触发的是四平台工作流。

如果 job 无法启动并提示账号或额度问题，需要先恢复 Actions；[本地 Windows 检查流程](RELEASE_LOCAL.md) 不能生成 macOS/Linux 正式产物，也不能替代本流程。

## 准备

只需一次：

```powershell
winget install GitHub.cli
gh auth login
```

## 完整流程

以发布 `0.1.5` 为例。四条命令里的版本号必须一致；候选和正式构建还必须使用同一份 Markdown 更新摘要，该摘要会同时显示在客户端更新弹窗和 GitHub Release 中。

### 1. 改版本号并推送

三处必须一致，脚本会校验：

- `package.json` 的 `version`
- `package-lock.json`（用下面的命令同步，不要手改）
- `desktop/src/GptAccountKeeper.Desktop/GptAccountKeeper.Desktop.csproj` 的 `<Version>`

```powershell
# 改完 package.json 和 csproj 后
npm install --package-lock-only --ignore-scripts
git add -A
git commit -m "chore: release 0.1.5"
git push origin main
```

必须先推送。二进制里嵌的是 HEAD 的 commit，只有工作树干净且与 `origin/main` 一致，`SOURCE.md` 承诺的"tag 源码树可复现该二进制"才成立。

### 2. 构建候选包

先创建 `release-notes-0.1.5.md`，只写面向用户的本次变更，例如修复、改进和必要的升级提醒。文件不能为空。

```powershell
.\scripts\publish-windows-release.ps1 -Version 0.1.5 -Mode Candidate -ReleaseNotesFile .\release-notes-0.1.5.md
```

触发四个平台 job 并实时跟踪日志，跑完才返回。成功后汇总产物平铺下载到 `artifacts\candidate-0.1.5\`，包括安装包、四个 VeloPack 更新通道、签名、SBOM、源码归档和校验和。

这一步**不打 tag、不创建 Release**，只为验收提供安装包。

### 3. N-1 → N 验收（手动）

这是公开发布前唯一的人工闸门，不要跳过。完整清单和原理见 **[N-1 → N 验收](RELEASE_VERIFY.md)**。

简版：在每个已有线上版本的平台上安装 N-1 → 造出真实数据（账号、登录、跑一次任务）→ 用候选目录里的对应安装包/AppImage/DMG 升级 → 确认账号、Profile、登录态、历史、代理都在，Agent 正常重启。首次增加的平台至少完成全新安装、退出重启、自启动和更新源检查。

### 4. 创建 Draft Release

```powershell
.\scripts\publish-windows-release.ps1 -Version 0.1.5 -Mode Release -NMinusOneVerified -ReleaseNotesFile .\release-notes-0.1.5.md
```

`-NMinusOneVerified` 是强制的，不带这个开关脚本会拒绝执行 —— 它的作用就是挡住跳过第 3 步。

只有四个平台全部构建成功、N-1 验收已确认，且 Authenticode、Apple 公证与 Minisign 凭据全部配置时，这一步才会打 tag 并创建 **一个 Draft Release**。任何 `UNSIGNED-<rid>.txt` 标记都会阻止创建 Draft。

### 5. 公开

先在 Release 页面人工确认下列资产组齐全：

| Asset | 用途 |
|---|---|
| Windows `Setup.exe`、Portable.zip、full.nupkg | Windows x64 安装与更新 |
| 两组 macOS `Setup.pkg`、Portable.zip、DMG、full.nupkg | Apple Silicon 与 Intel 安装/更新 |
| Linux AppImage、`.minisig`、full.nupkg | Linux x64 运行与更新 |
| `releases.win.json`、`releases.osx-arm64.json`、`releases.osx-x64.json`、`releases.linux-x64.json` | 四个隔离更新通道 |
| 四份 `*.spdx.json` | 各 RID SBOM |
| `chatgpt-account-keeper-<版本>-source.zip` | 项目对应源码（AGPL） |
| `mihomo-v<版本>-source.zip` | mihomo 对应源码（GPL-3.0 强制） |
| `SHA256SUMS.linux-x64.txt`、`.minisig`、`minisign.pub` | Linux 独立签名材料 |
| `SHA256SUMS.release.txt` | 全部资产总校验和 |

然后：

```powershell
.\scripts\publish-windows-release.ps1 -Version 0.1.5 -Mode PublishDraft
```

脚本会再核对一遍 asset 齐全、确认是 Draft 且非 prerelease，通过后转正并标记 `--latest`。

**只有这一步会让版本进入客户端的稳定更新通道。**

### 维护者明确要求跳过人工验收或签名时

正常流程仍应使用上面的签名门禁。如果维护者明确接受无签名产物并要求跳过 N-1 人工验收，可将一次已经成功的四平台 Candidate run 直接提升为公开 Release：

```powershell
gh workflow run publish-existing-candidate.yml `
  --repo yang-sanmu/chatgpt-account-keeper `
  -f version=0.1.5 `
  -f source_run_id=<成功的 run id> `
  -f allow_unsigned=true `
  -f skip_n_minus_one_verification=true
```

该例外流程会再次校验来源 run、四平台资产和聚合 SHA-256，先上传为 Draft 并核对资产数量，再公开。Release 说明会明确标注未签名/未公证及跳过 N-1 验收，不会把例外发布伪装成通过正式门禁。

## 注意事项

- **先干跑**：任何阶段都可以加 `-WhatIf`，只验证状态并显示将执行的操作，不实际执行。
- **同一版本号只能发一次**：脚本会检查 tag 和 Release 都不存在。重发必须换版本号。
- **候选目录不能已存在**：重跑第 2 步前先删 `artifacts\candidate-<版本>\`，或用 `-CandidateOutputDirectory` 指定别处。
- **更新摘要必须一致**：Candidate 和 Release 都通过 `-ReleaseNotesFile` 传入非空 Markdown；正式构建不要临时换另一份内容。
- **不需要手动 push tag**：tag 由第 4 步自动创建。工作流只接受手动触发（`workflow_dispatch`），推 tag 不会触发构建。
- **仓库不是默认的**：加 `-Repository <owner>/<repo>`。

## 仓库签名配置

正式 Draft 需要以下 Actions Secrets；缺失时只保留内部候选 artifact：

- Windows：`WINDOWS_SIGNING_CERTIFICATE_BASE64`、`WINDOWS_SIGNING_CERTIFICATE_PASSWORD`
- macOS 证书：`MACOS_APP_CERTIFICATE_BASE64`、`MACOS_INSTALLER_CERTIFICATE_BASE64`、`MACOS_P12_PASSWORD`、`MACOS_KEYCHAIN_PASSWORD`
- macOS 身份/公证：`MACOS_APP_IDENTITY`、`MACOS_INSTALLER_IDENTITY`、`APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID`
- Linux：`LINUX_MINISIGN_SECRET_KEY_BASE64`、`LINUX_MINISIGN_PASSWORD`、`LINUX_MINISIGN_PUBLIC_KEY`

`LINUX_MINISIGN_PUBLIC_KEY` 是 `RW...` 单行公钥；私钥 secret 存放 Minisign 私钥文件的 Base64。公钥也会作为 `minisign.pub` 随 Release 发布，但维护者仍应通过仓库外渠道公布可信公钥指纹。

## 工作流做了什么

`.github/workflows/windows-release.yml`：

1. 在四个发行 RID 的原生 runner 上运行完整 Node/.NET 测试和 NativeAOT publish
2. 下载固定版本的 Node 与 mihomo 并校验 SHA-256
3. 用 `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` 安装生产依赖
4. 拒绝 Chromium、`ms-playwright` 和旧 `public/` 管理页进入产物
5. 用私有 Node 对 staged Agent 执行 IPC/SQLite 启动烟测
6. 将许可证、第三方声明、隐私和源码说明写入安装包的 `licenses/`
7. 生成 Windows 安装器、Linux AppImage、macOS `.pkg`/Portable.zip/DMG，并执行各平台签名门禁
8. 从 `assets.<channel>.json` 只收集本次构建产物，排除为 delta 下载的历史包
9. 生成四份 SBOM、源码归档与总校验和，由 aggregate job 创建唯一 Draft

固定发行标识（不随品牌变更）：

- 显示名：`ChatGPT Account Keeper`
- VeloPack Pack ID：`GptAccountKeeper.Desktop`
- Bundle ID：`io.github.yang-sanmu.gptaccountkeeper`
