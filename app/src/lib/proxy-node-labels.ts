import type { ProxyState } from "@/ipc/types";

function describeProxyNodes(proxies: ProxyState) {
  const aliases = new Map(proxies.subscriptions?.map((source) => [source.id, source.name]));
  const options = proxies.nodes.map((node) => {
    const source = (node.sourceId && aliases.get(node.sourceId)) || (node.id.startsWith("custom_") ? "自定义" : "订阅");
    const label = `${source} · ${node.name}`;
    const endpoint = [node.type, node.server && `${node.server}:${node.port ?? ""}`].filter(Boolean).join(" · ");
    return { value: node.id, label, endpoint, disabled: !node.enabled || node.missing };
  });
  const counts = new Map<string, number>();
  const endpoints = new Map<string, string[]>();
  for (const { label, endpoint, value } of options) {
    counts.set(label, (counts.get(label) ?? 0) + 1);
    const key = JSON.stringify([label, endpoint]);
    const peers = endpoints.get(key);
    if (peers) peers.push(value);
    else endpoints.set(key, [value]);
  }
  return options.map((option) => {
    const { value, endpoint, disabled } = option;
    let label = option.label;
    if ((counts.get(label) ?? 0) > 1) {
      if (endpoint) label += ` · ${endpoint}`;
      const peers = endpoints.get(JSON.stringify([option.label, endpoint])) ?? [];
      if (peers.length > 1) {
        let length = Math.min(8, value.length);
        while (length < value.length && peers.some((id) => id !== value && id.slice(-length) === value.slice(-length))) length++;
        label += ` · ${value.slice(-length)}`;
      }
    }
    if (disabled) label += "（不可用）";
    return { value, label, searchText: endpoint, disabled };
  });
}

export function proxyNodeOptions(proxies: ProxyState, selected?: string) {
  return describeProxyNodes(proxies).filter((option) => !option.disabled || option.value === selected);
}

export function proxyNodeLabels(proxies: ProxyState) {
  return new Map(describeProxyNodes(proxies).map(({ value, label }) => [value, label]));
}
