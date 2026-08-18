import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { ApplicationServices } from "../src/application/services.js";
import {
  FrameDecoder,
  FrameProtocolError,
  decodeJsonFrame,
  encodeFrame,
} from "../src/agent/framing.js";
import {
  currentUserEndpoint,
  dataRootFromArgs,
  endpointFromArgs,
  canonicalDataRoot,
  assertUnixSocketPathFits,
  unixSocketPathLimit,
} from "../src/agent/endpoint.js";
import { AgentIpcServer } from "../src/agent/ipcServer.js";
import { createAgent } from "../src/agent/createAgent.js";

test("length-prefixed decoder handles partial and coalesced frames", () => {
  const first = encodeFrame({ id: 1, value: "中文" });
  const second = encodeFrame({ id: 2, value: true });
  const decoder = new FrameDecoder();
  assert.deepEqual(decoder.push(first.subarray(0, 3)), []);
  const frames = decoder.push(Buffer.concat([first.subarray(3), second]));
  assert.equal(frames.length, 2);
  assert.deepEqual(decodeJsonFrame(frames[0]), { id: 1, value: "中文" });
  assert.deepEqual(decodeJsonFrame(frames[1]), { id: 2, value: true });
});

test("decoder rejects a declared frame larger than its configured limit", () => {
  const decoder = new FrameDecoder({ maxFrameBytes: 8 });
  const header = Buffer.alloc(4);
  header.writeUInt32LE(9);
  assert.throws(() => decoder.push(header), FrameProtocolError);
});

test("endpoint parsing supports explicit launch arguments and stable per-user defaults", () => {
  assert.equal(endpointFromArgs(["--endpoint", "custom"]), "custom");
  assert.equal(endpointFromArgs(["--endpoint=other"]), "other");
  assert.equal(dataRootFromArgs(["--data-root", "data"]), "data");
  assert.equal(
    currentUserEndpoint({ platform: "win32", identity: "same-user" }),
    currentUserEndpoint({ platform: "win32", identity: "same-user" })
  );
  assert.equal(
    currentUserEndpoint({ platform: "win32", identity: "DOMAIN\\user" }),
    "\\\\.\\pipe\\gptaccountkeeper-agent-v1-" +
      createHash("sha256").update("DOMAIN\\user").digest("hex").slice(0, 16)
  );
  assert.match(
    currentUserEndpoint({ platform: "linux", uid: 42, runtimeDir: "/run/user/42" }),
    /gptaccountkeeper-agent-v1-42\.sock$/
  );
  const firstRoot = currentUserEndpoint({ platform: "win32", identity: "same-user", dataRoot: "C:\\one" });
  const secondRoot = currentUserEndpoint({ platform: "win32", identity: "same-user", dataRoot: "C:\\two" });
  assert.notEqual(firstRoot, secondRoot);
  assert.equal(canonicalDataRoot("C:\\One", "win32"), canonicalDataRoot("c:\\one", "win32"));
});

/**
 * macOS 的 sun_path 只有 104 字节，而 os.tmpdir() 在 macOS 上是
 * /var/folders/xx/<32 字符哈希>/T（约 50 字节）。默认端点曾经只剩 2 字节余量，
 * 用户名更长或多一段后缀就会 bind 失败，而底层报的是 EINVAL 不是"路径太长"。
 */
