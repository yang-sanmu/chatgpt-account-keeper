import test from "node:test";
import assert from "node:assert/strict";
import { BlockList, isIP } from "node:net";
import { win32 as path } from "node:path";
import { compileGroupPathPlan } from "../src/network/groupPathPlan.js";
import { compileWfpResourcePlan } from "../src/network/wfpResourcePlan.js";
import { getStrictNetworkCapabilities } from "../src/network/strictConfig.js";

const SID = "S-1-5-21-1-2-3-1001";
function input() {
  return { isolationModel: "group_path_v1", installationId: "00000000-0000-4000-8000-000000000001", programRoot: "C:\\RuntimeTest",
    registrations: ["a", "b"].map((name, i) => ({ userSid: SID, dataDirectoryId: "00000000-0000-4000-8000-000000000002",
      groupId: `grp_${name}`, chrome: { version: "155.0.8059.40", files: ["chrome.exe", "version\\helper.exe", "version\\resource.pak"]
        .map(relativePath => ({ relativePath, sizeBytes: 100, sha256: "a".repeat(64) })) },
      proxies: [{ generation: 1, role: "active", listenerPort: 23001 + i, sha256: "b".repeat(64),
        raw: { type: "http", server: "node.example", port: 443, tls: true, username: "secret-username", password: "secret-password" },
        approvedAddress: "192.0.2.1" }] })) };
}
const condition = (filter, name) => filter.conditions.find(c => c.field === `FWPM_CONDITION_${name}`);

// An independent check of the emitted conditions in OUR sublayer. This does
// not model other providers, native security descriptors or WFP reauthorization.
function decision(resources, layer, event) {
  const candidates = resources.filters.filter(filter => filter.layer === `FWPM_LAYER_ALE_${layer}` && filter.conditions.every(c => {
    switch (c.field) {
      case "FWPM_CONDITION_ALE_APP_ID": return c.value === event.app.toLowerCase();
      case "FWPM_CONDITION_ALE_USER_ID": return c.value.sid === event.user;
      case "FWPM_CONDITION_IP_PROTOCOL": return c.value === event.protocol;
      case "FWPM_CONDITION_IP_LOCAL_PORT": return c.value === event.localPort;
      case "FWPM_CONDITION_IP_REMOTE_PORT": return c.value === event.remotePort;
      case "FWPM_CONDITION_IP_LOCAL_ADDRESS":
      case "FWPM_CONDITION_IP_REMOTE_ADDRESS": {
        const block = new BlockList(); const address = c.field.includes("LOCAL") ? event.localAddress : event.remoteAddress;
        block.addSubnet(c.value.address, c.value.prefixLength, isIP(c.value.address) === 4 ? "ipv4" : "ipv6");
        return block.check(address, isIP(address) === 4 ? "ipv4" : "ipv6");
      }
      default: throw new Error(`Unknown condition ${c.field}`);
    }
  })).sort((a, b) => b.weight - a.weight);
  return candidates[0]?.action ?? "unmatched";
}

test("WFP draft restricts entry clients, helpers, wrong users and other groups without a global loopback block", () => {
  const raw = input(); const plan = compileGroupPathPlan(raw); const resources = compileWfpResourcePlan(raw);
  const [a, b] = plan.groups;
  const event = { app: a.chromePath, user: SID, protocol: 6, remoteAddress: "127.0.0.1", remotePort: 23001 };
  assert.equal(decision(resources, "AUTH_CONNECT_V4", event), "permit");
  for (const app of [b.chromePath, path.join(path.dirname(a.chromePath), "version", "helper.exe"), "C:\\Daily\\chrome.exe", "C:\\Other.exe"]) {
    assert.equal(decision(resources, "AUTH_CONNECT_V4", { ...event, app }), "block");
  }
  assert.equal(decision(resources, "AUTH_CONNECT_V4", { ...event, user: "S-1-5-21-1-2-3-1002" }), "block");
  assert.equal(decision(resources, "AUTH_CONNECT_V4", { ...event, remotePort: 23002 }), "block");
  assert.equal(decision(resources, "AUTH_CONNECT_V4", { ...event, protocol: 17, remoteAddress: "192.0.2.1" }), "block");
  assert.equal(decision(resources, "AUTH_CONNECT_V4", { ...event, app: "C:\\Other.exe", remotePort: 24000 }), "unmatched");
  assert.equal(decision(resources, "AUTH_CONNECT_V4", { ...event, app: "C:\\Other.exe", remoteAddress: "192.0.2.1" }), "unmatched");
  for (const remoteAddress of ["127.0.0.2", "127.1.2.3", "::1", "::ffff:127.0.0.1", "::ffff:7f00:2"]) {
    assert.equal(decision(resources, `AUTH_CONNECT_V${isIP(remoteAddress)}`, { ...event, app: "C:\\Other.exe", remoteAddress }), "block");
  }
});

