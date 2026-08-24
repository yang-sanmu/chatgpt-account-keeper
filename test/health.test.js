import test from "node:test";
import assert from "node:assert/strict";
import {
  checkSession,
  clearSession,
  SESSION_OK,
  SESSION_OUT,
  SESSION_REAUTH,
  SESSION_UNKNOWN,
} from "../src/health.js";

function pageReturning(probe) {
  return { evaluate: async () => probe };
}

function pageRunningProbe({ session, me, loggedOut = false }) {
  let expectedAccessToken = "test-token";
  try {
    const parsed = JSON.parse(session.body);
    if (typeof parsed?.accessToken === "string") {
      expectedAccessToken = parsed.accessToken;
    }
  } catch {}
  return {
    evaluate: async (probeFn, options) => {
      const hadDocument = Object.hasOwn(globalThis, "document");
      const previousDocument = globalThis.document;
      const previousFetch = globalThis.fetch;
      globalThis.document = {
        title: "ChatGPT",
        body: { innerText: "" },
        querySelector: () => null,
        querySelectorAll: (selector) => loggedOut && /modal-no-auth-login|login-button/.test(selector)
          ? [{ hidden: false, getAttribute: () => null }]
          : [],
      };
      globalThis.fetch = async (url, options = {}) => {
        if (url === "/api/auth/session") {
          return new Response(session.body, {
            status: session.status ?? 200,
            headers: { "content-type": session.contentType ?? "application/json" },
          });
        }
        if (url === "/backend-api/me") {
          assert.equal(
            options.headers.authorization,
            `Bearer ${expectedAccessToken}`
          );
          return new Response(me.body, {
            status: me.status ?? 200,
            headers: { "content-type": me.contentType ?? "application/json" },
          });
        }
        throw new Error(`unexpected URL: ${url}`);
      };
      try {
        return await probeFn(options);
      } finally {
        if (hadDocument) globalThis.document = previousDocument;
        else delete globalThis.document;
        globalThis.fetch = previousFetch;
      }
    },
  };
}

const healthySession = JSON.stringify({
  user: { email: "person@example.com", name: "Person" },
  accessToken: "test-token",
});

function storageClearingPage(initialUrl = "about:blank") {
  let currentUrl = initialUrl;
  return {
    isClosed: () => false,
    url: () => currentUrl,
    route: async () => {},
    unroute: async () => {},
    goto: async (url) => {
      currentUrl = url;
    },
    evaluate: async () => ({
      origin: new URL(currentUrl).origin,
      local: true,
      session: true,
    }),
  };
}

test("合法 session JSON 明确没有用户时才判定未登录", async () => {
  const result = await checkSession(
    pageReturning({
      sessionOk: true,
      sessionAttempts: 3,
      sessionJsonCount: 3,
      sessionEmptyCount: 3,
      sessionStatus: 200,
      email: null,
      name: null,
      hasToken: false,
    })
  );
  assert.equal(result.state, SESSION_OUT);
});

test("验证页拦截 session 接口时保持待确认而非误判未登录", async () => {
  const result = await checkSession(
    pageReturning({
      sessionOk: false,
      sessionAttempts: 3,
      sessionJsonCount: 0,
      sessionStatus: 200,
      notJson: "<html>Just a moment...</html>",
      email: null,
      name: null,
      hasToken: false,
    })
  );
  assert.equal(result.state, SESSION_UNKNOWN);
  assert.match(result.detail, /验证页/);
});

test("游客页有输入框但显示登录入口时明确判定未登录", async () => {
  const result = await checkSession(
    pageRunningProbe({
      session: { body: '{"message":"Sign in to continue"}' },
      me: { body: "{}" },
      loggedOut: true,
    }),
    { retryDelayMs: 0, fetchTimeoutMs: 50, hardTimeoutMs: 500 }
  );

  assert.equal(result.state, SESSION_OUT);
  assert.match(result.detail, /未登录/);
});

test("已有会话身份但页面弹出登录窗口时判定需要重新登录", async () => {
  const result = await checkSession(
    pageReturning({
      loggedOutPage: true,
      challengePage: false,
      email: "person@example.com",
      name: "Person",
      hasToken: true,
      meStatus: 503,
    })
  );

  assert.equal(result.state, SESSION_REAUTH);
  assert.match(result.detail, /重新登录/);
});

