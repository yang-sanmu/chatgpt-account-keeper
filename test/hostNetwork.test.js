import test from "node:test";
import assert from "node:assert/strict";
import {
  configureHostNetworkDetector,
  evaluateNetworkEnvironment,
  getHostNetworkSnapshot,
  inspectOsNetworkInterfaces,
  isFakeIpAddress,
  isLoopbackHost,
  parseWindowsHostNetworkPayload,
  refreshHostNetworkSnapshot,
} from "../src/network/hostNetwork.js";

test("parseWindowsHostNetworkPayload filters virtual/TUN adapters and detects Clash Verge TUN + fake-ip", () => {
  const payload = {
    adapters: [
      {
        Name: "Mihomo",
        InterfaceDescription: "Meta Tunnel",
        InterfaceIndex: 55,
        InterfaceOperationalStatus: 1,
        HardwareInterface: false,
        Virtual: true,
        MacAddress: "",
      },
      {
        Name: "Tailscale",
        InterfaceDescription: "Tailscale Tunnel",
        InterfaceIndex: 63,
        InterfaceOperationalStatus: 1,
        HardwareInterface: false,
        Virtual: true,
      },
      {
        Name: "vEthernet (WSL (Hyper-V firewall))",
        InterfaceDescription: "Hyper-V Virtual Ethernet Adapter",
        InterfaceIndex: 68,
        InterfaceOperationalStatus: 1,
        HardwareInterface: false,
        Virtual: true,
      },
      {
        Name: "以太网 2",
        InterfaceDescription: "Sangfor SSL VPN CS Support System VNIC",
        InterfaceIndex: 14,
        InterfaceOperationalStatus: 2,
        HardwareInterface: false,
        Virtual: true,
      },
      {
        Name: "WLAN",
        InterfaceDescription: "Intel(R) Wi-Fi 6E AX211 160MHz",
        InterfaceIndex: 11,
        InterfaceOperationalStatus: 1,
        HardwareInterface: true,
        Virtual: false,
      },
      {
        Name: "以太网",
        InterfaceDescription: "Intel(R) Ethernet Connection I219-LM",
        InterfaceIndex: 7,
        InterfaceOperationalStatus: 2,
        HardwareInterface: true,
        Virtual: false,
      },
    ],
    routes: [
      { InterfaceAlias: "Mihomo", InterfaceIndex: 55, DestinationPrefix: "0.0.0.0/0", NextHop: "198.18.0.2", RouteMetric: 0, InterfaceMetric: 0 },
      { InterfaceAlias: "WLAN", InterfaceIndex: 11, DestinationPrefix: "0.0.0.0/0", NextHop: "192.168.4.1", RouteMetric: 0, InterfaceMetric: 35 },
      { InterfaceAlias: "以太网", InterfaceIndex: 7, DestinationPrefix: "0.0.0.0/0", NextHop: "10.0.0.1", RouteMetric: 0, InterfaceMetric: 5 },
    ],
    ips: [
      { InterfaceAlias: "Mihomo", InterfaceIndex: 55, IPAddress: "198.18.0.1", PrefixLength: 30 },
      { InterfaceAlias: "WLAN", InterfaceIndex: 11, IPAddress: "192.168.4.148", PrefixLength: 24 },
      { InterfaceAlias: "以太网", InterfaceIndex: 7, IPAddress: "10.0.0.12", PrefixLength: 24 },
    ],
    dns: [
      { InterfaceAlias: "Mihomo", InterfaceIndex: 55, ServerAddresses: ["198.18.0.2"] },
      { InterfaceAlias: "WLAN", InterfaceIndex: 11, ServerAddresses: ["192.168.4.1"] },
    ],
  };

  const snapshot = parseWindowsHostNetworkPayload(payload);
  assert.equal(snapshot.recommendedInterface, "WLAN");
  assert.deepEqual(snapshot.interfaces.map((item) => item.name), ["WLAN", "以太网"]);
  assert.equal(snapshot.interfaces[0].recommended, true);
  assert.equal(snapshot.interfaces[0].status, "up");
  assert.equal(snapshot.interfaces[0].ipv4, "192.168.4.148");
  assert.equal(snapshot.interfaces[0].gateway, "192.168.4.1");
  assert.equal(snapshot.interfaces[0].metric, 35);
  assert.equal(snapshot.interfaces[1].status, "down");
  assert.equal(snapshot.tunConflict.detected, true);
  assert.equal(snapshot.tunConflict.adapterName, "Mihomo");
  assert.equal(snapshot.tunConflict.description, "Meta Tunnel");
  assert.equal(snapshot.tunConflict.fakeIpDetected, true);
});

