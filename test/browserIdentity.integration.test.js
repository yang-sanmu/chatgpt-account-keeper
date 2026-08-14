import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import {
  launchForAccount,
  probeHeadlessIdentity,
} from "../src/browser.js";
import { ROOT } from "../src/paths.js";

const HIGH_ENTROPY_HINTS = [
  "architecture",
  "bitness",
  "platformVersion",
  "fullVersionList",
];

test(
  "bundled Chromium 身份探测不访问外网且能移除 HeadlessChrome",
  { timeout: 30_000 },
  async (t) => {
    try {
      const identity = await probeHeadlessIdentity(null);
      assert.doesNotMatch(identity.userAgent, /HeadlessChrome/);
      assert.equal(
        identity.metadata?.brands?.some(
          (item) => item.brand === "HeadlessChrome"
        ),
        false
      );
      assert.equal(
        identity.metadata?.fullVersionList?.some(
          (item) => item.brand === "HeadlessChrome"
        ),
        false
      );
      assert.ok(
        identity.metadata?.brands?.some((item) => item.brand === "Chromium"),
        "降级身份应保留真实 Chromium 品牌"
      );
    } catch (error) {
      if (/Executable doesn't exist|browser.*not found/i.test(String(error))) {
        t.skip(`本机没有 Playwright Chromium：${error.message}`);
        return;
      }
      throw error;
    }
  }
);

