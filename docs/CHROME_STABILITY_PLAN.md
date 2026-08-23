# Chrome 卡顿与任务调度稳定性修复计划

本计划已由 GPT 与 Claude 完成多轮讨论并收敛。文中条款即为实现依据；讨论过程中被撤回或纠正的提议不再出现在本文件中。

## 1. 目标与完成定义

本次工作解决账号增多后系统卡顿、任务统计与实际 Chrome 数量不一致、后台任务集中启动，以及任务结束后 Chrome 进程残留的问题。

完成后必须满足：

- 调度任务和状态巡检共用一个全局有界队列，默认并发上限为 4。
- 同一账号任何时刻最多执行一个会占用该账号 Profile 的操作。
- 所有由本项目启动的 Chrome 都有明确归属、可观察状态和唯一关闭路径。
- 一个任务只有在该次运行的**完整 owned 进程树**被确认退出后，才算**资源已释放**（Chrome 容量与账号锁）。Operation 可以先以终态呈现失败结果，但终态**不代表**资源已释放；资源释放只发生在 BrowserRun 到达 `closed`。
- UI 中的排队、运行、关闭中任务和 Chrome 数量与实际状态一致。
- 停止调度、账号配置变更和应用退出都不会继续放行已经失效的后台任务。
- 不会按进程名称批量结束 Chrome，不影响用户自行启动的 Chrome。
- 后台排队不会阻塞应用更新，也不会让用户的登录/打开网页请求失败。

明确不在本次范围内：

- 不引入任何形式的浏览器回退或降级。代理节点不可用继续 fail-closed，找不到 Chrome 继续不降级到 bundled Chromium。
- 不引入跨账号抢占。任何规则都不得取消其他账号正在运行的任务。
- 不引入后台单次运行的业务总时限，不截断合法的长对话。

## 2. 组合根与依赖方向

统一队列必须拥有并编排 Operation。为避免 `services → scheduler → statusMonitor → loginProvider → browser` 成环，依赖方向固定如下：

- 新增 `src/application/backgroundQueue.js`，只依赖 `locks.js`、`operations.js`、`events.js`。队列**不得** import `scheduler.js`、`statusMonitor.js`、`browser.js`。
- `statusMonitor` 由模块级单例改造为可构造的 `StatusMonitorService`；`SchedulerService` 保持可构造。
- 由 `src/agent/main.js` 与 `src/agent/createAgent.js` 作为 Agent 的组合根，注入队列、浏览器启动器与持久化后端。
- `src/server.js` 与 `src/cli.js` 保留各自独立的组合根，不与 Agent 共享单例。

`statusMonitor` 的私有限流必须删除，不能与统一队列叠加：移除并发上限常量、single-flight 包装与自建 worker 池；巡检 tick 改为“把到期账号入队后立即返回”，重入保护由队列去重承担。保存设置不立即触发一次巡检的现有语义保留。

`scheduler` 的每账号独立循环必须替换为**单一 next-due 定时器 + 有序到期表**，执行完全交给队列。账号的 `busy` 与调度状态通知改由 Operation 状态迁移驱动，避免账号视图的 `running` 与真实状态脱节。

## 3. 资源模型与全序

只保留三类约束，避免多套并发计数相互冲突：

1. **后台工作槽：4** —— 自动调度、立即运行、状态巡检、选择器检查进入统一队列，全局最多同时执行 4 个已获准运行的后台任务。
2. **Chrome 槽：4** —— 所有会启动 Chrome 的路径都必须申请同一个 Chrome 槽。登录和长期打开页面不占后台工作槽，但占 Chrome 槽。
3. **账号锁：每账号 1** —— 同一账号的 Profile 不能被两个任务或窗口同时使用。账号锁和 Chrome 槽由统一生命周期释放，禁止各调用方自行释放。

### 3.1 资源全序

资源类别上的全序为 **工作槽 < 账号锁 < Chrome 槽**，释放顺序相反。各参与方只取自己需要的子集，相对顺序一致即不成环：

| 参与方 | 申请顺序 |
| --- | --- |
| 后台任务（调度、立即运行、状态检测、选择器检查） | 工作槽 → 账号锁 → Chrome 槽 |
| 登录、打开长期页面 | 账号锁 → Chrome 槽（不取工作槽） |
| Profile 缓存维护 | 仅账号锁 |

排队任务不得预占 Chrome 槽。交互请求在等待 Chrome 槽期间不得持有后台工作槽。

### 3.2 账号锁的非阻塞语义

`locks.js` 新增 `tryAcquire(accountId)`、`release(handle)`、`onRelease(accountId, callback)`。现有 `withAccountLock`、`isBusy`、`isHeld` 的语义与签名**保持不变**。

- 后台条目取得工作槽后对账号锁执行 **try-lock**；失败则**立即释放工作槽**，条目转入 `stage=waiting_account`，挂在该账号锁的释放通知上等待（事件驱动，不轮询、不自旋）。否则少数长期开窗的账号会把工作槽占死，整个后台停摆。
- `onRelease` 必须在该账号的锁完全释放时无条件触发，**不区分**上一个持有者是队列、登录、打开网页还是 Profile 维护，否则队列会漏掉唤醒。
- 交互请求（登录、打开网页）同样使用 try-lock。失败即立即返回 `RESOURCE_BUSY`，与现有行为一致，不排队、不在未来突然弹窗。
- 队列中 `state=queued` 的条目不持有账号锁，因此不计入 `isBusy`。UI 需要的“该账号有排队任务”由队列提供 `isQueued(accountId)`。
- **quarantine 持有的账号锁计入 `isBusy`**（见 §11.4）。把 `close_failed` 的所有权留在锁里而不是另设一个旁路标志，正是为了让全部既有与新增消费者（Profile 维护、`accounts.remove`、`accounts.runNow`、`accounts.checkSelectors`、登录、打开网页、状态巡检、队列 try-lock，以及 `system.getActivity` 的聚合展示）获得一致行为；实现与测试必须逐站点核对，不能依赖一个容易过时的数量描述。

### 3.3 Chrome 槽的弹性高优先级等待

不抢占、不取消其他账号正在运行的任务：

- 无交互请求时，后台可占满 4 个 Chrome 槽。
- 交互请求（login / open-page）进入 Chrome 槽的最高优先级 FIFO 队列。此后任何**新释放**的槽优先给该队列，后台一律不得插队，直到该队列为空。
- 交互等待期间持有账号锁（try-lock 已成功，即该账号本来空闲），不持工作槽、不预占 Chrome 槽。Operation 停在 `stage=waiting_chrome`，`message` 说明前方等待数量。
- 用户可随时取消等待（关闭登录进度窗、`browser.closePage`）；取消即释放账号锁并退出队列。
- 优先级规则只保证“不被后台插队”，**不承诺交互启动延迟上界**。
- 同账号“打开网页”立即关闭该账号 headless 上下文的既有行为完整保留，不受本队列约束。

### 3.4 启动错峰

- Chrome 启动实行全局最小间隔，第一版固定为 1 秒。
- 启动许可由统一管理器发放，调用方不能自行 sleep 后绕过限制。

## 4. 统一后台队列

### 4.1 入队范围

用户立即运行、自动调度、用户手动状态检测、后台状态巡检、选择器检查。

登录和打开长期页面不进入后台工作队列，直接走 Chrome 槽的高优先级准入；它们仍受 Chrome 上限和账号锁约束。Profile 缓存维护不入队。

### 4.2 队列条目的最小字段模型

**去重维度与取消维度必须是两个独立字段。** 只用一个 `kind` 会产生一个真实缺陷：manual run 与 scheduled run 必须以同一个 dedupe key 去重（否则同账号会并发跑两次对话），但停止调度只应取消自动任务；若两者共用一个字段，一个被用户 `runNow` 命中并提升的 scheduled 条目会在 `scheduler.stop` 时被误取消，违反 §7.4“停止调度不影响用户任务”。

| 字段 | 用途 | 取值 |
| --- | --- | --- |
| `workKind` | **仅**用于 dedupe | `account-run` / `status-check` / `selector-check` |
| `dedupeParams` | 仅用于 dedupe | `selector-check` 取 `{ depth }`；其余为空 |
| `effectiveSource` | 优先级与取消判定 | `manual` / `scheduled` / `background` |
| `priority` / `seq` | 排序 | 由 `effectiveSource` 派生 |

`effectiveSource` 单调不降，偏序为 `background < scheduled < manual`。

### 4.3 优先级与公平性

优先级由 `effectiveSource` 决定，同级 FIFO，**不抢占正在运行的任务**：

1. `manual` —— 用户立即运行、手动状态检测、选择器检查
2. `scheduled` —— 自动调度
3. `background` —— 后台状态巡检

第一版不实现动态老化。队列不得因为每次轮询重新插队；已经排队的低优先级任务保持原始入队顺序。

### 4.4 去重与意图提升

- dedupe key = `(accountId, workKind, dedupeParams)`。**`effectiveSource` 不进 key**——manual run 与 scheduled run 同为 `workKind=account-run`，必须去重到同一条；手动状态检测与后台巡检同为 `status-check`，同理。
- `depth` 必须进 `dedupeParams`。`page` 深度的隐含契约是不在账号里留下对话，而 `conversation` 深度会真发一条消息；合并或“升级”都会产生调用方没有要求的副作用。key 不同即两个独立条目，禁止合并、禁止升级。
- 命中去重时**原子提升** `effectiveSource`（取两者较高意图）并返回**现有 Operation 的 id**。不建任何订阅者结构：`operation.changed` 是全局事件，Desktop 按 id 增量 upsert，命令重放由 `commandId` 收据机制负责。
- 提升与重排在同一个原子操作内完成，分两种：
  - 条目处于 `queued` / `waiting_work_slot` / `waiting_account`（不持有任何资源）：重算 `priority`，并分配新的单调 `seq`，进入新优先级带队尾。沿用旧 seq 会让被提升的条目插到更早的手动请求之前。
  - 条目处于 `waiting_chrome` / `launching` / `running`（已持工作槽 + 账号锁）：**只更新 `effectiveSource` 与展示用 `priority`，不重排、不抢占**。

