import { preSendPauseMs } from "./humanize.js";
import { raceSignal, throwIfCancelled } from "./cancellation.js";
import * as log from "./logger.js";

function selectorList(value) {
  const candidates = Array.isArray(value) ? value : value == null ? [] : [value];
  return candidates.filter((candidate) => typeof candidate === "string" && candidate.trim());
}

function combinedSelector(value) {
  return selectorList(value).join(", ");
}

const MEMORY_NUX_SELECTOR = "#modal-m3m-nux";
const LOGGED_OUT_SELECTOR = "#modal-no-auth-login, [data-testid='login-button']";

async function hasVisible(page, selector) {
  const handles = await page.$$(selector);
  for (const handle of handles) {
    if (await handle.isVisible()) return true;
  }
  return false;
}

async function throwIfLoginRequired(page) {
  if (await hasVisible(page, LOGGED_OUT_SELECTOR)) {
    const error = new Error("ChatGPT 页面已要求登录，请在账号页点击“重新登录”");
    error.code = "LOGIN_REQUIRED";
    error.needReauth = true;
    throw error;
  }
}

async function dismissMemoryNux(page) {
  const modal = await page.$(MEMORY_NUX_SELECTOR);
  if (!modal || !(await modal.isVisible())) return;
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  if (await modal.isVisible()) {
    throw new Error("ChatGPT Memory 功能引导窗口未能关闭");
  }
  log.info("已关闭 ChatGPT Memory 功能引导弹窗");
}

/**
 * 在一组候选选择器里返回第一个可见的元素句柄。
 */
export async function firstVisible(page, candidates, timeout = 8000) {
  const selectors = selectorList(candidates);
  if (!selectors.length) throw chatError("INVALID_SELECTORS", "没有配置可用的元素选择器");
  // Wait once for any visible candidate. An absent legacy selector must not
  // consume seconds before we inspect an already-ready modern composer.
  await page.locator(combinedSelector(selectors)).filter({ visible: true }).first()
    .waitFor({ state: "visible", timeout });
  // Keep configured preference when several candidates are present. These are
  // immediate queries, with no separate timeout for each missing selector.
  for (const sel of selectors) {
    for (const el of await page.$$(sel)) {
      if (await el.isVisible()) return el;
    }
  }
  throw new Error(`未找到可见元素，候选: ${selectors.join(" | ")}`);
}

/**
 * 确认账号已登录。明确显示登录入口时返回 false；否则再以输入框作为正向证据。
 */
export async function ensureLoggedIn(page, selectors) {
  if (await hasVisible(page, LOGGED_OUT_SELECTOR)) return false;
  try {
    await firstVisible(page, selectors.loginIndicators, 10000);
    return true;
  } catch {
    return false;
  }
}

