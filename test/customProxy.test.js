import test from "node:test";
import assert from "node:assert/strict";
import { parseCustomProxies, appendCustomProxies } from "../src/customProxy.js";
import { mergeProxyNodes } from "../src/proxyUtils.js";
import { configureProxyStoreBackend, importCustom, getNodes, getSubscriptionInfo, renameCustom, removeCustom, getCustom, saveCustom } from "../src/proxyManager.js";
import { configureStoreBackend } from "../src/store.js";

test("provider host-first format supports manual protocol and literal backslash separator", () => {
  for (const separator of ["@", "\\@"]) {
    for (const protocol of ["http", "socks5"]) {
      const [node] = parseCustomProxies(`proxy.example.com:3000${separator}user-region-Rand-sid-abc-t-5:p@ss:word`, protocol);
      assert.equal(node.raw.type, protocol);
      assert.equal(node.raw.server, "proxy.example.com");
      assert.equal(node.raw.port, 3000);
      assert.equal(node.raw.username, "user-region-Rand-sid-abc-t-5");
      assert.equal(node.raw.password, "p@ss:word");
    }
  }
  assert.equal(parseCustomProxies("localhost:1080", "socks5")[0].raw.type, "socks5");
  assert.equal(parseCustomProxies("http://localhost:3000", "socks5")[0].raw.type, "http");
  assert.throws(() => parseCustomProxies("localhost:3000@user", "http"));
  assert.throws(() => parseCustomProxies("localhost:3000", "ftp"));
});

test("curl proxy credentials preserve provider usernames and password colons", () => {
  const [node] = parseCustomProxies('curl -x proxy.example.com:3000 -U "user-region-IN-sid-abc:pass:word" ipinfo.io');
  assert.equal(node.raw.type, "http");
  assert.equal(node.raw.port, 3000);
  assert.equal(node.raw.username, "user-region-IN-sid-abc");
  assert.equal(node.raw.password, "pass:word");
  assert.ok(!node.name.includes("user-region"));
  assert.equal(node.raw.name, node.id);
});

test("curl quoted credentials preserve escaped quotes and backslashes", () => {
  const [node] = parseCustomProxies(String.raw`curl -x localhost:3000 -U "user:pa\"ss\\word" example.com`);
  assert.equal(node.raw.password, 'pa"ss\\word');
  const [literal] = parseCustomProxies(String.raw`curl -x localhost:3000 -U 'user:pa\ss"word' example.com`);
  assert.equal(literal.raw.password, 'pa\\ss"word');
});

test("host-first format rejects paths, fragments and empty usernames instead of changing their meaning", () => {
  for (const input of [
    "localhost:3000/#label@user:password",
    "localhost:3000/a/..@user:password",
    "localhost:3000\\@:",
    "localhost:3000\t@user:password",
  ]) assert.throws(() => parseCustomProxies(input), { badRequest: true });
  assert.equal(parseCustomProxies("localhost:3000@user:p/#?@ss")[0].raw.password, "p/#?@ss");
});

test("URL import supports encoded credentials, HTTPS, SOCKS5, IPv6 and default ports", () => {
  const nodes = parseCustomProxies('https://u:p%40ss@proxy.example.com:443#Office\nsocks5://u:p%3Ass@[::1]:1080\nhttp://localhost:80');
  assert.equal(nodes[0].raw.tls, true);
  assert.equal(nodes[0].raw.port, 443);
  assert.equal(nodes[0].raw.password, "p@ss");
  assert.equal(nodes[0].name, "Office");
  assert.equal(nodes[1].raw.type, "socks5");
  assert.equal(nodes[1].raw.server, "::1");
  assert.equal(nodes[1].raw.password, "p:ss");
  assert.equal(nodes[2].raw.port, 80);
  assert.equal(nodes[2].raw.username, undefined);
});

test("curl long options and SOCKS5 variants match URL imports", () => {
  const [node] = parseCustomProxies("curl.exe --socks5-hostname localhost:1080 --proxy-user='u:p' https://example.com");
  assert.equal(node.id, parseCustomProxies("socks5h://u:p@localhost:1080")[0].id);
  assert.equal(parseCustomProxies('curl --proxy=http://localhost:3000 --proxy-user=u:p example.com')[0].raw.password, "p");
  assert.equal(parseCustomProxies('curl -x localhost:3000 -U "u:p" example.com', "socks5")[0].raw.type, "socks5");
  assert.equal(parseCustomProxies('curl -x http://localhost:3000 -U "u:p" example.com', "socks5")[0].raw.type, "http");
});

test("reject malformed input atomically without exposing credentials", () => {
  for (const input of ["", "http://u:secret@localhost", "http://u:secret@localhost:0", "socks5://u:secret@localhost:65536", "ftp://u:secret@localhost:21", "http://u:secret@localhost:80/path", 'curl -x localhost:80 -U "u:secret', "curl -x localhost:80 --output secret", "http://u:%ZZsecret@localhost:80", "http://localhost:80\nbad-secret"]) {
    assert.throws(() => parseCustomProxies(input), (error) => error.badRequest && !error.message.includes("secret"));
  }
});

