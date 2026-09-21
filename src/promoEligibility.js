/**
 * ChatGPT Plus 优惠资格探测。
 *
 * 这里只读取后端 JSON 接口，不读取页面文案或 DOM，因此不受出口节点语言
 * 影响。资格判断只接受已实测的精确响应：HTTP 200、coupon 与请求一致，并且 state 为
 * eligible / not_eligible。接口形态变化时返回 unknown，由状态缓存保留上次可信结果。
 *
 * 判定按维度而非按券整体收敛：任何一张券确认 eligible 就足以定论该维度有资格，
 * 只有判「没有资格」才需要该维度的每张券都确认。四张券里坏一张就整次作废，
 * 会把明明已经查出的半价资格丢成「没有结果」。
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
    // 活动标识必须精确匹配：1 个月是 month，2/3 个月是 months。
    coupon: "plus-1-month-50-pct-off",
    eligibility: PROMO_HALF_PRICE,
  }),
  Object.freeze({
    coupon: "plus-2-months-50-pct-off",
    eligibility: PROMO_HALF_PRICE,
  }),
  Object.freeze({
    coupon: "plus-3-months-50-pct-off",
    eligibility: PROMO_HALF_PRICE,
  }),
]);

export const PROMO_FETCH_TIMEOUT_MS = 4_000;
// 登录刚完成时 token 可能还没被后端接受，要留出等待与重试的时间。
export const PROMO_CHECK_TIMEOUT_MS = 20_000;

// token 就绪校验。实测（2026-09-20，真实账号 cubic-parlay-7r）：check_coupon 对匿名请求
// 返回 200 + state:"offline"，对无效 token 返回 401，对有效 token 返回 eligible。所以
// offline 等价于"这次请求没被认证"，不是"活动下线"或"券名写错"：登录成功那一刻
// /api/auth/session 已能给出 accessToken，但后端尚未认它。1 个月券匿名也能答，
// 所以只有 2/3 个月券会暴露出来，看起来像这两张券坏了。
//
// 预算不能只靠次数×间隔推算：每次尝试两个请求都可能耗尽 fetch 超时，4 次的最坏用时会
// 超过外层硬截止，"凭据尚未生效"这个有用的原因就被一句超时盖掉。7s + 边界上再起的一次
// 尝试（8s）+ 一轮并发查券（4s）= 19s，仍在 20s 硬截止内。
export const PROMO_TOKEN_READY_ATTEMPTS = 4;
export const PROMO_TOKEN_READY_DELAY_MS = 900;
export const PROMO_TOKEN_READY_BUDGET_MS = 7_000;

export function isPromoEligibility(value) {
  return PROMO_ELIGIBILITIES.includes(value);
}

/**
 * 把一次「部分确认」的观测并回已缓存的资格。
 *
 * eligibility 是一个把两个独立维度压进去的枚举（both = 两个都有），所以部分结果**不能**
 * 整体覆盖旧值：本次只确认了半价、免费试用那张券返回 503 时，直接写 half_price 会把上次
 * 已确认的免费试用抹掉，账号于是从「免费试用」筛选里消失。
 *
 * 规则：两个维度取并集 —— 部分结果只补充信息，绝不删除此前确认过的资格。
 * 完整成功的检查不走这里，它是权威结论，可以把 both 下调回 half_price。
 */
export function mergePartialEligibility(previous, partial) {
  if (!isPromoEligibility(partial)) return previous ?? null;
  if (!isPromoEligibility(previous)) return partial;
  const hasFree = (value) => value === PROMO_FREE_TRIAL || value === PROMO_BOTH;
  const hasHalf = (value) => value === PROMO_HALF_PRICE || value === PROMO_BOTH;
  const free = hasFree(partial) || hasFree(previous);
  const half = hasHalf(partial) || hasHalf(previous);
  if (free && half) return PROMO_BOTH;
  if (free) return PROMO_FREE_TRIAL;
  if (half) return PROMO_HALF_PRICE;
  return PROMO_NONE;
}