test("WFP listener conditions are layer-specific and do not block unrelated outbound ephemeral binds", () => {
  const raw = input(); const plan = compileGroupPathPlan(raw); const resources = compileWfpResourcePlan(raw);
  const event = { app: plan.groups[0].proxies[0].proxyPath, user: SID, protocol: 6,
    localAddress: "127.0.0.1", localPort: 23001, remoteAddress: "127.0.0.1" };
  for (const layer of ["RESOURCE_ASSIGNMENT_V4", "AUTH_LISTEN_V4", "AUTH_RECV_ACCEPT_V4"]) {
    assert.equal(decision(resources, layer, event), "permit");
    for (const changes of [{ app: plan.groups[1].proxies[0].proxyPath }, { app: "C:\\Other.exe" },
      { user: "S-1-5-21-1-2-3-1002" }, { localAddress: "0.0.0.0" }, { localAddress: "192.0.2.2" }]) {
      assert.equal(decision(resources, layer, { ...event, ...changes }), "block");
    }
  }
  assert.equal(decision(resources, "AUTH_RECV_ACCEPT_V4", { ...event, remoteAddress: "192.0.2.3" }), "block");
  assert.equal(decision(resources, "RESOURCE_ASSIGNMENT_V4", { ...event, localPort: 55000, localAddress: "0.0.0.0" }), "unmatched");
  for (const filter of resources.filters.filter(f => f.layer.includes("AUTH_LISTEN"))) {
    assert.equal(condition(filter, "IP_PROTOCOL"), undefined);
    assert.equal(condition(filter, "IP_REMOTE_ADDRESS"), undefined);
  }
});

test("WFP upstream grants follow transport and freezing removes both output permissions only for that group", () => {
  const raw = input();
  raw.registrations[0].proxies[0].raw = { type: "hysteria2", server: "node.example", port: 443, password: "secret" };
  raw.registrations[0].proxies[0].approvedAddress = "2001:db8::1";
  const plan = compileGroupPathPlan(raw); const resources = compileWfpResourcePlan(raw);
  const event = { app: plan.groups[0].proxies[0].proxyPath, user: SID, protocol: 17, remoteAddress: "2001:db8::1", remotePort: 443 };
  assert.equal(decision(resources, "AUTH_CONNECT_V6", event), "permit");
  for (const changes of [{ protocol: 6 }, { remotePort: 53 }, { remoteAddress: "2001:db8::2" }]) {
    assert.equal(decision(resources, "AUTH_CONNECT_V6", { ...event, ...changes }), "block");
  }
  const keys = resources.groups[0].freezeKeys;
  assert.equal(keys.length, 2);
  const frozen = { ...resources, filters: resources.filters.filter(f => !keys.includes(f.key)) };
  assert.equal(decision(frozen, "AUTH_CONNECT_V6", event), "block");
  const browser = { app: plan.groups[0].chromePath, user: SID, protocol: 6, remoteAddress: "127.0.0.1", remotePort: 23001 };
  assert.equal(decision(frozen, "AUTH_CONNECT_V4", browser), "block");
  assert.equal(decision(frozen, "AUTH_CONNECT_V4", { ...browser, app: plan.groups[1].chromePath, remotePort: 23002 }), "permit");
  const crashed = { ...resources, filters: resources.filters.filter(f => f.lifetime === "persistent") };
  assert.equal(decision(crashed, "AUTH_CONNECT_V4", { ...browser, app: "C:\\Other.exe" }), "block");
});

