import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import YAML from "yaml";
import { fromRoot, ensureDir } from "./paths.js";
import { getAccounts } from "./store.js";
import { mergeProxyNodes } from "./proxyUtils.js";
import * as log from "./logger.js";

/**
 * 定向代理：让每个账号可以各自走指定的代理节点（VPN 节点），
 * 没设置的账号走系统默认网络。
 *
 * 做法：另起一个**私有的 mihomo 进程**（不碰你系统上的 Clash Verge），
 * 用它的 listeners 特性为每个节点单独开一个本地 HTTP 端口，
 * Playwright 启动时按账号连不同端口即可：
 *
 *   账号A --proxy 127.0.0.1:21001 --\
 *   账号B --proxy 127.0.0.1:21002 --- 私有 mihomo ==> 各自节点出口
 *   账号C ----（不设代理）------------> 系统网络（你的 Verge 节点）
 *
 * 已实测：mihomo v1.19.21 该配置可正常绑定端口，且出口 IP 确实走对应节点。
 */

const PROXIES_FILE = fromRoot("config/proxies.json");
const RUNTIME_DIR = fromRoot(".mihomo");
const BASE_PORT = 21000;
const API_PORT = 21999;

// mihomo 可执行文件候选位置：优先项目自带，其次 Clash Verge 安装目录。
const MIHOMO_CANDIDATES = [
  fromRoot("bin/mihomo.exe"),
  fromRoot("bin/verge-mihomo.exe"),
  "C:\\Program Files\\Clash Verge\\verge-mihomo.exe",
  "C:\\Program Files\\Clash Verge\\verge-mihomo-alpha.exe",
  "C:\\Program Files (x86)\\Clash Verge\\verge-mihomo.exe",
];

// 用户输入不合法：标记 badRequest，API 层答 400 而不是 500。
function badRequest(msg) {
  const e = new Error(msg);
  e.badRequest = true;
  return e;
}

function readStore() {
  try {
    const data = JSON.parse(fs.readFileSync(PROXIES_FILE, "utf8"));
    return {
      subscription: data.subscription ?? null,
      nodes: Array.isArray(data.nodes) ? data.nodes : [],
      mihomoPath: data.mihomoPath ?? null,
    };
  } catch {
    return { subscription: null, nodes: [], mihomoPath: null };
  }
}

function writeStore(data) {
  ensureDir(fromRoot("config"));
  fs.writeFileSync(PROXIES_FILE, JSON.stringify(data, null, 2), "utf8");
}

// ---------- 对外：节点数据 ----------

/**
 * 节点列表。默认隐藏密码等敏感字段（前端用）。
 */
export function getNodes({ safe = true } = {}) {
  const { nodes } = readStore();
  if (!safe) return nodes;
  // 端口映射算一次就够：早先每个节点都调 portOf()，
  // 而 portOf 会重新读整个 proxies.json —— 几百个节点的订阅就是几百次全文件解析。
  const ports = portMapFrom(nodes);
  return nodes.map((n) => ({
    id: n.id,
    name: n.name,
    type: n.raw?.type ?? null,
    server: n.raw?.server ?? null,
    port: n.raw?.port ?? null,
    enabled: n.enabled !== false,
    missing: !!n.missing,
    localPort: ports.get(n.id) ?? null,
  }));
}

/**
 * 订阅信息。**默认脱敏**：订阅 URL 里通常带访问令牌（token/uuid），
 * 直接回给前端等于把令牌暴露在 HTTP 响应里。只回显主机名和是否已配置，
 * 真实 URL 只留在本地 config/proxies.json。
 */
export function getSubscriptionInfo() {
  const { subscription } = readStore();
  if (!subscription?.url) return null;
  let host = "";
  try {
    host = new URL(subscription.url).host;
  } catch {
    host = "（地址无法解析）";
  }
  return {
    configured: true,
    host, // 只给主机名，不含 path/query 里的 token
    updatedAt: subscription.updatedAt,
    count: getNodes().length,
  };
}

