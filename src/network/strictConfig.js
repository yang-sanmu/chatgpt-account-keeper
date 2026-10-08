import { randomBytes } from "node:crypto";
import { isIP } from "node:net";

export const STRICT_DOH = "https://1.1.1.1/dns-query#upstream";
export const STRICT_RESOLVER_ARGUMENT = "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1";

const COMMON = ["name", "type", "server", "port", "udp", "tls", "sni", "servername", "skip-cert-verify", "alpn", "fingerprint", "client-fingerprint"];
const FIELDS = {
  http: ["username", "password", "headers"],
  socks5: ["username", "password"],
  anytls: ["password", "idle-session-check-interval", "idle-session-timeout", "min-idle-session"],
  hysteria2: ["password", "obfs", "obfs-password", "up", "down"],
  tuic: ["uuid", "password", "congestion-controller", "heartbeat-interval", "reduce-rtt", "request-timeout", "max-udp-relay-packet-size"],
  vmess: ["uuid", "alterId", "cipher", "network", "ws-opts", "grpc-opts", "packet-encoding", "global-padding", "authenticated-length"],
  vless: ["uuid", "flow", "network", "ws-opts", "grpc-opts", "packet-encoding", "reality-opts"],
};
const UDP_UPSTREAM = new Set(["hysteria2", "tuic"]);
const INHERENT_TLS = new Set(["anytls", "hysteria2", "tuic"]);

function invalid(message) {
  return Object.assign(new Error(message), { code: "STRICT_CONFIG_UNSUPPORTED" });
}
function port(value, name) {
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw invalid(`${name} 无效`);
  return value;
}
function object(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid(`${name} 必须是对象`);
}
function onlyKeys(value, keys, name) {
  object(value, name);
  const extra = Object.keys(value).filter((key) => !keys.includes(key));
  if (extra.length) throw invalid(`${name} 含未经验证的字段：${extra.join(", ")}`);
}

/** Conservative, side-effect-free compiler. Successful compilation is not M1 approval. */
export function normalizeStrictUpstream(raw, approvedAddress) {
  object(raw, "节点");
  if (!Object.hasOwn(FIELDS, raw.type)) throw invalid("此节点协议尚未适配严格模式");
  onlyKeys(raw, [...COMMON, ...FIELDS[raw.type]], "节点");
  if (raw["skip-cert-verify"] !== undefined && raw["skip-cert-verify"] !== false) {
    throw invalid("严格模式不允许跳过上游证书校验；skip-cert-verify 只能为 false 或省略");
  }
  if (!isIP(approvedAddress) || approvedAddress.includes("%")) throw invalid("必须提供已批准的数值上游地址");
  if (typeof raw.server !== "string" || !raw.server || /[\s\0/@?#\\]/u.test(raw.server)) throw invalid("节点服务器无效");
  port(raw.port, "节点端口");
  const upstream = structuredClone(raw);
  if (raw.network && !["tcp", "ws", "grpc"].includes(raw.network)) {
    throw invalid("此传输尚未证明端点集合；包括 XHTTP 在内的未验证传输不能启用严格模式");
  }
  if (raw["ws-opts"]) {
    onlyKeys(raw["ws-opts"], ["path", "headers", "max-early-data", "early-data-header-name"], "ws-opts");
    if (raw["ws-opts"].headers !== undefined) validateHeaders(raw["ws-opts"].headers);
  }
  if (raw.headers !== undefined) validateHeaders(raw.headers);
  for (const field of ["sni", "servername"]) {
    if (raw[field] !== undefined && (typeof raw[field] !== "string" || !raw[field] || /[\s\0/@?#\\]/u.test(raw[field]))) {
      throw invalid("TLS 服务器名称无效");
    }
  }
  if (raw["grpc-opts"]) onlyKeys(raw["grpc-opts"], ["grpc-service-name"], "grpc-opts");
  if (raw["reality-opts"]) onlyKeys(raw["reality-opts"], ["public-key", "short-id"], "reality-opts");
  // Binding an IP must not silently change certificate identity or HTTP routing.
  const originalHost = raw.server.replace(/^\[|\]$/gu, "");
  if (raw.tls || INHERENT_TLS.has(raw.type) || raw["reality-opts"]) {
    const field = ["vmess", "vless"].includes(raw.type) ? "servername" : "sni";
    upstream[field] ||= originalHost;
  }
  if (raw.network === "ws") {
    upstream["ws-opts"] ??= {};
    upstream["ws-opts"].headers ??= {};
    const headers = upstream["ws-opts"].headers;
    if (!Object.keys(headers).some((key) => key.toLowerCase() === "host")) headers.Host = originalHost;
  }
  // No origin UDP through this HTTP listener. The transport's own UDP is separate.
  upstream.udp = false;
  upstream.name = "upstream";
  upstream.server = approvedAddress;
  return Object.freeze({ upstream, endpoint: Object.freeze({
    address: approvedAddress, port: raw.port, protocol: UDP_UPSTREAM.has(raw.type) ? "udp" : "tcp",
  }) });
}

function validateHeaders(headers) {
  object(headers, "传输 headers");
  for (const [key, value] of Object.entries(headers)) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(key)
      || typeof value !== "string" || /[\r\n\0]/u.test(value)) throw invalid("传输 headers 无效");
  }
}

export function newProxyCredentials() {
  return Object.freeze({ username: randomBytes(18).toString("base64url"), password: randomBytes(32).toString("base64url") });
}

export function validateProxyCredentials(credentials) {
  if (!credentials || typeof credentials.username !== "string" || typeof credentials.password !== "string"
    || !credentials.username || !credentials.password || /[:\r\n\0]/u.test(credentials.username)
    || /[\r\n\0]/u.test(credentials.password)) throw invalid("入口必须具有非空、有效的独立凭据");
}

export function buildStrictProxyConfig({ raw, approvedAddress, listenerPort, credentials }) {
  port(listenerPort, "入口端口");
  validateProxyCredentials(credentials);
  const { upstream, endpoint } = normalizeStrictUpstream(raw, approvedAddress);
  return {
    endpoint,
    config: {
      "mixed-port": 0, "allow-lan": false, mode: "rule", "log-level": "warning",
      ipv6: true,
      dns: {
        enable: true, "enhanced-mode": "redir-host", "prefer-h3": false,
        "use-hosts": false, "use-system-hosts": false,
        nameserver: [STRICT_DOH], fallback: [],
      },
      proxies: [upstream],
      listeners: [{ name: "strict", type: "http", listen: "127.0.0.1", port: listenerPort,
        proxy: "upstream", users: [{ username: credentials.username, password: credentials.password }] }],
      rules: ["MATCH,REJECT"],
    },
  };
}

export function strictBrowserArguments(proxyPort) {
  port(proxyPort, "入口端口");
  return [
    `--proxy-server=http://127.0.0.1:${proxyPort}`,
    STRICT_RESOLVER_ARGUMENT,
    // Remove Chromium's implicit loopback bypass; WFP remains the enforcement layer.
    "--proxy-bypass-list=<-loopback>",
  ];
}

export function getStrictNetworkCapabilities() {
  // Never infer production readiness from OS, an executable, or passing unit tests.
  return { platform: process.platform, available: false, status: "unavailable",
    reason: "M1_NOT_ACCEPTED", message: "严格保护尚未通过专用 Windows 环境实机验收" };
}
