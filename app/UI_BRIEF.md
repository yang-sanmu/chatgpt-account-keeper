# 前端实现任务书（给 agy）

本文件是 `app/src/` 前端实现的唯一规格来源。Rust 侧（`app/src-tauri/`）已经完成并通过
122 个测试，**不要修改 `src-tauri/` 下的任何文件**。

## 你的工作范围

只在 `app/src/` 下工作。技术栈已固定：React 19 + Vite 7 + TypeScript 5（strict）。
依赖已安装，不要新增运行时依赖（除下面明确允许的）。

允许新增的 devDependency：无。allowed runtime dependency：无。
所有 UI 用手写 CSS（CSS Modules 或单个全局样式表皆可），不引入 UI 框架/组件库。
理由：这是一个要长期维护的桌面客户端，组件库的版本升级成本远高于它省下的样式代码。

## 一、可用的后端接口（这是完整清单）

```ts
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
```

### Command（`invoke(name, args)`）

| name | args | 返回 | 说明 |
| --- | --- | --- | --- |
| `agent_call` | `{ method, params?, commandId? }` | `unknown` | **唯一的业务通道**。`method` 只能是下面 45 个之一 |
| `new_command_id` | – | `string` | 变更类调用的幂等键 |
| `get_startup_info` | – | `StartupInfo` | 启动时调一次 |
| `connect_agent` | `{ start: boolean }` | `ConnectionSnapshot` | `start=false` 只接回已有 Agent |
| `refresh_bootstrap` | – | `void` | 手动全量同步；结果走 `keeper://bootstrap` 事件 |
| `save_settings` | `{ next: DesktopSettings }` | `void` | |
| `exit_all` | – | `void` | 停 Agent 后退出进程 |
| `hide_to_tray` | – | `void` | |
| `check_data_root` | `{ path }` | `DataRootCheck` | |
| `use_data_root` | `{ path }` | `void` | 需要重启才生效 |
| `inspect_legacy` | `{ path }` | `unknown` | 只读预检，不改旧数据 |
| `import_legacy` | `{ path }` | `ConnectionSnapshot` | 长任务，进度走 `keeper://migration` |
| `check_update` | – | `UpdateStatus` | |
| `install_update` | – | `void` | 长任务，进度走 `keeper://update` |
| `set_scheduler_tray_state` | `{ running: boolean }` | `void` | 收到 `scheduler.changed` 后调它 |

失败时 `invoke` reject 出 `{ code, message, retryable }`。**`code` 必须显示给用户**
（可复制），它是定位问题的唯一稳定标识。已知值见下方错误码清单。

### `agent_call` 允许的 45 个 method

```
accounts.list  accounts.create  accounts.update  accounts.remove
accounts.getStatus  accounts.refreshStatus  accounts.runNow  accounts.checkSelectors
accounts.history
browser.startLogin  browser.getTask  browser.openPage  browser.closePage
browser.listOpenPages
history.query  history.listAccounts
groups.list  groups.create  groups.update  groups.remove
proxies.getState  proxies.importSubscription  proxies.refreshSubscription
proxies.setRuntimeDirectory  proxies.setNodeEnabled  proxies.testNode  proxies.testAll
profiles.scan  profiles.cleanCache  profiles.archiveOrphan  profiles.purgeOrphan
conversations.list  conversations.upsert  conversations.remove
scheduler.getState  scheduler.start  scheduler.stop
settings.get  settings.update
operations.get  operations.listActive  operations.list
queue.getSnapshot
browserRuns.list  browserRuns.close
```

**`system.*` 五个方法不对前端开放**（`system.hello/bootstrap/getActivity/prepareUpdate/
shutdown`）。调它们会被拒绝并返回 `VALIDATION_FAILED`。连接协商、全量快照时机、更新
编排和退出流程都在 Rust 侧——这是有意的边界，不要试图绕过。

### 事件（`listen(name, handler)`）

