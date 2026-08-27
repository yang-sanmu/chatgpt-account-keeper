# 前端 UI 重建任务书

这是 `app/src/` 视觉层的唯一规格来源。**旧实现已全部删除**，不要去找、不要参考、不要复原
它的任何主题、图标、布局或组件形态。仓库里已经没有它了。

## 硬边界

**只在这些目录下写文件：**

```
src/components/**        你新建的所有组件
src/pages/**             八个页面
src/styles/**            只能改 theme.css 里的令牌值，不能改令牌名
```

**绝对不要碰：**

```
src/ipc/**               IPC 契约与生成的类型（generated.ts 由脚本生成）
src/store/**             状态层（已完成，64 个测试锁住行为）
src/lib/**               format / notify / theme / utils（已完成）
src/test/**              测试基建
src-tauri/**             Rust 侧
package.json             依赖已装齐，不要增删
vite.config.ts  tsconfig.json
```

需要一个 `src/lib/` 或 `src/store/` 里没有的能力时，**在报告里说明**，不要自己往那些目录
里加文件，也不要在组件里重新实现一份。

## 技术栈（已安装，直接用）

React 19 · TypeScript 5.9 strict · Vite 7 · **Tailwind CSS v4** · **shadcn/ui 形态的组件**
（Radix primitives + cva，源码落在 `src/components/ui/`）· lucide-react 图标 · sonner 通知
· zustand（只读，不要自己建 store）

已安装的 Radix primitives：`dialog` `alert-dialog` `select` `tooltip` `checkbox` `switch`
`tabs` `dropdown-menu` `progress` `scroll-area` `label` `separator` `popover` `collapsible`
`slot`。**不要新增依赖**，缺什么用现有的拼。

Tailwind v4 是 CSS-first 配置，没有 `tailwind.config.js`，令牌全在 `src/styles/theme.css`
的 `@theme inline` 块里。

## 设计令牌（已定，照用）

`src/styles/theme.css` 已经定义好双套色板。**用语义类名，不要写具体颜色**：

| 用途 | 类名 |
| --- | --- |
| 页面底色 / 面板 / 抬升 / 浮层 / 凹陷 | `bg-app` `bg-panel` `bg-raised` `bg-overlay` `bg-sunken` |
| 悬停 / 按下 | `bg-hover` `bg-active` |
| 正文 / 次要 / 弱化 | `text-primary` `text-secondary` `text-muted` |
| 描边 | `border-subtle` `border-line` `border-strong` |
| 强调 | `bg-accent` `text-accent` `bg-accent-soft` `text-accent-content` |
| 状态 | `text-ok` `bg-ok-soft` · `warn` · `danger` · `info` · `idle` 同构 |
| 圆角 | `rounded-panel`(12px) `rounded-control`(8px) `rounded-chip`(6px) |
| 阴影 | `shadow-panel` `shadow-raised` `shadow-overlay` |
| 工具类 | `scroll-slim`（细滚动条）`tabular`（等宽数字） |

**禁止**出现 `bg-[#1c1c20]`、`text-gray-400`、`bg-slate-800`、内联 `style={{color:...}}`。
所有颜色必须来自上表。要新的语义色，先在 `theme.css` 里加令牌（深浅两套都要加），再用。

深浅切换靠 `<html class="dark">`，`src/lib/theme.ts` 已实现 `applyTheme` / `resolveTheme` /
`watchSystemTheme`。**每个组件在两种模式下都要能看**——写完自己切一遍看。

### 视觉方向

深色控制台，冷色强调。这是一个常驻托盘、长时间盯着看的运维工具：

- **信息密度优先**：13px 基准字号，紧凑行高。这不是内容阅读界面。
- **状态色只用在状态上**。不要用彩色做装饰、渐变或点缀。一屏里出现红色就应该意味着
  「这里真的有问题」，否则红色会失去意义。
- **层次靠背景亮度与描边，不靠大阴影**。阴影只给真正浮起来的东西（浮层、弹窗、吸底栏）。
- 等宽数字用在所有会刷新的数值上（延迟、计数、进度），否则数字跳动时列会左右抖。

## 可用的状态层 API（这是完整清单）

不要自己调 `invoke`，不要自己 `listen` 事件，不要新建 store。全部通过下面的 hooks。

### `src/store/selectors.ts`

