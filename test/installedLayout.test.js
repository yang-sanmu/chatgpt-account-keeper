import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createProfileManager } from "../src/profileManager.js";

/**
 * 安装布局回归。
 *
 * 一批线上故障（selectors ENOENT、"Profile 不在 profiles 直接子目录中"）根因相同：
 * 安装后 DATA_ROOT 指向 %LOCALAPPDATA%\...\data，与安装目录分离，而代码混用了两个
 * 根。CLI/开发模式下 DATA_ROOT 恰好等于源码根，所以整套测试都跨不过这个坎 ——
 * 它从没在分离布局下跑过。
 *
 * paths.js 在导入时把 DATA_ROOT 冻结成模块级常量，模块缓存无法在同一进程里重置
 * （目标模块内部的 `import "./paths.js"` 不带 query，一定命中缓存）。所以凡是要
 * 验证单例接线的用例都在子进程里跑。
 */

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "..");

function installedLayout(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "keeper-installed-"));
  const dataRoot = path.join(root, "data");
  fs.mkdirSync(path.join(dataRoot, "profiles"), { recursive: true });
  t.after(() => {
    // Windows 上句柄未完全释放时删除会 EPERM，重试几次即可。
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        fs.rmSync(root, { recursive: true, force: true });
        return;
      } catch {
        // 句柄可能仍在释放中
      }
    }
  });
  return dataRoot;
}

/** 在独立进程中以指定 DATA_ROOT 运行一段脚本，返回其 stdout 最后一行的 JSON。 */
function runInDataRoot(dataRoot, script) {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
    env: { ...process.env, GPT_ACCOUNT_KEEPER_DATA_ROOT: dataRoot },
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean);
  return JSON.parse(lines.at(-1));
}

test("单例 profileManager 在分离布局下把账号 Profile 解析到数据目录", (t) => {
  const dataRoot = installedLayout(t);
  fs.mkdirSync(path.join(dataRoot, "profiles", "acc_1", "Default"), { recursive: true });
  fs.writeFileSync(path.join(dataRoot, "profiles", "acc_1", "Default", "Cookies"), "c");

  // 早先单例的 workspaceRoot 是安装根、profilesRoot 是数据根，这里会抛
  // "账号 Profile 路径不在 profiles 直接子目录中"，删除账号和清缓存全部失败。
  const report = runInDataRoot(dataRoot, `
    const { profileManager } = await import("./src/profileManager.js");
    const account = { id: "acc_1", profileDir: "profiles/acc_1" };
    const scan = profileManager.scan([account]);
    const entry = scan.profiles.find((item) => item.name === "acc_1");
    let purge = null;
    try {
      purge = profileManager.removeAccountWithProfile(account, "purge", () => true, [account]);
    } catch (error) {
      purge = { error: error.message };
    }
    console.log(JSON.stringify({ linked: entry?.linked ?? null, purge }));
  `);

  assert.equal(report.linked, true, "Profile 必须被识别为已关联账号");
  assert.equal(report.purge.deleted, true, `purge 应成功，实际：${JSON.stringify(report.purge)}`);
  assert.equal(fs.existsSync(path.join(dataRoot, "profiles", "acc_1")), false);
  // 安装目录不该被碰。
  assert.equal(fs.existsSync(path.join(REPOSITORY_ROOT, "profiles", "acc_1")), false);
});

test("仅移除账号不触碰文件系统，Profile 变成孤儿保留下来", (t) => {
  const dataRoot = installedLayout(t);
  fs.mkdirSync(path.join(dataRoot, "profiles", "acc_keep"), { recursive: true });
  fs.writeFileSync(path.join(dataRoot, "profiles", "acc_keep", "Cookies"), "keep");

  const report = runInDataRoot(dataRoot, `
    const { profileManager } = await import("./src/profileManager.js");
    const account = { id: "acc_keep", profileDir: "profiles/acc_keep" };
    let committed = false;
    const result = profileManager.removeAccountWithProfile(
      account,
      "detach",
      () => { committed = true; return true; },
      [account]
    );
    console.log(JSON.stringify({ committed, result }));
  `);

  assert.equal(report.committed, true);
  assert.equal(report.result.retained, true);
  assert.equal(fs.existsSync(path.join(dataRoot, "profiles", "acc_keep")), true);
});