#### 4.4.1 提升必须原子同步三处

一次提升要在同一个原子操作内同时更新下列三处，任一失败则整体不提升（保持提升前的一致状态）：

1. **队列条目**：`effectiveSource`、`priority`、`seq`；
2. **Operation**：并推送 `operation.changed`，让 Desktop 增量更新；
3. **已创建的 BrowserRun**：`effectiveSource` 与由它派生的 `purpose`（见 §10），并推送 `browserRun.changed`。

漏掉第 3 处会造成同一件事在两个地方有两个答案——一个正在运行的 `scheduled-run` 被 `runNow` 命中后，队列条目变成 `manual` 而 BrowserRun 与 UI 仍显示 `scheduled`，§7.4 的取消判定也会与展示不一致。

#### 4.4.2 closing 之后冻结意图

**进入 `stage=closing` 后不再提升。** 此后重复提交只复用 Operation id（去重仍然命中，调用方拿到同一个 id），`effectiveSource` 与 `purpose` 已结算、不再改变。两条理由：

- `closing` 阶段的意图已无操作意义——不会再影响优先级，也不会再影响 §7.4 的取消判定（它已经在关了）；
- `close_failed` 的记录会长期留在 `active` 并作为 blocker 展示，它的 `purpose` 必须是**事故发生时**的真实来源。允许事后改写会让排障记录不可信。

### 4.5 行为变更说明

分三种情形，不可混为一谈：

- **同 key 命中已存在条目**：复用该条目、提升 `effectiveSource`，返回**现有** Operation 的 id。
- **不同 `workKind`、账号被占用**：**创建一个新的 `queued` Operation** 并入队，返回新 id。它在 §3.2 的 try-lock 处等待账号锁，**不**与在跑的条目合并，也不存在“提升”。
- 因此 `accounts.runNow`、`accounts.checkSelectors`、`accounts.refreshStatus` 的行为变更精确表述为：从“立即返回 `RESOURCE_BUSY` / 返回缓存状态”改为“返回一个 Operation id”——同 key 时是既有条目的 id，否则是新建排队条目的 id。

`accounts.remove` 在账号忙或被长期持有时拒绝的语义**保持不变**。

### 4.6 队列快照

队列快照至少提供：总排队数、按 stage 分组的各等待阶段数量、运行数、关闭中数量、工作槽用量、Chrome 槽用量，以及按 `effectiveSource` 与 `workKind` 的分组计数（UI 需要区分“用户触发”与“自动”）。

## 5. Operation 与可观察状态

后台任务在**入队时**立即创建 Operation，而不是取得执行槽后才创建。

### 5.1 状态与阶段

`state` 集合冻结为 7 项，本次不增不减：

```text
queued | running | waiting_user | succeeded | failed | timed_out | cancelled
```

`waiting_user` 保留，且**仅用于登录**（登录不入后台队列）。它已被登录进度窗与任务页正确消费；归一到 `running` 会让进度窗退化成“运行中”，是功能倒退。

队列阶段全部落在 `stage`（契约中 `stage` 为自由字符串，新增阶段名不需要改契约）：

```text
state=queued:  stage=queued / waiting_work_slot / waiting_account
state=running: stage=waiting_chrome / launching / running / closing
state=终态:    succeeded / failed / timed_out / cancelled
```

禁止把 `closing` 提升为 `state`。

### 5.2 注册表接口

`OperationRegistry` 现有的 `create(kind, handler, options)` 保持不变（代理、Profile 等既有调用方不受影响）。新增 `declare(kind, options)`：只登记并落库一条 `state=queued` 的 Operation，**不启动 handler**；后续状态全部由队列通过 `update()` 推进。

### 5.3 blocksUpdate 是可逆的，不是一次性翻转

判定原则一句话：**`blocksUpdate` 反映“此刻是否持有工作槽 / 账号锁 / Chrome 槽，或处于活动执行”**，随资源持有情况双向变化。

| 迁移 | blocksUpdate |
| --- | --- |
| 入队（`queued` / `waiting_work_slot`） | `false` |
| 取得工作槽 | `true` |
| try-lock 账号锁失败、释放工作槽退回 `waiting_account` | **回落 `false`** |
| 再次取得工作槽 | 再置 `true` |
| `waiting_chrome` / `launching` / `running` / `closing` | 保持 `true` |
| 终态 | 由 `listActive` 自然排除 |

活动查询的 blocker 判定同时排除 `state=queued`（含已退回 `waiting_account` 且不持任何资源的条目）。

两条理由都必须成立：50–100 个排队条目若都成为 blocker，`system.prepareUpdate` 会永久返回 `ready:false`，Desktop 的“安全空闲时安装”永不触发，把眼前的卡顿换成一个再也装不上更新的应用；而若只做单向翻转，一个长期开窗的账号会让它的条目在工作槽上反复进出，每次退回都留下一个不持有任何资源的假 blocker，最终同样堵死更新。

### 5.4 计入与统计

- `launching`、`running`、`closing` 都计入账号 `busy` 和活动任务统计。
- `context.close()` 返回不代表任务已完成。

### 5.5 终态时序（硬约束）

注册表在 Operation 已是终态时会忽略后续更新。因此：**已创建 BrowserRun 的队列条目，其 Operation 在该 BrowserRun 到达 `closed` 或 `close_failed` 之前禁止写入任何终态**，否则关闭信息会被永久丢弃且不报错。

**尚未创建 BrowserRun 的条目可以直接落终态**，无需等待任何关闭：`queued`、`waiting_work_slot`、`waiting_account`、`waiting_chrome` 阶段的语义复验取消（§7.2）、代理预检失败、`scheduler.stop` 取消排队条目、退出时取消排队条目，以及 Chrome 启动前的一切失败。若不加这条限定，条款文字会阻止全部正常取消路径。

结果分层，互不覆盖：

- Operation 的 `state` 由主任务结果决定。
- 关闭结果单独写入 `result.close = { ok, reason, error }`。
- BrowserRun 到达 `closed` 时必须显式写入 `result.close = { ok: true, reason, error }`（无关闭噪声时 `error:null`，优雅关闭抛错但强制回收成功时保留归一化错误）；到达 `close_failed` 时必须显式写入 `{ ok: false, reason, error }`。任何曾创建 BrowserRun 的终态 Operation，`result.close.ok` 必须是布尔值，禁止用字段缺失暗示成功。
- 关闭调用抛错但完整 owned 进程树已确认退出：**只记 `result.close.error`，不降级**主结果。
- BrowserRun 落到 `close_failed`（无法证明完整 owned 进程树消失）时：
  - 主结果为成功 → Operation 降级为 `failed`；
  - 主结果为取消 → Operation 为 `cancelled`，但**必须**同时写入 `result.close.ok=false`。`cancelled` 只表示主任务被取消，**不宣称资源已释放**（见 §1 与 §11.4）。

“关闭噪声不掩盖真实主结果”是既有性质，现有回归测试守着它，必须继续通过。

### 5.6 跨重启恢复

Agent 启动时把数据库中遗留的非终态 Operation 统一恢复为 `cancelled` 的机制**已存在**（持久化层的 `cancelUnfinishedOperations` 经注册表 `restore()` 调用），保留现有文案“Agent 重启，任务已中断”。禁止新增第二套恢复路径。

### 5.7 可选项（不属第一版必须项）

登录轮询目前每 250 毫秒无条件写一次 Operation，落库并广播事件，5 分钟登录约产生 1200 次写库与 1200 个事件。可改为仅在 `status` / `message` 变化时更新。与本次卡顿主题同源，但不阻塞主线。

## 6. 逾期任务恢复

移除重启后把逾期任务集中塞入 5 分钟窗口的做法：

1. 按持久化的原始 `nextAt` 从早到晚恢复。
2. 每个账号最多生成一个逾期补跑任务。
3. 同一时刻恢复的任务按 FIFO 入队。
4. 由后台并发上限、Chrome 上限和 1 秒启动间隔自然消化积压。
5. 补跑完成后只计算一个新的未来执行时间，不连续追赶多个历史周期。

## 7. 配置变更与语义复验

### 7.1 两个计数器只触发复验

维护两个进程内单调计数器，**都不落库**（重启时队列本来是空的），**都只用于触发复验，不用于判定失效**：

- `configEpoch`：在账号创建/更新/删除、设置更新、分组更新、代理节点启停的服务层 handler 中递增。在应用服务层递增，不放进 `store.js`（该模块被 CLI 共用，且有后端一次性配置约束）。
- `schedulerEpoch`：仅在调度启动/停止时递增。

计数器变化本身**不取消任何东西**，只意味着“该重新跑一遍逐条复验”。

### 7.2 复验是逐条且按任务语义的

执行时机：计数器变化时对全部 queued 条目跑一遍；以及每个条目准入前（取得工作槽后、try-lock 账号锁前）再跑一次。

判定项：

- 账号仍存在且 `enabled`。不满足 → `cancelled`，message“账号已删除或已停用”。
- **仅 `effectiveSource === 'scheduled'` 的条目**受调度状态约束：`schedulerEpoch` 与入队快照一致且调度仍在运行。不满足 → `cancelled`，message“调度已停止”。`effectiveSource` 已被提升为 `manual` 的条目**不因 `scheduler.stop` 取消**，即使它最初是自动入队的；`background`（巡检）条目也不受 `schedulerEpoch` 影响——巡检由自己的定时器控制，`scheduler.stop` 不停它。
- 出口可用性：账号的有效代理 id 非空时，对应节点必须存在、启用且未从订阅中消失。不满足 → `cancelled`，message“分组绑定的代理节点不可用”。这只是把启动时的必然失败提前到准入，给出可读原因而不是白起一次浏览器。
- 其余一切（间隔、jitter、巡检分钟、headless、备注、分组名、时区）**一律不判失效**。

改一个账号的备注不得取消其他账号的任务；改一个无关设置不得取消全部排队。

### 7.3 live config 与快照