test("挑战页即使返回空 session JSON 也不能判定未登录", async () => {
  const result = await checkSession(
    pageReturning({
      challengePage: true,
      loggedOutPage: true,
      sessionOk: true,
      sessionAttempts: 3,
      sessionJsonCount: 3,
      sessionStatus: 200,
      email: null,
      name: null,
      hasToken: false,
    })
  );
  assert.equal(result.state, SESSION_UNKNOWN);
  assert.match(result.detail, /人机验证/);
});

test("session 检查结果不一致时保持待确认", async () => {
  const result = await checkSession(
    pageReturning({
      challengePage: false,
      sessionOk: true,
      sessionAttempts: 3,
      sessionJsonCount: 1,
      sessionStatus: 503,
      email: null,
      name: null,
      hasToken: false,
    })
  );
  assert.equal(result.state, SESSION_UNKNOWN);
});

test("页面或浏览器临时失败时保持待确认", async () => {
  const result = await checkSession({
    evaluate: async () => {
      throw new Error("Target page has been closed");
    },
  });
  assert.equal(result.state, SESSION_UNKNOWN);
});

test("session 和鉴权接口均成功时判定已登录", async () => {
  const result = await checkSession(
    pageReturning({
      sessionOk: true,
      sessionStatus: 200,
      email: "person@example.com",
      name: "Person",
      hasToken: true,
      meStatus: 200,
      meValidUser: true,
    })
  );
  assert.equal(result.state, SESSION_OK);
  assert.equal(result.email, "person@example.com");
});

test("session 有邮箱但暂缺 accessToken 时保持待确认", async () => {
  const result = await checkSession(
    pageReturning({
      email: "person@example.com",
      name: "Person",
      hasToken: false,
    })
  );
  assert.equal(result.state, SESSION_UNKNOWN);
  assert.match(result.detail, /accessToken/);
});

test("200 但不是有效用户 JSON 时不得误报已登录", async () => {
  for (const probe of [
    { meParseOk: false, meValidUser: false },
    { meParseOk: true, meValidUser: false },
  ]) {
    const result = await checkSession(
      pageReturning({
        email: "person@example.com",
        name: "Person",
        hasToken: true,
        meStatus: 200,
        ...probe,
      })
    );
    assert.equal(result.state, SESSION_UNKNOWN);
    assert.match(result.detail, /用户信息/);
  }
});

test("Cloudflare/WAF 403 不得被当作令牌失效", async () => {
  const result = await checkSession(
    pageReturning({
      email: "person@example.com",
      name: "Person",
      hasToken: true,
      meStatus: 403,
      meTokenInvalid: false,
    })
  );
  assert.equal(result.state, SESSION_UNKNOWN);
});

test("只有 401 且明确 token-invalid 时才要求重新登录", async () => {
  const invalid = await checkSession(
    pageReturning({
      email: "person@example.com",
      name: "Person",
      hasToken: true,
      meStatus: 401,
      meTokenInvalid: true,
    })
  );
  assert.equal(invalid.state, SESSION_REAUTH);

  const ambiguous = await checkSession(
    pageReturning({
      email: "person@example.com",
      name: "Person",
      hasToken: true,
      meStatus: 401,
      meTokenInvalid: false,
    })
  );
  assert.equal(ambiguous.state, SESSION_UNKNOWN);
});

test("页面探测器只接受邮箱一致且含 id 的真实用户 JSON", async () => {
  for (const body of [
    JSON.stringify({ id: "user-1", email: "PERSON@example.com" }),
    JSON.stringify({ id: "user-2", email: "person@example.com" }),
  ]) {
    const result = await checkSession(
      pageRunningProbe({
        session: { body: healthySession },
        me: { body },
      })
    );
    assert.equal(result.state, SESSION_OK);
  }

  for (const body of [
    "<!doctype html><title>Just a moment</title>",
    "{}",
    JSON.stringify({ id: "user-1", email: "other@example.com" }),
    JSON.stringify({ email: "person@example.com" }),
    JSON.stringify({ user: { id: "user-1", email: "person@example.com" } }),
  ]) {
    const result = await checkSession(
      pageRunningProbe({
        session: { body: healthySession },
        me: { body },
      })
    );
    assert.equal(result.state, SESSION_UNKNOWN);
  }
});

