import os from "node:os";
import { execFile } from "node:child_process";

const HOST_NETWORK_TTL_MS = 15_000;
const POWERSHELL_TIMEOUT_MS = 8_000;

const TUN_PATTERN =
  /(?:^|[\s(_-])(mihomo|clash|meta\s*tunnel|wintun|sing-?tun|utun\d*|tun\d*|tap-?windows|flclash|v2rayn|nekobox|shadowrocket)(?:$|[\s)_-])/i;

const VIRTUAL_PATTERN =
  /(?:meta\s*tunnel|mihomo|clash|wintun|sing-?tun|tailscale|wireguard|hyper-?v|vethernet|vmware|virtualbox|vbox|wsl|tap-?windows|openvpn|sangfor|zerotier|hamachi|bluetooth|蓝牙|loopback|teredo|isatap|wan\s*miniport|virtual|vpn|tunnel|docker|podman|bridge|npcap|km-test)/i;

const ETHERNET_NAME_PATTERN = /(?:^|\s)(?:以太网|ethernet|eth\d*|en\d+)(?:\s|$|\d)/i;
const WIFI_NAME_PATTERN = /(?:^|\s)(?:wlan|wi-?fi|wireless|无线)(?:\s|$|\d)/i;

const WINDOWS_PROBE_SCRIPT = [
  "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
  "$OutputEncoding = [System.Text.Encoding]::UTF8",
  "$ErrorActionPreference = 'SilentlyContinue'",
  "$adapters = @(Get-CimInstance -Namespace root/StandardCimv2 -ClassName MSFT_NetAdapter | Select-Object Name, InterfaceDescription, InterfaceIndex, InterfaceOperationalStatus, MediaConnectState, HardwareInterface, Virtual, MacAddress)",
  "$routes = @(Get-CimInstance -Namespace root/StandardCimv2 -ClassName MSFT_NetRoute -Filter 'AddressFamily=2' | Where-Object { $_.DestinationPrefix -in @('0.0.0.0/0', '0.0.0.0/1', '128.0.0.0/1') } | Select-Object InterfaceAlias, InterfaceIndex, DestinationPrefix, NextHop, RouteMetric, InterfaceMetric)",
  "$ips = @(Get-CimInstance -Namespace root/StandardCimv2 -ClassName MSFT_NetIPAddress -Filter 'AddressFamily=2' | Select-Object InterfaceAlias, InterfaceIndex, IPAddress, PrefixLength)",
  "$dns = @(Get-CimInstance -Namespace root/StandardCimv2 -ClassName MSFT_DNSClientServerAddress -Filter 'AddressFamily=2' | Select-Object InterfaceAlias, InterfaceIndex, ServerAddresses)",
  "[PSCustomObject]@{ adapters = $adapters; routes = $routes; ips = $ips; dns = $dns } | ConvertTo-Json -Depth 4 -Compress",
].join("; ");

const asArray = (value) => (Array.isArray(value) ? value : value == null ? [] : [value]);
const isApipaAddress = (address) => typeof address === "string" && address.startsWith("169.254.");
const isLoopbackIpv4 = (address) => typeof address === "string" && address.startsWith("127.");

export function isFakeIpAddress(address) {
  if (typeof address !== "string") return false;
  const parts = address.trim().split(".");
  if (parts.length !== 4) return false;
  const first = Number(parts[0]);
  const second = Number(parts[1]);
  return first === 198 && (second === 18 || second === 19);
}

export function isLoopbackHost(host) {
  const value = String(host ?? "").trim().toLowerCase().replace(/^\[|\]$/g, "");
  return value === "localhost" || value === "127.0.0.1" || value === "::1" || value.startsWith("127.");
}

function isZeroMac(mac) {
  const normalized = String(mac ?? "").trim().replace(/[:-]/g, "").toLowerCase();
  return !normalized || /^0+$/.test(normalized);
}

function normalizeStatus(status, operationalStatus, mediaConnectState) {
  if (typeof status === "string" && status.trim()) {
    const text = status.trim().toLowerCase();
    if (text === "up") return "up";
    if (text === "disconnected" || text === "down" || text === "not present" || text === "disabled") return "down";
  }
  const op = Number(operationalStatus);
  if (op === 1) return "up";
  if (Number.isInteger(op) && op > 1) return "down";
  const media = Number(mediaConnectState);
  if (media === 1) return "up";
  if (media === 2) return "down";
  return "unknown";
}

