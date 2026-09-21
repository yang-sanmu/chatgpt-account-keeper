import test from "node:test";
import assert from "node:assert/strict";
import {
  checkPromoEligibility,
  PROMO_BOTH,
  PROMO_FREE_TRIAL,
  PROMO_HALF_PRICE,
  PROMO_NONE,
  PROMO_CAMPAIGNS,
} from "../src/promoEligibility.js";

const FREE_COUPON = "plus-1-month-free";
const HALF_COUPON = "plus-1-month-50-pct-off";
const HALF_TWO_COUPON = "plus-2-months-50-pct-off";
const HALF_THREE_COUPON = "plus-3-months-50-pct-off";

/**
 * 假页面。模拟真实后端的关键行为（实测 2026-09-20）：
 *   - /backend-api/me 带有效 Bearer 返回 200，这是"token 已被后端接受"的判据；
 *   - check_coupon 只接受带 Bearer 的请求，匿名请求返回 200 + state:"offline"。
 * meStatus 可传入非 200，用来模拟"登录刚完成、token 还没生效"。
 */
function promoPage(states, overrides = {}, options = {}) {
  states = { [HALF_TWO_COUPON]: "not_eligible", [HALF_THREE_COUPON]: "not_eligible", ...states };
  // 数组表示逐次返回：第一次 401、第二次 200 即"重试后才生效"。
  const meStatuses = Array.isArray(options.meStatus)
    ? [...options.meStatus]
    : [options.meStatus ?? 200];
  const calls = { me: 0, coupons: 0 };
  const page = {
    calls,
    evaluate: async (probe, probeOptions) => {
      const previousFetch = globalThis.fetch;
      globalThis.fetch = async (url, init = {}) => {
        if (url === "/api/auth/session") {
          return new Response(JSON.stringify({ accessToken: "promo-token" }), {
            status: 200,
          });
        }
        if (url === "/backend-api/me") {
          calls.me++;
          assert.equal(init.headers.authorization, "Bearer promo-token");
          const status = meStatuses[Math.min(calls.me - 1, meStatuses.length - 1)];
          return new Response(status === 200 ? JSON.stringify({ id: "u", email: "a@b.c" }) : "nope", {
            status,
          });
        }
        const parsed = new URL(String(url), "https://chatgpt.com");
        const coupon = parsed.searchParams.get("coupon");
        assert.equal(parsed.pathname, "/backend-api/promo_campaign/check_coupon");
        assert.equal(parsed.searchParams.get("is_coupon_from_query_param"), "true");
        // 匿名请求在真实后端会得到 offline；探测器绝不该发出这种请求。
        assert.equal(init.headers.authorization, "Bearer promo-token");
        calls.coupons++;
        const configured = overrides[coupon] ?? {};
        return new Response(
          configured.body ?? JSON.stringify({ coupon, state: states[coupon] }),
          { status: configured.status ?? 200 }
        );
      };
      try {
        return await probe(probeOptions);
      } finally {
        globalThis.fetch = previousFetch;
      }
    },
  };
  return page;
}

// 所有用例都不该真的睡 1.2 秒 × 4 次。
const FAST = { fetchTimeoutMs: 100, hardTimeoutMs: 2_000, tokenReadyDelayMs: 0 };

test("检查免费试用和 1/2/3 个月半价的准确优惠券名称", () => {
  assert.deepEqual(PROMO_CAMPAIGNS.map(({ coupon }) => coupon), [
    FREE_COUPON, HALF_COUPON, HALF_TWO_COUPON, HALF_THREE_COUPON,
  ]);
});

for (const coupon of [HALF_TWO_COUPON, HALF_THREE_COUPON]) {
  for (const free of [false, true]) {
    test(`${coupon} 有资格${free ? "，且有免费试用" : ""}`, async () => {
      const result = await checkPromoEligibility(promoPage({
        [FREE_COUPON]: free ? "eligible" : "not_eligible",
        [HALF_COUPON]: "not_eligible",
        [coupon]: "eligible",
      }), FAST);
      assert.deepEqual(result, { ok: true, eligibility: free ? PROMO_BOTH : PROMO_HALF_PRICE });
    });
  }
  test(`${coupon} offline 不误判成无优惠`, async () => {
    const result = await checkPromoEligibility(promoPage({
      [FREE_COUPON]: "not_eligible", [HALF_COUPON]: "not_eligible", [coupon]: "offline",
    }), FAST);
    assert.equal(result.ok, false);
    assert.ok(result.detail.includes(coupon));
    assert.match(result.detail, /offline/);
  });
}