async function waitFor(promise, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} 超时`)),
          timeoutMs
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function identityInTarget(target) {
  return target.evaluate(async (hints) => ({
    userAgent: navigator.userAgent,
    metadata: navigator.userAgentData
      ? await navigator.userAgentData.getHighEntropyValues(hints)
      : null,
  }), HIGH_ENTROPY_HINTS);
}

test(
  "Headless 身份覆盖主页面、跨站 iframe、popup、newPage 与 Service Worker",
  // Brand Chrome can take close to a minute to initialize every target type on
  // a contended Windows CI host. The test still performs its own bounded waits.
  { timeout: 120_000 },
  async (t) => {
    const tempPrefix = path.join(path.dirname(ROOT), "gptkeeper-browser-identity-");
    const profileDir = fs.mkdtempSync(tempPrefix);
    const requests = [];
    let resolveServiceWorkerFetch;
    const serviceWorkerFetch = new Promise((resolve) => {
      resolveServiceWorkerFetch = resolve;
    });

    const server = http.createServer((req, res) => {
      requests.push({
        url: req.url,
        userAgent: req.headers["user-agent"] ?? "",
        brands: req.headers["sec-ch-ua"] ?? "",
        fullVersionList:
          req.headers["sec-ch-ua-full-version-list"] ?? "",
        platformVersion:
          req.headers["sec-ch-ua-platform-version"] ?? "",
        architecture: req.headers["sec-ch-ua-arch"] ?? "",
        bitness: req.headers["sec-ch-ua-bitness"] ?? "",
      });
      res.setHeader(
        "Accept-CH",
        [
          "Sec-CH-UA-Full-Version-List",
          "Sec-CH-UA-Platform-Version",
          "Sec-CH-UA-Arch",
          "Sec-CH-UA-Bitness",
        ].join(", ")
      );

      if (req.url === "/sw.js") {
        res.setHeader("Content-Type", "application/javascript");
        res.end(`
          self.addEventListener("install", () => self.skipWaiting());
          self.addEventListener("activate", (event) =>
            event.waitUntil(self.clients.claim())
          );
          self.addEventListener("message", (event) => {
            if (event.data === "probe") {
              event.waitUntil(fetch("/sw-fetch"));
            }
          });
        `);
        return;
      }

      if (req.url === "/main") {
        const { port } = server.address();
        const iframeOrigin = `http://localhost:${port}`;
        res.setHeader("Content-Type", "text/html");
        res.setHeader(
          "Permissions-Policy",
          [
            `ch-ua-full-version-list=(self "${iframeOrigin}")`,
            `ch-ua-platform-version=(self "${iframeOrigin}")`,
            `ch-ua-arch=(self "${iframeOrigin}")`,
            `ch-ua-bitness=(self "${iframeOrigin}")`,
          ].join(", ")
        );
        res.end(`
          <!doctype html>
          <a id="popup" target="_blank" href="/popup">popup</a>
          <iframe id="oopif" src="${iframeOrigin}/iframe"></iframe>
          <script>navigator.serviceWorker.register("/sw.js");</script>
        `);
        return;
      }

      if (req.url === "/sw-fetch") resolveServiceWorkerFetch();
      res.setHeader("Content-Type", "text/html");
      res.end("<!doctype html><title>ok</title>");
    });

    let context = null;
    try {
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      const { port } = server.address();
      const baseUrl = `http://127.0.0.1:${port}`;

      try {
        const launched = await launchForAccount(
          {
            id: "__browser_identity_test__",
            profileDir: path.relative(ROOT, profileDir),
            groupId: null,
          },
          { headless: true }
        );
        context = launched.context;
        const page = launched.page;

        await page.goto(`${baseUrl}/main`, { waitUntil: "domcontentloaded" });
        // 首次响应协商高熵 Client Hints；再加载一次后，后续 Target 的首包
        // 才能稳定携带 Sec-CH-UA-Full-Version-List 等字段。
        await page.reload({ waitUntil: "domcontentloaded" });
        await page.waitForLoadState("load");
        const mainIdentity = await identityInTarget(page);

        const iframeUrl = `http://localhost:${port}/iframe`;
        await page.waitForSelector(`iframe[src="${iframeUrl}"]`);
        const oopif = page.frames().find((frame) => frame.url() === iframeUrl);
        assert.ok(
          oopif,
          `应创建跨站 OOPIF Target，实际 Frame：${page
            .frames()
            .map((frame) => frame.url())
            .join(", ")}`
        );
        const oopifIdentity = await identityInTarget(oopif);
        await oopif.evaluate(() => fetch("/iframe-fetch"));

        const popupPromise = page.waitForEvent("popup");
        await page.click("#popup");
        const popup = await popupPromise;
        await popup.waitForURL(`${baseUrl}/popup`);
        await popup.waitForLoadState("domcontentloaded");
        const popupIdentity = await identityInTarget(popup);
        await popup.evaluate(() => fetch("/popup-fetch"));

        const newPage = await context.newPage();
        await newPage.goto(`${baseUrl}/new-page`, {
          waitUntil: "domcontentloaded",
        });
        const newPageIdentity = await identityInTarget(newPage);
        await newPage.evaluate(() => fetch("/new-page-fetch"));

        await page.evaluate(async () => {
          const registration = await navigator.serviceWorker.ready;
          registration.active.postMessage("probe");
        });
        await waitFor(serviceWorkerFetch, 10_000, "Service Worker 请求");
        const serviceWorker = context.serviceWorkers()[0];
        assert.ok(serviceWorker, "应创建 Service Worker Target");
        const serviceWorkerIdentity = await identityInTarget(serviceWorker);

        for (const [name, identity] of [
          ["main", mainIdentity],
          ["oopif", oopifIdentity],
          ["popup", popupIdentity],
          ["newPage", newPageIdentity],
          ["serviceWorker", serviceWorkerIdentity],
        ]) {
          assert.doesNotMatch(
            identity.userAgent,
            /HeadlessChrome/i,
            `${name} JavaScript UA 不得暴露 HeadlessChrome`
          );
          assert.ok(identity.metadata, `${name} 应保留 UA-CH metadata`);
          assert.deepEqual(
            identity.metadata,
            mainIdentity.metadata,
            `${name} UA-CH 应与主页面完全一致`
          );
        }

        for (const url of [
          "/main",
          "/iframe",
          "/popup",
          "/new-page",
          "/sw.js",
          "/sw-fetch",
        ]) {
          const request = requests.find((candidate) => candidate.url === url);
          assert.ok(request, `服务端应收到 ${url}`);
          assert.doesNotMatch(
            request.userAgent,
            /HeadlessChrome/i,
            `${url} 首个请求不得暴露 HeadlessChrome`
          );
        }

        // 首个 document 请求由 Chrome 在 Target 暂停前发起，启动参数保证其中
        // 不出现 HeadlessChrome；Target 恢复后发出的 API/Worker 请求必须带回
        // 完整高熵 Client Hints，这也是 ChatGPT session 请求实际走的阶段。
        // Service Worker 的 fetch 按 Chrome 原生行为通常不发送 UA-CH，但其
        // legacy UA 与 WorkerNavigator 身份仍已在上面分别验证。
        for (const url of [
          "/iframe-fetch",
          "/popup-fetch",
          "/new-page-fetch",
        ]) {
          const request = requests.find((candidate) => candidate.url === url);
          assert.ok(
            request.fullVersionList,
            `${url} 应发送完整版本列表：${JSON.stringify(request)}`
          );
          assert.ok(
            request.platformVersion,
            `${url} 应发送系统平台版本：${JSON.stringify(request)}`
          );
          assert.ok(
            request.architecture,
            `${url} 应发送 CPU 架构：${JSON.stringify(request)}`
          );
          assert.ok(
            request.bitness,
            `${url} 应发送系统位数：${JSON.stringify(request)}`
          );
        }
      } catch (error) {
        if (/Executable doesn't exist|browser.*not found/i.test(String(error))) {
          t.skip(`本机没有可用的 Chrome/Chromium：${error.message}`);
          return;
        }
        throw error;
      }
    } finally {
      if (context) await context.close().catch(() => {});
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(() => resolve()));
      assert.ok(
        profileDir.startsWith(tempPrefix),
        "只允许删除本测试创建的临时 Profile"
      );
      fs.rmSync(profileDir, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 200,
      });
    }
  }
);