```ts
useVisibleAccounts(): AccountRecord[]          // 当前筛选下可见的账号
useAccountRecord(id): AccountRecord | undefined // 单条，卡片组件用它
useAccountFilter()    // { filter, active, setFilter, reset }
useAccountSelection() // { selectedIds, count, toggle, select, clear }
useAccountActions()   // { edit, discard, save, remove, refreshStatus, runNow,
                      //   checkSelectors, startLogin, togglePage, openHistory }
useBulkActions()      // { setEnabled, refreshStatus, runNow, remove }
useConnectionStatus() // { connection, draining, agentVersion, instanceId }
useSchedulerControls()// { scheduler, running, start, stop, toggle }
useActiveOperations(): Operation[]
useNav()              // { nav, setNav, collapsed, toggleSidebar }
useProfileScanState() // { scan, scanning, failed, request }
useDesktopSettings()  // { settings, update }
useAgentSettings()    // { settings, update }
```

### `useKeeperStore` 直接读取（用 selector 形式，别整个订阅）

```ts
const groups = useKeeperStore((s) => s.groups);
```

可读字段：`startupInfo` `initializing` `connection` `draining` `accounts` `accountIds`
`accountFilter` `selectedAccountIds` `emailsRevealed` `groups` `proxies` `conversations`
`scheduler` `operations` `historyAccounts` `browserRuns` `queue` `agentSettings`
`desktopSettings` `profileScan` `profileScanning` `profileScanFailed` `nav`
`sidebarCollapsed` `login` `updateDialog` `closeDialogOpen` `exitProgress`
`historyFocusAccountId`

可调动作（除上面 hooks 覆盖的以外）：`setEmailsRevealed` `startScheduler` `stopScheduler`
`syncBootstrap` `refreshBrowserRuns` `refreshQueue` `checkForUpdate`
`installPendingUpdate` `dismissUpdateDialog` `dismissCloseDialog` `minimizeToTray`
`exitEverything` `forceExit` `closeLogin` `createAccount` `runOperation`

### 直接调 agent 的场景

分组、代理订阅、会话集、历史查询这几处没有包装 hook，用：

```ts
import { agentCall, newCommandId } from "@/ipc/bridge";
import { useKeeperStore } from "@/store/keeperStore";

// 查询类
const entries = await agentCall("history.query", { accountId, limit: 50 });

// 变更类：必须带幂等键
await agentCall("groups.create", { name, proxyId }, await newCommandId());

// 操作类（长任务，返回 Operation 描述符）：必须用 runOperation 等终态
const op = await useKeeperStore.getState().runOperation("proxies.importSubscription", { url });
```

**哪些是操作类**：`proxies.importSubscription` `proxies.refreshSubscription`
`proxies.setNodeEnabled` `proxies.testNode` `proxies.testAll` `profiles.scan`
`profiles.cleanCache` `profiles.archiveOrphan` `profiles.purgeOrphan`
`accounts.runNow` `accounts.refreshStatus` `accounts.checkSelectors`
`browser.startLogin` `browser.openPage` `browser.closePage`

操作类方法 `agentCall` 的返回值**只是一个描述符**，不是结果。直接拿它当结果用是一个真实
发生过的缺陷：Profile 页曾经去描述符里找 `profiles` 数组，永远找不到，于是一台有 47 个
Profile 的机器显示「无 Profile」。要结果就用 `runOperation` 等终态。

### 通知

```ts
import { notify } from "@/lib/notify";
notify.success("标题", "说明");
notify.info(...); notify.warning(...);
notify.error("保存失败", error);   // 第二参传抛出物，自动提取稳定错误码
```

失败提示停留 8 秒并显示错误码。你要做的是在 `<Toaster />` 里把 `data.code` 渲染成一个
**可点击复制**的徽章——错误码是用户报障时唯一有用的信息。

### 格式化

```ts
import { displayEmail, maskEmail, formatRelative, formatDateTime, formatDate,
         formatBytes, shortId, formatDuration } from "@/lib/format";
```

`displayEmail(email, revealed)` 按开关决定明文还是脱敏。**不要自己写脱敏逻辑。**

## 八个页面

左侧栏 + 右侧内容区。侧栏分两组，带分组标签：

```
运行
  总览 overview      账号 accounts     任务 operations    历史 history
配置
  分组与代理 proxies  会话策略 conversations  Profile profiles  设置 settings
```

侧栏要求：可折叠到仅图标（`useNav().collapsed` / `toggleSidebar`）；折叠态下用 Tooltip
显示名称；账号数与运行中任务数显示为 badge；`Ctrl+1..8` 切换页面；底部是连接状态指示 +
调度启停 + 手动同步。`draining` 为真时侧栏要有明显的「正在排空准备更新」提示。

### 1. 总览 overview

连接状态与 Agent 版本/实例、调度启停、队列与并发插槽（`queue`：workSlots / chromeSlots /
queuedTotal / running）、Chrome 运行明细（`browserRuns`，`close_failed` 的记录必须持续可见
且可重试回收，调 `browserRuns.close`）、数据目录路径（复制按钮）、最近操作摘要。

