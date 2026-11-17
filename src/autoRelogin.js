import { checkSession, clearSession, SESSION_OK, SESSION_REAUTH, SESSION_OUT } from "./health.js";
import { throwIfCancelled } from "./cancellation.js";
import { generateTotp, totpSecondsRemaining } from "./totp.js";
import { normalizeEmailAddress } from "./mail/otpParser.js";
import * as defaultLog from "./logger.js";

const CHATGPT_HOME_URL = "https://chatgpt.com/";
const CHATGPT_LOGIN_URL = "https://chatgpt.com/auth/login";
const DEFAULT_LOGIN_TIMEOUT_MS = 300_000;
const EMAIL_STEP_WAIT_MS = 25_000;
const TRANSITION_WAIT_MS = 15_000;

const EMAIL_INPUT_SELECTORS = [
  'input[type="email"]',
  'input[name="email"]',
  'input[name="username"]',
  'input[autocomplete="username"]',
  'input[id*="email" i]',
  'input[placeholder*="Email" i]',
  'input[placeholder*="邮箱"]',
];

const PASSWORD_INPUT_SELECTORS = [
  'input[type="password"]',
  'input[name="password"]',
  'input[autocomplete="current-password"]',
];

const OTP_SINGLE_INPUT_SELECTORS = [
  'input[name="code"]',
  'input[autocomplete="one-time-code"]',
  'input[id*="code" i]',
  'input[inputmode="numeric"]',
  'input[placeholder*="code" i]',
  'input[placeholder*="验证码"]',
];

const OTP_BOX_SELECTOR = 'input[maxlength="1"]';

const CONTINUE_BUTTON_SELECTORS = [
  '[role="dialog"] button[data-dd-action-name="Continue"]',
  'button[data-dd-action-name="Continue"]',
  '[role="dialog"] button[type="submit"]:not([value="resend"]):not([name*="resend" i])',
  'button:text-is("Continue")',
  'button:text-is("继续")',
  'button:text-is("続ける")',
  'button:text-is("続行")',
  'button:text-is("確認コードを送信")',
  'button:text-is("계속")',
  'button:text-is("Continuar")',
  'button:text-is("Continuer")',
  'button:text-is("Weiter")',
  'button:text-is("Verify")',
  'button:text-is("验证")',
  'button:has-text("Continue"):not(:has-text("Google")):not(:has-text("Apple")):not(:has-text("phone"))',
  'button[type="submit"]:not([value="resend"]):not([name*="resend" i])',
];

const ONE_TIME_CODE_BUTTON_SELECTORS = [
  'button[data-dd-action-name="Continue with one-time code"]',
  'button[value="passwordless_login_send_otp"]',
  'button:has-text("Continue with one-time code")',
  'button:has-text("Log in with a one-time code")',
  'button:has-text("one-time code")',
  'button:has-text("ワンタイムコード")',
  'button:has-text("일회용 코드")',
  'button:has-text("一次性代码")',
  'button:has-text("一次性验证码")',
  'button:has-text("邮箱验证码")',
  'button:has-text("código de uso único")',
  'button:has-text("código único")',
  'button:has-text("Einmalcode")',
  'a:has-text("one-time code")',
];

const RESEND_BUTTON_SELECTORS = [
  'button[value="resend"]',
  'button:has-text("Resend email")',
  'button:has-text("Resend code")',
  'button:has-text("Send a new code")',
  'button:has-text("Resend")',
  'button:has-text("重新发送")',
  'button:has-text("メールを再送信")',
  'button:has-text("Reenviar")',
  'button:has-text("Erneut senden")',
  'button:has-text("다시 보내기")',
];

const LANDING_LOGIN_BUTTON_SELECTORS = [
  '[data-testid="login-button"]',
  'button:has-text("Log in")',
  'a:has-text("Log in")',
  'button:has-text("登录")',
  'a:has-text("登录")',
  'button:has-text("ログイン")',
  'a:has-text("ログイン")',
  'button:has-text("로그인")',
  'a:has-text("로그인")',
];

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("自动重登已取消"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener?.("abort", onAbort);
      resolve();
    }, ms);
    timer.unref?.();
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("自动重登已取消"));
    };
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

/**
 * 判断巡检结果是否属于会话失效 / 401，需要自动重新登录。
 */