export function getMihomoInfo() {
  const p = resolveMihomo();
  return { path: p, found: !!p };
}

function resolveMihomo() {
  const { mihomoPath } = readStore();
  const list = mihomoPath ? [mihomoPath, ...MIHOMO_CANDIDATES] : MIHOMO_CANDIDATES;
  for (const p of list) {
    try {
      if (p && fs.existsSync(p)) return p;
    } catch {
      // 忽略无权限路径
    }
  }
  return null;
}

// ---------- 订阅导入 ----------

function decodeMaybeBase64(text) {
  const t = text.trim();
  // Clash 订阅是 YAML；有些订阅返回 base64。YAML 里必然有 "proxies:"。
  if (t.includes("proxies:")) return t;
  if (/^[A-Za-z0-9+/=\s]+$/.test(t) && t.length > 40) {
    try {
      const decoded = Buffer.from(t.replace(/\s/g, ""), "base64").toString("utf8");
      if (decoded.includes("proxies:")) return decoded;
    } catch {
      // 不是 base64，按原文处理
    }
  }
  return t;
}

/**
 * 拉取并解析订阅，覆盖节点列表。**只在用户手动触发时调用**，不做任何自动刷新。
 * 已有绑定通过“同名节点 id 不变”保留；订阅里消失的节点标 missing 而不是直接删，
 * 免得账号的代理配置突然变成空。
 */
export async function importSubscription(url) {
  const target = String(url || "").trim();
  if (!/^https?:\/\//i.test(target)) {
    throw badRequest("订阅地址必须是 http(s) 链接");
  }

  const res = await fetch(target, {
    headers: { "user-agent": "clash-verge/mihomo" },
    signal: AbortSignal.timeout(45000),
  });
  if (!res.ok) throw new Error(`订阅拉取失败: HTTP ${res.status}`);
  const text = decodeMaybeBase64(await res.text());

  let doc;
  try {
    doc = YAML.parse(text);
  } catch (e) {
    throw new Error("订阅内容不是合法 YAML: " + e.message);
  }
  const list = doc?.proxies;
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error("订阅里没有解析到 proxies 节点列表");
  }

  const prev = readStore();
  const referencedIds = new Set(
    getAccounts()
      .map((account) => account.proxyId)
      .filter(Boolean)
  );
  const nodes = mergeProxyNodes(list, prev.nodes, referencedIds);
  if (!nodes.some((node) => !node.missing)) {
    throw new Error("订阅里没有包含合法端口的可用代理节点");
  }

  writeStore({
    subscription: { url: target, updatedAt: new Date().toISOString() },
    nodes,
    mihomoPath: prev.mihomoPath,
  });

  log.info(`订阅导入完成：${nodes.filter((n) => !n.missing).length} 个节点`);
  await restart();
  return { count: nodes.filter((n) => !n.missing).length, total: nodes.length };
}

/**
 * 手动刷新：复用已保存的订阅地址。
 */
export async function refreshSubscription() {
  const { subscription } = readStore();
  if (!subscription?.url) throw badRequest("尚未配置订阅地址");
  return importSubscription(subscription.url);
}

export async function setNodeEnabled(id, enabled) {
  const store = readStore();
  const n = store.nodes.find((x) => x.id === id);
  if (!n) return null;
  n.enabled = !!enabled;
  writeStore(store);
  await restart();
  return getNodes().find((x) => x.id === id) ?? null;
}

export async function clearNodes() {
  writeStore({ subscription: null, nodes: [], mihomoPath: readStore().mihomoPath });
  await runLifecycleTransition(() => stopAndWait());
}

// ---------- 端口分配 ----------

// 节点 id -> 本地端口。按节点在列表中的顺序稳定分配，重启后不变。
// 传入已读好的 nodes，避免调用方在循环里反复读文件。
function portMapFrom(nodes) {
  const map = new Map();
  let i = 0;
  for (const n of nodes) {
    if (n.enabled === false || n.missing) continue;
    map.set(n.id, BASE_PORT + i);
    i++;
  }
  return map;
}