test("Unix socket 端点必须留在平台的 sun_path 上限内", () => {
  const longDataRoot = "/Users/a-fairly-long-account-name/Library/Application Support/GptAccountKeeper";

  // runtimeDir 显式给定：否则 linux 分支会去取宿主的 os.tmpdir()，在 Windows
  // 上拿到 C:\... 而让断言反映宿主而不是被测代码。
  for (const [platform, uid, runtimeDir] of [
    ["darwin", 501, "/tmp"],
    ["linux", 1000, "/run/user/1000"],
  ]) {
    const endpoint = currentUserEndpoint({ platform, uid, runtimeDir, dataRoot: longDataRoot });
    const bytes = Buffer.byteLength(endpoint, "utf8");
    assert.ok(
      bytes < unixSocketPathLimit(platform),
      `${platform} 端点 ${bytes} 字节，超出 ${unixSocketPathLimit(platform)}：${endpoint}`
    );
    // Unix socket 路径永远是 posix，宿主是 Windows 时也不能出现反斜杠。
    assert.ok(!endpoint.includes("\\"), `${platform} 端点不应包含反斜杠：${endpoint}`);
    assert.ok(endpoint.startsWith("/"), `${platform} 端点应是绝对 posix 路径：${endpoint}`);
  }

  // macOS 默认不应落在 /var/folders 那条长路径上。XDG_RUNTIME_DIR 优先级更高，
  // 而 Linux 宿主上通常设了它，所以断言默认值时必须显式排除。
  const previousXdg = process.env.XDG_RUNTIME_DIR;
  delete process.env.XDG_RUNTIME_DIR;
  try {
    assert.match(currentUserEndpoint({ platform: "darwin", uid: 501 }), /^\/tmp\//);
  } finally {
    if (previousXdg === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = previousXdg;
  }

  assert.equal(unixSocketPathLimit("darwin"), 104);
  assert.equal(unixSocketPathLimit("linux"), 108);

  // 超限时要给出可读错误，而不是把 EINVAL 留给调用方。
  assert.throws(
    () => assertUnixSocketPathFits(`/tmp/${"x".repeat(120)}.sock`, "darwin"),
    /超出系统上限/
  );
  // Windows 命名管道不受这个限制约束。
  assert.equal(
    assertUnixSocketPathFits(`\\\\.\\pipe\\${"x".repeat(200)}`, "win32"),
    `\\\\.\\pipe\\${"x".repeat(200)}`
  );
});

test("createAgent accepts persistence adapters, receipt store, and a pre-start dataRoot hook", async () => {
  const calls = [];
  let shutdownContext = null;
  const receiptStore = {
    async get() {
      return null;
    },
    async put(commandId) {
      calls.push(`receipt:${commandId}`);
    },
  };
  const agent = createAgent({
    endpoint: testEndpoint(),
    dataRoot: "D:/keeper-data",
    runtime: {
      ...minimalRuntime(),
      lifecycle: {
        shutdown: async (context) => {
          shutdownContext = context;
        },
      },
    },
    receiptStore,
    beforeStart({ dataRoot, runtime }) {
      calls.push(`before:${dataRoot}`);
      assert.equal(runtime.store.getAccounts().length, 0);
    },
  });
  await agent.start();
  assert.equal(agent.started, true);
  assert.equal(agent.dataRoot, "D:/keeper-data");
  await agent.services.execute({
    method: "scheduler.start",
    params: {},
    commandId: "f786be7a-4f1d-4b26-9e4f-9ebf86b28c01",
  });
  assert.deepEqual(calls, ["before:D:/keeper-data", "receipt:f786be7a-4f1d-4b26-9e4f-9ebf86b28c01"]);
  await agent.runtime.lifecycle.shutdown({ reason: "user-exit-all" });
  assert.equal(agent.started, false);
  assert.deepEqual(shutdownContext, { reason: "user-exit-all" });
});

function minimalRuntime() {
  const settings = { headless: true };
  return {
    store: {
      getAccounts: () => [],
      getGroups: () => [],
      getConversations: () => ({}),
      getSettings: () => settings,
    },
    scheduler: {
      running: false,
      status() {
        return { running: this.running, accounts: {}, lastResults: {} };
      },
      start() {
        this.running = true;
        return { running: true };
      },
      async stop() {
        this.running = false;
        return { running: false };
      },
    },
    proxies: {
      getNodes: () => [],
      status: () => ({ running: false }),
      getSubscriptionInfo: () => null,
      getMihomoInfo: () => null,
    },
    getCachedStatus: () => ({ state: null, loggedIn: false }),
    getAllCachedStatus: () => ({}),
    getOpenPages: () => ({}),
    validateSettingsPatch: () => null,
    restartStatusMonitor: () => {},
    stopStatusMonitor: () => {},
    agentVersion: "ipc-test",
    schemaVersion: 1,
    lifecycle: {},
  };
}

// macOS 上 os.tmpdir() + 完整 UUID 会超过 104 字节的 sun_path 上限，所以用
// /tmp 加截短的随机段：够唯一，又给测试留足余量。
function testEndpoint() {
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\gptaccountkeeper-test-${randomUUID()}`;
  }
  const base = process.platform === "darwin" ? "/tmp" : os.tmpdir();
  return path.posix.join(
    base.replace(/\\/g, "/"),
    `kpr-test-${randomUUID().replace(/-/g, "").slice(0, 12)}.sock`
  );
}

async function connect(endpoint) {
  const socket = net.createConnection(endpoint);
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  const decoder = new FrameDecoder();
  const messages = [];
  const waiters = [];
  socket.on("data", (chunk) => {
    for (const frame of decoder.push(chunk)) {
      const message = decodeJsonFrame(frame);
      const waiter = waiters.shift();
      if (waiter) waiter(message);
      else messages.push(message);
    }
  });
  return {
    socket,
    async next() {
      if (messages.length) return messages.shift();
      return new Promise((resolve) => waiters.push(resolve));
    },
    send(value) {
      socket.write(encodeFrame(value));
    },
  };
}

test("IPC requires hello, returns stable envelopes, and streams events", async (t) => {
  const services = new ApplicationServices({ runtime: minimalRuntime() });
  const server = new AgentIpcServer({
    services,
    endpoint: testEndpoint(),
    logger: { error() {} },
  });
  await server.listen();
  t.after(() => server.close());

  const rejected = await connect(server.endpoint);
  rejected.send({ id: "bad", method: "settings.get", params: {} });
  const first = await rejected.next();
  assert.equal(first.id, "bad");
  assert.equal(first.error.code, "PROTOCOL_MISMATCH");
  rejected.socket.destroy();

  const client = await connect(server.endpoint);
  t.after(() => client.socket.destroy());
  client.send({
    id: "hello",
    method: "system.hello",
    params: {
      protocol: { major: 1, minor: 0 },
      clientVersion: "test",
      capabilities: [],
    },
  });
  const hello = await client.next();
  assert.equal(hello.id, "hello");
  assert.equal(hello.result.agentVersion, "ipc-test");

  client.send({
    id: "start",
    method: "scheduler.start",
    params: {},
    commandId: randomUUID(),
  });
  const received = [await client.next(), await client.next()];
  const response = received.find((item) => item.id === "start");
  const event = received.find((item) => item.event === "scheduler.changed");
  assert.equal(response.result.running, true);
  assert.equal(event.instanceId, hello.result.instanceId);
  assert.equal(typeof event.seq, "number");
});

test("IPC mutation without commandId is rejected without invoking the method", async (t) => {
  const services = new ApplicationServices({ runtime: minimalRuntime() });
  const server = new AgentIpcServer({ services, endpoint: testEndpoint() });
  await server.listen();
  t.after(() => server.close());
  const client = await connect(server.endpoint);
  t.after(() => client.socket.destroy());
  client.send({
    id: "hello",
    method: "system.hello",
    params: {
      protocol: { major: 1, minor: 0 },
      clientVersion: "test",
      capabilities: [],
    },
  });
  await client.next();
  client.send({ id: "start", method: "scheduler.start", params: {} });
  const response = await client.next();
  assert.equal(response.id, "start");
  assert.equal(response.error.code, "VALIDATION_FAILED");
  assert.equal(services.runtime.scheduler.running, false);
});