export function shouldAttemptAutoRelogin(statusResult) {
  if (!statusResult || typeof statusResult !== "object") return false;
  const effectiveState = statusResult.lastCheckState ?? statusResult.state ?? null;
  if (effectiveState === SESSION_OUT || effectiveState === SESSION_REAUTH) {
    return true;
  }
  const detail = String(statusResult.lastCheckDetail ?? statusResult.detail ?? "");
  if (effectiveState === "unknown") {
    return /\b401\b|token.*invalid|invalid.*token|session.*expired|unauthorized|重新登录/i.test(detail);
  }
  if (
    effectiveState === SESSION_OK &&
    statusResult.tokenStatus === "unavailable" &&
    /\b401\b|重新登录/i.test(detail)
  ) {
    return true;
  }
  return false;
}

async function findVisibleSelector(page, selectors, { requireEnabled = true } = {}) {
  for (const selector of selectors) {
    try {
      const locator = page.locator(selector).first();
      if (!(await locator.isVisible())) continue;
      if (requireEnabled && !(await locator.isEnabled().catch(() => false))) continue;
      return locator;
    } catch {
      // 忽略瞬态 DOM 切换
    }
  }
  return null;
}

async function dismissCookieBanners(page) {
  const candidates = [
    'button:has-text("Reject non-essential")',
    'button:has-text("Accept all")',
    'button:has-text("Accept")',
  ];
  const locator = await findVisibleSelector(page, candidates);
  if (locator) {
    await locator.click({ timeout: 2_000 }).catch(() => {});
  }
}

