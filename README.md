# chatgpt-account-keeper

多 ChatGPT 网页账号的会话管理与定时对话工具。手动登录一次后持久化登录态，之后可按预设内容定时自动对话，并在网页面板里统一管理多个账号。

## 功能

- 多账号管理：每个账号独立浏览器 profile，登录态落盘持久化
- 手动登录：面板点“登录”→ 本机弹出真实浏览器窗口，手动完成登录（含验证码/二步验证）
- 账号身份：登录后自动抓取并显示 ChatGPT 账号邮箱
- 会话内容集：可配置多组 prompt，随机或顺序抽取
- 定时调度：按可配置间隔（带随机抖动）自动为各账号跑对话
- 状态监控：后台定时检查各账号登录状态，面板实时显示

## 技术栈

- 后端：Node.js + Express（REST API + 内置调度器 + 状态监控）
- 前端：原生 HTML/CSS/JS（无构建步骤）
- 自动化：Playwright（Chromium）

## 安装

```bash
npm install
npx playwright install chromium
```

首次使用，复制示例配置：

```bash
cp config/accounts.example.json config/accounts.json
cp config/settings.example.json config/settings.json
cp config/conversations.example.json config/conversations.json
```

（`accounts.json` 也可留空由面板“添加账号”生成；会话内容可在面板“会话内容”里编辑。）

## 启动

```bash
npm start
```

然后浏览器打开 http://localhost:5173

## 使用

1. 面板点“添加账号”→ 自动弹出浏览器 → 手动登录
2. 登录成功后账号邮箱会自动显示
3. 在“会话内容”配置 prompt，在账号行选择会话集
4. “定时设置”里配置间隔，顶栏“启动调度”开启自动对话

## 命令行（可选）

```bash
npm run login <accountId>   # 手动登录某账号
npm run once <accountId>    # 立即跑一次
npm run run                 # 启动常驻定时调度
```

## 安全说明

- `profiles/` 存放账号登录态（cookies/session），`config/accounts.json` 含邮箱等信息，均已在 `.gitignore` 中排除，**切勿提交或分享**。

## 免责声明

本工具通过自动化方式访问 ChatGPT 网页端。OpenAI 的服务条款通常禁止对非 API 服务的程序化/自动化访问，使用本工具可能导致账号被限制或封禁。本工具仅供个人学习与技术研究，使用风险自负。