function portMap() {
  return portMapFrom(readStore().nodes);
}

function portOf(id) {
  return portMap().get(id) ?? null;
}

/**
 * 账号要用的代理地址。没绑定节点则返回 null（走系统默认网络）。
 */
export function proxyForAccount(account) {
  if (!account?.proxyId) return null;
  const port = portOf(account.proxyId);
  if (!port) return null;
  return { server: `http://127.0.0.1:${port}` };
}

// ---------- mihomo 进程 ----------

let child = null;
// 当前运行进程对应的配置指纹，用于判断“配置没变就别重启”。
let currentFingerprint = null;
// 所有 stop/restart/ensure 操作都经过同一条 Promise 队列，覆盖完整生命周期。
// 不能只保护 spawn 阶段，否则两个快速节点切换仍可能交叉执行 stopAndWait。
let lifecycleTail = Promise.resolve();

function runLifecycleTransition(fn) {
  const run = lifecycleTail.then(fn, fn);
  lifecycleTail = run.then(
    () => {},
    () => {}
  );
  return run;
}

function buildConfig() {
  const { nodes } = readStore();
  const active = nodes.filter((n) => n.enabled !== false && !n.missing);
  const ports = portMap();

  const listeners = active
    .filter((n) => ports.has(n.id))
    .map((n) => ({
      name: "in-" + n.id,
      type: "http",
      listen: "127.0.0.1",
      port: ports.get(n.id),
      proxy: n.name,
    }));

  return {
    "mixed-port": 0,
    "allow-lan": false,
    mode: "rule",
    "log-level": "warning",
    ipv6: false,
    "external-controller": `127.0.0.1:${API_PORT}`,
    "unified-delay": true,
    dns: {
      enable: true,
      ipv6: false,
      "enhanced-mode": "redir-host",
      nameserver: ["223.5.5.5", "1.1.1.1"],
    },
    proxies: active.map((n) => n.raw),
    listeners,
    rules: ["MATCH,DIRECT"],
  };
}

/**
 * 确保 mihomo 已按当前节点配置运行。没有任何启用节点时不启动。
 *
 * 幂等：配置没变且进程还活着就直接返回。
 * 这点很重要——每个账号启动浏览器都会调它，若每次都重启边车，
 * 一个账号开浏览器就会掐断其它账号正在进行的请求。
 */