test("parseWindowsHostNetworkPayload prefers lower-metric wired Ethernet when both wired and Wi-Fi are up", () => {
  const payload = {
    adapters: [
      { Name: "WLAN", InterfaceDescription: "Wi-Fi 6E", InterfaceIndex: 11, Status: "Up", HardwareInterface: true, Virtual: false },
      { Name: "以太网", InterfaceDescription: "Realtek PCIe GbE", InterfaceIndex: 7, Status: "Up", HardwareInterface: true, Virtual: false },
    ],
    routes: [
      { InterfaceAlias: "WLAN", InterfaceIndex: 11, DestinationPrefix: "0.0.0.0/0", NextHop: "192.168.1.1", RouteMetric: 0, InterfaceMetric: 35 },
      { InterfaceAlias: "以太网", InterfaceIndex: 7, DestinationPrefix: "0.0.0.0/0", NextHop: "192.168.1.1", RouteMetric: 0, InterfaceMetric: 15 },
    ],
    ips: [
      { InterfaceAlias: "WLAN", InterfaceIndex: 11, IPAddress: "192.168.1.101" },
      { InterfaceAlias: "以太网", InterfaceIndex: 7, IPAddress: "192.168.1.100" },
    ],
    dns: [],
  };

  const snapshot = parseWindowsHostNetworkPayload(payload);
  assert.equal(snapshot.recommendedInterface, "以太网");
  assert.equal(snapshot.tunConflict.detected, false);
});

test("parseWindowsHostNetworkPayload ignores stale fake-ip DNS on disconnected virtual adapters", () => {
  const snapshot = parseWindowsHostNetworkPayload({
    adapters: [
      { Name: "Mihomo", InterfaceDescription: "Meta Tunnel", InterfaceIndex: 55, InterfaceOperationalStatus: 2, HardwareInterface: false, Virtual: true },
      { Name: "WLAN", InterfaceDescription: "Wi-Fi 6E", InterfaceIndex: 11, InterfaceOperationalStatus: 1, HardwareInterface: true, Virtual: false },
    ],
    routes: [
      { InterfaceAlias: "WLAN", InterfaceIndex: 11, DestinationPrefix: "0.0.0.0/0", NextHop: "192.168.4.1", RouteMetric: 0, InterfaceMetric: 35 },
    ],
    ips: [
      { InterfaceAlias: "WLAN", InterfaceIndex: 11, IPAddress: "192.168.4.148" },
    ],
    dns: [
      { InterfaceAlias: "Mihomo", InterfaceIndex: 55, ServerAddresses: ["198.18.0.2"] },
      { InterfaceAlias: "WLAN", InterfaceIndex: 11, ServerAddresses: ["192.168.4.1"] },
    ],
  });
  assert.equal(snapshot.tunConflict.detected, false);
  assert.equal(snapshot.tunConflict.fakeIpDetected, false);
  assert.equal(snapshot.recommendedInterface, "WLAN");
});

test("inspectOsNetworkInterfaces detects fake-ip TUN and excludes virtual adapters", () => {
  const snapshot = inspectOsNetworkInterfaces({
    Mihomo: [{ address: "198.18.0.1", family: "IPv4", mac: "00:00:00:00:00:00", internal: false }],
    "vEthernet (WSL)": [{ address: "172.29.32.1", family: "IPv4", mac: "00:15:5d:46:96:9a", internal: false }],
    WLAN: [{ address: "192.168.4.148", family: "IPv4", mac: "e8:bf:e1:f4:05:60", internal: false }],
    Loopback: [{ address: "127.0.0.1", family: "IPv4", mac: "00:00:00:00:00:00", internal: true }],
  });

  assert.equal(snapshot.recommendedInterface, "WLAN");
  assert.deepEqual(snapshot.interfaces.map((item) => item.name), ["WLAN"]);
  assert.equal(snapshot.tunConflict.detected, true);
  assert.equal(snapshot.tunConflict.adapterName, "Mihomo");
  assert.equal(snapshot.tunConflict.fakeIpDetected, true);
});