准入时统一重新读取 live config 执行——启动路径本来就在启动时重读账号，正是为了排队很久后不使用旧出口。入队快照只保留：`accountId`、`workKind`、`dedupeParams`、`effectiveSource`、`priority`、`seq`、`schedulerEpoch`、`configEpochAtEnqueue`。

### 7.4 活动任务的取消边界

活动任务只在三种情况下收到取消信号：

1. 该账号被停用或删除；
2. 调度停止 —— **仅**取消 `effectiveSource` 仍为 `scheduled` 的条目；
3. 应用退出。

设置更新**不取消活动任务**，只影响后续入队。否则改一个无关设置就会杀掉正在跑的对话。

停止调度只取消 `effectiveSource === 'scheduled'` 的排队条目并阻止新自动任务入队，不影响 `manual` 条目（含被提升的）、不影响 `background` 巡检、不影响长期页面。长期页面不受配置失效取消、不受停止调度影响。

## 8. 取消：AbortSignal 与硬关闭

取消的**硬保证来自关闭 BrowserRun**（上下文与进程关闭会让所有在飞的页面调用立刻失败）；AbortSignal 只是让干净路径尽快收敛。这个主次关系必须在实现中保持，否则会做成“到处传 signal 但仍然挂很久”。

### 8.1 可取消的等待

新增 `src/cancellation.js`：`cancellableSleep(ms, signal)`、`raceSignal(promise, signal)`。

可取消路径中禁止直接使用 `page.waitForTimeout` 与裸 `setTimeout` sleep。现有的等待停止按钮消失（最长 180 秒）、等待回复、轮次间隔、调度分段睡眠、巡检等待全部替换。

### 8.2 signal 贯穿链

队列条目 → 准入 → 账号锁等待 → Chrome 槽等待 → 启动错峰等待 → Chrome 启动 → 会话检查 → 对话执行 / 选择器探测 → 关闭。签名一律追加 `{ signal }`。

模块级的 `browserShutdownRequested` 全局标志由 BrowserRun 注册表的关闭状态取代，不新增新的全局标志。

### 8.3 取消的硬保证

收到取消后 **250 毫秒内**进入 `stage=closing`。关闭序列从进入 `closing` 起有 **5 秒总预算**，其内部切分与精确进程树回收见 §11。协作式 signal 未能及时退出**不得**延长这个总预算。

不引入后台单次运行的业务总时限。

## 9. Chrome 启动：broker 创建与身份屏障

有头与无头共用同一个 `ChromeProcessLauncher`，共用相同的进程登记、启动错峰和关闭代码。Windows 上 Chrome 必须经 Agent 级 `chrome-launcher` broker 创建，broker 在创建时把 root 放入 per-run Job 并独占 Job / root 进程句柄；Agent 只持 broker child 句柄和该次启动的 `runToken`，再通过调试端口接管。不接受任何“事后反查 PID”的替代方案。

### 9.1 启动序列（固定顺序）

1. 向已启动且健康的 broker 发送 `launch(requestId, runToken, chromeExe, args)`；broker 为该 token 建好 Job 后以无窗口创建方式启动 Chrome，并返回 root pid、root 创建时间与启动确认。args 只含 `about:blank` 作为唯一初始页，并附 `--no-first-run --no-default-browser-check`；**必须抑制既有 Profile 的会话恢复**。
2. `--remote-debugging-port=0` 并读取 `DevToolsActivePort`（复用现有实现，含旧端口文件的 mtime 陈旧防护）。这同时消除了“预留端口 → 关闭 → spawn”的抢占窗口，交互路径一并切换过来。
3. Raw CDP 连接先安装 `Target.setAutoAttach{ waitForDebuggerOnStart: true, flatten: true }`，以 `Target.getTargets` 作为安装屏障，并把既有 Target 全部处理完毕。现有的等待循环与安装失败即 fail-closed 的语义原样保留。
4. **之后**才 `connectOverCDP`。
5. 最后才执行业务导航。

### 9.2 会话恢复抑制由 spike 证明

不预先规定一套未验证的 Preferences 改写。要求为：显式 `about:blank` + 抑制恢复；具体采用命令行开关，还是把该专用 Profile 的 `session.restore_on_startup` 原子设为 **5**（新标签页），由 spike 证明。

- **禁止写 1**。Chromium 中 `1` 是“恢复上次会话”，`5` 才是“打开新标签页”。
- 若写 Preferences，必须复用既有 WebRTC 偏好写入的**同一原子读改写通道**，不新增第二条 Preferences 写路径。
- `exit_type` 是否需要归一为 `Normal`、`--disable-session-crashed-bubble` 是否必要，同样由 spike 判定，不当作已证明。
- 判定依据是 §9.3.2 的“既有 Profile 不恢复外部标签”测试。

### 9.3 spike 的两条判定测试

在阶段 C 改动 headless 启动路径之前完成，且都必须用“先红后绿”方式确认能失败。

#### 9.3.1 身份在首次外部交互前已生效（三层断言）

**首个 document 请求不会携带高熵 Client Hints，这是 UA-CH 的协议行为，不是缺陷。** 浏览器只在收到 `Accept-CH` 之后的后续请求上补发高熵 hints。现有的 `test/browserIdentity.integration.test.js` 已按此分层：`/main`、`/iframe`、`/popup`、`/new-page`、`/sw.js` 等首个请求只断言 legacy UA 不含 `HeadlessChrome`，而只有 `/iframe-fetch`、`/popup-fetch`、`/new-page-fetch` 这些在收到 `Accept-CH` 之后发出的请求才断言 `Sec-CH-UA-Full-Version-List` / `-Platform-Version` / `-Arch` / `-Bitness`。

因此断言必须分三层，**不得**对首个 document 请求断言高熵 hints：

1. **首个 document 请求**：legacy `User-Agent` **与**默认低熵 `Sec-CH-UA` brands 均不含 `HeadlessChrome`。两者都必须验证。
2. **首个页面脚本运行前**：JS 侧 `navigator.userAgent` 与 `navigator.userAgentData.getHighEntropyValues(...)` 已等于探测到的身份。这一层由 Raw CDP 的 auto-attach 屏障 + `Emulation.setUserAgentOverride` 在 `Runtime.runIfWaitingForDebugger` 之前完成来保证，也正是 §9.1 步骤 3 必须早于步骤 4 的原因。
3. **服务端发出 `Accept-CH` 之后的后续请求**：fetch / worker 请求携带匹配的高熵 headers，且与第 2 层的 JS 身份一致。

**第 1 层的低熵机制必须由 spike 实证，不得归因于 `--user-agent`。** `--user-agent` 只覆盖 legacy UA 字符串，与设置 `userAgentMetadata` 不等价（后者在现有实现里经 CDP `Emulation.setUserAgentOverride` 的 `userAgentMetadata` 字段设置）。现有集成测试**采集**了 `sec-ch-ua` 请求头但从未断言它，所以“当前实现的首个 document 低熵 brands 是否安全”今天仍是未知。spike 必须给出机制答案：自然低熵 brands 本就不含 `HeadlessChrome`？`--user-agent` 是否连带影响 brands？branded Chrome 与 bundled Chromium 是否表现不同？

**低熵 brands 泄漏 `HeadlessChrome` 构成阻塞**（见 §9.4）——Raw CDP 屏障建立在 `DevToolsActivePort` 可读之后，对首个 document 请求没有补救手段。可能的出路是启动时不向任何业务 URL 导航（§9.1 已要求唯一初始页为 `about:blank`，需确认首个 document 请求确实不会在屏障建立前发向外部），或把首次业务导航推迟到屏障确认安装完成之后；这两条出路的可行性同属 spike 范围。

新测试复用现有集成测试的服务器骨架与 `Accept-CH` 设置，重点是在 **broker 创建路径**上重跑这三层，而非替换现有用例。

**阶段 A 前置**：现有集成测试补一条对首个 document 请求 `sec-ch-ua` 的断言（数据已采集，只差断言），把这一层的现状从未知变成已知。成本极低，无论 spike 结论如何都要做。

#### 9.3.2 既有 Profile 不恢复外部标签

预置一个含外部 URL 会话的 Profile，断言启动后上下文只有 `about:blank`，且不存在指向该外部 URL 的 Target。这条测试同时是 §9.2 的判定依据。

现有身份集成测试的覆盖不足以在改坏时报警，所以这两条测试是 spike 的组成部分，不是事后补充。

### 9.4 spike 实证不可行时的处理

若 9.1 的步骤 3 → 4 顺序在实际 Chrome / Playwright 上被证明不可行（例如 `connectOverCDP` 自身的 attach 与已安装的 flatten auto-attach 屏障互相干扰），**必须停下并明确报出阻塞，回到讨论**。

不得降低身份屏障保证，不得退回 `launchPersistentContext`，不得以反查 PID 替代 broker 的创建时所有权凭据。

“不可行”的判定范围必须精确区分两件容易混同的事：

- 首个 document 请求**不携带高熵 hints**：这是 UA-CH 的正常协议行为，**不构成阻塞**，不得据此判定 spike 失败。
- 首个 document 请求的**低熵 `Sec-CH-UA` brands 泄漏 `HeadlessChrome`**：**构成阻塞**，且在 §9.3.1 给出的两条出路都被证明不可行时必须停下讨论。
- §9.3.1 的第 2、3 层失败：**构成阻塞**。

本节的停下规则同样适用于 §10.3.2 的进程 containment spike：两项 spike 并列为阶段 C 的阻塞前置，任一不可行都必须停下讨论，不得降低保证。

## 10. BrowserRun 生命周期与完整 owned 进程树

新增统一 BrowserRun 注册表，登录、打开页面、调度、状态检测和选择器检查都必须通过同一入口启动和关闭 Chrome。

每条记录至少包含：

```text
browserRunId
accountId
operationId（长期页面可为空）
purpose
effectiveSource（队列条目才有；login / open-page 为空）
profilePath
rootPid
rootStartTime
debugEndpointFingerprint
launcherRunToken（broker 内 per-run Job 的不可复用 token；见 §10.2 / §10.3）
brokerGenerationId
startedAt
state: waiting / launching / running / closing / closed / close_failed
closeReason
closeError
```

