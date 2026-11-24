import { createHash } from "node:crypto";
import YAML from "yaml";
import { normalizeProxyPort } from "./proxyUtils.js";
import { parseCustomProxyInput } from "./customProxyInput.js";
import { stableJson } from "./proxySubscriptions.js";

const MAX_INPUT_LENGTH = 262144;
const MAX_NODES = 100;
const MAX_SERIALIZED_BYTES = 512 * 1024;
const STRIPPED_ROUTING_FIELDS = ["dialer-proxy", "interface-name", "routing-mark"];
const SIMPLE_CUSTOM_KEYS = new Set(["name", "type", "server", "port", "tls", "username", "password"]);
const PROTOCOL_TYPE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/i;
const URI_SCHEME_PATTERN = /^(vless|hysteria2|hy2|trojan|vmess|ss|http|https|socks5|socks5h):\/\//i;

function badRequest(message) {
  return Object.assign(new Error(message), { badRequest: true });
}

export function validateNodeDisplayName(value, { allowEmpty = false } = {}) {
  if (value === null || value === undefined) {
    if (allowEmpty) return null;
    throw badRequest("节点名称须为 1–200 个字符，且不能包含控制字符");
  }
  if (typeof value !== "string") {
    throw badRequest("节点名称必须是字符串");
  }
  const name = value.trim();
  if (!name) {
    if (allowEmpty) return null;
    throw badRequest("节点名称须为 1–200 个字符，且不能包含控制字符");
  }
  if (name.length > 200 || /[\x00-\x1f\x7f]/.test(name)) {
    throw badRequest("节点名称须为 1–200 个字符，且不能包含控制字符");
  }
  return name;
}

export function customNodeKind(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "yaml";
  if (raw.type !== "http" && raw.type !== "socks5") return "yaml";
  if (raw.type === "socks5" && raw.tls) return "yaml";
  for (const key of Object.keys(raw)) {
    if (!SIMPLE_CUSTOM_KEYS.has(key)) return "yaml";
  }
  return "simple";
}

function decodeBase64Flexible(input) {
  const cleaned = String(input ?? "").trim().replace(/-/g, "+").replace(/_/g, "/").replace(/\s+/g, "");
  if (!cleaned || !/^[A-Za-z0-9+/=]+$/.test(cleaned)) {
    throw badRequest("分享链接的 Base64 编码无效");
  }
  const padded = cleaned.length % 4 === 0 ? cleaned : cleaned + "=".repeat(4 - (cleaned.length % 4));
  return Buffer.from(padded, "base64").toString("utf8");
}

