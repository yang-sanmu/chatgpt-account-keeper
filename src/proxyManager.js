import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import YAML from "yaml";
import { parseCustomProxies } from "./customProxy.js";
import {
  customConfigNodeId,
  customNodeKind,
  parseCustomConfigInput,
  parseSingleCustomNodeYaml,
  stringifyCustomNodeYaml,
  validateNodeDisplayName,
} from "./customProxyConfig.js";
import {
  fromRoot,
  fromCacheRoot,
  fromInstallRoot,
  ensureDir,
} from "./paths.js";
import { getGroups, effectiveProxyId } from "./store.js";
import {
  assignStablePorts,
  mergeProxyNodes,
  normalizeProxyPort,
  selectRuntimeProxyNodes,
} from "./proxyUtils.js";
import {
  findMihomoExecutable,
  findMihomoInDirectory,
  validateMihomoExecutable,
} from "./mihomoLocator.js";
import * as log from "./logger.js";
import {
  normalizeNetworkConfig,
  resolveSystemProxy,
  compileConnectionRoutes,
  isUdpOnlyProxyType,
  upstreamSupportsUdp,
  udpDialerConflict,
} from "./network/connectionMode.js";
import {
  evaluateNetworkEnvironment,
  getHostNetworkSnapshot,
  isLoopbackHost,
  refreshHostNetworkSnapshot,
} from "./network/hostNetwork.js";
import {
  assertNoSystemProxyLoop,
  buildDirectBypassConfig,
  buildMihomoRuntimeConfig,
  buildSystemBridgeConfig,
} from "./network/mihomoConfig.js";
import { waitMihomoConfigApplied } from "./network/mihomoReadiness.js";
import { throwIfCancelled } from "./cancellation.js";
import {
  allocateProxySlots, fetchSubscription, fetchSubscriptionText, mergeSubscriptionNodes, stableJson, subscriptionHost, subscriptionUrl,
} from "./proxySubscriptions.js";

/**
 * 定向代理：让每个分组可以走指定的代理节点（VPN 节点），
 * 组内账号共用该出口；未绑定分组节点的账号走系统默认网络。
 *
 * 做法：另起一个**私有的 mihomo 进程**（不碰你系统上的 Clash Verge），
 * 用它的 listeners 特性为每个被分组引用的节点开一个本地 HTTP 端口，
 * Playwright 启动时按账号连不同端口即可：
 *
 *   美国组账号 --proxy 127.0.0.1:21001 --\
 *   韩国组账号 --proxy 127.0.0.1:21002 --- 私有 mihomo ==> 各组节点出口
 *   未绑定组 ----（不设代理）-----------> 系统网络（你的 Verge 节点）
 *
 * 已实测：mihomo v1.19.21 该配置可正常绑定端口，且出口 IP 确实走对应节点。
 */

const PROXIES_FILE = fromRoot("config/proxies.json");
const RUNTIME_DIR = fromCacheRoot("mihomo");
const TEST_RUNTIME_DIR = fromCacheRoot("mihomo-test");
const DIRECT_RUNTIME_DIR = fromCacheRoot("mihomo-direct");
// 默认端口段。21000 起这一段与 Clash Verge 的入站端口段重叠，撞上时
// 用户可以通过 proxies.json 的 basePort 改到空闲区间（见 readStore）。
const DEFAULT_BASE_PORT = 21000;
// 控制接口固定落在端口段末尾，跟着 basePort 一起移动。
const API_PORT_OFFSET = 999;
// 测速使用完全独立的 mihomo，绝不重启承载账号流量的主边车。
const TEST_API_PORT = 20999;
export const DEFAULT_CLASH_VERGE_DIR = process.platform === "win32"
  ? "C:\\Program Files\\Clash Verge"
  : null;
let proxyStoreBackend = null;
// Retain deleted slots for this Agent lifetime so existing Chrome proxy ports
// do not move when an unused node is removed. No deleted credentials are kept.
let portOrderAfterRemoval = null;
// 最近一次测速结果：nodeId -> { ok, delay, message, testedAt }。
// 测速本身是短生命周期的独立进程，结果不落库；但界面需要在节点行上一直显示
// 上次延迟，否则用户点完“测速”只能去任务中心翻 Operation 结果。
const nodeLatency = new Map();

export function configureProxyStoreBackend(backend) {
  if (backend != null && typeof backend !== "object") {
    throw new TypeError("proxy store backend must be an object or null");
  }
  const previous = proxyStoreBackend;
  const previousPortOrder = portOrderAfterRemoval;
  proxyStoreBackend = backend;
  portOrderAfterRemoval = null;
  return () => {
    proxyStoreBackend = previous;
    portOrderAfterRemoval = previousPortOrder;
  };
}

// 用户输入不合法：标记 badRequest，API 层答 400 而不是 500。
function badRequest(msg) {
  const e = new Error(msg);
  e.badRequest = true;
  return e;
}

function readStore() {
  if (typeof proxyStoreBackend?.readProxyStore === "function") {
    return proxyStoreBackend.readProxyStore();
  }
  try {
    const data = JSON.parse(fs.readFileSync(PROXIES_FILE, "utf8"));
    return {
      subscription: data.subscription ?? null,
      ...(Array.isArray(data.subscriptions) ? { subscriptions: data.subscriptions } : {}),
      nodes: Array.isArray(data.nodes) ? data.nodes : [],
      mihomoPath: data.mihomoPath ?? null,
      clashVergeDir: data.clashVergeDir ?? DEFAULT_CLASH_VERGE_DIR,
      network: data.network,
    };
  } catch {
    return {
      subscription: null,
      nodes: [],
      mihomoPath: null,
      clashVergeDir: DEFAULT_CLASH_VERGE_DIR,
    };
  }
}

function writeStore(data) {
  if (data.subscriptions) data = { ...data, nodes: allocateProxySlots(data.nodes) };
  if (typeof proxyStoreBackend?.writeProxyStore === "function") {
    return proxyStoreBackend.writeProxyStore(data);
  }
  ensureDir(fromRoot("config"));
  fs.writeFileSync(PROXIES_FILE, JSON.stringify(data, null, 2), "utf8");
}

export function getNetworkConfig() {
  const config = normalizeNetworkConfig(readStore().network);
  const systemProxy = resolveSystemProxy(config);
  const environment = evaluateNetworkEnvironment(config, getHostNetworkSnapshot());
  return { config, systemProxy, environment };
}

export async function getNetworkConfigFresh({ force = true } = {}) {
  const snapshot = await refreshHostNetworkSnapshot({ force });
  const config = normalizeNetworkConfig(readStore().network);
  const systemProxy = resolveSystemProxy(config);
  const environment = evaluateNetworkEnvironment(config, snapshot);
  return { config, systemProxy, environment };
}

export function setNetworkConfig(input, { assertIdle = () => {} } = {}) {
  const next = normalizeNetworkConfig(input);
  return runLifecycleTransition(async () => {
    assertIdle();
    const previous = readStore();
    const systemProxy = next.mode === "system" ? resolveSystemProxy(next) : undefined;
    const environment = evaluateNetworkEnvironment(next, getHostNetworkSnapshot());
    // Validate the chain before writing settings or stopping the current runtime.
    compileConnectionRoutes({
      nodes: previous.nodes,
      proxyIds: referencedProxyIds({ ...previous, network: next }),
      network: next,
      systemProxy,
      effectiveOutboundInterface: environment.effectiveOutboundInterface,
      allowPartialUdpSkip: true,
    });
    writeStore({ ...previous, network: next });
    try {
      await ensureRunningUnlocked();
      await stopDirectBypassAndWait();
    } catch (error) {
      // Restore only the setting we changed; unrelated imports may have completed
      // while the candidate process was starting.
      writeStore({ ...readStore(), network: normalizeNetworkConfig(previous.network) });
      try { await ensureRunningUnlocked(); } catch { /* The original failure remains actionable. */ }
      throw error;
    }
    nodeLatency.clear();
    return getNetworkConfig();
  });
}

export function withClashVergeDirectory(store, directory) {
  return {
    ...store,
    clashVergeDir: directory,
    // 页面配置是当前明确选择，不能再被旧版隐藏字段覆盖。
    mihomoPath: null,
  };
}

// ---------- 对外：节点数据 ----------

/**
 * 节点列表。默认隐藏密码等敏感字段（前端用）。
 */
export function getNodes({ safe = true, store = readStore() } = {}) {
  const { nodes } = store;
  if (!safe) return nodes;
  // 端口映射算一次就够：早先每个节点都调 portOf()，
  // 而 portOf 会重新读整个 proxies.json —— 几百个节点的订阅就是几百次全文件解析。
  const ports = portMapFrom(nodes, activeBasePort ?? configuredBasePort(store));
  const routedIds = referencedProxyIds(store);
  const network = normalizeNetworkConfig(store.network);
  const systemProxy = network.mode === "system" ? resolveSystemProxy(network) : undefined;
  const relayNode = network.mode === "relay"
    ? nodes.find((item) => item.id === network.relayProxyId)
    : null;
  return nodes.map((n) => {
    const isCustom = n.id.startsWith("custom_");
    const hasCustomAlias = !isCustom && typeof n.customName === "string" && n.customName.trim().length > 0;
    const originalName = typeof n.raw?.name === "string" && n.raw.name.trim() ? n.raw.name.trim() : null;
    const routedAndUsable = routedIds.has(n.id) && n.enabled !== false && !n.missing;
    const conflict = routedAndUsable ? udpDialerConflict(n, { config: network, systemProxy, relayNode }) : null;
    return {
      id: n.id,
      ...(n.sourceId ? { sourceId: n.sourceId } : {}),
      name: n.name,
      ...(hasCustomAlias ? { originalName, customNamed: true } : {}),
      ...(isCustom ? { customKind: customNodeKind(n.raw) } : {}),
      type: n.raw?.type ?? null,
      server: n.raw?.server ?? null,
      port: normalizeProxyPort(n.raw?.port),
      enabled: n.enabled !== false,
      missing: !!n.missing,
      directOutbound: Boolean(n.directOutbound),
      udpOnly: isUdpOnlyProxyType(n.raw?.type),
      udpSupported: upstreamSupportsUdp(n.raw),
      // 上次测速结果随节点一起返回，界面无需另外关联 Operation 结果。
      latencyMs: nodeLatency.get(n.id)?.delay ?? null,
      latencyOk: nodeLatency.get(n.id)?.ok ?? null,
      latencyMessage: nodeLatency.get(n.id)?.message ?? null,
      latencyTestedAt: nodeLatency.get(n.id)?.testedAt ?? null,
      // 只有被分组实际引用的兼容节点才有主边车监听端口；测速走独立临时进程。
      localPort: routedAndUsable && !conflict ? ports.get(n.id) ?? null : null,
    };
  });
}

