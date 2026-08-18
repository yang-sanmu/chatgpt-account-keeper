# 远端发布流程（GitHub Actions）

用 GitHub Actions 构建并发布 Windows 版本。构建在 GitHub 的 runner 上完成，本机只负责触发和验收。

公开仓库的 Actions 用量免费。如果 job 无法启动并提示 `account is locked due to a billing issue`，那是账号级别的欠费锁（与本仓库用量无关），处理完才能用这条路径；期间改用 [本地发布流程](RELEASE_LOCAL.md)。

## 准备

只需一次：

```powershell
winget install GitHub.cli
gh auth login
```

## 完整流程

以发布 `0.1.5` 为例。四条命令里的版本号必须一致。

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

```powershell
.\scripts\publish-windows-release.ps1 -Version 0.1.5 -Mode Candidate
```

触发工作流并实时跟踪日志，跑完才返回（Windows runner 上约 15-25 分钟）。成功后产物自动下载到 `artifacts\candidate-0.1.5\`，其中分成两个子目录：

- `Releases\` —— 安装包、完整包、增量包、更新清单
- `compliance\` —— SBOM、源码归档、校验和

这一步**不打 tag、不创建 Release**，只为验收提供安装包。

### 3. N-1 → N 验收（手动）

这是公开发布前唯一的人工闸门，不要跳过。完整清单和原理见 **[N-1 → N 验收](RELEASE_VERIFY.md)**。

简版：装当前线上版本 → 造出真实数据（账号、登录、跑一次任务）→ 用 `artifacts\candidate-0.1.5\Releases\GptAccountKeeper.Desktop-win-Setup.exe` **覆盖安装**（不要先卸载）→ 确认账号 / Profile / 登录态 / 历史 / 代理都在，Agent 正常重启。

首次运行会出现 SmartScreen「未知发布者」提示，点「更多信息 → 仍要运行」。这是未签名软件的预期行为，见 [无签名发布](#无签名发布)。

### 4. 创建 Draft Release

```powershell
.\scripts\publish-windows-release.ps1 -Version 0.1.5 -Mode Release -NMinusOneVerified
```

`-NMinusOneVerified` 是强制的，不带这个开关脚本会拒绝执行 —— 它的作用就是挡住跳过第 3 步。

这一步会打 tag 并创建 **Draft** Release。Draft 客户端看不到，此时还没有人会收到更新。

### 5. 公开

先在 Release 页面人工确认 8 个必需 asset 齐全：

| Asset | 用途 |
|---|---|
| `GptAccountKeeper.Desktop-win-Setup.exe` | 安装程序 |
| `GptAccountKeeper.Desktop-<版本>-full.nupkg` | VeloPack 完整包 |
| `RELEASES` / `releases.win.json` | 更新清单 |
| `GptAccountKeeper.Desktop-<版本>.spdx.json` | SBOM |
| `chatgpt-account-keeper-<版本>-source.zip` | 项目对应源码（AGPL） |
| `mihomo-v<版本>-source.zip` | mihomo 对应源码（GPL-3.0 强制） |
| `SHA256SUMS.release.txt` | 校验和 |

然后：

```powershell
.\scripts\publish-windows-release.ps1 -Version 0.1.5 -Mode PublishDraft
```

脚本会再核对一遍 asset 齐全、确认是 Draft 且非 prerelease，通过后转正并标记 `--latest`。

**只有这一步会让版本进入客户端的稳定更新通道。**

## 注意事项

- **先干跑**：任何阶段都可以加 `-WhatIf`，只验证状态并显示将执行的操作，不实际执行。
- **同一版本号只能发一次**：脚本会检查 tag 和 Release 都不存在。重发必须换版本号。
- **候选目录不能已存在**：重跑第 2 步前先删 `artifacts\candidate-<版本>\`，或用 `-CandidateOutputDirectory` 指定别处。
- **不需要手动 push tag**：tag 由第 4 步自动创建。工作流只接受手动触发（`workflow_dispatch`），推 tag 不会触发构建。
- **仓库不是默认的**：加 `-Repository <owner>/<repo>`。

## 无签名发布

发行产物**不做 Authenticode 签名**。

Windows SmartScreen 在首次下载或运行安装程序时可能提示"未知发布者"，用户需点击「更多信息 → 仍要运行」。这不影响 VeloPack 自动更新 —— 更新完整性由 `RELEASES` 中的 SHA 校验，与签名无关。

每个 Release 附带 `SHA256SUMS.release.txt`，用户可据此核对下载。

如果以后配置了 `WINDOWS_SIGNING_CERTIFICATE_BASE64` 和 `WINDOWS_SIGNING_CERTIFICATE_PASSWORD` 两个仓库 secret，工作流会自动改为签名打包并校验签名状态，**上面的流程一个字都不用改**。

## 工作流做了什么

`.github/workflows/windows-release.yml`：

1. 运行完整 Node 测试和真实 NativeAOT publish
2. 下载固定版本的 Node 与 mihomo 并校验 SHA-256
3. 用 `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` 安装生产依赖
4. 拒绝 Chromium、`ms-playwright` 和旧 `public/` 管理页进入产物
5. 用私有 Node 对 staged Agent 执行 IPC/SQLite 启动烟测
6. 将许可证、第三方声明、隐私和源码说明写入安装包的 `licenses/`
7. 通过 VeloPack 打包（有证书则签名）
8. 生成 SBOM、项目与 mihomo 源码归档、`SHA256SUMS.release.txt`

固定发行标识（不随品牌变更）：

- 显示名：`ChatGPT Account Keeper`
- VeloPack Pack ID：`GptAccountKeeper.Desktop`
- Bundle ID：`io.github.yang-sanmu.gptaccountkeeper`
