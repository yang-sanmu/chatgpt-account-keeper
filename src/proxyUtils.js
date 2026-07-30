/**
 * Normalize one Clash/mihomo proxy node before it is persisted or rendered.
 * In particular, `port` must become a real integer so subscription-controlled
 * strings can never flow into the dashboard's HTML.
 */
export function normalizeProxyNode(raw) {
  const name = String(raw?.name ?? "").trim();
  const type = String(raw?.type ?? "").trim();
  const server = String(raw?.server ?? "").trim();
  const port = Number(raw?.port);

  if (
    !name ||
    !type ||
    !server ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  ) {
    return null;
  }

  return {
    ...raw,
    name,
    type,
    server,
    port,
  };
}

/**
 * Build the persisted node list for a refreshed subscription.
 * Removed nodes are retained only while a group still references them.
 */
export function mergeProxyNodes(rawNodes, previousNodes, referencedIds) {
  const prevById = new Map(previousNodes.map((node) => [node.id, node]));
  const nodes = [];
  const seen = new Set();

  for (const candidate of rawNodes) {
    const raw = normalizeProxyNode(candidate);
    if (!raw) continue;

    const id = proxyNodeId(raw.name);
    if (seen.has(id)) continue;
    seen.add(id);

    const old = prevById.get(id);
    nodes.push({
      id,
      name: raw.name,
      raw,
      enabled: old ? old.enabled !== false : true,
      missing: false,
    });
  }

  for (const old of previousNodes) {
    if (!seen.has(old.id) && referencedIds.has(old.id)) {
      nodes.push({ ...old, missing: true });
    }
  }

  return nodes;
}

export function proxyNodeId(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  }
  return "px_" + hash.toString(36);
}
