import test from "node:test";
import assert from "node:assert/strict";
import { buildStrictProxyConfig, normalizeStrictUpstream, newProxyCredentials,
  strictBrowserArguments, getStrictNetworkCapabilities } from "../src/network/strictConfig.js";

test("strict compiler pins the endpoint and preserves the original TLS and WS identity", () => {
  const raw = { name: "source", type: "vmess", server: "node.example", port: 443, uuid: "test",
    tls: true, network: "ws", "ws-opts": { path: "/tunnel" } };
  const { upstream, endpoint } = normalizeStrictUpstream(raw, "192.0.2.10");
  assert.equal(upstream.name, "upstream");
  assert.equal(upstream.server, "192.0.2.10");
  assert.equal(upstream.servername, "node.example");
  assert.equal(upstream["ws-opts"].headers.Host, "node.example");
  assert.equal(raw["ws-opts"].headers, undefined);
  assert.deepEqual(endpoint, { address: "192.0.2.10", port: 443, protocol: "tcp" });
});

for (const type of ["http", "socks5", "anytls", "hysteria2", "tuic", "vmess", "vless"]) {
  test(`strict compiler: ${type} declares its actual transport protocol`, () => {
    const result = normalizeStrictUpstream({ type, server: "node.example", port: 443 }, "2001:db8::2");
    assert.equal(result.endpoint.protocol, ["hysteria2", "tuic"].includes(type) ? "udp" : "tcp");
    assert.equal(result.upstream.udp, false);
  });
}

test("strict compiler rejects alternate paths rather than passing arbitrary subscription fields", () => {
  for (const extra of [{ "dialer-proxy": "another" }, { ports: "1000-9000" }, { plugin: "external" },
    { "interface-name": "Ethernet" }, { network: "xhttp" }, { network: "ws", "ws-opts": { "download-settings": {} } },
    { network: "ws", "ws-opts": { headers: "not-an-object" } },
    { network: "ws", "ws-opts": { headers: { Host: "valid\r\ninjected: yes" } } }, { servername: 123 }]) {
    assert.throws(() => normalizeStrictUpstream({ type: "vless", server: "node.example", port: 443, ...extra }, "192.0.2.1"),
      { code: "STRICT_CONFIG_UNSUPPORTED" });
  }
});

test("strict config has mandatory authentication, selected listener, proxied DNS and rejecting fallback", () => {
  const credentials = newProxyCredentials();
  const { config } = buildStrictProxyConfig({ raw: { type: "http", server: "node.example", port: 443, tls: true },
    approvedAddress: "192.0.2.1", listenerPort: 23001, credentials });
  assert.deepEqual(config.listeners[0].users, [credentials]);
  assert.equal(config.listeners[0].proxy, "upstream");
  assert.equal(config.proxies[0].sni, "node.example");
  assert.deepEqual(config.rules, ["MATCH,REJECT"]);
  assert.deepEqual(config.dns.nameserver, ["https://1.1.1.1/dns-query#upstream"]);
  assert.deepEqual(config.dns.fallback, []);
  assert.equal(config["external-controller"], undefined);
  assert.notDeepEqual(newProxyCredentials(), credentials);
  assert.throws(() => buildStrictProxyConfig({ raw: { type: "http", server: "n", port: 1 }, approvedAddress: "192.0.2.1",
    listenerPort: 23001, credentials: { username: "", password: "" } }), { code: "STRICT_CONFIG_UNSUPPORTED" });
});

test("browser policy includes no payment or arbitrary loopback bypass and readiness remains gated", () => {
  const args = strictBrowserArguments(23001);
  assert.ok(args.includes("--proxy-bypass-list=<-loopback>"));
  assert.ok(args.some((item) => item.startsWith("--host-resolver-rules=")));
  assert.equal(args.some((item) => item.includes("alipay")), false);
  assert.equal(getStrictNetworkCapabilities().available, false);
});
