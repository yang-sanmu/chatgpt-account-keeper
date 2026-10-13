import { createHash } from "node:crypto";
import { BlockList, isIP } from "node:net";
import { win32 as path } from "node:path";
import { compileGroupPathPlan } from "./groupPathPlan.js";

const CONNECT = "FWPM_LAYER_ALE_AUTH_CONNECT";
const BIND = "FWPM_LAYER_ALE_RESOURCE_ASSIGNMENT";
const LISTEN = "FWPM_LAYER_ALE_AUTH_LISTEN";
const RECEIVE = "FWPM_LAYER_ALE_AUTH_RECV_ACCEPT";
const loopback = new BlockList();
loopback.addSubnet("127.0.0.0", 8, "ipv4");
loopback.addAddress("::1", "ipv6");
const unspecified = new BlockList();
unspecified.addAddress("0.0.0.0", "ipv4");
unspecified.addAddress("::", "ipv6");

function invalid(message) { return Object.assign(new Error(message), { code: "WFP_RESOURCE_PLAN_INVALID" }); }
function freeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze); Object.freeze(value);
  }
  return value;
}
function guid(namespace, value) {
  const bytes = createHash("sha256").update(JSON.stringify(["group_path_wfp_draft_v1", namespace, value])).digest();
  bytes[6] = (bytes[6] & 15) | 128; bytes[8] = (bytes[8] & 63) | 128;
  const hex = bytes.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function condition(field, type, value) { return { field: `FWPM_CONDITION_${field}`, match: "FWP_MATCH_EQUAL", type, value }; }
const app = value => condition("ALE_APP_ID", "application_path", value.toLowerCase());
// ALE_USER_ID requires a security descriptor in native WFP, not FWP_SID.
const user = value => condition("ALE_USER_ID", "local_user_security_descriptor", { sid: value });
const protocol = value => condition("IP_PROTOCOL", "FWP_UINT8", value === "tcp" ? 6 : 17);
const port = (side, value) => condition(`IP_${side}_PORT`, "FWP_UINT16", value);
const address = (side, value, prefixLength = isIP(value) === 4 ? 32 : 128) =>
  condition(`IP_${side}_ADDRESS`, isIP(value) === 4 ? "FWP_V4_ADDR_MASK" : "FWP_V6_ADDR_MASK", { address: value, prefixLength });
const family = value => isIP(value) === 4 ? "V4" : "V6";

function matchObservations(groups, observations) {
  if (!Array.isArray(observations)) throw invalid("目录观测必须是数组");
  const remaining = new Map(groups.map(group => [path.dirname(group.chromePath).toLowerCase(), group]));
  const matched = new Set();
  for (const observation of observations) {
    if (observation?.kind !== "runtime_inventory_observation" || typeof observation.directory !== "string") {
      throw invalid("必须提供 runtime-report 的目录观测，不能使用布尔验证结果");
    }
    const directory = observation.directory.toLowerCase();
    const group = remaining.get(directory);
    if (!group) throw invalid("目录观测不属于本次登记或重复提交");
    const manifest = observation.manifest;
    if (manifest?.version !== group.chrome.version || !Array.isArray(manifest.files)
      || manifest.files.length !== group.chrome.files.length) throw invalid("目录观测版本或清单不匹配");
    const files = new Map(group.chrome.files.map(file => [file.relativePath.toLowerCase(), file]));
    for (const file of manifest.files) {
      const key = typeof file?.relativePath === "string" ? file.relativePath.toLowerCase() : "";
      const expected = files.get(key);
      if (!expected || file.sizeBytes !== expected.sizeBytes || file.sha256 !== expected.sha256) throw invalid("目录观测文件不匹配");
      files.delete(key);
    }
    remaining.delete(directory); matched.add(group.key);
  }
  return groups.map(group => ({ groupKey: group.key, directory: path.dirname(group.chromePath),
    inventoryHash: group.chrome.inventoryHash, status: matched.has(group.key) ? "matched_observation" : "not_observed" }));
}

const observedTime = value => typeof value === "string" && Number.isFinite(Date.parse(value));
function matchPrograms(plan, observations) {
  if (!Array.isArray(observations)) throw invalid("程序观测必须是数组");
  const proxyFiles = plan.groups.flatMap(group => group.proxies.map(proxy => ({ groupKey: group.key,
    generation: proxy.generation, path: proxy.proxyPath, sha256: proxy.sha256 })));
  const controllerFiles = plan.controllers.map(controller => ({ controllerKey: controller.key, path: controller.path, sha256: controller.sha256 }));
  const remaining = new Map([...proxyFiles, ...controllerFiles].map(file => [file.path.toLowerCase(), file]));
  const matched = new Map();
  for (const observation of observations) {
    if (observation?.kind !== "program_file_observation" || typeof observation.path !== "string"
      || !Number.isSafeInteger(observation.sizeBytes) || observation.sizeBytes < 0 || !observedTime(observation.observedAt)) {
      throw invalid("必须提供完整的 program-report 程序观测");
    }
    const key = observation.path.toLowerCase(); const expected = remaining.get(key);
    if (!expected || observation.sha256 !== expected.sha256) throw invalid("程序观测路径或哈希不匹配，或重复提交");
    matched.set(key, { status: "matched_observation", sizeBytes: observation.sizeBytes, observedAt: observation.observedAt });
    remaining.delete(key);
  }
  const result = files => files.map(file => ({ ...file, ...(matched.get(file.path.toLowerCase()) ?? { status: "not_observed" }) }));
  return { proxyFiles: result(proxyFiles), controllerFiles: result(controllerFiles) };
}

function checkPorts(ports, observation) {
  const validPort = value => Number.isInteger(value) && value >= 1 && value <= 65535;
  const validRanges = ranges => Array.isArray(ranges) && ranges.every(range => range
    && validPort(range.start) && validPort(range.end) && range.start <= range.end);
  if (observation !== null && (observation?.kind !== "tcp_port_observation" || observation.scope !== "tcp_ipv4_ipv6"
    || !observedTime(observation.observedAt) || observation.portsReserved !== false
    || !validRanges(observation.dynamicRanges) || observation.dynamicRanges.length !== 2
    || !validRanges(observation.excludedRanges) || !Array.isArray(observation.occupiedPorts) || !observation.occupiedPorts.every(validPort))) {
    throw invalid("必须提供包含 IPv4/IPv6 范围及占用信息的完整 ports-report 观测");
  }
  const contains = (ranges, port) => ranges.some(range => port >= range.start && port <= range.end);
  const occupied = new Set(observation?.occupiedPorts);
  const entries = [...ports].sort((a, b) => a - b).map(port => {
    if (!observation) return { port, status: "not_observed", reasons: [] };
    const reasons = [];
    if (contains(observation.dynamicRanges, port)) reasons.push("dynamic_range");
    if (contains(observation.excludedRanges, port)) reasons.push("excluded_range");
    if (occupied.has(port)) reasons.push("occupied");
    return { port, status: reasons.length ? "conflict_observed" : "no_conflict_observed", reasons };
  });
  return { scope: "tcp_ipv4_ipv6", portsReserved: false, observedAt: observation?.observedAt ?? null, entries };
}

/** Compile only controlled input. These are symbolic WFP resources, not native
 * filters or an authorization receipt. Reports are compared, never attested.
 * No filesystem, WFP, process, or network operations occur here. */
export function compileWfpResourcePlan(input, { runtimeObservations = [], programObservations = [], portObservation = null } = {}) {
  const plan = compileGroupPathPlan(input);
  const observations = matchObservations(plan.groups, runtimeObservations);
  const programs = matchPrograms(plan, programObservations);
  const reservedPorts = new Set(plan.groups.flatMap(group => [
    ...group.proxies.map(proxy => proxy.listener.port), ...group.browserRuns.map(run => run.endpoint.port),
  ]));
  const ports = checkPorts(reservedPorts, portObservation);
  // A same-sublayer upstream permit must never override another entry's deny.
  for (const group of plan.groups) for (const proxy of group.proxies) {
    if (unspecified.check(proxy.endpoint.address, isIP(proxy.endpoint.address) === 4 ? "ipv4" : "ipv6")) {
      throw invalid("上游必须是具体地址，不能使用未指定地址");
    }
    if (proxy.endpoint.protocol === "tcp" && reservedPorts.has(proxy.endpoint.port)
      && loopback.check(proxy.endpoint.address, isIP(proxy.endpoint.address) === 4 ? "ipv4" : "ipv6")) {
      throw invalid("上游不能指向本次登记的代理或 CDP 入口（包括回环别名）");
    }
  }
  const providerKey = guid(plan.installationId, "provider");
  const sublayerKey = guid(plan.installationId, "sublayer");
  const filters = new Map();
  function add(group, purpose, layer, af, action, conditions, generation = null) {
    conditions.sort((a, b) => a.field.localeCompare(b.field, "en"));
    const specification = { layer: `${layer}_${af}`, action, lifetime: action === "block" ? "persistent" : "dynamic",
      weight: action === "block" ? 10 : 100, clearActionRight: false, conditions };
    const key = guid(plan.installationId, specification);
    if (!filters.has(key)) filters.set(key, { key, groupKey: group.key, generation, purpose, ...specification });
    return key;
  }
  function listenerRules(group, prefix, entryPort, owner, generation = null) {
    const persistent = []; const dynamic = [];
    for (const [af, network, bits] of [["V4", "127.0.0.0", 8], ["V6", "::1", 128], ["V6", "::ffff:127.0.0.0", 104]]) {
      persistent.push(add(group, `${prefix}_client_default_deny`, CONNECT, af, "block",
        [protocol("tcp"), address("REMOTE", network, bits), port("REMOTE", entryPort)], generation));
    }
    for (const layer of [BIND, LISTEN, RECEIVE]) {
      // AUTH_LISTEN has no IP_PROTOCOL condition; the layer is TCP-specific.
      const tcp = layer === LISTEN ? [] : [protocol("tcp")];
      for (const af of ["V4", "V6"]) {
        persistent.push(add(group, `${prefix}_owner_default_deny`, layer, af, "block",
          [...tcp, port("LOCAL", entryPort)], generation));
      }
      dynamic.push(add(group, `${prefix}_owner_allow`, layer, "V4", "permit", [app(owner), user(group.identity.userSid),
        ...tcp, address("LOCAL", "127.0.0.1"), port("LOCAL", entryPort),
        ...(layer === RECEIVE ? [address("REMOTE", "127.0.0.1")] : [])], generation));
    }
    return { persistent, dynamic };
  }
  const resources = plan.groups.map(group => {
    const programs = group.chrome.files.filter(file => file.relativePath.toLowerCase().endsWith(".exe"))
      .map(file => ({ path: file.path, sha256: file.sha256, role: "chrome" }));
    programs.push(...group.proxies.map(proxy => ({ path: proxy.proxyPath, sha256: proxy.sha256, role: "proxy", generation: proxy.generation })));
    for (const program of programs) {
      // Do not block all RESOURCE_ASSIGNMENTs: outbound sockets need ephemeral
      // local binds too. Only the registered TCP listener ports are reserved.
      for (const layer of [CONNECT, LISTEN, RECEIVE]) for (const af of ["V4", "V6"]) {
        add(group, "application_default_deny", layer, af, "block", [app(program.path)]);
      }
    }
    const freezeKeys = [];
    for (const proxy of group.proxies) {
      const entryPort = proxy.listener.port;
      listenerRules(group, "entry", entryPort, proxy.proxyPath, proxy.generation);
      if (proxy.role !== "active") continue;
      freezeKeys.push(add(group, "browser_entry_allow", CONNECT, "V4", "permit",
        [app(group.chromePath), user(group.identity.userSid), protocol("tcp"), address("REMOTE", "127.0.0.1"), port("REMOTE", entryPort)], proxy.generation));
      freezeKeys.push(add(group, "proxy_upstream_allow", CONNECT, family(proxy.endpoint.address), "permit",
        [app(proxy.proxyPath), user(group.identity.userSid), protocol(proxy.endpoint.protocol),
          address("REMOTE", proxy.endpoint.address), port("REMOTE", proxy.endpoint.port)], proxy.generation));
    }
    const controlChannels = group.browserRuns.map(run => {
      const controller = plan.controllers.find(item => item.key === run.controllerKey);
      const keys = listenerRules(group, "cdp", run.endpoint.port, group.chromePath);
      keys.dynamic.push(add(group, "cdp_client_allow", CONNECT, "V4", "permit", [app(controller.path), user(controller.userSid),
        protocol("tcp"), address("LOCAL", "127.0.0.1"), address("REMOTE", "127.0.0.1"), port("REMOTE", run.endpoint.port)]));
      // Keep the control channel during business freeze so Browser.close can run.
      // Its rules may be released only after this run's processes/connections drain.
      return { accountId: run.accountId, runToken: run.runToken, controllerKey: run.controllerKey, endpoint: run.endpoint,
        cleanupKeys: { dynamic: keys.dynamic.sort(), persistent: keys.persistent.sort() } };
    });
    return { key: group.key, identity: group.identity, inventoryHash: group.chrome.inventoryHash, programs,
      freezeKeys: freezeKeys.sort(), controlChannels };
  });
  const ordered = [...filters.values()].sort((a, b) => a.key < b.key ? -1 : 1);
  return freeze({ kind: "offline_wfp_resources", schemaVersion: 1, isolationModel: plan.isolationModel,
    launchAuthorization: "not_issued", provider: { key: providerKey, persistent: true },
    sublayer: { key: sublayerKey, providerKey, weight: 0x7000, persistent: true },
    groups: resources, controllers: plan.controllers, filters: ordered,
    cleanupKeys: { dynamic: ordered.filter(f => f.lifetime === "dynamic").map(f => f.key),
      persistent: ordered.filter(f => f.lifetime === "persistent").map(f => f.key), sublayer: sublayerKey, provider: providerKey },
    preflight: { chrome: observations, ...programs, ports, signaturesAndAcl: "not_checked" },
    pendingChecks: [...plan.pendingChecks, "native_appid_and_user_descriptor_encoding", "wfp_layer_and_priority_acceptance", "cdp_channel_registration"],
  });
}
