/**
 * 清理持久化 Session 是不可逆操作，只响应严格的显式确认。
 * Web 与 CLI 共用此策略，避免某条登录入口重新引入自动清理。
 */
export function shouldClearSessionBeforeLogin(opts = {}) {
  return opts.force === true;
}

/**
 * 登录前统一处理现有会话。
 *
 * 强制重登必须先清理，不能先做一次可能耗时的健康检查；清理操作必须返回
 * 可验证的成功结果，且刷新后仍是 ok 时绝不能把旧会话当成一次新登录。
 * 依赖由调用方传入，CLI 与 Web 登录共用同一条不可逆操作策略。
 */
export async function prepareSessionForLogin({
  opts = {},
  context,
  page,
  url,
  checkSession,
  clearSession,
  onCleared,
}) {
  if (!shouldClearSessionBeforeLogin(opts)) {
    return {
      forced: false,
      clearResult: null,
      current: await checkSession(page),
    };
  }

  const clearResult = await clearSession(context, { url });
  if (!clearResult?.ok) {
    const reportedDetail = Array.isArray(clearResult?.errors)
      ? clearResult.errors.filter(Boolean).join("；")
      : "";
    const detail = reportedDetail || "未返回可验证的清理结果";
    const error = new Error(`强制重登未能完整清除旧登录态：${detail}`);
    error.code = "SESSION_CLEAR_FAILED";
    error.clearResult = clearResult;
    throw error;
  }

  // 清理一旦成功，旧登录结论就已失效；先通知调用方落缓存，再做可能失败
  // 的网络导航。导航错误必须上抛，否则页面停在 about:blank 会白等五分钟。
  if (onCleared) await onCleared(clearResult);
  await page.goto(url, { waitUntil: "domcontentloaded" });
  const current = await checkSession(page);
  if (current?.state === "ok") {
    const error = new Error(
      "强制重登清理后旧会话仍然有效，已停止本次登录，避免误报成功"
    );
    error.code = "SESSION_CLEAR_STILL_AUTHENTICATED";
    error.clearResult = clearResult;
    throw error;
  }

  return { forced: true, clearResult, current };
}
