import * as log from "./logger.js";

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
 * 确认账号已登录（输入框可见）。未登录时抛错，由调用方跳过该账号。
 */
export async function ensureLoggedIn(page, selectors) {
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
  const composer = await firstVisible(page, selectors.composer, 15000);

  await composer.click();
  // contenteditable 需要用键盘输入，模拟真实打字。
  await page.keyboard.type(prompt, { delay: 25 });
  await page.waitForTimeout(300);

  // 优先点发送按钮，找不到就回车。
  let sent = false;
  for (const sel of selectors.sendButton) {
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

  await waitForResponseComplete(page, selectors);
  return extractLastAssistant(page, selectors);
}

async function waitForResponseComplete(page, selectors) {
  const stopSel = selectors.stopButton.join(", ");

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
  const sel = selectors.assistantMessage[0];
  const nodes = await page.$$(sel);
  if (nodes.length === 0) return "";
  const lastNode = nodes[nodes.length - 1];
  return (await lastNode.innerText()).trim();
}