`purpose` 区分六项：`login`、`open-page`、`manual-run`、`scheduled-run`、`status-check`、`selector-check`。

`purpose` 按队列条目的**最终有效来源**映射，而不是入队时的来源——一个被 `runNow` 提升的自动条目必须显示为 `manual-run`：

| `workKind` + `effectiveSource` | `purpose` |
| --- | --- |
| `account-run` + `manual` | `manual-run` |
| `account-run` + `scheduled` | `scheduled-run` |
| `status-check`（`manual` 或 `background`） | `status-check` |
| `selector-check` | `selector-check` |

`login` 与 `open-page` 不经队列，映射保持不变。记录中同时保留 `effectiveSource`，供 UI 区分“用户触发”与“自动”。

实现约束：

- BrowserRun 创建后立刻登记；启动失败也要进入明确终态并释放已取得的资源。
- 长期页面始终显示账号、来源、根 PID、启动时间、运行时长和关闭状态。
- 强制回收前必须确认 BrowserRun 的 `launcherRunToken` 与 `brokerGenerationId` 仍匹配，且 broker 报告的 root pid / root 创建时间与记录一致。禁止只凭一个外部 PID 判断所有权。

### 10.1 所有权凭据

- Agent 持有的 **broker Node child 句柄与 `brokerGenerationId`**；
- broker 独占的 `launcherRunToken -> { per-run Job handle, root process handle, identity }` 记录（Windows：owned 集合的唯一权威来源，见 §10.2 / §10.3）；Agent **不得** `DuplicateHandle` 或以其他方式持有 per-run Job 的副本，否则 broker 崩溃时不再到达 last-handle，`KILL_ON_JOB_CLOSE` 无法触发；
- root pid **与创建时间**（Windows 上必须比对创建时间以防 PID 复用）；
- 调试端口与 `webSocketDebuggerUrl` 指纹。

`--user-data-dir` 命令行匹配只作为**辅助信号**用于日志与排障，**不得**作为所有权或完备性判据——它依赖 Chrome 未公开的命令行构造方式。

### 10.2 owned 集合的权威来源是 per-BrowserRun Job，不是进程扫描

**基于父子关系的周期性进程扫描不可用于证明完备性。** 两条独立的否证理由：

1. **不可见时间窗口**：扫描是周期性 OS 查询，两次采样之间新生的后代不在集合里。
2. **所有权证明不足**：root 退出后，孤儿的 `ParentProcessId` 仍指向那个已死的 PID 且不可解析（本机实测：该 PID 无法解析为任何存活进程），而该 PID 随时可被复用。历史父子关系无法在事后恢复。

因此 Windows 第一版直接采用 **per-BrowserRun Job Object**：

