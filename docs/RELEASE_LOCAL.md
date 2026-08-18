# 本地 Windows 检查流程（不依赖 GitHub Actions）

> **范围变更：** 本脚本只构建 Windows x64 检查包。四平台发布启用后，`UploadDraft` 已被禁用；本地产物不能创建正式 Draft Release，也不能替代 macOS 签名公证和 Linux AppImage/Minisign runner。正式发布请使用 [远端发布流程](RELEASE_REMOTE.md)。

在本机完成 Windows 构建、打包和检查产物生成，不上传 Release。它与远端 Windows job 接近，但不是完整的四平台发布产物。

适用场景：诊断 Windows 打包、签名前检查或 Actions 故障时验证 Windows 候选。

## 准备

需要本机装好：

| 依赖 | 说明 |
|---|---|
| .NET SDK | 版本见 `desktop/global.json` |
| Node.js | 版本见 `.node-version` |
| Git | 用于生成源码归档 |
| Visual Studio | 必须含「使用 C++ 的桌面开发」工作负载 —— NativeAOT 要用 MSVC 链接器 |
| GitHub CLI | `winget install GitHub.cli` 然后 `gh auth login` |

`vpk` 和 `syft` 缺失时脚本会自动安装/下载，不用手动准备。

Visual Studio 的 C++ 工作负载是最容易漏的一项。缺了会在 NativeAOT publish 阶段报 `MSB3073`，脚本已改为在开头就检查并给出提示。

## 完整流程

以发布 `0.1.5` 为例。三条命令里的版本号必须一致。

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

必须先提交并推送。二进制里嵌的是 HEAD 的 commit，只有工作树干净且与 `origin/main` 一致，`SOURCE.md` 承诺的"tag 源码树可复现该二进制"才成立。

### 2. 本地构建

```powershell
.\scripts\build-local-release.ps1 -Version 0.1.5
```

约 10-20 分钟（首次要下载 36MB Node + 17MB mihomo，之后会复用缓存）。做完这些事：

1. 检查工具链、工作树干净、三处版本号一致
2. 运行 Node 和 .NET 测试
3. 下载并校验 Node / mihomo 的 SHA-256（对照 `build/runtime-versions.json`）
4. NativeAOT publish
5. staging + 包内容校验 + Agent IPC/SQLite 烟测
6. 下载上一版生成增量包
7. VeloPack 打包
8. syft 生成 SBOM（校验官方 checksums）
9. 源码归档 + `SHA256SUMS.release.txt`

产物落在：

- `artifacts\Releases\` —— 安装包、完整包、增量包、更新清单
- `artifacts\compliance\` —— SBOM、源码归档、校验和

结尾会打印汇总，包括嵌入的 commit 和签名状态（`NotSigned` 是预期的）。

**常用开关：**

| 开关 | 用途 |
|---|---|
| `-SkipTests` | 跳过测试。仅用于同一 commit 上重跑构建 |
| `-SkipDelta` | 不生成增量包，客户端回退到完整包 |
| `-AllowDirty` | 允许脏工作树构建。仅用于丢弃性验证，产物不可由 tag 复现 |

### 3. N-1 → N 验收（手动）

这是公开发布前唯一的人工闸门，不要跳过。完整清单和原理见 **[N-1 → N 验收](RELEASE_VERIFY.md)**。

简版：装当前线上版本 → 造出真实数据（账号、登录、跑一次任务）→ 用 `artifacts\Releases\GptAccountKeeper.Desktop-win-Setup.exe` **覆盖安装**（不要先卸载）→ 确认账号 / Profile / 登录态 / 历史 / 代理都在，Agent 正常重启。

首次运行会出现 SmartScreen「未知发布者」提示，点「更多信息 → 仍要运行」。这是未签名软件的预期行为，见 [无签名发布](#无签名发布)。

### 4. 不要上传这个本地包

`publish-windows-release.ps1 -Mode UploadDraft` 会明确报错，因为本地目录缺少 macOS arm64/x64、Linux AppImage、Apple 公证和 Minisign 产物。完成 Windows 检查后，请回到 [远端发布流程](RELEASE_REMOTE.md)，由同一 commit 的四个平台原生 runner 重新构建并汇总 Draft。

## 注意事项

- **本地流程不创建 tag 或 Release**。
- **重跑构建前不用手动清理**：脚本每次会重建 `artifacts\stage`、`artifacts\Releases`、`artifacts\compliance`，下载缓存则会复用。

## 无签名发布

发行产物**不做 Authenticode 签名**。

Windows SmartScreen 在首次下载或运行安装程序时可能提示"未知发布者"，用户需点击「更多信息 → 仍要运行」。这不影响 VeloPack 自动更新 —— 更新完整性由 `RELEASES` 中的 SHA 校验，与签名无关。

本地检查目录会生成 SHA-256 清单；正式 Release 的总清单由远端 aggregate job 重新生成。

本地构建路径不支持签名。需要签名请用 [远端发布流程](RELEASE_REMOTE.md) 并配置仓库 secret。

## 为什么要有 mihomo 源码归档

安装包内含 `mihomo.exe`（代理内核），其许可证是 **GPL-3.0**。GPL-3.0 第 6 条要求分发二进制时同时提供**对应版本**的完整源码。仅提供上游仓库链接不够严谨（tag 可能被删、仓库可能消失），所以随 Release 附一份该 tag 的源码归档。

这是法律义务，不是可选项。

Node.js 是 MIT，只要求保留版权和许可声明，不需要提供源码 —— 所以只有 mihomo 需要源码归档。

如果以后不再打包 mihomo，这个 asset 可以去掉，同时要改 `scripts/verify-package.mjs` 里的 `licenses/mihomo-GPL-3.0.txt` 检查和 `SOURCE.md` 的相应段落。
