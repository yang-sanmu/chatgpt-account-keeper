import test from "node:test";
import assert from "node:assert/strict";
import { compileGroupPathPlan, GROUP_PATH_MODEL } from "../src/network/groupPathPlan.js";
import { buildStrictProxyConfig, getStrictNetworkCapabilities } from "../src/network/strictConfig.js";

const HASH = "a".repeat(64);
const SID = "S-1-5-21-100-200-300-1001";
const DIRECTORY = "00000000-0000-4000-8000-000000000002";
function file(relativePath, sizeBytes = 100) { return { relativePath, sizeBytes, sha256: HASH }; }
function proxy(generation = 1, role = "active", listenerPort = 23001) {
  return { generation, role, listenerPort, sha256: HASH, approvedAddress: "192.0.2.10",
    raw: { type: "vmess", server: "node.example", port: 443, tls: true, uuid: "test", network: "ws", "ws-opts": { path: "/ws" } } };
}
function registration(groupId = "grp_a", port = 23001) {
  return { userSid: SID, dataDirectoryId: DIRECTORY, groupId,
    chrome: { version: "155.0.8059.40", files: [file("chrome.exe"), file("155.0.8059.40\\chrome.dll", 300),
      file("155.0.8059.40\\chrome_crashpad_handler.exe")] }, proxies: [proxy(1, "active", port)] };
}
function input() {
  return { isolationModel: GROUP_PATH_MODEL, installationId: "00000000-0000-4000-8000-000000000001",
    programRoot: "C:\\Program Files\\GptAccountKeeper\\runtimes", registrations: [registration(), registration("grp_b", 23002)] };
}
function invalid(mutate, code = "GROUP_PATH_PLAN_INVALID") {
  const value = input();
  mutate(value);
  assert.throws(() => compileGroupPathPlan(value), { code });
}

test("v4 offline plan scopes paths by immutable user, data directory and group, never by a supplied executable", () => {
  const value = input();
  value.registrations.push({ ...registration("grp_a", 23003), userSid: "S-1-5-21-100-200-300-1002" });
  value.registrations.push({ ...registration("grp_a", 23004), dataDirectoryId: "00000000-0000-4000-8000-000000000003" });
  const plan = compileGroupPathPlan(value);
  assert.equal(new Set(plan.groups.map((group) => group.chromePath)).size, 4);
  assert.equal(new Set(plan.groups.map((group) => group.key)).size, 4);
  for (const group of plan.groups) {
    assert.ok(group.chromePath.endsWith(`\\${group.identity.groupId}\\chrome\\active\\chrome.exe`));
    assert.ok(group.proxies[0].proxyPath.startsWith(`${group.groupRoot}\\mihomo\\1\\`));
    assert.equal(group.identity.userSid, value.registrations[plan.groups.indexOf(group)].userSid);
  }
  invalid((v) => { v.registrations[0].chromePath = plan.groups[1].chromePath; });
  invalid((v) => { v.registrations[0].identity = plan.groups[1].identity; });
  invalid((v) => { v.registrations.push(structuredClone(v.registrations[0])); });
});

test("v4 paths reject lexical aliases, traversal, device names and malformed identities", () => {
  for (const root of ["C:\\", "c:\\lab", "C:lab", "\\\\server\\share", "\\\\?\\C:\\lab", "C:/lab", "C:\\a\\..\\lab",
    "C:\\a\\.\\lab", "C:\\lab\\", "C:\\lab.", "C:\\lab ", "C:\\PROGRA~1\\lab", "C:\\nul.txt", "C:\\lab:stream", "C:\\a\\\\b"]) {
    invalid((v) => { v.programRoot = root; });
  }
  for (const group of ["../a", "a\\b", "a/b", "A", "con", "aux", "com1", "a ", "a.", "", "a".repeat(65)]) {
    invalid((v) => { v.registrations[0].groupId = group; });
  }
  for (const sid of ["S-1-5", "S-1-05-21", "S-1-5-21-01", "S-1-5-4294967296", "S-1-281474976710656-1", "s-1-5-21-1"]) {
    invalid((v) => { v.registrations[0].userSid = sid; });
  }
  invalid((v) => { v.registrations[0].dataDirectoryId = "../directory"; });
  invalid((v) => { v.installationId = "caller-selected/path"; });
});