/**
 * 订阅信息。**默认脱敏**：订阅 URL 里通常带访问令牌（token/uuid），
 * 直接回给前端等于把令牌暴露在 HTTP 响应里。只回显主机名和是否已配置，
 * 真实 URL 只留在本地 config/proxies.json。
 */
export function getSubscriptionInfo() {
  const { subscription, subscriptions, nodes } = readStore();
  if (subscriptions?.length > 1) return null;
  const single = subscriptions?.[0];
  if (single) return single.url ? { configured: true, host: subscriptionHost(single.url) ?? "（地址无法解析）",
    updatedAt: single.updatedAt ?? null, count: nodes.filter((node) => node.sourceId === single.id).length } : null;
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
    // 旧订阅记录可能没有 updatedAt；公开 DTO 用 null 保持字段稳定，避免序列化时
    // undefined 直接把键吞掉。
    updatedAt: subscription.updatedAt ?? null,
    count: nodes.filter((node) => !node.id.startsWith("custom_")).length,
  };
}

export function getSubscriptions() {
  const { subscriptions = [], nodes } = readStore();
  const counts = new Map();
  for (const node of nodes) {
    if (!node.sourceId) continue;
    if (!counts.has(node.sourceId)) counts.set(node.sourceId, { count: 0, missingCount: 0 });
    const count = counts.get(node.sourceId);
    if (node.missing) count.missingCount++;
    else if (node.enabled !== false) count.count++;
  }
  return subscriptions.map(({ id, name, url, updatedAt, attemptedAt, error }) => ({
    id, name, configured: !!url, host: subscriptionHost(url), updatedAt: updatedAt ?? null,
    attemptedAt: attemptedAt ?? null, error: error ?? null, ...(counts.get(id) ?? { count: 0, missingCount: 0 }),
  }));
}

export function getMihomoInfo() {
  const p = resolveMihomo();
  return { path: p, found: !!p };
}

function resolveMihomo() {
  const { mihomoPath, clashVergeDir } = readStore();
  return findMihomoExecutable({
    configuredPath: mihomoPath,
    configuredInstallDir: clashVergeDir,
    projectRoot: fromInstallRoot("."),
  });
}