| name | payload | 何时来 |
| --- | --- | --- |
| `keeper://bootstrap` | 全量快照对象 | 首次连上、seq 缺口、实例变化、`refresh_bootstrap` |
| `keeper://agent-event` | `{ name, seq, instanceId, occurredAt, payload }` | Agent 的 18 种业务事件 |
| `keeper://connection` | `ConnectionSnapshot` | 连接状态变化 |
| `keeper://migration` | `{ state, stage, message, progress?, error? }` | 旧项目导入进度 |
| `keeper://update` | `UpdateStatus` | 更新检查/下载/安装进度 |
| `keeper://tray-action` | `string` | 托盘菜单点击：`scheduler-start` / `scheduler-stop` / `check-update` / `exit-all` |
| `keeper://close-requested` | – | 用户点了窗口关闭按钮 |

### 18 种 `keeper://agent-event` 的 name

```
account.changed  account.removed  accountStatus.changed  openPage.changed
operation.changed  group.changed  proxyState.changed  proxyNode.tested
profile.changed  conversation.changed  scheduler.changed  scheduler.accountChanged
history.appended  settings.changed  agent.draining  agent.readyForUpdate
queue.changed  browserRun.changed
```

### 错误码（12 个，全部要能显示）

```
VALIDATION_FAILED  NOT_FOUND  RESOURCE_BUSY  PROFILE_IN_USE  PROXY_UNAVAILABLE
ALREADY_OPEN  LOGIN_FORCE_CONFLICT  CHROME_NOT_FOUND  AGENT_DRAINING
PROTOCOL_MISMATCH  FRAME_TOO_LARGE  INTERNAL
```
另有 Rust 侧补充的：`AGENT_NOT_CONNECTED`（可重试）、`AGENT_TIMEOUT`（可重试）、
`MIGRATION_*`。

## 二、数据形状

`agent_call` 返回的是 Agent 的原始 JSON。你需要在 `src/ipc/types.ts` 手写 interface。
**不要用 `any`**；不确定的字段用 `unknown` 加窄化函数。以下是关键结构，字段名以实际
运行结果为准（用 `keeper://bootstrap` 的实际 payload 校对）。

`keeper://bootstrap` 的 14 个顶层字段：
```
accounts  groups  proxies  conversations  settings  scheduler
historyAccounts  operations  profiles  draining  protocol  agentVersion
instanceId  revision
```

单个 account 的关键字段（来自 Agent 的 `publicAccount`）：
```ts
interface Account {
  id: string;
  email: string | null;          // 未登录时为 null
  note: string;
  enabled: boolean;
  groupId: string | null;
  groupName: string | null;
  switchRule: "random" | "sequential";
  minWindows: number;
  maxWindows: number;
  status: string;                // ok / needs_login / waf / unknown / ...
  statusCheckedAt: string | null;
  stale: boolean;                // 待复核
  exitNode: string | null;
  exitNodeMissing: boolean;      // 节点已失效
  rotationTopic: string | null;
  rotationDone: number;
  rotationTarget: number;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastRunOk: boolean | null;
  pageOpen: boolean;
  profileDir: string;
}
```

## 三、账号页：标签式卡片布局（这是本次的新要求）

**不要做成列表/表格行。** 账号页用卡片网格，参照 Cockpit Tools 的形态：

```
┌─────────────────────────────────────┐
│ ☐  ba***7@i***d.com    [当前] [PLUS] │  ← 复选框 + 脱敏邮箱 + 状态徽章
│                                      │
│ 出口分组: 个人账户 ⇄ [切换分组] [备注] │  ← 一行操作链接
│ [↻ 轮换 3/8]                         │  ← 小徽章
│                                      │
│ 使用 Password 登录 · ID: 4f4***d9e   │  ← 次要信息行
│                                      │
│ 本周进度            0 req  0  A $0   │  ← 指标行
│ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░           79%   │  ← 进度条
│ 6d 18h 36m (08/31 08:37)             │
│                                      │
│ ┌──────────────────────────────────┐ │
│ │ 📅 下次运行 4 天   2026-08-27 14:11│ │  ← 高亮信息块
│ └──────────────────────────────────┘ │
│                                      │
│ 2026/07/31 11:31        [标准 ▾]    │  ← 创建时间 + 轮换规则下拉
├──────────────────────────────────────┤
│  [>_] [🏷] [📄] [▶] [↻] [⬆] [🗑]    │  ← 图标操作条
└─────────────────────────────────────┘
```