/** A single DOM snapshot avoids mixing nodes from different React renders. */
export async function readConversationState(page, selectors, options = {}) {
  const { signal, timeoutMs = 10_000, latestOnly = false } = options;
  throwIfCancelled(signal);
  if (page.isClosed?.()) throw chatError("PAGE_CLOSED", "对话页面已关闭，无法继续读取回复");
  if (!(timeoutMs > 0) || !Number.isFinite(timeoutMs)) throw new TypeError("DOM read timeout must be finite and positive");
  const reading = page.evaluate(({ assistant, user, stop, composer, login, latestOnly }) => {
    // Cache only within this synchronous snapshot, never across React renders.
    const styles = new Map();
    const visibility = new Map();
    const styleOf = (node) => {
      if (!styles.has(node)) styles.set(node, getComputedStyle(node));
      return styles.get(node);
    };
    const hasBox = (rects) => [...rects].some((rect) => rect.width > 0 && rect.height > 0);
    const textVisible = (node) => {
      const range = document.createRange();
      range.selectNodeContents(node);
      return hasBox(range.getClientRects());
    };
    const visible = (node) => {
      if (visibility.has(node)) return visibility.get(node);
      if (!node?.isConnected) return false;
      const style = styleOf(node);
      if (style.visibility !== "visible" || style.display === "none") return false;
      // display:contents has no box of its own. Its visible children still form
      // a message; filtering solely on the wrapper's rects discards every turn.
      const result = hasBox(node.getClientRects()) || (style.display === "contents" && [...node.childNodes].some((child) =>
        child.nodeType === Node.TEXT_NODE ? textVisible(child)
          : child.nodeType === Node.ELEMENT_NODE && visible(child)));
      visibility.set(node, result);
      return result;
    };
    const renderedText = (node) => {
      // innerText on a layoutless wrapper falls back to textContent, including
      // hidden drafts. Read visible descendants while retaining block breaks.
      if (styleOf(node).display !== "contents") return node.innerText ?? "";
      return [...node.childNodes].map((child) => {
        if (child.nodeType === Node.TEXT_NODE) return textVisible(child) ? child.textContent : "";
        if (child.nodeType !== Node.ELEMENT_NODE || !visible(child)) return "";
        const text = renderedText(child);
        const display = styleOf(child).display;
        return display === "contents" || display.startsWith("inline") ? text : `\n${text}\n`;
      }).join("");
    };
    const query = (selector) => selector ? [...document.querySelectorAll(selector)] : [];
    const messages = (raw) => {
      const nodes = raw.filter(visible);
      // A fallback article and its role-marked child represent the same message.
      return nodes.filter((node) => !nodes.some((child) => child !== node && node.contains(child)));
    };
    const unitSelector = "[data-content-search-unit-key], [data-chatgpt-search-unit-key]";
    const identity = (node) => {
      const owner = node.closest(`[data-message-id], [data-turn-id], [data-testid^='conversation-turn-'], ${unitSelector}, [data-turn-key]`);
      return owner?.getAttribute("data-message-id") || owner?.getAttribute("data-turn-id") ||
        owner?.getAttribute("data-testid") || owner?.getAttribute("data-content-search-unit-key") ||
        owner?.getAttribute("data-chatgpt-search-unit-key") || owner?.getAttribute("data-turn-key") || null;
    };
    const rawUsers = query(user);
    const rawReplies = query(assistant);
    const users = messages(rawUsers);
    const lastUser = users.at(-1);
    const replyNodes = messages(rawReplies);
    const streaming = (node) => node.matches("[data-is-streaming='true'], [aria-busy='true']") ||
      !!node.querySelector("[data-is-streaming='true'], [aria-busy='true']");
    // The pre-send baseline includes every old message. Polling only compares
    // the newest pair, so do not re-extract all historical answer bodies at 2 Hz.
    const replies = (latestOnly ? replyNodes.slice(-1) : replyNodes).map((node) => {
      const bodySelector = ".markdown, [data-markdown-text-style='assistant-message']";
      const markdown = [
        ...(node.matches(bodySelector) ? [node] : []), ...node.querySelectorAll(bodySelector),
      ].filter(visible);
      const roots = markdown.filter((part) => !markdown.some((parent) => parent !== part && parent.contains(part)));
      return {
        id: identity(node),
        // New role markers can be headings beside the answer. Never return the
        // heading, activity panel or shared user+assistant turn as answer text.
        text: (roots.length ? roots.map(renderedText).join("\n")
          : node.closest(unitSelector) ? "" : renderedText(node)).trim(),
        afterUser: !!lastUser && !!(lastUser.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING),
        streaming: streaming(node),
      };
    });
    const input = query(composer).find(visible);
    const alerts = query("[role='alert'], [data-testid='conversation-turn-error']")
      .filter(visible).map((node) => renderedText(node).trim());
    const error = alerts.find((text) => /something went wrong|error (?:occurred|generating)|network error|too many requests|usage limit|达到.{0,12}上限|出了点问题|发生错误|网络错误|请求过多/i.test(text));
    return {
      replies,
      users: (latestOnly ? users.slice(-1) : users).map((node) => ({ id: identity(node), text: renderedText(node).trim() })),
      assistantCount: replyNodes.length,
      userCount: users.length,
      generating: query(stop).some(visible) || replyNodes.some(streaming),
      composerText: input ? (input.value ?? input.innerText ?? "").trim() : null,
      loginRequired: query(login).some(visible),
      error: error?.slice(0, 300) ?? null,
      // Structural evidence only: never log messages, cookies or the chat URL.
      dom: {
        rawAssistantCount: rawReplies.length,
        rawUserCount: rawUsers.length,
        layoutlessAssistantCount: rawReplies.filter((node) => styleOf(node).display === "contents").length,
        layoutlessUserCount: rawUsers.filter((node) => styleOf(node).display === "contents").length,
        turnCount: query("[data-testid^='conversation-turn-'], [data-turn-key]").length,
        searchUnitCount: query(unitSelector).length,
        markdownCount: query(".markdown, [data-markdown-text-style='assistant-message']").filter(visible).length,
        frameCount: document.querySelectorAll("iframe").length,
        readyState: document.readyState,
        visibility: document.visibilityState,
        pageKind: /^\/c\//.test(location.pathname) ? "conversation" : location.pathname === "/" ? "new-chat" : "other",
      },
    };
  }, {
    assistant: combinedSelector(selectors.assistantMessage),
    user: combinedSelector(selectors.userMessage || [
      "[data-message-author-role='user']", "[data-turn='user']",
      "[data-content-search-unit-key$=':user']", "[data-chatgpt-search-unit-key$=':user']", "[data-user-message-bubble]",
    ]),
    stop: combinedSelector(selectors.stopButton),
    composer: combinedSelector(selectors.composer),
    login: LOGGED_OUT_SELECTOR,
    latestOnly,
  });
  // evaluate has no Playwright action timeout. A frozen renderer must not keep
  // the account locked indefinitely before the polling loop checks its budget.
  let timer;
  try {
    return await raceSignal(Promise.race([
      reading,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(chatError("PAGE_READ_TIMEOUT", "读取对话页面超时，浏览器页面未响应", {
          stage: "reading-page", readTimeoutMs: timeoutMs,
        })), timeoutMs);
      }),
    ]), signal);
  } finally {
    clearTimeout(timer);
  }
}

