import test from "node:test";
import assert from "node:assert/strict";
import {
  checkSession,
  SESSION_OK,
  SESSION_OUT,
  SESSION_UNKNOWN,
} from "../src/health.js";

function pageReturning(probe) {
  return { evaluate: async () => probe };
}

test("合法 session JSON 明确没有用户时才判定未登录", async () => {
  const result = await checkSession(
    pageReturning({
      sessionOk: true,
      sessionAttempts: 3,
      sessionJsonCount: 3,
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

test("挑战页即使返回空 session JSON 也不能判定未登录", async () => {
  const result = await checkSession(
    pageReturning({
      challengePage: true,
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
    })
  );
  assert.equal(result.state, SESSION_OK);
  assert.equal(result.email, "person@example.com");
});
