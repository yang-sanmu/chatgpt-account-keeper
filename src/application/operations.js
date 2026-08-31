import { randomUUID } from "node:crypto";
import { errorEnvelope } from "./errors.js";

const TERMINAL_STATES = new Set(["succeeded", "failed", "timed_out", "cancelled"]);

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function latestAccountRuns(operations) {
  const latest = new Map();
  for (const operation of operations) {
    if (operation.kind !== "account-run" || !operation.resourceId) continue;
    if (!["succeeded", "failed", "timed_out"].includes(operation.state)) continue;
    const finishedAt = Date.parse(operation.finishedAt);
    if (!Number.isFinite(finishedAt)) continue;
    const previous = latest.get(operation.resourceId);
    if (!previous || finishedAt >= Date.parse(previous.finishedAt)) {
      latest.set(operation.resourceId, operation);
    }
  }
  return [...latest.values()];
}

export class OperationRegistry {
  constructor(options = {}) {
    this._events = options.events;
    this._clock = options.clock ?? (() => new Date());
    this._retentionMs = options.retentionMs ?? 30 * 60 * 1000;
    this._maxTerminal = options.maxTerminal ?? 200;
    this._operations = new Map();
    this._waiters = new Map();
    this._log = options.log ?? null;
    this._sealed = false;
    this.persistFailures = 0;
    this.sealViolations = 0;
    // 可选的持久化后端（SQLite）。有它时任务结果和错误详情能跨 Agent 重启查询，
    // 内存 Map 只作为热缓存。
    this._store = options.store ?? null;
  }

  /**
   * 从持久化后端恢复历史任务。Agent 重启后"活动任务/错误中心"才不会是空的。
   * 上次遗留的未完成任务由后端标记为已取消，不会伪装成仍在运行。
   */
  restore() {
    if (!this._store) return 0;
    this._store.cancelUnfinished?.();
    let restored = 0;
    for (const operation of this._store.list?.({ limit: this._maxTerminal }) ?? []) {
      if (this._operations.has(operation.id)) continue;
      this._operations.set(operation.id, operation);
      restored++;
    }
    return restored;
  }

  /**
   * 运行期：持久化失败记 warn 并保留内存态，绝不反向覆盖业务主结果——一次瞬时写
   * 故障不应变成业务失败。但不再静默吞掉，否则最后一批任务的终态会无声丢失。
   *
   * seal 之后的任何写入是 invariant violation：记 error 并计数，生产不抛（抛出会把
   * 记账问题升级成退出失败），测试断言 sealViolations === 0。
   */
  _persist(operation) {
    if (this._sealed) {
      this.sealViolations++;
      try {
        this._log?.error?.(
          `Operation ${operation.id} 在 seal 之后仍尝试写入（invariant violation）`
        );
      } catch {
        // 日志失败不能再抛
      }
      return;
    }
    try {
      this._store?.save?.(clone(operation));
    } catch (error) {
      this.persistFailures++;
      try {
        this._log?.warn?.(
          `Operation ${operation.id} 持久化失败：${String(error?.message || error)}`
        );
      } catch {
        // 日志失败不影响业务
      }
    }
  }

  /** 关闭期：把全部非终态转终态并逐条落库。 */
  flush(message = "Agent 关闭，任务已中断") {
    let flushed = 0;
    for (const operation of [...this._operations.values()]) {
      if (TERMINAL_STATES.has(operation.state)) continue;
      this.update(operation.id, { state: "cancelled", stage: null, message, blocksUpdate: false });
      flushed++;
    }
    return flushed;
  }

  /** 关闭写入口。必须严格早于 repository.checkpoint()/close()。 */
  seal() {
    this._sealed = true;
    return { sealViolations: this.sealViolations, persistFailures: this.persistFailures };
  }

  get sealed() {
    return this._sealed;
  }

  /**
   * 只登记一条 state=queued 的 Operation，**不启动 handler**；后续状态全部由统一
   * 队列通过 update() 推进。create() 的语义是「立刻开跑」（现有代理 / Profile 调用方
   * 依赖它），无法表达「入队时就有 Operation、但还没获准运行」。
   */
  declare(kind, options = {}) {
    const now = this._clock().toISOString();
    const operation = {
      id: options.id ?? randomUUID(),
      kind,
      resourceId: options.resourceId ?? null,
      state: "queued",
      stage: options.stage ?? null,
      message: options.message ?? null,
      progress: options.progress ?? null,
      startedAt: now,
      updatedAt: now,
      finishedAt: null,
      result: null,
      error: null,
      // 排队条目默认不阻塞更新；取得工作槽时才由队列翻成 true。
      blocksUpdate: options.blocksUpdate === true,
      effectiveSource: options.effectiveSource ?? null,
    };
    this._operations.set(operation.id, operation);
    this._persist(operation);
    this._emit(operation);
    return this.get(operation.id);
  }

