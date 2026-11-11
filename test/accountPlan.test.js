import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import Database from "better-sqlite3";
import { createPlanClient } from "../src/accountPlan.js";
import { ACCOUNTS_CHECK_PATH, parseAccountPlan } from "../src/accountPlanResponse.js";
import { AccountPlanStore } from "../src/persistence/accountPlans.js";
import { KeeperRepository } from "../src/persistence/sqliteRepository.js";
import { MIGRATIONS } from "../src/persistence/schema.js";

test("套餐查询按凭据中的账号选择工作区，部分优惠通过查券补齐", async (t) => {
  const auth = { "https://api.openai.com/auth": { chatgpt_account_id: "personal" } };
  const token = `header.${Buffer.from(JSON.stringify(auth)).toString("base64url")}.signature`;
  const accounts = {
    default: { account: { account_id: "team", plan_type: "team" } },
    personal: {
      account: { account_id: "personal", plan_type: "free" },
      eligible_promo_campaigns: { plus: { metadata: { discount: { percentage: 100 } } } },
    },
  };
  assert.equal(parseAccountPlan({ accounts }, "missing"), null);
  assert.equal(parseAccountPlan({ accounts }, "missing", { allowMissingPlan: true }), null);
  let attempts = 0;
  const coupons = [];
  const client = createPlanClient("http://127.0.0.1:12345", new AbortController().signal, async (path, headers) => {
    assert.equal(headers.authorization, `Bearer ${token}`);
    assert.equal(headers["chatgpt-account-id"], "personal");
    const url = new URL(path, "https://chatgpt.com");
    if (url.pathname === ACCOUNTS_CHECK_PATH) {
      assert.equal(headers["x-openai-target-route"], ACCOUNTS_CHECK_PATH);
      return ++attempts === 1
        ? { status: 429, headers: { "retry-after": "0" } }
        : { status: 200, payload: { accounts } };
    }
    const coupon = url.searchParams.get("coupon");
    coupons.push(coupon);
    return { status: 200, payload: { coupon, state: "not_eligible" } };
  });
  t.after(() => client.close());
  assert.deepEqual(await client.check(token), { planType: "free", promo: { ok: true, eligibility: "free_trial" } });
  assert.equal(attempts, 2);
  assert.equal(coupons.length, 3);
  assert.ok(coupons.every((coupon) => coupon.includes("50-pct-off")));
  assert.deepEqual(await client.check(token, { promoOnly: true }), {
    promo: { ok: true, eligibility: "free_trial" },
  });
  assert.equal(coupons.length, 3, "查优惠直接使用已确认的活动列表");
});

test("查优惠在套餐字段缺失时保留活动列表已确认的资格", async (t) => {
  const client = createPlanClient("http://127.0.0.1:12345", new AbortController().signal, async (path) => {
    const url = new URL(path, "https://chatgpt.com");
    if (url.pathname === ACCOUNTS_CHECK_PATH) {
      return { status: 200, payload: { accounts: { default: {
        eligible_promo_campaigns: { plus: { metadata: { discount: { percentage: 100 } } } },
      } } } };
    }
    return { status: 200, payload: { coupon: url.searchParams.get("coupon"), state: "not_eligible" } };
  });
  t.after(() => client.close());
  assert.deepEqual(await client.check("fixture-token", { promoOnly: true }), {
    promo: { ok: true, eligibility: "free_trial" },
  });
  assert.deepEqual(await client.check("fixture-token"), { detail: "套餐接口未返回可确认的账号套餐" });
});

test("纯协议优惠查询在活动列表不可用时仍能查券，未认证响应保留为待复核", async (t) => {
  const paths = [];
  const client = createPlanClient("http://127.0.0.1:12345", new AbortController().signal, async (path, headers) => {
    assert.equal(headers.authorization, "Bearer fixture-token");
    const url = new URL(path, "https://chatgpt.com");
    paths.push(url.pathname);
    if (url.pathname === ACCOUNTS_CHECK_PATH) return { status: 404 };
    if (url.pathname === "/backend-api/me") return { status: 200 };
    const coupon = url.searchParams.get("coupon");
    return { status: 200, payload: { coupon, state: coupon === "plus-1-month-free" ? "offline" : "eligible" } };
  });
  t.after(() => client.close());
  const result = await client.check("fixture-token", { promoOnly: true });
  assert.deepEqual(result, {
    promo: { ok: false, eligibility: "half_price", detail: "plus-1-month-free：优惠资格未确认" },
  });
  assert.deepEqual(paths.slice(0, 2), [ACCOUNTS_CHECK_PATH, "/backend-api/me"]);
  assert.deepEqual(paths.slice(2), Array(4).fill("/backend-api/promo_campaign/check_coupon"));
});

