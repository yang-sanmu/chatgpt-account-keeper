import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { compileGroupPathPlan } from "../src/network/groupPathPlan.js";
import { compileWfpResourcePlan } from "../src/network/wfpResourcePlan.js";

const executable = fileURLToPath(new URL("../tools/network-isolation/bin/Release/net10.0-windows/win-x64/publish/network-isolation-lab.exe", import.meta.url));
const options = { skip: process.platform !== "win32" || !fs.existsSync(executable) ? "Requires published Windows encoding tool" : false };
const SID = "S-1-5-21-1-2-3-1001";
const FIELDS = {
  ALE_APP_ID: "d78e1e87-8644-4ea5-9437-d809ecefc971", ALE_USER_ID: "af043a0a-b34d-4f86-979c-c90371af6e66",
  IP_PROTOCOL: "3971ef2b-623e-4f9a-8cb1-6e79b806b9a7", IP_LOCAL_PORT: "0c1ba1af-5765-453f-af22-a8f791ac775b",
  IP_REMOTE_PORT: "c35a604d-d22b-4e1a-91b4-68f674ee674b", IP_LOCAL_ADDRESS: "d9ee00de-c1ef-4617-bfe3-ffd8f5a08957",
  IP_REMOTE_ADDRESS: "b235ae9a-1d64-49b8-a44c-5ff3d9095045",
};
const LAYERS = {
  AUTH_CONNECT_V4: "c38d57d1-05a7-4c33-904f-7fbceee60e82", AUTH_CONNECT_V6: "4a72393b-319f-44bc-84c3-ba54dcb3b6b4",
  RESOURCE_ASSIGNMENT_V4: "1247d66d-0b60-4a15-8d44-7155d0f53a0c", RESOURCE_ASSIGNMENT_V6: "55a650e1-5f0a-4eca-a653-88f53b26aa8c",
  AUTH_LISTEN_V4: "88bb5dad-76d7-4227-9c71-df0a3ed7be7e", AUTH_LISTEN_V6: "7ac9de24-17dd-4814-b4bd-a9fbc95a321b",
  AUTH_RECV_ACCEPT_V4: "e1cd9fe7-f4b5-4273-96c0-592e487b8650", AUTH_RECV_ACCEPT_V6: "a3b42c97-9f04-4672-b87e-cee9c483257f",
};
function fixture(t, withControl = false) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "keeper-wfp-encoding-"));
  t.after(() => { assert.equal(path.dirname(temporary), os.tmpdir()); fs.rmSync(temporary, { recursive: true, force: true }); });
  const root = fs.realpathSync.native(temporary);
  const raw = { isolationModel: "group_path_v1", installationId: "00000000-0000-4000-8000-000000000001", programRoot: root,
    registrations: ["a", "b"].map((groupId, i) => ({ userSid: SID, dataDirectoryId: "00000000-0000-4000-8000-000000000002", groupId,
      chrome: { version: "1.0.0.0", files: ["chrome.exe", "helper.exe"].map(relativePath => ({ relativePath, sizeBytes: 1, sha256: "a".repeat(64) })) },
      proxies: [{ generation: 1, role: "active", listenerPort: 23001 + i, sha256: "b".repeat(64),
        raw: { type: i ? "hysteria2" : "http", server: "test.example", port: 443, password: "test" },
        approvedAddress: i ? "2001:db8::1" : "192.0.2.1" }] })) };
  if (withControl) {
    raw.controllers = [{ userSid: SID, dataDirectoryId: raw.registrations[0].dataDirectoryId,
      path: path.join(root, "agent", "node.exe"), sha256: "c".repeat(64) }];
    raw.registrations.forEach((group, i) => { group.browserRuns = [{ accountId: `acc_${i}`,
      runToken: `run-00000000-0000-4000-8000-00000000000${i}`, debugPort: 24001 + i }]; });
  }
  const plan = compileGroupPathPlan(raw);
  // App-ID translation uses real temporary files. Nothing executes these bytes.
  for (const group of plan.groups) for (const file of [...group.chrome.executablePaths, ...group.proxies.map(p => p.proxyPath)]) {
    assert.ok(file.startsWith(root + path.sep)); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, "x");
  }
  for (const controller of plan.controllers) {
    assert.ok(controller.path.startsWith(root + path.sep));
    fs.mkdirSync(path.dirname(controller.path), { recursive: true }); fs.writeFileSync(controller.path, "x");
  }
  const resources = compileWfpResourcePlan(raw);
  function run(value = resources) {
    const file = path.join(root, "resources.json"); fs.writeFileSync(file, JSON.stringify(value));
    const result = spawnSync(executable, ["encode-wfp", file], { encoding: "utf8", windowsHide: true, timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
    assert.ifError(result.error); return result;
  }
  return { resources, run };
}

test("native WFP encoding preserves GUIDs, lifecycle and typed conditions without opening an engine", options, t => {
  const { resources, run } = fixture(t); const result = run(); assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.kind, "offline_wfp_encoding"); assert.equal(report.wfpModified, false);
  assert.equal(report.productionReady, false); assert.equal(report.launchAuthorization, "not_issued");
  assert.equal(report.filters.length, resources.filters.length);
  for (const source of resources.filters) {
    const native = report.filters.find(f => f.key === source.key);
    assert.equal(native.layer, LAYERS[source.layer.replace("FWPM_LAYER_ALE_", "")]);
    assert.equal(native.providerKey, resources.provider.key); assert.equal(native.sublayer, resources.sublayer.key);
    assert.equal(native.flags, source.lifetime === "persistent" ? 1 : 0);
    assert.equal(native.action, source.action === "block" ? 0x1001 : 0x1002); assert.equal(native.weight, source.weight);
    assert.equal(native.conditions.length, source.conditions.length);
    for (const c of source.conditions) {
      const decoded = native.conditions.find(v => v.field === FIELDS[c.field.replace("FWPM_CONDITION_", "")]);
      assert.ok(decoded); assert.equal(decoded.match, 0);
      if (c.type === "application_path") {
        assert.equal(decoded.type, 12); assert.match(decoded.value, /^\\device\\/u);
        assert.ok(decoded.value.endsWith(c.value.slice(2)), `${decoded.value} / ${c.value}`);
      } else if (c.type === "local_user_security_descriptor") {
        assert.equal(decoded.type, 14);
        assert.equal(decoded.value, `D:(A;;CC;;;${SID})`); // one allow ACE, access mask 1 = MATCH_FILTER
      } else if (c.type === "FWP_UINT8" || c.type === "FWP_UINT16") {
        assert.equal(decoded.type, c.type === "FWP_UINT8" ? 1 : 2); assert.equal(decoded.value, String(c.value));
      } else if (c.type === "FWP_V4_ADDR_MASK") {
        assert.equal(decoded.type, 256);
        const ip = c.value.address.split(".").map(n => Number(n).toString(16).padStart(2, "0")).join("");
        const mask = (0xffffffffn << BigInt(32 - c.value.prefixLength)) & 0xffffffffn;
        assert.equal(decoded.value, `${ip}/${mask.toString(16).padStart(8, "0")}`);
      } else {
        assert.equal(decoded.type, 257);
        const addressHex = { "::1": "00000000000000000000000000000001", "::ffff:127.0.0.0": "00000000000000000000FFFF7F000000",
          "2001:db8::1": "20010DB8000000000000000000000001" }[c.value.address];
        assert.ok(addressHex); assert.equal(decoded.value, `${addressHex}/${c.value.prefixLength}`);
      }
    }
  }
});