test("profilesRoot 不在 workspaceRoot 之内时立刻报错，而不是等用户点删除", () => {
  assert.throws(
    () => createProfileManager({
      workspaceRoot: path.join(os.tmpdir(), "keeper-ws"),
      profilesRoot: path.join(os.tmpdir(), "keeper-elsewhere", "profiles"),
    }),
    /必须位于/
  );
  // 缺 workspaceRoot 时必须直接失败，而不是默默回落到某个根。
  assert.throws(() => createProfileManager({}), TypeError);
});

test("历史记录在 SQLite 后端下也带时间戳", async (t) => {
  const dataRoot = installedLayout(t);
  const { openKeeperRepository } = await import("../src/persistence/sqliteRepository.js");
  const { createSqliteRuntimeAdapters } = await import("../src/persistence/runtimeAdapters.js");
  let repository;
  try {
    repository = await openKeeperRepository({
      filePath: path.join(dataRoot, "keeper.db"),
      appVersion: "test",
    });
  } catch {
    return; // 没有原生 better-sqlite3 时跳过
  }
  t.after(() => repository.close());
  const adapters = createSqliteRuntimeAdapters(repository);
  repository.createAccount({ id: "acc_h", profileName: "acc_h", note: "history" });

  // runOnce 的结果里没有 time —— JSON 后端写入时补了一个，SQLite 后端没有，
  // 于是"立即跑"成功后历史列表显示"未知时间"。
  adapters.history.recordConversation("acc_h", {
    ok: true,
    setName: "topic",
    totalRounds: 1,
    rounds: [{ q: "问", a: "答" }],
  });

  const [entry] = adapters.history.readHistory("acc_h", 10);
  assert.ok(entry.time, "历史条目必须带 time");
  assert.ok(Number.isFinite(Date.parse(entry.time)), "time 必须可被解析");
  assert.equal(entry.rounds[0].q, "问");

  // 本次修复之前写入的行（payload 里没有 time）读出来也要能兜底。
  repository.db
    .prepare(
      `INSERT INTO run_history(account_id, source, finished_at, ok, payload_json)
       VALUES (?, 'legacy', ?, 1, ?)`
    )
    .run("acc_h", "2026-01-01T00:00:00.000Z", JSON.stringify({ ok: true }));
  const rows = adapters.history.readHistory("acc_h", 10);
  assert.ok(rows.every((row) => row.time), "历史行必须都有时间，不能出现未知时间");
});

test("端口段被第三方占用时自动改用空闲段，且绝不关闭占用者", async (t) => {
  // 模拟 Clash Verge 占住本项目的默认段起点。
  const squatter = net.createServer();
  const listening = await new Promise((resolve) => {
    squatter.once("error", () => resolve(false));
    squatter.listen({ host: "127.0.0.1", port: 21000, exclusive: true }, () => resolve(true));
  });
  t.after(() => new Promise((resolve) => squatter.close(resolve)));
  if (!listening) return; // 端口本来就被占（例如用户的 Verge 正在跑），跳过

  const dataRoot = installedLayout(t);
  const report = runInDataRoot(dataRoot, `
    const proxies = await import("./src/proxyManager.js");
    const status = proxies.status();
    console.log(JSON.stringify({ basePort: status.basePort, running: status.running }));
  `);
  assert.equal(typeof report.basePort, "number");
  assert.ok(report.basePort >= 1024);

  // 关键断言：占用者仍然活着。抢端口时按进程名杀 mihomo 会切断用户自己的网络。
  assert.equal(squatter.listening, true, "不能关闭占用端口的第三方进程");
});

test("空闲端口探测跳过被占用的整段，且不影响占用者", async (t) => {
  const dataRoot = installedLayout(t);
  const blockers = [];
  // 占住 21000 段里探测一定会碰到的几个端口。
  for (const port of [21000, 21001, 21999]) {
    const server = net.createServer();
    const ok = await new Promise((resolve) => {
      server.once("error", () => resolve(false));
      server.listen({ host: "127.0.0.1", port, exclusive: true }, () => resolve(true));
    });
    if (ok) blockers.push(server);
  }
  t.after(async () => {
    for (const server of blockers) await new Promise((resolve) => server.close(resolve));
  });
  if (blockers.length === 0) return;

  const report = runInDataRoot(dataRoot, `
    const proxies = await import("./src/proxyManager.js");
    // 没有启用节点时 ensureRunning 不启动边车，但也绝不能抛端口错误。
    const result = await proxies.ensureRunning();
    console.log(JSON.stringify(result));
  `);
  assert.equal(report.running, false);
  assert.equal(report.reason, "没有启用的代理节点");
  assert.ok(blockers.every((server) => server.listening), "占用者必须全部存活");
});
