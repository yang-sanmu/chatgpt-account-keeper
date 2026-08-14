import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { chromium } from "playwright-core";
import {
  checkSession,
  clearSession,
  SESSION_OK,
  SESSION_UNKNOWN,
} from "../src/health.js";

test(
  "真实 Playwright page.evaluate 可完成会话探测并中止挂起请求",
  { timeout: 20_000 },
  async (t) => {
    let mode = "healthy";
    const hangingResponses = new Set();
    const server = http.createServer((req, res) => {
      res.setHeader("Cache-Control", "no-store");
      if (req.url === "/api/auth/session") {
        if (mode === "hang") {
          hangingResponses.add(res);
          res.on("close", () => hangingResponses.delete(res));
          return;
        }
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            user: { email: "real-page@example.com", name: "Real Page" },
            accessToken: "real-page-token",
          })
        );
        return;
      }
      if (req.url === "/backend-api/me") {
        assert.equal(req.headers.authorization, "Bearer real-page-token");
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({ id: "user-real-page", email: "real-page@example.com" })
        );
        return;
      }
      if (req.url === "/review-sw.js") {
        res.setHeader("Content-Type", "application/javascript");
        res.end("self.addEventListener('install', () => self.skipWaiting());");
        return;
      }
      res.setHeader("Content-Type", "text/html");
      res.end("<!doctype html><title>ChatGPT</title><main>ready</main>");
    });

    let browser;
    try {
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      try {
        browser = await chromium.launch({ headless: true });
      } catch (error) {
        if (/Executable doesn't exist|browser.*not found/i.test(String(error))) {
          t.skip(`本机没有 Playwright Chromium：${error.message}`);
          return;
        }
        throw error;
      }

      const page = await browser.newPage();
      const { port } = server.address();
      const baseUrl = `http://127.0.0.1:${port}/`;
      await page.goto(baseUrl, {
        waitUntil: "domcontentloaded",
      });

      await page.evaluate(async () => {
        document.cookie = "review-session=present; path=/";
        localStorage.setItem("review-local", "present");
        sessionStorage.setItem("review-session-storage", "present");
        const cache = await caches.open("review-cache");
        await cache.put("/review-entry", new Response("cached"));
        await new Promise((resolve, reject) => {
          const request = indexedDB.open("review-database", 1);
          request.onupgradeneeded = () =>
            request.result.createObjectStore("items");
          request.onsuccess = () => {
            request.result.close();
            resolve();
          };
          request.onerror = () => reject(request.error);
        });
        await navigator.serviceWorker.register("/review-sw.js");
        await navigator.serviceWorker.ready;
      });
      // 模拟登录/挑战流程已把当前页面重定向到另一个 origin；clearSession
      // 仍必须回到指定目标 origin 清理，而不能盲清 pages()[0] 的当前位置。
      const authUrl = `http://localhost:${port}/`;
      await page.goto(authUrl, {
        waitUntil: "domcontentloaded",
      });
      await page.evaluate(() => {
        localStorage.setItem("review-auth-local", "present");
        sessionStorage.setItem("review-auth-session", "present");
      });
      assert.ok(
        (await page.context().cookies()).some(
          (cookie) => cookie.name === "review-session"
        )
      );
      const cleared = await clearSession(page.context(), {
        url: baseUrl,
        relatedOrigins: [authUrl],
      });
      assert.equal(cleared.ok, true);
      assert.deepEqual(cleared.clearedOrigins, [
        baseUrl.slice(0, -1),
        authUrl.slice(0, -1),
      ]);
      assert.deepEqual(await page.context().cookies(), []);
      await page.goto(authUrl, { waitUntil: "domcontentloaded" });
      assert.deepEqual(
        await page.evaluate(() => ({
          local: localStorage.getItem("review-auth-local"),
          session: sessionStorage.getItem("review-auth-session"),
        })),
        { local: null, session: null }
      );
      await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
      assert.deepEqual(
        await page.evaluate(() => ({
          local: localStorage.getItem("review-local"),
          session: sessionStorage.getItem("review-session-storage"),
        })),
        { local: null, session: null }
      );
      assert.deepEqual(
        await page.evaluate(async () => ({
          caches: await caches.keys(),
          databases: (await indexedDB.databases()).map((item) => item.name),
          serviceWorkers: (
            await navigator.serviceWorker.getRegistrations()
          ).length,
        })),
        { caches: [], databases: [], serviceWorkers: 0 }
      );

      const healthy = await checkSession(page, {
        fetchTimeoutMs: 500,
        retryDelayMs: 10,
        hardTimeoutMs: 2_000,
      });
      assert.equal(healthy.state, SESSION_OK);
      assert.equal(healthy.email, "real-page@example.com");

      mode = "hang";
      const started = Date.now();
      const timedOut = await checkSession(page, {
        fetchTimeoutMs: 60,
        retryDelayMs: 10,
        hardTimeoutMs: 800,
      });
      assert.equal(timedOut.state, SESSION_UNKNOWN);
      assert.ok(Date.now() - started < 700, "挂起 fetch 应由页面内超时主动中止");
    } finally {
      if (browser) await browser.close().catch(() => {});
      for (const response of hangingResponses) response.destroy();
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(() => resolve()));
    }
  }
);