/** 在已登录的 ChatGPT 页面内运行；accessToken 不离开浏览器上下文。 */
export async function promoProbeInPage(options = {}) {
  const fetchTimeoutMs =
    Number.isFinite(options.fetchTimeoutMs) && options.fetchTimeoutMs > 0
      ? options.fetchTimeoutMs
      : 4_000;
  const campaigns = Array.isArray(options.campaigns) ? options.campaigns : [];
  // 这几个值由 checkPromoEligibility 校验后传入（它是唯一的调用方）。
  const readyAttempts = options.tokenReadyAttempts;
  const readyDelayMs = options.tokenReadyDelayMs;
  const readyBudgetMs = options.tokenReadyBudgetMs;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const startedAt = Date.now();

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

  const readToken = async () => {
    const result = await fetchTextWithTimeout("/api/auth/session", {
      headers: { accept: "application/json" },
    });
    if (result.status !== 200) {
      return { ok: false, detail: `会话接口返回 ${result.status}` };
    }
    const session = JSON.parse(result.text);
    const token =
      session && typeof session === "object" && !Array.isArray(session)
        ? session.accessToken
        : null;
    if (typeof token !== "string" || !token.trim()) {
      return { ok: false, detail: "session 未提供 accessToken" };
    }
    return { ok: true, token };
  };

  // 光有 token 字符串不够：登录刚完成时后端还不认它，此时查券会得到 200+offline，
  // 那是匿名响应，会被误读成"活动下线/券名不对"。所以先拿 token 打一个真正需要
  // 鉴权的接口（与会话健康判定同一判据），认证通过后才开始查券。
  //
  // 不能因为"调用方刚做完会话健康检查且判定 ok"就跳过这一步省一个请求：用户实际遇到
  // offline 的那次，正是登录流程里 checkSession 已判定 ok 之后发生的 —— 本函数会重新读
  // 一次 session，拿到的可能是登录后刚轮换的新 token，与 checkSession 验过的并非同一个。
  // 校验必须针对"接下来真正要用的这个 token"，否则等于没校验。
  let token = null;
  let lastDetail = "未能读取优惠检查凭据";
  for (let attempt = 0; attempt < readyAttempts; attempt++) {
    // 预算耗尽就停：继续重试只会撞上外层硬截止，把有用的原因换成一句"超时"。
    if (attempt > 0 && Date.now() - startedAt >= readyBudgetMs) break;
    if (attempt > 0) await sleep(readyDelayMs);
    let candidate;
    try {
      candidate = await readToken();
    } catch (error) {
      lastDetail = `读取优惠检查凭据失败：${String(error && error.message ? error.message : error)}`;
      continue;
    }
    if (candidate.ok !== true) {
      lastDetail = candidate.detail;
      continue;
    }
    try {
      const me = await fetchTextWithTimeout("/backend-api/me", {
        headers: {
          accept: "application/json",
          authorization: `Bearer ${candidate.token}`,
        },
      });
      if (me.status === 200) {
        token = candidate.token;
        break;
      }
      lastDetail = `登录凭据尚未生效（鉴权接口返回 ${me.status}），未查询优惠资格`;
    } catch (error) {
      lastDetail = `校验登录凭据失败：${String(error && error.message ? error.message : error)}`;
    }
  }
  if (!token) return { ok: false, detail: lastDetail };

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
      if (!validObject || payload.coupon !== coupon) {
        return { ok: false, coupon, detail: `${coupon}：优惠接口返回结构不符合预期` };
      }
      if (payload.state === "offline") {
        // offline 是后端对匿名请求的回答（实测：有效 token→eligible，无效 token→401，
        // 不带/空 token→200+offline）。走到这里说明请求虽然带了通过 /backend-api/me
        // 校验的 token，后端却仍按未认证处理 —— 不能据此说活动下线或券名写错。
        return {
          ok: false, coupon,
          detail: `${coupon}：优惠接口未认证本次请求（返回 offline），无法确认资格；稍后重试即可`,
        };
      }
      if (payload.state !== "eligible" && payload.state !== "not_eligible") {
        return { ok: false, coupon, detail: `${coupon}：优惠接口返回未知状态，无法确认资格` };
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
  // 逐券上报，让调用方按维度收敛。整次作废会浪费已经拿到的确定答案。
  return {
    ok: true,
    campaigns: Object.fromEntries(
      results.map((result) => [
        result.coupon,
        result.ok === true
          ? { ok: true, eligible: result.eligible === true }
          : { ok: false, detail: String(result.detail || "未能确认该优惠券") },
      ])
    ),
  };
}

/**
 * 把逐券结果收敛成一个资格。
 *
 * 每个维度独立判定：有一张券 eligible 即为有资格（正例是单调的，别的券查不到也不影响）；
 * 全部券都确认 not_eligible 才是没资格；否则该维度未知。
 *
 * 任一维度未知时结果不可信，绝不能报 none —— 「查不到」和「确实没有」是两件事。但若另一
 * 维度已确认有资格，就带上这个已确认的下界一起返回：它是真实观测，丢掉它用户就只能看到
 * 一个空结果。调用方据此显示「(资格)（待复核）」而不是什么都不显示。
 *
 * @returns {{ok: true, eligibility: string}|{ok: false, detail: string, eligibility?: string}}
 */
function classifyCampaigns(campaigns) {
  const classifyDimension = (eligibility) => {
    const relevant = PROMO_CAMPAIGNS.filter(
      (campaign) => campaign.eligibility === eligibility
    ).map((campaign) => ({ coupon: campaign.coupon, result: campaigns[campaign.coupon] }));
    if (relevant.some(({ result }) => result?.ok === true && result.eligible === true)) {
      return { known: true, eligible: true };
    }
    const unresolved = relevant.filter(({ result }) => result?.ok !== true);
    if (unresolved.length === 0) return { known: true, eligible: false };
    return {
      known: false,
      detail: unresolved
        .map(({ coupon, result }) => String(result?.detail || `${coupon}：未能确认`))
        .join("；"),
    };
  };

  const free = classifyDimension(PROMO_FREE_TRIAL);
  const half = classifyDimension(PROMO_HALF_PRICE);

  if (free.known && half.known) {
    if (free.eligible && half.eligible) return { ok: true, eligibility: PROMO_BOTH };
    if (free.eligible) return { ok: true, eligibility: PROMO_FREE_TRIAL };
    if (half.eligible) return { ok: true, eligibility: PROMO_HALF_PRICE };
    return { ok: true, eligibility: PROMO_NONE };
  }

  // 未知维度存在。已确认的那一半作为下界一并返回，但整体仍不可信：另一半可能也有资格，
  // 直接报 free_trial 会把一个其实是 both 的账号说小。
  const confirmed =
    free.known && free.eligible
      ? PROMO_FREE_TRIAL
      : half.known && half.eligible
        ? PROMO_HALF_PRICE
        : undefined;
  const result = {
    ok: false,
    detail: [free.known ? null : free.detail, half.known ? null : half.detail]
      .filter(Boolean)
      .join("；"),
  };
  if (confirmed) result.eligibility = confirmed;
  return result;
}

/**
 * ok:false 时可能仍带 eligibility —— 那是本次已确认的资格下界，调用方应保留它并标记待复核。
 *
 * @returns {Promise<{ok: true, eligibility: string}|{ok: false, detail: string, eligibility?: string}>}
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
    tokenReadyAttempts:
      Number.isFinite(options.tokenReadyAttempts) && options.tokenReadyAttempts > 0
        ? options.tokenReadyAttempts
        : PROMO_TOKEN_READY_ATTEMPTS,
    tokenReadyDelayMs:
      Number.isFinite(options.tokenReadyDelayMs) && options.tokenReadyDelayMs >= 0
        ? options.tokenReadyDelayMs
        : PROMO_TOKEN_READY_DELAY_MS,
    tokenReadyBudgetMs:
      Number.isFinite(options.tokenReadyBudgetMs) && options.tokenReadyBudgetMs > 0
        ? options.tokenReadyBudgetMs
        : PROMO_TOKEN_READY_BUDGET_MS,
    campaigns: PROMO_CAMPAIGNS.map(({ coupon }) => ({ coupon })),
  };
  let timeout;
  let onPageClose;
  try {
    const closed = new Promise((resolve) => {
      onPageClose = () => resolve({ ok: false, detail: "浏览器页面已关闭，优惠资格检查未完成" });
      page.once?.("close", onPageClose);
      if (page.isClosed?.()) onPageClose();
    });
    const probe = await Promise.race([
      closed,
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
    return classifyCampaigns(probe.campaigns);
  } catch (error) {
    return {
      ok: false,
      detail: `优惠资格检查失败：${String(error?.message || error)}`,
    };
  } finally {
    clearTimeout(timeout);
    if (onPageClose) page.off?.("close", onPageClose);
  }
}
