import { Agent, request } from "node:https";
import { cancellableSleep, throwIfCancelled } from "./cancellation.js";
import { classifyCampaigns, promoForDiscount, PROMO_CAMPAIGNS, PROMO_NONE } from "./promoEligibility.js";
import { ACCOUNTS_CHECK_PATH, parseAccountPlan } from "./accountPlanResponse.js";
import { readAccessTokenClaims } from "./accessToken.js";

const ORIGIN = "https://chatgpt.com";
const REQUEST_TIMEOUT = 10_000;
const MAX_RETRY_WAIT = 10_000;
const BODY_LIMIT = 1024 * 1024;

function accountIdFromToken(token) {
  const id = readAccessTokenClaims(token)?.["https://api.openai.com/auth"]?.chatgpt_account_id;
  return typeof id === "string" && /^[a-z\d_-]{1,128}$/iu.test(id) ? id : null;
}

function get(path, headers, agent, signal) {
  return new Promise((resolve, reject) => {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT);
    const req = request(new URL(path, ORIGIN), { headers, agent, signal: AbortSignal.any([signal, timeout]) }, (res) => {
      const chunks = [];
      let bytes = 0;
      res.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > BODY_LIMIT) req.destroy(new Error("Response exceeds size limit"));
        else chunks.push(chunk);
      });
      res.on("error", reject);
      res.on("end", () => {
        let payload;
        try { payload = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* 非 JSON 由调用方分类 */ }
        resolve({ status: res.statusCode, headers: res.headers, payload });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

function retryDelay(response) {
  const value = response?.headers?.["retry-after"];
  if (!value) return 1_200;
  const seconds = Number(value);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(ms) ? Math.max(0, ms) : 1_200;
}

function responseDetail(status, subject = "套餐") {
  if (status === 401) return "accessToken 已失效或鉴权失败，请刷新状态获取新 Token";
  if (status === 403) return `${subject}接口拒绝请求（HTTP 403），请检查所选节点`;
  if (status === 429) return `${subject}接口限流（HTTP 429），请稍后重试`;
  return status ? `${subject}接口返回 HTTP ${status}` : `节点连接失败或${subject}接口超时`;
}

export function createPlanClient(proxyUrl, signal, fetchJson = get) {
  // 旧 Node 会忽略 proxyEnv。显式拒绝，避免请求意外直连。
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 24 || (major === 24 && minor < 5)) throw new Error("账号查询需要 Node.js 24.5 或更新版本");
  const proxy = new URL(proxyUrl);
  if (!["http:", "https:"].includes(proxy.protocol)) throw new Error("账号查询代理地址无效");
  const agent = new Agent({
    keepAlive: true,
    maxSockets: 4,
    rejectUnauthorized: true,
    proxyEnv: { HTTPS_PROXY: proxy.href, NO_PROXY: "" },
  });
  let throttledUntil = 0;
  const requestJson = async (path, headers) => {
    throwIfCancelled(signal);
    while (throttledUntil > Date.now()) {
      const wait = throttledUntil - Date.now();
      if (wait > MAX_RETRY_WAIT) return { status: 429 };
      await cancellableSleep(wait, signal);
    }
    try {
      const response = await fetchJson(path, headers, agent, signal);
      if (response?.status === 429) throttledUntil = Math.max(throttledUntil, Date.now() + retryDelay(response));
      return response;
    } catch {
      throwIfCancelled(signal);
      return null;
    }
  };

  return {
    close: () => agent.destroy(),
    async check(token, { promoOnly = false } = {}) {
      const accountId = accountIdFromToken(token);
      const headers = { accept: "application/json", authorization: `Bearer ${token}`, referer: `${ORIGIN}/` };
      if (accountId) headers["chatgpt-account-id"] = accountId;
      const accountHeaders = { ...headers, "x-openai-target-path": ACCOUNTS_CHECK_PATH, "x-openai-target-route": ACCOUNTS_CHECK_PATH };
      const path = `${ACCOUNTS_CHECK_PATH}?timezone_offset_min=${new Date().getTimezoneOffset()}`;
      let response = await requestJson(path, accountHeaders);
      const wait = response?.status === 429 ? 0 : retryDelay(response);
      const retryable = !response || [403, 408, 409, 425, 429].includes(response.status) || response.status >= 500 ||
        (response.status === 200 && !response.payload);
      if (retryable && wait <= MAX_RETRY_WAIT) {
        if (response?.status === 403 || response?.status === 200) {
          // 在同一节点预热站点。Cookie 只在本次查询内使用，且只发送给 ChatGPT。
          const landing = await requestJson("/", { accept: "text/html" });
          const cookies = landing?.headers?.["set-cookie"]?.map((value) => value.split(";", 1)[0]);
          if (cookies?.length) headers.cookie = accountHeaders.cookie = cookies.join("; ");
        }
        if (wait > 0) await cancellableSleep(wait, signal);
        response = await requestJson(path, accountHeaders);
      }
      const plan = response?.status === 200
        ? parseAccountPlan(response.payload, accountId, { allowMissingPlan: promoOnly })
        : null;
      const knownPromo = promoForDiscount(plan?.discountPercentage);
      if (promoOnly) {
        const listed = plan?.listedPlusCampaign;
        const advertised = knownPromo ?? PROMO_CAMPAIGNS.find(({ coupon }) => coupon === listed?.id)?.eligibility;
        // 已认证工作区的活动列表可以直接判定，不让无法确认的券接口覆盖结果。
        if (advertised || listed === null) {
          return { promo: { ok: true, eligibility: advertised ?? PROMO_NONE } };
        }
        if (!plan || plan.planType === "guest") {
          const verified = [401, 429].includes(response?.status)
            ? response : await requestJson("/backend-api/me", headers);
          if (verified?.status !== 200) return { detail: responseDetail(verified?.status, "优惠") };
        }
      } else {
        if (response?.status !== 200) return { detail: responseDetail(response?.status) };
        if (!plan) return { detail: "套餐接口未返回可确认的账号套餐" };
      }

      const campaigns = await Promise.all(PROMO_CAMPAIGNS.map(async ({ coupon, eligibility }) => {
        if (knownPromo === eligibility) return [coupon, { ok: true, eligible: true }];
        const path = `/backend-api/promo_campaign/check_coupon?coupon=${encodeURIComponent(coupon)}&is_coupon_from_query_param=true`;
        const result = await requestJson(path, headers);
        if (result?.status === 200 && result.payload?.coupon === coupon &&
            ["eligible", "not_eligible"].includes(result.payload.state)) {
          return [coupon, { ok: true, eligible: result.payload.state === "eligible" }];
        }
        const detail = result?.status === 200 ? "优惠资格未确认" : responseDetail(result?.status, "优惠");
        return [coupon, { ok: false, detail: `${coupon}：${detail}` }];
      }));
      const promo = classifyCampaigns(Object.fromEntries(campaigns));
      return promoOnly ? { promo } : { planType: plan.planType, promo };
    },
  };
}