test("WFP candidates have listener ownership but no entry or upstream grant; default rules are deduplicated", () => {
  const raw = input();
  raw.registrations[0].proxies.push({ ...structuredClone(raw.registrations[0].proxies[0]), generation: 2, role: "candidate", listenerPort: 23003 });
  const plan = compileGroupPathPlan(raw); const resources = compileWfpResourcePlan(raw);
  const candidate = plan.groups[0].proxies[1];
  assert.equal(resources.filters.filter(f => f.generation === 2 && f.action === "permit").length, 3);
  assert.equal(decision(resources, "AUTH_CONNECT_V4", { app: plan.groups[0].chromePath, user: SID, protocol: 6,
    remoteAddress: "127.0.0.1", remotePort: candidate.listener.port }), "block");
  assert.equal(decision(resources, "AUTH_CONNECT_V4", { app: candidate.proxyPath, user: SID, protocol: 6,
    remoteAddress: candidate.endpoint.address, remotePort: candidate.endpoint.port }), "block");
  const browserDeny = resources.filters.filter(f => f.purpose === "application_default_deny"
    && condition(f, "ALE_APP_ID")?.value === plan.groups[0].chromePath.toLowerCase());
  assert.equal(browserDeny.length, 6);
  assert.equal(new Set(resources.filters.map(f => f.key)).size, resources.filters.length);
});

test("WFP rejects upstreams that could override reserved-entry denial", () => {
  for (const address of ["127.0.0.1", "127.1.2.3", "::1", "::ffff:127.0.0.1", "::ffff:7f00:1"]) {
    const raw = input(); raw.registrations[0].proxies[0].approvedAddress = address; raw.registrations[0].proxies[0].raw.port = 23002;
    assert.throws(() => compileWfpResourcePlan(raw), { code: "WFP_RESOURCE_PLAN_INVALID" });
  }
  for (const address of ["0.0.0.0", "::", "::ffff:0.0.0.0"]) {
    const raw = input(); raw.registrations[0].proxies[0].approvedAddress = address;
    assert.throws(() => compileWfpResourcePlan(raw), { code: "WFP_RESOURCE_PLAN_INVALID" });
  }
});

test("WFP resources and cleanup keys are stable, secret-free and have no hard permits", () => {
  const raw = input(); const before = compileWfpResourcePlan(raw);
  raw.registrations.reverse(); raw.registrations.forEach(r => r.chrome.files.reverse());
  const after = compileWfpResourcePlan(raw);
  assert.deepEqual(after.filters, before.filters);
  assert.deepEqual(after.cleanupKeys, before.cleanupKeys);
  assert.equal(before.cleanupKeys.dynamic.length + before.cleanupKeys.persistent.length, before.filters.length);
  for (const filter of before.filters) {
    assert.equal(filter.clearActionRight, false);
    assert.equal(filter.lifetime, filter.action === "permit" ? "dynamic" : "persistent");
    if (filter.action === "permit") assert.equal(condition(filter, "ALE_USER_ID").type, "local_user_security_descriptor");
  }
  const json = JSON.stringify(before);
  assert.equal(json.includes("secret-username"), false); assert.equal(json.includes("secret-password"), false);
  assert.throws(() => before.filters[0].conditions.push({}), TypeError);
  assert.equal(before.launchAuthorization, "not_issued"); assert.equal(getStrictNetworkCapabilities().available, false);
});

test("WFP preflight binds observed directory and every file, while absent observations stay pending", () => {
  const raw = input(); const plan = compileGroupPathPlan(raw);
  const observation = { kind: "runtime_inventory_observation", directory: path.dirname(plan.groups[0].chromePath),
    manifest: structuredClone(raw.registrations[0].chrome) };
  const resources = compileWfpResourcePlan(raw, { runtimeObservations: [observation] });
  assert.deepEqual(resources.preflight.chrome.map(c => c.status), ["matched_observation", "not_observed"]);
  assert.ok(resources.preflight.proxyFiles.every(file => file.status === "not_observed"));
  assert.equal(resources.launchAuthorization, "not_issued");
  for (const mutate of [o => { o.directory = "C:\\Unregistered"; }, o => { o.manifest.version = "1.0.0.0"; },
    o => { o.manifest.files.pop(); }, o => { o.manifest.files[0].sha256 = "b".repeat(64); },
    o => { o.manifest.files[1] = structuredClone(o.manifest.files[0]); }]) {
    const broken = structuredClone(observation); mutate(broken);
    assert.throws(() => compileWfpResourcePlan(raw, { runtimeObservations: [broken] }), { code: "WFP_RESOURCE_PLAN_INVALID" });
  }
  assert.throws(() => compileWfpResourcePlan(raw, { runtimeObservations: [observation, observation] }), { code: "WFP_RESOURCE_PLAN_INVALID" });
  assert.throws(() => compileWfpResourcePlan(raw, { runtimeObservations: [true] }), { code: "WFP_RESOURCE_PLAN_INVALID" });
});