export async function setClashVergeDirectory(value) {
  let directory = String(value ?? "").trim();
  if (
    (directory.startsWith('"') && directory.endsWith('"')) ||
    (directory.startsWith("'") && directory.endsWith("'"))
  ) {
    directory = directory.slice(1, -1).trim();
  }
  if (!directory) directory = DEFAULT_CLASH_VERGE_DIR;

  const executable = findMihomoInDirectory(directory, {
    projectRoot: fromInstallRoot("."),
  });
  if (!executable) {
    throw badRequest(
      "该目录中未找到 mihomo 内核，请选择包含 verge-mihomo.exe 或 mihomo.exe 的 Clash Verge 安装目录"
    );
  }

  const validation = validateMihomoExecutable(executable);
  if (!validation.ok) {
    throw badRequest(`找到的文件无法作为 mihomo 内核运行：${validation.message}`);
  }

  // 配置写入与进程切换共用生命周期队列，避免两个快速保存请求交叉停启。
  return runLifecycleTransition(async () => {
    writeStore(withClashVergeDirectory(readStore(), directory));

    let runtime;
    try {
      runtime = await ensureRunningUnlocked();
    } catch (error) {
      const reason = String(error?.message || error);
      log.warn("Clash Verge 目录已保存，但代理边车启动失败: " + reason);
      runtime = { running: false, reason };
    }

    const activeExecutable = resolveMihomo();
    return {
      clashVergeDir: directory,
      mihomo: {
        path: activeExecutable,
        found: !!activeExecutable,
        version: validation.version,
      },
      runtime,
    };
  });
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
export async function importSubscription(url, options) {
  const managed = readStore().subscriptions;
  if (managed?.length > 1) throw badRequest("已配置多个订阅，请在订阅源列表中选择要更新的来源");
  if (managed?.length === 1) {
    const { results: [result] } = await updateSubscription({ id: managed[0].id, url }, options);
    if (result.error) throw badRequest(result.error);
    return { count: getSubscriptions()[0].count, total: getNodes().length };
  }
  if (managed && !readStore().subscription) {
    const { results: [result] } = await addSubscriptions([url], options);
    if (result.error) throw badRequest(result.error);
    return { count: getSubscriptions()[0].count, total: getNodes().length };
  }
  const target = String(url || "").trim();
  if (!/^https?:\/\//i.test(target)) {
    throw badRequest("订阅地址必须是 http(s) 链接");
  }

  const res = await withSubscriptionHttpProxy(target, (proxyUrl) =>
    fetchSubscriptionText(target, { proxyUrl, timeoutMs: 45000 })
  );
  if (!res.ok) throw new Error(`订阅拉取失败: HTTP ${res.status}`);
  const text = decodeMaybeBase64(res.text);

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
  // 仍被分组引用的节点即使从订阅里消失也要留着（标 missing），
  // 否则分组的代理配置会突然变空、组内账号悄悄改走系统网络。
  const referencedIds = referencedProxyIds();
  const nodes = mergeProxyNodes(list, prev.nodes, referencedIds);
  const count = nodes.filter((node) => !node.missing && !node.id.startsWith("custom_")).length;
  if (!count) {
    throw new Error("订阅里没有包含合法端口的可用代理节点");
  }

  writeStore({
    ...prev,
    subscription: { url: target, updatedAt: new Date().toISOString() },
    nodes,
    mihomoPath: prev.mihomoPath,
    clashVergeDir: prev.clashVergeDir,
  });
  // 订阅换掉的节点不能留着旧延迟，否则界面会给新节点显示上一批的数字。
  const liveIds = new Set(nodes.map((node) => node.id));
  for (const id of [...nodeLatency.keys()]) {
    if (!liveIds.has(id)) nodeLatency.delete(id);
  }

  log.info(`订阅导入完成：${count} 个节点`);
  portOrderAfterRemoval = null;
  try {
    await restart({ throwOnError: true });
  } catch (cause) {
    throw Object.assign(new Error(`订阅节点已更新，但代理未能应用：${cause.message || cause}`, { cause }), {
      code: "PROXY_UNAVAILABLE",
    });
  }
  return { count, total: nodes.length };
}

/**
 * 手动刷新：复用已保存的订阅地址。
 */
export async function refreshSubscription(options) {
  const { subscription, subscriptions } = readStore();
  if (subscriptions?.length > 1) throw badRequest("已配置多个订阅，请在订阅源列表中选择刷新范围");
  if (subscriptions?.[0]) {
    const { results: [result] } = await refreshSubscriptions([subscriptions[0].id], options);
    if (result.error) throw badRequest(result.error);
    return { count: getSubscriptions()[0].count, total: getNodes().length };
  }
  if (!subscription?.url) throw badRequest("尚未配置订阅地址");
  return importSubscription(subscription.url);
}

const subscriptionDownloads = new Map();
const linkReplacements = new Map();
const appliedDownloads = new Map();
const downloadTail = [Promise.resolve(), Promise.resolve(), Promise.resolve()];
let nextDownloadSequence = 0;

function downloadSubscription(url) {
  if (!url) return fetchSubscription(url);
  if (subscriptionDownloads.has(url)) return subscriptionDownloads.get(url);
  const sequence = nextDownloadSequence++;
  const lane = sequence % downloadTail.length;
  const pending = downloadTail[lane]
    .then(async () => {
      try {
        const result = await withSubscriptionHttpProxy(url, (proxyUrl) => fetchSubscription(url, { proxyUrl }));
        return { ...result, sequence };
      } catch (error) {
        return { error: String(error?.message || error), sequence };
      }
    })
    .finally(() => subscriptionDownloads.delete(url));
  downloadTail[lane] = pending.catch(() => {});
  subscriptionDownloads.set(url, pending);
  return pending;
}

function uniqueSourceName(sources, name) {
  const used = new Set(sources.map((source) => source.name.toLowerCase()));
  if (!used.has(name.toLowerCase())) return name;
  for (let index = 2; ; index++) {
    const candidate = `${name} (${index})`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
}

function requireSource(sources, id) {
  const source = sources.find((item) => item.id === id);
  if (!source) throw badRequest("订阅源不存在");
  return source;
}

async function commitSubscriptions(requests, { assertIdle = () => {}, onApply = () => {}, bindingLabels = () => [] } = {}) {
  return runLifecycleTransition(async () => {
    onApply();
    const previous = readStore();
    const references = referencedProxyIds(previous);
    const sources = [...(previous.subscriptions ?? [])];
    let nodes = previous.nodes;
    const results = [];
    const attempts = new Map();
    const now = new Date().toISOString();
    let dirty = false;
    for (const [index, request] of requests.entries()) {
      const { url, initial, downloaded, replacement, name, remove } = request;
      const at = initial ? sources.findIndex((source) => source.id === initial.id) : -1;
      const current = sources[at];
      if (initial && (!current || current.url !== initial.url || current.linkRevision !== initial.linkRevision ||
        (replacement && linkReplacements.get(initial.id) !== replacement))) {
        results.push({ index, id: initial.id, name: initial.name, error: "订阅源已变更，请重新操作" });
        continue;
      }
      if (current && url === current.url && downloaded?.sequence !== undefined &&
          downloaded.sequence < (appliedDownloads.get(current.id) ?? -1)) {
        results.push({ index, id: current.id, name: current.name, error: "已忽略较早的刷新结果" });
        continue;
      }
      if (remove) {
        const bound = nodes.filter((node) => node.sourceId === current.id && references.has(node.id));
        if (bound.length) {
          const labels = bound.flatMap((node) => bindingLabels(node.id));
          throw badRequest(`此订阅仍被使用，请先更换节点：${[...new Set(labels.length ? labels : bound.map((node) => node.name))].join("、")}`);
        }
        sources.splice(at, 1);
        nodes = nodes.filter((node) => node.sourceId !== current.id);
        attempts.set(current.id, null);
        results.push({ index, id: current.id, name: current.name });
        dirty = true;
        continue;
      }
      const duplicate = url && sources.find((source) => source.id !== current?.id && subscriptionUrl(source.url) === url);
      if (duplicate) {
        results.push({ index, id: duplicate.id, name: duplicate.name, duplicate: true, error: "此链接已存在" });
        continue;
      }
      const label = name ?? current?.name ?? uniqueSourceName(sources, subscriptionHost(url)?.slice(0, 180) ?? "订阅");
      if (name && sources.some((source) => source.id !== current?.id && source.name.toLowerCase() === name.toLowerCase())) {
        results.push({ index, id: current?.id, name: label, error: "订阅别名已存在" });
        continue;
      }
      const id = current?.id ?? randomUUID();
      const oldNodes = nodes.filter((node) => node.sourceId === id);
      const merged = downloaded?.nodes ? mergeSubscriptionNodes(id, downloaded.nodes, oldNodes, references) : null;
      const error = downloaded?.error ?? (downloaded?.skipped && merged?.missing.length ? "订阅包含无效记录，已保留原有绑定节点" : null);
      if (downloaded?.sequence !== undefined && (current || merged)) attempts.set(id, downloaded.sequence);
      if (error) {
        if (current) {
          sources[at] = { ...current, attemptedAt: now, error };
          dirty = true;
        }
        results.push({ index, id: current?.id, name: label, host: subscriptionHost(url), error });
        continue;
      }
      if (merged) {
        const first = nodes.findIndex((node) => node.sourceId === id);
        const atNode = first < 0 ? nodes.length : first;
        nodes = [...nodes.slice(0, atNode), ...merged.nodes, ...nodes.slice(atNode).filter((node) => node.sourceId !== id)];
      }
      const source = { ...current, id, name: label };
      if (merged) {
        Object.assign(source, { url, attemptedAt: now, updatedAt: now, error: null,
          linkRevision: (current?.linkRevision ?? 0) + Number(!!current && current.url !== url) });
      }
      if (current) sources[at] = source;
      else sources.push(source);
      results.push({ index, id, name: label, host: subscriptionHost(source.url),
        ...(merged ? { added: merged.added, updated: merged.updated, removed: merged.removed,
          skipped: merged.duplicates + downloaded.skipped,
          missing: merged.missing.map((node) => ({ ...node, bindings: bindingLabels(node.id) })) } : {}) });
      dirty = true;
    }
    if (!dirty) return { results, routesChanged: false };
    let routesChanged = false;
    if (nodes === previous.nodes) {
      writeStore({ ...previous, subscription: null, subscriptions: sources });
    } else {
      const candidate = { ...previous, subscription: null, subscriptions: sources, nodes: allocateProxySlots(nodes) };
      if (Buffer.byteLength(JSON.stringify(getNodes({ store: candidate }))) > 6 * 1024 * 1024) {
        throw badRequest("订阅节点过多，请减少节点后重试");
      }
      routesChanged = await applySubscriptionSnapshot(previous, candidate, references, assertIdle);
      const live = new Set(candidate.nodes.filter((node) => !node.missing).map((node) => node.id));
      for (const id of nodeLatency.keys()) if (!live.has(id)) nodeLatency.delete(id);
    }
    for (const [id, sequence] of attempts) {
      if (sequence === null) appliedDownloads.delete(id);
      else appliedDownloads.set(id, sequence);
    }
    return { results, routesChanged };
  });
}

export async function addSubscriptions(values, options = {}) {
  const sources = readStore().subscriptions ?? [];
  const providedNames = Array.isArray(options?.names) ? options.names : [];
  const requests = await Promise.all(values.map(async (value, index) => {
    const url = subscriptionUrl(value);
    const rawName = providedNames[index];
    let name;
    if (typeof rawName === "string") {
      const trimmed = rawName.trim();
      if (trimmed) {
        if (trimmed.length > 200 || /[\x00-\x1f\x7f]/.test(trimmed)) {
          return { url, name: trimmed.slice(0, 200), downloaded: { error: "订阅别名须为 1–200 个字符" } };
        }
        name = trimmed;
      }
    }
    const duplicate = url && sources.some((source) => subscriptionUrl(source.url) === url);
    return { url, name, downloaded: duplicate ? { error: "此链接已存在" } : await downloadSubscription(url) };
  }));
  return commitSubscriptions(requests, options);
}

export async function updateSubscription({ id, name, url: value }, options) {
  const initial = requireSource(readStore().subscriptions ?? [], id);
  if (name !== undefined) {
    name = name.trim();
    if (!name || name.length > 200 || /[\x00-\x1f\x7f]/.test(name)) throw badRequest("订阅别名须为 1–200 个字符");
  }
  if (value === undefined) return commitSubscriptions([{ initial, name }], options);
  const replacement = Symbol();
  linkReplacements.set(id, replacement);
  try {
    const url = subscriptionUrl(value);
    const downloaded = await downloadSubscription(url);
    return await commitSubscriptions([{ initial, name, url, downloaded, replacement }], options);
  } finally {
    if (linkReplacements.get(id) === replacement) linkReplacements.delete(id);
  }
}

export async function refreshSubscriptions(ids, options) {
  const sources = readStore().subscriptions ?? [];
  const selected = ids ? [...new Set(ids)].map((id) => requireSource(sources, id)) : sources.filter((source) => source.url);
  if (!selected.length) throw badRequest("尚未配置订阅地址");
  const requests = await Promise.all(selected.map(async (initial) => {
    const url = subscriptionUrl(initial.url);
    return { initial, url, downloaded: await downloadSubscription(url) };
  }));
  return commitSubscriptions(requests, options);
}

export function removeSubscription(id, options) {
  return commitSubscriptions([{ initial: requireSource(readStore().subscriptions ?? [], id), remove: true }], options);
}

export async function importCustom(input, protocol = "http") {
  const imported = parseCustomProxies(input, protocol);
  const previous = readStore();
  const { nodes, savedIds, createdIds } = upsertCustomNodes(previous.nodes, imported, { preserveExistingName: true });
  writeStore({ ...previous, nodes });
  for (const id of createdIds) nodeLatency.delete(id);
  // New nodes are not routed until selected by a group. Import need not stop Chrome traffic.
  return { count: savedIds.length, total: nodes.length };
}

export async function setNodeEnabled(id, enabled) {
  const store = readStore();
  const n = store.nodes.find((x) => x.id === id);
  if (!n) return null;
  const affectsRuntime = referencedProxyIds().has(id);
  n.enabled = !!enabled;
  writeStore(store);
  // 未被分组使用的节点不在运行配置里，切换它无需打断当前代理连接。
  if (affectsRuntime) await restart();
  return getNodes().find((x) => x.id === id) ?? null;
}

export async function setNodeDirectOutbound(idsOrId, directOutbound, { assertIdle = () => {} } = {}) {
  const isBatch = Array.isArray(idsOrId);
  const idList = isBatch ? [...new Set(idsOrId.filter(Boolean))] : [idsOrId].filter(Boolean);
  if (!idList.length) throw badRequest("请指定要更新的代理节点");
  const flag = Boolean(directOutbound);
  return runLifecycleTransition(async () => {
    const previous = readStore();
    const idSet = new Set(idList);
    const matched = previous.nodes.filter((item) => idSet.has(item.id));
    if (!matched.length) return null;
    const changed = matched.filter((item) => Boolean(item.directOutbound) !== flag);
    if (!changed.length) {
      const currentNodes = getNodes({ store: previous }).filter((item) => idSet.has(item.id));
      return isBatch
        ? { ok: true, count: currentNodes.length, ids: currentNodes.map((item) => item.id), directOutbound: flag }
        : currentNodes[0] ?? null;
    }
    const nextNodes = previous.nodes.map((item) =>
      idSet.has(item.id) ? { ...item, directOutbound: flag } : item
    );
    const candidate = { ...previous, nodes: nextNodes };
    const references = referencedProxyIds(previous);
    const affectsRuntime = changed.some(
      (item) => references.has(item.id) && item.enabled !== false && !item.missing
    );
    if (affectsRuntime) {
      assertIdle();
      const previousBasePort = activeBasePort;
      try {
        await ensureRunningUnlocked(candidate, references, { allowReuse: true });
      } catch (error) {
        activeBasePort = previousBasePort;
        try { await ensureRunningUnlocked(previous, references, { allowReuse: true }); } catch { /* 保留原始错误 */ }
        throw error;
      }
    }
    // 重读最新状态，仅更新目标节点的 directOutbound，避免覆盖重启期间并发导入/改名。
    const latest = readStore();
    writeStore({
      ...latest,
      nodes: latest.nodes.map((item) => (idSet.has(item.id) ? { ...item, directOutbound: flag } : item)),
    });
    for (const item of matched) nodeLatency.delete(item.id);
    const updatedNodes = getNodes().filter((item) => idSet.has(item.id));
    return isBatch
      ? { ok: true, count: updatedNodes.length, ids: updatedNodes.map((item) => item.id), directOutbound: flag }
      : updatedNodes[0] ?? null;
  });
}

function requireCustomNode(store, id) {
  const node = store.nodes.find((item) => item.id === id);
  if (!node || !node.id.startsWith("custom_")) throw badRequest("自定义节点不存在");
  return node;
}

export function getCustom(id) {
  const node = requireCustomNode(readStore(), id);
  if (customNodeKind(node.raw) !== "simple") {
    throw badRequest("该自定义节点使用 Clash YAML 格式，请在 YAML 编辑器中查看与修改");
  }
  return { id: node.id, name: node.name, protocol: node.raw.tls ? "https" : node.raw.type,
    server: node.raw.server, port: node.raw.port,
    username: node.raw.username ?? "", password: node.raw.password ?? "" };
}

export function previewCustomConfig(input) {
  const { nodes, skipped } = parseCustomConfigInput(input);
  return {
    nodes: nodes.map(({ name, type, server, port, yaml }) => ({
      name,
      type,
      server,
      port,
      yaml,
      udpOnly: isUdpOnlyProxyType(type),
    })),
    skipped,
  };
}

export function getCustomConfig(id) {
  const node = requireCustomNode(readStore(), id);
  return {
    id: node.id,
    name: node.name,
    type: String(node.raw?.type ?? ""),
    server: String(node.raw?.server ?? ""),
    port: normalizeProxyPort(node.raw?.port) ?? 1,
    yaml: stringifyCustomNodeYaml(node.raw),
  };
}

function upsertCustomNodes(existingNodes, incomingItems, { preserveExistingName = false } = {}) {
  const byId = new Map(existingNodes.map((node) => [node.id, node]));
  const byConnection = new Map();
  for (const node of existingNodes) {
    if (!node.id.startsWith("custom_")) continue;
    const key = customConfigNodeId(node.raw);
    if (key && !byConnection.has(key)) byConnection.set(key, node);
  }
  const savedIds = new Set();
  const createdIds = [];
  for (const item of incomingItems) {
    const key = customConfigNodeId(item.raw);
    const matched = byConnection.get(key);
    let nodeId = matched?.id ?? key;
    if (!matched && byId.has(nodeId)) {
      do {
        nodeId = `custom_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
      } while (byId.has(nodeId));
    }
    const runtimeName = matched?.raw?.name ?? nodeId;
    const displayName = preserveExistingName && matched?.name ? matched.name : item.name;
    const customName = preserveExistingName && matched ? matched.customName : displayName;
    const nextNode = {
      ...matched,
      id: nodeId,
      name: displayName,
      ...(customName ? { customName } : {}),
      portSlot: matched?.portSlot,
      enabled: matched ? matched.enabled !== false : true,
      missing: false,
      directOutbound: typeof item.directOutbound === "boolean"
        ? item.directOutbound
        : Boolean(matched?.directOutbound),
      raw: { ...item.raw, name: runtimeName },
    };
    byId.set(nodeId, nextNode);
    byConnection.set(key, nextNode);
    savedIds.add(nodeId);
    if (!matched) createdIds.push(nodeId);
  }
  return { nodes: [...byId.values()], savedIds: [...savedIds], createdIds };
}

export async function saveCustom(params) {
  const { id, protocol, port, username = "", password = "" } = params;
  const name = validateNodeDisplayName(params.name);
  const server = typeof params.server === "string" ? params.server.trim() : "";
  if (!["http", "https", "socks5"].includes(protocol) || !Number.isInteger(port) || port < 1 || port > 65535 || !server || /[\s/@?#\\]/.test(server)) throw badRequest("请填写有效的协议、服务器和端口（1–65535）");
  if (typeof username !== "string" || typeof password !== "string" || (password && !username)) throw badRequest("填写密码时必须填写用户名");
  const host = server.includes(":") && !server.startsWith("[") ? `[${server}]` : server;
  const auth = username ? `${encodeURIComponent(username)}:${encodeURIComponent(password)}@` : "";
  const [parsed] = parseCustomProxies(`${protocol}://${auth}${host}:${port}`);
  const store = readStore();
  if (!id) {
    const { nodes, createdIds } = upsertCustomNodes(store.nodes, [{ name, raw: parsed.raw }]);
    writeStore({ ...store, nodes });
    for (const createdId of createdIds) nodeLatency.delete(createdId);
    return { ok: true };
  }
  const old = requireCustomNode(store, id);
  const node = {
    ...parsed,
    id: old.id,
    name,
    customName: name,
    enabled: old.enabled !== false,
    directOutbound: Boolean(old.directOutbound),
    portSlot: old.portSlot,
    raw: { ...parsed.raw, name: old.raw.name ?? parsed.raw.name },
  };
  const connectionChanged = stableJson(old.raw) !== stableJson(node.raw);
  const nodes = store.nodes.map((item) => (item.id === old.id ? node : item));
  writeStore({ ...store, nodes });
  if (connectionChanged) {
    nodeLatency.delete(old.id);
    if (referencedProxyIds().has(old.id)) await restart();
  }
  return { ok: true };
}

export async function saveCustomConfig(params = {}) {
  const { id, items } = params;
  if (!Array.isArray(items) || !items.length || items.length > 100) {
    throw badRequest("请提供 1–100 条有效的自定义节点配置");
  }
  if (id && items.length !== 1) {
    throw badRequest("编辑自定义节点时一次只能保存 1 条配置");
  }
  const parsedItems = items.map((item) => {
    if (!item || typeof item !== "object") throw badRequest("节点配置条目格式无效");
    const parsed = parseSingleCustomNodeYaml(item.yaml, item.name);
    return {
      ...parsed,
      ...(typeof item.directOutbound === "boolean" ? { directOutbound: item.directOutbound } : {}),
    };
  });

  if (id) {
    return runLifecycleTransition(async () => {
      const store = readStore();
      const old = requireCustomNode(store, id);
      const { name, raw, directOutbound } = parsedItems[0];
      const runtimeName = old.raw?.name ?? old.id;
      const updated = {
        id: old.id,
        name,
        customName: name,
        portSlot: old.portSlot,
        enabled: old.enabled !== false,
        missing: false,
        directOutbound: typeof directOutbound === "boolean" ? directOutbound : Boolean(old.directOutbound),
        raw: { ...raw, name: runtimeName },
      };
      const connectionChanged = stableJson(old.raw) !== stableJson(updated.raw) || Boolean(old.directOutbound) !== Boolean(updated.directOutbound);
      const candidate = {
        ...store,
        nodes: store.nodes.map((item) => (item.id === old.id ? updated : item)),
      };
      const references = referencedProxyIds(store);
      if (connectionChanged && references.has(old.id) && updated.enabled) {
        const previousBasePort = activeBasePort;
        try {
          await ensureRunningUnlocked(candidate, references, { allowReuse: false });
        } catch (error) {
          activeBasePort = previousBasePort;
          try {
            await ensureRunningUnlocked(store, references, { allowReuse: false });
          } catch {
            /* 保留原始启动错误 */
          }
          throw Object.assign(
            new Error(`新节点配置无法应用，已保留原配置：${error.message || error}`, { cause: error }),
            { code: "PROXY_UNAVAILABLE" }
          );
        }
      }
      // 重读最新状态，仅更新目标节点，避免覆盖重启期间并发导入的新节点。
      const latest = readStore();
      writeStore({
        ...latest,
        nodes: latest.nodes.map((item) => (item.id === old.id ? updated : item)),
      });
      if (connectionChanged) nodeLatency.delete(old.id);
      return { ok: true, count: 1, ids: [old.id] };
    });
  }

  const store = readStore();
  const { nodes, savedIds, createdIds } = upsertCustomNodes(store.nodes, parsedItems);
  writeStore({ ...store, nodes });
  for (const createdId of createdIds) nodeLatency.delete(createdId);
  return { ok: true, count: savedIds.length, ids: savedIds };
}

export async function renameCustom(id, value) {
  const name = validateNodeDisplayName(value);
  const store = readStore();
  const node = requireCustomNode(store, id);
  node.name = name;
  node.customName = name;
  // Runtime names are stable IDs; changing the display name does not restart traffic.
  writeStore(store);
  return { ok: true };
}

export async function renameNode(id, value) {
  const store = readStore();
  const node = store.nodes.find((item) => item.id === id);
  if (!node) throw badRequest("代理节点不存在");
  const isCustom = node.id.startsWith("custom_");
  if (isCustom) {
    const name = validateNodeDisplayName(value, { allowEmpty: false });
    node.name = name;
    node.customName = name;
  } else {
    const customName = validateNodeDisplayName(value, { allowEmpty: true });
    const originalName = typeof node.raw?.name === "string" && node.raw.name.trim()
      ? node.raw.name.trim()
      : node.name;
    if (customName) {
      node.customName = customName;
      node.name = customName;
    } else {
      delete node.customName;
      node.name = originalName;
    }
  }
  // Runtime names are stable IDs; changing the display name does not restart traffic.
  writeStore(store);
  return {
    ok: true,
    id: node.id,
    name: node.name,
    originalName: isCustom ? null : (typeof node.raw?.name === "string" && node.raw.name.trim() ? node.raw.name.trim() : node.name),
    customNamed: !isCustom && Boolean(node.customName),
  };
}

export async function removeCustom(id) {
  const store = readStore();
  requireCustomNode(store, id);
  if (referencedProxyIds().has(id)) throw badRequest("该节点正被分组使用、被临时窗口引用或已选为网络中转，请先修改对应配置再删除");
  portMapFrom(store.nodes);
  const portOrder = store.subscriptions ? null : portOrderAfterRemoval ?? store.nodes.map((node) => node.id);
  writeStore({ ...store, nodes: store.nodes.filter((node) => node.id !== id) });
  portOrderAfterRemoval = portOrder;
  nodeLatency.delete(id);
  return { ok: true };
}

export async function clearNodes() {
  const previous = readStore();
  const references = referencedProxyIds(previous);
  writeStore({
    ...previous,
    subscription: null,
    ...(previous.subscriptions ? { subscriptions: [] } : {}),
    nodes: previous.subscriptions ? previous.nodes.filter((node) => references.has(node.id))
      .map((node) => ({ ...node, sourceId: null, raw: {}, enabled: false, missing: true })) : [],
    mihomoPath: previous.mihomoPath,
    clashVergeDir: previous.clashVergeDir,
  });
  nodeLatency.clear();
  portOrderAfterRemoval = null;
  await runLifecycleTransition(() => stopAndWait());
}

// ---------- 端口分配 ----------

// 节点 id -> 预留本地端口。严格按订阅位置分配，停用节点也保留自己的槽位；
// 这样切换一个未被分组使用的节点，不会让后续分组节点的端口整体位移。
// 当前边车实际使用的端口段起点。默认段与 Clash Verge 重叠时会自动下移，
// 所以端口不能在每次调用时重算 —— getNodes/proxyForAccount 必须和正在运行的
// 边车看到同一批端口，否则浏览器会把流量发到错误的监听口。
let activeBasePort = null;

function configuredBasePort(store = readStore()) {
  const value = Number(store.basePort);
  return Number.isInteger(value) && value >= 1024 && value <= 60000 ? value : DEFAULT_BASE_PORT;
}

function currentBasePort() {
  return activeBasePort ?? configuredBasePort();
}

function apiPortFor(basePort) {
  return basePort + API_PORT_OFFSET;
}

/**
 * 找一段可用的端口区间。
 *
 * 首选配置里的段（默认 21000）。只有当该段确实被别的程序占用时才向后让路 ——
 * 常见情形是用户的 Clash Verge 也在这一段开入站监听。让路而不是抢占：按进程名
 * 杀 mihomo 会把用户自己的网络一起切断。
 *
 * 只检查实际要用到的端口，不检查整段：段内零散端口被占用不影响我们。
 */
async function resolveFreeBasePort(store, references, preserveCurrentPort) {
  const preferred = configuredBasePort(store);
  const bases = Array.from({ length: 12 }, (_, index) => preferred + index * 1000);
  if (preserveCurrentPort && activeBasePort !== null) bases.unshift(activeBasePort);
  for (const base of new Set(bases)) {
    if (apiPortFor(base) > 65535) continue;
    // 先给现有程序让位，再验证最终链路。系统代理本身可能占着首选端口，
    // 此时提前生成配置会把外部代理误判成本工具的循环入口。
    const { nodes } = store;
    const ports = portMapFrom(nodes, base);
    const candidates = [
      apiPortFor(base),
      ...selectRuntimeProxyNodes(nodes, references).map((node) => ports.get(node.id)),
    ];
    if ((await findOccupiedPorts(candidates)).length === 0) return base;
  }
  return null;
}

function portMapFrom(nodes, basePort = currentBasePort()) {
  if (nodes.some((node) => Number.isInteger(node.portSlot))) {
    return new Map(allocateProxySlots(nodes).map(({ id, portSlot }) => {
      const port = basePort + portSlot + Number(portSlot >= API_PORT_OFFSET);
      if (port > 65535) throw badRequest("代理节点过多，本地监听端口已用尽");
      return [id, port];
    }));
  }
  if (portOrderAfterRemoval) {
    const known = new Set(portOrderAfterRemoval);
    for (const node of nodes) {
      if (!known.has(node.id)) portOrderAfterRemoval.push(node.id);
    }
  }
  return assignStablePorts(portOrderAfterRemoval?.map((id) => ({ id })) ?? nodes, {
    basePort,
    reservedPorts: [apiPortFor(basePort)],
  });
}

let temporaryProxyIds = () => [];

export function configureTemporaryProxyIds(provider) {
  const previous = temporaryProxyIds;
  temporaryProxyIds = provider;
  return () => { temporaryProxyIds = previous; };
}

function referencedProxyIds(store = readStore()) {
  const ids = new Set(
    getGroups()
      .map((group) => group.proxyId)
      .filter(Boolean)
  );
  const network = normalizeNetworkConfig(store.network);
  for (const id of temporaryProxyIds()) if (id) ids.add(id);
  if (network.mode === "relay") ids.add(network.relayProxyId);
  return ids;
}

/**
 * 账号要用的代理地址。代理绑在**分组**上，所以这里先解析账号所属分组的节点。
 * 未分组、或分组没绑节点则返回 null（走系统默认网络）。
 */
export function proxyForAccount(account) {
  return proxyForNode(effectiveProxyId(account));
}

export function getNodeUdpConflict(id, store = readStore()) {
  if (!id) return null;
  const node = store.nodes.find((item) => item.id === id);
  if (!node || node.enabled === false || node.missing) return null;
  const config = normalizeNetworkConfig(store.network);
  const systemProxy = config.mode === "system" ? resolveSystemProxy(config) : undefined;
  const relayNode = config.mode === "relay"
    ? store.nodes.find((item) => item.id === config.relayProxyId)
    : null;
  return udpDialerConflict(node, { config, systemProxy, relayNode });
}

// Direct node binding for independent browser windows; no synthetic group/account.
export function proxyForNode(selectedProxyId) {
  const store = readStore();
  const config = normalizeNetworkConfig(store.network);
  const proxyId = selectedProxyId || (config.mode === "relay" ? config.relayProxyId : null);
  if (!proxyId) {
    const systemProxy = config.mode === "system" ? resolveSystemProxy(config) : null;
    return systemProxy?.server ? { server: systemProxy.server } : null;
  }
  const node = store.nodes.find((candidate) => candidate.id === proxyId);
  if (!node || node.enabled === false || node.missing) return null;
  if (getNodeUdpConflict(proxyId, store)) return null;
  const port = portMapFrom(store.nodes).get(proxyId) ?? null;
  return port ? { server: `http://127.0.0.1:${port}` } : null;
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

export function waitForNetworkTransition() {
  return lifecycleTail;
}

function relayUnavailable(store) {
  const config = normalizeNetworkConfig(store.network);
  if (config.mode !== "relay") return false;
  const relay = store.nodes.find((node) => node.id === config.relayProxyId);
  return !relay || relay.missing || relay.enabled === false || !relay.raw?.type || !relay.raw?.server;
}

function subscriptionRuntimeSignature(store, references) {
  if (relayUnavailable(store)) return "relay-unavailable";
  const cfg = buildConfig(currentBasePort(), store, references);
  return cfg.listeners.length ? stableJson(cfg) : "idle";
}

async function applySubscriptionSnapshot(previous, candidate, references, assertIdle) {
  // Untouched bindings keep their node objects and their allocated port slots.
  const boundBefore = new Set(previous.nodes.filter((node) => references.has(node.id)));
  const boundAfter = candidate.nodes.filter((node) => references.has(node.id));
  if (boundBefore.size === boundAfter.length && boundAfter.every((node) => boundBefore.has(node))) {
    writeStore(candidate);
    return false;
  }
  let previousRuntime;
  try {
    previousRuntime = subscriptionRuntimeSignature(previous, references);
  } catch {
    // A refresh can repair an existing invalid configuration.
  }
  let nextRuntime;
  try {
    nextRuntime = subscriptionRuntimeSignature(candidate, references);
  } catch (error) {
    // A restored listener can claim a port that an external system proxy now occupies.
    if (!previousRuntime || !error.systemProxyPort || !(await findOccupiedPorts([error.systemProxyPort])).length) throw error;
  }
  if (nextRuntime === previousRuntime) {
    writeStore(candidate);
    return false;
  }
  assertIdle();
  const previousBasePort = activeBasePort;
  const before = stableJson(previous);
  const referenceKey = [...references].sort().join("\n");
  try {
    if (nextRuntime === "relay-unavailable") await stopAndWait();
    else await ensureRunningUnlocked(candidate, references, { allowReuse: nextRuntime !== undefined });
    const latest = readStore();
    if (stableJson(latest) !== before || [...referencedProxyIds(latest)].sort().join("\n") !== referenceKey) {
      throw Object.assign(new Error("代理绑定或配置已变更，请重试订阅操作"), { code: "RESOURCE_BUSY" });
    }
    writeStore(candidate);
    return true;
  } catch (error) {
    activeBasePort = previousBasePort;
    try {
      const saved = readStore();
      if (relayUnavailable(saved)) await stopAndWait();
      else await ensureRunningUnlocked(saved);
    } catch {
      await stopAndWait();
      throw Object.assign(new Error("订阅应用失败，原代理配置暂时无法启动"), { code: "PROXY_UNAVAILABLE" });
    }
    if (error.code === "RESOURCE_BUSY") throw error;
    throw Object.assign(new Error("订阅应用失败，已恢复原代理配置"), { code: "PROXY_UNAVAILABLE" });
  }
}

export function buildConfig(basePort = currentBasePort(), store = readStore(), references = referencedProxyIds(store)) {
  const { nodes, network } = store;
  const config = normalizeNetworkConfig(network);
  const environment = evaluateNetworkEnvironment(config, getHostNetworkSnapshot());
  const systemProxy = config.mode === "system" ? resolveSystemProxy(config) : undefined;
  const ordered = nodes.some((node) => Number.isInteger(node.portSlot))
    ? allocateProxySlots(nodes).sort((a, b) => a.portSlot - b.portSlot)
    : nodes;
  const { adapters, targets: active, mixedDirectAdapter } = compileConnectionRoutes({
    nodes: ordered,
    proxyIds: references,
    network: config,
    systemProxy,
    effectiveOutboundInterface: environment.effectiveOutboundInterface,
    allowPartialUdpSkip: true,
  });
  // 仍按完整订阅中的顺序分配端口，分组引用增减不会改变其它节点的端口。
  const ports = portMapFrom(nodes, basePort);
  assertNoSystemProxyLoop({
    config,
    systemProxy,
    occupiedLocalPorts: [
      ...active.map((node) => ports.get(node.id)),
      apiPortFor(basePort),
      TEST_API_PORT,
    ],
  });

  const listeners = active
    .filter((n) => ports.has(n.id))
    .map((n) => ({
      name: "in-" + n.id,
      type: "http",
      listen: "127.0.0.1",
      port: ports.get(n.id),
      proxy: `out-${n.id}`,
    }));

  return buildMihomoRuntimeConfig({
    controlPort: apiPortFor(basePort),
    adapters,
    listeners,
    rules: ["MATCH,DIRECT"],
    mode: config.mode,
    effectiveOutboundInterface: environment.effectiveOutboundInterface,
    mixedDirectAdapter,
    tunConflictDetected: environment.tunConflict.detected,
  });
}

/**
 * 确保 mihomo 已按当前节点配置运行。没有任何启用节点时不启动。
 *
 * 幂等：配置没变且进程还活着就直接返回。
 * 这点很重要——每个账号启动浏览器都会调它，若每次都重启边车，
 * 一个账号开浏览器就会掐断其它账号正在进行的请求。
 */
async function ensureRunningUnlocked(snapshot, snapshotReferences, { allowReuse = true } = {}) {
  let store = snapshot ?? readStore();
  let references = snapshotReferences ?? referencedProxyIds(store);
  const network = normalizeNetworkConfig(store.network);
  const systemProxy = network.mode === "system" ? resolveSystemProxy(network) : undefined;
  // 先校验中转/系统代理入口并算出实际可启动的节点数，单节点 UDP 冲突只跳过该节点、不连坐其它健康分组。
  const preview = compileConnectionRoutes({
    nodes: store.nodes,
    proxyIds: references,
    network,
    systemProxy,
    allowPartialUdpSkip: true,
  });
  const routedNodeCount = preview.targets.length;
  if (routedNodeCount === 0) {
    await stopAndWait();
    return {
      running: false,
      reason: preview.skippedConflicts.size > 0
        ? "当前引用的节点与前置代理协议不兼容"
        : "没有启用的代理节点",
    };
  }

  const bin = resolveMihomo();
  if (!bin) {
    // 明确报错而不是静默直连：否则账号会以为在走代理，其实是裸奔。
    throw new Error(
      "找不到可独立启动的 mihomo 内核。请到“代理节点”页修改 Clash Verge 安装目录；若使用便携版，也可把 mihomo.exe 放到项目 bin/ 目录"
    );
  }
  const executableKey = process.platform === "win32" ? bin.toLowerCase() : bin;
  // 复用判定必须基于**正在运行**的那个端口段（activeBasePort），而不是配置里的
  // 首选段。否则一旦发生过让路，每次调用都会认为配置变了而重启边车 —— 每个账号
  // 开浏览器都会掐断其它账号正在进行的请求。
  if (allowReuse && child && !child.killed) {
    const reuseFingerprint = stableJson({
      config: buildConfig(currentBasePort(), store, references),
      executable: executableKey,
    });
    if (currentFingerprint === reuseFingerprint) {
      return { running: true, nodes: routedNodeCount, reused: true };
    }
  }

  // 先等旧进程真正退出，再起新的：否则旧进程还占着端口，
  // 新进程会绑定失败。
  await stopAndWait();
  if (!snapshot) {
    store = readStore();
    references = referencedProxyIds(store);
    if (!selectRuntimeProxyNodes(store.nodes, references).length && !relayUnavailable(store)) {
      return { running: false, reason: "没有启用的代理节点" };
    }
  }

  // 自己的进程已退出，此时仍被占用的端口一定属于别的程序 —— 通常是用户的
  // Clash Verge，它的入站端口段与本项目默认段（21000+）重叠。
  //
  // 撞上时必须自己让路，不能去动占用者：按进程名杀 mihomo 会切断用户的网络。
  // 也不能无视冲突继续启动：mihomo 绑定失败会立刻退出，而"端口连得上"的检查
  // 会把 Verge 的监听误判为启动成功，账号流量最终流向另一套路由规则，
  // 表现为 ERR_PROXY_CONNECTION_FAILED。
  const basePort = await resolveFreeBasePort(store, references, !!snapshot);
  if (basePort === null) {
    throw new Error(
      `本地端口段 ${configuredBasePort()} 起连续多段都已被其它程序占用` +
        `（常见原因：Clash Verge 的入站端口段与本程序重叠）。` +
        `请调整 Clash Verge 的端口设置后重试；本程序不会关闭占用端口的进程。`
    );
  }
  if (basePort !== configuredBasePort()) {
    log.info(`默认端口段被占用，本次改用 ${basePort} 起的空闲端口段`);
  }
  // 端口段确定后再生成最终配置，并让 getNodes/proxyForAccount 看到同一批端口。
  const cfg = buildConfig(basePort, store, references);
  if (!cfg.listeners.length) {
    await stopAndWait();
    return { running: false, reason: "没有可启动的兼容代理节点" };
  }
  const fingerprint = stableJson({ config: cfg, executable: executableKey });

  ensureDir(RUNTIME_DIR);
  const cfgPath = path.join(RUNTIME_DIR, "config.yaml");
  fs.writeFileSync(cfgPath, YAML.stringify(cfg), "utf8");

  const proc = spawn(bin, ["-d", RUNTIME_DIR, "-f", cfgPath], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child = proc;
  let spawnError = null;
  proc.once("error", (error) => {
    spawnError = error;
    log.warn("mihomo 进程无法启动: " + String(error?.message || error));
    if (child === proc) {
      child = null;
      currentFingerprint = null;
    }
  });
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

  const readiness = await waitAllPortsReady(
    cfg.listeners.map((listener) => listener.port),
    {
      timeoutMs: 20000,
      shouldStop: () => !!spawnError || proc.exitCode !== null || proc.signalCode !== null,
    }
  );
  if (!readiness.ok) {
    await stopAndWait();
    throw new Error(
      spawnError
        ? `mihomo 无法启动：${String(spawnError.message || spawnError)}`
        : proc.exitCode !== null
          ? `mihomo 启动后立即退出（code=${proc.exitCode}），请检查节点配置与端口占用`
          : `mihomo 入站端口 ${readiness.port} 未就绪，请检查节点配置与端口占用`
    );
  }

  const applied = await waitMihomoConfigApplied(apiPortFor(basePort), cfg, {
    shouldStop: () => !!spawnError || proc.exitCode !== null || proc.signalCode !== null,
  });
  if (!applied.ok) {
    await stopAndWait();
    throw new Error("mihomo 配置未完成应用，代理转发尚未就绪，请检查内核和控制端口");
  }
  activeBasePort = basePort;
  currentFingerprint = fingerprint;
  const firstPort = cfg.listeners[0].port;
  log.info(`代理边车已启动：${cfg.listeners.length} 个节点全部就绪，端口 ${firstPort}+`);
  return { running: true, nodes: cfg.listeners.length, basePort };
}

export function ensureRunning() {
  return runLifecycleTransition(() => ensureRunningUnlocked());
}

/**
 * 让主边车与当前分组引用保持一致。配置未变化时复用现有进程；
 * 同步失败只返回状态，由调用方继续保留已经保存的分组配置。
 */
export async function reconcile() {
  try {
    return await ensureRunning();
  } catch (e) {
    log.warn("同步分组代理配置失败: " + e.message);
    return { running: false, reason: e.message };
  }
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
  // 下次启动重新探测空闲端口段：占用情况可能已经变化。
  activeBasePort = null;
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

export async function restart({ throwOnError = false } = {}) {
  return runLifecycleTransition(async () => {
    await stopAndWait();
    try {
      return await ensureRunningUnlocked();
    } catch (e) {
      log.warn("代理边车重启失败: " + e.message);
      if (throwOnError) throw e;
      return { running: false, reason: e.message };
    }
  });
}

export function status() {
  const { nodes, clashVergeDir } = readStore();
  const routedNodeCount = selectRuntimeProxyNodes(nodes, referencedProxyIds()).length;
  return {
    running: !!child && !child.killed,
    mihomo: getMihomoInfo(),
    nodeCount: nodes.filter((n) => n.enabled !== false && !n.missing).length,
    routedNodeCount,
    subscription: getSubscriptionInfo(),
    clashVergeDir,
    // 实际使用的端口段：与 Clash Verge 冲突时会自动下移，界面上要能看出来。
    basePort: currentBasePort(),
    basePortShifted: activeBasePort !== null && activeBasePort !== configuredBasePort(),
  };
}

/**
 * 检查端口是否已被本机其它程序占用。
 *
 * 本项目的端口段（21000+）会和用户自己的 Clash Verge 撞上 —— Verge 也在这一段开
 * 入站监听。撞上时后果很隐蔽：mihomo 绑定失败后立刻退出，而 waitPort 连得上那个
 * 被 Verge 占着的端口，于是被判定为"启动成功"，浏览器把流量发给 Verge 的入站口，
 * 路由规则完全不同，最终表现为 ERR_PROXY_CONNECTION_FAILED。
 *
 * 用 bind 而不是 connect 判断：connect 成功只说明"有人在听"，无法区分是不是自己。
 */
function isPortAvailable(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.once("listening", () => probe.close(() => resolve(true)));
    // exclusive 阻止 SO_REUSEADDR 造成的"看起来能绑"假象。
    probe.listen({ host: "127.0.0.1", port, exclusive: true });
  });
}

async function findOccupiedPorts(ports) {
  const occupied = [];
  for (const port of ports) {
    if (!(await isPortAvailable(port))) occupied.push(port);
  }
  return occupied;
}

/**
 * 等待**每一个**入站端口都可连接。
 *
 * 早先只等 listeners[0]：第一个端口一通就返回"启动成功"，但 mihomo 还在逐个绑定
 * 其余监听。此时发起登录的账号如果用的是后面的端口（例如 9 个节点里的第 4 个），
 * 浏览器就会拿到 ERR_PROXY_CONNECTION_FAILED —— 表现为"部分账号刚好在这几秒里失败、
 * 重试一次又好了"，非常难定位。
 *
 * shouldStop 为真表示我们自己的进程已经退出：此时必须立刻放弃，否则会把别的程序
 * 占用的同号端口误判成自己启动成功。
 */
export async function waitAllPortsReady(ports, { timeoutMs = 20000, shouldStop = () => false } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (const port of ports) {
    if (shouldStop()) return { ok: false, port, stopped: true };
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { ok: false, port, timedOut: true };
    if (!(await waitPort(port, remaining, shouldStop))) {
      return { ok: false, port, stopped: shouldStop() };
    }
  }
  return { ok: true };
}

function waitPort(port, timeoutMs, shouldStop = () => false) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const tryOnce = () => {
      if (shouldStop()) return resolve(false);
      const sock = net.connect({ host: "127.0.0.1", port }, () => {
        sock.destroy();
        resolve(true);
      });
      sock.on("error", () => {
        sock.destroy();
        if (shouldStop()) return resolve(false);
        if (Date.now() > deadline) return resolve(false);
        setTimeout(tryOnce, 300);
      });
    };
    tryOnce();
  });
}

function loopbackJsonGet(port, reqPath, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: reqPath,
        method: "GET",
        agent: false,
        headers: { Connection: "close" },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => { body += chunk; });
        res.on("error", reject);
        res.on("end", () => {
          let data = {};
          try { data = body ? JSON.parse(body) : {}; } catch { /* non-JSON error body */ }
          resolve({ statusCode: res.statusCode ?? 0, ok: res.statusCode >= 200 && res.statusCode < 300, data });
        });
      }
    );
    const timer = setTimeout(() => req.destroy(new Error("请求超时")), timeoutMs);
    req.on("close", () => clearTimeout(timer));
    req.on("error", reject);
    req.end();
  });
}

