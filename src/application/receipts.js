const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

export class InMemoryReceiptStore {
  constructor(options = {}) {
    this._clock = options.clock ?? Date.now;
    this._ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this._entries = new Map();
  }

  async get(commandId, method = null) {
    this.prune();
    const entry = this._entries.get(commandId);
    if (!entry) return null;
    if (method && entry.method && entry.method !== method) {
      const error = new Error("commandId 已用于其他方法，不能复用");
      error.badRequest = true;
      throw error;
    }
    return entry.value;
  }

  async put(commandId, value, options = {}) {
    const ttlMs = options.ttlMs ?? this._ttlMs;
    this._entries.set(commandId, {
      expiresAt: this._clock() + Math.max(0, ttlMs),
      method: options.method ?? null,
      value,
    });
  }

  async delete(commandId) {
    return this._entries.delete(commandId);
  }

  prune() {
    const now = this._clock();
    for (const [id, entry] of this._entries) {
      if (entry.expiresAt <= now) this._entries.delete(id);
    }
  }
}

/**
 * Prevents duplicate execution even when equal commandIds arrive concurrently.
 * A persistent implementation only needs get/put; in-flight coalescing stays here.
 */
export class ReceiptCoordinator {
  constructor(store = new InMemoryReceiptStore()) {
    this.store = store;
    this._inFlight = new Map();
  }

  async execute(commandId, action, method = null) {
    const saved = await this.store.get(commandId, method);
    if (saved) return { ...saved, replayed: true };
    const inFlight = this._inFlight.get(commandId);
    if (inFlight) {
      if (method && inFlight.method && method !== inFlight.method) {
        const error = new Error("commandId 已用于其他方法，不能复用");
        error.badRequest = true;
        throw error;
      }
      const value = await inFlight.promise;
      return { ...value, replayed: true };
    }

    const run = Promise.resolve()
      .then(action)
      .then(async (value) => {
        const receipt = { value };
        await this.store.put(commandId, receipt, { method });
        return receipt;
      });
    const entry = { method, promise: run };
    this._inFlight.set(commandId, entry);
    try {
      const receipt = await run;
      return { ...receipt, replayed: false };
    } finally {
      if (this._inFlight.get(commandId) === entry) this._inFlight.delete(commandId);
    }
  }
}