进页面时调 `refreshQueue()` 与 `refreshBrowserRuns()`，之后靠事件更新即可，**不要轮询**。

### 2. 账号 accounts —— 这是主页面，投入最多的精力

**必须是标签式卡片网格，禁止列表/表格行。** 网格
`grid-template-columns: repeat(auto-fill, minmax(340px, 1fr))`，间距 16px，
**卡片高度不写死**，用 flex 让内容自然撑开（不同账号信息量不同）。

单卡内容，字段全部来自 `AccountRecord.effective`：

- **卡头**：勾选框、邮箱（`displayEmail(email, emailsRevealed)`）、`gptName` 徽章、
  状态徽章（`status` + 颜色点，`stale` 时追加「待复核」）、`statusCheckedAt` 的相对时间
  （完整时间戳进 `title`）
- **分组行**：`groupName` 可编辑下拉（改动即时保存）、`exitNode`；`exitNodeMissing` 为真时
  显示「节点已失效」并用 `text-danger`
- **轮换进度**：`rotationTopic` + `rotationDone`/`rotationTarget` + 进度条
- **下次运行信息块**：`nextRunAt` 相对 + 绝对时间；`lastRunOk === false` 时用 danger 色显示
  `lastRunReason`
- **轮换规则下拉**：`switchRule`，`random`→「随机」`sequential`→「顺序」。
  **模型值是枚举，中文只做显示**，不要拿中文当值
- **备注与窗口数**：放在可展开区，`note` 文本框 + `minWindows`/`maxWindows` 数字输入，
  Enter 提交
- **图标操作条**：登录、强制重登（仅 `status` 为 `needs_login`/`waf` 或 `lastRunOk===false`
  时出现）、打开/关闭网页（由 `pageOpen` 决定形态）、立即运行、刷新状态、检查选择器、
  历史、删除。每个必须有 `aria-label` 或 `title`

**脏值可见**：`record.dirtyFields.size > 0` 时卡片要有未保存的视觉标记，并给「保存 / 放弃」
（`save` / `discard`）。`record.inFlight !== null` 时提交按钮进 loading。

顶部工具栏：搜索框、分组筛选、状态筛选（含 `stale` / `node_missing` / `disabled` /
`page_open` 四个派生项）、轮换规则筛选、**全部隐藏/全部展示邮箱的切换按钮**
（`emailsRevealed` / `setEmailsRevealed`，默认隐藏）、新建账号。

底部吸底批量操作栏（有勾选时出现，不随卡片滚动）：全选/取消、已选 N 个、批量启用/停用/
刷新状态/立即运行/删除。

卡片必须 `React.memo` 且 `key={id}`。一条巡检事件只该让一张卡重渲染——`useAccountRecord`
已保证订阅粒度，你只要别把整个 `accounts` 对象传进卡片。

### 3. 任务 operations

`operations` 列表，按 state 筛选。稳定错误码可复制。`progress` 有值时显示进度条。
上次运行遗留的 `interrupted`/`cancelled` 要显示成「已取消」，**不能看起来像还在跑**。

### 4. 历史 history

`history.listAccounts` + `history.query`。渲染结构化问答气泡并支持复制。
`historyFocusAccountId` 有值时自动选中那个账号（从账号卡片跳过来的）。
**取不到字段时不许把原始 JSON 铺给用户看**，显示「本条记录缺少内容」。

### 5. 分组与代理 proxies

`groups.*` + `proxies.getState`。分组用**标签式卡片**（同账号页形态，禁止列表）。
「新建分组」与「编辑分组」必须是两个明确状态，**不要用「选中项为空」表示新建**。

节点部分显示 `server:port`、分组本地端口、延迟（颜色分级：<200ms ok / <500ms warn /
更高用 warn 的更深一档 / 测速失败 danger）。注意 `latencyOk === false`（测过且失败）与
`latencyOk === null`（还没测过）必须区分，后者不能涂成红色。测速结果由
`proxyNode.tested` 事件自动回填到 store，你只要读 `proxies.nodes` 即可。

订阅缺字段时显示 `—`，不能渲染成 `null:null`。

### 6. 会话策略 conversations

`conversations.*`。**标签式卡片，禁止列表。** 同样区分新建/编辑两个明确状态。

重命名是非原子的（先 `upsert` 新名，再 `remove` 旧名）：
- 改名时必须**提前**警告这一点
- 第二步失败时必须说清「两个会话集现在同时存在，请手动删除旧的，否则它会继续参与调度」，
  并且**不要关弹窗**——让用户看着当前状态决定下一步

