import * as log from "./logger.js";

/**
 * 选择器漂移自检。
 *
 * config/selectors.json 是整个自动对话最脆的一环：ChatGPT 前端改版后这些选择器
 * 会失配，而失败现场是"找不到输入框"——用户看到一堆运行失败，分不清是自己账号
 * 被限制了、代理挂了，还是官网改版了。这里把它变成一个可主动运行、结论明确的
 * 检查：哪一组失效、还剩哪些候选可用。
 *
 * 五组选择器不在同一页面状态下可见，所以探测分两层：
 * - page：只读探测。打开新对话页即可验证 loginIndicators、composer，输入探测
 *   文本后验证 sendButton，然后清空输入框。不发送任何消息。
 * - conversation：额外真发一条短消息，才能验证 stopButton（仅生成中出现）和
 *   assistantMessage（需要已有回复）。会在账号里留下一条真实对话。
 */

export const PROBE_DEPTH_PAGE = "page";
export const PROBE_DEPTH_CONVERSATION = "conversation";

// 探测用的输入文本。只为让发送按钮进入可用态，默认深度下不会被发送。
const PROBE_TEXT = "hello";

export const SELECTOR_GROUPS = Object.freeze([
  {
    key: "loginIndicators",
    label: "登录状态指示",
    // 当前自动对话的登录判断走 checkSession；这一组只服务于旧的备用 helper，
    // 失配不应把整个自检判死。
    impact: "旧版登录状态备用判断不可用；自动对话仍会执行会话健康检查",
    depth: PROBE_DEPTH_PAGE,
    degradable: true,
  },
  {
    key: "composer",
    label: "输入框",
    impact: "无法输入问题，自动对话在第一轮就失败",
    depth: PROBE_DEPTH_PAGE,
  },
  {
    key: "sendButton",
    label: "发送按钮",
    // chat.js 找不到发送按钮时会回退到回车，所以这一组失配不致命。
    impact: "发送按钮不可用，会回退为回车发送",
    depth: PROBE_DEPTH_PAGE,
    degradable: true,
  },
  {
    key: "stopButton",
    label: "停止按钮",
    // 失配后退化为轮询文本稳定，能跑但每轮多等数秒。
    impact: "无法判断回复是否生成完成，会退化为轮询文本稳定",
    depth: PROBE_DEPTH_CONVERSATION,
    degradable: true,
  },
  {
    key: "assistantMessage",
    label: "回复内容",
    impact: "读不到回复正文，追问链条无法继续",
    depth: PROBE_DEPTH_CONVERSATION,
  },
]);

const GROUP_BY_KEY = new Map(SELECTOR_GROUPS.map((group) => [group.key, group]));

/**
 * 只检查配置本身的结构，不需要浏览器。缺组、空数组和非字符串候选都会让运行期
 * 报出含义不明的错误，这里提前指出来。
 */
export function validateSelectorConfig(selectors) {
  const problems = [];
  if (!selectors || typeof selectors !== "object") {
    return { ok: false, problems: [{ key: null, detail: "选择器配置不是对象" }] };
  }
  for (const key of ["url", "newChatUrl"]) {
    const value = selectors[key];
    // newChatUrl 允许缺省或显式留空，chat.js 都会回落到 url。
    if (key === "newChatUrl" && (value == null || value === "")) continue;
    if (typeof value !== "string" || !value.trim()) {
      problems.push({ key, detail: `${key} 必须是非空字符串` });
    }
  }
  for (const { key, label } of SELECTOR_GROUPS) {
    const value = selectors[key];
    if (value === undefined) {
      problems.push({ key, detail: `缺少「${label}」（${key}）选择器` });
      continue;
    }
    const candidates = Array.isArray(value) ? value : [value];
    if (candidates.length === 0) {
      problems.push({ key, detail: `「${label}」（${key}）没有任何候选选择器` });
      continue;
    }
    const bad = candidates.filter((c) => typeof c !== "string" || !c.trim());
    if (bad.length > 0) {
      problems.push({
        key,
        detail: `「${label}」（${key}）有 ${bad.length} 个候选不是非空字符串`,
      });
    }
  }
  return { ok: problems.length === 0, problems };
}

function candidatesOf(selectors, key) {
  const value = selectors?.[key];
  if (value === undefined) return [];
  return (Array.isArray(value) ? value : [value]).filter(
    (c) => typeof c === "string" && c.trim()
  );
}