test("evaluateNetworkEnvironment resolves auto vs manual vs disabled outbound interface and warnings", () => {
  const snapshot = parseWindowsHostNetworkPayload({
    adapters: [
      { Name: "Mihomo", InterfaceDescription: "Meta Tunnel", InterfaceIndex: 55, Status: "Up", HardwareInterface: false, Virtual: true },
      { Name: "WLAN", InterfaceDescription: "Wi-Fi 6E", InterfaceIndex: 11, Status: "Up", HardwareInterface: true, Virtual: false },
      { Name: "以太网", InterfaceDescription: "Intel Ethernet", InterfaceIndex: 7, Status: "Disconnected", HardwareInterface: true, Virtual: false },
    ],
    routes: [
      { InterfaceAlias: "Mihomo", InterfaceIndex: 55, DestinationPrefix: "0.0.0.0/0", NextHop: "198.18.0.2", RouteMetric: 0, InterfaceMetric: 0 },
      { InterfaceAlias: "WLAN", InterfaceIndex: 11, DestinationPrefix: "0.0.0.0/0", NextHop: "192.168.4.1", RouteMetric: 0, InterfaceMetric: 35 },
    ],
    ips: [
      { InterfaceAlias: "Mihomo", InterfaceIndex: 55, IPAddress: "198.18.0.1" },
      { InterfaceAlias: "WLAN", InterfaceIndex: 11, IPAddress: "192.168.4.148" },
    ],
  });

  const auto = evaluateNetworkEnvironment({ mode: "direct", outboundInterface: null }, snapshot);
  assert.equal(auto.effectiveOutboundInterface, "WLAN");
  assert.equal(auto.outboundInterfaceSource, "auto");
  assert.equal(auto.outboundInterfaceWarning, null);

  const optedOut = evaluateNetworkEnvironment({ mode: "direct", outboundInterface: null, autoOutboundInterface: false }, snapshot);
  assert.equal(optedOut.effectiveOutboundInterface, null);
  assert.equal(optedOut.outboundInterfaceSource, "none");
  assert.match(optedOut.outboundInterfaceWarning, /Mihomo/);

  const virtualChoice = evaluateNetworkEnvironment({ mode: "direct", outboundInterface: "Mihomo" }, snapshot);
  assert.equal(virtualChoice.effectiveOutboundInterface, "Mihomo");
  assert.equal(virtualChoice.outboundInterfaceSource, "manual");
  assert.match(virtualChoice.outboundInterfaceWarning, /虚拟\/TUN/);

  const downChoice = evaluateNetworkEnvironment({ mode: "direct", outboundInterface: "以太网" }, snapshot);
  assert.match(downChoice.outboundInterfaceWarning, /未连接/);

  const missingChoice = evaluateNetworkEnvironment({ mode: "direct", outboundInterface: "Wi-Fi" }, snapshot);
  assert.match(missingChoice.outboundInterfaceWarning, /未找到名为「Wi-Fi」/);
});

test("configureHostNetworkDetector overrides sync and async snapshots cleanly", async () => {
  const fixture = inspectOsNetworkInterfaces({
    Ethernet: [{ address: "10.0.0.5", family: "IPv4", mac: "aa:bb:cc:dd:ee:ff", internal: false }],
  });
  const restore = configureHostNetworkDetector(() => fixture);
  try {
    assert.equal(getHostNetworkSnapshot().recommendedInterface, "Ethernet");
    assert.equal((await refreshHostNetworkSnapshot({ force: true })).recommendedInterface, "Ethernet");
    assert.equal(isFakeIpAddress("198.18.0.1"), true);
    assert.equal(isFakeIpAddress("198.19.255.1"), true);
    assert.equal(isFakeIpAddress("192.168.1.1"), false);
    assert.equal(isLoopbackHost("127.0.0.1"), true);
    assert.equal(isLoopbackHost("localhost"), true);
    assert.equal(isLoopbackHost("[::1]"), true);
    assert.equal(isLoopbackHost("example.com"), false);
  } finally {
    restore();
  }
});