### 7. Profile profiles

`useProfileScanState()`。**首次进入自动扫描**，条件是
`scan === null && !scanning && !failed`——三个条件都要判，漏掉 `failed` 会在 Agent 未连接时
变成每轮一个错误提示的无限重试。

孤儿筛选、清缓存、归档、永久删除。破坏性操作的确认文案必须说明**具体后果**：涉及几个、
Profile 会保留还是删除、是否可恢复。`busy` 的条目禁用操作并说明原因。

`failed` 时**绝不能**显示「暂无 Profile」——那句话会让一台有 47 个 Profile 的机器看起来
是干净的。要显示「扫描失败，这里既不代表有也不代表没有」+ 重试按钮。

### 8. 设置 settings

三块：Agent 配置（`useAgentSettings`，脏值跟踪 + 提交前校验 + 可放弃）、桌面偏好
（`useDesktopSettings`：**主题三档 dark/light/system**、关闭行为、开机自启、自动调度、
更新策略）、关于与许可。

更新策略**只有两档**：`notifyOnly`（仅提醒）和 `installAtSafePoint`（安全空闲时自动安装）。
没有第三档，不要加。

### 首次启动向导

`startupInfo.initialized === false` 时不进主界面，走向导：创建全新数据 / 预览并导入旧项目
（`inspect_legacy` → 显示账号数、Profile 数、占用空间 → 确认 → `import_legacy`，进度走
`keeper://migration` 事件）/ 选择数据目录（`check_data_root` → `use_data_root` → 提示重启）。

导入失败时必须显示「**旧目录未被修改**」——这是用户最担心的事。

需要用到的 bridge 函数：`inspectLegacy` `importLegacy` `checkDataRoot` `useDataRoot`
（都在 `@/ipc/bridge`）。`keeper://migration` 事件目前 store 没订阅，向导页自己用
`subscribeTauriEvents({ onMigration })` 订阅，组件卸载时注销。

### 全局浮层

登录进度窗（跟随 `login.operation`，必须消费 `waiting_user` 阶段——用户要在真实 Chrome 里
操作，不能只说一句「已提交」）、关闭确认框、更新弹窗、退出进度窗（`exitProgress`，
`canForce` 为真时才给「强制结束」）。

**浮层必须挂在页面组件之外。** 它们曾经嵌在页面里，而页面在加载中和首次启动时会提前
return，导致关闭确认框在首次启动页上不存在——窗口点关闭毫无反应，只能去任务管理器结束
进程。Rust 侧对 `CloseRequested` 调了 `prevent_close()`，决定权完全在前端。

## 通用交互要求

- 每个页面**最多一个纵向滚动容器**。禁止列表写死高度后再套外层滚动（嵌套滚动）
- 每个列表都要有空状态：说明为什么是空的、下一步做什么
- 破坏性操作二次确认，文案说明具体后果与影响范围
- 文本框支持 Enter 提交
- 加载中要有骨架屏或明确的加载指示，不要空白
- 所有图标按钮必须有 `aria-label`；表单控件必须有关联 `<label>`；键盘可达
- 中文文案。注释写「为什么」不写「做什么」，中文注释

## 质量门禁

```bash
cd app
npm run typecheck   # tsc --noEmit，strict
npm run test        # vitest，64 个既有测试必须保持全绿
npm run build
```

- 不允许 `any`、`@ts-ignore`、`@ts-expect-error`、`eslint-disable`
- 不允许 `console.log`
- 不允许硬编码颜色（见「设计令牌」）
- **不要改 `src/store/**` 或 `src/lib/**` 里的任何文件**。那 64 个测试锁的是状态层行为，
  改动它们就是在改被测对象。如果你认为状态层缺了某个能力，在报告里写出来
- 不要新增 README 或文档文件

## 交付顺序

按这个顺序做，每完成一批自己 review 一遍再继续：

1. **设计系统**：`src/components/ui/` 下的基础组件（Button / Card / Badge / Input / Select /
   Checkbox / Switch / Dialog / AlertDialog / Tooltip / Tabs / Progress / DropdownMenu /
   Separator / Label / ScrollArea / Skeleton / EmptyState / Toaster）+ 状态徽章 StatusDot
2. **应用外壳**：`App.tsx` 的替代（侧栏 + 顶栏 + 内容区 + 全局浮层 + 主题应用）
3. **账号页**（含卡片、筛选栏、批量栏、新建/删除弹窗）
4. **总览 + 任务 + 历史**
5. **分组与代理 + 会话策略 + Profile**
6. **设置 + 首次启动向导**