- owned 集合 = `QueryInformationJobObject(JobObjectBasicProcessIdList)`，**这是唯一权威来源**。后代由内核语义自动继承 Job，不需要"去查有哪些后代"，因此不存在采样窗口。
- 单个进程的归属核对用 `IsProcessInJob`。
- 强制回收 = `TerminateJobObject`（单次原子调用），不存在"杀一半"的中间态。
- **`closed` 的可证明判据** = broker 的 `QueryInformationJobObject` 返回 `NumberOfAssignedProcesses === 0`，随后 `dispose(runToken)` 成功并确认 active registry entry 已删除（允许留下等待 `forget` 的无句柄 tombstone）；两者缺一不可。
- **`close_failed` 的判据** = deadline 内该计数未归零。
- Job 创建时即设 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`。顺序硬约束：必须**先** `SetInformationJobObject`、**后**放入进程；反序会留下一段进程已在 Job 但 `KILL_ON_JOB_CLOSE` 未生效的窗口。

**`taskkill /T` 与按 pid 逐个 `taskkill` 从计划中删除**：前者按调用当时的父子关系展开，root 退出后彻底失效；两者都不如 `TerminateJobObject` 的原子性。仍然禁止 `taskkill /IM`、`pkill -f` 一类按镜像名的命令。

**POSIX 的保证弱于 Windows，必须承认这个不对称、不得假装等强**：POSIX 使用 per-run `setsid` 进程组（`detached: true` + `kill(-pgid, SIGKILL)`），子进程可自行 `setpgid` 逃逸。本项目的发布目标只有 Windows（发布脚本仅产出 win-x64），POSIX 只需在开发机可用，因此允许以进程组为准。

Agent 级 Job Object 只兜底 Agent / Desktop 的异常退出，**不替代**单次 BrowserRun 的回收。

### 10.3 创建即纳管：普通 spawn 后 assign 明确禁止

`AssignProcessToJobObject` **不追溯**——它不会把 root 已经创建的子进程补进 Job。而 Chrome 启动后的最初几百毫秒就在 spawn crashpad / gpu / renderer / utility，因此"普通 `child_process.spawn` 后立即 assign"会留下逃逸后代。

本机实测（Chrome 141 / Win11，assign 前立即采样已存在子进程，再用 `IsProcessInJob` 逐个核对）：

| assign 延迟 | assign 之前已存在的子进程 | 其中在 Job 内 | **不在 Job 内** |
| --- | --- | --- | --- |
| 500 ms | 1 | 0 | **1** |
| 1500 ms | 9（1 个已退出） | 0 | **8** |

这些逃逸进程在实测中最终仍然消失，但那是 **Chrome 自己的内部 Job** 在 root 死后回收了它们，不是我们的机制起作用。把正确性押在这个未公开的第三方实现细节上不可接受——它可以在任何一个 Chrome 版本改变。

同一禁令也适用于 §13.2 的 Desktop→Agent：本机已实测复现“Agent 先 spawn broker、Desktop 后 assign Agent”时 `agentInJob=true` 但 `brokerInJob=false`。`AssignProcessToJobObject` 不追溯，不能用“Desktop 通常更快”或“Agent 当前启动较慢”代替正确性保证。Agent 与 Chrome 都必须在创建时入 Job。

**Windows 第一版必须无窗口创建**，二者之一：

- **首选 `PROC_THREAD_ATTRIBUTE_JOB_LIST`**（Win8+）：`InitializeProcThreadAttributeList` → `UpdateProcThreadAttribute(PROC_THREAD_ATTRIBUTE_JOB_LIST, &job)` → `CreateProcessW(EXTENDED_STARTUPINFO_PRESENT)`。进程在**创建时刻**即在 Job 内，窗口为零，且不需要挂起 / 恢复，比备选少一个可能出错的环节。
- **备选 `CREATE_SUSPENDED`**：`CreateProcessW(CREATE_SUSPENDED)` → `CreateJobObject` + `SetInformationJobObject(KILL_ON_JOB_CLOSE)` → `AssignProcessToJobObject(root)` → `ResumeThread`。窗口内主线程未运行，等价无窗口。

两者都要求先建好 Job 再创建进程，因此 Job 的生命周期必须由**创建者**持有。

#### 10.3.1 随包 chrome-launcher broker

Node 没有任何内置方式调用带扩展属性的 `CreateProcessW`。第一版采用一个与 Agent 同生命周期的**随包 broker 可执行文件**，而非每个 BrowserRun 一个 helper、也不是原生模块：

- 位置 `agent/bin/chrome-launcher.exe`，与 `mihomo.exe` 同层。选它而不选 native addon / koffi / ffi-napi，是因为发布校验对原生二进制是严格白名单——只允许 `agent/node_modules/better-sqlite3/prebuilds/<rid>.node` 且**数量恰好为 1**，新增任何 `.node` 都会让发布校验失败，还要引入 C++ 构建链（当前工程无 node-gyp）。broker 是可执行文件，不触碰该白名单。
- 也不采用"由 Desktop 代为启动 Chrome"：那需要每个 BrowserRun 一次反向 IPC，且 Agent 必须能脱离 Desktop 独立运行。
- 实现可复用 Desktop 已有的 AOT 工具链（`PublishAot` + `AllowUnsafeBlocks` 已启用），或用 Rust / C。
- **启动、健康门与数量**：Windows Agent 组合根初始化时普通 `child_process.spawn` 一次 broker，并持有唯一 child 句柄；broker 在收到第一条合法 `launch` 之前绝不创建 Chrome。Agent 必须在接受 IPC 前完成有界 `ready` 握手，校验协议版本、`brokerGenerationId`、RID 与必需 capability。可执行文件缺失、EACCES、spawn error、握手超时 / 不匹配均以稳定错误码 `CHROME_BROKER_UNAVAILABLE` 使 **Agent 启动 fail-closed 并非零退出**，日志明确提示安装损坏 / 重新安装；不得启动一个没有 broker 的 Windows Agent，也不得退化成每个账号各自失败。Desktop 已按 §13.2 在**创建时刻**把 Agent 纳入 Agent 级 Job，因此 broker 及后续 Chrome 都继承该兜底。Agent 存活期间 broker 进程数恒为 1，不随 BrowserRun 数增长，也不在进程内重启 broker。POSIX 开发路径按 §10.2 使用进程组，不要求 Windows broker。
- **独占所有权与幂等记录**：broker 的 active registry 维护 `runToken -> { per-run Job handle, root process handle, rootPid, rootStartTime }`；每次 `launch` 都先建立设有 `KILL_ON_JOB_CLOSE` 的新 Job，再以 `PROC_THREAD_ATTRIBUTE_JOB_LIST` 创建 Chrome，Job / root 句柄从不传给 Agent。另维护已 dispose token 的 tombstone（`disposedAt`、最终 `count:0`、root identity）。`launch` 对 active / tombstone token 一律拒绝，token 永不复用；`enumerate` / `dispose` 命中 tombstone 时幂等返回 `{ count:0, disposed:true }`，而非报 unknown。
- **协议**：内部 stdin / stdout 行协议提供 `ready`、`launch`、`enumerate`、`terminate`、`dispose`、`forget`、`shutdown`；每条请求 / 响应均带 `requestId`、`brokerGenerationId`，除 `ready` / `shutdown` 外还带 `runToken`。命令只做短操作并立即响应，长等待由 Agent 反复 `enumerate`；stdout 只写协议帧，诊断写 stderr。stdin EOF 是异常 / 独立运行 Agent 被强杀时的紧急路径：broker 不等待 Agent ack，直接退出并关闭全部 per-run Job 句柄，使 `KILL_ON_JOB_CLOSE` 回收 Chrome。
- **dispose / forget 语义**：只有 `NumberOfAssignedProcesses === 0` 才允许 active token 的 `dispose`；成功时先关闭 Job / root 句柄、从 active registry 删除并写 tombstone，再返回成功。Agent 收到首次或重试的 disposed ack、完成 BrowserRun 状态迁移后发送可重试的 `forget(runToken)`；forget 对 tombstone / unknown 均幂等成功，broker 删除 tombstone。tombstone **不得按 TTL / LRU 提前驱逐**仍可能被 Agent 引用的 token；设置硬上限时只能 fail-closed 拒绝新 launch，不能牺牲幂等性。未确认 ack 的 tombstone 受未释放 Chrome 槽上限约束，已确认项由 forget 重试清理；正常验收要求 tombstone 数归零。单 run 的 dispose / forget 失败不得杀死全局 broker（否则会杀掉其他 run），而是按是否已取得 dispose 证明分别保持 `close_failed` 或只重试 forget。
- **broker 意外退出是 Agent 级 fatal**：非正常 shutdown 路径的 exit / EOF / 协议永久失联必须 `log.error`（exit code、signal、全部受影响 token）并触发现有 20 秒 fatal shutdown，最终 `process.exit(1)`。broker 独占全部 per-run Job 句柄，它退出已经使所有 Job 到达 last-handle 并由 `KILL_ON_JOB_CLOSE` 回收全部活动 Chrome；此时继续运行只会让 Agent 状态与现实脱节。不得把任何 run 乐观判 `closed`，也不得在进程内重启 broker。
- **Windows 独立运行边界**：不经 Desktop 直接启动 Agent 时没有 Agent 级 outer Job，broker 在 `ready` 中报告父 Agent 是否处于任意 Job，Agent 据此写一次 `log.warn`。per-run Job 的启动、枚举、终止与 dispose 保证仍完整；Agent 被强杀后依赖 stdin EOF → broker 退出 → `KILL_ON_JOB_CLOSE` 回收，这是该模式唯一的最终兜底，**不宣称与 Desktop 托管等强**，但不得因此拒绝开发 / CLI 启动。
- **发布资产校验**：必须为 broker 新增一条必需资产检查（存在性 + 可执行 + 与 RID 匹配），与 Node / mihomo 同等对待。

#### 10.3.2 containment 工程 spike（阶段 C 阻塞前置）

与身份屏障 spike **并列**为阶段 C 的两项阻塞前置。必须验证三项：

1. `PROC_THREAD_ATTRIBUTE_JOB_LIST` 在 Chrome 上可用，含 Chrome 自己给子进程套 Job 时的**嵌套**是否被内核接受；
2. **创建时纳管与嵌套 Job 可行**：Desktop 用 `PROC_THREAD_ATTRIBUTE_JOB_LIST` 创建的 Agent 从第一条指令起就在 Agent 级 Job，随后 broker 与 Chrome 全树继承；broker 持有的 per-run Job 同时包含对应 Chrome root 与全部后代，且 Chrome 自己的内部 Job 未造成 `BREAKAWAY` 冲突。需在打包后的 Desktop / broker 上复现本机原型结果；
3. broker 的多 token stdin / stdout 协议在 headless 与有头两条路径上都能承载启动、枚举、终止、dispose；两个并发 run 时注入 broker 崩溃，确认所有 per-run Job 的 `KILL_ON_JOB_CLOSE` 都触发、全部 Chrome 树归零，随后 Agent fail-fast。

任一项不成立即按 §9.4 的同一规则**停下讨论**：不得退回进程扫描轮询，不得接受创建竞态，不得降低完备性保证。

### 10.4 关闭的确认对象是完整树，不是 root

**root 退出不等于 closed。** 必须由 broker 确认 Job 内进程计数归零并完成 dispose 才能判 `closed` 并释放 Chrome 容量。否则孤立的 renderer / GPU 进程仍活着却已释放槽位，实际项目进程超限，Profile 锁残留。

- 有残留：经 broker **立即** `TerminateJobObject`，**不等应用退出**。
- 无法证明完整树消失（计数未归零），或计数归零但 dispose 未确认 → `close_failed`。
- **禁止用"进程最终消失"倒推 containment 成立**——实测已证明 Chrome 自己的 Job 会掩盖我们的失败。判据只能是 `IsProcessInJob` / `QueryInformationJobObject`。

## 11. 单个 BrowserRun 的关闭与回收

### 11.1 单次关闭的总预算：5 秒

从进入 `stage=closing` 起，整个关闭尝试共享 **5 秒总预算**，内部切分为两段子预算：

- **子预算 A（正常退出），最多 4 秒**：经控制通道请求 Chrome 正常退出、等待 root 退出并断开控制连接；无论何时开始，都必须为 B 保留 deadline 前最后 1 秒。
- **子预算 B（至少保留 1 秒）**：通过 broker `terminate`，轮询 `enumerate` 确认 Job 内进程计数归零，并取得 `dispose(runToken)` 成功 ack。POSIX 对应为 kill / wait：root 已被 `wait` 回收，且对负 pgid 的存在性探测返回 `ESRCH`（`EPERM` 仍表示有成员）；无 broker dispose。

到达 5 秒 deadline 时 Job 计数仍非零，或未取得 broker 的 dispose ack → **立即** `close_failed`，不再延长。broker 进程自身的退出不属于单 run 预算；它只在 Agent 正常关闭时由 §12 的 20 秒整体预算处理。

这个 5 秒是**单次关闭尝试**的预算。§11.6 的自愈复验每一轮重试各自享有一份完整预算；不要读成“整个回收过程只有 5 秒”。

### 11.2 固定顺序

1. 原子地把状态改为 `closing`，启动 5 秒总预算计时；重复关闭请求复用同一个关闭 Promise。冻结 `effectiveSource` 与 `purpose`（§4.4.2）。
2. 停止向页面发送新命令，触发任务取消信号。**保留控制通道。**
3. **在子预算 A 内**：经保留的控制通道发出优雅关闭（`Browser.close` / Playwright `browser.close()`），等待 broker 报告的 root 退出；最晚在进入最后 1 秒时停止等待。
4. 断开页面与浏览器控制连接（若上一步已使其自然断开，此步为 no-op）。**此步受 A 的 deadline 约束，不得侵占为 B 保留的最后 1 秒**——Chrome 已挂死时 `browser.close()` 可能永不返回，必须与 deadline 竞速。
5. **在子预算 B 内**：向 broker 发 `terminate(runToken)`（Windows）/ `kill(-pgid, SIGKILL)`（POSIX）。
6. **在子预算 B 内**：Windows 轮询 broker `enumerate(runToken)` 直到 `NumberOfAssignedProcesses === 0`；POSIX 等 root wait 回收并轮询负 pgid 存在性直到 `ESRCH`。两者都受 deadline 约束，root 消失本身不能替代完整集合确认。
7. Windows 计数归零后立即发 `dispose(runToken)`；只有收到成功 ack（含 tombstone 幂等成功）且 broker active registry 已删除该 entry 才完成所有权释放。状态迁移后异步重试 `forget`，其失败只保留诊断 / 重试项，不反向把已证明 closed 的 BrowserRun 改成 `close_failed`。
8. 写入关闭原因和错误。
9. 按结果分流（见 §11.3 / §11.4）。
10. 按分支更新 Operation 与账号状态（见 §11.5）。

**顺序不可交换**：控制连接一旦拆除就无法再经 CDP 请求优雅退出，而 Windows 上的 `child.kill()` 是 `TerminateProcess`、不是优雅退出（Node 在 Windows 无 SIGTERM 语义，现有代码注释也承认这点）。用它冒充"正常退出"会跳过 Chrome 的 Profile 落盘与 `exit_type=Normal` 写入，反而触发 §9.2 要抑制的会话恢复气泡。现有交互式关闭路径的既有顺序（先 `browser.close()`，`finally` 再处理进程）正是这个道理。

**从进入 `closing` 起的每一个子步骤都在 5 秒总 deadline 内**，包括控制连接自身的断开。任何一步都不得以"等待清理"为由突破 deadline。

任务主体失败、关闭调用抛错或关闭调用挂起时，也必须走完第 3 至第 10 步。

### 11.3 closed

Windows 上 `closed` 的充要判据是：broker `enumerate` 已确认 Job 计数为 0，且 `dispose(runToken)` 成功 ack（首次或 tombstone 幂等响应）、active registry entry 已删除。满足后，对有关联 Operation 的 run 显式写 `result.close = { ok: true, reason, error }`（错误字段规则见 §5.5），再释放 Chrome 槽、账号锁、工作槽；`release()` 账号锁并触发 `onRelease`，唤醒等待该账号的队列条目；从 `active` 转入 `recent`。随后重试 `forget` 清 tombstone，但它不再持有 OS 资源，也不是 closed 前置。POSIX 的 closed 判据是 root 已 wait 回收且进程组存在性探测为 `ESRCH`。任何未取得对应平台证明的协议超时、断线或 dispose 失败都不得乐观进入本分支。

### 11.4 close_failed

- **释放后台工作槽**（否则队列吞吐会被僵尸吃掉）；
- **继续占用 Chrome 容量**，并**留在 `active`**（`state=close_failed`）。这是“OS 确认退出后才释放”的直接要求；释放容量会让 4 个僵尸之后仍能启动第 5 个 Chrome。
- **账号锁的所有权保留在 quarantine 中，不 release。** `isBusy(accountId)` 继续为真，全部账号锁消费者一律取不到——Profile 缓存维护（`withAccountLock`）、`accounts.remove`、登录、打开网页、队列 try-lock。若只设一个隔离标志而把锁放掉，Profile 维护会去清理一个仍被僵尸 Chrome 持有文件锁的 Profile，`accounts.remove` 也会放行删除一个 Profile 仍被占用的账号。
- 账号进入隔离态 `chromeReclaimFailed`，该账号后续任何 BrowserRun 一律拒绝；
- Operation 可落终态（成功降级为 `failed`；取消保持 `cancelled`），并显式写 `result.close = { ok: false, reason, error }`（见 §5.5）。**Operation 终态只表示结果已可呈现，不表示资源已释放；资源释放只发生在 `closed`。**
- 隔离的 BrowserRun 与其 Chrome 占用**继续作为活动查询的 blocker**，`kind: "chrome-reclaim-failed"`，`resourceId` 为 accountId；
- **禁止用户不经复验手动清除**。`browserRuns.close` 的语义是“对该 BrowserRun 精确重试关闭 / 复验”，不是从列表里删掉。
- Chrome 容量耗尽时 **fail-safe**：新的启动申请一律以明确错误拒绝（“Chrome 容量已被未回收的进程占满，请在活动 Chrome 明细中处理”），**绝不超上限**。

### 11.5 第 10 步按分支推送状态

| 分支 | Operation | 账号状态 | 资源 |
| --- | --- | --- | --- |
| `closed` | 更新终态 + `result.close.ok=true` | 推送 `busy=false` | Job 计数为 0、dispose ack 成功且 active registry 已删除 entry；释放 Chrome 槽、账号锁、工作槽；转 `recent`，异步 forget tombstone |
| `close_failed` | 更新终态（`failed` 或 `cancelled` + `result.close.ok=false`） | **不推送 `busy=false`**，改推 `busy=true` + `quarantine=true` | Chrome 容量与账号锁不释放；仅释放工作槽；留在 `active`；`chrome-reclaim-failed` blocker 存在；进入 §11.6 |

无条件推 `busy=false` 会与 §11.4 的 quarantine 直接冲突，让 UI 显示账号空闲而实际上任何操作都会被拒。

### 11.6 close_failed 的自愈复验

对每个 `close_failed` 的 BrowserRun 启动复验定时器（15 秒起，指数退避至 60 秒上限）。Windows 每次经 broker 执行：`enumerate(runToken)` 重新确认计数 → 若非零则再次 `terminate(runToken)` → 再确认 → 计数为 0 后重试 `dispose(runToken)`；命中 tombstone 的 enumerate / dispose 返回 `{ count:0, disposed:true }`，直接作为此前 ack 丢失场景的收敛证明，随后发送 forget。POSIX 每次再次 kill 负 pgid、wait root，并以 `ESRCH` 复核进程组为空。每轮重试各自享有一份 §11.1 的完整预算；只有取得对应平台的完整证明才算收敛。broker 仍存活但单次协议请求失败时保持 quarantine 并重试；broker 已退出则走 §10.3.1 的 Agent 级 fatal，不存在 root-only 退化判据或人工旁路。

确认完整树消失后：释放 Chrome 槽、`release()` 账号锁并触发 `onRelease`、解除账号隔离、推送 `busy=false`、转入 `recent`、推送 `browserRun.changed`。

没有这条自愈回路，一次僵尸就会让 `system.prepareUpdate` 与 Desktop 的“安全空闲时安装”永久不通，应用再也装不上更新。fail-safe 停机是正确的，但必须能自己走出来。

### 11.7 active 与 recent

- `active` = `waiting | launching | running | closing | close_failed`；
- `closed` 后转入 `recent`（上限 50 条或 30 分钟）；
- `close_failed` **不参与 recent 淘汰**，一直保留到完整树被确认消失；
- 查询接口同时返回两段；每次状态迁移推送一次 `browserRun.changed`。

## 12. Agent 退出流程

### 12.1 IPC 必须两段拆分

现状是关闭链在任何 Chrome 关闭之前就销毁了全部客户端，Desktop 从来收不到关闭期间的事件。因此把 IPC 服务的 `close()` 拆成两段：

- `stopAccepting()`：停止接受新连接（**不动已建立的连接**），并置内部拒绝标志——除活动查询、Operation 查询、BrowserRun 查询之外的方法返回 `AGENT_DRAINING`。**保留事件订阅**，最终事件继续推送。
- `destroy()`：摘除事件订阅、销毁全部客户端、清理 socket 文件。

### 12.2 关闭顺序

1. 置 draining，publish `agent.draining`。
2. `server.stopAccepting()`。
3. 停调度 next-due 定时器、停巡检定时器、停止队列准入。
4. 取消全部 queued 条目，逐条落 `cancelled` 并推事件。
5. 向全部活动条目发取消信号。
6. 关闭登录窗口与长期页面。
7. 并行关闭全部活动 BrowserRun（按 §11 的顺序与预算，含 broker `terminate`、Job 计数归零与 dispose ack）。
8. 有界等待队列与全部 Operation handler 收敛，**含 Profile 维护 Worker**。
9. 断言 broker active registry 已无任何 run entry；先尽力重试全部 pending forget，再发送 `broker.shutdown` 并等待 broker child 正常退出。broker 必须在响应前再次确认 **active registry** 为空；存在 active entry 时拒绝 shutdown，转 §12.3 的 fatal 路径，绝不靠退出 broker 冒充单 run 的正常回收。仅剩 tombstone 时可在 shutdown 中清空后正常退出，因为它们已不持有任何 Job / root 句柄。
10. flush 全部 Operation 与 BrowserRun 终态，并把最终事件推给仍连接的客户端。
11. `operations.seal()`。
12. 停止代理内核。
13. `repository.checkpoint()` → `repository.close()`。
14. 释放 store / history / status / proxy 后端。
15. `server.destroy()`。
16. 释放单实例锁。

`createAgent.stop()` 相应改为：`beforeStop` → `stopAccepting()` → 生命周期关闭（第 3–14 步）→ `services.dispose()` → `server.destroy()`（第 15 步）→ `afterStop`。`services.dispose()` 必须晚于第 10 步，否则最终事件的转发订阅已被摘掉。调用它的 `main.shutdown()` 在上述 Promise 完成后的 `finally` 执行第 16 步释放单实例锁；该责任不能因 `createAgent.stop()` 的边界而从顺序中丢失。

### 12.3 第 8 / 9 步未收敛时不得关库

若在有界强制收敛后 Operation handler / 维护 Worker 仍未归零，或 broker active registry 仍有 run entry、shutdown 未成功：

- **不得进入第 11 步 seal，不得进入第 13 步 checkpoint / close**；
- 必须 `log.error` 写出未归零对象（operationId / kind / accountId / Worker 标识 / broker runToken）与所处步骤；
- 直接交给整体 watchdog `process.exit(1)`，由 Desktop 的 Job 收树。

活 handler 在数据库关闭后写入，比不 checkpoint 更坏。

### 12.4 超时与幂等

- 单步超时 5 秒；整体硬超时 **20 秒**。整体超时必须 `log.error` 明确写出卡在第几步，然后 `process.exit(1)`。
- 信号处理改为复用现有的 `installShutdownHandlers`（已有 watchdog 与“第二次信号立即退出”语义），不再自建 `process.once`。
- `shutdown()` 幂等且可 await：第一次调用返回同一个 Promise。第二次信号视为用户明确要求不再等待，立即退出。

### 12.5 持久化的 flush / seal

- **运行期**：持久化失败记 `log.warn`（不再静默吞掉）+ 保留内存态 + `persistFailures++`。绝不反向覆盖业务主结果——一次瞬时写故障不应变成业务失败。
- **关闭期**：第 10 步 `flush()` 显式把全部非终态转终态并逐条落库，失败逐条 `log.error`；第 11 步 `seal()` 关闭写入口。
- seal 之后的任何写入是 invariant violation：`log.error` + `sealViolations++`。测试断言 `sealViolations === 0`；生产不抛（抛出会把记账问题升级成退出失败）。
- 第 13 步严格晚于 `seal()`，数据库关闭后不存在任何写路径。

### 12.6 Profile 维护 Worker

Profile 缓存维护继续使用 `withAccountLock`，不取工作槽、不取 Chrome 槽、不入队列——它只取单一资源类，按全序子集不成环。需要补的只有：关闭序列第 8 步必须跟踪并有界等待在跑的维护 Worker，超时 `worker.terminate()`。

## 13. Desktop 侧：等待时长与 Job Object

### 13.1 等待时长对齐

Agent 整体硬超时为 20 秒，Desktop 侧必须相应放宽，否则更新会在 Agent 仍在合法收尾时被判失败：

- 等待断连由 15 秒提到 **30 秒**（客户端现在会一直连到第 15 步 `server.destroy()`，这个等待第一次具有真实含义）；
- 等待 Agent 进程退出由 15 秒提到 **30 秒**；
- 超时后**不再只是放弃等待**：由 Job Object 兜底，并把该事件写入 Agent 日志文件。

### 13.2 Agent 创建时入 Job，并按进程世代管理

- Agent 启动器保留 `Process` 对象（不再启动后立即 Dispose）与 Job 句柄。
- Windows 每次启动创建**新的** Job，先设 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`，再以 `CreateProcessW` + `EXTENDED_STARTUPINFO_PRESENT` + `PROC_THREAD_ATTRIBUTE_JOB_LIST` 创建 Agent。Agent 在第一条用户代码执行前已经属于该 Job，其后 broker 与全部后代从出生即继承；Job 内只有 Agent 及其后代，Desktop 自身绝不入 Job。**禁止**退回 `Process.Start` 后再 `AssignProcessToJobObject`。
- 实现集中在 Desktop 的 Windows native process launcher：完整保留当前 `ProcessStartInfo` 的参数、工作目录与显式环境变量，正确构造 Windows command line 与 Unicode environment block；`CreateProcessW` 返回的 process / thread handle、attribute list 与 Job handle 全部由 `SafeHandle` / `finally` 管理。成功后用返回的进程句柄立即 `IsProcessInJob` 复核，再建立 `Process` / 退出等待；任何一步失败都 fail-closed。
- 第一版 Windows 最低版本满足 `PROC_THREAD_ATTRIBUTE_JOB_LIST`（Win8+）。属性初始化、更新或创建时纳管不可用时直接返回 Agent 启动失败，不得静默回退 post-start assign；非 Windows 开发路径继续用现有 `Process.Start`，不宣称具备 Windows Job 的同等保证。
- 订阅 Agent 进程退出：**Agent 退出或崩溃时立即关闭该 Job 句柄**，由 `KILL_ON_JOB_CLOSE` 回收仍存后代；随后为下一次启动创建全新 Job，世代之间不复用句柄。
- 正常优雅退出时该关闭是 no-op，**但仍必须执行**。
- 修掉的具体缺陷：旧实现在 Desktop 存活期间永不关闭 Job 句柄，Agent 崩溃留下的 Chrome 会继续活；退出超时分支也从不结束 Agent 进程。