async function withTimeout(promise, ms, onTimeout) {
  let timer = null;
  try {
    return await Promise.race([
      Promise.resolve(promise),
      new Promise((resolve, reject) => {
        timer = setTimeout(() => {
          try {
            resolve(onTimeout());
          } catch (err) {
            reject(err);
          }
        }, ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function readPageSignals(page) {
  const url = String(page.url() || "");
  const frameUrls = typeof page.frames === "function"
    ? page.frames().map((frame) => String(frame.url() || "")).filter(Boolean)
    : [];

  let snapshot = { title: "", text: "", hasAuthInput: false, hasChallengeUi: false, inputsSummary: [], buttonsSummary: [] };
  try {
    const evalSnapshot = await withTimeout(
      page.evaluate(() => {
        const title = String(document.title || "");
        const bodyText = String(document.body?.innerText || "").slice(0, 4000);
        const visibleInputs = Array.from(document.querySelectorAll("input")).filter((el) => {
          const style = window.getComputedStyle(el);
          return style.display !== "none" && style.visibility !== "hidden" && !el.disabled;
        });
        const hasAuthInput = visibleInputs.some((el) => {
          const t = (el.type || "").toLowerCase();
          return t === "email" || t === "password" || t === "text" || t === "tel" || t === "number";
        });
        const inputsSummary = visibleInputs.slice(0, 6).map((el) => ({
          type: el.type || "",
          name: el.name || "",
          id: el.id || "",
          ac: el.autocomplete || "",
        }));
        const buttonsSummary = Array.from(document.querySelectorAll("button, a[role='button'], [data-testid]"))
          .filter((el) => {
            const style = window.getComputedStyle(el);
            return style.display !== "none" && style.visibility !== "hidden";
          })
          .slice(0, 8)
          .map((el) => {
            const label = String(el.innerText || el.getAttribute("aria-label") || el.getAttribute("data-testid") || "").trim().slice(0, 32);
            const dd = el.getAttribute("data-dd-action-name") || el.getAttribute("value") || "";
            return dd ? `${label}[${dd}]` : label;
          })
          .filter(Boolean);
        const hasChallengeUi = Boolean(
          document.querySelector("#challenge-running, #challenge-form, #cf-challenge-running") ||
          Array.from(document.querySelectorAll("iframe")).some((frame) => {
            const src = String(frame.src || "");
            if (!/challenges\.cloudflare\.com|arkoselabs|funcaptcha|hcaptcha|recaptcha/i.test(src)) return false;
            const rect = frame.getBoundingClientRect();
            return rect.width > 10 && rect.height > 10;
          })
        );
        const hasConnectingState = Array.from(document.querySelectorAll("button")).some((el) =>
          /connecting|conectando|carregando|wird verbunden|正在连接|読み込み|接続中/i.test(String(el.innerText || ""))
        );
        return { title, text: bodyText, hasAuthInput, hasChallengeUi, hasConnectingState, inputsSummary, buttonsSummary };
      }),
      10_000,
      () => null
    );
    if (evalSnapshot) snapshot = evalSnapshot;
  } catch {
    // 导航期间 evaluate 可能因上下文销毁报错
  }

  return { url, frameUrls, ...snapshot };
}

/**
 * 检测是否触发 Cloudflare / CAPTCHA / 人机验证；一旦检测到立即中断（绝不尝试绕过）。
 */
export function classifyHumanChallenge(signals) {
  const url = String(signals?.url || "");
  const title = String(signals?.title || "");
  const text = String(signals?.text || "");
  const combinedText = `${title}\n${text}`;

  if (/\/cdn-cgi\/challenge-platform|challenges\.cloudflare\.com/i.test(url)) {
    return "触发 Cloudflare 人机验证页，请在可见窗口使用「强制重登」手动完成";
  }
  if (
    /just a moment|attention required|verify you are human|checking your browser|잠시만 기다리십시오|しばらくお待ちください|nur einen moment|un instant|请完成以下操作|请稍候|安全验证/i.test(
      combinedText
    ) &&
    !signals?.hasAuthInput
  ) {
    return "触发人机验证 / 安全检查，请在可见窗口使用「强制重登」手动完成";
  }
  if (signals?.hasChallengeUi && !signals?.hasAuthInput) {
    return "页面展示验证码 / 人机挑战组件，请手动完成登录";
  }
  return null;
}

export function classifyBlockedAccount(signals) {
  const url = String(signals?.url || "");
  const text = String(signals?.text || "");
  if (/account_deactivated|account_deleted|account_banned/i.test(url)) {
    return "账号已被官方停用或删除，无法登录";
  }
  if (
    /your account (?:was|has been) (?:deleted|deactivated|suspended|banned)|account is deactivated|account_deactivated|账号已被(?:停用|封禁|删除)/i.test(
      text
    )
  ) {
    return "账号已被官方停用或封禁，无法登录";
  }
  return null;
}

/**
 * 识别误入新建账号（注册）流程：当账号已改邮、注销或未注册时立即中止，避免误注册空号。
 */
export function classifySignupFlow(signals) {
  const url = String(signals?.url || "");
  const text = String(signals?.text || "");
  if (
    /\/create-account\b/i.test(url) ||
    /(?:to create your account|finish creating your account|创建你的账户|创建您的帐户|アカウントを作成|계정을 만들)/i.test(
      text
    )
  ) {
    return "该邮箱在 OpenAI 进入了新建账号流程（可能已改绑邮箱、未注册或已注销），已中止重登";
  }
  return null;
}

const CHROME_NET_ERROR_RE =
  /\b(ERR_(?:CONNECTION_CLOSED|CONNECTION_RESET|CONNECTION_REFUSED|CONNECTION_ABORTED|CONNECTION_TIMED_OUT|TIMED_OUT|PROXY_CONNECTION_FAILED|TUNNEL_CONNECTION_FAILED|NAME_NOT_RESOLVED|ADDRESS_UNREACHABLE|INTERNET_DISCONNECTED|SSL_PROTOCOL_ERROR|CERT_AUTHORITY_INVALID|EMPTY_RESPONSE))\b/i;

/**
 * 检测 Chrome 断网 / 代理失败页（chrome-error://chromewebdata/ 或 ERR_*），避免白等满整个重登超时。
 */
export function classifyNetworkError(signals) {
  const url = String(signals?.url || "");
  const text = String(signals?.text || "");
  const codeMatch = text.match(CHROME_NET_ERROR_RE);
  if (/^chrome-error:\/\//i.test(url) || codeMatch) {
    const code = codeMatch?.[1]?.toUpperCase() || "CHROME_NETWORK_ERROR";
    return `无法连接登录页（${code}），请检查所选代理节点是否可用或切换节点后重试`;
  }
  return null;
}

async function clickContinue(page, fallbackInput = null) {
  for (const selector of CONTINUE_BUTTON_SELECTORS) {
    try {
      const btn = page.locator(selector).first();
      if ((await btn.isVisible()) && (await btn.isEnabled())) {
        await btn.click({ timeout: 5_000 });
        return true;
      }
    } catch {
      // 尝试下一个按钮选择器
    }
  }
  if (fallbackInput) {
    await fallbackInput.press("Enter");
    return true;
  }
  return false;
}

async function fillOtpValue(page, code, missingError = "未找到邮箱验证码输入框") {
  const splitBoxes = await page
    .evaluate(() => {
      const inputs = Array.from(document.querySelectorAll("input")).filter((el) => {
        if (el.disabled) return false;
        const style = window.getComputedStyle(el);
        return style.display !== "none" && style.visibility !== "hidden";
      });
      const singleCharInputs = inputs.filter((el) => {
        const maxLen = Number(el.getAttribute("maxlength"));
        return maxLen === 1 || el.getAttribute("data-otp-index") !== null;
      });
      return singleCharInputs.length >= 6 ? singleCharInputs.length : 0;
    })
    .catch(() => 0);

  if (splitBoxes >= 6) {
    const boxes = page.locator(`${OTP_BOX_SELECTOR}:visible`);
    const visibleCount = await boxes.count();
    if (visibleCount >= 6) {
      for (let i = 0; i < 6; i++) {
        await boxes.nth(i).fill(code[i]);
      }
      return boxes.nth(5);
    }
  }

  const single = await findVisibleSelector(page, OTP_SINGLE_INPUT_SELECTORS);
  if (!single) {
    throw new Error(missingError);
  }
  await single.fill(code);
  return single;
}

function isChatGptAppUrl(url) {
  try {
    const parsed = new URL(url);
    const isHost = parsed.hostname === "chatgpt.com" || parsed.hostname === "chat.openai.com";
    if (!isHost) return false;
    return !parsed.pathname.startsWith("/auth/");
  } catch {
    return false;
  }
}

async function waitForAuthenticatedSession(
  account,
  { page, signal, accountPlans, refreshAccountFn, checkSessionFn, pause = (ms) => sleep(ms, signal) }
) {
  const deadline = Date.now() + 40_000;
  let lastResult = null;

  while (Date.now() < deadline) {
    throwIfCancelled(signal);
    const probe = await checkSessionFn(page, { captureAccessToken: true });
    if (probe.state === SESSION_OK && probe.accessToken) {
      if (refreshAccountFn) {
        return await refreshAccountFn(account, { page, signal, accountPlans });
      }
      if (accountPlans) {
        accountPlans.saveToken(account.id, probe.email || account.email, probe.accessToken);
      }
      return {
        state: SESSION_OK,
        lastCheckState: SESSION_OK,
        lastCheckDetail: "自动重登成功，已保存 accessToken",
        tokenStatus: probe.accessToken ? "saved" : "unavailable",
        email: probe.email || account.email,
        gptName: probe.name || null,
      };
    }
    lastResult = probe;
    await pause(1_200);
  }

  if (refreshAccountFn) {
    return await refreshAccountFn(account, { page, signal, accountPlans });
  }
  return lastResult;
}

const OTP_ERROR_RE =
  /incorrect|invalid|expired|wrong code|正しくありません|無効|有効期限|código inválido|código incorrecto|ungültig|incorrecto|잘못된|만료|验证码.*(?:错误|无效|过期)|已失效/i;

async function waitAfterOtpSubmit(page, pause) {
  for (let i = 0; i < 15; i++) {
    await pause(800);
    const curUrl = String(page.url() || "");
    if (!/\/email-verification|\/otp/i.test(curUrl)) return;
    const sig = await readPageSignals(page);
    if (OTP_ERROR_RE.test(sig.text || "")) return;
    if (!sig.hasConnectingState && i >= 4) {
      const anyVisibleInput = await findVisibleSelector(
        page,
        [...OTP_SINGLE_INPUT_SELECTORS, OTP_BOX_SELECTOR],
        { requireEnabled: false }
      );
      if (!anyVisibleInput || i >= 10) return;
    }
  }
}

function attachAuthDiagnostics(page, log, accountId) {
  if (typeof page?.on !== "function") return () => {};
  const seen = new Set();
  const onResponse = (res) => {
    try {
      const status = res.status?.();
      const reqUrl = String(res.url?.() || "");
      if (
        !Number.isFinite(status) ||
        status < 400 ||
        !/chatgpt\.com\/(?:api\/auth|backend-anon\/sentinel)|auth\.openai\.com/i.test(reqUrl)
      ) {
        return;
      }
      const parsed = new URL(reqUrl);
      const method = res.request?.().method?.() || "";
      const key = `${status} ${method} ${parsed.origin}${parsed.pathname}`;
      if (!seen.has(key)) {
        seen.add(key);
        log?.warn?.(`[autoRelogin:${accountId}] http=${key}`);
      }
    } catch {
      // 忽略诊断解析异常
    }
  };
  page.on("response", onResponse);
  return () => page.off?.("response", onResponse);
}

async function submitEmailStep(page, email, state, pause, setStage) {
  setStage?.("submitting_email", "正在填写账号邮箱");
  const emailInput = await findVisibleSelector(page, EMAIL_INPUT_SELECTORS);
  if (!emailInput) return false;

  await emailInput.fill(email, { timeout: 10_000 });
  await pause(400);
  try {
    if (await emailInput.isEnabled().catch(() => false)) {
      const currentVal = await emailInput.inputValue();
      if (normalizeEmailAddress(currentVal) !== normalizeEmailAddress(email)) {
        await emailInput.fill(email, { timeout: 8_000 });
        await pause(250);
      }
    }
  } catch {
    // 忽略瞬时导航导致的元素脱离
  }

  state.otpAfterTs = Date.now() - 15_000;
  state.emailSubmitted = true;
  state.emailSubmitAttempts = (state.emailSubmitAttempts || 0) + 1;
  state.emailSubmittedAt = Date.now();
  await clickContinue(page, emailInput).catch(() => {});
  if (state.emailSubmitAttempts >= 2) {
    await pause(600);
    if (await emailInput.isVisible().catch(() => false)) {
      await emailInput.focus().catch(() => {});
      await emailInput.press("Enter").catch(() => {});
    }
  }
  return true;
}

/**
 * 执行单账号 Playwright 自动重登状态机（不涉及 Python，不绕过任何人机验证）。
 */
export async function autoReloginAccount(account, runtime = {}, options = {}) {
  const log = runtime.log ?? defaultLog;
  const signal = runtime.signal ?? null;
  const page = runtime.page;
  const setStage = runtime.setStage ?? options.setStage ?? null;
  const checkSessionFn = runtime.checkSession ?? checkSession;
  const clearSessionFn = runtime.clearSession ?? clearSession;
  const refreshAccountFn = runtime.refreshAccount ?? null;
  const accountPlans = runtime.accountPlans;
  const mailCredentials = runtime.mailCredentials ?? null;
  const sharedInboxRegistry = runtime.sharedInboxRegistry ?? null;
  const loginUrl = runtime.loginUrl || CHATGPT_LOGIN_URL;
  const homeUrl = runtime.homeUrl || CHATGPT_HOME_URL;
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS;
  const delayScale = options.delayScale ?? 1;
  const pause = (ms) => sleep(Math.max(0, Math.round(ms * delayScale)), signal);
  const force = Boolean(options.force);
  const skipInitialCheck = Boolean(options.skipInitialCheck);

  throwIfCancelled(signal);
  const targetEmail = normalizeEmailAddress(account?.email);
  if (!targetEmail || !targetEmail.includes("@")) {
    throw new Error("账号缺少有效邮箱，无法自动重登，请先在凭据设置中补充邮箱");
  }
  if (!page) {
    throw new Error("自动重登需要有效的浏览器页面");
  }

  // 1. 非强制模式下，如尚未检查过会话，先确认当前页面是否其实仍有效。
  if (!force && !skipInitialCheck) {
    setStage?.("checking", "检查现有会话是否有效");
    await page.goto(homeUrl, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {});
    const preSignals = await readPageSignals(page);
    const preNetErr = classifyNetworkError(preSignals);
    if (preNetErr) throw new Error(preNetErr);
    const challengeMsg = classifyHumanChallenge(preSignals);
    if (challengeMsg) throw new Error(challengeMsg);

    const existing = await checkSessionFn(page, { captureAccessToken: true }).catch(() => null);
    if (existing?.state === SESSION_OK && existing?.accessToken) {
      const saved = await waitForAuthenticatedSession(account, {
        page,
        signal,
        accountPlans,
        refreshAccountFn,
        checkSessionFn,
      });
      return { ok: true, alreadyLoggedIn: true, status: saved };
    }
  }

  // 2. 在清理 Cookie 之前检查凭证条件：既无密码也无接码邮箱则立刻给出清晰提示。
  const creds = mailCredentials?.getAccountCredentials?.(account.id) ?? { password: null, totpSecret: null };
  const imapConfig = mailCredentials?.getImapSecretConfig?.() ?? null;
  const inbox = imapConfig && sharedInboxRegistry ? sharedInboxRegistry.getCoordinator(imapConfig) : null;
  if (!inbox && !creds.password) {
    throw new Error("未配置接码邮箱（IMAP），且该账号未设置密码，无法自动接收登录验证码");
  }

  // 3. 清理失效的登录会话并进入登录流程（防止底层 CDP 清理偶发卡死）。
  setStage?.("clearing_session", "清理过期会话并打开登录页");
  await withTimeout(
    clearSessionFn(page.context(), { url: loginUrl, targetUrl: loginUrl }),
    25_000,
    () => {
      throw new Error("清理过期会话超时，可能是浏览器页卡住");
    }
  );
  try {
    accountPlans?.clearToken?.(account.id);
  } catch (error) {
    log.warn?.(`[autoRelogin:${account.id}] 清除旧 accessToken 失败：${String(error?.message || error)}`);
  }

  const deadline = Date.now() + timeoutMs;
  const state = {
    emailSubmitted: false,
    emailSubmitAttempts: 0,
    emailSubmittedAt: 0,
    emailPageReloaded: false,
    passwordTried: false,
    otpAttempts: 0,
    otpResentAfterTimeout: false,
    mfaAttempts: 0,
    usedOtpCodes: new Set(),
    otpAfterTs: Date.now() - 15_000,
    clickedLandingLogin: false,
    blankReloaded: false,
    networkErrorRetried: false,
    blankSince: Date.now(),
  };

  const detachAuthDiag = attachAuthDiagnostics(page, log, account.id);
  let lastDiagKey = "";
  setStage?.("loading_login", "正在打开 ChatGPT 登录页");
  await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 35_000 }).catch(() => {});

  try {
    while (Date.now() < deadline) {
      throwIfCancelled(signal);
      await dismissCookieBanners(page);

      const signals = await readPageSignals(page);
      const compactText = (signals.text || "").replace(/\s+/g, " ").trim();
      const diagKey = `${signals.url}|${signals.title}|${(signals.inputsSummary || []).map(i => i.name || i.type).join(",")}|${compactText.slice(0, 200)}`;
      if (diagKey !== lastDiagKey) {
        lastDiagKey = diagKey;
        state.blankSince = Date.now();
        log.info?.(`[autoRelogin:${account.id}] url=${signals.url} title=${JSON.stringify(signals.title)} inputs=${JSON.stringify(signals.inputsSummary || [])} buttons=${JSON.stringify(signals.buttonsSummary || [])} text=${JSON.stringify(compactText.slice(0, 240))}`);
      }

      const netError = classifyNetworkError(signals);
      if (netError) {
        if (!state.networkErrorRetried) {
          state.networkErrorRetried = true;
          state.blankSince = Date.now();
          setStage?.("loading_login", "页面连接异常，正在尝试重载登录页");
          log.warn?.(`[autoRelogin:${account.id}] 检测到网络错误页（${signals.url}），重试加载登录页`);
          if (state.emailSubmitted && !/^chrome-error:\/\//i.test(signals.url || "")) {
            await page.reload?.({ waitUntil: "domcontentloaded", timeout: 25_000 }).catch(() => {});
          } else {
            await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 25_000 }).catch(() => {});
          }
          await pause(1_500);
          continue;
        }
        throw new Error(netError);
      }

      const isBlankShell =
        !(signals.inputsSummary || []).length &&
        !(signals.buttonsSummary || []).length &&
        !(signals.text || "").trim();
      if (!isBlankShell || isChatGptAppUrl(signals.url)) {
        state.blankSince = Date.now();
      } else if (!state.emailSubmitted && Date.now() - state.blankSince > 20_000) {
        if (!state.blankReloaded) {
          state.blankReloaded = true;
          state.blankSince = Date.now();
          log.info?.(`[autoRelogin:${account.id}] 页面长时间空白，尝试重载登录页`);
          await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {});
          await pause(1_500);
          continue;
        }
        throw new Error("登录页长时间未完成加载，可能是当前代理节点响应异常");
      } else if (state.emailSubmitted && Date.now() - state.blankSince > 35_000) {
        throw new Error("OpenAI 授权页长时间空白，可能是当前代理节点响应异常");
      }
      const challenge = classifyHumanChallenge(signals);
      if (challenge) {
        throw new Error(challenge);
      }
      const blocked = classifyBlockedAccount(signals);
      if (blocked) {
        throw new Error(blocked);
      }
      const signupFlow = classifySignupFlow(signals);
      if (signupFlow) {
        throw new Error(signupFlow);
      }

      const url = signals.url || "";

      // 登录已完成并跳回 ChatGPT 主站（且已发起过登录流，或明确不再是 auth 路径）。
      if (state.emailSubmitted && isChatGptAppUrl(url)) {
        setStage?.("verifying_session", "正在确认新会话与 accessToken");
        const status = await waitForAuthenticatedSession(account, {
          page,
          signal,
          accountPlans,
          refreshAccountFn,
          checkSessionFn,
          pause,
        });
        if (status?.state === SESSION_OK && status?.tokenStatus !== "unavailable") {
          log.info?.(`[autoRelogin] 账号 ${targetEmail} 自动重登成功`);
          return { ok: true, alreadyLoggedIn: false, status };
        }
        state.blankSince = Date.now();
        // 某些登录会短暂闪烁回首页再跳转授权回调
        if (Date.now() + 5_000 >= deadline) {
          throw new Error(status?.lastCheckDetail || "登录后仍未能确认会话或获取 accessToken");
        }
        await pause(1_500);
        continue;
      }

      // auth.openai.com/workspace 或团队工作区选择页
      if (/\/workspace/i.test(url)) {
        setStage?.("selecting_workspace", "选择工作区并继续");
        const personalBtn = await findVisibleSelector(page, [
          'button:has-text("Personal")',
          'button:has-text("个人")',
          '[data-testid*="workspace"] button',
          ...CONTINUE_BUTTON_SELECTORS,
        ]);
        if (personalBtn) {
          await personalBtn.click({ timeout: 5_000 }).catch(() => {});
          await pause(1_200);
          continue;
        }
      }

      // 1) OTP 验证码输入页
      const onOtpUrl = /\/email-verification|\/otp/i.test(url);
      const otpInput = onOtpUrl
        ? await findVisibleSelector(page, [...OTP_SINGLE_INPUT_SELECTORS, OTP_BOX_SELECTOR])
        : null;
      if (onOtpUrl || (state.emailSubmitted && otpInput && !/mfa|totp/i.test(url))) {
        state.emailSubmitted = true;
        if (state.otpAttempts >= 3) {
          throw new Error("邮箱验证码多次校验失败，请检查账号或接码邮箱状态");
        }
        if (!inbox) {
          throw new Error("OpenAI 要求邮箱验证码，但尚未配置 IMAP 接码邮箱");
        }

        if (!otpInput) {
          await pause(600);
          continue;
        }

        // 若已提交过验证码且过渡等待后仍停留在 OTP 页，记录提示并点击重发，避免空等第二封邮件
        if (state.otpAttempts > 0 && state.otpAttempts > (state.otpResentCountAtAttempt || 0)) {
          state.otpResentCountAtAttempt = state.otpAttempts;
          log.warn?.(
            `[autoRelogin:${account.id}] 提交第 ${state.otpAttempts} 次验证码后仍停留验证页 text=${JSON.stringify(
              compactText.slice(0, 160)
            )}`
          );
          const resendBtn = await findVisibleSelector(page, RESEND_BUTTON_SELECTORS);
          if (resendBtn) {
            state.otpAfterTs = Date.now() - 5_000;
            await resendBtn.click({ timeout: 5_000 }).catch(() => {});
            await pause(1_000);
          }
        }

        const isIcloudTarget = targetEmail.endsWith("@icloud.com");
        const waitOnce = (waitMs) =>
          inbox.waitForOtp({
            email: targetEmail,
            afterTs: state.otpAfterTs,
            excludeCodes: state.usedOtpCodes,
            timeoutMs: Math.min(waitMs, Math.max(15_000, deadline - Date.now())),
            settleMs: Math.round(2_000 * delayScale),
            signal,
          });

        setStage?.("waiting_otp", `等待邮箱 ${targetEmail} 接收验证码（第 ${state.otpAttempts + 1} 次）`);
        let code;
        try {
          code = await waitOnce(isIcloudTarget ? 120_000 : 90_000);
        } catch (err) {
          const canResendOnTimeout =
            (err?.code === "OTP_TIMEOUT" || /验证码超时/.test(err?.message || "")) &&
            !state.otpResentAfterTimeout &&
            deadline - Date.now() >= 25_000;
          const resendBtn = canResendOnTimeout
            ? await findVisibleSelector(page, RESEND_BUTTON_SELECTORS)
            : null;
          if (!resendBtn) throw err;

          state.otpResentAfterTimeout = true;
          // 首次邮件可能只是投递延迟，保留原 otpAfterTs（搭配 excludeCodes 防重复），避免迟到首封被过滤掉
          setStage?.("waiting_otp", `首次等待超时，点击重发并继续等待 ${targetEmail}`);
          await resendBtn.click({ timeout: 5_000 }).catch(() => {});
          await pause(1_200);
          code = await waitOnce(isIcloudTarget ? 110_000 : 80_000);
        }
        state.usedOtpCodes.add(code);
        state.otpAttempts += 1;

        setStage?.("submitting_otp", "正在填入邮箱验证码");
        const targetInput = await fillOtpValue(page, code);
        await pause(300);
        await clickContinue(page, targetInput);
        await waitAfterOtpSubmit(page, pause);
        continue;
      }

      // 2) MFA / TOTP 两步验证页
      if (/\/mfa|\/totp/i.test(url)) {
        if (!creds.totpSecret) {
          throw new Error("该账号开启了两步验证（TOTP），请先配置 TOTP 密钥或手动登录");
        }
        if (state.mfaAttempts >= 2) {
          throw new Error("TOTP 动态验证码校验失败，请核对密钥是否正确");
        }
        const mfaReadyInput = await findVisibleSelector(page, [...OTP_SINGLE_INPUT_SELECTORS, OTP_BOX_SELECTOR]);
        if (!mfaReadyInput) {
          await pause(600);
          continue;
        }
        if (delayScale >= 1 && totpSecondsRemaining() <= 3) {
          setStage?.("waiting_totp", "等待下一个 30 秒 TOTP 周期");
          await pause((totpSecondsRemaining() + 1) * 1000);
        }
        const mfaCode = generateTotp(creds.totpSecret);
        state.mfaAttempts += 1;
        setStage?.("submitting_totp", "正在填入两步验证码");
        const mfaInput = await fillOtpValue(page, mfaCode, "未找到两步验证码输入框");
        await pause(300);
        await clickContinue(page, mfaInput);
        await pause(3_500);
        continue;
      }

      // 3) 密码页（可选填密码或切换一次性验证码）
      const passwordInput = await findVisibleSelector(page, PASSWORD_INPUT_SELECTORS);
      if (passwordInput || /\/log-in\/password/i.test(url)) {
        state.emailSubmitted = true;
        // 密码页刚导航过来时 DOM 可能仍在渲染（inputs=[] & buttons=[]），避免水合瞬间误报缺少入口
        if (
          !passwordInput &&
          (signals.buttonsSummary?.length || 0) === 0 &&
          Date.now() - state.emailSubmittedAt < 25_000
        ) {
          await pause(800);
          continue;
        }
        const hasPasswordError = /incorrect email or password|invalid_auth_step|wrong email or password|密码.*错误/i.test(
          signals.text || ""
        );
        if (creds.password && !state.passwordTried && !hasPasswordError && passwordInput) {
          setStage?.("submitting_password", "正在输入账号密码");
          state.passwordTried = true;
          state.otpAfterTs = Date.now() - 15_000;
          await passwordInput.fill(creds.password);
          await pause(250);
          await clickContinue(page, passwordInput);
          await pause(2_200);
          continue;
        }

        const otpSwitchBtn = await findVisibleSelector(page, ONE_TIME_CODE_BUTTON_SELECTORS);
        if (otpSwitchBtn) {
          setStage?.("switching_otp", "切换到邮箱一次性验证码登录");
          state.otpAfterTs = Date.now() - 15_000;
          await otpSwitchBtn.click({ timeout: 5_000 });
          await pause(1_500);
          continue;
        }

        if (hasPasswordError) {
          throw new Error("账号密码错误且无一次性验证码入口，请更新密码或手动登录");
        }
        throw new Error("该账号停留在密码页且未提供密码或一次性验证码入口");
      }

      // 4) 邮箱输入页（提交后处于 Connecting… 或 disabled 状态时等待跳转，不重复覆盖）
      const emailInput = !signals.hasConnectingState
        ? await findVisibleSelector(page, EMAIL_INPUT_SELECTORS)
        : null;
      if (emailInput) {
        if (state.emailSubmitted && Date.now() - state.emailSubmittedAt > 15_000 && !/\/email-verification/i.test(url)) {
          if (state.emailSubmitAttempts >= 3) {
            throw new Error("提交账号邮箱后页面多次未跳转，可能是当前代理节点响应异常");
          }
          if (state.emailSubmitAttempts === 1 && !state.emailPageReloaded) {
            state.emailPageReloaded = true;
            state.emailSubmitted = false;
            state.blankSince = Date.now();
            log.warn?.(`[autoRelogin:${account.id}] 提交邮箱后未跳转，重载登录页重试`);
            await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {});
            await pause(1_200);
            continue;
          }
          await submitEmailStep(page, targetEmail, state, pause, setStage);
          await pause(Math.min(2_000, TRANSITION_WAIT_MS));
          continue;
        }
        if (!state.emailSubmitted) {
          await submitEmailStep(page, targetEmail, state, pause, setStage);
          await pause(Math.min(2_000, TRANSITION_WAIT_MS));
          continue;
        }
      }

      // 5) ChatGPT 未登录首页，需先点击登录按钮跳往 auth.openai.com
      if (!state.emailSubmitted && !state.clickedLandingLogin && isChatGptAppUrl(url)) {
        const loginBtn = await findVisibleSelector(page, LANDING_LOGIN_BUTTON_SELECTORS);
        if (loginBtn) {
          state.clickedLandingLogin = true;
          await loginBtn.click({ timeout: 5_000 }).catch(() => {});
          await pause(1_500);
          continue;
        }
      }

      await pause(Math.min(1_000, EMAIL_STEP_WAIT_MS));
    }

    throw new Error(`自动重登超时（${Math.round(timeoutMs / 1000)} 秒），未能完成登录`);
  } finally {
    detachAuthDiag();
  }
}
