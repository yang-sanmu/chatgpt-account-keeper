import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import YAML from "yaml";
import { parseCustomConfigInput, parseSingleCustomNodeYaml, customNodeKind } from "../src/customProxyConfig.js";
import { createSqliteRuntimeAdapters } from "../src/persistence/runtimeAdapters.js";
import { openKeeperRepository } from "../src/persistence/sqliteRepository.js";
import { configureStoreBackend } from "../src/store.js";
import * as proxies from "../src/proxyManager.js";

async function sqliteFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "keeper-custom-yaml-"));
  const filePath = path.join(root, "keeper.db");
  let database = await openKeeperRepository({ filePath });
  let { proxy: backend } = createSqliteRuntimeAdapters(database);
  backend.writeProxyStore({ nodes: [], subscriptions: [], network: { mode: "direct" } });
  const groups = [];
  const restoreStore = configureStoreBackend({ getGroups: () => groups });
  let restoreProxy = proxies.configureProxyStoreBackend(backend);

  const feeds = new Map();
  const server = http.createServer((request, response) => {
    const feed = feeds.get(new URL(request.url, "http://localhost").pathname);
    if (!feed) return response.writeHead(404).end();
    response.end(YAML.stringify({ proxies: feed }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  t.after(async () => {
    restoreProxy();
    restoreStore();
    database.close();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });

  return {
    groups,
    feeds,
    url: (pathname) => `http://127.0.0.1:${server.address().port}${pathname}`,
    reopen: async () => {
      restoreProxy();
      database.close();
      database = await openKeeperRepository({ filePath });
      ({ proxy: backend } = createSqliteRuntimeAdapters(database));
      restoreProxy = proxies.configureProxyStoreBackend(backend);
      return backend;
    },
    readStore: () => backend.readProxyStore(),
  };
}

test("parses full Clash YAML with VLESS-Reality and Hysteria2 while stripping routing overrides", () => {
  const sample = `
mixed-port: 7890
tun:
  enable: true
proxies:
  - name: "VPS-VLESS-Reality"
    type: vless
    server: 198.51.100.10
    port: 56702
    uuid: 11111111-2222-3333-4444-555555555555
    network: tcp
    udp: true
    packet-encoding: xudp
    flow: xtls-rprx-vision
    tls: true
    servername: aws.amazon.com
    client-fingerprint: chrome
    dialer-proxy: should-be-stripped
    interface-name: eth0
    reality-opts:
      public-key: secret-public-key-value
      short-id: 0123456789abcdef
  - name: "VPS-Hysteria2"
    type: hysteria2
    server: 198.51.100.10
    port: 443
    password: secret-hy2/password+value
    sni: aws.amazon.com
    alpn:
      - h3
    skip-cert-verify: false
    fingerprint: "abcdef0123456789"
proxy-groups:
  - name: "Proxy"
    type: select
    proxies:
      - "VPS-VLESS-Reality"
rules:
  - MATCH,Proxy
`;
  const parsed = parseCustomConfigInput(sample);
  assert.equal(parsed.skipped, 0);
  assert.equal(parsed.nodes.length, 2);

  const [vless, hy2] = parsed.nodes;
  assert.equal(vless.name, "VPS-VLESS-Reality");
  assert.equal(vless.type, "vless");
  assert.equal(vless.port, 56702);
  assert.equal(vless.raw["dialer-proxy"], undefined);
  assert.equal(vless.raw["interface-name"], undefined);
  assert.deepEqual(vless.raw["reality-opts"], {
    "public-key": "secret-public-key-value",
    "short-id": "0123456789abcdef",
  });
  assert.equal(customNodeKind(vless.raw), "yaml");

  assert.equal(hy2.name, "VPS-Hysteria2");
  assert.equal(hy2.type, "hysteria2");
  assert.equal(hy2.raw.password, "secret-hy2/password+value");
  assert.deepEqual(hy2.raw.alpn, ["h3"]);
  assert.equal(hy2.raw["skip-cert-verify"], false);
});

test("parses VLESS-Reality, Hysteria2, Trojan, VMess and Shadowsocks share URIs safely", () => {
  const vmessPayload = Buffer.from(JSON.stringify({
    v: "2",
    ps: "自建VMess",
    add: "vmess.example.test",
    port: "443",
    id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    aid: "0",
    scy: "auto",
    net: "ws",
    host: "cdn.example.test",
    path: "/ws",
    tls: "tls",
    sni: "cdn.example.test",
  })).toString("base64");
  const ssUserInfo = Buffer.from("aes-256-gcm:ss-secret-pass").toString("base64");

  const input = [
    "vless://11111111-2222-3333-4444-555555555555@198.51.100.10:56702?encryption=none&flow=xtls-rprx-vision&security=reality&sni=aws.amazon.com&fp=chrome&pbk=pubKey123&sid=abcd1234&type=tcp&packetEncoding=xudp#%E8%87%AA%E5%BB%BA-VLESS",
    "hy2://secret/with+slash@198.51.100.10:443?sni=aws.amazon.com&alpn=h3&insecure=0&pinSHA256=AA:BB:CC:DD#%E8%87%AA%E5%BB%BA-Hy2",
    "trojan://trojan-pass@trojan.example.test:443?sni=trojan.example.test&type=grpc&serviceName=svc#Trojan",
    `vmess://${vmessPayload}`,
    `ss://${ssUserInfo}@ss.example.test:8388#SS`,
  ].join("\n");

  const parsed = parseCustomConfigInput(input);
  assert.equal(parsed.nodes.length, 5);
  assert.equal(parsed.nodes[0].name, "自建-VLESS");
  assert.equal(parsed.nodes[0].raw["reality-opts"]["public-key"], "pubKey123");
  assert.equal(parsed.nodes[0].raw["packet-encoding"], "xudp");
  assert.equal(parsed.nodes[1].name, "自建-Hy2");
  assert.equal(parsed.nodes[1].raw.password, "secret/with+slash");
  assert.equal(parsed.nodes[1].raw.fingerprint, "aabbccdd");
  assert.equal(parsed.nodes[2].raw["grpc-opts"]["grpc-service-name"], "svc");
  assert.equal(parsed.nodes[3].name, "自建VMess");
  assert.equal(parsed.nodes[3].raw["ws-opts"].path, "/ws");
  assert.equal(parsed.nodes[4].raw.cipher, "aes-256-gcm");

  assert.throws(
    () => parseCustomConfigInput("vless://my-secret-uuid@198.51.100.10:443?security=reality"),
    (error) => error.badRequest && !error.message.includes("my-secret-uuid")
  );
  assert.throws(
    () => parseSingleCustomNodeYaml("type: vless\nserver: 198.51.100.10\nport: 70000\nuuid: secret-uuid", "坏节点"),
    (error) => error.badRequest && !error.message.includes("secret-uuid")
  );
});

test("handles indented YAML snippets, rejects SS plugin links, and routes TLS SOCKS5 to YAML editor", () => {
  const indentedSnippet = [
    "",
    '  - name: "VPS-VLESS-Snippet"',
    "    type: vless",
    "    server: 198.51.100.10",
    "    port: 56702",
    "    uuid: 11111111-2222-3333-4444-555555555555",
    "",
  ].join("\n");
  const parsed = parseCustomConfigInput(indentedSnippet);
  assert.equal(parsed.nodes.length, 1);
  assert.equal(parsed.nodes[0].name, "VPS-VLESS-Snippet");
  assert.equal(parsed.nodes[0].port, 56702);

  const singleIndented = parseSingleCustomNodeYaml("  type: hysteria2\n  server: 198.51.100.10\n  port: 443\n  password: p", "单节点");
  assert.equal(singleIndented.raw.type, "hysteria2");

  const ssWithPlugin = `ss://${Buffer.from("aes-256-gcm:pass").toString("base64")}@ss.example.test:8388?plugin=v2ray-plugin%3Bmode%3Dwebsocket#SSPlugin`;
  assert.throws(() => parseCustomConfigInput(ssWithPlugin), (error) => error.badRequest && /plugin|Clash YAML/.test(error.message));

  assert.equal(customNodeKind({ name: "s", type: "socks5", server: "127.0.0.1", port: 1080 }), "simple");
  assert.equal(customNodeKind({ name: "s", type: "socks5", server: "127.0.0.1", port: 1080, tls: true }), "yaml");
});

test("re-importing an old server does not overwrite a previously edited custom node", async (t) => {
  const { readStore } = await sqliteFixture(t);
  const first = await proxies.saveCustomConfig({
    items: [{ name: "节点A", yaml: "type: http\nserver: a.example.test\nport: 8080\nheaders:\n  X-Test: a" }],
  });
  const [editedId] = first.ids;

  await proxies.saveCustomConfig({
    id: editedId,
    items: [{ name: "已改B", yaml: "type: http\nserver: b.example.test\nport: 9090\nheaders:\n  X-Test: b" }],
  });

  // 重新导入旧的 A：不能覆写已改为 B 的节点，应分配独立新 ID。
  const reimportedA = await proxies.saveCustomConfig({
    items: [{ name: "重新导入A", yaml: "type: http\nserver: a.example.test\nport: 8080\nheaders:\n  X-Test: a" }],
  });
  assert.notEqual(reimportedA.ids[0], editedId);
  const stored = readStore().nodes;
  assert.equal(stored.length, 2);
  assert.equal(stored.find((n) => n.id === editedId).raw.server, "b.example.test");
  assert.equal(stored.find((n) => n.id === reimportedA.ids[0]).raw.server, "a.example.test");

  // 导入当前 B 则按当前连接去重，命中已编辑节点。
  const reimportedB = await proxies.saveCustomConfig({
    items: [{ name: "还是B", yaml: "type: http\nserver: b.example.test\nport: 9090\nheaders:\n  X-Test: b" }],
  });
  assert.equal(reimportedB.ids[0], editedId);
  assert.equal(readStore().nodes.length, 2);

  // 普通 HTTP 表单 / 批量导入重新添加旧 A 也不会覆写已改为 B 的普通节点；且显式 tls: false 与省略 tls 判重一致。
  await proxies.saveCustom({ name: "普通A", protocol: "http", server: "plain-a.example.test", port: 8080, username: "", password: "" });
  const plainId = readStore().nodes.find((n) => n.name === "普通A").id;
  await proxies.saveCustom({ id: plainId, name: "普通改B", protocol: "http", server: "plain-b.example.test", port: 8081, username: "", password: "" });
  await proxies.saveCustom({ name: "再添普通A", protocol: "http", server: "plain-a.example.test", port: 8080, username: "", password: "" });
  await proxies.importCustom("http://plain-a.example.test:8080");
  assert.equal(readStore().nodes.find((n) => n.id === plainId).raw.server, "plain-b.example.test");
  assert.equal(readStore().nodes.filter((n) => n.raw.server === "plain-a.example.test").length, 1);

  const countBeforeTlsFalse = readStore().nodes.length;
  await proxies.saveCustomConfig({
    items: [{ name: "带默认tls", yaml: "type: http\nserver: plain-a.example.test\nport: 8080\ntls: false" }],
  });
  assert.equal(readStore().nodes.length, countBeforeTlsFalse);
});

test("editing a referenced custom YAML node preserves a node imported concurrently during mihomo restart", async (t) => {
  const { groups, readStore } = await sqliteFixture(t);
  t.after(() => proxies.stop());
  if (!proxies.getMihomoInfo().found) return t.skip("本地未找到 mihomo 内核");

  const saved = await proxies.saveCustomConfig({
    items: [{ name: "节点A", yaml: "type: http\nserver: 127.0.0.1\nport: 18082\nheaders:\n  X-Node: a" }],
  });
  const [idA] = saved.ids;
  groups.push({ id: "g-a", name: "组A", proxyId: idA });
  await proxies.ensureRunning();

  const editing = proxies.saveCustomConfig({
    id: idA,
    items: [{ name: "节点A-改", yaml: "type: http\nserver: 127.0.0.1\nport: 18083\nheaders:\n  X-Node: a2" }],
  });
  // 在边车重启期间并发导入节点 C。
  const importedC = await proxies.saveCustomConfig({
    items: [{ name: "并发导入C", yaml: "type: http\nserver: c.example.test\nport: 8080\nheaders:\n  X-Node: c" }],
  });
  await editing;

  const stored = readStore().nodes;
  assert.equal(stored.find((n) => n.id === idA)?.raw.port, 18083);
  assert.equal(stored.find((n) => n.id === importedC.ids[0])?.name, "并发导入C");
});

test("editing a referenced custom YAML node rolls back and keeps mihomo running if the new config fails to start", async (t) => {
  const { groups, readStore } = await sqliteFixture(t);
  t.after(() => proxies.stop());

  const saved = await proxies.saveCustomConfig({
    items: [
      { name: "正常节点A", yaml: "type: http\nserver: 127.0.0.1\nport: 18080\nheaders:\n  X-Node: a" },
      { name: "正常节点B", yaml: "type: http\nserver: 127.0.0.1\nport: 18081\nheaders:\n  X-Node: b" },
    ],
  });
  const [idA, idB] = saved.ids;
  groups.push({ id: "g-a", name: "组A", proxyId: idA }, { id: "g-b", name: "组B", proxyId: idB });

  const mihomo = proxies.getMihomoInfo();
  if (mihomo.found) {
    const started = await proxies.ensureRunning();
    assert.equal(started.running, true);
  }

  // 把正在使用的节点 A 改坏协议名：必须抛错、不落库，且原边车仍恢复运行。
  await assert.rejects(
    proxies.saveCustomConfig({
      id: idA,
      items: [{ name: "改坏的A", yaml: "type: not_a_real_protocol\nserver: 127.0.0.1\nport: 18080" }],
    }),
    (error) => error.code === "PROXY_UNAVAILABLE" && /已保留原配置/.test(error.message)
  );

  const afterNodeA = readStore().nodes.find((n) => n.id === idA);
  assert.equal(afterNodeA.name, "正常节点A");
  assert.equal(afterNodeA.raw.type, "http");
  if (mihomo.found) {
    assert.equal(proxies.status().running, true);
  }
});

test("SQLite persists custom YAML nodes privately and preserves id/portSlot on in-place edit", async (t) => {
  const { groups, readStore, reopen } = await sqliteFixture(t);
  const preview = proxies.previewCustomConfig(`
proxies:
  - name: "VPS-VLESS"
    type: vless
    server: 198.51.100.10
    port: 56702
    uuid: super-secret-uuid
    tls: true
    servername: aws.amazon.com
    reality-opts:
      public-key: super-secret-pbk
      short-id: 1234abcd
  - name: "VPS-Hy2"
    type: hysteria2
    server: 198.51.100.10
    port: 443
    password: super-secret-password
    sni: aws.amazon.com
    alpn: [h3]
`);
  assert.equal(preview.nodes.length, 2);

  const saved = await proxies.saveCustomConfig({
    items: [
      { name: "我的自建 VLESS", yaml: preview.nodes[0].yaml },
      { name: "我的自建 Hy2", yaml: preview.nodes[1].yaml },
    ],
  });
  assert.equal(saved.count, 2);

  const publicNodes = proxies.getNodes();
  assert.equal(publicNodes.length, 2);
  assert.equal(publicNodes[0].name, "我的自建 VLESS");
  assert.equal(publicNodes[0].customKind, "yaml");
  assert.ok(!JSON.stringify(publicNodes).includes("super-secret"));

  const [vlessId] = saved.ids;
  const beforeSlot = readStore().nodes.find((n) => n.id === vlessId).portSlot;
  assert.ok(Number.isInteger(beforeSlot));

  const details = proxies.getCustomConfig(vlessId);
  assert.equal(details.name, "我的自建 VLESS");
  assert.match(details.yaml, /type: vless/);
  assert.throws(() => proxies.getCustom(vlessId), /YAML/);

  await proxies.saveCustomConfig({
    id: vlessId,
    items: [{ name: "我的自建 VLESS 主力", yaml: details.yaml.replace("56702", "56703") }],
  });
  await reopen();
  groups.push({ id: "grp-vps", name: "VPS组", proxyId: vlessId });
  const afterEdit = proxies.getNodes().find((n) => n.id === vlessId);
  assert.equal(afterEdit.name, "我的自建 VLESS 主力");
  assert.equal(afterEdit.port, 56703);
  assert.equal(readStore().nodes.find((n) => n.id === vlessId).portSlot, beforeSlot);
  assert.ok(afterEdit.localPort);
  assert.equal(readStore().nodes.find((n) => n.id === vlessId).raw.port, 56703);
});

test("renaming subscription nodes persists across SQLite reopen and subscription refreshes, and can restore original name", async (t) => {
  const { feeds, url, reopen } = await sqliteFixture(t);
  feeds.set("/sub", [{ name: "美国-VLESS-8", type: "vless", server: "us8.example.test", port: 443, uuid: "u-8" }]);

  const added = await proxies.addSubscriptions([url("/sub")], { names: ["我的FSCloud"] });
  assert.equal(added.results[0].error, undefined);
  assert.equal(proxies.getSubscriptions()[0].name, "我的FSCloud");

  const dupName = await proxies.addSubscriptions([url("/sub2")], { names: ["我的FSCloud"] });
  assert.match(dupName.results[0].error, /别名已存在|无法拉取|404/);

  const [node] = proxies.getNodes();
  assert.equal(node.name, "美国-VLESS-8");
  assert.equal(node.customNamed, undefined);

  await proxies.renameNode(node.id, "美国主力节点");
  await reopen();

  const renamed = proxies.getNodes()[0];
  assert.equal(renamed.name, "美国主力节点");
  assert.equal(renamed.originalName, "美国-VLESS-8");
  assert.equal(renamed.customNamed, true);

  // 上游刷新（同名或改名）后，自定义名称应继续保留且节点 ID 不变。
  feeds.set("/sub", [{ name: "美国-VLESS-8-新", type: "vless", server: "us8.example.test", port: 443, uuid: "u-8" }]);
  const refreshed = await proxies.refreshSubscriptions();
  assert.equal(refreshed.results[0].updated, 1);
  const afterRefresh = proxies.getNodes()[0];
  assert.equal(afterRefresh.id, node.id);
  assert.equal(afterRefresh.name, "美国主力节点");
  assert.equal(afterRefresh.originalName, "美国-VLESS-8-新");
  assert.equal(afterRefresh.customNamed, true);

  // 清空自定义名可恢复上游原名。
  await proxies.renameNode(node.id, null);
  const restored = proxies.getNodes()[0];
  assert.equal(restored.name, "美国-VLESS-8-新");
  assert.equal(restored.customNamed, undefined);
  assert.equal(restored.originalName, undefined);
});