test("v4 validates whole supplied file inventory, includes auxiliaries, and keeps stable active paths", () => {
  const value = input();
  const before = compileGroupPathPlan(value).groups[0];
  assert.equal(before.chrome.totalBytes, 500);
  const rules = before.proxies[0].policyIntent.browserOutbound;
  assert.equal(rules.applications.length, 2);
  assert.ok(rules.applications.some((p) => p.endsWith("chrome_crashpad_handler.exe")));
  assert.equal(rules.allow.length, 1);
  assert.equal(rules.allow[0].path, before.chromePath);
  value.registrations[0].chrome.files.reverse();
  assert.equal(compileGroupPathPlan(value).groups[0].chrome.inventoryHash, before.chrome.inventoryHash);
  value.registrations[0].chrome.files[0].sha256 = "b".repeat(64);
  value.registrations[0].chrome.version = "155.0.8059.41";
  const after = compileGroupPathPlan(value).groups[0];
  assert.equal(after.chromePath, before.chromePath);
  assert.notEqual(after.chrome.inventoryHash, before.chrome.inventoryHash);
  for (const name of ["..\\chrome.exe", "x/Chrome.exe", "x\\CON.exe", "x\\a:stream", "x\\a.", "x\\a ", "C:\\Chrome.exe"]) {
    invalid((v) => { v.registrations[0].chrome.files.push(file(name)); });
  }
  invalid((v) => { v.registrations[0].chrome.files.push(file("CHROME.EXE")); });
  invalid((v) => { v.registrations[0].chrome.files.push(file("155.0.8059.40")); });
  invalid((v) => { v.registrations[0].chrome.files.shift(); });
  invalid((v) => { v.registrations[0].chrome.files[0].sha256 = "invalid"; });
  invalid((v) => { v.registrations[0].chrome.files[0].sizeBytes = -1; });
  invalid((v) => { v.registrations[0].chrome.files[0].sizeBytes = Number.MAX_SAFE_INTEGER; });
  invalid((v) => { v.registrations[0].chrome.files.push(...Array.from({ length: 256 }, (_, i) => file(`helper${i}.exe`))); });
});

test("v4 generation and entry conflicts fail across groups, users and candidates", () => {
  invalid((v) => { v.registrations[1].proxies[0].listenerPort = 23001; });
  invalid((v) => { v.registrations[1].userSid = "S-1-5-21-100-200-300-1002"; v.registrations[1].proxies[0].listenerPort = 23001; });
  invalid((v) => { v.registrations[0].proxies.push(proxy(2, "candidate", 23002)); });
  for (const port of [1023, 65536, 1.5, "23001"]) invalid((v) => { v.registrations[0].proxies[0].listenerPort = port; });
  for (const generation of [0, -1, "2", Number.MAX_SAFE_INTEGER + 1]) invalid((v) => { v.registrations[0].proxies[0].generation = generation; });
  for (const p of [proxy(1, "candidate", 23003), proxy(2, "active", 23003)]) {
    invalid((v) => { v.registrations[0].proxies.push(p); });
  }
  invalid((v) => { v.registrations[0].proxies = [proxy(2, "candidate", 23003)]; });
  invalid((v) => { v.registrations[0].proxies.push(proxy(2, "candidate", 23003), proxy(3, "candidate", 23004)); });
});

test("v4 expresses four boundaries without granting a candidate or auxiliary process entry access", () => {
  const value = input();
  value.registrations[0].proxies.push(proxy(2, "candidate", 23003));
  const [a, b] = compileGroupPathPlan(value).groups;
  for (const group of [a, b]) {
    const active = group.proxies[0];
    const { browserOutbound, entryClients, listenerOwner, proxyOutbound } = active.policyIntent;
    for (const boundary of [browserOutbound, entryClients, listenerOwner, proxyOutbound]) assert.equal(boundary.defaultAction, "block");
    assert.deepEqual(entryClients.allow, [{ path: group.chromePath, userSid: SID }]);
    assert.deepEqual(browserOutbound.allow, [{ path: group.chromePath, userSid: SID, endpoint: active.listener }]);
    assert.deepEqual(listenerOwner.allow, [{ path: active.proxyPath, userSid: SID, endpoint: active.listener }]);
    assert.equal(listenerOwner.wildcardBindAllowed, false);
    assert.deepEqual(proxyOutbound.allow, [{ path: active.proxyPath, userSid: SID, endpoint: active.endpoint }]);
    assert.deepEqual(active.listener, { address: "127.0.0.1", port: active.listener.port, protocol: "tcp" });
  }
  for (const field of ["browserOutbound", "entryClients", "proxyOutbound"]) assert.deepEqual(a.proxies[1].policyIntent[field].allow, []);
  assert.notEqual(a.proxies[0].proxyPath, a.proxies[1].proxyPath);
  assert.notEqual(a.proxies[0].userDataRelativeConfigPath, a.proxies[1].userDataRelativeConfigPath);
  assert.ok(a.browserArgumentsDraft.includes("--proxy-server=http://127.0.0.1:23001"));
  assert.equal(a.browserArgumentsDraft.some((arg) => arg.includes("23003")), false);
});

