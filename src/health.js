/**
 * 会话健康判定（登录状态的唯一真相来源）。
 *
 * 为什么不能只看 /api/auth/session：
 * 账号在别处改了密码或新增双重认证后，该接口**依然**返回带 email 和 accessToken
 * 的完整 session（cookie 还在），于是旧逻辑判定“已登录”，但真实会话早已失效：
 * 跑对话时打不开输入框，点“登录”时又被立刻判定成功并关掉窗口。
 *
 * 实测（真实 profile 对比，2026-07）：
 *   健康账号   session 200 + accessToken + /backend-api/me 200
 *   失效账号   session 200 + accessToken + /backend-api/me 401
 *              body: "Your authentication token has been invalidated. Please try signing in again."
 * 所以判定的关键是“拿 accessToken 去打一个真正需要鉴权的后端接口”。
 * 注意 /backend-api/* 必须带 Authorization: Bearer，只靠 cookie 一律 401，
 * 不能把裸请求的 401 当作失效（否则健康账号会被全部误判）。
 */

// 会话可用 / 有会话但需重新认证 / 未登录 / 无法验证（网络抖动、限流、5xx）
export const SESSION_OK = "ok";
export const SESSION_REAUTH = "reauth";
export const SESSION_OUT = "out";
// unknown：有 email 和 token，但后端鉴权没能明确成功也没明确失败。
// 不能算 ok（那就等于回到“显示已登录其实跑不动”的老问题），
// 也不该算 reauth（网络抖一下就把好账号的会话清了，代价更大）。
export const SESSION_UNKNOWN = "unknown";

/**
 * 在已导航到 ChatGPT 的页面上检查会话健康度。
 * @returns {Promise<{state: string, email: string|null, name: string|null, detail: string|null}>}
 */
export async function checkSession(page) {
  let probe;
  try {
    probe = await page.evaluate(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const out = { sessionOk: false, sessionAttempts: 0, sessionJsonCount: 0 };
      let sess = null;

      // 挑战页有时也会让 session 接口返回 200 + 空 JSON，不能只看接口结果。
      // 记录页面标记，避免把“正在做人机验证”误判成真实退出。
      try {
        const marker = `${document.title ?? ""}\n${document.body?.innerText?.slice(0, 1000) ?? ""}`;
        out.challengePage =
          /just a moment|verify you are human|checking your browser|security verification|验证您是真人|安全验证/i.test(
            marker
          ) ||
          !!document.querySelector(
            'iframe[src*="challenges.cloudflare.com"], input[name="cf-turnstile-response"]'
          );
      } catch {
        out.challengePage = false;
      }

      // 刚导航完就查，偶尔会赶在会话态就绪之前，导致 session 返回空用户 ——
      // 那会把正常账号误判成“未登录”。所以拿不到用户时重试几次再下结论。
      for (let attempt = 0; attempt < 3; attempt++) {
        out.sessionAttempts++;
        try {
          const res = await fetch("/api/auth/session", {
            headers: { accept: "application/json" },
          });
          out.sessionStatus = res.status;
          if (res.ok) {
            const text = await res.text();
            try {
              sess = JSON.parse(text);
              out.sessionOk = true;
              out.sessionJsonCount++;
            } catch {
              // 返回了非 JSON（多半是被登录墙/风控页拦截）
              out.notJson = text.slice(0, 120);
            }
          }
        } catch (e) {
          out.sessionError = String(e && e.message ? e.message : e);
        }
        if (sess?.user?.email) break;
        out.retried = attempt + 1;
        if (attempt < 2) await sleep(1500);
      }

      out.email = sess?.user?.email ?? null;
      out.name = sess?.user?.name ?? null;
      const token = sess?.accessToken;
      out.hasToken = !!token;

      // 只有拿到 token 才有必要验后端；带 Bearer 才是有效鉴权请求。
      if (token) {
        try {
          const res = await fetch("/backend-api/me", {
            headers: {
              accept: "application/json",
              authorization: "Bearer " + token,
            },
          });
          out.meStatus = res.status;
          if (!res.ok) out.meBody = (await res.text().catch(() => "")).slice(0, 200);
        } catch (e) {
          out.meError = String(e && e.message ? e.message : e);
        }
      }
      return out;
    });
  } catch (e) {
    // 页面不可用只能说明本次无法检查，不能据此断言 Cookie 已丢失。
    // 浏览器启动/导航失败若被记成 out，会让所有正常账号瞬间显示“未登录”。
    return {
      state: SESSION_UNKNOWN,
      email: null,
      name: null,
      detail: `会话检查失败：${String(e.message || e)}`,
    };
  }

  const email = probe.email ?? null;
  const name = probe.name ?? null;

  // 只有成功拿到合法 session JSON 且其中明确没有用户，才能判定未登录。
  // Cloudflare 挑战页、403/5xx、非 JSON 响应和网络错误都只是“无法确认”；
  // 若把它们算成 out，正处于登录状态的账号会被误报为未登录。
  if (!email) {
    if (
      !probe.challengePage &&
      probe.sessionAttempts > 0 &&
      probe.sessionJsonCount === probe.sessionAttempts
    ) {
      return { state: SESSION_OUT, email: null, name: null, detail: "session 无用户信息" };
    }
    const reason = probe.challengePage
      ? "当前页面仍处于人机验证"
      : probe.notJson
        ? "会话接口被验证页拦截"
        : probe.sessionStatus
          ? `会话接口返回 ${probe.sessionStatus}`
          : probe.sessionError
            ? `会话接口请求失败：${probe.sessionError}`
            : "未能读取会话接口";
    return {
      state: SESSION_UNKNOWN,
      email: null,
      name: null,
      detail: `${reason}，暂不能确认登录状态`,
    };
  }

  // 有 email 但没有 accessToken：会话不完整，需要重新认证。
  if (!probe.hasToken) {
    return { state: SESSION_REAUTH, email, name, detail: "session 缺少 accessToken" };
  }

  // 后端鉴权通过 —— 真正可用。
  if (probe.meStatus === 200) {
    return { state: SESSION_OK, email, name, detail: null };
  }

  // 401/403：token 已被服务端作废（改密码、加双重认证、被强制登出都会这样）。
  if (probe.meStatus === 401 || probe.meStatus === 403) {
    return {
      state: SESSION_REAUTH,
      email,
      name,
      detail: "认证令牌已失效，需重新登录",
    };
  }

  // 其它情况（网络抖动、404、429、5xx）：既不能断言可用，也不能断言失效。
  // 标成 unknown，由调用方决定怎么处理：面板显示“待确认”而不是“已登录”，
  // 调度器仍会尝试跑（真跑不动会在发消息阶段失败），但不会对外声称已登录。
  return {
    state: SESSION_UNKNOWN,
    email,
    name,
    detail: probe.meStatus
      ? `鉴权接口返回 ${probe.meStatus}，未能确认会话状态`
      : `未能验证会话状态${probe.meError ? "：" + probe.meError : ""}`,
  };
}

/**
 * 清除该 profile 的登录态，让下次打开真正回到登录页。
 * 用于“需重新认证”时的强制重登：不必删账号（备注/分组/代理配置都能保留）。
 */
export async function clearSession(context) {
  try {
    await context.clearCookies();
  } catch {
    // 继续尝试清 storage
  }
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto("https://chatgpt.com/", { waitUntil: "domcontentloaded" }).catch(() => {});
    await page.evaluate(() => {
      try { localStorage.clear(); } catch {}
      try { sessionStorage.clear(); } catch {}
    }).catch(() => {});
  } catch {
    // 尽力而为，清不掉也不阻塞登录流程
  }
}
