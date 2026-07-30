import test from "node:test";
import assert from "node:assert/strict";
import {
  mergeProxyNodes,
  normalizeProxyNode,
  proxyNodeId,
} from "../src/proxyUtils.js";

test("normalizeProxyNode converts a valid string port to an integer", () => {
  const node = normalizeProxyNode({
    name: "US node",
    type: "anytls",
    server: "proxy.example.com",
    port: "443",
    password: "secret",
  });

  assert.equal(node.port, 443);
  assert.equal(node.server, "proxy.example.com");
  assert.equal(node.password, "secret");
});

test("normalizeProxyNode rejects invalid and HTML-bearing ports", () => {
  assert.equal(
    normalizeProxyNode({
      name: "bad",
      type: "anytls",
      server: "proxy.example.com",
      port: `443</span><img src=x onerror="alert(1)">`,
    }),
    null
  );
  assert.equal(
    normalizeProxyNode({
      name: "too-high",
      type: "anytls",
      server: "proxy.example.com",
      port: 70000,
    }),
    null
  );
});

test("mergeProxyNodes retains only removed nodes still referenced by accounts", () => {
  const referencedId = proxyNodeId("referenced old");
  const unreferencedId = proxyNodeId("unreferenced old");
  const previous = [
    {
      id: referencedId,
      name: "referenced old",
      raw: { name: "referenced old", type: "ss", server: "old.example", port: 443 },
      enabled: true,
      missing: false,
    },
    {
      id: unreferencedId,
      name: "unreferenced old",
      raw: { name: "unreferenced old", type: "ss", server: "old2.example", port: 443 },
      enabled: true,
      missing: false,
    },
  ];

  const nodes = mergeProxyNodes(
    [{ name: "current", type: "ss", server: "new.example", port: 8443 }],
    previous,
    new Set([referencedId])
  );

  assert.equal(nodes.some((node) => node.id === referencedId && node.missing), true);
  assert.equal(nodes.some((node) => node.id === unreferencedId), false);
  assert.equal(nodes.some((node) => node.name === "current" && !node.missing), true);
});