function chatError(code, message, diagnostics) {
  return Object.assign(new Error(message), { code, diagnostics });
}

function isNewMessage(message, previous) {
  if (!message) return false;
  return message.id
    ? !previous.some((old) => old.id === message.id)
    : !previous.some((old) => old.text === message.text);
}

function replyTimeoutError(reply, diagnostics) {
  if (!diagnostics.accepted) return chatError("MESSAGE_NOT_SUBMITTED", "发送未确认：未出现本轮用户消息或生成状态，未自动重发以避免重复提交", diagnostics);
  if (!reply) return chatError("REPLY_NOT_FOUND", "消息已提交，但发送后未检测到新的回复（可能生成缓慢或回复选择器已变化）", diagnostics);
  if (!reply.text && !diagnostics.generating) return chatError("REPLY_EMPTY", "新的回复内容为空", diagnostics);
  return chatError("RESPONSE_TIMEOUT", "回复生成或稳定等待超时，未将未完成内容记为成功", diagnostics);
}

/** Only the reply belonging to this submission may satisfy completion. */
export async function waitForReply(page, selectors, before, options = {}) {
  const { signal, timeoutMs = 180_000, acknowledgementMs = 15_000, pollMs = 500,
    stableMs = 3000, fallbackStableMs = 5000, readTimeoutMs = timeoutMs, timing = {} } = options;
  const startedAt = Date.now();
  let accepted = false;
  let sawGenerating = false;
  let lastText = "";
  let wasIdle = false;
  let idleSince = null;
  let state = before;
  let reply = null;
  let diagnostics = { stage: "waiting-submit", accepted: false };
  timing.firstReplyMs = null;
  timing.domReadMs = 0;
  timing.maxDomReadMs = 0;
  timing.domReads = 0;
  // The iteration bound also makes a stalled/fake clock unable to wait forever.
  if (!(pollMs > 0) || !Number.isFinite(pollMs) || !(timeoutMs >= 0) || !Number.isFinite(timeoutMs)) {
    throw new TypeError("reply timeout and polling interval must be finite and non-negative (polling > 0)");
  }
  for (let elapsed = 0; ; elapsed += pollMs) {
    throwIfCancelled(signal);
    const remainingMs = timeoutMs - Math.max(elapsed, Date.now() - startedAt);
    if (remainingMs <= 0 && elapsed > 0) {
      throw replyTimeoutError(reply, { ...diagnostics, elapsedMs: timeoutMs - remainingMs });
    }
    const readStarted = Date.now();
    let navigated = false;
    try {
      state = await readConversationState(page, selectors, {
        signal, latestOnly: true,
        timeoutMs: Math.max(1, Math.min(readTimeoutMs, remainingMs)),
      });
    } catch (error) {
      // A read shortened by the reply budget is not evidence that the renderer
      // exceeded its own read deadline. Preserve the last known response stage.
      if (error.code === "PAGE_READ_TIMEOUT" && remainingMs <= readTimeoutMs) {
        throw replyTimeoutError(reply, { ...diagnostics, elapsedMs: Math.max(timeoutMs, Date.now() - startedAt) });
      }
      if (/Execution context was destroyed|Cannot find context with specified id/.test(error.message)) {
        // A submitted first message can navigate to its conversation URL.
        // The rejected read is over; inspect the new document without resending.
        navigated = true;
        wasIdle = false;
      } else {
        throw error;
      }
    } finally {
      const readMs = Date.now() - readStarted;
      timing.domReads++;
      timing.domReadMs += readMs;
      timing.maxDomReadMs = Math.max(timing.maxDomReadMs, readMs);
    }
    if (navigated) {
      await raceSignal(page.waitForTimeout(pollMs), signal);
      continue;
    }
    const newUser = isNewMessage(state.users.at(-1), before.users);
    const last = state.replies.at(-1);
    const freshReply = last && (!newUser || last.afterUser) && (last.id
      ? isNewMessage(last, before.replies)
      : isNewMessage(last, before.replies) || (newUser && last.afterUser));
    reply = freshReply ? last : null;
    if (reply?.text && timing.firstReplyMs === null) timing.firstReplyMs = Date.now() - startedAt;
    accepted ||= newUser || state.generating || !!reply;
    sawGenerating ||= state.generating;
    const waited = Math.max(elapsed, Date.now() - startedAt);
    diagnostics = {
      stage: accepted ? "waiting-reply" : "waiting-submit",
      accepted, sawGenerating, generating: state.generating,
      assistantCount: state.assistantCount ?? state.replies.length,
      userCount: state.userCount ?? state.users.length, replyLength: reply?.text.length ?? 0,
      composerHasText: !!state.composerText, elapsedMs: waited,
      ...(state.dom ? { dom: state.dom } : {}),
    };
    if (state.loginRequired) {
      throw Object.assign(chatError("LOGIN_REQUIRED", "ChatGPT 页面已要求登录，请在账号页点击“重新登录”", diagnostics), { needReauth: true });
    }
    if (state.error) throw chatError("CHAT_PAGE_ERROR", `ChatGPT 页面提示：${state.error}`, diagnostics);
    if (reply?.text && !state.generating) {
      if (!wasIdle || reply.text !== lastText) idleSince = waited;
      // DOM reads and timer delays are part of the observed stable interval.
      // Counting only pollMs stretches a 3 s check to 15+ s on a slow renderer.
      if (waited - idleSince >= (sawGenerating ? stableMs : fallbackStableMs)) {
        timing.completionWaitMs = waited - idleSince;
        return reply.text;
      }
    }
    lastText = reply?.text ?? "";
    wasIdle = !!reply?.text && !state.generating;
    if (!accepted && waited >= acknowledgementMs) {
      throw chatError("MESSAGE_NOT_SUBMITTED", "发送未确认：未出现本轮用户消息或生成状态，未自动重发以避免重复提交", diagnostics);
    }
    if (waited >= timeoutMs) {
      throw replyTimeoutError(reply, diagnostics);
    }
    await raceSignal(page.waitForTimeout(pollMs), signal);
  }
}