test("已认证账号的空活动列表可确认无优惠，访客列表仍需校验凭据", async (t) => {
  const paths = [];
  let planType = "free";
  const client = createPlanClient("http://127.0.0.1:12345", new AbortController().signal, async (path) => {
    const pathname = new URL(path, "https://chatgpt.com").pathname;
    paths.push(pathname);
    if (pathname === ACCOUNTS_CHECK_PATH) {
      return { status: 200, payload: { accounts: { default: {
        account: { plan_type: planType }, eligible_promo_campaigns: {},
      } } } };
    }
    return { status: 401 };
  });
  t.after(() => client.close());
  assert.deepEqual(await client.check("fixture-token", { promoOnly: true }), {
    promo: { ok: true, eligibility: "none" },
  });
  assert.deepEqual(paths, [ACCOUNTS_CHECK_PATH]);

  planType = "guest";
  assert.match((await client.check("fixture-token", { promoOnly: true })).detail, /鉴权失败/);
  assert.deepEqual(paths, [ACCOUNTS_CHECK_PATH, ACCOUNTS_CHECK_PATH, "/backend-api/me"]);
});

test("代理拒绝 CONNECT 时每次套餐请求都仍走所选代理", async (t) => {
  const connects = [];
  const server = http.createServer();
  server.on("connect", (req, socket) => {
    connects.push(req.url);
    assert.equal(req.headers.authorization, undefined);
    socket.end("HTTP/1.1 407 Proxy Authentication Required\r\nConnection: close\r\n\r\n");
  });
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const client = createPlanClient(`http://127.0.0.1:${server.address().port}`, new AbortController().signal);
  t.after(() => client.close());
  assert.match((await client.check("fixture-token")).detail, /节点连接失败|HTTP 407/);
  assert.ok(connects.length > 0);
  assert.ok(connects.every((target) => target === "chatgpt.com:443"));
});

test("长时间限流时本批查询不会提前重试或继续发送下一个账号的请求", async (t) => {
  let requests = 0;
  const client = createPlanClient("http://127.0.0.1:12345", new AbortController().signal, async () => {
    requests++;
    return { status: 429, headers: { "retry-after": "60" } };
  });
  t.after(() => client.close());
  assert.match((await client.check("first-fixture")).detail, /HTTP 429/);
  assert.match((await client.check("second-fixture")).detail, /HTTP 429/);
  assert.equal(requests, 1);
});

test("持久化凭据与账号身份绑定，旧 Token 查询结果不能覆盖新会话", () => {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  try {
    for (const migration of MIGRATIONS) database.exec(migration.sql);
    const repository = new KeeperRepository(database);
    repository.createAccount({ id: "personal", profileName: "personal", email: "user@example.test" });
    const plans = new AccountPlanStore(database, "test-private-ipc-key");
    assert.deepEqual(plans.getTokenStatus("personal"), { hasAccessToken: false, accessTokenExpiresAt: null });
    assert.throws(() => plans.saveToken("personal", "other@example.test", "invalid"), /账号身份已变更/);
    plans.saveToken("personal", "user@example.test", "fixture-token");
    const initial = plans.getToken("personal");
    assert.equal(initial.token, "fixture-token");
    assert.deepEqual(plans.getTokenStatus("personal"), { hasAccessToken: true, accessTokenExpiresAt: null });
    assert.ok(!initial.sealed.includes("fixture-token"));
    assert.equal(plans.savePlan("personal", initial.sealed, { planType: "plus" }), true);
    assert.equal(plans.savePlan("personal", initial.sealed, { detail: "HTTP 403" }), true);
    assert.equal(plans.getPlan("personal").planType, "plus");
    assert.equal(plans.getPlan("personal").planCheckDetail, "HTTP 403");
    const accessTokenExpiresAt = "2026-11-09T10:00:00.000Z";
    const claims = { exp: Date.parse(accessTokenExpiresAt) / 1000 };
    const token = `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
    plans.saveToken("personal", "user@example.test", token);
    assert.deepEqual(plans.getTokenStatus("personal"), { hasAccessToken: true, accessTokenExpiresAt });
    assert.equal(plans.savePlan("personal", initial.sealed, { planType: "free" }), false);
    assert.equal(new AccountPlanStore(database, "different-key").getToken("personal"), null);
    const refreshed = plans.getToken("personal");
    repository.upsertStatus("personal", { state: "ok", email: "new@example.test" });
    assert.equal(plans.getToken("personal"), null);
    assert.deepEqual(plans.getTokenStatus("personal"), { hasAccessToken: false, accessTokenExpiresAt: null });
    assert.equal(plans.getPlan("personal").planType, null);
    assert.equal(plans.savePlan("personal", refreshed.sealed, { planType: "free" }), false);
    repository.updateAccount("personal", { email: "new@example.test" });
    assert.equal(plans.getToken("personal"), null);
    assert.equal(plans.getPlan("personal").planType, null);
  } finally {
    database.close();
  }
});