/**
 * 在一组候选里逐个尝试，返回第一个命中的选择器。与 chat.js 的 firstVisible 用
 * 同样的可见性判定；发送按钮还要和 chat.js 一样确认 enabled。
 */
async function firstMatching(
  page,
  candidates,
  perCandidateTimeoutMs,
  { requireEnabled = false } = {}
) {
  const attempts = [];
  for (const selector of candidates) {
    try {
      const handle = await page.waitForSelector(selector, {
        timeout: perCandidateTimeoutMs,
        state: "visible",
      });
      if (handle) {
        if (requireEnabled) {
          const enabled = await handle.isEnabled().catch(() => false);
          if (!enabled) {
            attempts.push({ selector, error: "元素不可用" });
            continue;
          }
        }
        return { matched: selector, handle, attempts };
      }
    } catch (error) {
      attempts.push({ selector, error: error?.message ?? String(error) });
    }
  }
  return { matched: null, handle: null, attempts };
}

async function countCandidates(page, candidates) {
  const counts = new Map();
  for (const selector of candidates) {
    try {
      counts.set(selector, (await page.$$(selector)).length);
    } catch {
      // 非法 CSS 候选会在后续实际探测中留下明确失败；这里仅记录发送前基线。
      counts.set(selector, 0);
    }
  }
  return counts;
}

/**
 * 深度探测不能把页面里已有的旧回复当成 hello 的回复。逐个候选等待节点数增长，
 * 同时保留“主候选/备用候选”的漂移判断。
 */
async function firstMatchingNewNode(page, candidates, beforeCounts, perCandidateTimeoutMs) {
  const attempts = [];
  for (const selector of candidates) {
    const before = beforeCounts.get(selector) ?? 0;
    try {
      await page.waitForFunction(
        ([candidate, count]) => document.querySelectorAll(candidate).length > count,
        [selector, before],
        { timeout: perCandidateTimeoutMs }
      );
      const handle = await page.waitForSelector(selector, {
        timeout: perCandidateTimeoutMs,
        state: "visible",
      });
      if (handle) return { matched: selector, handle, attempts };
    } catch (error) {
      attempts.push({ selector, error: error?.message ?? String(error) });
    }
  }
  return { matched: null, handle: null, attempts };
}

function groupResult(group, { status, matched, candidates, detail }) {
  return {
    key: group.key,
    label: group.label,
    status,
    matched: matched ?? null,
    candidates,
    // 命中第一个候选说明主选择器还有效；命中靠后的候选说明主选择器已经漂移，
    // 只是被兜底救回来了——这是改版的早期信号，值得单独提示。
    usedFallback: status === "ok" && matched != null && candidates[0] !== matched,
    impact: group.impact,
    degradable: group.degradable === true,
    detail: detail ?? null,
  };
}

/**
 * 对一个已经在 ChatGPT 页面上的 page 执行选择器自检。
 *
 * 不做导航、不检查会话状态——调用方（Agent 服务）负责把 page 带到已登录的新
 * 对话页，这样自检可以复用现有的账号锁与浏览器生命周期。
 *
 * @returns {Promise<{ok, depth, groups, failedKeys, degradedKeys, fallbackKeys}>}
 */
