import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildLegacyMigrationPlan } from "../src/migration/legacyPlan.js";
import { requiredFreeBytes, stageAndPromoteProfiles } from "../src/migration/profileCopy.js";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "keeper-copy-source-"));
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "keeper-copy-target-"));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(target, { recursive: true, force: true });
  });
  const write = (relative, data) => {
    const file = path.join(root, ...relative.split("/"));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof data === "string" ? data : JSON.stringify(data));
  };
  write("config/accounts.json", { accounts: [{ id: "a1", profileDir: "profiles/a1" }] });
  write("config/conversations.json", { sets: {} });
  write("config/settings.json", {});
  write("profiles/a1/Default/Cookies", "cookies");
  write("profiles/a1/Default/Service Worker/CacheStorage/item", "cache-storage");
  write("profiles/a1/SingletonCookie", "lock");
  write("profiles/orphan/Default/Local Storage/item", "orphan");
  return { root, target, plan: buildLegacyMigrationPlan(root) };
}

const ampleSpace = () => Number.MAX_SAFE_INTEGER;
const noReserve = { minimumReserveBytes: 0, reserveRatio: 0 };

test("profile copy stages, hashes, promotes and is idempotent", (t) => {
  const fx = fixture(t);
  const result = stageAndPromoteProfiles({
    plan: fx.plan,
    targetDataRoot: fx.target,
    migrationId: "migration-1",
    getAvailableBytes: ampleSpace,
    ...noReserve,
  });
  assert.equal(result.copiedProfiles, 2);
  assert.equal(fs.readFileSync(path.join(fx.target, "profiles/a1/Default/Cookies"), "utf8"), "cookies");
  assert.equal(fs.existsSync(path.join(fx.target, "profiles/a1/SingletonCookie")), false);
  assert.equal(fs.existsSync(path.join(fx.target, ".importing")), false);

  const replay = stageAndPromoteProfiles({
    plan: fx.plan,
    targetDataRoot: fx.target,
    migrationId: "migration-1",
    getAvailableBytes: ampleSpace,
    ...noReserve,
  });
  assert.equal(replay.copiedProfiles, 0);
  assert.equal(replay.reusedProfiles, 2);
});

test("profile copy refuses insufficient space, overlap and destination conflicts", (t) => {
  const fx = fixture(t);
  assert.throws(
    () =>
      stageAndPromoteProfiles({
        plan: fx.plan,
        targetDataRoot: fx.target,
        migrationId: "space",
        getAvailableBytes: () => 0,
        ...noReserve,
      }),
    (error) => error.code === "INSUFFICIENT_DISK_SPACE"
  );
  assert.throws(
    () =>
      stageAndPromoteProfiles({
        plan: fx.plan,
        targetDataRoot: path.join(fx.root, "new-data"),
        migrationId: "overlap",
        getAvailableBytes: ampleSpace,
        ...noReserve,
      }),
    /旧源码目录|互相包含/
  );

  fs.mkdirSync(path.join(fx.target, "profiles/a1"), { recursive: true });
  fs.writeFileSync(path.join(fx.target, "profiles/a1/unexpected"), "different");
  assert.throws(
    () =>
      stageAndPromoteProfiles({
        plan: fx.plan,
        targetDataRoot: fx.target,
        migrationId: "conflict",
        getAvailableBytes: ampleSpace,
        ...noReserve,
      }),
    (error) => error.code === "DESTINATION_CONFLICT"
  );
});

test("profile copy rejects tampered manifest paths and unowned staging", (t) => {
  const fx = fixture(t);
  const tampered = structuredClone(fx.plan);
  tampered.manifest.profileTrees[0].files[0].path = "../escape";
  assert.throws(
    () =>
      stageAndPromoteProfiles({
        plan: tampered,
        targetDataRoot: fx.target,
        migrationId: "tampered",
        getAvailableBytes: ampleSpace,
        ...noReserve,
      }),
    (error) => error.code === "UNSAFE_MANIFEST_PATH"
  );
  assert.equal(fs.existsSync(path.join(fx.target, "escape")), false);

  const stage = path.join(fx.target, ".importing", "foreign");
  fs.mkdirSync(stage, { recursive: true });
  fs.writeFileSync(
    path.join(stage, "migration-owner.json"),
    JSON.stringify({ migrationId: "someone-else", sourceFingerprint: "other" })
  );
  assert.throws(
    () =>
      stageAndPromoteProfiles({
        plan: fx.plan,
        targetDataRoot: fx.target,
        migrationId: "foreign",
        getAvailableBytes: ampleSpace,
        ...noReserve,
      }),
    (error) => error.code === "UNOWNED_STAGING"
  );
  assert.equal(fs.existsSync(stage), true);
});

test("disk requirement is copy size plus the larger reserve", () => {
  assert.equal(requiredFreeBytes(100, { minimumReserveBytes: 50, reserveRatio: 0.1 }), 150);
  assert.equal(requiredFreeBytes(1000, { minimumReserveBytes: 50, reserveRatio: 0.1 }), 1100);
});