function isTunNameOrDesc(name, description) {
  return TUN_PATTERN.test(String(name ?? "")) || TUN_PATTERN.test(String(description ?? ""));
}

function isVirtualNameOrDesc(name, description) {
  return VIRTUAL_PATTERN.test(String(name ?? "")) || VIRTUAL_PATTERN.test(String(description ?? ""));
}

function nicKindRank(name, description) {
  const text = `${name ?? ""} ${description ?? ""}`;
  if (ETHERNET_NAME_PATTERN.test(text) && !WIFI_NAME_PATTERN.test(text)) return 0;
  if (WIFI_NAME_PATTERN.test(text)) return 1;
  return 2;
}

function comparePhysicalInterfaces(left, right) {
  const rank = (nic) => [
    nic.status === "up" ? 0 : 1,
    nic.gateway && !isFakeIpAddress(nic.gateway) ? 0 : 1,
    nic.ipv4 && !isApipaAddress(nic.ipv4) && !isFakeIpAddress(nic.ipv4) ? 0 : 1,
    Number.isFinite(nic.metric) ? nic.metric : Number.POSITIVE_INFINITY,
    nicKindRank(nic.name, nic.description),
  ];
  const a = rank(left);
  const b = rank(right);
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return left.name.localeCompare(right.name);
}

function buildTunDetail({ adapterName, description, fakeIpDetected }) {
  const label = adapterName
    ? description && description !== adapterName
      ? `${adapterName}（${description}）`
      : adapterName
    : "虚拟 TUN 网卡";
  return fakeIpDetected
    ? `检测到活跃 TUN 网卡 ${label} 且存在 Fake-IP（198.18.0.0/15）路由/DNS，未绑定物理网卡的直连与 DNS 解析会被系统代理接管`
    : `检测到活跃 TUN 网卡 ${label} 持有默认路由，未绑定物理网卡的直连流量会被系统代理接管`;
}

function createAdapterLookup(items, addValue) {
  const byIndex = new Map();
  const byAlias = new Map();
  for (const item of asArray(items)) {
    const idx = Number(item?.InterfaceIndex);
    const alias = typeof item?.InterfaceAlias === "string" ? item.InterfaceAlias.trim() : "";
    if (Number.isInteger(idx)) addValue(byIndex, idx, item);
    if (alias) addValue(byAlias, alias, item);
  }
  return (idx, name, fallback) =>
    (Number.isInteger(idx) ? byIndex.get(idx) : undefined) ?? byAlias.get(name) ?? fallback;
}

function buildSnapshot({ platform, source, now, physicalCandidates, virtualAdapters, recommendedInterface, activeTun, fakeIpDetected }) {
  const tunDetected = Boolean(activeTun) || fakeIpDetected;
  return {
    platform,
    source,
    detectedAt: now.toISOString(),
    interfaces: physicalCandidates.map((nic) => ({
      name: nic.name,
      description: nic.description ?? null,
      status: nic.status,
      ipv4: nic.ipv4 ?? null,
      gateway: nic.gateway ?? null,
      metric: Number.isFinite(nic.metric) ? nic.metric : null,
      recommended: nic.name === recommendedInterface,
    })),
    virtualAdapters: virtualAdapters.map((nic) => ({
      name: nic.name,
      description: nic.description ?? null,
      status: nic.status,
      tun: Boolean(nic.tun),
    })),
    recommendedInterface,
    tunConflict: {
      detected: tunDetected,
      adapterName: activeTun?.name ?? null,
      description: activeTun?.description ?? null,
      fakeIpDetected,
      detail: tunDetected
        ? buildTunDetail({
            adapterName: activeTun?.name ?? null,
            description: activeTun?.description ?? null,
            fakeIpDetected,
          })
        : null,
    },
  };
}

