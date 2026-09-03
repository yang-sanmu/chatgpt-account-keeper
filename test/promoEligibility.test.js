import test from "node:test";
import assert from "node:assert/strict";
import {
  checkPromoEligibility,
  PROMO_BOTH,
  PROMO_FREE_TRIAL,
  PROMO_HALF_PRICE,
  PROMO_NONE,
} from "../src/promoEligibility.js";

const FREE_COUPON = "plus-1-month-free";
const HALF_COUPON = "plus-1-month-50-pct-off";

function promoPage(states, overrides = {}) {
  return {
    evaluate: async (probe, options) => {
      const previousFetch = globalThis.fetch;
      globalThis.fetch = async (url, init = {}) => {
        if (url === "/api/auth/session") {
          return new Response(JSON.stringify({ accessToken: "promo-token" }), {
            status: 200,
          });
        }
        const parsed = new URL(String(url), "https://chatgpt.com");
        const coupon = parsed.searchParams.get("coupon");
        assert.equal(parsed.pathname, "/backend-api/promo_campaign/check_coupon");
        assert.equal(parsed.searchParams.get("is_coupon_from_query_param"), "true");
        assert.equal(init.headers.authorization, "Bearer promo-token");
        const configured = overrides[coupon] ?? {};
        return new Response(
          configured.body ?? JSON.stringify({ coupon, state: states[coupon] }),
          { status: configured.status ?? 200 }
        );
      };
      try {
        return await probe(options);
      } finally {
        globalThis.fetch = previousFetch;
      }
    },
  };
}

for (const [name, states, expected] of [
  ["免费试用", { [FREE_COUPON]: "eligible", [HALF_COUPON]: "not_eligible" }, PROMO_FREE_TRIAL],
  ["半价", { [FREE_COUPON]: "not_eligible", [HALF_COUPON]: "eligible" }, PROMO_HALF_PRICE],
  ["两种资格", { [FREE_COUPON]: "eligible", [HALF_COUPON]: "eligible" }, PROMO_BOTH],
  ["无优惠", { [FREE_COUPON]: "not_eligible", [HALF_COUPON]: "not_eligible" }, PROMO_NONE],
]) {
  test(`严格区分${name}优惠资格`, async () => {
    const result = await checkPromoEligibility(promoPage(states), {
      fetchTimeoutMs: 100,
      hardTimeoutMs: 500,
    });
    assert.deepEqual(result, { ok: true, eligibility: expected });
  });
}

test("响应 coupon 不回显请求值时拒绝猜测资格", async () => {
  const result = await checkPromoEligibility(
    promoPage(
      { [FREE_COUPON]: "eligible", [HALF_COUPON]: "not_eligible" },
      { [FREE_COUPON]: { body: JSON.stringify({ coupon: "other", state: "eligible" }) } }
    ),
    { fetchTimeoutMs: 100, hardTimeoutMs: 500 }
  );
  assert.equal(result.ok, false);
  assert.match(result.detail, /结构不符合预期/);
});

test("任一优惠接口失败时整次结果为未知，不能把另一个 not_eligible 当成无优惠", async () => {
  const result = await checkPromoEligibility(
    promoPage(
      { [FREE_COUPON]: "not_eligible", [HALF_COUPON]: "not_eligible" },
      { [HALF_COUPON]: { status: 503, body: "unavailable" } }
    ),
    { fetchTimeoutMs: 100, hardTimeoutMs: 500 }
  );
  assert.equal(result.ok, false);
  assert.match(result.detail, /503/);
});

test("页面探测不返回时受外层硬截止约束", async () => {
  const result = await checkPromoEligibility(
    { evaluate: () => new Promise(() => {}) },
    { hardTimeoutMs: 15 }
  );
  assert.equal(result.ok, false);
  assert.match(result.detail, /硬截止/);
});