async function measureTestNode(node) {
  const reqPath = `/proxies/${encodeURIComponent(`out-${node.id}`)}/delay?timeout=8000&url=${encodeURIComponent(
    "https://www.gstatic.com/generate_204"
  )}`;
  try {
    const res = await loopbackJsonGet(TEST_API_PORT, reqPath, 15000);
    if (!res.ok) {
      return { ok: false, message: res.data?.message || `HTTP ${res.statusCode}` };
    }
    return { ok: true, delay: res.data?.delay ?? null };
  } catch (e) {
    return { ok: false, message: String(e.message || e) };
  }
}

const auxiliaryChildren = new Set();
let testLifecycleTail = Promise.resolve();

function runTestLifecycle(fn) {
  const run = testLifecycleTail.then(fn, fn);
  testLifecycleTail = run.then(
    () => {},
    () => {}
  );
  return run;
}

// ---------- 直出旁路边车（用于未绑定账号 / iCloud 直连 / 订阅拉取绕过系统 TUN） ----------

let directBypassChild = null;
let directBypassPort = null;
let directBypassFingerprint = null;
let directBypassTail = Promise.resolve();

function runDirectBypassLifecycle(fn) {
  const run = directBypassTail.then(fn, fn);
  directBypassTail = run.then(
    () => {},
    () => {}
  );
  return run;
}