test("native encoder rejects schema, layer, type and address errors instead of emitting partial success", options, t => {
  const { resources, run } = fixture(t);
  const app = draft => draft.filters[0].conditions[0];
  const address = draft => draft.filters.flatMap(f => f.conditions).find(c => c.type === "FWP_V4_ADDR_MASK");
  for (const mutate of [
    draft => { draft.schemaVersion = 2; }, draft => { draft.isolationModel = "shared_chrome"; },
    draft => { draft.filters[0].layer = "UNKNOWN"; }, draft => { draft.filters[0].clearActionRight = true; },
    draft => { draft.filters.push(structuredClone(draft.filters[0])); },
    draft => { app(draft).field = "UNKNOWN"; }, draft => { app(draft).type = "FWP_SID"; },
    draft => { app(draft).match = "FWP_MATCH_NOT_EQUAL"; },
    draft => { address(draft).value.prefixLength = 33; }, draft => { address(draft).value.address = "::1"; },
    draft => { draft.filters.find(f => f.layer.includes("AUTH_LISTEN")).conditions.push({
      field: "FWPM_CONDITION_IP_PROTOCOL", type: "FWP_UINT8", match: "FWP_MATCH_EQUAL", value: 6 }); },
    draft => { draft.filters.flatMap(f => f.conditions).find(c => c.type === "local_user_security_descriptor").value.sid = "not-a-sid"; },
  ]) {
    const broken = structuredClone(resources); mutate(broken); const result = run(broken);
    assert.equal(result.status, 1, result.stdout); assert.equal(result.stdout, ""); assert.ok(result.stderr.trim());
  }
});

test("native encoder accepts CDP client and listener resources while retaining precise ports and user conditions", options, t => {
  const { resources, run } = fixture(t, true); const result = run(); assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout); assert.equal(report.productionReady, false);
  for (const group of resources.groups) for (const channel of group.controlChannels) {
    const keys = [...channel.cleanupKeys.dynamic, ...channel.cleanupKeys.persistent];
    const native = report.filters.filter(filter => keys.includes(filter.key));
    assert.equal(native.length, 13);
    for (const filter of native) {
      const port = filter.conditions.find(c => c.field === FIELDS.IP_LOCAL_PORT || c.field === FIELDS.IP_REMOTE_PORT);
      assert.equal(port.value, String(channel.endpoint.port)); assert.equal(port.type, 2);
      if (filter.action === 0x1002) {
        assert.equal(filter.conditions.find(c => c.field === FIELDS.ALE_USER_ID).value, `D:(A;;CC;;;${SID})`);
      }
    }
    const clientKey = resources.filters.find(filter => keys.includes(filter.key) && filter.purpose === "cdp_client_allow").key;
    const client = native.find(filter => filter.key === clientKey);
    assert.ok(client.conditions.find(c => c.field === FIELDS.ALE_APP_ID).value.endsWith("\\agent\\node.exe"));
    for (const field of [FIELDS.IP_LOCAL_ADDRESS, FIELDS.IP_REMOTE_ADDRESS]) {
      assert.equal(client.conditions.find(c => c.field === field).value, "7f000001/ffffffff");
    }
  }
});