for (const [name, states, expected] of [
  ["免费试用", { [FREE_COUPON]: "eligible", [HALF_COUPON]: "not_eligible" }, PROMO_FREE_TRIAL],
  ["半价", { [FREE_COUPON]: "not_eligible", [HALF_COUPON]: "eligible" }, PROMO_HALF_PRICE],
  ["两种资格", { [FREE_COUPON]: "eligible", [HALF_COUPON]: "eligible" }, PROMO_BOTH],
  ["无优惠", { [FREE_COUPON]: "not_eligible", [HALF_COUPON]: "not_eligible" }, PROMO_NONE],
]) {
  test(`严格区分${name}优惠资格`, async () => {
    const result = await checkPromoEligibility(promoPage(states), FAST);
    assert.deepEqual(result, { ok: true, eligibility: expected });
  });
}

test("响应 coupon 不回显请求值时拒绝猜测资格", async () => {
  const result = await checkPromoEligibility(
    promoPage(
      { [FREE_COUPON]: "eligible", [HALF_COUPON]: "not_eligible" },
      { [FREE_COUPON]: { body: JSON.stringify({ coupon: "other", state: "eligible" }) } }
    ),
    FAST
  );
  assert.equal(result.ok, false);
  assert.match(result.detail, /结构不符合预期/);
});

test("某维度的券失败时不能把该维度的 not_eligible 当成无优惠", async () => {
  const result = await checkPromoEligibility(
    promoPage(
      { [FREE_COUPON]: "not_eligible", [HALF_COUPON]: "not_eligible" },
      { [HALF_COUPON]: { status: 503, body: "unavailable" } }
    ),
    FAST
  );
  assert.equal(result.ok, false);
  assert.match(result.detail, /503/);
  // 半价那一维还有 2/3 个月两张券已确认 not_eligible，但 1 个月那张没答案，
  // 所以该维度仍未知，不能报 none。
  assert.equal(result.eligibility, undefined);
});

// 按维度收敛：坏掉一张券不该作废另一张券已经查出的确定答案。此前 4 张券里坏 1 张
// 就整次 ok:false，新账号于是只剩一句「待复核」，界面上什么资格都不显示。
test("一张半价券确认有资格时，另一张半价券失败不影响该维度定论", async () => {
  const result = await checkPromoEligibility(
    promoPage(
      { [FREE_COUPON]: "not_eligible", [HALF_COUPON]: "eligible" },
      { [HALF_TWO_COUPON]: { status: 503, body: "unavailable" } }
    ),
    FAST
  );
  assert.deepEqual(result, { ok: true, eligibility: PROMO_HALF_PRICE });
});

test("免费试用券失败但半价已确认时，返回半价作为下界并要求复核", async () => {
  const result = await checkPromoEligibility(
    promoPage(
      { [FREE_COUPON]: "not_eligible", [HALF_COUPON]: "eligible" },
      { [FREE_COUPON]: { status: 503, body: "unavailable" } }
    ),
    FAST
  );
  // 不能报 half_price 成功：免费试用那张券没答案，真实资格可能是 both。
  assert.equal(result.ok, false);
  // 但已确认的半价是真实观测，丢掉它用户就只能看到一个空结果。
  assert.equal(result.eligibility, PROMO_HALF_PRICE);
  assert.match(result.detail, /503/);
});

test("所有券都确认 not_eligible 才报无优惠", async () => {
  const result = await checkPromoEligibility(
    promoPage({ [FREE_COUPON]: "not_eligible", [HALF_COUPON]: "not_eligible" }),
    FAST
  );
  assert.deepEqual(result, { ok: true, eligibility: PROMO_NONE });
});

// token 就绪校验。实测（2026-09-20，cubic-parlay-7r）：check_coupon 对匿名请求返回
// 200 + state:"offline"，对无效 token 返回 401，对有效 token 返回 eligible。登录刚完成时
// /api/auth/session 已能给出 token 字符串但后端还没认它，直接查券就得到一串 offline ——
// 用户在「新建账号」后看到的正是这个。所以查券前必须先确认 token 真的被后端接受。
test("token 尚未被后端接受时不查券，直接报未生效", async () => {
  const page = promoPage(
    { [FREE_COUPON]: "eligible", [HALF_COUPON]: "eligible" },
    {},
    { meStatus: 401 }
  );
  const result = await checkPromoEligibility(page, FAST);
  assert.equal(result.ok, false);
  assert.match(result.detail, /尚未生效|401/);
  // 关键：一张券都不能发出去。发了就会拿到 offline，并被记成「活动下线」。
  assert.equal(page.calls.coupons, 0);
});

