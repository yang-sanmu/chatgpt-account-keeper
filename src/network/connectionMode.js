import { execFileSync } from "node:child_process";

export const DEFAULT_NETWORK_CONFIG = Object.freeze({
  mode: "system", relayProxyId: null, systemProxyUrl: null, outboundInterface: null,
});

function invalid(message) {
  return Object.assign(new Error(message), { badRequest: true });
}

export function normalizeSystemProxyUrl(value) {
  if (value == null || value === "") return null;
  let url;
  try { url = new URL(String(value).trim()); } catch { throw invalid("系统代理入口须为 http://、https:// 或 socks5:// 地址"); }
  if (!["http:", "https:", "socks5:"].includes(url.protocol) || !url.hostname ||
      url.username || url.password || url.search || url.hash || url.pathname !== "/" && url.pathname !== "") {
    throw invalid("系统代理入口仅支持无认证的 HTTP、HTTPS 或 SOCKS5 地址，请勿填写路径或账号密码");
  }
  const port = Number(url.port || (url.protocol === "https:" ? 443 : url.protocol === "http:" ? 80 : 1080));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw invalid("系统代理端口须为 1–65535");
  return `${url.protocol}//${url.hostname}:${port}`;
}

export function normalizeNetworkConfig(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw invalid("网络配置必须是对象");
  const unknown = Object.keys(input).find((key) => !Object.hasOwn(DEFAULT_NETWORK_CONFIG, key));
  if (unknown) throw invalid(`不允许更新网络字段：${unknown}`);
  const value = { ...DEFAULT_NETWORK_CONFIG, ...input };
  if (!["direct", "system", "relay"].includes(value.mode)) throw invalid("请选择有效的网络模式");
  for (const key of ["relayProxyId", "outboundInterface"]) {
    if (value[key] != null && (typeof value[key] !== "string" || !value[key].trim() || /[\x00-\x1f\x7f]/.test(value[key]) || value[key].length > 200)) {
      throw invalid(key === "relayProxyId" ? "请选择有效的中转节点" : "请填写有效的直出网卡名称");
    }
    value[key] = value[key]?.trim() ?? null;
  }
  if (value.mode === "relay" && !value.relayProxyId) throw invalid("指定中转模式必须选择中转节点");
  value.systemProxyUrl = normalizeSystemProxyUrl(value.systemProxyUrl);
  return value;
}

export function parseWindowsSystemProxy(output) {
  const entry = (name) => output.match(new RegExp(`^\\s*${name}\\s+REG_\\w+\\s+(.*)$`, "im"))?.[1]?.trim();
  const enabled = Number(entry("ProxyEnable")) === 1;
  const server = entry("ProxyServer");
  if (enabled && server) {
    const parts = Object.fromEntries(server.split(";").filter((part) => part.includes("=")).map((part) => part.trim().split("=")));
    const selected = parts.https || parts.http || parts.socks || (!server.includes("=") ? server : null);
    if (selected) {
      const protocol = parts.socks === selected && !parts.http && !parts.https ? "socks5" : "http";
      try {
        return { server: normalizeSystemProxyUrl(selected.includes("://") ? selected : `${protocol}://${selected}`), source: "windows", detail: "使用 Windows 系统代理入口" };
      } catch {
        return { server: null, source: "unavailable", detail: "系统代理入口格式不受支持，请手动填写无认证的 HTTP、HTTPS 或 SOCKS5 入口" };
      }
    }
    return { server: null, source: "unavailable", detail: "无法识别已启用的系统代理，请手动填写固定代理入口" };
  }
  if (enabled) return { server: null, source: "unavailable", detail: "系统代理已开启但缺少入口地址，请手动填写固定代理入口" };
  if (entry("AutoConfigURL")) return { server: null, source: "pac", detail: "检测到 PAC 自动代理。分组专用节点需要手动填写固定的系统代理入口" };
  return { server: null, source: "none", detail: "未检测到固定系统代理入口，将跟随系统网络" };
}