**创建时纳管失败即启动失败（fail-closed）**：`CreateJobObject` / `SetInformationJobObject` / attribute list / `CreateProcessW` / `IsProcessInJob` 任一失败，必须立即 `TerminateProcess` 已创建但尚未交付的 Agent（若存在）、关闭 process / thread / attribute / Job 资源、写 Agent 日志，并向 UI 返回启动失败。只有验证 Agent 已在正确 Job 内后才发布“启动成功”和当前世代。**不允许继续运行一个没有兜底的 Agent**——那正是本次要修的残留场景。

**世代回调采用捕获式 + 幂等模型**：`Process.Exited` 是线程池回调，与下一次启动无同步。既要防止旧世代回调误关新世代的 Job，又不能让旧世代自己的 Job 因回调晚到而被跳过——后者会永久泄漏那个 Job 句柄，`KILL_ON_JOB_CLOSE` 永不触发，旧世代残留的 Chrome 继续活。因此：

- 每个世代创建时，回调**闭包捕获该世代自己的** `Process`、Job 句柄与 `generationId`，**不从共享字段读取**；
- 回调触发时，**无条件幂等关闭它自己捕获的那个 Job 句柄**——无论它是否仍是 current。这是它唯一的清理责任，绝不能被跳过；
- `generationId` **只用于**决定是否清空 / 修改当前共享字段（`_currentJob`、`_currentProcess`、`_currentGenerationId`）：一致才清，不一致则跳过共享字段的修改，但句柄该关照关；
- 关闭必须幂等（句柄置空后只关一次，用 `Interlocked.Exchange` 或 `SafeHandle` 的天然幂等）。这同时消掉另一个竞态：“退出全部”的超时兜底与 `Process.Exited` 回调可能同时试图关闭同一句柄，无幂等保护会抛 `ObjectDisposedException`；
- Job 世代管理与启动共用一把锁；下一次启动必须在旧世代 Job 关闭完成后才创建新 Job。
- 不接受启动时序竞态：实测反例必须固化为回归测试，证明旧 post-start assign 会让先出生的 broker 逃逸；创建时 Job 属性的正例必须证明“首条指令即 spawn 后代”的 Agent stub 及其后代全部在 Job 内。
- 两层职责必须同时存在：Desktop 持有的 **Agent 级 Job** 负责 Agent / broker / 全部 Chrome 在 Desktop 或 Agent 异常退出时的最终兜底；broker 独占的 **per-BrowserRun Job** 负责单 run 的创建时纳管、权威枚举、精确终止与 dispose。前者绝不替代后者。嵌套关系及 Chrome 自身内部 Job 必须通过 §10.3.2 的 spike。

