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

/** Compile only controlled input. These are symbolic WFP resources, not native
 * filters or an authorization receipt. Reports are compared, never attested.
 * No filesystem, WFP, process, or network operations occur here. */
export function compileWfpResourcePlan(input, { runtimeObservations = [] } = {}) {
  const plan = compileGroupPathPlan(input);
  const observations = matchObservations(plan.groups, runtimeObservations);
  const reservedPorts = new Set(plan.groups.flatMap(group => group.proxies.map(proxy => proxy.listener.port)));
  // A same-sublayer upstream permit must never override another entry's deny.
  for (const group of plan.groups) for (const proxy of group.proxies) {
    if (unspecified.check(proxy.endpoint.address, isIP(proxy.endpoint.address) === 4 ? "ipv4" : "ipv6")) {
      throw invalid("上游必须是具体地址，不能使用未指定地址");
    }
    if (proxy.endpoint.protocol === "tcp" && reservedPorts.has(proxy.endpoint.port)
      && loopback.check(proxy.endpoint.address, isIP(proxy.endpoint.address) === 4 ? "ipv4" : "ipv6")) {
      throw invalid("上游不能指向本次登记的代理入口（包括回环别名）");
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
      for (const [af, network, prefix] of [["V4", "127.0.0.0", 8], ["V6", "::1", 128], ["V6", "::ffff:127.0.0.0", 104]]) {
        add(group, "entry_client_default_deny", CONNECT, af, "block",
          [protocol("tcp"), address("REMOTE", network, prefix), port("REMOTE", entryPort)], proxy.generation);
      }
      for (const layer of [BIND, LISTEN, RECEIVE]) {
        // AUTH_LISTEN has no IP_PROTOCOL condition; the layer is TCP-specific.
        const tcp = layer === LISTEN ? [] : [protocol("tcp")];
        for (const af of ["V4", "V6"]) {
          add(group, "entry_owner_default_deny", layer, af, "block", [...tcp, port("LOCAL", entryPort)], proxy.generation);
        }
        add(group, "entry_owner_allow", layer, "V4", "permit", [app(proxy.proxyPath), user(group.identity.userSid),
          ...tcp, address("LOCAL", "127.0.0.1"), port("LOCAL", entryPort),
          ...(layer === RECEIVE ? [address("REMOTE", "127.0.0.1")] : [])], proxy.generation);
      }
      if (proxy.role !== "active") continue;
      freezeKeys.push(add(group, "browser_entry_allow", CONNECT, "V4", "permit",
        [app(group.chromePath), user(group.identity.userSid), protocol("tcp"), address("REMOTE", "127.0.0.1"), port("REMOTE", entryPort)], proxy.generation));
      freezeKeys.push(add(group, "proxy_upstream_allow", CONNECT, family(proxy.endpoint.address), "permit",
        [app(proxy.proxyPath), user(group.identity.userSid), protocol(proxy.endpoint.protocol),
          address("REMOTE", proxy.endpoint.address), port("REMOTE", proxy.endpoint.port)], proxy.generation));
    }
    return { key: group.key, identity: group.identity, inventoryHash: group.chrome.inventoryHash, programs,
      freezeKeys: freezeKeys.sort() };
  });
  const ordered = [...filters.values()].sort((a, b) => a.key < b.key ? -1 : 1);
  return freeze({ kind: "offline_wfp_resources", schemaVersion: 1, isolationModel: plan.isolationModel,
    launchAuthorization: "not_issued", provider: { key: providerKey, persistent: true },
    sublayer: { key: sublayerKey, providerKey, weight: 0x7000, persistent: true },
    groups: resources, filters: ordered,
    cleanupKeys: { dynamic: ordered.filter(f => f.lifetime === "dynamic").map(f => f.key),
      persistent: ordered.filter(f => f.lifetime === "persistent").map(f => f.key), sublayer: sublayerKey, provider: providerKey },
    preflight: { chrome: observations, proxyFiles: "not_checked", signaturesAndAcl: "not_checked" },
    pendingChecks: [...plan.pendingChecks, "native_appid_and_user_descriptor_encoding", "wfp_layer_and_priority_acceptance", "cdp_channel_registration"],
  });
}