test("token 稍后生效时会重试并拿到正确资格", async () => {
  // 前两次鉴权失败，第三次成功 —— 模拟登录落盘后 token 才被接受。
  const page = promoPage(
    { [FREE_COUPON]: "not_eligible", [HALF_COUPON]: "eligible" },
    {},
    { meStatus: [401, 401, 200] }
  );
  const result = await checkPromoEligibility(page, FAST);
  assert.deepEqual(result, { ok: true, eligibility: PROMO_HALF_PRICE });
  assert.equal(page.calls.me, 3);
});

test("offline 的文案不再让用户去核对券名", async () => {
  // 券名与活动都已实测无误；offline 只代表这次请求没被认证，误导文案会让用户白查。
  const page = promoPage({
    [FREE_COUPON]: "not_eligible",
    [HALF_COUPON]: "offline",
  });
  const result = await checkPromoEligibility(page, FAST);
  assert.equal(result.ok, false);
  assert.match(result.detail, /未认证/);
  assert.doesNotMatch(result.detail, /核对优惠券名称/);
});

// token 一直不生效时，重试必须在预算内收手。每次尝试有两个请求，各自最坏耗尽 fetch
// 超时，光靠"次数×间隔"估算会远超外层硬截止 —— 那样用户看到的就是一句"超过硬截止"，
// 而真正有用的"登录凭据尚未生效"被盖掉了，登录也被整段挡住。
test("token 始终不生效时按预算收手，报出原因而不是撞硬截止", async () => {
  const page = promoPage(
    { [FREE_COUPON]: "eligible", [HALF_COUPON]: "eligible" },
    {},
    { meStatus: 401 }
  );
  const started = Date.now();
  const result = await checkPromoEligibility(page, {
    fetchTimeoutMs: 100,
    hardTimeoutMs: 2_000,
    tokenReadyDelayMs: 200,
    tokenReadyBudgetMs: 300,
  });
  const elapsed = Date.now() - started;
  assert.equal(result.ok, false);
  // 原因必须是具体的鉴权失败，不能是硬截止。
  assert.match(result.detail, /尚未生效|401/);
  assert.doesNotMatch(result.detail, /硬截止/);
  // 预算 300ms + 边界上再起的一次尝试，远小于 4 次全跑完。
  assert.ok(elapsed < 1_500, `预算应提前收手，实际用了 ${elapsed}ms`);
  assert.ok(page.calls.me < 4, `不该用尽全部重试，实际 ${page.calls.me} 次`);
  assert.equal(page.calls.coupons, 0);
});

test("页面探测不返回时受外层硬截止约束", async () => {
  const result = await checkPromoEligibility(
    { evaluate: () => new Promise(() => {}) },
    { hardTimeoutMs: 15 }
  );
  assert.equal(result.ok, false);
  assert.match(result.detail, /硬截止/);
});

// eligibility 是把两个独立维度压进一个枚举的值，合并必须按维度取并集。
// 这个函数是「部分确认不能抹掉旧资格」的唯一实现处，语义错了整条链路都会错。
test("部分资格按维度取并集，绝不删除已确认的维度", async () => {
  const { mergePartialEligibility } = await import("../src/promoEligibility.js");
  // 补充：各自持有一维，合并成 both。
  assert.equal(mergePartialEligibility(PROMO_FREE_TRIAL, PROMO_HALF_PRICE), PROMO_BOTH);
  assert.equal(mergePartialEligibility(PROMO_HALF_PRICE, PROMO_FREE_TRIAL), PROMO_BOTH);
  // 不缩小：both 遇到单维的部分结果仍是 both。
  assert.equal(mergePartialEligibility(PROMO_BOTH, PROMO_HALF_PRICE), PROMO_BOTH);
  assert.equal(mergePartialEligibility(PROMO_BOTH, PROMO_FREE_TRIAL), PROMO_BOTH);
  // none 不携带任何维度，不能用它清掉旧资格。
  assert.equal(mergePartialEligibility(PROMO_BOTH, PROMO_NONE), PROMO_BOTH);
  assert.equal(mergePartialEligibility(PROMO_HALF_PRICE, PROMO_NONE), PROMO_HALF_PRICE);
  // 没有旧值时直接采用本次下界；没有本次值时保留旧值。
  assert.equal(mergePartialEligibility(null, PROMO_HALF_PRICE), PROMO_HALF_PRICE);
  assert.equal(mergePartialEligibility(PROMO_BOTH, undefined), PROMO_BOTH);
  assert.equal(mergePartialEligibility(null, undefined), null);
  // 非法值不参与合并。
  assert.equal(mergePartialEligibility(PROMO_HALF_PRICE, "eligible"), PROMO_HALF_PRICE);
});
