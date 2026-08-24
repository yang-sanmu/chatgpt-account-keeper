import { preSendPauseMs, typingDelayMs } from "./humanize.js";
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
export async function firstVisible(page, selectorList, timeout = 8000) {
  const selectors = Array.isArray(selectorList) ? selectorList : [selectorList];
  const perTry = Math.max(1000, Math.floor(timeout / selectors.length));
  for (const sel of selectors) {
    try {
      const el = await page.waitForSelector(sel, {
        timeout: perTry,
        state: "visible",
      });
      if (el) return el;
    } catch {
      // 试下一个候选
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

/**
 * 发送一条 prompt 并等待回复完成，返回回复文本。
 * 完成判定：发送后 stop 按钮出现（生成中）→ 消失（生成结束）。
 * 拿不到 stop 按钮时退化为轮询回复文本稳定。
 */
export async function sendPrompt(page, selectors, prompt) {
  await dismissMemoryNux(page);
  await throwIfLoginRequired(page);
  const composer = await firstVisible(page, selectors.composer, 15000);

  // ChatGPT 会虚拟化长会话：新增回复时可能同时移除旧节点，因此不能靠节点数
  // 判断。直接记住最后一个回复节点，发送后确认页面末尾换成了新节点。
  const assistantSel = combinedSelector(selectors.assistantMessage);
  const beforeNodes = await page.$$(assistantSel);
  const beforeLast = beforeNodes[beforeNodes.length - 1] ?? null;

  await composer.click();
  // contenteditable 需要用键盘输入，模拟真实打字。延迟每轮取一个区间内的值，
  // 固定 25ms 是可测量的机器指纹。
  await page.keyboard.type(prompt, { delay: typingDelayMs() });
  // 输入完到点发送之间，真人总有一点间隔。
  await page.waitForTimeout(preSendPauseMs());

  // 优先点发送按钮，找不到就回车。
  let sent = false;
  for (const sel of selectorList(selectors.sendButton)) {
    const btn = await page.$(sel);
    if (btn && (await btn.isEnabled().catch(() => false))) {
      await btn.click();
      sent = true;
      break;
    }
  }
  if (!sent) {
    await page.keyboard.press("Enter");
  }

  // 等最后一条 assistant 消息变成新节点（最多 20s），再等其生成完成。
  try {
    await page.waitForFunction(
      ([sel, previous]) => {
        const nodes = document.querySelectorAll(sel);
        return nodes.length > 0 && nodes[nodes.length - 1] !== previous;
      },
      [assistantSel, beforeLast],
      { timeout: 20000 }
    );
  } catch {
    log.warn("未检测到新回复节点，继续按完成判定处理。");
  }

  await waitForResponseComplete(page, selectors);
  const afterNodes = await page.$$(assistantSel);
  const afterLast = afterNodes[afterNodes.length - 1] ?? null;
  const sameNode = beforeLast && afterLast
    ? await afterLast.evaluate((current, previous) => current === previous, beforeLast)
    : false;
  if (!afterLast || sameNode) {
    // 等待超时后不能直接取“最后一条”：多轮对话里那会读到上一轮回复，把一次
    // 实际发送失败伪装成成功，并继续沿着旧问题推进。
    throw new Error("发送后未检测到新的回复");
  }
  const reply = (await afterLast.innerText()).trim();
  if (!reply) throw new Error("新的回复内容为空");
  return reply;
}

async function waitForResponseComplete(page, selectors) {
  const stopSel = combinedSelector(selectors.stopButton);

  // 等生成开始（stop 按钮出现），最多 15s。若没等到，可能回复极快或结构变了。
  try {
    await page.waitForSelector(stopSel, { timeout: 15000, state: "visible" });
  } catch {
    log.warn("未检测到停止按钮，退化为轮询文本稳定判定。");
    return waitForTextStable(page, selectors);
  }

  // 等生成结束（stop 按钮消失），最多 3 分钟。
  try {
    await page.waitForSelector(stopSel, { timeout: 180000, state: "hidden" });
  } catch {
    log.warn("回复超过 3 分钟仍未结束，按当前内容返回。");
  }
  await page.waitForTimeout(500);
}

async function waitForTextStable(page, selectors) {
  let last = "";
  let stableCount = 0;
  for (let i = 0; i < 60; i++) {
    const text = await extractLastAssistant(page, selectors).catch(() => "");
    if (text && text === last) {
      stableCount++;
      if (stableCount >= 3) return; // 连续 3 次不变视为完成
    } else {
      stableCount = 0;
    }
    last = text;
    await page.waitForTimeout(1000);
  }
}

async function extractLastAssistant(page, selectors) {
  const sel = combinedSelector(selectors.assistantMessage);
  const nodes = await page.$$(sel);
  if (nodes.length === 0) return "";
  const lastNode = nodes[nodes.length - 1];
  return (await lastNode.innerText()).trim();
}

/**
 * 开启一个新的对话线程：导航到新对话页，等输入框就绪。
 */
export async function startNewChat(page, selectors) {
  const url = selectors.newChatUrl || selectors.url;
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await firstVisible(page, selectors.composer, 15000);
  await page.waitForTimeout(500);
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