export async function probeSelectors(page, selectors, options = {}) {
  const depth = options.depth === PROBE_DEPTH_CONVERSATION
    ? PROBE_DEPTH_CONVERSATION
    : PROBE_DEPTH_PAGE;
  const perCandidateTimeoutMs = Math.max(500, options.perCandidateTimeoutMs ?? 3000);

  const config = validateSelectorConfig(selectors);
  const groups = [];
  const criticalConfigProblems = config.problems.filter(
    (problem) => problem.key == null || !GROUP_BY_KEY.has(problem.key)
  );

  // 结构有问题的组直接标记为 invalid，不去浏览器里白等超时。
  const invalidKeys = new Set(
    config.problems.map((problem) => problem.key).filter((key) => GROUP_BY_KEY.has(key))
  );

  const probe = async (group, { beforeCounts = null } = {}) => {
    const candidates = candidatesOf(selectors, group.key);
    if (invalidKeys.has(group.key) || candidates.length === 0) {
      const problem = config.problems.find((p) => p.key === group.key);
      return groupResult(group, {
        status: "invalid",
        matched: null,
        candidates,
        detail: problem?.detail ?? "选择器配置不可用",
      });
    }
    const { matched, attempts } = beforeCounts
      ? await firstMatchingNewNode(page, candidates, beforeCounts, perCandidateTimeoutMs)
      : await firstMatching(
          page,
          candidates,
          perCandidateTimeoutMs,
          { requireEnabled: group.key === "sendButton" }
        );
    if (matched) {
      return groupResult(group, { status: "ok", matched, candidates });
    }
    return groupResult(group, {
      status: "failed",
      matched: null,
      candidates,
      detail: `${candidates.length} 个候选全部未命中：${attempts
        .map((a) => a.selector)
        .join(" | ")}`,
    });
  };

  // 页面刚加载时可见的两组。
  for (const key of ["loginIndicators", "composer"]) {
    groups.push(await probe(GROUP_BY_KEY.get(key)));
  }

  // 发送按钮要等输入框有内容才进入可用态。输入探测文本后必须清掉，否则会在
  // 用户的输入框里留下残留。
  const sendGroup = GROUP_BY_KEY.get("sendButton");
  const composerOk = groups.find((g) => g.key === "composer")?.status === "ok";
  let probeTextReady = false;
  if (!composerOk) {
    groups.push(
      groupResult(sendGroup, {
        status: "skipped",
        matched: null,
        candidates: candidatesOf(selectors, "sendButton"),
        detail: "输入框未命中，无法让发送按钮进入可用态",
      })
    );
  } else {
    let typed = false;
    try {
      await typeProbeText(page, selectors, perCandidateTimeoutMs);
      typed = true;
      probeTextReady = true;
    } catch (error) {
      log.warn(`选择器自检写入探测文本失败：${error?.message ?? error}`);
      const composer = groups.find((group) => group.key === "composer");
      if (composer) {
        composer.status = "failed";
        composer.detail = `输入框虽可见但无法写入探测文本：${error?.message ?? error}`;
      }
    }
    groups.push(
      typed
        ? await probe(sendGroup)
        : groupResult(sendGroup, {
            status: "skipped",
            matched: null,
            candidates: candidatesOf(selectors, "sendButton"),
            detail: "无法写入探测文本，跳过发送按钮检查",
          })
    );
    if (typed && depth !== PROBE_DEPTH_CONVERSATION) {
      // 只读深度下必须把探测文本清掉；conversation 深度反而要留着去发送。
      try {
        await clearComposer(page);
      } catch (error) {
        log.warn(`选择器自检清空输入框失败：${error?.message ?? error}`);
        throw new Error(`选择器自检无法清空探测文本：${error?.message ?? error}`);
      }
    }
  }

  // 停止按钮与回复正文只有真发一条消息才能验证。
  for (const key of ["stopButton", "assistantMessage"]) {
    const group = GROUP_BY_KEY.get(key);
    if (depth !== PROBE_DEPTH_CONVERSATION) {
      const candidates = candidatesOf(selectors, key);
      // 结构问题不需要浏览器就能确认，只读深度下也必须报出来——否则配置写坏了
      // 只能等到真跑对话时才发现。
      if (invalidKeys.has(key) || candidates.length === 0) {
        const problem = config.problems.find((p) => p.key === key);
        groups.push(
          groupResult(group, {
            status: "invalid",
            matched: null,
            candidates,
            detail: problem?.detail ?? "选择器配置不可用",
          })
        );
        continue;
      }
      groups.push(
        groupResult(group, {
          status: "skipped",
          matched: null,
          candidates,
          detail: "需要真实发送一条消息才能验证，本次为只读检查",
        })
      );
    }
  }

  if (depth === PROBE_DEPTH_CONVERSATION) {
    const sendOk = groups.find((g) => g.key === "sendButton")?.status === "ok";
    const assistantCountsBefore = await countCandidates(
      page,
      candidatesOf(selectors, "assistantMessage")
    );
    let sent = false;
    if (probeTextReady) {
      try {
        await sendProbeMessage(page, selectors, sendOk, perCandidateTimeoutMs);
        sent = true;
      } catch (error) {
        log.warn(`选择器自检发送探测消息失败：${error?.message ?? error}`);
      }
    }
    for (const key of ["stopButton", "assistantMessage"]) {
      const group = GROUP_BY_KEY.get(key);
      if (!sent) {
        groups.push(
          groupResult(group, {
            status: "skipped",
            matched: null,
            candidates: candidatesOf(selectors, key),
            detail: "探测消息未发出，无法验证",
          })
        );
        continue;
      }
      // 停止按钮只在生成期间可见，回复很快时可能已经消失——这不算失配。
      const result = key === "assistantMessage"
        ? await probe(group, { beforeCounts: assistantCountsBefore })
        : await probe(group);
      if (key === "stopButton" && result.status === "failed") {
        result.status = "inconclusive";
        result.detail = `${result.detail}（回复可能已生成完成，停止按钮本就不再可见）`;
      }
      groups.push(result);
    }
  }

  const ordered = SELECTOR_GROUPS.map(
    (group) => groups.find((g) => g.key === group.key)
  ).filter(Boolean);

  const failedKeys = ordered
    .filter((g) => (g.status === "failed" || g.status === "invalid") && !g.degradable)
    .map((g) => g.key);
  const degradedKeys = ordered
    .filter((g) => (g.status === "failed" || g.status === "invalid") && g.degradable)
    .map((g) => g.key);
  const fallbackKeys = ordered.filter((g) => g.usedFallback).map((g) => g.key);

  return {
    ok: failedKeys.length === 0 && criticalConfigProblems.length === 0,
    depth,
    groups: ordered,
    failedKeys,
    degradedKeys,
    fallbackKeys,
    configProblems: config.problems,
  };
}