function controlInput() {
  const raw = input();
  raw.registrations[1].dataDirectoryId = "00000000-0000-4000-8000-000000000003";
  raw.controllers = raw.registrations.map((group, i) => ({ userSid: group.userSid, dataDirectoryId: group.dataDirectoryId,
    path: `C:\\Keeper${i}\\node.exe`, sha256: "c".repeat(64) }));
  raw.registrations.forEach((group, i) => { group.browserRuns = [{ accountId: `acc_${i}`,
    runToken: `run-00000000-0000-4000-8000-00000000000${i}`, debugPort: 24001 + i }]; });
  return raw;
}

test("program observations bind proxy generations and shared controllers without granting authorization", () => {
  const raw = controlInput();
  raw.controllers[1].path = raw.controllers[0].path; // one file, two registered owners
  raw.registrations[0].proxies.push({ ...raw.registrations[0].proxies[0], generation: 2, role: "candidate", listenerPort: 23003 });
  const plan = compileGroupPathPlan(raw);
  const report = (file, sha256) => ({ kind: "program_file_observation", path: file, sha256, sizeBytes: 100,
    observedAt: "2026-10-13T01:00:00Z", productionReady: false });
  const proxy = report(plan.groups[0].proxies[1].proxyPath.toUpperCase(), "b".repeat(64));
  const controller = report(raw.controllers[0].path, "c".repeat(64));
  const options = { programObservations: [proxy, controller] };
  const before = structuredClone(options); const resources = compileWfpResourcePlan(raw, options);
  assert.deepEqual(resources.preflight.proxyFiles.map(file => file.status), ["not_observed", "matched_observation", "not_observed"]);
  assert.ok(resources.preflight.controllerFiles.every(file => file.status === "matched_observation"));
  assert.equal(resources.preflight.proxyFiles[1].observedAt, proxy.observedAt);
  assert.deepEqual(options, before); assert.equal(Object.isFrozen(proxy), false);
  assert.equal(resources.preflight.signaturesAndAcl, "not_checked");
  const unobserved = compileWfpResourcePlan(raw);
  assert.deepEqual(resources.filters, unobserved.filters);
  assert.deepEqual(resources.pendingChecks, unobserved.pendingChecks);
  assert.equal(resources.launchAuthorization, "not_issued");
  assert.throws(() => resources.preflight.proxyFiles.push({}), TypeError);
  for (const change of [{ path: "C:\\Other\\mihomo.exe" }, { sha256: "c".repeat(64) },
    { kind: "verified" }, { observedAt: "invalid" }, { sizeBytes: -1 }]) {
    assert.throws(() => compileWfpResourcePlan(raw, { programObservations: [{ ...proxy, ...change }] }), { code: "WFP_RESOURCE_PLAN_INVALID" });
  }
  for (const observations of [true, [true], [proxy, proxy], [controller, controller]]) {
    assert.throws(() => compileWfpResourcePlan(raw, { programObservations: observations }), { code: "WFP_RESOURCE_PLAN_INVALID" });
  }
});

function portReport() {
  return { kind: "tcp_port_observation", scope: "tcp_ipv4_ipv6", observedAt: "2026-10-13T01:00:00Z",
    dynamicRanges: [{ start: 23001, end: 23001 }, { start: 24001, end: 24002 }],
    excludedRanges: [{ start: 23002, end: 23002 }], occupiedPorts: [24002], portsReserved: false, productionReady: false };
}

