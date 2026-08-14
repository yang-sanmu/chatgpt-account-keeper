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

function testEndpoint() {
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\gptaccountkeeper-test-${randomUUID()}`;
  }
  return path.join(os.tmpdir(), `gptaccountkeeper-test-${randomUUID()}.sock`);
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
