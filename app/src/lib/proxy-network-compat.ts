import type { NetworkConfigParams, NetworkConfigResult } from "@/ipc/generated";
import type { ProxyNode } from "@/ipc/types";

const UDP_ONLY_PROXY_TYPES = new Set(["hysteria2", "tuic", "hysteria", "wireguard"]);

export function isUdpOnlyNode(node: { type?: string | null; udpOnly?: boolean } | null | undefined): boolean {
  if (!node) return false;
  if (typeof node.udpOnly === "boolean") return node.udpOnly;
  const type = String(node.type ?? "").trim().toLowerCase();
  return UDP_ONLY_PROXY_TYPES.has(type);
}

export function effectiveSystemProxyServer(
  config: Pick<NetworkConfigParams, "mode" | "systemProxyUrl">,
  current: NetworkConfigResult | null | undefined
): string | null {
  if (config.mode !== "system") return null;
  if (config.systemProxyUrl?.trim()) return config.systemProxyUrl.trim();
  return current?.systemProxy.server ?? null;
}

export function upstreamUdpCompatibility({
  mode,
  systemProxyServer,
  relayNode,
}: {
  mode: NetworkConfigParams["mode"];
  systemProxyServer: string | null;
  relayNode?: Pick<ProxyNode, "id" | "name" | "type" | "udpSupported"> | null;
}): { blocksUdp: boolean; reason: string | null; socks5Suggestion: string | null } {
  if (mode === "direct") {
    return { blocksUdp: false, reason: null, socks5Suggestion: null };
  }
  if (mode === "system") {
    if (!systemProxyServer) return { blocksUdp: false, reason: null, socks5Suggestion: null };
    const lower = systemProxyServer.trim().toLowerCase();
    if (lower.startsWith("http://") || lower.startsWith("https://")) {
      const socks5Suggestion = systemProxyServer.replace(/^https?:\/\//i, "socks5://");
      return {
        blocksUdp: true,
        reason: `当前 HTTP 系统代理入口（${systemProxyServer}）不支持 UDP 转发`,
        socks5Suggestion,
      };
    }
    return { blocksUdp: false, reason: null, socks5Suggestion: null };
  }
  if (mode === "relay" && relayNode) {
    const type = String(relayNode.type ?? "").trim().toLowerCase();
    const supportsUdp =
      typeof relayNode.udpSupported === "boolean"
        ? relayNode.udpSupported
        : type !== "http" && type !== "https";
    if (!supportsUdp) {
      return {
        blocksUdp: true,
        reason: `当前中转节点「${relayNode.name}」（${relayNode.type ?? "unknown"}）不支持 UDP 转发`,
        socks5Suggestion: null,
      };
    }
  }
  return { blocksUdp: false, reason: null, socks5Suggestion: null };
}

export function getNodeUdpConflict(
  node: Pick<ProxyNode, "id" | "name" | "type" | "enabled" | "missing" | "directOutbound" | "udpOnly">,
  context: {
    mode: NetworkConfigParams["mode"];
    systemProxyServer: string | null;
    relayNode?: Pick<ProxyNode, "id" | "name" | "type" | "udpSupported"> | null;
  }
): string | null {
  if (!node.enabled || node.missing || node.directOutbound || !isUdpOnlyNode(node)) return null;
  if (context.mode === "relay" && context.relayNode && node.id === context.relayNode.id) return null;
  const compat = upstreamUdpCompatibility(context);
  if (!compat.blocksUdp) return null;
  const proto = node.type ?? "UDP";
  return `${proto} 属于纯 UDP 协议，${compat.reason}；请开启该节点「直连出站」或改用 SOCKS5 / 直连模式`;
}