### 13.3 退出语义

- **最小化到托盘**：Desktop 存活 → Job 存活 → Agent 与长期页面继续运行。
- **退出全部**：先走 `system.shutdown` 优雅关闭并等待进程退出；成功后关闭 Job 是 no-op。仅当等待超时才依赖 Job 兜底，且必须记日志。
- **Desktop 被强杀 / 崩溃**：Job 关闭 → Agent 及其 Chrome 进程树被系统回收。正常路径永不依赖强杀。
- **更新重启**：更新路径必须继续要求“确认 Agent 进程已退出”，确保 checkpoint 在旧 Desktop 退出前完成。

## 14. 契约与协议版本

新增方法：`queue.getSnapshot`、`browserRuns.list`、`browserRuns.close`。
新增事件：`queue.changed`、`browserRun.changed`。

以下四处必须在**同一次提交内**改完：

1. `contracts/ipc-v1.schema.json` 的 `method` 与 `eventName` enum；
2. `contracts/ipc-v1.methods.schema.json` 的参数 / 结果 DTO；
3. `src/agent/contractValidator.js` 的 `METHOD_CONTRACTS`；
4. 协议 minor：Agent 侧 `PROTOCOL_VERSION` 与 Desktop 侧 `AgentProtocol.Minor` 同时由 **2 升到 3**。

漏改事件名不会在启动期失败，而会在运行期被出站契约校验判为 INTERNAL 并销毁 socket——这是必须一次改完的原因。

`state` enum 不变；`stage` 是自由字符串，新增阶段名不需要改契约。新 blocker `kind: "chrome-reclaim-failed"` 是纯附加字符串，活动结果的 blockers 未约束 items，Desktop 已按 `资源 id ?? kind` 显示，无需改契约。

Desktop 与 Agent 由同一次发布整体打包替换，不存在长期混版。

## 15. 第一版 UI 完善

只增加定位和控制卡顿问题所必需的状态：

- 总排队任务数、运行任务数、关闭中任务数。
- Chrome 使用量，例如 `3 / 4`。**长期页面计入分母占用**，并在明细中单列，避免与后台任务数量混淆。
- 活动 Chrome 明细：账号、用途（`purpose`，按最终有效来源）、根 PID、启动时间、运行时长、状态。
- broker 健康状态、active registry / tombstone / pending-forget 数进入诊断快照；正常时 Agent 存活期间 broker 进程数恒为 1。它是 Agent 级基础设施，不按 BrowserRun 在 UI 中重复列进程。
- 队列条目区分“用户触发”与“自动”（来自 `effectiveSource`）；被提升的条目显示为用户触发。
- 提供按 BrowserRun 精确关闭 / 复验的操作。
- 任务取消、启动失败、关闭失败显示具体原因；`close_failed` 与账号隔离（quarantine）必须可见，并说明该账号在解除隔离前不接受新操作。
- **`result.close.ok === false` 的 `cancelled` 不得被 UI 或任何统计解释为“资源已释放”**：任务页必须显示“任务已取消，但 Chrome 未能回收”，Chrome 用量分母必须仍计入该 run，账号必须显示 quarantine。
- 队列各等待阶段（等工作槽 / 等账号锁 / 等 Chrome 槽）可见。

当后台活动任务显示为 0 时，所有仍存在的项目 Chrome 必须能在活动 Chrome 明细中找到对应记录。

## 16. 实施顺序

### 阶段 A：基线与回归测试

- 为现有残留路径、调度并发和状态不一致建立可重复失败测试。
- 记录当前任务入口、Chrome 启动入口、锁获取点和关闭入口，防止漏接。
- 补一条对首个 document 请求 `sec-ch-ua` 的断言（§9.3.1），把低熵 brands 的现状从未知变成已知。
- 补"普通 spawn 后立即 assign 会留下逃逸后代"的否证测试（§10.3 反例），锁死旧方案。
- Desktop→Agent 同样补创建时纳管正例与 post-start assign 反例（§13.2），防止 broker 在 outer Job 之外出生。

### 阶段 B：组合根、队列与状态

- 改造组合根注入，消除队列与 scheduler / statusMonitor / browser 的循环依赖。
- 实现统一后台队列、优先级 FIFO、并发 4、去重与提升、语义复验、快照。
- `OperationRegistry` 新增 `declare`；接入立即运行、自动调度、状态检测、选择器检查。
- 删除 statusMonitor 私有 worker 池；scheduler 改为单 next-due 结构。
- 实现 `locks.js` 的 try-lock / release / onRelease，并保持既有 API 语义不变。
- 重写逾期恢复逻辑。

### 阶段 C：Chrome 生命周期

**两项阻塞前置 spike 并列，任一不可行即停下讨论：**

- **身份屏障 spike**：§9.3 的两条判定测试与 §9.1 / §9.2 的实证；不可行则按 §9.4 停下。
- **进程 containment spike**：§10.3.2 的三项（`PROC_THREAD_ATTRIBUTE_JOB_LIST` 可用性、嵌套 Job、broker 多 token 协议与崩溃回收）；不可行则按同一规则停下，不得退回进程扫描轮询、不得接受创建竞态。

两项 spike 通过后才继续：

- 实现随包的单个 Agent 级 `chrome-launcher` broker（无窗口创建 + per-run Job 独占 registry + launch / enumerate / terminate / dispose / shutdown 协议），并补齐它的发布资产校验。
- 实现 `ChromeProcessLauncher`（经 broker 创建 + 身份屏障 + 统一有头/无头）。
- 实现 Chrome 槽、全局启动间隔、BrowserRun 注册表、per-run Job 与权威枚举。
- 实现幂等、有界、可精确强制回收的关闭流程；`close_failed` 隔离与自愈复验。
- 确保 Chrome 容量只在 Job 内进程计数归零、broker dispose ack 成功且 active registry entry 删除后释放；forget 只清无句柄 tombstone。

### 阶段 D：退出兜底、Desktop 与 UI

- 拆分 IPC 的 `stopAccepting` / `destroy`，落实 16 步关闭顺序、broker shutdown、flush / seal、未收敛不关库。
- Desktop 等待时长对齐，实现 `PROC_THREAD_ATTRIBUTE_JOB_LIST` 创建时纳管与按 Agent 世代管理的 Job Object；失败路径逐一验证无进程、句柄或世代状态泄漏。
- 升协议 minor 并同步四处契约。
- 补齐队列与 BrowserRun 查询接口、事件与 UI 状态。

### 阶段 E：端到端验收

- 运行 L1、L2、L3 三层验证。
- 所有故障注入通过、15 条验收矩阵全绿后才结束第一版。

## 17. 测试分层

