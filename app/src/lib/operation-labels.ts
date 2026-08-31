// 操作类型的中文名与它作用的资源种类。
//
// 任务列表要显示「谁 + 做什么」，而 Operation 只给出 `kind` 与 `resourceId`。resourceId 的
// 含义**随 kind 变化**：账号类任务里它是账号 id，Profile 类里是目录名，代理类里是节点 id，
// 全局任务则没有。列表要把它渲染成人能读的东西，就必须先知道它是哪一种。
//
// kind 取值来自 src/application/services.js 的 enqueue 调用。

/// resourceId 指向的东西。
export type OperationResource = "account" | "profile" | "proxy" | "global";

interface OperationMeta {
  action: string;
  resource: OperationResource;
}

const OPERATIONS: Record<string, OperationMeta> = {
  "account-login": { action: "登录", resource: "account" },
  "account-run": { action: "立即运行", resource: "account" },
  "account-status-refresh": { action: "刷新状态", resource: "account" },
  "account-selector-check": { action: "检查选择器", resource: "account" },
  "account-busy": { action: "占用中", resource: "account" },
  "open-page": { action: "打开网页", resource: "account" },
  "open-page-start": { action: "打开网页", resource: "account" },
  "profile-scan": { action: "扫描 Profile", resource: "global" },
  "profile-cache-clean": { action: "清理缓存", resource: "profile" },
  "profile-orphan-archive": { action: "归档孤儿", resource: "profile" },
  "profile-orphan-purge": { action: "永久删除孤儿", resource: "profile" },
  "proxy-import": { action: "导入订阅", resource: "global" },
  "proxy-refresh": { action: "刷新订阅", resource: "global" },
  "proxy-test-all": { action: "全部测速", resource: "global" },
  "proxy-node-test": { action: "节点测速", resource: "proxy" },
  "proxy-node-toggle": { action: "启停节点", resource: "proxy" },
  "proxy-runtime-directory": { action: "设置运行目录", resource: "global" },
  "chrome-reclaim-failed": { action: "回收 Chrome 失败", resource: "account" },
};

/// 未知 kind 原样返回，并按「有 resourceId 就当账号」处理。
///
/// 不塌缩成「未知任务」：Agent 加了新 kind 时，原样显示那个 slug 仍然能让人查到它是什么，
/// 而统一显示「未知」会把新增任务和真正的异常混在一起。
export function describeOperation(kind: string, hasResourceId: boolean): OperationMeta {
  const known = OPERATIONS[kind];
  if (known) return known;
  return { action: kind, resource: hasResourceId ? "account" : "global" };
}

/// Chrome 运行的用途。browserRuns 用的是另一套枚举，不是 operation kind。
const BROWSER_PURPOSES: Record<string, string> = {
  login: "登录",
  "open-page": "打开网页",
  "manual-run": "手动运行",
  "scheduled-run": "自动调度",
  "status-check": "状态巡检",
  "selector-check": "检查选择器",
};

export function describeBrowserPurpose(purpose: string): string {
  return BROWSER_PURPOSES[purpose] ?? purpose;
}

/// 兼容旧版本已落盘的终态：旧队列会把关闭 Chrome 的进行中提示留在成功记录上。
///
/// 这只影响显示，不会改写 store 或持久化内容；非成功任务仍必须如实展示其当前消息。
export function normalizeOperationDisplay(
  state: string,
  stage: string | null,
  message: string | null
): { stage: string | null; message: string | null } {
  if (state !== "succeeded") return { stage, message };

  const hasStaleClosingStage = stage === "closing";
  const hasStaleClosingMessage = message === "正在关闭 Chrome";
  if (!hasStaleClosingStage && !hasStaleClosingMessage) return { stage, message };

  return {
    stage: hasStaleClosingStage ? null : stage,
    message: hasStaleClosingMessage ? "任务已完成" : message ?? "任务已完成",
  };
}
