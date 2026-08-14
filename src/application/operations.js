import { randomUUID } from "node:crypto";
import { errorEnvelope } from "./errors.js";

const TERMINAL_STATES = new Set(["succeeded", "failed", "timed_out", "cancelled"]);

function clone(value) {
  return value == null ? value : structuredClone(value);
}

export class OperationRegistry {
  constructor(options = {}) {
    this._events = options.events;
    this._clock = options.clock ?? (() => new Date());
    this._retentionMs = options.retentionMs ?? 30 * 60 * 1000;
    this._maxTerminal = options.maxTerminal ?? 200;
    this._operations = new Map();
    this._waiters = new Map();
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

  _persist(operation) {
    try {
      this._store?.save?.(clone(operation));
    } catch {
      // 持久化失败不能让业务操作失败；内存态仍然正确。
    }
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
    const terminal = [...this._operations.values()]
      .filter((operation) => TERMINAL_STATES.has(operation.state))
      .sort((a, b) => Date.parse(a.finishedAt) - Date.parse(b.finishedAt));
    for (const operation of terminal) {
      if (Date.parse(operation.finishedAt) <= cutoff) this._operations.delete(operation.id);
    }
    const remaining = terminal.filter((operation) => this._operations.has(operation.id));
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