export function parseWindowsHostNetworkPayload(payload, { now = new Date() } = {}) {
  const lookupIps = createAdapterLookup(payload?.ips, (map, key, item) => {
    const address = typeof item?.IPAddress === "string" ? item.IPAddress.trim() : "";
    if (!address || isLoopbackIpv4(address)) return;
    const list = map.get(key) ?? [];
    list.push(address);
    map.set(key, list);
  });

  const lookupRoute = createAdapterLookup(payload?.routes, (map, key, route) => {
    const prefix = String(route?.DestinationPrefix ?? "").trim();
    if (!["0.0.0.0/0", "0.0.0.0/1", "128.0.0.0/1"].includes(prefix)) return;
    const nextHop = typeof route?.NextHop === "string" ? route.NextHop.trim() : null;
    const metric =
      (Number.isFinite(Number(route?.RouteMetric)) ? Number(route.RouteMetric) : 0) +
      (Number.isFinite(Number(route?.InterfaceMetric)) ? Number(route.InterfaceMetric) : 0);
    const entry = {
      nextHop: nextHop && nextHop !== "0.0.0.0" ? nextHop : null,
      metric,
      halfDefault: prefix !== "0.0.0.0/0",
    };
    const existing = map.get(key);
    if (!existing || entry.metric < existing.metric) map.set(key, entry);
  });

  const lookupDns = createAdapterLookup(payload?.dns, (map, key, item) => {
    const servers = asArray(item?.ServerAddresses)
      .filter((addr) => typeof addr === "string" && addr.trim())
      .map((addr) => addr.trim());
    if (servers.length) map.set(key, servers);
  });

  const physicalCandidates = [];
  const virtualAdapters = [];
  let fakeIpDetected = false;

  for (const adapter of asArray(payload?.adapters)) {
    const name = typeof adapter?.Name === "string" ? adapter.Name.trim() : "";
    if (!name) continue;
    const description =
      typeof adapter?.InterfaceDescription === "string" && adapter.InterfaceDescription.trim()
        ? adapter.InterfaceDescription.trim()
        : null;
    const idx = Number(adapter?.InterfaceIndex);
    const status = normalizeStatus(adapter?.Status, adapter?.InterfaceOperationalStatus, adapter?.MediaConnectState);
    const addresses = lookupIps(idx, name, []);
    const route = lookupRoute(idx, name, null);
    const dnsServers = lookupDns(idx, name, []);

    const hasFakeIp =
      addresses.some(isFakeIpAddress) ||
      isFakeIpAddress(route?.nextHop) ||
      dnsServers.some(isFakeIpAddress);
    if (status === "up" && hasFakeIp) fakeIpDetected = true;

    const tun = isTunNameOrDesc(name, description) || hasFakeIp;
    const virtual =
      tun ||
      adapter?.Virtual === true ||
      adapter?.HardwareInterface === false ||
      isVirtualNameOrDesc(name, description);

    const primaryIpv4 =
      addresses.find((ip) => !isApipaAddress(ip) && !isFakeIpAddress(ip)) ??
      addresses.find((ip) => !isApipaAddress(ip)) ??
      addresses[0] ??
      null;

    const record = {
      name,
      description,
      status,
      ipv4: primaryIpv4,
      gateway: route?.nextHop ?? null,
      metric: route ? route.metric : null,
      hasDefaultRoute: Boolean(route),
      halfDefaultRoute: Boolean(route?.halfDefault),
      hasFakeIp,
      tun,
    };

    if (virtual) virtualAdapters.push(record);
    else physicalCandidates.push(record);
  }

  physicalCandidates.sort(comparePhysicalInterfaces);
  const topPhysical =
    physicalCandidates.find(
      (nic) => nic.status === "up" && nic.ipv4 && !isApipaAddress(nic.ipv4) && !isFakeIpAddress(nic.ipv4)
    ) ??
    physicalCandidates.find((nic) => nic.status === "up") ??
    null;

  const recommendedInterface = topPhysical?.name ?? null;
  const bestPhysicalMetric =
    topPhysical && Number.isFinite(topPhysical.metric) ? topPhysical.metric : Number.POSITIVE_INFINITY;

  const activeTun =
    virtualAdapters
      .filter((nic) => nic.status === "up")
      .filter(
        (nic) =>
          nic.hasFakeIp ||
          (nic.tun && (nic.hasDefaultRoute || Boolean(nic.ipv4))) ||
          (nic.hasDefaultRoute && (nic.halfDefaultRoute || (Number.isFinite(nic.metric) && nic.metric <= bestPhysicalMetric)))
      )
      .sort((left, right) => {
        const leftScore = (left.hasFakeIp ? 0 : 2) + (left.tun ? 0 : 1);
        const rightScore = (right.hasFakeIp ? 0 : 2) + (right.tun ? 0 : 1);
        if (leftScore !== rightScore) return leftScore - rightScore;
        const lm = Number.isFinite(left.metric) ? left.metric : Number.POSITIVE_INFINITY;
        const rm = Number.isFinite(right.metric) ? right.metric : Number.POSITIVE_INFINITY;
        return lm - rm;
      })[0] ?? null;

  return buildSnapshot({
    platform: "win32",
    source: "windows-powershell",
    now,
    physicalCandidates,
    virtualAdapters,
    recommendedInterface,
    activeTun,
    fakeIpDetected,
  });
}

