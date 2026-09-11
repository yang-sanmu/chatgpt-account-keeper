import test from "node:test";
import { assertOutgoingContract } from "../src/agent/contractValidator.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createProfileManager, ProfileOperationError } from "../src/profileManager.js";

function fixture() {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "keeper-profiles-"));
  const profilesRoot = path.join(workspaceRoot, "profiles");
  const archiveRoot = path.join(workspaceRoot, "profiles-archive");
  const trashRoot = path.join(workspaceRoot, ".profile-trash");
  fs.mkdirSync(profilesRoot, { recursive: true });

  const write = (rel, bytes) => {
    const file = path.join(workspaceRoot, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.alloc(bytes, 1));
  };

  return {
    workspaceRoot,
    profilesRoot,
    archiveRoot,
    trashRoot,
    write,
    cleanup() {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    },
  };
}

test("scan distinguishes linked and orphan profiles and reports cache bytes", () => {
  const fx = fixture();
  try {
    fx.write("profiles/active/Default/Cache/data", 100);
    fx.write("profiles/active/Default/Cookies", 25);
    fx.write("profiles/orphan/Default/Code Cache/js/data", 200);
    fx.write("profiles/orphan/Default/Local Storage/data", 50);
    const manager = createProfileManager(fx);

    const result = manager.scan([{
      id: "a1",
      profileDir: "profiles/active",
      email: "owner@example.com",
    }]);

    assert.equal(result.totals.profiles, 2);
    assert.equal(result.totals.linked, 1);
    assert.equal(result.totals.orphans, 1);
    assert.equal(result.totals.cacheBytes, 300);
    assert.equal(result.totals.orphanBytes, 250);
    assert.deepEqual(result.profiles.find((profile) => profile.name === "active").accountLabels, [
      "owner@example.com",
    ]);
    assert.equal(result.orphans[0].name, "orphan");
  } finally {
    fx.cleanup();
  }
});

test("scan protects nested legacy profile references from orphan operations", () => {
  const fx = fixture();
  try {
    fx.write("profiles/legacy-container/nested/Default/Cookies", 25);
    const accounts = [
      {
        id: "legacy",
        profileDir: "profiles/legacy-container/nested",
      },
    ];
    const manager = createProfileManager(fx);

    const result = manager.scan(accounts);

    assert.equal(result.totals.linked, 1);
    assert.equal(result.totals.orphans, 0);
    assert.equal(result.profiles[0].nonStandardReference, true);
    assert.throws(
      () => manager.archiveOrphan("legacy-container", accounts),
      (error) => error instanceof ProfileOperationError && error.statusCode === 409
    );
  } finally {
    fx.cleanup();
  }
});

test("scan matches profile paths case-insensitively on Windows", { skip: process.platform !== "win32" }, () => {
  const fx = fixture();
  try {
    fx.write("profiles/active/Default/Cookies", 25);
    const manager = createProfileManager(fx);

    const result = manager.scan([{ id: "a1", profileDir: "PROFILES/ACTIVE" }]);

    assert.equal(result.totals.linked, 1);
    assert.equal(result.totals.orphans, 0);
  } finally {
    fx.cleanup();
  }
});

test("cache cleanup removes only allowlisted cache and preserves login storage", () => {
  const fx = fixture();
  try {
    fx.write("profiles/active/Default/Cache/data", 100);
    fx.write("profiles/active/Default/Code Cache/js/data", 200);
    fx.write("profiles/active/Default/Service Worker/CacheStorage/data", 400);
    fx.write("profiles/active/Default/Cookies", 25);
    fx.write("profiles/active/Default/Local Storage/data", 50);
    const manager = createProfileManager(fx);

    const result = manager.cleanCaches([{ id: "a1", profileDir: "profiles/active" }], {
      name: "active",
    });

    assert.equal(result.freedBytes, 700);
    assert.equal(fs.existsSync(path.join(fx.profilesRoot, "active", "Default", "Cache")), false);
    assert.equal(
      fs.existsSync(path.join(fx.profilesRoot, "active", "Default", "Code Cache")),
      false
    );
    assert.equal(
      fs.existsSync(
        path.join(fx.profilesRoot, "active", "Default", "Service Worker", "CacheStorage")
      ),
      false
    );
    assert.equal(
      fs.existsSync(path.join(fx.profilesRoot, "active", "Default", "Cookies")),
      true
    );
    assert.equal(
      fs.existsSync(path.join(fx.profilesRoot, "active", "Default", "Local Storage", "data")),
      true
    );
  } finally {
    fx.cleanup();
  }
});