function stopDirectBypass() {
  if (directBypassChild && !directBypassChild.killed) {
    try { directBypassChild.kill(); } catch { /* 进程可能已退出 */ }
  }
  directBypassChild = null;
  directBypassPort = null;
  directBypassFingerprint = null;
}

async function stopDirectBypassUnlocked(timeoutMs = 5000) {
  const proc = directBypassChild;
  directBypassChild = null;
  directBypassPort = null;
  directBypassFingerprint = null;
  if (proc) await stopAuxiliaryAndWait(proc, timeoutMs);
}

function stopDirectBypassAndWait(timeoutMs = 5000) {
  return runDirectBypassLifecycle(() => stopDirectBypassUnlocked(timeoutMs));
}

/**
 * 在检测到本机 TUN 冲突或用户指定了直出物理网卡时，启动/复用轻量级直出旁路边车，
 * 供未绑定节点的直连浏览器、iCloud 直连窗口及直连模式订阅下载经物理网卡直出。
 * 未生效物理网卡绑定或缺少 mihomo 内核时返回 null，调用方回落原生直连。
 */
export function ensureDirectBypassProxy({ signal } = {}) {
  return runDirectBypassLifecycle(async () => {
    throwIfCancelled(signal);
    const config = normalizeNetworkConfig(readStore().network);
    const environment = evaluateNetworkEnvironment(config, getHostNetworkSnapshot());
    const outboundInterface = environment.effectiveOutboundInterface;
    if (!outboundInterface) {
      await stopDirectBypassUnlocked();
      return null;
    }

    const bin = resolveMihomo();
    if (!bin) {
      if (environment.outboundInterfaceSource === "manual") {
        throw Object.assign(
          new Error(
            `已指定直出物理网卡「${outboundInterface}」，但找不到可独立启动的 mihomo 内核。请到“代理节点”页配置 Clash Verge 安装目录，或将直出网卡改回自动选择`
          ),
          { code: "PROXY_UNAVAILABLE" }
        );
      }
      log.warn(`检测到 TUN 冲突并推荐使用物理网卡 ${outboundInterface}，但未找到 mihomo 内核，已回落原生直连`);
      return null;
    }
    const executableKey = process.platform === "win32" ? bin.toLowerCase() : bin;
    const fingerprint = stableJson({ outboundInterface, executable: executableKey });

    if (
      directBypassChild &&
      !directBypassChild.killed &&
      directBypassChild.exitCode === null &&
      directBypassFingerprint === fingerprint &&
      directBypassPort
    ) {
      return { server: `http://127.0.0.1:${directBypassPort}`, outboundInterface };
    }

    await stopDirectBypassUnlocked();
    throwIfCancelled(signal);

    const [controlPort, listenerPort] = await reserveLoopbackPorts(2);
    const cfg = buildDirectBypassConfig({ controlPort, listenerPort, outboundInterface });
    ensureDir(DIRECT_RUNTIME_DIR);
    const cfgPath = path.join(DIRECT_RUNTIME_DIR, "config.yaml");
    fs.writeFileSync(cfgPath, YAML.stringify(cfg), "utf8");

    const proc = spawn(bin, ["-d", DIRECT_RUNTIME_DIR, "-f", cfgPath], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    directBypassChild = proc;
    let spawnError = null;
    proc.once("error", (error) => {
      spawnError = error;
      log.warn("mihomo 直出旁路进程无法启动: " + String(error?.message || error));
      if (directBypassChild === proc) {
        directBypassChild = null;
        directBypassPort = null;
        directBypassFingerprint = null;
      }
    });
    proc.stdout.on("data", (b) => {
      const s = String(b).trim();
      if (s) log.info("[mihomo-direct] " + s.split("\n").slice(-1)[0]);
    });
    proc.stderr.on("data", (b) => {
      const s = String(b).trim();
      if (s) log.warn("[mihomo-direct] " + s.split("\n").slice(-1)[0]);
    });
    proc.on("exit", () => {
      if (directBypassChild === proc) {
        directBypassChild = null;
        directBypassPort = null;
        directBypassFingerprint = null;
      }
    });

    const stopped = () => signal?.aborted || !!spawnError || proc.exitCode !== null || proc.signalCode !== null;
    const portsReady = await waitAllPortsReady([controlPort, listenerPort], {
      timeoutMs: 12000,
      shouldStop: stopped,
    });
    if (!portsReady.ok) {
      await stopDirectBypassUnlocked();
      throwIfCancelled(signal);
      throw new Error(
        spawnError
          ? `直出旁路边车无法启动：${String(spawnError.message || spawnError)}`
          : "直出旁路边车启动后端口未就绪，请检查物理网卡名称与 mihomo 内核"
      );
    }

    const applied = await waitMihomoConfigApplied(controlPort, cfg, {
      timeoutMs: 12000,
      shouldStop: stopped,
    });
    if (!applied.ok) {
      await stopDirectBypassUnlocked();
      throwIfCancelled(signal);
      throw new Error("直出旁路边车配置未完成应用");
    }

    directBypassPort = listenerPort;
    directBypassFingerprint = fingerprint;
    log.info(`直出旁路边车已就绪：物理网卡 ${outboundInterface} -> 127.0.0.1:${listenerPort}`);
    return { server: `http://127.0.0.1:${listenerPort}`, outboundInterface };
  });
}

function buildAuxiliaryConfig(nodes, listenerPort, controlPort) {
  const store = readStore();
  const network = normalizeNetworkConfig(store.network);
  const environment = evaluateNetworkEnvironment(network, getHostNetworkSnapshot());
  const systemProxy = network.mode === "system" ? resolveSystemProxy(network) : undefined;
  const { adapters, targets, mixedDirectAdapter } = compileConnectionRoutes({
    nodes: store.nodes,
    proxyIds: nodes.map((node) => node.id),
    network,
    systemProxy,
    effectiveOutboundInterface: environment.effectiveOutboundInterface,
  });
  if (listenerPort && !targets.some(({ id }) => id === nodes[0].id)) throw badRequest("所选节点不可用");
  assertNoSystemProxyLoop({
    config: network,
    systemProxy,
    occupiedLocalPorts: [controlPort, ...(listenerPort ? [listenerPort] : [])],
  });
  return buildMihomoRuntimeConfig({
    controlPort,
    adapters,
    listeners: listenerPort
      ? [{ name: "account-plan", type: "http", listen: "127.0.0.1", port: listenerPort, proxy: `out-${nodes[0].id}` }]
      : null,
    rules: [listenerPort ? "MATCH,REJECT" : "MATCH,DIRECT"],
    mode: network.mode,
    effectiveOutboundInterface: environment.effectiveOutboundInterface,
    mixedDirectAdapter,
    tunConflictDetected: environment.tunConflict.detected,
  });
}

async function stopAuxiliaryAndWait(proc, timeoutMs = 5000) {
  if (!proc.pid || proc.exitCode !== null || proc.signalCode !== null) return;

  await new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        // 已经退出
      }
      finish();
    }, timeoutMs);
    proc.once("exit", finish);
    try {
      if (!proc.killed) proc.kill();
    } catch {
      finish();
    }
  });
}