export function inspectOsNetworkInterfaces(
  osInterfaces = os.networkInterfaces(),
  { platform = process.platform, now = new Date() } = {}
) {
  const physicalCandidates = [];
  const virtualAdapters = [];
  let fakeIpDetected = false;
  let activeTun = null;

  for (const [name, entries] of Object.entries(osInterfaces ?? {})) {
    const nonInternal = asArray(entries).filter((entry) => entry && !entry.internal);
    if (!nonInternal.length) continue;

    const ipv4List = nonInternal
      .filter((entry) => entry.family === "IPv4" || entry.family === 4)
      .map((entry) => entry.address)
      .filter((address) => typeof address === "string" && !isLoopbackIpv4(address));

    const hasFakeIp = ipv4List.some(isFakeIpAddress);
    if (hasFakeIp) fakeIpDetected = true;

    const mac = nonInternal.find((entry) => entry.mac && !isZeroMac(entry.mac))?.mac ?? null;
    const tun = isTunNameOrDesc(name, null) || hasFakeIp;
    const virtual = tun || isVirtualNameOrDesc(name, null) || !mac;

    const primaryIpv4 =
      ipv4List.find((ip) => !isApipaAddress(ip) && !isFakeIpAddress(ip)) ??
      ipv4List.find((ip) => !isApipaAddress(ip)) ??
      ipv4List[0] ??
      null;

    if (virtual) {
      virtualAdapters.push({ name, description: null, status: "up", tun });
      if ((hasFakeIp || tun) && (!activeTun || (hasFakeIp && !activeTun.hasFakeIp))) {
        activeTun = { name, description: null, hasFakeIp };
      }
      continue;
    }

    if (!primaryIpv4 || isApipaAddress(primaryIpv4)) continue;

    physicalCandidates.push({
      name,
      description: null,
      status: "up",
      ipv4: primaryIpv4,
      gateway: null,
      metric: null,
    });
  }

  physicalCandidates.sort(comparePhysicalInterfaces);

  return buildSnapshot({
    platform,
    source: "os-network-interfaces",
    now,
    physicalCandidates,
    virtualAdapters,
    recommendedInterface: physicalCandidates[0]?.name ?? null,
    activeTun,
    fakeIpDetected,
  });
}

let customDetector = null;
let cachedSnapshot = null;
let cachedAt = 0;
let inflightRefresh = null;

export function configureHostNetworkDetector(detector) {
  const previous = { customDetector, cachedSnapshot, cachedAt, inflightRefresh };
  customDetector = typeof detector === "function" ? detector : null;
  cachedSnapshot = null;
  cachedAt = 0;
  inflightRefresh = null;
  return () => {
    ({ customDetector, cachedSnapshot, cachedAt, inflightRefresh } = previous);
  };
}

function runWindowsPowershellProbe(timeoutMs = POWERSHELL_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", WINDOWS_PROBE_SCRIPT],
      { encoding: "utf8", windowsHide: true, timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024 },
      (error, stdout) => {
        if (error) return reject(error);
        const text = String(stdout ?? "").trim();
        if (!text) return reject(new Error("PowerShell returned empty output"));
        try {
          resolve(parseWindowsHostNetworkPayload(JSON.parse(text)));
        } catch (parseError) {
          reject(parseError);
        }
      }
    );
  });
}

export function getHostNetworkSnapshot() {
  if (customDetector) return customDetector();
  if (cachedSnapshot) {
    if (process.platform === "win32" && Date.now() - cachedAt >= HOST_NETWORK_TTL_MS && !inflightRefresh) {
      void refreshHostNetworkSnapshot();
    }
    return cachedSnapshot;
  }
  return inspectOsNetworkInterfaces();
}

export async function refreshHostNetworkSnapshot({ force = false, timeoutMs = POWERSHELL_TIMEOUT_MS } = {}) {
  if (customDetector) return customDetector();
  if (!force && cachedSnapshot && Date.now() - cachedAt < HOST_NETWORK_TTL_MS) {
    return cachedSnapshot;
  }
  if (process.platform !== "win32") {
    cachedSnapshot = inspectOsNetworkInterfaces();
    cachedAt = Date.now();
    return cachedSnapshot;
  }
  if (inflightRefresh && !force) return inflightRefresh;
  const run = runWindowsPowershellProbe(timeoutMs)
    .catch(() => inspectOsNetworkInterfaces())
    .then((snapshot) => {
      cachedSnapshot = snapshot;
      cachedAt = Date.now();
      return snapshot;
    })
    .finally(() => {
      if (inflightRefresh === run) inflightRefresh = null;
    });
  inflightRefresh = run;
  return run;
}