test("自动清理保留 CacheStorage 与登录相关站点存储", () => {
  const fx = fixture();
  try {
    fx.write("profiles/active/Default/Cache/data", 100);
    fx.write("profiles/active/Default/Code Cache/js/data", 200);
    fx.write("profiles/active/Default/Service Worker/CacheStorage/data", 400);
    fx.write("profiles/active/Default/Network/Cookies", 25);
    fx.write("profiles/active/Default/IndexedDB/data", 50);
    const manager = createProfileManager(fx);
    const account = { id: "a1", profileDir: "profiles/active" };

    const before = manager.inspectAccountCache(account);
    const cleaned = manager.cleanAccountCache(account);

    assert.equal(before.cacheBytes, 300);
    assert.equal(before.cacheFiles, 2);
    assert.equal(cleaned.freedBytes, 300);
    assert.equal(
      fs.existsSync(
        path.join(
          fx.profilesRoot,
          "active",
          "Default",
          "Service Worker",
          "CacheStorage",
          "data"
        )
      ),
      true
    );
    assert.equal(
      fs.existsSync(path.join(fx.profilesRoot, "active", "Default", "Network", "Cookies")),
      true
    );
    assert.equal(
      fs.existsSync(path.join(fx.profilesRoot, "active", "Default", "IndexedDB", "data")),
      true
    );
  } finally {
    fx.cleanup();
  }
});

test("cache cleanup refuses paths redirected through a symlink or junction", () => {
  const fx = fixture();
  try {
    fx.write("outside-cache/Cache/data", 100);
    fs.mkdirSync(path.join(fx.profilesRoot, "linked", "Default"), { recursive: true });
    fs.rmSync(path.join(fx.profilesRoot, "linked", "Default"), { recursive: true });
    fs.symlinkSync(
      path.join(fx.workspaceRoot, "outside-cache"),
      path.join(fx.profilesRoot, "linked", "Default"),
      process.platform === "win32" ? "junction" : "dir"
    );
    const manager = createProfileManager(fx);

    const result = manager.cleanCaches([], { name: "linked" });

    assert.equal(result.freedBytes, 0);
    assert.equal(result.skipped.length, 1);
    assert.equal(fs.existsSync(path.join(fx.workspaceRoot, "outside-cache", "Cache", "data")), true);
  } finally {
    fx.cleanup();
  }
});

test("orphan archive moves the profile outside the active profiles directory", () => {
  const fx = fixture();
  try {
    fx.write("profiles/orphan/Default/Cookies", 25);
    const manager = createProfileManager(fx);

    const archived = manager.archiveOrphan("orphan", []);
    const after = manager.scan([]);

    assert.equal(archived.archived, true);
    assert.equal(fs.existsSync(path.join(fx.profilesRoot, "orphan")), false);
    assert.equal(after.totals.orphans, 0);
    assert.equal(after.totals.archiveCount, 1);
    assert.equal(fs.existsSync(path.join(fx.workspaceRoot, archived.path)), true);
  } finally {
    fx.cleanup();
  }
});

test("purge refuses an in-use account and orphan operations reject linked profiles", () => {
  const fx = fixture();
  try {
    fx.write("profiles/active/Default/Cookies", 25);
    const accounts = [{ id: "a1", profileDir: "profiles/active" }];
    const manager = createProfileManager({
      ...fx,
      accountBusy: (id) => id === "a1",
    });

    assert.throws(
      () => manager.purgeAccount(accounts[0]),
      (error) => error instanceof ProfileOperationError && error.statusCode === 409
    );
    assert.throws(
      () => manager.archiveOrphan("active", accounts),
      (error) => error instanceof ProfileOperationError && error.statusCode === 409
    );
    assert.equal(fs.existsSync(path.join(fx.profilesRoot, "active")), true);
  } finally {
    fx.cleanup();
  }
});