/** Fill, submit exactly once, then wait for acknowledgement and this turn's reply. */
export async function sendPrompt(page, selectors, prompt, options = {}) {
  const { signal, timing = {} } = options;
  const startedAt = Date.now();
  timing.stage = "preparing";
  throwIfCancelled(signal);
  await raceSignal(dismissMemoryNux(page), signal);
  await raceSignal(throwIfLoginRequired(page), signal);
  const composer = await raceSignal(firstVisible(page, selectors.composer, 15000), signal);
  const before = await readConversationState(page, selectors, { signal });
  if (before.generating) throw chatError("CHAT_BUSY", "上一轮仍在生成，未发送新的问题");
  timing.prepareMs = Date.now() - startedAt;
  timing.stage = "submitting";
  const submitStartedAt = Date.now();
  // fill handles textarea/contenteditable and multiline prompts without Enter submitting
  // half a prompt. It also replaces any draft left behind by a previous failed send.
  await raceSignal(composer.fill(prompt), signal);
  // Let the editor commit its input during the existing human pause. Checking
  // synchronously after fill can observe a transient empty editor; checking
  // afterwards also catches a draft that React reset before submission.
  timing.preSendPauseMs = preSendPauseMs();
  await raceSignal(page.waitForTimeout(timing.preSendPauseMs), signal);
  const filled = await raceSignal(composer.evaluate((node) => node.value ?? node.innerText ?? ""), signal);
  // contenteditable paragraphs may render a blank line as two or three newlines.
  const normalize = (value) => value.replace(/\s+/g, " ").trim();
  if (normalize(filled) !== normalize(prompt)) {
    throw chatError("COMPOSER_INPUT_MISMATCH", "输入框内容与本轮问题不一致，未发送消息", {
      stage: "checking-input", expectedLength: normalize(prompt).length, actualLength: normalize(filled).length,
    });
  }
  let sent = false;
  // React may need a moment after input before enabling send. Check every candidate,
  // including visibility; a hidden enabled button must never consume the click timeout.
  for (let attempt = 0; attempt < 20 && !sent; attempt++) {
    throwIfCancelled(signal);
    for (const sel of selectorList(selectors.sendButton)) {
      const buttons = await raceSignal(page.$$(sel), signal);
      for (const button of buttons) {
        if (await button.isVisible() && await button.isEnabled()) {
          // Our own reply loop confirms submission. Playwright's additional
          // navigation wait can time out after the click already succeeded.
          await raceSignal(button.click({ timeout: 5000, noWaitAfter: true }), signal);
          sent = true;
          break;
        }
      }
      if (sent) break;
    }
    if (!sent) await raceSignal(page.waitForTimeout(250), signal);
  }
  if (!sent) {
    throwIfCancelled(signal);
    await raceSignal(composer.press("Enter", { noWaitAfter: true }), signal);
  }
  timing.submitMs = Date.now() - submitStartedAt;
  timing.stage = "waiting-reply";
  const replyStartedAt = Date.now();
  try {
    const reply = await waitForReply(page, selectors, before, { ...options, timing });
    timing.stage = "completed";
    return reply;
  } finally {
    timing.replyWaitMs = Date.now() - replyStartedAt;
  }
}

