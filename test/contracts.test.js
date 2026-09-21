import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import {
  METHOD_CONTRACTS,
  assertMethodResultContract,
  assertOutgoingContract,
  assertRequestContract,
} from "../src/agent/contractValidator.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const schema = JSON.parse(
  fs.readFileSync(path.join(here, "..", "contracts", "ipc-v1.schema.json"), "utf8")
);
const methodSchema = JSON.parse(
  fs.readFileSync(path.join(here, "..", "contracts", "ipc-v1.methods.schema.json"), "utf8")
);

function validator() {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);
  ajv.addSchema(schema);
  ajv.addSchema(methodSchema);
  return ajv.getSchema(schema.$id);
}

test("IPC v1 canonical schema accepts requests, responses and events", () => {
  const validate = validator();
  const messages = [
    {
      id: "request-1",
      method: "system.hello",
      params: {
        protocol: { major: 1, minor: 0 },
        clientVersion: "0.1.0",
        capabilities: [],
      },
    },
    { id: "request-1", result: { ok: true } },
    {
      id: "request-2",
      error: {
        code: "CHROME_NOT_FOUND",
        message: "Google Chrome is required",
        retryable: false,
      },
    },
    {
      event: "scheduler.changed",
      seq: 1,
      instanceId: "346d2d5d-2b90-4dce-9b07-3b68fcb6f935",
      revision: 1,
      occurredAt: "2026-08-13T00:00:00.000Z",
      payload: { running: false },
    },
  ];

  for (const message of messages) {
    assert.equal(validate(message), true, JSON.stringify(validate.errors));
  }
});

test("IPC v1 schema rejects unknown methods and unstable error codes", () => {
  const validate = validator();
  assert.equal(
    validate({ id: "request-1", method: "internal.eval", params: {} }),
    false
  );
  assert.equal(
    validate({
      id: "request-2",
      error: { code: "SOMETHING_RANDOM", message: "bad", retryable: false },
    }),
    false
  );
});

test("every advertised IPC method has runtime parameter and result contracts", () => {
  assert.equal(Object.keys(methodSchema.$defs).length, 56);
  assert.deepEqual(
    Object.keys(METHOD_CONTRACTS).sort(),
    [...schema.$defs.method.enum].sort()
  );
  for (const [method, [paramsName, resultName]] of Object.entries(METHOD_CONTRACTS)) {
    assert.ok(methodSchema.$defs[paramsName], `${method} 缺少参数定义 ${paramsName}`);
    assert.ok(methodSchema.$defs[resultName], `${method} 缺少结果定义 ${resultName}`);
  }
  assert.throws(
    () => assertRequestContract({ id: "x", method: "accounts.runNow", params: { accountId: "wrong-field" } }),
    (error) => error.code === "VALIDATION_FAILED"
  );
  assert.throws(
    () => assertRequestContract({ id: "x", method: "settings.update", params: { patch: { unknown: 1 } } }),
    (error) => error.code === "VALIDATION_FAILED"
  );
  assert.throws(
    () => assertMethodResultContract("browser.openPage", { not: "an-operation" }),
    (error) => error.code === "INTERNAL"
  );
  assert.throws(
    () => assertMethodResultContract("accounts.create", {
      id: "account", enabled: true, switchRule: "random", minWindows: 1,
      maxWindows: 3, loggedIn: null, pageOpen: false,
    }),
    (error) => error.code === "INTERNAL"
  );
  assert.doesNotThrow(() => assertMethodResultContract("history.query", [{
    time: "2026-08-21T00:00:00.000Z",
    ok: true,
    setName: null,
    topic: null,
    totalRounds: 1,
    targetRounds: 2,
    stopReason: "future-reason",
    error: null,
    needReauth: false,
    rounds: [],
  }]));
});

test("新增账号登录选项通过真实 Agent 入站契约校验，且不污染退出参数", () => {
  const request = (method, params) => ({ id: "login-options", method, params });
  for (const closeOnSuccess of [false, true]) {
    for (const checkPromoOnSuccess of [false, true]) {
      assert.doesNotThrow(() => assertRequestContract(request("browser.startLogin", {
        accountId: "acc-new", force: false, closeOnSuccess, checkPromoOnSuccess,
      })));
    }
  }
  // 旧客户端仍能省略两个选项。
  assert.doesNotThrow(() => assertRequestContract(request("browser.startLogin", {
    accountId: "acc-old", force: true,
  })));
  for (const key of ["closeOnSuccess", "checkPromoOnSuccess"]) {
    for (const value of ["true", 1, null]) {
      assert.throws(() => assertRequestContract(request("browser.startLogin", {
        accountId: "acc-new", [key]: value,
      })), (error) => error.code === "VALIDATION_FAILED");
    }
    assert.throws(() => assertRequestContract(request("system.shutdown", {
      reason: "user-exit-all", force: true, [key]: true,
    })), (error) => error.code === "VALIDATION_FAILED");
  }
  assert.doesNotThrow(() => assertRequestContract(request("system.shutdown", {
    reason: "user-exit-all", force: true,
  })));
});