function decodeFragment(hash) {
  if (!hash || !hash.startsWith("#")) return "";
  try {
    return decodeURIComponent(hash.slice(1)).trim();
  } catch {
    return hash.slice(1).trim();
  }
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function parseBoolParam(value) {
  if (value == null) return undefined;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes"].includes(normalized)) return true;
  if (["0", "false", "no"].includes(normalized)) return false;
  return undefined;
}

function parseListParam(value) {
  if (!value) return undefined;
  const items = String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length ? items : undefined;
}

function extractExplicitPort(rawUrl) {
  const withoutScheme = rawUrl.replace(/^[a-z0-9+.-]+:\/\//i, "");
  const authority = withoutScheme.split(/[/?#]/)[0];
  const hostPort = authority.includes("@") ? authority.slice(authority.lastIndexOf("@") + 1) : authority;
  const match = hostPort.match(/:(\d+)$/);
  return normalizeProxyPort(match?.[1]);
}

function fallbackNodeName(type, server, port) {
  const host = server.includes(":") ? `[${server}]` : server;
  return `${type.toUpperCase()} ${host}:${port}`.slice(0, 200);
}

function applyTransportParams(node, network, params) {
  if (!network || network === "tcp" || network === "raw") return;
  node.network = network;
  const path = params.get("path")?.trim() || "";
  const host = params.get("host")?.trim() || "";
  if (network === "ws") {
    const wsOpts = {};
    if (path) wsOpts.path = path;
    if (host) wsOpts.headers = { Host: host };
    if (Object.keys(wsOpts).length) node["ws-opts"] = wsOpts;
  } else if (network === "grpc") {
    const serviceName = (params.get("serviceName") || params.get("service-name") || path).trim();
    if (serviceName) node["grpc-opts"] = { "grpc-service-name": serviceName };
  } else if (network === "h2") {
    const h2Opts = {};
    if (path) h2Opts.path = path;
    if (host) h2Opts.host = parseListParam(host) ?? [host];
    if (Object.keys(h2Opts).length) node["h2-opts"] = h2Opts;
  } else if (network === "httpupgrade") {
    const opts = {};
    if (path) opts.path = path;
    if (host) opts.headers = { Host: host };
    if (Object.keys(opts).length) node["ws-opts"] = { ...opts, "v2ray-http-upgrade": true };
  }
}

function parseVlessUri(line) {
  let url;
  try {
    url = new URL(line);
  } catch {
    throw badRequest("VLESS 分享链接格式无效");
  }
  const uuid = safeDecode(url.username).trim();
  const server = url.hostname.replace(/^\[|\]$/g, "").trim();
  const port = extractExplicitPort(line);
  if (!uuid || !server || port === null) throw badRequest("VLESS 分享链接缺少有效的 UUID、服务器或端口");

  const params = url.searchParams;
  const rawType = (params.get("type") || "tcp").trim().toLowerCase();
  const network = rawType === "raw" ? "tcp" : rawType;
  const security = (params.get("security") || "").trim().toLowerCase();
  const node = {
    name: decodeFragment(url.hash) || fallbackNodeName("vless", server, port),
    type: "vless",
    server,
    port,
    uuid,
    network,
    udp: parseBoolParam(params.get("udp")) ?? true,
  };

  const flow = params.get("flow")?.trim();
  if (flow) node.flow = flow;
  const packetEncoding = (params.get("packetEncoding") || params.get("packet-encoding"))?.trim();
  if (packetEncoding) node["packet-encoding"] = packetEncoding;

  if (security === "tls" || security === "reality") {
    node.tls = true;
    const sni = (params.get("sni") || params.get("servername"))?.trim();
    if (sni) node.servername = sni;
    const fp = (params.get("fp") || params.get("client-fingerprint"))?.trim();
    if (fp) node["client-fingerprint"] = fp;
    const alpn = parseListParam(params.get("alpn"));
    if (alpn) node.alpn = alpn;
    const insecure = parseBoolParam(params.get("allowInsecure") ?? params.get("insecure"));
    if (insecure !== undefined) node["skip-cert-verify"] = insecure;
    if (security === "reality") {
      const publicKey = (params.get("pbk") || params.get("public-key"))?.trim();
      if (!publicKey) throw badRequest("VLESS Reality 链接缺少公钥（pbk）参数");
      const realityOpts = { "public-key": publicKey };
      const shortId = (params.get("sid") || params.get("short-id"))?.trim();
      if (shortId) realityOpts["short-id"] = shortId;
      node["reality-opts"] = realityOpts;
    }
  }
  applyTransportParams(node, network, params);
  return node;
}

function splitAuthorityBeforeQuery(rawUrl, schemeLength) {
  const afterScheme = rawUrl.slice(schemeLength);
  const hashIndex = afterScheme.indexOf("#");
  const hash = hashIndex >= 0 ? afterScheme.slice(hashIndex) : "";
  const beforeHash = hashIndex >= 0 ? afterScheme.slice(0, hashIndex) : afterScheme;
  const queryIndex = beforeHash.indexOf("?");
  const query = queryIndex >= 0 ? beforeHash.slice(queryIndex + 1) : "";
  const authorityAndPath = queryIndex >= 0 ? beforeHash.slice(0, queryIndex) : beforeHash;
  const atIndex = authorityAndPath.lastIndexOf("@");
  if (atIndex <= 0) return null;
  const userInfo = authorityAndPath.slice(0, atIndex);
  const hostPortPath = authorityAndPath.slice(atIndex + 1);
  const slashIndex = hostPortPath.indexOf("/");
  const hostPort = slashIndex >= 0 ? hostPortPath.slice(0, slashIndex) : hostPortPath;
  return { userInfo, hostPort, query, hash };
}

function parseHostPort(hostPort, defaultPort = null) {
  let fakeUrl;
  try {
    fakeUrl = new URL(`http://${hostPort}`);
  } catch {
    return null;
  }
  const server = fakeUrl.hostname.replace(/^\[|\]$/g, "").trim();
  const explicit = extractExplicitPort(`http://${hostPort}`);
  const port = explicit ?? defaultPort;
  if (!server || port === null) return null;
  return { server, port };
}

function parseHysteria2Uri(line) {
  const normalizedLine = line.replace(/^hy2:\/\//i, "hysteria2://");
  const parts = splitAuthorityBeforeQuery(normalizedLine, "hysteria2://".length);
  if (!parts) throw badRequest("Hysteria2 分享链接格式无效");
  const password = safeDecode(parts.userInfo).trim();
  const endpoint = parseHostPort(parts.hostPort, 443);
  if (!password || !endpoint) throw badRequest("Hysteria2 分享链接缺少有效的认证密码、服务器或端口");
  const { server, port } = endpoint;

  const params = new URLSearchParams(parts.query);
  const node = {
    name: decodeFragment(parts.hash) || fallbackNodeName("hysteria2", server, port),
    type: "hysteria2",
    server,
    port,
    password,
  };
  const sni = params.get("sni")?.trim();
  if (sni) node.sni = sni;
  const alpn = parseListParam(params.get("alpn"));
  if (alpn) node.alpn = alpn;
  const insecure = parseBoolParam(params.get("insecure") ?? params.get("allowInsecure"));
  if (insecure !== undefined) node["skip-cert-verify"] = insecure;
  const pin = (params.get("pinSHA256") || params.get("pinsha256") || params.get("fingerprint"))?.trim();
  if (pin) node.fingerprint = pin.replace(/^sha256:/i, "").replace(/:/g, "").toLowerCase();
  const obfs = params.get("obfs")?.trim();
  if (obfs && obfs.toLowerCase() !== "none") {
    node.obfs = obfs;
    const obfsPassword = params.get("obfs-password")?.trim();
    if (obfsPassword) node["obfs-password"] = obfsPassword;
  }
  const ports = (params.get("mport") || params.get("ports"))?.trim();
  if (ports) node.ports = ports;
  const up = params.get("up")?.trim();
  if (up) node.up = up;
  const down = params.get("down")?.trim();
  if (down) node.down = down;
  return node;
}

function parseTrojanUri(line) {
  const parts = splitAuthorityBeforeQuery(line, "trojan://".length);
  if (!parts) throw badRequest("Trojan 分享链接格式无效");
  const password = safeDecode(parts.userInfo).trim();
  const endpoint = parseHostPort(parts.hostPort, 443);
  if (!password || !endpoint) throw badRequest("Trojan 分享链接缺少有效的密码、服务器或端口");
  const { server, port } = endpoint;

  const params = new URLSearchParams(parts.query);
  const node = {
    name: decodeFragment(parts.hash) || fallbackNodeName("trojan", server, port),
    type: "trojan",
    server,
    port,
    password,
    udp: parseBoolParam(params.get("udp")) ?? true,
  };
  const sni = (params.get("sni") || params.get("peer"))?.trim();
  if (sni) node.sni = sni;
  const insecure = parseBoolParam(params.get("allowInsecure") ?? params.get("insecure"));
  if (insecure !== undefined) node["skip-cert-verify"] = insecure;
  const fp = (params.get("fp") || params.get("client-fingerprint"))?.trim();
  if (fp) node["client-fingerprint"] = fp;
  const alpn = parseListParam(params.get("alpn"));
  if (alpn) node.alpn = alpn;
  const network = (params.get("type") || "").trim().toLowerCase();
  applyTransportParams(node, network, params);
  return node;
}

function parseVmessUri(line) {
  const payload = line.slice("vmess://".length).split("#")[0].trim();
  let json;
  try {
    json = JSON.parse(decodeBase64Flexible(payload));
  } catch {
    throw badRequest("VMess 分享链接格式无效");
  }
  const server = String(json?.add ?? "").trim();
  const port = normalizeProxyPort(json?.port);
  const uuid = String(json?.id ?? "").trim();
  if (!server || port === null || !uuid) throw badRequest("VMess 分享链接缺少有效的服务器、端口或 UUID");

  const alterId = Number.isInteger(Number(json?.aid)) && Number(json.aid) >= 0 ? Number(json.aid) : 0;
  const cipher = String(json?.scy || "auto").trim() || "auto";
  const network = String(json?.net || "tcp").trim().toLowerCase();
  const node = {
    name: String(json?.ps ?? "").trim() || fallbackNodeName("vmess", server, port),
    type: "vmess",
    server,
    port,
    uuid,
    alterId,
    cipher,
    udp: true,
  };
  if (String(json?.tls ?? "").trim().toLowerCase() === "tls") {
    node.tls = true;
    const sni = String(json?.sni || json?.host || "").trim();
    if (sni) node.servername = sni;
    const fp = String(json?.fp ?? "").trim();
    if (fp) node["client-fingerprint"] = fp;
    const alpn = parseListParam(json?.alpn);
    if (alpn) node.alpn = alpn;
  }
  const params = new URLSearchParams();
  if (json?.path) params.set("path", String(json.path));
  if (json?.host) params.set("host", String(json.host));
  applyTransportParams(node, network, params);
  return node;
}

function parseShadowsocksUri(line) {
  const fragmentIndex = line.indexOf("#");
  const nameFromHash = fragmentIndex >= 0 ? decodeFragment(line.slice(fragmentIndex)) : "";
  const withoutHash = fragmentIndex >= 0 ? line.slice(0, fragmentIndex) : line;
  const queryIndex = withoutHash.indexOf("?");
  const query = queryIndex >= 0 ? withoutHash.slice(queryIndex + 1) : "";
  if (query && new URLSearchParams(query).get("plugin")?.trim()) {
    throw badRequest("暂不支持解析带 plugin 参数的 Shadowsocks 分享链接，请直接粘贴 Clash YAML 节点配置");
  }
  const body = (queryIndex >= 0 ? withoutHash.slice(0, queryIndex) : withoutHash).slice("ss://".length).trim();
  if (!body) throw badRequest("Shadowsocks 分享链接格式无效");

  let cipher = "";
  let password = "";
  let server = "";
  let port = null;

  if (body.includes("@")) {
    const atIndex = body.lastIndexOf("@");
    const userInfo = body.slice(0, atIndex);
    const hostPort = body.slice(atIndex + 1);
    const decodedUserInfo = userInfo.includes(":") ? safeDecode(userInfo) : decodeBase64Flexible(userInfo);
    const colon = decodedUserInfo.indexOf(":");
    if (colon <= 0) throw badRequest("Shadowsocks 分享链接缺少有效的加密方式或密码");
    cipher = decodedUserInfo.slice(0, colon).trim();
    password = decodedUserInfo.slice(colon + 1);
    const endpoint = parseHostPort(hostPort);
    if (!endpoint) throw badRequest("Shadowsocks 分享链接服务器或端口无效");
    server = endpoint.server;
    port = endpoint.port;
  } else {
    const decoded = decodeBase64Flexible(body);
    const atIndex = decoded.lastIndexOf("@");
    if (atIndex <= 0) throw badRequest("Shadowsocks 分享链接格式无效");
    const userInfo = decoded.slice(0, atIndex);
    const hostPort = decoded.slice(atIndex + 1);
    const colon = userInfo.indexOf(":");
    if (colon <= 0) throw badRequest("Shadowsocks 分享链接缺少有效的加密方式或密码");
    cipher = userInfo.slice(0, colon).trim();
    password = userInfo.slice(colon + 1);
    const endpoint = parseHostPort(hostPort);
    if (!endpoint) throw badRequest("Shadowsocks 分享链接服务器或端口无效");
    server = endpoint.server;
    port = endpoint.port;
  }

  if (!cipher || !password || !server || port === null) {
    throw badRequest("Shadowsocks 分享链接缺少有效的服务器、端口或认证信息");
  }
  return {
    name: nameFromHash || fallbackNodeName("ss", server, port),
    type: "ss",
    server,
    port,
    cipher,
    password,
    udp: true,
  };
}

function parseSimpleSchemeUri(line) {
  const [parsed] = parseCustomProxyInput(line);
  const type = parsed.protocol === "socks5" ? "socks5" : "http";
  const tls = parsed.protocol === "https";
  return {
    name: parsed.name || fallbackNodeName(parsed.protocol, parsed.server, parsed.port),
    type,
    server: parsed.server,
    port: parsed.port,
    ...(tls ? { tls: true } : {}),
    ...(parsed.username ? { username: parsed.username, password: parsed.password } : {}),
  };
}

function parseShareUriLine(line) {
  try {
    const scheme = line.match(/^([a-z0-9+.-]+):\/\//i)?.[1]?.toLowerCase();
    if (scheme === "vless") return parseVlessUri(line);
    if (scheme === "hysteria2" || scheme === "hy2") return parseHysteria2Uri(line);
    if (scheme === "trojan") return parseTrojanUri(line);
    if (scheme === "vmess") return parseVmessUri(line);
    if (scheme === "ss") return parseShadowsocksUri(line);
    if (["http", "https", "socks5", "socks5h"].includes(scheme)) return parseSimpleSchemeUri(line);
    throw badRequest("不支持的代理链接协议");
  } catch (error) {
    if (error?.badRequest) throw error;
    throw badRequest("代理分享链接格式无效，请检查后重试");
  }
}

function sanitizeRawProxy(candidate, { allowMissingName = true } = {}) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
  const type = String(candidate.type ?? "").trim();
  const server = String(candidate.server ?? "").trim().replace(/^\[|\]$/g, "");
  const port = normalizeProxyPort(candidate.port);
  if (!type || !PROTOCOL_TYPE_PATTERN.test(type) || !server || /[\s\0/@?#\\]/.test(server) || port === null) {
    return null;
  }
  const rawName = typeof candidate.name === "string" ? candidate.name.trim() : "";
  const name = rawName || (allowMissingName ? fallbackNodeName(type, server, port) : "");
  if (!name || name.length > 200 || /[\x00-\x1f\x7f]/.test(name)) return null;

  const cleaned = { ...candidate };
  for (const field of STRIPPED_ROUTING_FIELDS) delete cleaned[field];
  return {
    ...cleaned,
    name,
    type,
    server,
    port,
  };
}

export function stringifyCustomNodeYaml(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "";
  const { name: _ignoredName, ...fields } = raw;
  for (const field of STRIPPED_ROUTING_FIELDS) delete fields[field];
  return YAML.stringify(fields).trimEnd();
}

export function customConfigNodeId(raw) {
  const { name: _name, ...fields } = raw;
  for (const field of STRIPPED_ROUTING_FIELDS) delete fields[field];
  if (customNodeKind({ ...fields, name: "x" }) === "simple") {
    const type = fields.type === "socks5" ? "socks5" : "http";
    const tls = Boolean(fields.tls);
    const identity = JSON.stringify([type, fields.server, fields.port, tls, fields.username ?? "", fields.password ?? ""]);
    return `custom_${createHash("sha256").update(identity).digest("hex").slice(0, 20)}`;
  }
  const suffix = createHash("sha256").update(stableJson(fields)).digest("hex").slice(0, 20);
  return `custom_${suffix}`;
}

function stripBlankBoundaryLines(text) {
  return text
    .replace(/^\uFEFF/, "")
    .replace(/^(?:[ \t]*\r?\n)+/, "")
    .replace(/(?:\r?\n[ \t]*)+$/, "");
}

function dedentLines(text) {
  const lines = text.split(/\r?\n/);
  let minIndent = Infinity;
  for (const line of lines) {
    if (!line.trim()) continue;
    const indent = line.match(/^[ ]*/)?.[0].length ?? 0;
    if (indent < minIndent) minIndent = indent;
  }
  if (!Number.isFinite(minIndent) || minIndent <= 0) return text;
  return lines.map((line) => (line.trim() ? line.slice(minIndent) : "")).join("\n");
}

function parseYamlCandidates(text) {
  let doc;
  try {
    doc = YAML.parse(dedentLines(text), { maxAliasCount: 50 });
  } catch {
    throw badRequest("YAML 格式无效，请检查缩进与语法");
  }
  if (!doc || typeof doc !== "object") {
    throw badRequest("未能从内容中解析到有效的 Clash 节点配置");
  }
  if (Array.isArray(doc)) return doc;
  if (Array.isArray(doc.proxies)) return doc.proxies;
  if (typeof doc.type === "string" || typeof doc.server === "string") return [doc];
  throw badRequest("未找到 proxies 列表或单节点配置（需包含 type、server 和 port）");
}

/**
 * 解析 Clash/mihomo YAML（完整配置文件、proxies 列表或单节点 YAML）以及常见协议分享链接。
 * 绝不在错误信息中回显凭据（UUID/密码/公钥）。
 */
export function parseCustomConfigInput(input) {
  if (typeof input !== "string") throw badRequest("请输入 Clash YAML 或代理分享链接");
  const cleaned = stripBlankBoundaryLines(input);
  if (!cleaned.trim()) throw badRequest("请输入 Clash YAML 或代理分享链接");
  if (cleaned.length > MAX_INPUT_LENGTH) throw badRequest("输入内容过大（上限 256 KB）");

  const lines = cleaned
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  const looksLikeUriBatch = lines.length > 0 && lines.every((line) => URI_SCHEME_PATTERN.test(line));

  let rawCandidates;
  if (looksLikeUriBatch) {
    if (lines.length > MAX_NODES) throw badRequest(`单次最多导入 ${MAX_NODES} 条节点`);
    rawCandidates = lines.map((line) => parseShareUriLine(line));
  } else {
    rawCandidates = parseYamlCandidates(cleaned);
    if (!rawCandidates.length) throw badRequest("配置里没有可用的节点");
    if (rawCandidates.length > MAX_NODES) throw badRequest(`单次最多导入 ${MAX_NODES} 条节点`);
  }

  const normalized = [];
  let skipped = 0;
  for (const candidate of rawCandidates) {
    const clean = sanitizeRawProxy(candidate, { allowMissingName: true });
    if (!clean) {
      skipped++;
      continue;
    }
    normalized.push(clean);
  }
  if (!normalized.length) {
    throw badRequest("未识别到有效的代理节点（每个节点须包含合法的 type、server 和 1–65535 端口）");
  }

  // 验证无循环引用并限制序列化大小。
  let serialized;
  try {
    serialized = JSON.stringify(normalized);
  } catch {
    throw badRequest("节点配置包含不受支持的引用结构");
  }
  if (Buffer.byteLength(serialized) > MAX_SERIALIZED_BYTES) {
    throw badRequest("解析后的节点配置过大，请分批导入");
  }
  const safeNodes = JSON.parse(serialized);
  return {
    nodes: safeNodes.map((raw) => ({
      name: raw.name,
      type: raw.type,
      server: raw.server,
      port: raw.port,
      yaml: stringifyCustomNodeYaml(raw),
      raw,
    })),
    skipped,
  };
}

export function parseSingleCustomNodeYaml(yamlText, displayName) {
  const name = validateNodeDisplayName(displayName);
  if (typeof yamlText !== "string" || !yamlText.trim()) {
    throw badRequest("节点 YAML 配置不能为空");
  }
  if (yamlText.length > 32768) {
    throw badRequest("单个节点 YAML 配置过大");
  }
  let doc;
  try {
    doc = YAML.parse(dedentLines(stripBlankBoundaryLines(yamlText)), { maxAliasCount: 50 });
  } catch {
    throw badRequest("节点 YAML 语法无效，请检查缩进与字段格式");
  }
  let candidate = doc;
  if (Array.isArray(doc)) {
    if (doc.length !== 1) throw badRequest("每个条目只能包含 1 个节点配置");
    candidate = doc[0];
  } else if (doc && typeof doc === "object" && Array.isArray(doc.proxies)) {
    if (doc.proxies.length !== 1) throw badRequest("每个条目只能包含 1 个节点配置");
    candidate = doc.proxies[0];
  }
  const clean = sanitizeRawProxy({ ...(candidate && typeof candidate === "object" ? candidate : {}), name }, { allowMissingName: false });
  if (!clean) {
    throw badRequest("节点配置无效：须包含合法的 type、server 和端口（1–65535）");
  }
  let serialized;
  try {
    serialized = JSON.stringify(clean);
  } catch {
    throw badRequest("节点配置包含不受支持的引用结构");
  }
  if (Buffer.byteLength(serialized) > 65536) {
    throw badRequest("单个节点配置过大");
  }
  return { name, raw: JSON.parse(serialized) };
}