let detectionCache = null;
export function detectSystemProxy({ platform = process.platform, env = process.env, query } = {}) {
  if (query) return parseWindowsSystemProxy(query());
  if (platform === "win32") {
    if (detectionCache && Date.now() - detectionCache.time < 2000) return detectionCache.result;
    let result;
    try {
      result = parseWindowsSystemProxy(execFileSync("reg.exe", ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings"], { encoding: "utf8", windowsHide: true, timeout: 3000, stdio: ["ignore", "pipe", "pipe"] }));
    } catch { result = { server: null, source: "unavailable", detail: "无法读取系统代理，请手动填写系统代理入口" }; }
    detectionCache = { time: Date.now(), result };
    return result;
  }
  const value = env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy || env.ALL_PROXY || env.all_proxy;
  if (value) {
    try { return { server: normalizeSystemProxyUrl(value), source: "environment", detail: "使用环境变量中的代理入口" }; }
    catch { return { server: null, source: "unavailable", detail: "环境变量代理格式不受支持，请手动填写系统代理入口" }; }
  }
  return { server: null, source: "none", detail: "未检测到固定系统代理入口，将跟随系统网络" };
}

export function resolveSystemProxy(config) {
  return config.systemProxyUrl
    ? { server: config.systemProxyUrl, source: "manual", detail: "使用手动指定的系统代理入口" }
    : detectSystemProxy();
}

function systemRaw(server) {
  const url = new URL(server);
  return { name: "network-system", type: url.protocol === "socks5:" ? "socks5" : "http",
    server: url.hostname.replace(/^\[|\]$/g, ""), port: Number(url.port || (url.protocol === "https:" ? 443 : url.protocol === "http:" ? 80 : 1080)), ...(url.protocol === "https:" ? { tls: true } : {}) };
}

function canonical(raw) {
  if (Array.isArray(raw)) return raw.map(canonical);
  if (!raw || typeof raw !== "object") return raw;
  return Object.fromEntries(Object.keys(raw).sort().map((key) => [key, canonical(raw[key])]));
}

export function sameProxyNode(left, right) {
  const clean = (raw) => {
    const { name, "dialer-proxy": dialer, "interface-name": nic, ...rest } = raw;
    return rest;
  };
  return left.id === right.id || JSON.stringify(canonical(clean(left.raw))) === JSON.stringify(canonical(clean(right.raw)));
}

function sameSystemEndpoint(raw, system) {
  const host = (value) => ["localhost", "127.0.0.1", "::1"].includes(String(value).toLowerCase()) ? "loopback" : String(value).toLowerCase();
  return raw.type === system.type && host(raw.server) === host(system.server) && Number(raw.port) === system.port &&
    !!raw.tls === !!system.tls;
}

/** Generate copies: never change a persisted subscription or share its dialer references. */
export function compileConnectionRoutes({ nodes, proxyIds, network = DEFAULT_NETWORK_CONFIG, systemProxy = { server: null, source: "none" } }) {
  const config = normalizeNetworkConfig(network);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const requireNode = (id) => {
    const node = byId.get(id);
    if (!node || node.enabled === false || node.missing || !node.raw?.type || !node.raw?.server) {
      throw Object.assign(new Error("指定的中转节点不存在、已停用或不在订阅中，请重新选择"), { code: "PROXY_UNAVAILABLE" });
    }
    return node;
  };
  const relay = config.mode === "relay" ? requireNode(config.relayProxyId) : null;
  const ids = new Set(proxyIds);
  if (relay) ids.add(relay.id);
  const targets = nodes.filter((node) => ids.has(node.id) && node.enabled !== false && !node.missing);
  if (config.mode === "system" && targets.length && ["pac", "unavailable"].includes(systemProxy.source) && !systemProxy.server) {
    throw Object.assign(new Error(systemProxy.detail), { code: "PROXY_UNAVAILABLE" });
  }
  const adapters = [];
  const copy = (node, name, dialer = null) => {
    const { "dialer-proxy": oldDialer, ...raw } = node.raw;
    return { ...raw, name, ...(dialer ? { "dialer-proxy": dialer } : {}),
      ...(!dialer && config.mode !== "system" && config.outboundInterface ? { "interface-name": config.outboundInterface } : {}) };
  };
  const system = config.mode === "system" && systemProxy.server ? systemRaw(systemProxy.server) : null;
  let needsRelay = false;
  let needsSystem = false;
  for (const node of targets) {
    let dialer = null;
    if (relay && !sameProxyNode(node, relay)) { dialer = "network-relay"; needsRelay = true; }
    if (system && !sameSystemEndpoint(node.raw, system)) { dialer = system.name; needsSystem = true; }
    adapters.push(copy(node, `out-${node.id}`, dialer));
  }
  if (needsRelay) adapters.push(copy(relay, "network-relay"));
  if (needsSystem) adapters.push(system);
  return { adapters, targets, config };
}