test("实证过的事件字段与 operation 状态由出站契约封住", () => {
  const event = (name, payload) => ({
    event: name,
    seq: 1,
    instanceId: "346d2d5d-2b90-4dce-9b07-3b68fcb6f935",
    revision: 1,
    occurredAt: "2026-08-25T00:00:00.000Z",
    payload,
  });

  assert.doesNotThrow(() => assertOutgoingContract(event("proxyNode.tested", {
    id: "node-1",
    ok: true,
    delay: 123,
    testedAt: "2026-08-25T00:00:00.000Z",
  })));
  assert.throws(
    () => assertOutgoingContract(event("proxyNode.tested", {
      id: "node-1",
      latencyMs: 123,
      error: null,
    })),
    (error) => error.code === "INTERNAL"
  );

  assert.throws(
    () => assertOutgoingContract(event("profile.changed", {
      kind: "profile-scan",
      name: null,
      result: {
        profiles: [{ name: "p", sizeBytes: 1, isOrphan: true }],
        orphans: [],
        totals: {},
      },
    })),
    (error) => error.code === "INTERNAL"
  );

  assert.throws(
    () => assertOutgoingContract(event("group.changed", {
      group: { id: "grp-1", name: "旧猜法" },
    })),
    (error) => error.code === "INTERNAL"
  );

  const operation = {
    id: "346d2d5d-2b90-4dce-9b07-3b68fcb6f935",
    kind: "profile-scan",
    resourceId: null,
    state: "interrupted",
    stage: null,
    message: null,
    progress: null,
    startedAt: "2026-08-25T00:00:00.000Z",
    updatedAt: "2026-08-25T00:00:00.000Z",
    finishedAt: null,
    result: null,
    error: null,
    blocksUpdate: false,
  };
  assert.throws(
    () => assertOutgoingContract(event("operation.changed", operation)),
    (error) => error.code === "INTERNAL"
  );
});

test("队列与 BrowserRun 的新方法、事件与 DTO 四处同步", () => {
  const validate = validator();

  // 事件名漏改不会在启动期失败，而会在运行期被出站契约校验判为 INTERNAL 并销毁
  // socket——所以两个新事件必须在 enum 里。
  for (const event of ["queue.changed", "browserRun.changed"]) {
    assert.equal(
      validate({
        event,
        seq: 1,
        instanceId: "346d2d5d-2b90-4dce-9b07-3b68fcb6f935",
        revision: 1,
        occurredAt: "2026-08-22T00:00:00.000Z",
        payload: {},
      }),
      true,
      `${event} 必须被 eventName enum 接受`
    );
  }

  assert.doesNotThrow(() => assertMethodResultContract("queue.getSnapshot", {
    queuedTotal: 3,
    waiting: { queued: 1, workSlot: 0, account: 2, chrome: 0 },
    running: 1,
    closing: 0,
    workSlots: { used: 1, limit: 4 },
    chromeSlots: { used: 2, limit: 4 },
    bySource: { manual: 1, scheduled: 2 },
    byWorkKind: { "account-run": 3 },
    admissionPaused: false,
    broker: { running: true, generationId: "abc" },
  }));

  const run = {
    browserRunId: "run-1",
    accountId: "acc-1",
    operationId: "op-1",
    purpose: "scheduled-run",
    effectiveSource: "scheduled",
    profilePath: null,
    rootPid: 1234,
    rootStartTime: 99,
    debugEndpointFingerprint: null,
    launcherRunToken: "run-token",
    brokerGenerationId: "gen",
    startedAt: "2026-08-22T00:00:00.000Z",
    state: "close_failed",
    closeReason: "close:job-not-empty",
    closeError: null,
  };
  assert.doesNotThrow(() => assertMethodResultContract("browserRuns.list", {
    active: [run],
    recent: [],
    chromeOccupancy: 1,
    quarantined: [{ accountId: "acc-1", reason: "chromeReclaimFailed" }],
  }));
  assert.doesNotThrow(() => assertMethodResultContract("browserRuns.close", { ok: false, run }));

  // purpose 是闭合集合：拼错会在运行期炸事件推送。
  assert.throws(
    () => assertMethodResultContract("browserRuns.list", {
      active: [{ ...run, purpose: "not-a-purpose" }],
      recent: [],
    }),
    (error) => error.code === "INTERNAL"
  );
  assert.throws(
    () => assertRequestContract({ id: "x", method: "browserRuns.close", params: { id: "wrong-field" } }),
    (error) => error.code === "VALIDATION_FAILED"
  );

  // Operation 的 effectiveSource 只允许三种意图。
  assert.equal(
    validate({
      id: "r",
      result: {
        id: "346d2d5d-2b90-4dce-9b07-3b68fcb6f935",
        kind: "account-run",
        resourceId: "acc-1",
        state: "queued",
        stage: null,
        message: null,
        progress: null,
        startedAt: "2026-08-22T00:00:00.000Z",
        updatedAt: "2026-08-22T00:00:00.000Z",
        finishedAt: null,
        result: null,
        error: null,
        blocksUpdate: false,
        effectiveSource: "manual",
      },
    }),
    true
  );
});

// 登录任务的每个阶段都必须能过 browser.getTask 的结果契约。
//
// 优惠检查期间任务处于 promo 阶段（不复用 saving，否则前端只能说"正在登录"）。
// 契约枚举漏掉这个值时，界面每次轮询任务都会撞上契约校验失败 —— 而且恰好只在
// 新建账号后的那几秒内发生，最难复现。这里把 loginProvider 会写的状态全列出来。
test("登录任务的所有阶段都被 browser.getTask 的结果契约接受", () => {
  const base = {
    accountId: "acc-1",
    force: false,
    message: "阶段消息",
    startedAt: new Date().toISOString(),
  };
  for (const status of [
    "opening", "clearing", "waiting", "promo", "saving", "success", "failed", "timeout",
  ]) {
    assertMethodResultContract("browser.getTask", { ...base, status });
  }
  assert.throws(
    () => assertMethodResultContract("browser.getTask", { ...base, status: "not-a-stage" }),
    /不符合契约/,
    "未知阶段仍应被拒绝，枚举不能放开成任意字符串"
  );
});