async function ensureRunningUnlocked() {
  const cfg = buildConfig();
  if (!cfg.listeners.length) {
    await stopAndWait();
    return { running: false, reason: "没有启用的代理节点" };
  }

  const fingerprint = JSON.stringify(cfg);
  if (child && !child.killed && currentFingerprint === fingerprint) {
    return { running: true, nodes: cfg.listeners.length, reused: true };
  }

  const bin = resolveMihomo();
  if (!bin) {
    // 明确报错而不是静默直连：否则账号会以为在走代理，其实是裸奔。
    throw new Error(
      "找不到 mihomo 可执行文件。请安装 Clash Verge，或把 mihomo.exe 放到项目 bin/ 目录"
    );
  }

  ensureDir(RUNTIME_DIR);
  const cfgPath = path.join(RUNTIME_DIR, "config.yaml");
  fs.writeFileSync(cfgPath, YAML.stringify(cfg), "utf8");

  // 先等旧进程真正退出，再起新的：否则旧进程还占着端口，
  // 新进程会绑定失败。
  await stopAndWait();

  const proc = spawn(bin, ["-d", RUNTIME_DIR, "-f", cfgPath], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child = proc;
  proc.stdout.on("data", (b) => {
    const s = String(b).trim();
    if (s) log.info("[mihomo] " + s.split("\n").slice(-1)[0]);
  });
  proc.stderr.on("data", (b) => {
    const s = String(b).trim();
    if (s) log.warn("[mihomo] " + s.split("\n").slice(-1)[0]);
  });
  // 只有“当前进程就是自己”时才清空全局引用。
  // 否则旧进程的 exit 回调会把刚启动的新进程引用抹掉，
  // 导致状态显示未运行、并可能重复启动造成端口冲突/孤儿进程。
  proc.on("exit", (code) => {
    if (code !== 0 && code !== null) log.warn(`mihomo 进程退出，code=${code}`);
    if (child === proc) {
      child = null;
      currentFingerprint = null; // 意外退出后下次调用要真的重启
    }
  });

  // 等第一个监听端口就绪，确认真的起来了。
  const firstPort = cfg.listeners[0].port;
  const ok = await waitPort(firstPort, 12000);
  if (!ok) {
    await stopAndWait();
    throw new Error("mihomo 启动后端口未就绪，请检查节点配置");
  }

  currentFingerprint = fingerprint;
  log.info(`代理边车已启动：${cfg.listeners.length} 个节点，端口 ${firstPort}+`);
  return { running: true, nodes: cfg.listeners.length };
}

export function ensureRunning() {
  return runLifecycleTransition(() => ensureRunningUnlocked());
}

export function stop() {
  if (child && !child.killed) {
    try {
      child.kill();
    } catch {
      // 进程可能已退出
    }
  }
  child = null;
  currentFingerprint = null;
}

/**
 * 停掉边车并等它真的退出（端口释放）。重启前必须用这个，
 * 否则新进程会因为旧进程还占着端口而绑定失败。
 */
async function stopAndWait(timeoutMs = 5000) {
  const proc = child;
  child = null;
  currentFingerprint = null;
  if (!proc || proc.killed || proc.exitCode !== null) return;

  await new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      // 到点还没退就强杀，避免卡死在这里
      try {
        proc.kill("SIGKILL");
      } catch {
        // 已经退了
      }
      finish();
    }, timeoutMs);
    proc.once("exit", finish);
    try {
      proc.kill();
    } catch {
      finish();
    }
  });
}

export async function restart() {
  return runLifecycleTransition(async () => {
    await stopAndWait();
    const { nodes } = readStore();
    if (!nodes.some((n) => n.enabled !== false && !n.missing)) return { running: false };
    try {
      return await ensureRunningUnlocked();
    } catch (e) {
      log.warn("代理边车重启失败: " + e.message);
      return { running: false, reason: e.message };
    }
  });
}

export function status() {
  const { nodes } = readStore();
  return {
    running: !!child && !child.killed,
    mihomo: getMihomoInfo(),
    nodeCount: nodes.filter((n) => n.enabled !== false && !n.missing).length,
    subscription: getSubscriptionInfo(),
  };
}

function waitPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const tryOnce = () => {
      const sock = net.connect({ host: "127.0.0.1", port }, () => {
        sock.destroy();
        resolve(true);
      });
      sock.on("error", () => {
        sock.destroy();
        if (Date.now() > deadline) return resolve(false);
        setTimeout(tryOnce, 300);
      });
    };
    tryOnce();
  });
}

/**
 * 测试节点连通性。直接用 mihomo 自己的延迟接口，不用另造代理客户端。
 */
export async function testNode(id) {
  const { nodes } = readStore();
  const node = nodes.find((n) => n.id === id);
  if (!node) throw badRequest("节点不存在");
  if (node.enabled === false) throw badRequest("该节点已停用，请先启用再测试");
  if (node.missing) throw badRequest("该节点已不在订阅中");

  await ensureRunning();
  const url = `http://127.0.0.1:${API_PORT}/proxies/${encodeURIComponent(
    node.name
  )}/delay?timeout=8000&url=${encodeURIComponent("https://www.gstatic.com/generate_204")}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { ok: false, message: data?.message || `HTTP ${res.status}` };
    }
    return { ok: true, delay: data.delay ?? null };
  } catch (e) {
    return { ok: false, message: String(e.message || e) };
  }
}

// 进程退出时收掉边车，别留孤儿进程。
for (const sig of ["exit", "SIGINT", "SIGTERM"]) {
  process.on(sig, () => stop());
}