- **L1 自动故障注入（每轮 Review 的 CI 门禁）**：假启动器 + 假进程句柄，可构造任意账号规模。覆盖：
  - **50–100 账号同时到期**下的队列与并发上限、启动间隔、优先级 FIFO（这是 #1 的主体——L2 只用 2–3 个 Profile，物理上无法构造这个规模）；
  - 正常关闭抛错、关闭永久挂起、root 退出但后代残留、root 退出前新生后代、根进程拒绝退出；
  - **containment 正例**：一个"首条指令即 spawn 后代"的 stub（进程 `main` 的第一条语句就创建若干子进程），断言在该进程执行任何后续用户代码**之前**，其后代已在 Job 内——判据是逐个 `IsProcessInJob === true`，随后 `TerminateJobObject` 使 `NumberOfAssignedProcesses === 0`；
  - **containment 反例（必须能变红）**：同一 stub 走"普通 spawn 后立即 assign"，断言存在 `IsProcessInJob === false` 的后代。这条把 §10.3 的实测（500 ms → 1 个逃逸、1500 ms → 8 个逃逸）固化成永久回归，防止后人改回旧方案；
  - Desktop Agent 启动正例：Agent stub 的首条指令立即 spawn broker stub，断言 Agent 与 broker 在任何后续用户代码前都 `IsProcessInJob === true`；旧 `Process.Start` 后 assign 路径必须能稳定复现 `agentInJob=true`、`brokerInJob=false`。逐项注入 Job / attribute / `CreateProcessW` / 归属复核 / 回调失败，断言进程、native handle 与世代字段都归零；
  - broker active registry entry 随已 launch 且未 dispose 的 BrowserRun 增减；错误 `runToken` / `brokerGenerationId` 被拒；注入“dispose 已成功但首次 ack 丢失”，复验必须通过 tombstone 幂等响应收敛、解除 quarantine，再由 forget 清零 tombstone，不能永久占槽；forget ack 丢失只触发重试、不反向改坏 closed；任何曾创建 BrowserRun 的终态 Operation 都显式携带布尔 `result.close.ok`；
  - broker 可执行文件缺失、EACCES、spawn error、ready 超时 / 协议或 RID 不匹配都使 Windows Agent 在接受 IPC 前以 `CHROME_BROKER_UNAVAILABLE` 非零退出，且不留下 broker / Agent 子进程；POSIX 路径不依赖该资产；
  - 两个以上活动 run 时注入 broker 崩溃，断言全部 per-run Job 的 `KILL_ON_JOB_CLOSE` 回收全部 Chrome 树、Agent fail-fast，旧非终态 Operation 跨重启恢复为 `cancelled`；
  - 启动失败、启动中取消、语义复验、去重与意图提升、`effectiveSource` 提升后不被 `scheduler.stop` 取消；
  - `close_failed` 的 quarantine（账号锁不释放、`busy` 不归零）、容量不释放、自愈复验解除；
  - 终态时序、blocksUpdate 双向可逆、**纯 queued 场景**（准入暂停或工作槽置 0）、关闭序列 seal 不变量。
  - 对应验收 1（队列与计数部分）、2、3、5、6、7、8、9、12、13、14。
- **L2 真实 Chrome 短任务 50 轮（脚本化，本地可无人值守）**：使用 2–3 个**未登录**的专用 Profile。会话检查会快速失败，但启动、CDP 接管、身份屏障、关闭、Job 回收、资源释放全部真实跑过。**只补真实 Chrome 的槽位与进程验证**，不承担 50–100 账号规模。真实 Chrome 的 containment 断言必须用 broker 调用 `IsProcessInJob` 逐个核对整棵树，**不得**用 `TerminateJobObject` 之后的存活数作判据——实测已证明 Chrome 自己的 Job 会掩盖我们的失败。每轮同时断言 broker active registry 与 BrowserRun 对齐并最终完成 forget；50 轮后 active registry、tombstone、pending-forget 均为 0，Agent 存活期间 `chrome-launcher.exe` 恰为 1，Agent 结束后为 0。覆盖验收 1（真实 Chrome 部分）、4、10、11 与 15 前半。
- **L3 真实账号 200 轮耐久（人工，最终验收）**：真实登录账号跑完整对话路径。覆盖验收 15 后半与全矩阵复核。

L1 / L2 只是把失败提前暴露，**不替代 L3**。第一版结束的判定始终是 15 条全部通过。

## 18. 必须通过的验收矩阵（15 条）

1. 50 至 100 个账号同时到期，后台活动任务和 Chrome 数量均不超过 4。（队列与计数由 L1 覆盖；真实 Chrome 的槽位与进程行为由 L2 补充。）
2. 任意两次 Chrome 启动间隔不小于 1 秒。
3. 同一账号永远不会同时启动两个占用相同 Profile 的 BrowserRun。
4. 已打开 2 个长期页面时，后台最多再运行 2 个 Chrome；长期页面保持可用。
5. 自动任务、状态巡检与手动任务竞争时，优先级和同级 FIFO 符合计划；已持有资源的条目不被重排或抢占。
6. 重复调度轮询、连续点击和重复状态刷新不会为同一账号积累重复任务：manual run 与 scheduled run 去重到同一条并提升 `effectiveSource`；`depth` 不同的选择器检查不被合并；不同 `workKind` 各自成条目而非合并。
7. 账号停用、删除会取消对应的失效排队任务；`scheduler.stop` **只**取消 `effectiveSource` 仍为 `scheduled` 的条目，**不取消**已被提升为 `manual` 的条目；修改备注、间隔、巡检分钟等**不会**取消任何其他账号或无关任务。
8. 注入正常关闭抛错、永久挂起、root 退出但后代残留、root 退出前新生后代、根进程拒绝退出：**Job 内进程计数未归零，或计数归零但 broker dispose 未确认，一律判 `close_failed`**（不得判 `closed`，且不得用“进程最终消失”倒推成立）；`close_failed` 期间 Chrome 容量继续被占用、账号锁保留在 quarantine（`isBusy` 为真、`busy` 不归零、Profile 维护与 `accounts.remove` 均被拒）、`chrome-reclaim-failed` blocker 存在；`cancelled` + `close.ok === false` 的条目在 UI 上显示为“任务已取消，但 Chrome 未能回收”，且 Chrome 用量分母仍计入该 run；容量耗尽时新启动被拒而非超上限；自愈复验确认计数归零并取得 dispose ack 后自动释放容量与账号锁并解除隔离。
9. Chrome 启动失败或启动中取消，不泄漏工作槽、账号锁、Chrome 槽、BrowserRun、broker active / tombstone 记录或进程，也不会使实际 Chrome 超过 4。Windows broker 首次 spawn / ready 失败则整个 Agent 在接受 IPC 前以 `CHROME_BROKER_UNAVAILABLE` fail-closed，不留下 Agent / broker 子进程。
10. Agent 正常退出、桌面程序强制退出后，本次运行启动的 Chrome 与 `chrome-launcher.exe` 最终均为 0。Agent 与“首条指令即 spawn”的 broker stub 从创建时刻就在 Desktop 的 Agent 级 Job；旧 post-start assign 反例能稳定证明 broker 会逃逸。Job 世代管理正确：Agent 崩溃后 Desktop 立即关闭该世代 Job 并回收 broker 与残留后代；任何创建时纳管步骤失败时启动被判失败且不留下运行中的 Agent、broker 或 native handle。
11. 用户在项目启动前自行打开的 Chrome 不被关闭。
12. Agent 重启后，旧的非终态 Operation 不再显示为正在运行。
13. 在准入暂停、或无任何条目持有资源的**纯 queued** 场景下，50 条排队条目均不成为 blocker，`system.prepareUpdate` 返回 `ready:true`；任一条目**每次**取得工作槽时成为 blocker，退回等待（try-lock 失败并释放工作槽）时取消 blocker。
14. **回收成功分支**：在等待回复中途取消 → Job 内进程计数在 5 秒预算内归零 → `dispose(runToken)` ack（首次或 tombstone 幂等响应）成功且 broker active registry 已删除该 entry → Operation 在 6 秒内到达 `cancelled` **且 `result.close.ok === true`** → BrowserRun 为 `closed` → Chrome 槽与账号锁已释放、`busy=false`；forget 最终清零 tombstone，但不阻塞前述 closed。
    **回收失败分支不属本条，归 #8**：Operation 可为 `cancelled` 但 `result.close.ok === false`，BrowserRun 为 `close_failed`，账号 quarantine，容量与账号锁不释放；UI 必须显示“任务已取消，但 Chrome 未能回收”，不得被解释为资源已释放。
15. 真实 Chrome 50 轮短任务（L2）后活动任务、BrowserRun、账号锁、broker active registry、tombstone 与 pending-forget 均为 0，Profile 无残留锁占用；Agent 存活期间 `chrome-launcher.exe` 恰为 1、Agent 结束后为 0。最终 200 轮真实账号耐久（L3）后上述计数仍为 0，且没有随轮数增长的 Chrome 进程、broker 进程、tombstone 或内存趋势。

## 19. Review 与修复规则

- 计划先由 GPT 与 Claude 讨论并修订，双方无实质异议后开始实现。本文件即为已收敛的结果。
- 第一版由 Claude 落地。
- 每轮代码 Review 由 GPT 执行，按严重程度列出可复现证据、影响和建议修复方向。
- 每轮修复前，GPT 与 Claude 先讨论 Review 结论；有分歧时以代码、测试和运行证据决定，不按角色强行定案。
- 修复优先交给 Claude。Claude 连续两轮修复后仍存在问题，则由 GPT 接手修复。
- **每轮新增的回归测试必须“先红后绿”**：临时回退被测修复，确认测试确实失败，再恢复修复确认通过。未经这一步的测试视为无效测试。
- 每轮修复后重新运行相关测试并由 GPT 再 Review；直到没有未解决问题且 15 条验收矩阵全部通过。
- 遇到 §9.4（身份屏障）或 §10.3.2（进程 containment）所述的 spike 实证不可行情形，**必须停下并回到讨论**，不得通过降低身份屏障、放弃 broker / Job 所有权凭据、退回进程扫描轮询或 post-start assign、接受创建竞态、放宽进程树确认来绕过。