test("port observations cover every proxy generation and CDP port with explicit conflict reasons", () => {
  const raw = controlInput();
  raw.registrations[0].proxies.push({ ...raw.registrations[0].proxies[0], generation: 2, role: "candidate", listenerPort: 23003 });
  const baseline = compileWfpResourcePlan(raw);
  assert.ok(baseline.preflight.ports.entries.every(entry => entry.status === "not_observed"));
  assert.equal(baseline.preflight.ports.observedAt, null);
  const observation = portReport(); const resources = compileWfpResourcePlan(raw, { portObservation: observation });
  assert.deepEqual(resources.preflight.ports.entries, [
    { port: 23001, status: "conflict_observed", reasons: ["dynamic_range"] },
    { port: 23002, status: "conflict_observed", reasons: ["excluded_range"] },
    { port: 23003, status: "no_conflict_observed", reasons: [] },
    { port: 24001, status: "conflict_observed", reasons: ["dynamic_range"] },
    { port: 24002, status: "conflict_observed", reasons: ["dynamic_range", "occupied"] },
  ]);
  assert.equal(resources.preflight.ports.portsReserved, false);
  assert.equal(resources.preflight.ports.observedAt, observation.observedAt);
  assert.equal(Object.isFrozen(observation), false);
  assert.deepEqual(resources.filters, baseline.filters);
  assert.deepEqual(resources.pendingChecks, baseline.pendingChecks);
  assert.equal(resources.launchAuthorization, "not_issued");
});

test("missing, incomplete and malformed TCP inventories never become conflict-free observations", () => {
  for (const change of [{ kind: "verified" }, { scope: "tcp_ipv4" }, { portsReserved: true }, { observedAt: null },
    { dynamicRanges: [] }, { dynamicRanges: [{ start: 1, end: 65535 }] }, { excludedRanges: undefined },
    { excludedRanges: [{ start: 30000, end: 20000 }] }, { excludedRanges: [{ start: 0, end: 65536 }] },
    { occupiedPorts: undefined }, { occupiedPorts: ["23001"] }, { occupiedPorts: [65536] }]) {
    assert.throws(() => compileWfpResourcePlan(controlInput(), { portObservation: { ...portReport(), ...change } }), { code: "WFP_RESOURCE_PLAN_INVALID" });
  }
  assert.throws(() => compileWfpResourcePlan(controlInput(), { portObservation: true }), { code: "WFP_RESOURCE_PLAN_INVALID" });
});

test("CDP permits only its registered controller and owning Chrome on the precise IPv4 channel", () => {
  const raw = controlInput(); const plan = compileGroupPathPlan(raw); const resources = compileWfpResourcePlan(raw);
  const [a, b] = plan.groups;
  const client = { app: raw.controllers[0].path, user: SID, protocol: 6,
    localAddress: "127.0.0.1", remoteAddress: "127.0.0.1", remotePort: 24001 };
  assert.equal(decision(resources, "AUTH_CONNECT_V4", client), "permit");
  for (const app of [raw.controllers[1].path, a.chromePath, b.chromePath, a.proxies[0].proxyPath, "C:\\Other.exe"]) {
    assert.equal(decision(resources, "AUTH_CONNECT_V4", { ...client, app }), "block");
  }
  for (const changes of [{ remotePort: 24002 }, { user: "S-1-5-21-1-2-3-1002" }, { localAddress: "127.0.0.2" }]) {
    assert.equal(decision(resources, "AUTH_CONNECT_V4", { ...client, ...changes }), "block");
  }
  for (const remoteAddress of ["127.0.0.2", "::1", "::ffff:127.0.0.1"]) {
    assert.equal(decision(resources, `AUTH_CONNECT_V${isIP(remoteAddress)}`, { ...client, remoteAddress }), "block");
  }
  assert.equal(decision(resources, "AUTH_CONNECT_V4", { ...client, remotePort: 23001 }), "block"); // no Agent proxy relay
  assert.equal(decision(resources, "AUTH_CONNECT_V4", { ...client, remotePort: 25001 }), "unmatched");
  assert.equal(decision(resources, "AUTH_CONNECT_V4", { ...client, remoteAddress: "192.0.2.1" }), "unmatched");
  const server = { ...client, app: a.chromePath, localPort: 24001 };
  for (const layer of ["RESOURCE_ASSIGNMENT_V4", "AUTH_LISTEN_V4", "AUTH_RECV_ACCEPT_V4"]) {
    assert.equal(decision(resources, layer, server), "permit");
    for (const changes of [{ app: b.chromePath }, { app: raw.controllers[0].path }, { app: "C:\\Other.exe" },
      { localAddress: "0.0.0.0" }, { localAddress: "127.0.0.2" }, { user: "S-1-5-21-1-2-3-1002" }]) {
      assert.equal(decision(resources, layer, { ...server, ...changes }), "block");
    }
    assert.equal(decision(resources, layer.replace("V4", "V6"), { ...server, localAddress: "::1", remoteAddress: "::1" }), "block");
  }
  assert.equal(decision(resources, "AUTH_RECV_ACCEPT_V4", { ...server, remoteAddress: "192.0.2.3" }), "block");
  assert.equal(decision(resources, "AUTH_CONNECT_V4", { ...client, app: a.chromePath, protocol: 17 }), "block");
  assert.ok(resources.preflight.controllerFiles.every(file => file.status === "not_observed"));
});