test("页面探测器只有明确的 401 token-invalid 才要求重登", async () => {
  const invalidText =
    "Your authentication token has been invalidated. Please try signing in again.";
  const invalid = await checkSession(
    pageRunningProbe({
      session: { body: healthySession },
      me: { status: 401, body: invalidText, contentType: "text/plain" },
    })
  );
  assert.equal(invalid.state, SESSION_REAUTH);

  const blocked = await checkSession(
    pageRunningProbe({
      session: { body: healthySession },
      me: { status: 403, body: invalidText, contentType: "text/html" },
    })
  );
  assert.equal(blocked.state, SESSION_UNKNOWN);
});

test("session JSON 只有明确的空对象或 user/token 结构才算有效响应", async () => {
  for (const body of ["{}", '{"user":null}', '{"accessToken":null}']) {
    const result = await checkSession(
      pageRunningProbe({
        session: { body },
        me: { body: "{}" },
      }),
      { retryDelayMs: 0, fetchTimeoutMs: 50, hardTimeoutMs: 500 }
    );
    assert.equal(result.state, SESSION_OUT, body);
  }

  for (const body of [
    "null",
    "[]",
    '"text"',
    "1",
    "true",
    '{"error":"temporarily unavailable"}',
    '{"message":"Just a moment"}',
    '{"expires":"2099-01-01"}',
    '{"user":[]}',
    '{"accessToken":{}}',
  ]) {
    const result = await checkSession(
      pageRunningProbe({
        session: { body },
        me: { body: "{}" },
      }),
      { retryDelayMs: 0, fetchTimeoutMs: 50, hardTimeoutMs: 500 }
    );
    assert.equal(result.state, SESSION_UNKNOWN, body);
    assert.match(result.detail, /非会话 JSON/);
  }
});

test("无邮箱但有 token 或非空 user 证据时保持待确认而非判退出", async () => {
  for (const body of [
    '{"accessToken":"valid-token"}',
    '{"user":{},"accessToken":"valid-token"}',
    '{"user":{"name":"Person"}}',
  ]) {
    const result = await checkSession(
      pageRunningProbe({
        session: { body },
        me: { body: "{}" },
      }),
      { retryDelayMs: 0, fetchTimeoutMs: 50, hardTimeoutMs: 500 }
    );
    assert.equal(result.state, SESSION_UNKNOWN, body);
    assert.match(result.detail, /不完整/);
  }
});

test("session 重试结束后重新识别刚出现的挑战页", async () => {
  const page = {
    evaluate: async (probeFn, options) => {
      const hadDocument = Object.hasOwn(globalThis, "document");
      const previousDocument = globalThis.document;
      const previousFetch = globalThis.fetch;
      let attempts = 0;
      globalThis.document = {
        title: "ChatGPT",
        body: { innerText: "" },
        querySelector: () => null,
      };
      globalThis.fetch = async () => {
        attempts++;
        if (attempts === 3) globalThis.document.title = "Just a moment...";
        return new Response("{}", { status: 200 });
      };
      try {
        return await probeFn(options);
      } finally {
        if (hadDocument) globalThis.document = previousDocument;
        else delete globalThis.document;
        globalThis.fetch = previousFetch;
      }
    },
  };

  const result = await checkSession(page, {
    retryDelayMs: 0,
    fetchTimeoutMs: 50,
    hardTimeoutMs: 500,
  });
  assert.equal(result.state, SESSION_UNKNOWN);
  assert.match(result.detail, /人机验证/);
});

test("session 与 me 请求都会被 AbortController 截止", async () => {
  const makePage = (hangUrl) => ({
    evaluate: async (probeFn, options) => {
      const hadDocument = Object.hasOwn(globalThis, "document");
      const previousDocument = globalThis.document;
      const previousFetch = globalThis.fetch;
      globalThis.document = {
        title: "ChatGPT",
        body: { innerText: "" },
        querySelector: () => null,
      };
      globalThis.fetch = async (url, init = {}) => {
        if (url !== hangUrl) {
          return new Response(healthySession, { status: 200 });
        }
        return new Promise((_, reject) => {
          init.signal.addEventListener(
            "abort",
            () => reject(new Error(`aborted ${url}`)),
            { once: true }
          );
        });
      };
      try {
        return await probeFn(options);
      } finally {
        if (hadDocument) globalThis.document = previousDocument;
        else delete globalThis.document;
        globalThis.fetch = previousFetch;
      }
    },
  });

  for (const url of ["/api/auth/session", "/backend-api/me"]) {
    const started = Date.now();
    const result = await checkSession(makePage(url), {
      retryDelayMs: 0,
      fetchTimeoutMs: 15,
      hardTimeoutMs: 500,
    });
    assert.equal(result.state, SESSION_UNKNOWN, url);
    assert.ok(Date.now() - started < 400, `${url} 应在请求截止后快速返回`);
  }
});

