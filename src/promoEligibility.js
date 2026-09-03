/**
 * ChatGPT Plus 优惠资格探测。
 *
 * 这里只读取两个稳定的后端 JSON 接口，不读取页面文案或 DOM，因此不受出口节点语言
 * 影响。资格判断只接受已实测的精确响应：HTTP 200、coupon 与请求一致，并且 state 为
 * eligible / not_eligible。接口形态变化时返回 unknown，由状态缓存保留上次可信结果。
 */

export const PROMO_FREE_TRIAL = "free_trial";
export const PROMO_HALF_PRICE = "half_price";
export const PROMO_BOTH = "both";
export const PROMO_NONE = "none";

export const PROMO_ELIGIBILITIES = Object.freeze([
  PROMO_FREE_TRIAL,
  PROMO_HALF_PRICE,
  PROMO_BOTH,
  PROMO_NONE,
]);

export const PROMO_CAMPAIGNS = Object.freeze([
  Object.freeze({
    coupon: "plus-1-month-free",
    eligibility: PROMO_FREE_TRIAL,
  }),
  Object.freeze({
    coupon: "plus-1-month-50-pct-off",
    eligibility: PROMO_HALF_PRICE,
  }),
]);

export const PROMO_FETCH_TIMEOUT_MS = 4_000;
export const PROMO_CHECK_TIMEOUT_MS = 7_000;

export function isPromoEligibility(value) {
  return PROMO_ELIGIBILITIES.includes(value);
}

/** 在已登录的 ChatGPT 页面内运行；accessToken 不离开浏览器上下文。 */
export async function promoProbeInPage(options = {}) {
  const fetchTimeoutMs =
    Number.isFinite(options.fetchTimeoutMs) && options.fetchTimeoutMs > 0
      ? options.fetchTimeoutMs
      : 4_000;
  const campaigns = Array.isArray(options.campaigns) ? options.campaigns : [];

  const fetchTextWithTimeout = async (url, init = {}) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), fetchTimeoutMs);
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      return { status: response.status, text: await response.text() };
    } finally {
      clearTimeout(timer);
    }
  };

  let session;
  try {
    const result = await fetchTextWithTimeout("/api/auth/session", {
      headers: { accept: "application/json" },
    });
    if (result.status !== 200) {
      return { ok: false, detail: `会话接口返回 ${result.status}` };
    }
    session = JSON.parse(result.text);
  } catch (error) {
    return {
      ok: false,
      detail: `读取优惠检查凭据失败：${String(error && error.message ? error.message : error)}`,
    };
  }

  const token =
    session && typeof session === "object" && !Array.isArray(session)
      ? session.accessToken
      : null;
  if (typeof token !== "string" || !token.trim()) {
    return { ok: false, detail: "session 未提供 accessToken" };
  }

  const inspectCampaign = async (campaign) => {
    const coupon =
      campaign && typeof campaign.coupon === "string" ? campaign.coupon : "";
    if (!coupon) return { ok: false, coupon, detail: "优惠券配置无效" };
    const url =
      `/backend-api/promo_campaign/check_coupon?coupon=${encodeURIComponent(coupon)}` +
      "&is_coupon_from_query_param=true";
    try {
      const result = await fetchTextWithTimeout(url, {
        headers: {
          accept: "application/json",
          authorization: `Bearer ${token}`,
        },
      });
      if (result.status !== 200) {
        return {
          ok: false,
          coupon,
          detail: `优惠接口返回 ${result.status}`,
        };
      }
      let payload;
      try {
        payload = JSON.parse(result.text);
      } catch {
        return { ok: false, coupon, detail: "优惠接口未返回 JSON" };
      }
      const validObject =
        !!payload && typeof payload === "object" && !Array.isArray(payload);
      if (
        !validObject ||
        payload.coupon !== coupon ||
        (payload.state !== "eligible" && payload.state !== "not_eligible")
      ) {
        return { ok: false, coupon, detail: "优惠接口返回结构不符合预期" };
      }
      return { ok: true, coupon, eligible: payload.state === "eligible" };
    } catch (error) {
      return {
        ok: false,
        coupon,
        detail: `优惠接口请求失败：${String(error && error.message ? error.message : error)}`,
      };
    }
  };

  const results = await Promise.all(campaigns.map(inspectCampaign));
  const failed = results.find((result) => result.ok !== true);
  if (failed) return { ok: false, detail: failed.detail };
  return {
    ok: true,
    campaigns: Object.fromEntries(
      results.map((result) => [result.coupon, result.eligible === true])
    ),
  };
}

function classifyCampaigns(campaigns) {
  const free = campaigns[PROMO_CAMPAIGNS[0].coupon] === true;
  const half = campaigns[PROMO_CAMPAIGNS[1].coupon] === true;
  if (free && half) return PROMO_BOTH;
  if (free) return PROMO_FREE_TRIAL;
  if (half) return PROMO_HALF_PRICE;
  return PROMO_NONE;
}

/**
 * @returns {Promise<{ok: true, eligibility: string}|{ok: false, detail: string}>}
 */
export async function checkPromoEligibility(page, options = {}) {
  const hardTimeoutMs =
    Number.isFinite(options.hardTimeoutMs) && options.hardTimeoutMs > 0
      ? options.hardTimeoutMs
      : PROMO_CHECK_TIMEOUT_MS;
  const probeOptions = {
    fetchTimeoutMs:
      Number.isFinite(options.fetchTimeoutMs) && options.fetchTimeoutMs > 0
        ? options.fetchTimeoutMs
        : PROMO_FETCH_TIMEOUT_MS,
    campaigns: PROMO_CAMPAIGNS.map(({ coupon }) => ({ coupon })),
  };
  let timeout;
  try {
    const probe = await Promise.race([
      Promise.resolve().then(() => page.evaluate(promoProbeInPage, probeOptions)),
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`优惠资格检查超过 ${hardTimeoutMs}ms 硬截止`)),
          hardTimeoutMs
        );
      }),
    ]);
    if (!probe || probe.ok !== true || !probe.campaigns) {
      return {
        ok: false,
        detail: String(probe?.detail || "优惠资格检查未返回可信结果"),
      };
    }
    return { ok: true, eligibility: classifyCampaigns(probe.campaigns) };
  } catch (error) {
    return {
      ok: false,
      detail: `优惠资格检查失败：${String(error?.message || error)}`,
    };
  } finally {
    clearTimeout(timeout);
  }
}
