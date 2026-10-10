import { createHash } from "node:crypto";
import { win32 as path } from "node:path";
import { normalizeStrictUpstream, STRICT_DOH, strictBrowserArguments } from "./strictConfig.js";

export const GROUP_PATH_MODEL = "group_path_v1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const DEVICE = /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/iu;

function invalid(message) {
  return Object.assign(new Error(message), { code: "GROUP_PATH_PLAN_INVALID" });
}
function keys(value, allowed, label) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).some((key) => !allowed.includes(key))) throw invalid(`${label} 结构无效或含未知字段`);
}
function textMatch(value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value)) throw invalid(`${label} 无效`);
  return value;
}
function integer(value, min, max, label) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw invalid(`${label} 无效`);
  return value;
}
function hash(value) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function freeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function segments(value) {
  if (typeof value !== "string" || !value || /[\x00-\x1f\x7f/:*?"<>|~]/u.test(value)) throw invalid("路径格式无效");
  const parts = value.split("\\");
  if (parts.some((part) => !part || part === "." || part === ".." || /[ .]$/u.test(part) || DEVICE.test(part))) {
    throw invalid("路径包含空段、别名或保留名称");
  }
  return parts;
}
function rootPath(value) {
  if (typeof value !== "string" || !/^[A-Z]:\\/u.test(value)) throw invalid("程序根目录必须使用规范的本地盘符绝对路径");
  segments(value.slice(3));
  return value;
}
function userSid(value) {
  textMatch(value, /^S-1-[0-9]+(?:-[0-9]+){1,15}$/u, "用户 SID");
  const numbers = value.slice(4).split("-");
  for (let i = 0; i < numbers.length; i++) {
    if (String(BigInt(numbers[i])) !== numbers[i]
      || BigInt(numbers[i]) > (i === 0 ? 281474976710655n : 4294967295n)) throw invalid("用户 SID 无效");
  }
  return value;
}

// This validates a supplied inventory, not the disk, its ACL, signature, or link count.
function chromeInventory(input, directory) {
  keys(input, ["version", "files"], "Chrome 清单");
  textMatch(input.version, /^\d+\.\d+\.\d+\.\d+$/u, "Chrome 版本");
  if (!Array.isArray(input.files) || !input.files.length || input.files.length > 100000) throw invalid("Chrome 文件清单无效");
  const seen = new Set();
  let totalBytes = 0;
  const files = input.files.map((file) => {
    keys(file, ["relativePath", "sizeBytes", "sha256"], "Chrome 文件");
    segments(file.relativePath);
    const key = file.relativePath.toLowerCase();
    if (seen.has(key)) throw invalid("Chrome 文件路径重复");
    seen.add(key);
    textMatch(file.sha256, SHA256, "文件 SHA-256");
    integer(file.sizeBytes, 0, Number.MAX_SAFE_INTEGER, "文件大小");
    totalBytes += file.sizeBytes;
    if (!Number.isSafeInteger(totalBytes)) throw invalid("Chrome 文件总量溢出");
    return { ...file, path: path.join(directory, file.relativePath) };
  });
  for (const key of seen) {
    let parent = path.dirname(key);
    while (parent !== ".") {
      if (seen.has(parent)) throw invalid("Chrome 文件与目录路径冲突");
      parent = path.dirname(parent);
    }
  }
  const executables = files.filter((file) => file.relativePath.toLowerCase().endsWith(".exe"));
  if (!seen.has("chrome.exe") || executables.length > 256) throw invalid("Chrome 主程序缺失或程序清单超限");
  files.sort((a, b) => a.relativePath.toLowerCase() < b.relativePath.toLowerCase() ? -1 : 1);
  return { version: input.version, totalBytes, files,
    inventoryHash: hash([input.version, files.map(({ relativePath, sizeBytes, sha256 }) => ({ relativePath, sizeBytes, sha256 }))]),
    executablePaths: executables.map((file) => file.path).sort(),
  };
}

function configDraft(upstream, listenerPort) {
  // Intentionally separate from the v3 compiler: its credentials remain mandatory.
  return {
    "mixed-port": 0, "allow-lan": false, mode: "rule", "log-level": "warning", ipv6: true,
    dns: { enable: true, "enhanced-mode": "redir-host", "prefer-h3": false,
      "use-hosts": false, "use-system-hosts": false, nameserver: [STRICT_DOH], fallback: [] },
    proxies: [upstream],
    listeners: [{ name: "strict", type: "http", listen: "127.0.0.1", port: listenerPort, proxy: "upstream", users: [] }],
    rules: ["MATCH,REJECT"],
  };
}

/**
 * Offline v4 design compiler. No disk/network/process access and no launch authority.
 * Conflict checking covers only the supplied snapshot. The future service must
 * also check its complete registry, including paused/retained resources.
 * Contains upstream credentials: never publish the returned draft as diagnostics.
 */
export function compileGroupPathPlan(input) {
  keys(input, ["isolationModel", "installationId", "programRoot", "registrations"], "计划");
  if (input.isolationModel !== GROUP_PATH_MODEL) throw invalid("必须显式指定 group_path_v1；不接受旧策略或自动降级");
  textMatch(input.installationId, UUID, "安装 ID");
  const root = rootPath(input.programRoot);
  if (!Array.isArray(input.registrations) || !input.registrations.length) throw invalid("分组登记不能为空");
  const identities = new Set();
  const reservedPorts = new Set();
  const groups = input.registrations.map((registration) => {
    keys(registration, ["userSid", "dataDirectoryId", "groupId", "chrome", "proxies"], "分组登记");
    const sid = userSid(registration.userSid);
    textMatch(registration.dataDirectoryId, UUID, "数据目录登记 ID");
    textMatch(registration.groupId, /^[a-z0-9][a-z0-9_-]{0,63}$/u, "不可变分组 ID");
    segments(registration.groupId);
    const identity = { userSid: sid, dataDirectoryId: registration.dataDirectoryId, groupId: registration.groupId };
    const key = hash(identity);
    if (identities.has(key)) throw invalid("同一用户/数据目录/分组重复登记");
    identities.add(key);
    const ownerKey = hash([sid, registration.dataDirectoryId]);
    const groupRoot = path.join(root, input.installationId, ownerKey, registration.groupId);
    const chromeDirectory = path.join(groupRoot, "chrome", "active");
    const chromePath = path.join(chromeDirectory, "chrome.exe");
    const chrome = chromeInventory(registration.chrome, chromeDirectory);
    if (!Array.isArray(registration.proxies) || !registration.proxies.length || registration.proxies.length > 2) {
      throw invalid("每组必须有一个活动代理，最多一个候选代理");
    }
    const roles = new Set();
    const proxies = registration.proxies.map((proxy) => {
      keys(proxy, ["generation", "role", "listenerPort", "raw", "approvedAddress", "sha256"], "代理代次");
      if (!["active", "candidate"].includes(proxy.role) || roles.has(proxy.role)) throw invalid("代理角色重复或无效");
      roles.add(proxy.role);
      integer(proxy.generation, 1, Number.MAX_SAFE_INTEGER, "配置代次");
      integer(proxy.listenerPort, 1024, 65535, "入口端口");
      if (reservedPorts.has(proxy.listenerPort)) throw invalid("入口端口跨组或跨代次冲突");
      reservedPorts.add(proxy.listenerPort);
      textMatch(proxy.sha256, SHA256, "mihomo SHA-256");
      const { upstream, endpoint } = normalizeStrictUpstream(proxy.raw, proxy.approvedAddress);
      const proxyPath = path.join(groupRoot, "mihomo", String(proxy.generation), "mihomo.exe");
      const listener = { address: "127.0.0.1", port: proxy.listenerPort, protocol: "tcp" };
      const client = { path: chromePath, userSid: sid };
      const owner = { path: proxyPath, userSid: sid };
      // Candidate entries stay inaccessible until a coordinated promotion. There is
      // no generic diagnostic or Agent relay exception in this first offline model.
      const active = proxy.role === "active";
      return {
        generation: proxy.generation, role: proxy.role, proxyPath, sha256: proxy.sha256, listener, endpoint,
        userDataRelativeConfigPath: path.join("network", GROUP_PATH_MODEL, registration.groupId, String(proxy.generation), "config.yaml"),
        proxyConfigDraft: configDraft(upstream, proxy.listenerPort),
        policyIntent: {
          browserOutbound: { defaultAction: "block", applications: chrome.executablePaths,
            allow: active ? [{ ...client, endpoint: listener }] : [] },
          entryClients: { defaultAction: "block", listener,
            requireAliasCoverage: ["ipv4-loopback", "ipv6", "ipv4-mapped"], allow: active ? [client] : [] },
          listenerOwner: { defaultAction: "block", applications: [proxyPath], reservedListener: listener,
            allow: [{ ...owner, endpoint: listener }], wildcardBindAllowed: false },
          proxyOutbound: { defaultAction: "block", applications: [proxyPath], allow: active ? [{ ...owner, endpoint }] : [] },
        },
      };
    }).sort((a, b) => a.generation - b.generation);
    const active = proxies.find((proxy) => proxy.role === "active");
    const candidate = proxies.find((proxy) => proxy.role === "candidate");
    if (!active || (candidate && candidate.generation <= active.generation)) throw invalid("候选代次必须晚于活动代次");
    return { key, identity, groupRoot, chromePath, chrome, proxies,
      browserArgumentsDraft: strictBrowserArguments(active.listener.port) };
  });
  return freeze({ isolationModel: GROUP_PATH_MODEL, kind: "offline_group_path_plan", launchAuthorization: "not_issued",
    installationId: input.installationId, programRoot: root, groups,
    pendingChecks: ["complete_resource_registry", "caller_and_session_identity", "filesystem_links_acl_signatures_hashes",
      "disk_peak_and_update_layout", "port_inventory_and_reservation", "persistent_wfp_four_boundaries",
      "profile_lock_and_migration", "job_and_listener_ownership", "dynamic_wfp_commit", "cdp_initialization", "M1_ACCEPTANCE"],
  });
}