async function withMihomoProcess(cfgOrBuilder, fn, {
  listenerPort, signal, controlPort = TEST_API_PORT, runtimeDir = TEST_RUNTIME_DIR,
  purpose = listenerPort ? "账号查询" : "测速",
} = {}) {
  throwIfCancelled(signal);
  const bin = resolveMihomo();
  if (!bin) {
    throw new Error(
      "找不到可独立启动的 mihomo 内核。请到“代理节点”页修改 Clash Verge 安装目录；若使用便携版，也可把 mihomo.exe 放到项目 bin/ 目录"
    );
  }

  if (!(await isPortAvailable(controlPort))) {
    throw badRequest(`${purpose}控制端口 ${controlPort} 已被其它程序占用，请释放该端口后重试`);
  }
  throwIfCancelled(signal);
  const cfg = typeof cfgOrBuilder === "function" ? cfgOrBuilder() : cfgOrBuilder;
  const cfgPath = path.join(ensureDir(runtimeDir), "config.yaml");
  fs.writeFileSync(cfgPath, YAML.stringify(cfg), "utf8");

  const proc = spawn(bin, ["-d", runtimeDir, "-f", cfgPath], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  auxiliaryChildren.add(proc);
  proc.once("close", () => auxiliaryChildren.delete(proc));
  let spawnError = null;
  proc.once("error", (error) => {
    spawnError = error;
    log.warn(`mihomo ${purpose}进程无法启动: ` + String(error?.message || error));
  });
  proc.stdout.on("data", (b) => {
    const s = String(b).trim();
    if (s) log.info("[mihomo-test] " + s.split("\n").slice(-1)[0]);
  });
  proc.stderr.on("data", (b) => {
    const s = String(b).trim();
    if (s) log.warn("[mihomo-test] " + s.split("\n").slice(-1)[0]);
  });
  proc.on("exit", (code) => {
    if (code !== 0 && code !== null) log.warn(`mihomo ${purpose}进程退出，code=${code}`);
  });

  try {
    const stopped = () => signal?.aborted || !!spawnError || proc.exitCode !== null || proc.signalCode !== null;
    const ok = await waitPort(controlPort, 12000, stopped);
    throwIfCancelled(signal);
    if (!ok) {
      throw new Error(
        spawnError
          ? `mihomo ${purpose}进程无法启动：${String(spawnError.message || spawnError)}`
          : `mihomo ${purpose}进程启动后控制端口未就绪`
      );
    }
    const applied = await waitMihomoConfigApplied(controlPort, cfg, {
      timeoutMs: 12000, shouldStop: stopped,
    });
    throwIfCancelled(signal);
    if (!applied.ok) throw new Error(`mihomo ${purpose}配置未完成应用`);
    if (listenerPort && !(await waitPort(listenerPort, 2000, stopped))) throw new Error(`${purpose}节点入口未就绪`);
    throwIfCancelled(signal);
    return await fn();
  } finally {
    await stopAuxiliaryAndWait(proc);
  }
}

function withAuxiliarySidecar(nodes, fn, options = {}) {
  const { listenerPort, controlPort = TEST_API_PORT } = options;
  return withMihomoProcess(
    () => buildAuxiliaryConfig(nodes, listenerPort, controlPort),
    fn,
    options
  );
}

function withTestSidecar(nodes, fn) {
  return runTestLifecycle(() => withAuxiliarySidecar(nodes, fn));
}

async function reserveLoopbackPorts(count) {
  const servers = [];
  try {
    for (let i = 0; i < count; i++) {
      const server = net.createServer();
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      servers.push(server);
    }
    return servers.map((server) => server.address().port);
  } finally {
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  }
}

async function withEphemeralSidecarPorts(cacheSubdir, fn) {
  const [controlPort, listenerPort] = await reserveLoopbackPorts(2);
  const runtimeDir = fs.mkdtempSync(path.join(ensureDir(fromCacheRoot(cacheSubdir)), "run-"));
  try {
    return await fn({ controlPort, listenerPort, runtimeDir });
  } finally {
    await fs.promises.rm(runtimeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 });
  }
}