test("CDP survives business freeze and has independent per-run cleanup; dynamic session loss denies it", () => {
  const raw = controlInput();
  raw.registrations[0].browserRuns.push({ accountId: "acc_second", runToken: "run-00000000-0000-4000-8000-000000000002", debugPort: 24003 });
  const resources = compileWfpResourcePlan(raw); const a = resources.groups[0];
  const [first, second] = a.controlChannels;
  assert.equal(first.cleanupKeys.dynamic.length, 4); assert.equal(first.cleanupKeys.persistent.length, 9);
  assert.equal(new Set([...first.cleanupKeys.dynamic, ...first.cleanupKeys.persistent, ...a.freezeKeys]).size, 15);
  const client = { app: raw.controllers[0].path, user: SID, protocol: 6, localAddress: "127.0.0.1", remoteAddress: "127.0.0.1", remotePort: first.endpoint.port };
  const frozen = { ...resources, filters: resources.filters.filter(f => !a.freezeKeys.includes(f.key)) };
  assert.equal(decision(frozen, "AUTH_CONNECT_V4", client), "permit");
  const closed = { ...frozen, filters: frozen.filters.filter(f => !first.cleanupKeys.dynamic.includes(f.key)) };
  assert.equal(decision(closed, "AUTH_CONNECT_V4", client), "block");
  assert.equal(decision(closed, "AUTH_CONNECT_V4", { ...client, remotePort: second.endpoint.port }), "permit");
  assert.equal(decision(closed, "AUTH_CONNECT_V4", { ...client, app: raw.controllers[1].path, remotePort: 24002 }), "permit");
  const crashed = { ...resources, filters: resources.filters.filter(f => f.lifetime === "persistent") };
  assert.equal(decision(crashed, "AUTH_CONNECT_V4", client), "block");
  const plan = compileGroupPathPlan(raw);
  assert.equal(decision(crashed, "AUTH_LISTEN_V4", { ...client, app: plan.groups[0].chromePath, localPort: first.endpoint.port }), "block");
  const before = structuredClone(resources);
  raw.registrations.reverse(); raw.controllers.reverse(); raw.registrations.forEach(g => g.browserRuns.reverse());
  const reordered = compileWfpResourcePlan(raw);
  assert.deepEqual(reordered.filters, before.filters); assert.deepEqual(reordered.cleanupKeys, before.cleanupKeys);
  // Same owner/program/port permissions retain stable keys; runToken is bookkeeping, not WFP identity.
  raw.registrations.find(g => g.groupId === "grp_a").browserRuns.find(r => r.accountId === "acc_0").runToken = "run-00000000-0000-4000-8000-000000000003";
  assert.deepEqual(compileWfpResourcePlan(raw).filters, before.filters);
});

test("CDP rules do not change proxy filters and upstream permits cannot override control-port denial", () => {
  const raw = controlInput(); const resources = compileWfpResourcePlan(raw);
  const stripped = structuredClone(raw); delete stripped.controllers; stripped.registrations.forEach(g => { delete g.browserRuns; });
  assert.deepEqual(resources.filters.filter(f => !f.purpose.startsWith("cdp_")), compileWfpResourcePlan(stripped).filters);
  for (const address of ["127.0.0.1", "127.1.2.3", "::1", "::ffff:127.0.0.1"]) {
    const broken = structuredClone(raw); broken.registrations[0].proxies[0].approvedAddress = address;
    broken.registrations[0].proxies[0].raw.port = 24002;
    assert.throws(() => compileWfpResourcePlan(broken), { code: "WFP_RESOURCE_PLAN_INVALID" });
  }
});
