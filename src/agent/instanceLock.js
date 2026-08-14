import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const LEGACY_STARTUP_GRACE_MS = 30 * 60 * 1000;

/**
 * Agent 数据目录单实例锁。
 *
 * 锁文件只用于诊断，真正的互斥由命名管道（Windows）或 Unix socket 持有。
 * 这些内核对象会在进程退出时自动释放，因此不会把已经复用给其它进程的 PID
 * 误判成仍在运行的 Agent。
 */
export async function acquireInstanceLock(lockFile, options = {}) {
  const resolved = path.resolve(lockFile);
  const pid = options.pid ?? process.pid;
  const isProcessAlive = options.isProcessAlive ?? defaultIsAlive;
  const probeEndpoint = options.probeEndpoint ?? defaultProbeEndpoint;
  const now = options.now ?? (() => Date.now());
  fs.mkdirSync(path.dirname(resolved), { recursive: true });

  const previous = readMetadata(resolved);
  if (
    previous?.lockId == null &&
    previous?.pid !== pid &&
    previous?.pid != null &&
    isProcessAlive(previous.pid)
  ) {
    const startedAt = Date.parse(previous.startedAt ?? "");
    const stillStarting = !Number.isFinite(startedAt) || now() - startedAt < LEGACY_STARTUP_GRACE_MS;
    const reachable = stillStarting
      ? false
      : await anyEndpointReachable(legacyEndpointCandidates(options.endpoint), probeEndpoint);
    if (stillStarting || reachable) throw conflictError(previous.pid);
    // 旧版只用 PID 判断存活。锁已足够旧、IPC 也不存在时，即使 PID 被复用，
    // 也可以安全接管；后续启动都由内核锁判定，不再依赖 PID。
  }

  const lockEndpoint = options.lockEndpoint ?? instanceLockEndpoint(resolved, options);
  const server = options.createServer?.() ?? net.createServer((socket) => socket.destroy());
  try {
    await listenWithStaleSocketRecovery(server, lockEndpoint);
  } catch (error) {
    server.close();
    if (error?.code === "EADDRINUSE") {
      throw conflictError(readMetadata(resolved)?.pid ?? null);
    }
    throw error;
  }

  const lockId = randomUUID();
  try {
    fs.writeFileSync(
      resolved,
      JSON.stringify({ pid, startedAt: new Date(now()).toISOString(), lockId, lockEndpoint }),
      "utf8"
    );
  } catch (error) {
    await closeServer(server);
    cleanupUnixSocket(lockEndpoint);
    throw error;
  }

  let released = false;
  return {
    file: resolved,
    endpoint: lockEndpoint,
    async release() {
      if (released) return;
      released = true;
      try {
        const current = readMetadata(resolved);
        // 仍持有内核锁时先删自己的诊断文件，避免释放与下一实例接管之间的竞态。
        if (current == null || current.lockId === lockId) fs.unlinkSync(resolved);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      } finally {
        await closeServer(server);
        cleanupUnixSocket(lockEndpoint);
      }
    },
  };
}

function conflictError(pid) {
  const owner = pid == null ? "未知" : pid;
  const conflict = new Error(
    `另一个 Agent 实例（pid ${owner}）已在使用该数据目录，不能同时启动第二个`
  );
  conflict.code = "AGENT_ALREADY_RUNNING";
  conflict.pid = pid;
  return conflict;
}

function readMetadata(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    const pid = Number(parsed?.pid);
    return {
      ...parsed,
      pid: Number.isInteger(pid) && pid > 0 ? pid : null,
    };
  } catch {
    // 空文件、写入过程中被读到、或内容损坏：内核锁仍会给出最终判定。
    return null;
  }
}

function instanceLockEndpoint(lockFile, options = {}) {
  const platform = options.platform ?? process.platform;
  const identity = platform === "win32"
    ? `${process.env.USERDOMAIN || ""}\\${os.userInfo().username}`
    : String(typeof process.getuid === "function" ? process.getuid() : os.userInfo().username);
  const suffix = createHash("sha256")
    .update(`${identity}\0${canonicalPath(lockFile, platform)}`)
    .digest("hex")
    .slice(0, 24);
  if (platform === "win32") return `\\\\.\\pipe\\gptaccountkeeper-data-lock-${suffix}`;
  const runtimeDirectory = options.runtimeDirectory ?? process.env.XDG_RUNTIME_DIR ?? os.tmpdir();
  return path.join(runtimeDirectory, `gptaccountkeeper-data-lock-${suffix}.sock`);
}

function canonicalPath(value, platform) {
  const resolved = path.resolve(value);
  return platform === "win32" ? resolved.toUpperCase() : resolved;
}

async function listenWithStaleSocketRecovery(server, endpoint) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await listen(server, endpoint);
      if (process.platform !== "win32") fs.chmodSync(endpoint, 0o600);
      return;
    } catch (error) {
      if (error?.code !== "EADDRINUSE" || process.platform === "win32") throw error;
      if (await defaultProbeEndpoint(endpoint)) throw error;
      cleanupUnixSocket(endpoint);
    }
  }
  const error = new Error(`无法占用 Agent 数据目录锁：${endpoint}`);
  error.code = "EADDRINUSE";
  throw error;
}

function listen(server, endpoint) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ path: endpoint, readableAll: false, writableAll: false });
  });
}

function closeServer(server) {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve) => server.close(() => resolve()));
}

function cleanupUnixSocket(endpoint) {
  if (process.platform === "win32") return;
  try {
    const stat = fs.lstatSync(endpoint);
    if (stat.isSocket()) fs.unlinkSync(endpoint);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function legacyEndpointCandidates(endpoint) {
  if (!endpoint) return [];
  const candidates = [endpoint];
  const match = String(endpoint).match(/^(.*)-[0-9a-f]{16}(\.sock)?$/i);
  if (match) candidates.push(`${match[1]}${match[2] ?? ""}`);
  return [...new Set(candidates)];
}

async function anyEndpointReachable(endpoints, probeEndpoint) {
  for (const endpoint of endpoints) {
    if (await probeEndpoint(endpoint)) return true;
  }
  return false;
}

function defaultProbeEndpoint(endpoint) {
  return new Promise((resolve) => {
    let settled = false;
    const socket = net.createConnection({ path: endpoint });
    const finish = (reachable) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(reachable);
    };
    const timer = setTimeout(() => finish(false), 250);
    timer.unref?.();
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

function defaultIsAlive(pid) {
  try {
    // 信号 0 只做存在性与权限检查，不影响目标进程。
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM 表示进程存在但不属于当前用户，仍要视为占用。
    return error?.code === "EPERM";
  }
}
