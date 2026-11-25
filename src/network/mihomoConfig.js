import { isLoopbackHost } from "./hostNetwork.js";
import { systemRaw } from "./connectionMode.js";

export const DOH_IP_SERVERS = Object.freeze([
  "https://223.5.5.5/dns-query",
  "https://1.12.12.12/dns-query",
  "https://1.1.1.1/dns-query",
]);

export const DOT_IP_SERVERS = Object.freeze([
  "tls://223.5.5.5:853",
  "tls://1.12.12.12:853",
]);

export const PLAIN_FALLBACK_DNS = Object.freeze([
  "223.5.5.5",
  "1.1.1.1",
]);

function badRequest(message) {
  return Object.assign(new Error(message), { badRequest: true });
}

export function assertNoSystemProxyLoop({ config, systemProxy, occupiedLocalPorts = [] }) {
  if (config?.mode !== "system" || !systemProxy?.server) return;
  let url;
  try {
    url = new URL(systemProxy.server);
  } catch {
    return;
  }
  const systemProxyPort = Number(
    url.port || (url.protocol === "https:" ? 443 : url.protocol === "http:" ? 80 : 1080)
  );
  if (isLoopbackHost(url.hostname) && occupiedLocalPorts.includes(systemProxyPort)) {
    throw Object.assign(
      badRequest("系统代理入口不能指向本工具的代理或控制端口，否则会产生循环转发"),
      { systemProxyPort }
    );
  }
}

export function buildMihomoDnsConfig({
  directTag = null,
  bypassPort53 = false,
} = {}) {
  const tag = (list) => (directTag ? list.map((item) => `${item}#${directTag}`) : [...list]);
  const doh = tag(DOH_IP_SERVERS);
  const dot = tag(DOT_IP_SERVERS);
  const plain = bypassPort53 ? [] : tag(PLAIN_FALLBACK_DNS);

  return {
    enable: true,
    ipv6: false,
    "enhanced-mode": "redir-host",
    "default-nameserver": [...doh, ...plain],
    "proxy-server-nameserver": [...doh, ...plain],
    "direct-nameserver": [...doh, ...plain],
    nameserver: [...doh, ...dot, ...plain],
  };
}

/**
 * Unified mihomo runtime config builder shared by main, auxiliary, direct-bypass,
 * and system-bridge sidecars.
 */
export function buildMihomoRuntimeConfig({
  controlPort,
  adapters,
  listeners = [],
  rules = ["MATCH,DIRECT"],
  mode = "direct",
  effectiveOutboundInterface = null,
  mixedDirectAdapter = false,
  tunConflictDetected = false,
}) {
  const useTopLevelInterface = mode !== "system" && Boolean(effectiveOutboundInterface);
  const useMixedDirectTag = mode === "system" && Boolean(effectiveOutboundInterface) && Boolean(mixedDirectAdapter);
  const bypassPort53 = useTopLevelInterface || useMixedDirectTag || Boolean(tunConflictDetected);

  return {
    "mixed-port": 0,
    "allow-lan": false,
    mode: "rule",
    "log-level": "warning",
    ipv6: false,
    ...(useTopLevelInterface ? { "interface-name": effectiveOutboundInterface } : {}),
    "external-controller": `127.0.0.1:${controlPort}`,
    "unified-delay": true,
    dns: buildMihomoDnsConfig({
      directTag: useMixedDirectTag ? "network-direct" : null,
      bypassPort53,
    }),
    proxies: adapters,
    ...(Array.isArray(listeners) ? { listeners } : {}),
    rules,
  };
}

export function buildDirectBypassConfig({
  controlPort,
  listenerPort,
  outboundInterface,
}) {
  if (!outboundInterface) throw badRequest("直出旁路边车需要指定物理网卡");
  return buildMihomoRuntimeConfig({
    controlPort,
    adapters: [{ name: "network-direct", type: "direct", "interface-name": outboundInterface }],
    listeners: [
      {
        name: "in-direct",
        type: "http",
        listen: "127.0.0.1",
        port: listenerPort,
        proxy: "network-direct",
      },
    ],
    rules: ["MATCH,network-direct"],
    mode: "direct",
    effectiveOutboundInterface: outboundInterface,
    tunConflictDetected: true,
  });
}

export function buildSystemBridgeConfig({
  controlPort,
  listenerPort,
  systemProxyServer,
  tunConflictDetected = false,
}) {
  const upstream = systemRaw(systemProxyServer);
  return buildMihomoRuntimeConfig({
    controlPort,
    adapters: [upstream],
    listeners: [
      {
        name: "in-system-bridge",
        type: "http",
        listen: "127.0.0.1",
        port: listenerPort,
        proxy: upstream.name,
      },
    ],
    rules: ["MATCH,REJECT"],
    mode: "system",
    tunConflictDetected,
  });
}
