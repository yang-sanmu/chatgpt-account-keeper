import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildLegacyMigrationPlan,
  verifyLegacyMigrationPlan,
} from "../src/migration/legacyPlan.js";

function createLegacyFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "keeper-legacy-plan-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (relative, value) => {
    const file = path.join(root, ...relative.split("/"));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value),
      Buffer.isBuffer(value) ? undefined : "utf8");
    return file;
  };

  write("config/accounts.json", {
    accounts: [
      {
        id: "a1",
        note: "one",
        profileDir: "profiles/a1",
        groupId: "g1",
        proxyId: "px1",
        enabled: true,
        rotation: { currentSet: "default", windowsDone: 2, windowsTarget: 3 },
      },
    ],
  });
  write("config/conversations.json", {
    sets: { default: { topic: "migration", minRounds: 1, maxRounds: 4 } },
  });
  write("config/settings.json", { intervalMinutes: 90, headless: false, customFuture: 1 });
  write("config/groups.json", { groups: [{ id: "g1", name: "group", proxyId: null }] });
  write("config/proxies.json", {
    subscription: { url: "https://example.test/sub?token=secret", updatedAt: "2026-01-01T00:00:00.000Z" },
    nodes: [{ id: "px1", name: "node", enabled: true, raw: { type: "http", password: "secret" } }],
  });
  write("config/status-cache.json", {
    version: 1,
    accounts: { a1: { state: "ok", loggedIn: true, checkedAt: "2026-01-01T00:00:00.000Z" } },
  });
  write("config/selectors.json", { url: "https://chatgpt.com" });
  write("profiles/a1/Default/Cookies", "cookie-state");
  write("profiles/a1/Default/Local Storage/value", "state");
  write("profiles/a1/SingletonLock", "runtime-lock");
  write("profiles/a1/DevToolsActivePort", "1234");
  write("profiles/orphan/Default/IndexedDB/value", "orphan-state");
  write("profiles-archive/archived/Default/Cookies", "archive-state");
  write(".profile-trash/residue/marker", "recover-me");
  write(
    "logs/a1.jsonl",
    [
      JSON.stringify({ time: "2026-01-01T00:00:00.000Z", ok: true, prompt: "p", reply: "r" }),
      "{broken",
      "",
    ].join("\n")
  );
  write(
    "logs/deleted-account.jsonl",
    `${JSON.stringify({ time: "2025-01-01T00:00:00.000Z", ok: false, reason: "old" })}\n`
  );
  return { root, write };
}

test("legacy plan preserves ordering/history/orphans and excludes Chrome locks", (t) => {
  const fixture = createLegacyFixture(t);
  const plan = buildLegacyMigrationPlan(fixture.root, {
    clock: () => new Date("2026-08-13T00:00:00.000Z"),
  });
  assert.match(plan.sourceFingerprint, /^[a-f0-9]{64}$/);
  assert.deepEqual(plan.counts, {
    accounts: 1,
    profiles: 2,
    archivedProfiles: 1,
    groups: 1,
    conversationSets: 1,
    proxyNodes: 1,
    statuses: 1,
    histories: 2,
    rejects: 1,
  });
  assert.equal(plan.data.accounts[0].profileName, "a1");
  assert.equal(plan.data.accounts[0].rotation.windowsDone, 2);
  assert.equal(plan.data.groups[0].proxyId, "px1");
  assert.equal(plan.data.settings.legacyExtra.customFuture, 1);
  assert.equal(plan.data.statuses[0].stale, true);
  assert.equal(plan.data.histories.some((entry) => entry.accountId === "deleted-account"), true);
  assert.equal(plan.requiresTrashDecision, true);
  assert.deepEqual(plan.manifest.trashResidues, ["residue"]);

  const a1 = plan.manifest.profileTrees.find((tree) => tree.name === "a1");
  assert.deepEqual(a1.skipped.sort(), ["DevToolsActivePort", "SingletonLock"]);
  assert.equal(a1.files.some((file) => file.path.includes("Cookies")), true);
  assert.equal(a1.files.some((file) => /Singleton|DevTools/.test(file.path)), false);
  assert.equal(verifyLegacyMigrationPlan(plan), true);
});

test("legacy plan detects source changes after the manifest is created", (t) => {
  const fixture = createLegacyFixture(t);
  const plan = buildLegacyMigrationPlan(fixture.root);
  fixture.write("config/settings.json", { intervalMinutes: 91 });
  assert.throws(
    () => verifyLegacyMigrationPlan(plan),
    (error) => error.code === "SOURCE_CHANGED"
  );
});

test("legacy plan rejects traversal, shared profiles, malformed JSON and invalid UTF-8", (t) => {
  const traversal = createLegacyFixture(t);
  traversal.write("config/accounts.json", {
    accounts: [{ id: "a1", profileDir: "../outside", enabled: true }],
  });
  assert.throws(
    () => buildLegacyMigrationPlan(traversal.root),
    (error) => error.code === "UNSAFE_PROFILE_PATH"
  );

  const malformed = createLegacyFixture(t);
  malformed.write("config/settings.json", "{");
  assert.throws(
    () => buildLegacyMigrationPlan(malformed.root),
    (error) => error.code === "INVALID_CONFIG_JSON"
  );

  const invalidUtf8 = createLegacyFixture(t);
  invalidUtf8.write("config/settings.json", Buffer.from([0xc3, 0x28]));
  assert.throws(
    () => buildLegacyMigrationPlan(invalidUtf8.root),
    (error) => error.code === "INVALID_UTF8"
  );
});

export { createLegacyFixture };