  create(kind, handler, options = {}) {
    const now = this._clock().toISOString();
    const operation = {
      id: options.id ?? randomUUID(),
      kind,
      resourceId: options.resourceId ?? null,
      state: "queued",
      stage: options.stage ?? null,
      message: options.message ?? null,
      progress: options.progress ?? null,
      startedAt: now,
      updatedAt: now,
      finishedAt: null,
      result: null,
      error: null,
      blocksUpdate: options.blocksUpdate !== false,
    };
    this._operations.set(operation.id, operation);
    this._persist(operation);
    this._emit(operation);

    Promise.resolve().then(async () => {
      this.update(operation.id, { state: "running" });
      try {
        const result = await handler({
          update: (patch) => this.update(operation.id, patch),
          operationId: operation.id,
        });
        // 成功即 100%。早先写的是 operation.progress ?? 1，而 operation 是活对象：
        // 中途上报过进度的任务会停在最后一个中间值（例如 0.75），进度条永远不满。
        this.update(operation.id, {
          state: "succeeded",
          result: result ?? null,
          progress: 1,
        });
      } catch (error) {
        const normalized = errorEnvelope(error);
        this.update(operation.id, {
          state: normalized.code === "TIMEOUT" ? "timed_out" : "failed",
          error: normalized,
          message: normalized.message,
        });
      }
    });

    return this.get(operation.id);
  }

  update(id, patch = {}) {
    const operation = this._operations.get(id);
    if (!operation || TERMINAL_STATES.has(operation.state)) return this.get(id);
    const nextState = patch.state ?? operation.state;
    Object.assign(operation, patch, {
      state: nextState,
      updatedAt: this._clock().toISOString(),
    });
    if (TERMINAL_STATES.has(nextState)) {
      operation.finishedAt = operation.updatedAt;
    }
    this._persist(operation);
    this._emit(operation);
    if (TERMINAL_STATES.has(nextState)) {
      for (const resolve of this._waiters.get(id) ?? []) resolve(this.get(id));
      this._waiters.delete(id);
      this.prune();
    }
    return this.get(id);
  }

  get(id) {
    const operation = this._operations.get(id);
    if (operation) return clone(operation);
    // 已从内存淘汰但仍在库里的历史任务：错误详情必须还能查到。
    if (!this._store?.list) return null;
    try {
      return this._store.list({ limit: 500 }).find((item) => item.id === id) ?? null;
    } catch {
      return null;
    }
  }

  listActive() {
    return [...this._operations.values()]
      .filter((operation) => !TERMINAL_STATES.has(operation.state))
      .map(clone);
  }

  list(options = {}) {
    const includeTerminal = options.includeTerminal !== false;
    const limit = Math.max(1, Math.min(500, Number(options.limit) || 200));
    // 内存里只保留最近的一批；要看更久之前的失败详情就走持久化后端。
    if (includeTerminal && this._store?.list) {
      try {
        const stored = this._store.list({ limit, includeTerminal });
        const merged = new Map(stored.map((operation) => [operation.id, operation]));
        for (const operation of this._operations.values()) merged.set(operation.id, operation);
        return [...merged.values()]
          .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
          .slice(0, limit)
          .map(clone);
      } catch {
        // 后端不可用时退回内存视图，不能因此让任务列表整体失败。
      }
    }
    return [...this._operations.values()]
      .filter((operation) => includeTerminal || !TERMINAL_STATES.has(operation.state))
      .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
      .slice(0, limit)
      .map(clone);
  }

  /** 每个账号的最新实际结果独立于全局任务列表上限，供重连快照补齐。 */
  listLatestAccountRuns() {
    let stored = [];
    try {
      stored = this._store?.listLatestAccountRuns?.() ?? [];
    } catch {
      // 与 list() 一样，存储不可用时保留内存视图。
    }
    const merged = new Map(stored.map((operation) => [operation.id, operation]));
    for (const operation of this._operations.values()) merged.set(operation.id, operation);
    return latestAccountRuns(merged.values()).map(clone);
  }

  waitForTerminal(id) {
    const current = this._operations.get(id);
    if (!current) return Promise.resolve(null);
    if (TERMINAL_STATES.has(current.state)) return Promise.resolve(this.get(id));
    return new Promise((resolve) => {
      const waiters = this._waiters.get(id) ?? [];
      waiters.push(resolve);
      this._waiters.set(id, waiters);
    });
  }

  prune() {
    const cutoff = this._clock().getTime() - this._retentionMs;
    // 每个账号额外保留一条实际结果；巡检和取消不应抹掉最后一次对话失败。
    const latestIds = new Set(latestAccountRuns(this._operations.values()).map((operation) => operation.id));
    const terminal = [...this._operations.values()]
      .filter((operation) => TERMINAL_STATES.has(operation.state))
      .sort((a, b) => Date.parse(a.finishedAt) - Date.parse(b.finishedAt));
    for (const operation of terminal) {
      if (!latestIds.has(operation.id) && Date.parse(operation.finishedAt) <= cutoff) {
        this._operations.delete(operation.id);
      }
    }
    const remaining = terminal.filter((operation) => this._operations.has(operation.id) && !latestIds.has(operation.id));
    while (remaining.length > this._maxTerminal) {
      this._operations.delete(remaining.shift().id);
    }
    try {
      this._store?.prune?.();
    } catch {
      // 清理失败只是留下更多历史行，不影响运行。
    }
  }

  _emit(operation) {
    this._events?.publish("operation.changed", clone(operation));
  }
}

export function isTerminalOperation(operation) {
  return !!operation && TERMINAL_STATES.has(operation.state);
}
