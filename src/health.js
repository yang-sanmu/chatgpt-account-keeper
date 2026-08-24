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

// 单个请求必须先于整个探测截止，否则某个 fetch 永不返回时会把状态巡检和
// 登录轮询一起永久卡住。三次 session 尝试（含间隔）加一次 me 请求的最坏
// 用时约 19 秒，外层再留少量调度余量。
export const SESSION_FETCH_TIMEOUT_MS = 4_000;
export const SESSION_CHECK_TIMEOUT_MS = 22_000;

// 外层硬截止只能停止调用方等待，无法取消 Playwright 已发出的 evaluate。
// 同一 Page 在底层探测真正 settle 前必须复用该 Promise，避免轮询不断叠加
// 永不返回的 CDP 请求。WeakMap 不延长已关闭 Page 的生命周期。
const sessionProbeFlights = new WeakMap();

/**
 * 在浏览器页面内部执行的原始探测器。保持函数自包含，便于既交给
 * page.evaluate 执行，也用真实 Response 对象覆盖解析边界。
 */
export async function sessionProbeInPage(options = {}) {
  const fetchTimeoutMs =
    Number.isFinite(options.fetchTimeoutMs) && options.fetchTimeoutMs > 0
      ? options.fetchTimeoutMs
      : 4_000;
  const retryDelayMs =
    Number.isFinite(options.retryDelayMs) && options.retryDelayMs >= 0
      ? options.retryDelayMs
      : 1_500;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const isPlainObject = (value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  };
  const classifySessionPayload = (value) => {
    if (!isPlainObject(value)) return "invalid";
    const keys = Object.keys(value);
    // NextAuth 明确退出时返回空对象。
    if (keys.length === 0) return "empty";

    const hasUser = Object.prototype.hasOwnProperty.call(value, "user");
    const hasToken = Object.prototype.hasOwnProperty.call(value, "accessToken");
    if (!hasUser && !hasToken) return "invalid";

    const userIsObject = isPlainObject(value.user);
    if (hasUser && value.user !== null && !userIsObject) return "invalid";
    if (
      userIsObject &&
      value.user.email != null &&
      typeof value.user.email !== "string"
    ) {
      return "invalid";
    }
    if (
      hasToken &&
      value.accessToken !== null &&
      typeof value.accessToken !== "string"
    ) {
      return "invalid";
    }

    // 有些错误响应也会伪装成 200 JSON。只有同时带有实际 user/token 时，
    // 才允许额外的 error/message 字段，避免 {error: ...} 被累计成已退出。
    const hasMeaningfulSession =
      userIsObject || typeof value.accessToken === "string";
    if (
      !hasMeaningfulSession &&
      (Object.prototype.hasOwnProperty.call(value, "error") ||
        Object.prototype.hasOwnProperty.call(value, "message"))
    ) {
      return "invalid";
    }

    const userExplicitlyEmpty = !hasUser || value.user === null;
    const tokenExplicitlyEmpty = !hasToken || value.accessToken === null;
    if (userExplicitlyEmpty && tokenExplicitlyEmpty) return "empty";

    // 有 token、非空 user，或形态可识别但尚未填完整的 session 都不能当作
    // 明确退出；它们只说明接口仍在初始化或响应形态发生了变化。
    return "incomplete";
  };
  const detectChallengePage = () => {
    try {
      const marker = `${document.title ?? ""}\n${document.body?.innerText?.slice(0, 1000) ?? ""}`;
      return (
        /just a moment|verify you are human|checking your browser|security verification|验证您是真人|安全验证/i.test(
          marker
        ) ||
        !!document.querySelector(
          'iframe[src*="challenges.cloudflare.com"], input[name="cf-turnstile-response"]'
        )
      );
    } catch {
      return false;
    }
  };
  const detectLoggedOutPage = () => {
    try {
      return Array.from(
        document.querySelectorAll("#modal-no-auth-login, [data-testid='login-button']")
      ).some((element) => {
        if (element.hidden || element.getAttribute?.("aria-hidden") === "true") return false;
        const style = element.ownerDocument?.defaultView?.getComputedStyle?.(element);
        return style?.display !== "none" && style?.visibility !== "hidden";
      });
    } catch {
      return false;
    }
  };
  const fetchTextWithTimeout = async (url, init = {}) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), fetchTimeoutMs);
    try {
      const response = await fetch(url, {
        ...init,
        signal: controller.signal,
      });
      const text = await response.text();
      return { response, text };
    } finally {
      clearTimeout(timer);
    }
  };
  const out = {
    sessionOk: false,
    sessionAttempts: 0,
    sessionJsonCount: 0,
    sessionEmptyCount: 0,
  };
  let sess = null;

  // 挑战页有时也会让 session 接口返回 200 + 空 JSON，不能只看接口结果。
  // 记录页面标记，避免把“正在做人机验证”误判成真实退出。
  out.challengePage = detectChallengePage();

  // 刚导航完就查，偶尔会赶在会话态就绪之前，导致 session 返回空用户 ——
  // 那会把正常账号误判成“未登录”。所以拿不到用户时重试几次再下结论。
  for (let attempt = 0; attempt < 3; attempt++) {
    out.sessionAttempts++;
    try {
      const { response: res, text } = await fetchTextWithTimeout(
        "/api/auth/session",
        { headers: { accept: "application/json" } }
      );
      out.sessionStatus = res.status;
      if (res.ok) {
        try {
          const payload = JSON.parse(text);
          // 数组、原始值及仅含 error/message 的任意对象都不是 session。
          // 若把它们算作“合法空 session”，连续三次会误判为已退出。
          const payloadKind = classifySessionPayload(payload);
          if (payloadKind !== "invalid") {
            sess = payload;
            out.sessionOk = true;
            out.sessionJsonCount++;
            if (payloadKind === "empty") out.sessionEmptyCount++;
            else out.sessionIncomplete = true;
          } else {
            out.invalidSessionJson = text.slice(0, 120);
          }
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
    if (attempt < 2) await sleep(retryDelayMs);
  }

  // 挑战页可能在第一次 session 请求后才替换当前文档。必须在所有重试结束
  // 后重新检测，否则三次空对象响应会被错误归类为真实退出。
  out.challengePage = out.challengePage || detectChallengePage();
  out.loggedOutPage = detectLoggedOutPage();

  out.email = sess?.user?.email ?? null;
  out.name = sess?.user?.name ?? null;
  const token = sess?.accessToken;
  out.hasToken = !!token;

  // 只有拿到 token 才有必要验后端；带 Bearer 才是有效鉴权请求。
  if (token) {
    try {
      const { response: res, text } = await fetchTextWithTimeout(
        "/backend-api/me",
        {
          headers: {
            accept: "application/json",
            authorization: "Bearer " + token,
          },
        }
      );
      out.meStatus = res.status;

      // 不能只看 HTTP 状态码：Cloudflare/WAF 可能返回 403 HTML，
      // 也可能以 200 返回验证页。只有与 session 邮箱一致的
      // 完整用户 JSON 才能证明会话真正可用。当前实测结构是顶层 id/email；
      // 不猜测兼容任意嵌套对象，接口变化时宁可待确认也不能误报已登录。
      try {
        const payload = JSON.parse(text);
        const rootIsObject =
          !!payload && typeof payload === "object" && !Array.isArray(payload);
        const meId =
          rootIsObject && typeof payload.id === "string"
            ? payload.id.trim()
            : "";
        const meEmail =
          rootIsObject && typeof payload.email === "string"
            ? payload.email.trim()
            : "";
        const sessionEmail = String(sess?.user?.email ?? "").trim();
        out.meParseOk = rootIsObject;
        out.meValidUser =
          !!meId &&
          !!meEmail &&
          meEmail.includes("@") &&
          !!sessionEmail &&
          meEmail.toLowerCase() === sessionEmail.toLowerCase();
      } catch {
        out.meParseOk = false;
        out.meValidUser = false;
      }

      // 只白名单当前已实测的确定失效文案。不用宽泛的
      // "invalid token" 正则，避免误命中 WAF/验证页文本。
      out.meTokenInvalid =
        res.status === 401 &&
        text
          .toLowerCase()
          .includes("your authentication token has been invalidated");
    } catch (e) {
      out.meError = String(e && e.message ? e.message : e);
    }
  }
  return out;
}

/**
 * 在已导航到 ChatGPT 的页面上检查会话健康度。
 * @returns {Promise<{state: string, email: string|null, name: string|null, detail: string|null}>}
 */
export async function checkSession(page, options = {}) {
  const hardTimeoutMs =
    Number.isFinite(options.hardTimeoutMs) && options.hardTimeoutMs > 0
      ? options.hardTimeoutMs
      : SESSION_CHECK_TIMEOUT_MS;
  const probeOptions = {
    fetchTimeoutMs:
      Number.isFinite(options.fetchTimeoutMs) && options.fetchTimeoutMs > 0
        ? options.fetchTimeoutMs
        : SESSION_FETCH_TIMEOUT_MS,
    retryDelayMs:
      Number.isFinite(options.retryDelayMs) && options.retryDelayMs >= 0
        ? options.retryDelayMs
        : 1_500,
  };
  let probe;
  let timeout;
  let flight;
  try {
    flight = sessionProbeFlights.get(page);
    if (!flight) {
      flight = {
        promise: Promise.resolve().then(() =>
          page.evaluate(sessionProbeInPage, probeOptions)
        ),
        timedOut: false,
      };
      sessionProbeFlights.set(page, flight);
      const clearFlight = () => {
        if (sessionProbeFlights.get(page) === flight) {
          sessionProbeFlights.delete(page);
        }
      };
      flight.promise.then(clearFlight, clearFlight);
    }
    if (flight.timedOut) {
      throw new Error("上一次会话检查已超时且底层页面探测仍未结束");
    }
    const usableProbe = flight.promise.then((value) => {
      if (flight.timedOut) {
        throw new Error("会话检查的迟到结果已丢弃");
      }
      return value;
    });
    probe = await Promise.race([
      usableProbe,
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => {
            flight.timedOut = true;
            reject(new Error(`会话检查超过 ${hardTimeoutMs}ms 硬截止`));
          },
          hardTimeoutMs
        );
      }),
    ]);
  } catch (e) {
    // 页面不可用只能说明本次无法检查，不能据此断言 Cookie 已丢失。
    // 浏览器启动/导航失败若被记成 out，会让所有正常账号瞬间显示“未登录”。
    return {
      state: SESSION_UNKNOWN,
      email: null,
      name: null,
      detail: `会话检查失败：${String(e.message || e)}`,
    };
  } finally {
    clearTimeout(timeout);
  }

  const email = probe.email ?? null;
  const name = probe.name ?? null;

  // 游客页与登录页现在同样提供可用输入框，只有会话接口而忽略页面强指示，会让
  // 自动对话先以游客身份跑几轮，再被 modal-no-auth-login 拦住。可见的登录入口
  // 或未登录弹窗是明确证据；挑战页优先保持 unknown，避免把 WAF 误判成退出。
  if (probe.loggedOutPage && !probe.challengePage) {
    return {
      state: email ? SESSION_REAUTH : SESSION_OUT,
      email,
      name,
      detail: email
        ? "ChatGPT 页面要求重新登录"
        : "ChatGPT 页面显示未登录状态",
    };
  }

  // 只有成功拿到合法 session JSON 且其中明确没有用户，才能判定未登录。
  // Cloudflare 挑战页、403/5xx、非 JSON 响应和网络错误都只是“无法确认”；
  // 若把它们算成 out，正处于登录状态的账号会被误报为未登录。
  if (!email) {
    if (
      !probe.challengePage &&
      probe.sessionAttempts > 0 &&
      probe.sessionEmptyCount === probe.sessionAttempts
    ) {
      return { state: SESSION_OUT, email: null, name: null, detail: "session 无用户信息" };
    }
    const reason = probe.challengePage
      ? "当前页面仍处于人机验证"
      : probe.notJson
        ? "会话接口被验证页拦截"
        : probe.invalidSessionJson
          ? "会话接口返回了非会话 JSON"
        : probe.sessionIncomplete
          ? "会话接口返回的信息不完整"
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

  // 有 email 但没有 accessToken 也可能只是 session 尚未就绪或接口形态变化。
  // 没有服务端的明确 token-invalid 证据，只能待确认，不能直接要求重登。
  if (!probe.hasToken) {
    return {
      state: SESSION_UNKNOWN,
      email,
      name,
      detail: "session 暂未提供 accessToken，未能确认会话状态",
    };
  }

  // 后端鉴权通过，且确实返回了与 session 一致的用户 JSON。
  if (probe.meStatus === 200 && probe.meValidUser) {
    return { state: SESSION_OK, email, name, detail: null };
  }

  // 只有已知的明确 token-invalid 响应才判为 reauth；是否清理 Cookie 仍只由
  // 用户明确点击“重新登录/强制重登”决定。403 可能是 WAF，绝不能判作废。
  if (probe.meStatus === 401 && probe.meTokenInvalid) {
    return {
      state: SESSION_REAUTH,
      email,
      name,
      detail: "认证令牌已失效，需重新登录",
    };
  }

  // 其它情况（200 非用户 JSON、401 未知错误、403、429、5xx、网络抖动）：
  // 既不能断言可用，也不能断言失效。
  // 标成 unknown，由调用方决定怎么处理：面板显示“待确认”而不是“已登录”，
  // 调度器仍会尝试跑（真跑不动会在发消息阶段失败），但不会对外声称已登录。
  return {
    state: SESSION_UNKNOWN,
    email,
    name,
    detail: probe.meStatus
      ? probe.meStatus === 200
        ? "鉴权接口未返回预期的用户信息，未能确认会话状态"
        : `鉴权接口返回 ${probe.meStatus}，未能确认会话状态`
      : `未能验证会话状态${probe.meError ? "：" + probe.meError : ""}`,
  };
}

