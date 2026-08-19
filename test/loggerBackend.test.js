import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  configureHistoryBackend,
  readHistory,
  redactLogMessage,
  recordConversation,
} from "../src/logger.js";

test("history backend receives scheduler and UI history access", () => {
  const recorded = [];
  const restore = configureHistoryBackend({
    recordConversation(accountId, entry) {
      recorded.push({ accountId, entry });
      return { id: 1 };
    },
    readHistory(accountId, limit) {
      return [{ accountId, limit }];
    },
  });
  try {
    assert.deepEqual(recordConversation("account-1", { ok: true }), { id: 1 });
    assert.deepEqual(readHistory("deleted-account", 25), [
      { accountId: "deleted-account", limit: 25 },
    ]);
    assert.deepEqual(recorded, [
      { accountId: "account-1", entry: { ok: true } },
    ]);
  } finally {
    restore();
  }
});

test("detached Agent diagnostics are written directly and redact URL credentials", (t) => {
  assert.equal(
    redactLogMessage("fetch https://example.test/sub?token=secret password=hunter2"),
    "fetch https://example.test/… password=[REDACTED]"
  );
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "keeper-runtime-log-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const logFile = path.join(root, "agent.log");
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      "import { info } from './src/logger.js'; info('subscription https://example.test/sub?token=secret password=hunter2');",
    ],
    {
      cwd: path.resolve("."),
      env: { ...process.env, GPT_ACCOUNT_KEEPER_LOG_FILE: logFile },
      encoding: "utf8",
    }
  );
  assert.equal(result.status, 0, result.stderr);
  const written = fs.readFileSync(logFile, "utf8");
  assert.match(written, /https:\/\/example\.test\/…/);
  assert.doesNotMatch(written, /secret|hunter2/);
});

test("legacy JSONL history exposes the latest readable result", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "keeper-legacy-history-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const logs = path.join(root, "logs");
  fs.mkdirSync(logs, { recursive: true });
  fs.writeFileSync(
    path.join(logs, "account-1.jsonl"),
    [
      JSON.stringify({ time: "2026-08-18T10:00:00.000Z", ok: true }),
      "{damaged trailing row",
      "",
    ].join("\n"),
    "utf8"
  );
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      "import { listHistoryAccounts } from './src/logger.js'; console.log(JSON.stringify(listHistoryAccounts()));",
    ],
    {
      cwd: path.resolve("."),
      env: { ...process.env, GPT_ACCOUNT_KEEPER_STATE_ROOT: root },
      encoding: "utf8",
    }
  );
  assert.equal(result.status, 0, result.stderr);
  const account = JSON.parse(result.stdout)[0];
  assert.equal(account.lastAt, "2026-08-18T10:00:00.000Z");
  assert.equal(account.lastOk, true);
});
