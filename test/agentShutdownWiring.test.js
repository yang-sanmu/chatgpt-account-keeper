import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createAgentIpcServer } from "../src/agent/ipcServer.js";
import { createAgent } from "../src/agent/createAgent.js";

function uniqueEndpoint(tag) {
  const suffix = `${process.pid}-${Math.random().toString(16).slice(2, 8)}`;
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\kpr-${tag}-${suffix}`;
  }
  return path.join(os.tmpdir(), `kpr-${tag}-${suffix}.sock`);
}

function stubServices() {
  const listeners = new Set();
  return {
    events: {
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      publish() {},
      get listenerCount() {
        return listeners.size;
      },
    },
    async execute() {
      return { ok: true };
    },
    dispose() {},
  };
}

function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
      timer.unref?.();
    }),
  ]);
}

test(
  "RED-A：stopAccepting 在存在已 accept 的连接时必须立即返回",
  { timeout: 10_000 },
  async (t) => {
    const services = stubServices();
    const endpoint = uniqueEndpoint("stopaccept");
    const server = createAgentIpcServer({ services, endpoint, logger: { error() {} } });
    await server.listen();

    // The server-side socket must be accepted before the assertion, otherwise
    // net.Server.close(cb) fires immediately and the test passes vacuously — the same
    // false-green shape as sampling a race with a fixed delay.
    const accepted = new Promise((resolve) => {
      const original = server._accept.bind(server);
      server._accept = (socket) => {
        const result = original(socket);
        resolve(socket);
        return result;
      };
    });
    const client = net.createConnection(endpoint);
    await new Promise((resolve, reject) => {
      client.once("connect", resolve);
      client.once("error", reject);
    });
    const serverSide = await accepted;
    assert.equal(serverSide.destroyed, false, "服务端连接应已建立且未销毁");

    t.after(async () => {
      client.destroy();
      await server.destroy().catch(() => {});
    });

    // net.Server.close(cb) only fires once every connection has ended. This phase must
    // keep clients connected to deliver the final events, so awaiting that callback here
    // self-locks and the whole 16-step shutdown never starts.
    await withTimeout(
      server.stopAccepting(),
      1_000,
      "stopAccepting 在保留客户端连接时自锁：它 await 了 net.Server.close 的回调"
    );

    // Existing connection must survive: it is what carries the final events.
    assert.equal(serverSide.destroyed, false, "stopAccepting 不得销毁已建立的连接");
    // Listening must have stopped synchronously. Asserting "a new connection is
    // refused" would be wrong here: on a Windows named pipe a connect against a closed
    // listener neither connects nor errors, it just hangs, so that probe would time the
    // test out rather than prove anything.
    assert.equal(server._listening, false, "stopAccepting 后必须停止监听");
    assert.equal(server.server?.listening ?? false, false, "底层 server 不应再监听");
    // The close promise must exist but must NOT be awaited by stopAccepting.
    assert.ok(server._serverClosePromise, "close 的完成状态必须被记下，供 destroy 等待");
  }
);

test(
  "close() = stopAccepting() + destroy() 不会二次 close 或 ERR_SERVER_NOT_RUNNING",
  { timeout: 10_000 },
  async () => {
    const services = stubServices();
    const endpoint = uniqueEndpoint("doubleclose");
    const server = createAgentIpcServer({ services, endpoint, logger: { error() {} } });
    await server.listen();
    const client = net.createConnection(endpoint);
    await new Promise((resolve, reject) => {
      client.once("connect", resolve);
      client.once("error", reject);
    });

    await withTimeout(server.stopAccepting(), 1_000, "stopAccepting 自锁");
    client.destroy();
    // destroy must await the SAME close promise rather than issuing a second close,
    // which would throw ERR_SERVER_NOT_RUNNING.
    await withTimeout(server.destroy(), 2_000, "destroy 未能完成");

    // The compat API is retained for old callers and must stay idempotent.
    await withTimeout(server.close(), 2_000, "兼容 close() 未能完成");

    // listen() must fully reset so the same instance can serve again.
    await server.listen();
    assert.equal(server._listening, true);
    await server.destroy();
  }
);

test(
  "RED-B：agent.stop 必须真正调用 lifecycle.shutdown，且 stopAccepting 早于它、destroy 晚于它",
  { timeout: 10_000 },
  async () => {
    const order = [];
    const agent = createAgent({
      endpoint: uniqueEndpoint("order"),
      server: {
        listen: async () => { order.push("listen"); },
        stopAccepting: async () => { order.push("stopAccepting"); },
        destroy: async () => { order.push("destroy"); },
        close: async () => { order.push("close"); },
      },
      runtime: {
        lifecycle: { shutdown: async () => { order.push("lifecycle.shutdown"); } },
      },
      afterStop: () => order.push("afterStop"),
    });
    const originalDispose = agent.services.dispose.bind(agent.services);
    agent.services.dispose = () => { order.push("services.dispose"); originalDispose(); };
    await agent.start();
    // Previously agent.stop awaited server.close() first, which self-locked on the live
    // connection and meant lifecycle.shutdown (the real 16-step sequence) never ran.
    await withTimeout(agent.stop({ reason: "test" }), 2_000, "agent.stop 挂住，16 步序列未进入");

    assert.ok(order.includes("lifecycle.shutdown"), "必须调用 lifecycle.shutdown");
    assert.ok(
      order.indexOf("stopAccepting") < order.indexOf("lifecycle.shutdown"),
      `stopAccepting 必须早于 lifecycle.shutdown，实际顺序 ${order.join(" -> ")}`
    );
    assert.ok(
      order.indexOf("destroy") > order.indexOf("lifecycle.shutdown"),
      `destroy 必须晚于 lifecycle.shutdown（否则最终事件推不出去），实际顺序 ${order.join(" -> ")}`
    );
    assert.ok(
      order.indexOf("services.dispose") > order.indexOf("lifecycle.shutdown"),
      "services.dispose 必须晚于最终事件推送"
    );
  }
);

test(
  "lifecycle.shutdown 抛错时仍执行 dispose/destroy 并重抛，afterStop 不被调用",
  { timeout: 10_000 },
  async () => {
    const order = [];
    const agent = createAgent({
      endpoint: uniqueEndpoint("failpath"),
      server: {
        listen: async () => {},
        stopAccepting: async () => { order.push("stopAccepting"); },
        destroy: async () => { order.push("destroy"); },
        close: async () => { order.push("close"); },
      },
      runtime: {
        lifecycle: {
          shutdown: async () => {
            order.push("lifecycle.shutdown");
            throw new Error("关闭序列失败");
          },
        },
      },
      afterStop: () => order.push("afterStop"),
    });
    const originalDispose2 = agent.services.dispose.bind(agent.services);
    agent.services.dispose = () => { order.push("services.dispose"); originalDispose2(); };
    await agent.start();

    await assert.rejects(() => agent.stop({ reason: "test" }), /关闭序列失败/);
    // Cleanup must not leak on the failure path.
    assert.ok(order.includes("services.dispose"), "失败路径也必须 dispose");
    assert.ok(order.includes("destroy"), "失败路径也必须 destroy");
    // afterStop keeps its original compat semantics: only after everything succeeded.
    assert.equal(order.includes("afterStop"), false, "afterStop 只在前面成功后调用");
    assert.equal(agent.started, false, "失败路径也必须复位 started");
  }
);

test(
  "RED-C：draining 期间只放行诊断查询，业务方法返回 AGENT_DRAINING",
  { timeout: 10_000 },
  async (t) => {
    const services = stubServices();
    const calls = [];
    services.execute = async (request) => {
      calls.push(request.method);
      if (request.method === "system.hello") {
        return { protocol: { major: 1, minMinor: 0, maxMinor: 3 } };
      }
      return { ok: true };
    };
    const endpoint = uniqueEndpoint("drain");
    const server = createAgentIpcServer({ services, endpoint, logger: { error() {} } });
    await server.listen();
    t.after(async () => { await server.destroy().catch(() => {}); });
    server._rejectBusiness = true;
    assert.equal(
      server.constructor.DRAIN_ALLOWED_METHODS.has("queue.getSnapshot"),
      true,
      "draining 期间必须放行队列快照，否则 UI 看不到关闭进展"
    );
    assert.equal(server.constructor.DRAIN_ALLOWED_METHODS.has("browserRuns.list"), true);
    assert.equal(server.constructor.DRAIN_ALLOWED_METHODS.has("system.getActivity"), true);
    assert.equal(
      server.constructor.DRAIN_ALLOWED_METHODS.has("accounts.runNow"),
      false,
      "业务方法不得在 draining 期间放行"
    );
    void calls;
  }
);