export function withPlanProxy(id, signal, action) {
  return runTestLifecycle(async () => {
    throwIfCancelled(signal);
    const node = testableNodeOrThrow(readStore().nodes, id);
    const [listenerPort] = await reserveLoopbackPorts(1);
    return withAuxiliarySidecar([node], () => action(`http://127.0.0.1:${listenerPort}`), { listenerPort, signal });
  });
}

export async function withInspectionProxy(id, signal, action) {
  throwIfCancelled(signal);
  const node = testableNodeOrThrow(readStore().nodes, id);
  return withEphemeralSidecarPorts("mihomo-inspection", ({ controlPort, listenerPort, runtimeDir }) =>
    withAuxiliarySidecar([node], () => action(`http://127.0.0.1:${listenerPort}`), {
      listenerPort, controlPort, runtimeDir, signal, purpose: "巡检",
    })
  );
}

async function withSubscriptionHttpProxy(targetUrl, action) {
  let parsed;
  try {
    parsed = new URL(targetUrl);
  } catch {
    return action(null);
  }
  // Keep loopback URLs direct so local fixtures and tests never detour through external proxies.
  if (isLoopbackHost(parsed.hostname)) return action(null);

  const store = readStore();
  const config = normalizeNetworkConfig(store.network);
  const environment = evaluateNetworkEnvironment(config, getHostNetworkSnapshot());

  if (config.mode === "direct") {
    if (!environment.effectiveOutboundInterface) return action(null);
    const bypass = await ensureDirectBypassProxy();
    return action(bypass?.server ?? null);
  }

  if (config.mode === "system") {
    const systemProxy = resolveSystemProxy(config);
    if (["pac", "unavailable"].includes(systemProxy.source) && !systemProxy.server) {
      throw Object.assign(new Error(systemProxy.detail), { code: "PROXY_UNAVAILABLE" });
    }
    if (!systemProxy.server) return action(null);
    const proxyParsed = new URL(systemProxy.server);
    if (proxyParsed.protocol === "http:" || proxyParsed.protocol === "https:") {
      return action(systemProxy.server);
    }
    return withEphemeralSidecarPorts("mihomo-subscription", ({ controlPort, listenerPort, runtimeDir }) =>
      withMihomoProcess(
        () => buildSystemBridgeConfig({
          controlPort,
          listenerPort,
          systemProxyServer: systemProxy.server,
          tunConflictDetected: environment.tunConflict.detected,
        }),
        () => action(`http://127.0.0.1:${listenerPort}`),
        { controlPort, listenerPort, runtimeDir, purpose: "订阅拉取" }
      )
    );
  }

  if (config.mode === "relay") {
    const relayNode = store.nodes.find((node) => node.id === config.relayProxyId);
    if (!relayNode || relayNode.enabled === false || relayNode.missing) {
      throw Object.assign(new Error("指定的中转节点不可用，请到“网络配置”重新选择中转节点"), {
        code: "PROXY_UNAVAILABLE",
      });
    }
    return withEphemeralSidecarPorts("mihomo-subscription", ({ controlPort, listenerPort, runtimeDir }) =>
      withAuxiliarySidecar([relayNode], () => action(`http://127.0.0.1:${listenerPort}`), {
        controlPort, listenerPort, runtimeDir, purpose: "订阅拉取",
      })
    );
  }

  return action(null);
}