test("orphan purge permanently removes the selected direct child only", () => {
  const fx = fixture();
  try {
    fx.write("profiles/orphan/Default/Cache/data", 128);
    fx.write("keep.txt", 16);
    const manager = createProfileManager(fx);

    const result = manager.purgeOrphan("orphan", []);

    assert.equal(result.deleted, true);
    assert.equal(result.bytes, 128);
    assert.equal(fs.existsSync(path.join(fx.profilesRoot, "orphan")), false);
    assert.equal(fs.existsSync(path.join(fx.workspaceRoot, "keep.txt")), true);
    assert.throws(() => manager.purgeOrphan("../keep.txt", []), ProfileOperationError);
  } finally {
    fx.cleanup();
  }
});

test("account archive and purge restore the profile when account removal cannot commit", () => {
  const fx = fixture();
  try {
    fx.write("profiles/archive-me/Default/Cookies", 25);
    fx.write("profiles/purge-me/Default/Cookies", 30);
    const manager = createProfileManager(fx);
    const failCommit = () => {
      throw new Error("config write failed");
    };

    assert.throws(
      () =>
        manager.removeAccountWithProfile(
          { id: "archive-me", profileDir: "profiles/archive-me" },
          "archive",
          failCommit
        ),
      /config write failed/
    );
    assert.throws(
      () =>
        manager.removeAccountWithProfile(
          { id: "purge-me", profileDir: "profiles/purge-me" },
          "purge",
          failCommit
        ),
      /config write failed/
    );

    assert.equal(fs.existsSync(path.join(fx.profilesRoot, "archive-me")), true);
    assert.equal(fs.existsSync(path.join(fx.profilesRoot, "purge-me")), true);
    assert.equal(
      fs.existsSync(path.join(fx.profilesRoot, "archive-me", ".keeper-archive.json")),
      false
    );
  } finally {
    fx.cleanup();
  }
});

test("account purge commits configuration removal before final recursive deletion", () => {
  const fx = fixture();
  try {
    fx.write("profiles/purge-me/Default/Cookies", 30);
    const manager = createProfileManager(fx);
    let committedWhileProfileStaged = false;

    const result = manager.removeAccountWithProfile(
      { id: "purge-me", profileDir: "profiles/purge-me" },
      "purge",
      () => {
        committedWhileProfileStaged = !fs.existsSync(path.join(fx.profilesRoot, "purge-me"));
        return true;
      }
    );

    assert.equal(committedWhileProfileStaged, true);
    assert.equal(result.deleted, true);
    assert.equal(result.bytes, 30);
    assert.equal(fs.existsSync(path.join(fx.profilesRoot, "purge-me")), false);
  } finally {
    fx.cleanup();
  }
});

test("account profile mutation is blocked while another account references the same profile", () => {
  const fx = fixture();
  try {
    fx.write("profiles/shared/Default/Cookies", 30);
    const first = { id: "a1", profileDir: "profiles/shared" };
    const second = { id: "a2", profileDir: "profiles/shared" };
    const manager = createProfileManager(fx);
    let committed = false;

    assert.throws(
      () =>
        manager.removeAccountWithProfile(
          first,
          "purge",
          () => {
            committed = true;
            return true;
          },
          [first, second]
        ),
      (error) => error instanceof ProfileOperationError && error.statusCode === 409
    );
    assert.equal(committed, false);
    assert.equal(fs.existsSync(path.join(fx.profilesRoot, "shared")), true);
  } finally {
    fx.cleanup();
  }
});

test("detach removes a legacy account without touching its nonstandard profile path", () => {
  const fx = fixture();
  try {
    fx.write("legacy/outside/Default/Cookies", 25);
    const manager = createProfileManager(fx);
    let committed = false;

    const result = manager.removeAccountWithProfile(
      { id: "legacy", profileDir: "legacy/outside" },
      "detach",
      () => {
        committed = true;
        return true;
      }
    );

    assert.equal(result.retained, true);
    assert.equal(committed, true);
    assert.equal(fs.existsSync(path.join(fx.workspaceRoot, "legacy", "outside")), true);
  } finally {
    fx.cleanup();
  }
});

