import { randomUUID } from "node:crypto";

export class ApplicationEventBus {
  constructor(options = {}) {
    this.instanceId = options.instanceId ?? randomUUID();
    this._clock = options.clock ?? (() => new Date());
    this._seq = 0;
    this._revision = 0;
    this._listeners = new Set();
  }

  get revision() {
    return this._revision;
  }

  publish(event, payload = null) {
    const envelope = {
      event,
      seq: ++this._seq,
      instanceId: this.instanceId,
      revision: ++this._revision,
      occurredAt: this._clock().toISOString(),
      payload,
    };
    for (const listener of [...this._listeners]) {
      try {
        listener(envelope);
      } catch {
        // A UI connection must not be able to break application work.
      }
    }
    return envelope;
  }

  subscribe(listener) {
    if (typeof listener !== "function") throw new TypeError("listener must be a function");
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }
}