test("checkSession 外层硬截止不依赖页面 evaluate 返回", async () => {
  const started = Date.now();
  const result = await checkSession(
    { evaluate: () => new Promise(() => {}) },
    { hardTimeoutMs: 20 }
  );
  assert.equal(result.state, SESSION_UNKNOWN);
  assert.match(result.detail, /硬截止/);
  assert.ok(Date.now() - started < 300);
});

test("同一页面硬截止后复用未完成 evaluate，settle 后才允许新探测", async () => {
  let resolveFirst;
  let evaluateCount = 0;
  const firstProbe = new Promise((resolve) => {
    resolveFirst = resolve;
  });
  const healthyProbe = {
    email: "person@example.com",
    name: "Person",
    hasToken: true,
    meStatus: 200,
    meValidUser: true,
  };
  const page = {
    evaluate: () => {
      evaluateCount++;
      return evaluateCount === 1 ? firstProbe : Promise.resolve(healthyProbe);
    },
  };

  const firstPending = checkSession(page, { hardTimeoutMs: 15 });
  const secondPending = checkSession(page, { hardTimeoutMs: 200 });
  const first = await firstPending;
  resolveFirst(healthyProbe);
  const second = await secondPending;
  assert.equal(first.state, SESSION_UNKNOWN);
  assert.equal(second.state, SESSION_UNKNOWN);
  assert.match(second.detail, /迟到结果/);
  assert.equal(evaluateCount, 1, "未完成的底层 evaluate 必须 single-flight");

  await firstProbe;
  await Promise.resolve();
  const third = await checkSession(page, { hardTimeoutMs: 100 });
  assert.equal(third.state, SESSION_OK);
  assert.equal(evaluateCount, 2, "前一个 evaluate settle 后应允许重新探测");
});

test("clearSession 返回经过 Cookie 与 storage 验证的结果", async () => {
  let cookieReads = 0;
  const clearedOrigins = [];
  const page = storageClearingPage();
  const context = {
    pages: () => [page],
    cookies: async () => {
      cookieReads++;
      return [];
    },
    clearCookies: async () => {},
    newCDPSession: async () => ({
      send: async (method, params) => {
        assert.equal(method, "Storage.clearDataForOrigin");
        assert.equal(params.storageTypes, "all");
        clearedOrigins.push(params.origin);
      },
      detach: async () => {},
    }),
  };

  const result = await clearSession(context);
  assert.equal(result.ok, true);
  assert.equal(result.cookiesCleared, true);
  assert.equal(result.cookiesVerified, true);
  assert.equal(result.storageCleared, true);
  assert.equal(result.originDataCleared, true);
  assert.deepEqual(clearedOrigins, [
    "https://chatgpt.com",
    "https://openai.com",
    "https://auth.openai.com",
    "https://auth0.openai.com",
  ]);
});

test("clearSession 任一步失败都会返回不可用结果", async () => {
  const page = storageClearingPage();
  const context = {
    pages: () => [page],
    cookies: async () => [
      { name: "auth", domain: ".chatgpt.com", path: "/" },
    ],
    clearCookies: async () => {
      throw new Error("profile is locked");
    },
    newCDPSession: async () => ({
      send: async () => {},
      detach: async () => {},
    }),
  };

  const result = await clearSession(context);
  assert.equal(result.ok, false);
  assert.match(result.errors.join(" "), /profile is locked/);
});

test("clearSession 不会把同名 Cookie 旋转新值误判为已清除", async () => {
  const page = storageClearingPage();
  const context = {
    pages: () => [page],
    clearCookies: async () => {},
    newCDPSession: async () => ({
      send: async () => {},
      detach: async () => {},
    }),
    cookies: async () => [
      {
        name: "auth",
        value: "rotated-value",
        domain: ".chatgpt.com",
        path: "/",
      },
    ],
  };

  const result = await clearSession(context);
  assert.equal(result.ok, false);
  assert.equal(result.cookiesVerified, false);
  assert.match(result.errors.join(" "), /auth@\.chatgpt\.com\//);
});