async function typeProbeText(page, selectors, perCandidateTimeoutMs) {
  const candidates = candidatesOf(selectors, "composer");
  const { handle } = await firstMatching(page, candidates, perCandidateTimeoutMs);
  if (!handle) throw new Error("输入框不可用");
  await handle.click();
  await page.keyboard.type(PROBE_TEXT, { delay: 10 });
  // 前端把按钮可用态绑在输入事件上，给它一点时间反应。
  await page.waitForTimeout(300);
}

async function clearComposer(page) {
  // contenteditable 用不了 fill("")，只能全选删除。
  await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
  await page.keyboard.press("Backspace");
  await page.waitForTimeout(150);
}

async function sendProbeMessage(page, selectors, sendButtonUsable, perCandidateTimeoutMs) {
  if (sendButtonUsable) {
    const { handle } = await firstMatching(
      page,
      candidatesOf(selectors, "sendButton"),
      perCandidateTimeoutMs,
      { requireEnabled: true }
    );
    if (handle) {
      await handle.click();
      return;
    }
  }
  // 和 chat.js 一样，发送按钮不可用时回退到回车。
  await page.keyboard.press("Enter");
}

/**
 * 把探测结果压成一句给用户看的结论。界面上"运行失败"太多了，这里必须一眼能看出
 * 是否官网改版。
 */
export function summarizeSelectorReport(report) {
  if (!report) return "选择器自检未执行";
  const {
    failedKeys = [],
    degradedKeys = [],
    fallbackKeys = [],
    groups = [],
    configProblems = [],
  } = report;
  const nameOf = (key) => GROUP_BY_KEY.get(key)?.label ?? key;

  const criticalConfigProblems = configProblems.filter(
    (problem) => problem.key == null || !GROUP_BY_KEY.has(problem.key)
  );
  if (criticalConfigProblems.length > 0) {
    return `选择器配置无效：${criticalConfigProblems.map((problem) => problem.detail).join("；")}`;
  }

  if (failedKeys.length > 0) {
    return `选择器已失效：${failedKeys.map(nameOf).join("、")}。ChatGPT 网页端可能已改版，需要更新 config/selectors.json`;
  }
  const notes = [];
  if (degradedKeys.length > 0) {
    notes.push(`${degradedKeys.map(nameOf).join("、")}失效但可降级运行`);
  }
  if (fallbackKeys.length > 0) {
    notes.push(`${fallbackKeys.map(nameOf).join("、")}靠备用选择器命中，主选择器可能已漂移`);
  }
  const skipped = groups.filter((g) => g.status === "skipped").length;
  if (skipped > 0) {
    notes.push(`${skipped} 组未验证（需要真实发送一条消息）`);
  }
  const inconclusive = groups
    .filter((g) => g.status === "inconclusive")
    .map((g) => g.label);
  if (inconclusive.length > 0) {
    notes.push(`${inconclusive.join("、")}未能确认`);
  }
  return notes.length > 0 ? `选择器基本可用：${notes.join("；")}` : "全部选择器可用";
}
