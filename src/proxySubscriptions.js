import { randomUUID } from "node:crypto";
import YAML from "yaml";
import { normalizeProxyNode } from "./proxyUtils.js";

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_NODES = 10000;

export function subscriptionUrl(value) {
  try {
    const text = value.trim();
    if (!/^https?:\/\//i.test(text) || /[\x00-\x20\x7f]/.test(text)) return null;
    const url = new URL(text);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}

export function subscriptionHost(value) {
  const url = subscriptionUrl(value);
  return url ? new URL(url).host : null;
}

async function readSubscription(response) {
  if (!response.body) return "";
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > MAX_BYTES) throw new Error("订阅内容过大");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8").trim();
}

export async function fetchSubscription(value) {
  const url = subscriptionUrl(value);
  if (!url) return { error: "请输入有效的 HTTP(S) 订阅链接" };
  let response;
  try {
    response = await fetch(url, {
      headers: { "user-agent": "clash-verge/mihomo" },
      signal: AbortSignal.timeout(45000),
    });
  } catch {
    return { error: "无法拉取订阅，请检查网络和链接" };
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    return { error: `订阅拉取失败（HTTP ${response.status}）` };
  }
  let text;
  try {
    text = await readSubscription(response);
  } catch {
    return { error: "订阅内容过大或下载中断" };
  }
  if (!text.includes("proxies:") && /^[A-Za-z0-9+/=\s]+$/.test(text)) {
    text = Buffer.from(text, "base64").toString("utf8");
  }
  try {
    const list = YAML.parse(text)?.proxies;
    if (!Array.isArray(list) || !list.length) return { error: "订阅没有可用的 proxies 节点" };
    if (list.length > MAX_NODES) return { error: "单条订阅的节点数量超过上限" };
    const nodes = list.map(normalizeProxyNode).filter(Boolean);
    if (!nodes.length) return { error: "订阅没有有效的代理节点" };
    // Reject recursive aliases and bound the expanded data before comparison or storage.
    const serialized = JSON.stringify(nodes);
    if (Buffer.byteLength(serialized) > MAX_BYTES) return { error: "订阅内容过大" };
    return { nodes: JSON.parse(serialized), skipped: list.length - nodes.length };
  } catch {
    return { error: "订阅内容不是有效的 Clash YAML" };
  }
}

export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function connectionKey({ name, "dialer-proxy": importedDialer, ...connection }) {
  return stableJson(connection);
}

function indexBy(items, keyOf) {
  const result = new Map();
  for (const item of items) {
    const key = keyOf(item);
    if (!result.has(key)) result.set(key, []);
    result.get(key).push(item);
  }
  return result;
}

export function mergeSubscriptionNodes(sourceId, incoming, previous, referenced) {
  const namedKey = ({ name, key }) => JSON.stringify([name.trim(), key]);
  const candidates = incoming.map((raw) => ({ raw, name: raw.name, key: connectionKey(raw) }));
  const unique = [...indexBy(candidates, namedKey).values()].map(([first]) => first);
  const old = previous.map((node) => ({
    ...node,
    key: connectionKey(normalizeProxyNode({ ...node.raw, name: node.name }) ?? {}),
  }));
  const unmatched = new Set(old);
  const matched = new Map();
  for (const keyOf of [namedKey, (node) => node.key]) {
    const before = indexBy(unmatched, keyOf);
    const after = indexBy(unique.filter((node) => !matched.has(node)), keyOf);
    for (const [key, next] of after) {
      const prior = before.get(key);
      if (next.length !== 1 || prior?.length !== 1) continue;
      matched.set(next[0], prior[0]);
      unmatched.delete(prior[0]);
    }
  }
  const missing = [...unmatched].filter((node) => referenced.has(node.id));
  const nodes = unique.map((candidate) => {
    const prior = matched.get(candidate);
    return {
      id: prior?.id ?? `px_${randomUUID()}`,
      sourceId,
      portSlot: prior?.portSlot,
      name: candidate.raw.name,
      raw: candidate.raw,
      enabled: prior?.enabled !== false,
      missing: false,
    };
  });
  for (const { key, ...node } of missing) nodes.push({ ...node, missing: true });
  return {
    nodes,
    added: unique.length - matched.size,
    updated: [...matched].filter(([next, prior]) => prior.missing || prior.name !== next.raw.name).length,
    missing: missing.filter((node) => !node.missing).map((node) => ({ id: node.id, name: node.name })),
    removed: unmatched.size - missing.length,
    duplicates: candidates.length - unique.length,
  };
}

export function allocateProxySlots(nodes) {
  const occupied = new Set(nodes.map((node) => node.portSlot).filter(Number.isInteger));
  let slot = 0;
  return nodes.map((node) => {
    if (Number.isInteger(node.portSlot)) return node;
    while (occupied.has(slot)) slot++;
    return { ...node, portSlot: slot++ };
  });
}