test("scan reports staged deletion residue separately", () => {
  const fx = fixture();
  try {
    fx.write(".profile-trash/residue/Default/Cache/data", 64);
    const manager = createProfileManager(fx);

    const result = manager.scan([]);

    assert.equal(result.totals.trashCount, 1);
    assert.equal(result.totals.trashBytes, 64);
  } finally {
    fx.cleanup();
  }
});


test("archived profiles remain visible, restore without overwriting and can be purged", () => {
  const fx = fixture();
  try {
    fx.write("profiles/orphan/Default/Cookies", 25);
    const manager = createProfileManager(fx);
    const archived = manager.archiveOrphan("orphan");
    assert.equal(manager.scan().archives[0].name, archived.name);
    for (const payload of [
      { kind: "profile-scan", name: null, result: manager.scan() },
      { kind: "profile-archive-restore", name: archived.name, result: { restored: true } },
      { kind: "profile-archive-purge", name: archived.name, result: { deleted: true } },
    ]) {
      assert.doesNotThrow(() => assertOutgoingContract({ event: "profile.changed", seq: 1,
        instanceId: "346d2d5d-2b90-4dce-9b07-3b68fcb6f935", revision: 1,
        occurredAt: new Date().toISOString(), payload }));
    }
    assert.equal(manager.scan().profiles.length, 0);
    fx.write("profiles/orphan/keep", 1);
    assert.throws(() => manager.restoreArchive(archived.name), /同名/);
    manager.purgeOrphan("orphan");
    assert.equal(manager.restoreArchive(archived.name).restored, true);
    assert.equal(fs.statSync(path.join(fx.profilesRoot, "orphan/Default/Cookies")).size, 25);
    assert.equal(manager.scan().archives.length, 0);
    const again = manager.archiveOrphan("orphan");
    assert.throws(() => manager.restoreArchive("../escape"), ProfileOperationError);
    assert.throws(() => manager.purgeArchive("../escape"), ProfileOperationError);
    assert.equal(manager.purgeArchive(again.name).deleted, true);
    assert.equal(manager.scan().archives.length, 0);
  } finally { fx.cleanup(); }
});

test("archive restore rejects a manifest outside the active profile root", () => {
  const fx = fixture();
  try {
    fx.write("profiles/orphan/Default/Cookies", 25);
    const manager = createProfileManager(fx);
    const archived = manager.archiveOrphan("orphan");
    fs.writeFileSync(path.join(fx.archiveRoot, archived.name, ".keeper-archive.json"), JSON.stringify({ originalProfile: "../escape" }));
    assert.throws(() => manager.restoreArchive(archived.name), ProfileOperationError);
    assert.equal(manager.scan().archives.length, 1);
  } finally { fx.cleanup(); }
});


test("restore requires a manifest and does not guess a name containing double underscores", () => {
  const fx = fixture();
  try {
    fx.write("profiles/original__name/Default/Cookies", 25);
    const manager = createProfileManager(fx);
    const archived = manager.archiveOrphan("original__name");
    assert.equal(manager.restoreArchive(archived.name).name, "original__name");
    const again = manager.archiveOrphan("original__name");
    fs.unlinkSync(path.join(fx.archiveRoot, again.name, ".keeper-archive.json"));
    assert.throws(() => manager.restoreArchive(again.name), /归档清单缺失/);
    assert.equal(manager.scan().archives.length, 1);
    assert.equal(manager.scan().profiles.length, 0);
    assert.equal(manager.purgeArchive(again.name).deleted, true);
  } finally { fx.cleanup(); }
});


test("background scan preserves busy flags without blocking the main event loop", async () => {
  const fx = fixture();
  try {
    fx.write("profiles/active/Default/Cookies", 100);
    const accounts = [{ id: "a", profileDir: "profiles/active" }];
    const manager = createProfileManager({ ...fx, accountBusy: (id) => id === "a" });
    const expected = manager.scan(accounts);
    let scanFinished = false;
    const pending = manager.scanAsync(accounts).then((result) => { scanFinished = true; return result; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(scanFinished, false, "main loop must run before the directory scan finishes");
    assert.deepEqual(await pending, expected);
  } finally { fx.cleanup(); }
});