test("custom nodes deduplicate, retain disabled state and survive subscription replacement", () => {
  const custom = parseCustomProxies("http://u:p@localhost:3000");
  custom[0].enabled = false;
  const sameEndpointDifferentAccount = parseCustomProxies("http://another:p@localhost:3000");
  const nodes = appendCustomProxies(custom, [...parseCustomProxies("http://u:p@localhost:3000"), ...sameEndpointDifferentAccount]);
  assert.equal(nodes.length, 2);
  assert.equal(nodes[0].enabled, false);
  const refreshed = mergeProxyNodes([{ name: "subscription", type: "http", server: "localhost", port: 8000 }], nodes, new Set());
  assert.deepEqual(refreshed.slice(1), nodes);
  assert.equal(refreshed[1].missing, false);
});

test("manager persists secrets privately, preserves subscription and does not partially import", async () => {
  let stored = { subscription: { url: "https://example.com/sub" }, nodes: [] };
  const restore = configureProxyStoreBackend({ readProxyStore: () => structuredClone(stored), writeProxyStore: (value) => { stored = structuredClone(value); } });
  try {
    await importCustom("socks5://private-user:private-password@localhost:1080");
    assert.equal(stored.subscription.url, "https://example.com/sub");
    assert.equal(stored.nodes[0].raw.password, "private-password");
    assert.equal(getSubscriptionInfo().count, 0);
    const safe = JSON.stringify(getNodes());
    assert.ok(!safe.includes("private-user"));
    assert.ok(!safe.includes("private-password"));
    await assert.rejects(importCustom("http://localhost:3000\ninvalid"));
    assert.equal(stored.nodes.length, 1);
    await importCustom("socks5://private-user:private-password@localhost:1080");
    assert.equal(stored.nodes.length, 1);
  } finally {
    restore();
  }
});

test("custom names survive reimport; deleting unused nodes preserves routed ports and rejects referenced nodes", async () => {
  const nodes = parseCustomProxies("localhost:3000@u:p\nlocalhost:3001@u:p");
  let stored = { nodes, subscription: null };
  const restoreStore = configureStoreBackend({ getGroups: () => [{ id: "g", proxyId: nodes[1].id }] });
  const restore = configureProxyStoreBackend({ readProxyStore: () => structuredClone(stored), writeProxyStore: value => { stored = structuredClone(value); } });
  try {
    const before = getNodes()[1].localPort;
    assert.ok(before);
    await renameCustom(nodes[1].id, "印度出口");
    await importCustom("localhost:3001@u:p");
    assert.equal(getNodes()[1].name, "印度出口");
    assert.equal(stored.nodes[1].raw.name, nodes[1].raw.name);
    await assert.rejects(removeCustom(nodes[1].id), /分组/);
    await assert.rejects(renameCustom(nodes[1].id, "  "));
    await assert.rejects(removeCustom("px_subscription"));
    await removeCustom(nodes[0].id);
    assert.equal(getNodes().length, 1);
    assert.equal(getNodes()[0].localPort, before);
    await importCustom("localhost:3002@u:p");
    assert.equal(getNodes()[0].localPort, before);
  } finally { restore(); restoreStore(); }
});

test("form edits preserve id and enabled state while replacing connection details and can clear authentication", async () => {
  let stored = { nodes: [], subscription: null };
  const restoreStore = configureStoreBackend({ getGroups: () => [] });
  const restore = configureProxyStoreBackend({ readProxyStore: () => structuredClone(stored), writeProxyStore: value => { stored = structuredClone(value); } });
  try {
    await saveCustom({ name: "新节点", protocol: "http", server: "localhost", port: 3000, username: "u", password: "p" });
    const id = stored.nodes[0].id;
    stored.nodes[0].enabled = false;
    await saveCustom({ id, name: "修改节点", protocol: "socks5", server: "::1", port: 1080, username: "u:@", password: "p/@:#" });
    assert.equal(stored.nodes.length, 1);
    assert.equal(stored.nodes[0].id, id);
    assert.equal(stored.nodes[0].raw.name, id);
    assert.equal(stored.nodes[0].enabled, false);
    assert.deepEqual(getCustom(id), { id, name: "修改节点", protocol: "socks5", server: "::1", port: 1080, username: "u:@", password: "p/@:#" });
    assert.ok(!JSON.stringify(getNodes()).includes("p/@:#"));
    await saveCustom({ ...getCustom(id), username: "", password: "" });
    assert.equal(stored.nodes[0].raw.username, undefined);
    const before = structuredClone(stored);
    for (const patch of [{ port: 0 }, { server: "host:3000" }, { password: "no-user" }, { id: "px_subscription" }]) {
      await assert.rejects(saveCustom({ ...getCustom(id), ...patch }));
      assert.deepEqual(stored, before);
    }
  } finally { restore(); restoreStore(); }
});