/** Navigate once to a new thread and wait for the composer. */
export async function startNewChat(page, selectors, options = {}) {
  const { signal } = options;
  throwIfCancelled(signal);
  await raceSignal(page.goto(selectors.newChatUrl || selectors.url, { waitUntil: "domcontentloaded" }), signal);
  await raceSignal(firstVisible(page, selectors.composer, 15000), signal);
}

// 追问链条的问题长度上限。模型偶尔会把整段解释接在前缀后面，原样发出去既不像
// 真人提问，也可能超出输入框承受范围。
const NEXT_QUESTION_MAX_LENGTH = 500;

// 讲解 Markdown 或 prompt 模板时，模型会把"下一个问题："写进代码块当占位符。
// 照抄进去会让下一轮问出与主题无关的假问题，所以先把代码内容挖空——保留换行
// 以维持行结构，这样后面的行号与匹配位置仍与原文一致。
function stripCodeSpans(text) {
  return text
    .replace(/(```|~~~)[\s\S]*?(?:\1|$)/g, (block) => block.replace(/[^\n]/g, " "))
    .replace(/(`+)[^\n]*?\1/g, (span) => " ".repeat(span.length));
}

// 剥掉包裹问题的 Markdown 强调与成对引号。模型给的前缀经常是 **下一个问题：**，
// 星号既可能只跟着前缀，也可能把整行包起来。
// 引号在外、强调在内（「**问题？**」）时单趟剥不干净：去掉引号后才露出星号。
// 三趟足够覆盖实际见过的嵌套深度，且到达不动点后继续剥也不会改变结果。
function unwrapQuestion(raw) {
  let text = raw.trim();
  for (let i = 0; i < 3; i++) {
    text = text
      .replace(/^\*{1,3}/, "")
      .replace(/\*{1,3}$/, "")
      .replace(/^_{1,3}/, "")
      .replace(/_{1,3}$/, "")
      .trim();
    // 只在确实成对时剥引号，避免把问题里真正的引号吃掉。
    const quotes = [
      ['"', '"'],
      ["'", "'"],
      ["「", "」"],
      ["『", "』"],
      ["“", "”"],
      ["‘", "’"],
    ];
    for (const [open, close] of quotes) {
      if (text.length >= open.length + close.length && text.startsWith(open) && text.endsWith(close)) {
        text = text.slice(open.length, -close.length).trim();
      }
    }
  }
  return text;
}

/**
 * 从 GPT 回答里抽取“下一个问题”。约定 GPT 在末尾输出：
 *   下一个问题：xxx   /   下一个问题: xxx   /   Next question: xxx
 *
 * 前缀允许带 Markdown 标题、列表、引用和强调标记；代码块与行内代码里的同名
 * 前缀会被忽略。多次出现时取最后一个——多轮对话里模型会复述上一轮的问题，
 * 真正的追问在末尾。抽不到时返回 null，由上层决定是否结束本轮对话。
 */
export function extractNextQuestion(replyText) {
  if (typeof replyText !== "string" || !replyText.trim()) return null;

  const searchable = stripCodeSpans(replyText);
  // 前缀后到行尾为止：跨行的问题只取首行，后续解释不吞进来。
  const pattern = /(?:下一个问题|下一问|next\s+question)\s*[:：]\s*([^\n]*)/gi;

  let candidate = null;
  for (const match of searchable.matchAll(pattern)) {
    const question = unwrapQuestion(match[1] ?? "");
    if (question) candidate = question;
  }
  if (!candidate) return null;

  return candidate.length > NEXT_QUESTION_MAX_LENGTH
    ? candidate.slice(0, NEXT_QUESTION_MAX_LENGTH).trim()
    : candidate;
}