映射到本项目的实际字段：

- **卡头**：复选框（批量选择）、脱敏邮箱（`email` 或「未登录」）、状态徽章
  （`status` + 颜色点 + `stale` 时追加「· 待复核」）。
- **分组行**：`groupName`（可编辑下拉，改动即时保存）、`exitNode`
  （`exitNodeMissing` 时显示「节点已失效」并用警告色）。
- **轮换徽章**：`rotationTopic` + `rotationDone`/`rotationTarget`。
- **进度条**：轮换进度 `rotationDone / rotationTarget`。
- **信息块**：`nextRunAt`（相对时间 + 绝对时间戳），`lastRunOk === false` 时用警告色
  显示上次失败。
- **底部下拉**：`switchRule`（`random` → 「随机」，`sequential` → 「顺序」）。
  **模型值是枚举，中文只做显示**，不要用中文字符串当值。
- **图标操作条**：登录、强制重登（仅 `status` 需要时显示）、打开/关闭网页
  （`pageOpen` 决定）、立即运行、刷新状态、检查选择器、历史、删除。每个图标必须有
  `title` 或 `aria-label`。
- **窗口数**（`minWindows`/`maxWindows`）：放在「备注」展开区或卡片次要区域，两个
  数字输入，Enter 提交。

卡片网格：`grid-template-columns: repeat(auto-fill, minmax(340px, 1fr))`，间距 16px。
**卡片高度不要写死**，用 flex 让内容自然撑开；不同账号的信息量不同。

批量操作栏固定在页面底部（不随卡片滚动）：全选/取消、已勾选 N 个、批量启用/停用/
刷新状态/立即运行/删除。

## 四、三条必须实现的行为（每条都要有测试）

这三条不是「最好有」，它们各自对应一个已经发生过的用户可见缺陷。测试用 vitest。

### 1. 刷新不丢正在编辑的草稿

状态巡检默认 15 分钟一次，接近 30 个账号并发推事件。用户改备注时撞上是常态。

要求：`keeper://bootstrap` 或 `accountStatus.changed` 到达时，若某个字段用户已经改过
且未保存，**保留用户的值**，只更新「服务端基线」。未改过的字段跟随服务端更新。

测试：改备注 → 收到一次含旧备注的 bootstrap → 输入框里仍是用户的值。

### 2. 提交期间继续编辑不丢新值

要求：提交 `accounts.update` 后、响应到达前，用户又改了同一个字段。响应回来时若当前值
已不等于提交值，**只更新基线，保留新草稿**，不要把界面回退到已提交的值。

测试：提交 A → 用户改成 B → 响应（服务端确认 A）到达 → 界面仍是 B 且仍标记为脏。

### 3. 增量事件不破坏筛选/选中/滚动

要求：单条 `account.changed` / `accountStatus.changed` 只更新那一张卡片。React 用稳定
`key={account.id}`，不要整表替换。收到增量事件后要**重新应用当前筛选条件**（一个账号
状态变了可能就不该出现在当前筛选下了）。

测试：勾选 3 张卡 → 收到一条 `accountStatus.changed` → 勾选状态保持；筛选「仅需登录」
时收到一条状态变为 ok 的事件 → 那张卡从列表消失。

**写法要求**：先用刻意朴素的实现（整表替换、无脏值判断）确认这三条测试**变红**，再换
真实现变绿。不曾变红的测试是空转测试。在提交里注明你验证过。

## 五、八个页面

Shell 是左侧栏 + 右侧内容区。每个页面是独立组件，**每页最多一个纵向滚动容器**
（禁止列表写死高度后再套外层滚动 → 会造成嵌套滚动）。

1. **总览**：连接状态、Agent 版本/实例、调度启停、队列快照、Chrome 运行明细
   （`browserRuns.list`，`close_failed` 的记录要能持续显示并可重试回收）、数据目录路径
   （「打开所在文件夹」+「复制路径」）、最近事件。
