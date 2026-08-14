import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * 边车启动的就绪判定。
 *
 * 真实故障：某账号登录报 ERR_PROXY_CONNECTION_FAILED，重试一次又好了，同一时间
 * 别的账号完全正常。原因是 ensureRunning 只等 `cfg.listeners[0]` 一个端口就返回
 * "启动成功"，而 mihomo 还在逐个绑定其余入站端口 —— 用到后面端口的账号（例如 9 个
 * 节点里的第 4 个）就撞在这个窗口里。
 *
 * 伪造 mihomo 可执行文件不现实（spawn 参数固定为 mihomo 的 CLI 形式），所以这里
 * 直接验证就绪判定本身：一批端口逐个延迟就绪时，判定必须等到最后一个。
 */

const { waitAllPortsReady } = await import("../src/proxyManager.js");

function listenLater(port, delayMs, servers) {
  return new Promise((resolve) => {
    setTimeout(() => {
      const server = net.createServer();
      server.once("error", () => resolve(false));
      server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
        servers.push(server);
        resolve(true);
      });
    }, delayMs);
  });
}

function canConnect(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("error", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

async function freePorts(count) {
  const probes = [];
  const ports = [];
  for (let index = 0; index < count; index++) {
    const server = net.createServer();
    await new Promise((resolve) => server.listen({ host: "127.0.0.1", port: 0 }, resolve));
    ports.push(server.address().port);
    probes.push(server);
  }
  await Promise.all(probes.map((server) => new Promise((resolve) => server.close(resolve))));
  return ports;
}

test("就绪判定必须等到最后一个入站端口可连接", async (t) => {
  const ports = await freePorts(3);
  const servers = [];
  t.after(async () => {
    for (const server of servers) await new Promise((resolve) => server.close(resolve));
  });

  // 第一个端口先监听好（就像 mihomo 已绑定第一个），后两个晚一些才绑定。
  await listenLater(ports[0], 0, servers);
  const opened = [
    listenLater(ports[1], 250, servers),
    listenLater(ports[2], 500, servers),
  ];

  const started = Date.now();
  const result = await waitAllPortsReady(ports, { timeoutMs: 5000 });
  const elapsed = Date.now() - started;
  await Promise.all(opened);

  assert.equal(result.ok, true, `应全部就绪，实际：${JSON.stringify(result)}`);
  // 只等第一个端口的旧行为会立刻返回（第一个端口早已就绪）。
  assert.ok(elapsed >= 450, `必须等到最后一个端口（实际 ${elapsed}ms）`);
  // 返回时三个端口都必须真的可连接。
  for (const port of ports) {
    assert.equal(await canConnect(port), true, `端口 ${port} 应已就绪`);
  }
});

test("任一端口始终不就绪时报告具体是哪个端口", async (t) => {
  const ports = await freePorts(2);
  const servers = [];
  t.after(async () => {
    for (const server of servers) await new Promise((resolve) => server.close(resolve));
  });
  await listenLater(ports[0], 0, servers);
  // ports[1] 永不监听。

  const result = await waitAllPortsReady(ports, { timeoutMs: 600 });
  assert.equal(result.ok, false);
  assert.equal(result.port, ports[1], "必须指出未就绪的具体端口，便于定位");
});

test("进程已退出时立刻放弃等待，不把别人占用的同号端口当成自己就绪", async (t) => {
  const ports = await freePorts(1);
  const servers = [];
  t.after(async () => {
    for (const server of servers) await new Promise((resolve) => server.close(resolve));
  });
  // 别的程序占着这个端口：连得上，但不是我们的进程。
  await listenLater(ports[0], 0, servers);

  const result = await waitAllPortsReady(ports, {
    timeoutMs: 2000,
    shouldStop: () => true, // 我们自己的进程已经退出
  });
  assert.equal(result.ok, false, "进程已退出就不能报告就绪");
});

test("单例 profileManager 的根接线可被断言（回归护栏）", () => {
  // 这个文件顺带守住另一条同源约束：workspaceRoot 必须与 profilesRoot 同根。
  const source = fs.readFileSync(
    path.join(path.resolve(import.meta.dirname, ".."), "src", "profileManager.js"),
    "utf8"
  );
  assert.ok(
    source.includes('workspaceRoot: fromRoot(".")'),
    "单例必须以数据根为 workspaceRoot，否则安装布局下所有 Profile 操作都会失败"
  );
  assert.equal(os.type().length > 0, true);
});
