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
  assertRequestContract,
} from "../src/agent/contractValidator.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const schema = JSON.parse(
  fs.readFileSync(path.join(here, "..", "contracts", "ipc-v1.schema.json"), "utf8")
);

function validator() {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);
  return ajv.compile(schema);
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
  assert.deepEqual(
    Object.keys(METHOD_CONTRACTS).sort(),
    [...schema.$defs.method.enum].sort()
  );
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
    totalRounds: 1,
    targetRounds: 2,
    stopReason: "future-reason",
    rounds: [],
  }]));
});
