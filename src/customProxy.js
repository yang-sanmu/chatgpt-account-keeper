import { createHash } from "node:crypto";
import { parseCustomProxyInput } from "./customProxyInput.js";

export function parseCustomProxies(input, selectedProtocol = "http") {
  return parseCustomProxyInput(input, selectedProtocol).map((details) => {
    const { server, port, username, password } = details;
    const type = details.protocol === "socks5" ? "socks5" : "http";
    const tls = details.protocol === "https";
    const identity = JSON.stringify([type, server, port, tls, username, password]);
    const suffix = createHash("sha256").update(identity).digest("hex").slice(0, 20);
    const host = server.includes(":") ? `[${server}]` : server;
    const name = details.name || `${type.toUpperCase()} ${host}:${port} · ${suffix.slice(0, 6)}`;
    if (name.length > 200) {
      throw Object.assign(new Error("代理节点名称过长，请通过 URL 的 #名称 指定最多 200 个字符的名称"), { badRequest: true });
    }
    return {
      id: `custom_${suffix}`, name,
      raw: { name: `custom_${suffix}`, type, server, port, ...(tls ? { tls: true } : {}), ...(username ? { username, password } : {}) },
      enabled: true, missing: false,
    };
  });
}

export function appendCustomProxies(previous, imported) {
  const nodes = new Map(previous.map((node) => [node.id, node]));
  for (const node of imported) {
    const old = nodes.get(node.id);
    nodes.set(node.id, { ...node, name: old?.name ?? node.name, enabled: old ? old.enabled !== false : true });
  }
  return [...nodes.values()];
}