export function warmupHostNetworkSnapshot() {
  void refreshHostNetworkSnapshot().catch(() => {});
}

export function evaluateNetworkEnvironment(config, snapshot = getHostNetworkSnapshot()) {
  const manual = typeof config?.outboundInterface === "string" && config.outboundInterface.trim()
    ? config.outboundInterface.trim()
    : null;
  const autoEnabled = config?.autoOutboundInterface !== false;
  const interfaces = Array.isArray(snapshot?.interfaces) ? snapshot.interfaces : [];
  const virtualAdapters = Array.isArray(snapshot?.virtualAdapters) ? snapshot.virtualAdapters : [];
  const recommendedInterface = snapshot?.recommendedInterface ?? null;
  const tunConflict = snapshot?.tunConflict ?? {
    detected: false,
    adapterName: null,
    description: null,
    fakeIpDetected: false,
    detail: null,
  };

  let effectiveOutboundInterface = null;
  let outboundInterfaceSource = "none";
  let outboundInterfaceWarning = null;

  if (manual) {
    effectiveOutboundInterface = manual;
    outboundInterfaceSource = "manual";
    const lower = manual.toLowerCase();
    const matchedPhysical = interfaces.find((item) => item.name.toLowerCase() === lower);
    const matchedVirtual = virtualAdapters.find((item) => item.name.toLowerCase() === lower);
    if (matchedVirtual || isTunNameOrDesc(manual, null) || isVirtualNameOrDesc(manual, null)) {
      const hint = recommendedInterface ? `，请改选物理网卡（如 ${recommendedInterface}）或切换为自动选择` : "，请改选真实物理网卡";
      outboundInterfaceWarning = `当前指定的直出网卡「${manual}」属于虚拟/TUN 网卡，无法绕过系统代理或 TUN${hint}`;
    } else if (matchedPhysical && matchedPhysical.status !== "up") {
      const hint = recommendedInterface ? `，建议切换为「自动选择活跃物理网卡」或改选 ${recommendedInterface}` : "，请检查网络连接";
      outboundInterfaceWarning = `当前指定的直出网卡「${matchedPhysical.name}」未连接${hint}`;
    } else if (!matchedPhysical && interfaces.length > 0) {
      const available = interfaces.filter((item) => item.status === "up").map((item) => item.name);
      const hint = available.length ? `（当前活跃物理网卡：${available.join("、")}）` : "";
      outboundInterfaceWarning = `当前本机未找到名为「${manual}」的物理网卡${hint}，建议切换为「自动选择活跃物理网卡」`;
    }
  } else if (autoEnabled && tunConflict.detected && recommendedInterface) {
    effectiveOutboundInterface = recommendedInterface;
    outboundInterfaceSource = "auto";
  } else if (tunConflict.detected && !autoEnabled) {
    const hint = recommendedInterface ? `（推荐物理网卡：${recommendedInterface}）` : "";
    outboundInterfaceWarning = `已关闭自动选择物理网卡，直连/中转流量可能继续被 ${tunConflict.adapterName ?? "TUN"} 接管${hint}`;
  } else if (tunConflict.detected && !recommendedInterface) {
    outboundInterfaceWarning = `检测到 ${tunConflict.adapterName ?? "TUN"} 冲突，但未能识别活跃物理网卡，请手动填写物理网卡名称`;
  }

  return {
    source: snapshot?.source ?? "os-network-interfaces",
    interfaces: interfaces.map(({ name, description, status, ipv4, gateway, metric, recommended }) => ({
      name,
      description: description ?? null,
      status,
      ipv4: ipv4 ?? null,
      gateway: gateway ?? null,
      metric: Number.isFinite(metric) ? metric : null,
      recommended: Boolean(recommended),
    })),
    recommendedInterface,
    effectiveOutboundInterface,
    outboundInterfaceSource,
    outboundInterfaceWarning,
    tunConflict: {
      detected: Boolean(tunConflict.detected),
      adapterName: tunConflict.adapterName ?? null,
      description: tunConflict.description ?? null,
      fakeIpDetected: Boolean(tunConflict.fakeIpDetected),
      detail: tunConflict.detail ?? null,
    },
  };
}