test("only explicit v4 drafts omit listener credentials; v3 authentication cannot be opted out", () => {
  for (const model of [undefined, "v3", "group_path_v2"]) invalid((v) => { v.isolationModel = model; });
  invalid((v) => { v.registrations[0].proxies[0].credentials = { username: "u", password: "p" }; });
  invalid((v) => { v.registrations[0].proxies[0].users = []; });
  invalid((v) => { v.ready = true; });
  const p = proxy();
  for (const credentials of [undefined, {}, { username: "", password: "" }]) {
    assert.throws(() => buildStrictProxyConfig({ ...p, credentials, isolationModel: GROUP_PATH_MODEL }), { code: "STRICT_CONFIG_UNSUPPORTED" });
  }
  const draft = compileGroupPathPlan(input()).groups[0].proxies[0].proxyConfigDraft;
  const legacy = buildStrictProxyConfig({ ...p, credentials: { username: "u", password: "p" } }).config;
  legacy.listeners[0].users = [];
  assert.deepEqual(draft, legacy);
  assert.deepEqual(draft.rules, ["MATCH,REJECT"]);
  assert.equal(draft["external-controller"], undefined);
  assert.deepEqual(draft.dns.fallback, []);
  assert.equal(draft.proxies[0].servername, "node.example");
  assert.equal(draft.proxies[0]["ws-opts"].headers.Host, "node.example");
  invalid((v) => { v.registrations[0].proxies[0].raw["skip-cert-verify"] = true; }, "STRICT_CONFIG_UNSUPPORTED");
  invalid((v) => { v.registrations[0].proxies[0].raw.network = "xhttp"; }, "STRICT_CONFIG_UNSUPPORTED");
  invalid((v) => { v.registrations[0].proxies[0].raw["dialer-proxy"] = "other"; }, "STRICT_CONFIG_UNSUPPORTED");
});

test("v4 permits only the selected upstream transport without enabling browser UDP", () => {
  for (const type of ["http", "socks5", "anytls", "hysteria2", "tuic", "vmess", "vless"]) {
    const value = input();
    value.registrations[0].proxies[0].raw = { type, server: "node.example", port: 443, tls: true };
    const p = compileGroupPathPlan(value).groups[0].proxies[0];
    assert.equal(p.policyIntent.proxyOutbound.allow[0].endpoint.protocol, ["hysteria2", "tuic"].includes(type) ? "udp" : "tcp");
    assert.equal(p.policyIntent.browserOutbound.allow[0].endpoint.protocol, "tcp");
    assert.equal(p.proxyConfigDraft.proxies[0].udp, false);
  }
});

test("v4 drafts are immutable, detached from inputs and explicitly lack launch authorization", () => {
  const value = input();
  const original = structuredClone(value);
  const plan = compileGroupPathPlan(value);
  assert.deepEqual(value, original);
  value.registrations[0].proxies[0].raw["ws-opts"].path = "/changed";
  assert.equal(plan.groups[0].proxies[0].proxyConfigDraft.proxies[0]["ws-opts"].path, "/ws");
  assert.throws(() => { plan.groups[0].proxies[0].policyIntent.entryClients.allow.push({ path: "other.exe" }); }, TypeError);
  assert.equal(plan.launchAuthorization, "not_issued");
  assert.equal(plan.kind, "offline_group_path_plan");
  assert.ok(plan.pendingChecks.includes("persistent_wfp_four_boundaries"));
  assert.ok(plan.pendingChecks.includes("filesystem_links_acl_signatures_hashes"));
  assert.equal(getStrictNetworkCapabilities().available, false);
  assert.equal(getStrictNetworkCapabilities().reason, "M1_NOT_ACCEPTED");
});