/**
 * 清除该 profile 的登录态，让下次打开真正回到登录页。
 * 用于“需重新认证”时的强制重登：不必删账号（备注/分组/代理配置都能保留）。
 */
export async function clearSession(context, options = {}) {
  const result = {
    ok: false,
    cookiesCleared: false,
    cookiesVerified: false,
    storageCleared: false,
    originDataCleared: false,
    targetOriginVerified: false,
    pagesParked: false,
    clearedOrigins: [],
    errors: [],
  };

  const optionObject =
    options && typeof options === "object" && !Array.isArray(options)
      ? options
      : {};
  const requestedUrl =
    typeof options === "string"
      ? options
      : optionObject.url ?? "https://chatgpt.com/";
  let targetOrigin;
  let parsedTarget;
  try {
    parsedTarget = new URL(requestedUrl);
    if (
      parsedTarget.protocol !== "https:" &&
      parsedTarget.protocol !== "http:"
    ) {
      throw new Error(`不支持的协议 ${parsedTarget.protocol}`);
    }
    targetOrigin = parsedTarget.origin;
    result.targetOrigin = targetOrigin;
  } catch (error) {
    result.errors.push(`登录站点地址无效：${String(error?.message || error)}`);
    return result;
  }

  const relatedOrigins = new Set([targetOrigin]);
  const hostname = parsedTarget.hostname.toLowerCase();
  if (
    hostname === "chatgpt.com" ||
    hostname.endsWith(".chatgpt.com") ||
    hostname === "openai.com" ||
    hostname.endsWith(".openai.com")
  ) {
    relatedOrigins.add("https://chatgpt.com");
    relatedOrigins.add("https://openai.com");
    relatedOrigins.add("https://auth.openai.com");
    relatedOrigins.add("https://auth0.openai.com");
  }
  for (const candidate of optionObject.relatedOrigins ?? []) {
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        throw new Error(`不支持的协议 ${parsed.protocol}`);
      }
      relatedOrigins.add(parsed.origin);
    } catch (error) {
      result.errors.push(
        `相关登录站点地址无效：${String(error?.message || error)}`
      );
      return result;
    }
  }

  // CDP 的 Storage.clearDataForOrigin(all) 会清 IndexedDB/CacheStorage/SW，
  // 但不会清每个 tab 独立保存的 sessionStorage。因此先清持久化数据与 SW，
  // 再让每个 tab 依次进入每个相关 origin 的本地受控响应，逐一清 sessionStorage。
  // 最后停在 about:blank，避免页面在 clearCookies 与验证之间旋转 Cookie。
  let pages = [];
  let temporaryPage = null;
  try {
    pages = context.pages().filter((page) => !page.isClosed?.());
    if (!pages.length) {
      temporaryPage = await context.newPage();
      pages = [temporaryPage];
    }

    for (const page of pages) {
      if (typeof page.url !== "function") continue;
      try {
        const observed = new URL(page.url());
        const observedHostname = observed.hostname.toLowerCase();
        if (
          observedHostname === "chatgpt.com" ||
          observedHostname.endsWith(".chatgpt.com") ||
          observedHostname === "openai.com" ||
          observedHostname.endsWith(".openai.com")
        ) {
          relatedOrigins.add(observed.origin);
        }
      } catch {}
    }

    let cdpSession;
    try {
      if (typeof context.newCDPSession !== "function") {
        throw new Error("当前浏览器不支持 CDP Storage 清理");
      }
      cdpSession = await context.newCDPSession(pages[0]);
      for (const origin of relatedOrigins) {
        await cdpSession.send("Storage.clearDataForOrigin", {
          origin,
          storageTypes: "all",
        });
        result.clearedOrigins.push(origin);
      }
      result.originDataCleared = true;
    } catch (error) {
      result.errors.push(
        `清除登录站点持久化数据失败：${String(error?.message || error)}`
      );
    } finally {
      if (cdpSession) await cdpSession.detach().catch(() => {});
    }

    let allStorageCleared = true;
    let allOriginsVerified = true;
    let allPagesParked = true;
    const nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    for (const page of pages) {
      try {
        let originIndex = 0;
        for (const origin of relatedOrigins) {
          const clearUrl = new URL(
            `/.well-known/gptkeeper-session-clear-${nonce}-${originIndex++}`,
            `${origin}/`
          ).href;
          try {
            await page.route(clearUrl, (route) =>
              route.fulfill({
                status: 200,
                contentType: "text/html",
                body: "<!doctype html><title>session clear</title>",
              })
            );
            await page.goto(clearUrl, {
              waitUntil: "domcontentloaded",
              timeout: 5_000,
            });
            const storage = await page.evaluate(() => {
              const cleared = {
                origin: location.origin,
                local: false,
                session: false,
              };
              try {
                localStorage.clear();
                cleared.local = localStorage.length === 0;
              } catch {}
              try {
                sessionStorage.clear();
                cleared.session = sessionStorage.length === 0;
              } catch {}
              return cleared;
            });
            allOriginsVerified &&= storage?.origin === origin;
            allStorageCleared &&=
              storage?.local === true && storage?.session === true;
          } catch (error) {
            allOriginsVerified = false;
            allStorageCleared = false;
            result.errors.push(
              `清除 ${origin} 页面存储失败：${String(error?.message || error)}`
            );
          } finally {
            if (typeof page.unroute === "function") {
              await page.unroute(clearUrl).catch(() => {});
            }
          }
        }
      } finally {
        if (page !== temporaryPage && !page.isClosed?.()) {
          try {
            await page.goto("about:blank", {
              waitUntil: "commit",
              timeout: 5_000,
            });
          } catch (error) {
            allPagesParked = false;
            result.errors.push(
              `暂停原登录页面失败：${String(error?.message || error)}`
            );
          }
        }
      }
    }
    result.storageCleared = allStorageCleared;
    result.targetOriginVerified = allOriginsVerified;
    result.pagesParked = allPagesParked;
  } catch (error) {
    result.errors.push(`准备目标站点存储清理失败：${String(error?.message || error)}`);
  } finally {
    if (temporaryPage) await temporaryPage.close().catch(() => {});
  }

  try {
    await context.clearCookies();
    result.cookiesCleared = true;
  } catch (error) {
    result.errors.push(`清除 Cookie 失败：${String(error?.message || error)}`);
  }

  try {
    const cookiesAfter = await context.cookies();
    result.cookiesVerified = cookiesAfter.length === 0;
    if (cookiesAfter.length) {
      const keys = cookiesAfter
        .slice(0, 5)
        .map((cookie) => `${cookie.name}@${cookie.domain}${cookie.path}`)
        .join(", ");
      result.errors.push(
        `清除后仍有 ${cookiesAfter.length} 个 Cookie 存在：${keys}`
      );
    }
  } catch (error) {
    result.errors.push(`验证 Cookie 清理结果失败：${String(error?.message || error)}`);
  }

  result.ok =
    result.cookiesCleared &&
    result.cookiesVerified &&
    result.storageCleared &&
    result.originDataCleared &&
    result.targetOriginVerified &&
    result.pagesParked;
  return result;
}