function testableNodeOrThrow(nodes, id) {
  const node = nodes.find((n) => n.id === id);
  if (!node) throw badRequest("节点不存在");
  if (node.enabled === false) throw badRequest("该节点已停用，请先启用再测试");
  if (node.missing) throw badRequest("该节点已不在订阅中");
  return node;
}

/**
 * 测试单个节点。使用独立临时 mihomo，不改动承载账号流量的主边车。
 */
export async function testNode(id) {
  const store = readStore();
  const node = testableNodeOrThrow(store.nodes, id);
  const conflict = getNodeUdpConflict(node.id, store);
  if (conflict) {
    return rememberLatency(node.id, { ok: false, message: conflict.message });
  }
  return withTestSidecar([node], async () => rememberLatency(node.id, await measureTestNode(node)));
}

function rememberLatency(nodeId, measurement) {
  const record = {
    ok: !!measurement?.ok,
    delay: measurement?.ok ? measurement.delay ?? null : null,
    message: measurement?.ok ? null : measurement?.message ?? "测速失败",
    testedAt: new Date().toISOString(),
  };
  nodeLatency.set(nodeId, record);
  return { id: nodeId, ...measurement, testedAt: record.testedAt };
}

export function getNodeLatency(nodeId) {
  return nodeLatency.get(nodeId) ?? null;
}

/**
 * 批量测速：独立进程一次加载目标启用节点，再用有限并发请求延迟。
 * 支持按范围（全部 / 某订阅源 / 自定义节点 / 未归属节点 / 指定 ID）过滤测速。
 *
 * onProgress 每测完一个节点回调一次，让上层 Operation 能报真实进度。
 */
export async function testAllNodes({ onProgress, scope = "all", sourceId = null, ids = null, concurrency = 5 } = {}) {
  const store = readStore();
  const { nodes, subscriptions = [] } = store;
  const knownSourceIds = new Set(subscriptions.map((source) => source.id));
  const idSet = Array.isArray(ids) && ids.length ? new Set(ids) : null;
  const targets = nodes.filter((n) => {
    if (n.enabled === false || n.missing) return false;
    if (idSet) return idSet.has(n.id);
    if (scope === "custom") return n.id.startsWith("custom_");
    if (scope === "source") return Boolean(sourceId) && n.sourceId === sourceId;
    if (scope === "unassigned") return !n.id.startsWith("custom_") && (!n.sourceId || !knownSourceIds.has(n.sourceId));
    return true;
  });
  if (!targets.length) throw badRequest("没有可测试的启用节点");

  const network = normalizeNetworkConfig(store.network);
  const environment = evaluateNetworkEnvironment(network, getHostNetworkSnapshot());
  const systemProxy = network.mode === "system" ? resolveSystemProxy(network) : undefined;
  const { targets: compatibleTargets, skippedConflicts } = compileConnectionRoutes({
    nodes,
    proxyIds: targets.map((node) => node.id),
    network,
    systemProxy,
    effectiveOutboundInterface: environment.effectiveOutboundInterface,
    allowPartialUdpSkip: true,
  });

  const results = new Array(targets.length);
  const indexById = new Map(targets.map((node, index) => [node.id, index]));
  let done = 0;

  const reportOne = (node, measured) => {
    const idx = indexById.get(node.id);
    if (idx !== undefined) results[idx] = measured;
    done++;
    try {
      onProgress?.({
        done,
        total: targets.length,
        node: { id: node.id, name: node.name },
        result: measured,
      });
    } catch {
      // 进度回调失败不能中断剩余节点的测速
    }
  };

  // Mark UDP-incompatible nodes immediately without aborting compatible nodes in the same batch.
  for (const node of targets) {
    const conflict = skippedConflicts.get(node.id);
    if (!conflict) continue;
    const measured = rememberLatency(node.id, { ok: false, message: conflict.message });
    reportOne(node, measured);
  }

  const compatibleIds = new Set(compatibleTargets.map((item) => item.id));
  const runnableTargets = targets.filter((node) => compatibleIds.has(node.id));
  if (!runnableTargets.length) {
    return { results, total: targets.length };
  }

  const workerCount = Math.min(Math.max(1, Math.floor(Number(concurrency) || 5)), runnableTargets.length);
  return withTestSidecar(runnableTargets, async () => {
    let cursor = 0;
    const worker = async () => {
      while (cursor < runnableTargets.length) {
        const node = runnableTargets[cursor++];
        const measured = rememberLatency(node.id, await measureTestNode(node));
        reportOne(node, measured);
      }
    };
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    return { results, total: targets.length };
  });
}

export function stopAll() {
  stop();
  stopDirectBypass();
  for (const proc of auxiliaryChildren) {
    try {
      if (!proc.killed) proc.kill();
    } catch {
      // 进程可能已退出
    }
  }
}

// exit 事件不能执行异步工作，但同步发出终止信号仍可避免边车变成孤儿进程。
// SIGINT/SIGTERM 由 server 的统一关闭流程处理；不能在这里拦截后只清理不退出，
// 否则 Node 会取消 Ctrl+C 的默认退出行为，HTTP 端口将一直被占用。
process.on("exit", stopAll);