2. **账号**：见第三节。
3. **任务**：`operations.list`，按状态筛选，稳定错误码可复制。上一次运行遗留的
   `interrupted` 要显示成「已取消」而不是像还在跑。
4. **分组与代理**：`proxies.getState` + `groups.*`。节点行显示 `server:port`、分组本地
   端口、延迟（颜色分级）。`proxyNode.tested` 事件的结果**回填到那一行**，不能只进任务
   中心。「新建分组」和「编辑分组」必须是两个明确状态，不要用「选中项为空」表示新建。
5. **会话**：`conversations.*`。同样区分新建/编辑。重命名是非原子的（先 upsert 后
   remove），执行前必须告知失败后果。
6. **Profile**：`profiles.scan`（**首次进入自动扫描**，不要求用户先点按钮）、孤儿筛选、
   清缓存/归档/永久删除。破坏性操作的确认文案必须说明具体后果（涉及几个、Profile 会
   保留还是删除、是否可恢复）。
7. **历史**：`history.listAccounts` + `history.query`。渲染结构化问答气泡并支持复制。
   **取不到字段时不许把原始 JSON 铺给用户看**，显示「本条记录缺少内容」。
8. **设置**：Agent 设置（`settings.get/update`，脏值跟踪 + 提交前校验 + 可放弃）、桌面
   行为（主题、关闭行为、开机自启、自动调度、更新策略）、关于与许可。

更新策略只有两档：`notifyOnly`（仅提醒）和 `installAtSafePoint`（安全空闲时自动安装）。
没有第三档，不要加。

## 六、通用交互要求

- **Toast**：成功/失败/提示三类。失败停留更久，且显示稳定错误码。浮在窗口顶层，不要
  放页面底部（账号页第一屏看不到）。
- **破坏性操作二次确认**，文案说明具体后果与影响范围。
- **登录**：`browser.startLogin` 返回一个 operation。必须开前台进度窗跟随它，消费
  `waiting_user` 阶段（用户要在真实 Chrome 里操作）。不能只留一句「已提交：queued」。
- **创建账号后直接拉起登录窗口**。新账号唯一有意义的下一步就是登录。
- **每个列表都要有空状态**：说明为什么是空的、下一步做什么。
- 文本框支持 Enter 提交。
- 关闭窗口：监听 `keeper://close-requested`，按设置里的 `closeBehavior` 决定
  隐藏到托盘（调 `hide_to_tray`）/退出全部（调 `exit_all`）/弹窗询问（可记住选择）。
- 托盘动作：监听 `keeper://tray-action`，四个动作复用页面上已有的同名逻辑，不要另写
  一套。
- 收到 `scheduler.changed` 后调 `set_scheduler_tray_state`，让托盘菜单与真实状态一致。

## 七、首次启动流程

`get_startup_info().initialized === false` 时不要直接连 Agent，走首次启动页：

- 「创建全新数据」→ `connect_agent({ start: true })`
- 「预览并导入旧项目」→ 选目录 → `inspect_legacy` 显示预览（账号数、Profile 数、占用
  空间）→ 用户确认 → `import_legacy`，进度走 `keeper://migration`
- 「选择数据目录」→ `check_data_root` 校验 → `use_data_root` → 提示需要重启

导入失败时必须显示「旧目录未被修改」——这是用户最担心的事。

## 八、质量门禁

提交前必须全绿：

```bash
cd app
npm run typecheck   # tsc --noEmit，strict
npm run test        # vitest
npm run build       # vite build
```

- 不允许 `any`、`@ts-ignore`、`eslint-disable`。
- 不允许 `console.log` 留在代码里。
- 注释写「为什么」，不写「做什么」。中文注释。
- 不要新增 README/文档文件。

## 九、明确不要做的事

- 不修改 `app/src-tauri/` 下任何文件。
- 不修改 `app/package.json` 的依赖（devDependencies 也不加）。
- 不引入 UI 组件库、状态管理库、路由库。页面切换用一个 `useState` 存当前页即可。
- 不调用 `system.*` 方法，不试图自己管理连接生命周期。
- 不为「以后可能需要」写抽象层。
