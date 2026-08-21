import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PROBE_DEPTH_CONVERSATION,
  PROBE_DEPTH_PAGE,
  SELECTOR_GROUPS,
  probeSelectors,
  summarizeSelectorReport,
  validateSelectorConfig,
} from "../src/selectorCheck.js";

// 选择器自检存在的意义是把"神秘的运行失败"变成"某一组选择器已失效"。所以这里
// 重点验证三件事：能不能区分失配与降级、只读探测不留痕迹、以及配置结构问题在
// 不碰浏览器的情况下就被指出来。

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const shippedSelectors = JSON.parse(
  fs.readFileSync(path.join(repoRoot, "config/selectors.json"), "utf8")
);

class NotVisible extends Error {}

/**
 * 假页面。visible 是当前"可见"的选择器集合；每次 waitForSelector 只在集合里命中。
 * 记录 keyboard 操作以验证探测文本被清理、以及是否真的发送了消息。
 */
function createFakePage(visible, options = {}) {
  const state = { typed: [], keys: [], clicks: 0, waits: [], sent: false };
  const visibleSet = new Set(visible);
  const isAssistantSelector = (selector) => shippedSelectors.assistantMessage.includes(selector);
  const page = {
    _state: state,
    async waitForSelector(selector) {
      if (!visibleSet.has(selector)) throw new NotVisible(selector);
      return {
        click: async () => {
          state.clicks += 1;
          if (shippedSelectors.sendButton.includes(selector)) state.sent = true;
          options.onClick?.(selector, state, visibleSet);
        },
        isEnabled: async () => options.isEnabled?.(selector) ?? true,
        innerText: async () => "回复正文",
      };
    },
    async waitForTimeout(ms) {
      state.waits.push(ms);
    },
    async $$(selector) {
      if (!visibleSet.has(selector)) return [];
      if (!isAssistantSelector(selector)) return [{}];
      const before = options.assistantBefore ?? 0;
      const after = state.sent && options.assistantAppears !== false ? 1 : 0;
      return Array.from({ length: before + after }, () => ({}));
    },
    async waitForFunction(_fn, [selector, before]) {
      const nodes = await page.$$(selector);
      if (nodes.length <= before) throw new NotVisible(selector);
      return true;
    },
    keyboard: {
      async type(text) {
        options.onType?.(text, state, visibleSet);
        state.typed.push(text);
      },
      async press(key) {
        state.keys.push(key);
        if (key === "Enter") state.sent = true;
        options.onKey?.(key, state, visibleSet);
      },
    },
  };
  return page;
}

const allVisible = [
  ...shippedSelectors.loginIndicators,
  ...shippedSelectors.composer,
  ...shippedSelectors.sendButton,
  ...shippedSelectors.stopButton,
  ...shippedSelectors.assistantMessage,
];

const groupOf = (report, key) => report.groups.find((g) => g.key === key);

test("随版本分发的选择器配置结构合法", () => {
  const result = validateSelectorConfig(shippedSelectors);
  assert.deepEqual(result.problems, []);
  assert.equal(result.ok, true);
});

test("缺组、空候选和非字符串候选都会被指出来", () => {
  const result = validateSelectorConfig({
    url: "https://chatgpt.com/",
    loginIndicators: ["#prompt-textarea"],
    composer: [],
    sendButton: [null, ""],
    stopButton: ["button"],
    // 缺 assistantMessage
  });

  assert.equal(result.ok, false);
  const keys = result.problems.map((p) => p.key);
  assert.ok(keys.includes("composer"), "空候选数组要报出来");
  assert.ok(keys.includes("sendButton"), "非字符串候选要报出来");
  assert.ok(keys.includes("assistantMessage"), "缺组要报出来");
  assert.ok(!keys.includes("loginIndicators"));
});

test("url 缺失被指出，newChatUrl 允许缺省", () => {
  const withoutNewChat = validateSelectorConfig({ ...shippedSelectors, newChatUrl: undefined });
  assert.equal(withoutNewChat.ok, true, "newChatUrl 缺省时 chat.js 会回落到 url");
  assert.equal(
    validateSelectorConfig({ ...shippedSelectors, newChatUrl: "" }).ok,
    true,
    "newChatUrl 留空时同样会回落到 url"
  );

  const withoutUrl = validateSelectorConfig({ ...shippedSelectors, url: "  " });
  assert.equal(withoutUrl.ok, false);
  assert.ok(withoutUrl.problems.some((p) => p.key === "url"));
});

test("非对象配置不抛异常，直接报结构问题", () => {
  for (const bad of [null, undefined, "x", 42, []]) {
    const result = validateSelectorConfig(bad);
    assert.equal(result.ok, false, `${JSON.stringify(bad)} 应判为不合法`);
  }
});

test("只读探测验证前三组，且不发送任何消息", async () => {
  const page = createFakePage(allVisible);

  const report = await probeSelectors(page, shippedSelectors, { depth: PROBE_DEPTH_PAGE });

  assert.equal(report.ok, true);
  assert.equal(report.depth, PROBE_DEPTH_PAGE);
  assert.equal(groupOf(report, "loginIndicators").status, "ok");
  assert.equal(groupOf(report, "composer").status, "ok");
  assert.equal(groupOf(report, "sendButton").status, "ok");
  // 后两组需要真实对话，只读深度下必须是 skipped 而不是谎称通过或失败。
  assert.equal(groupOf(report, "stopButton").status, "skipped");
  assert.equal(groupOf(report, "assistantMessage").status, "skipped");
  assert.equal(page._state.clicks, 1, "只点了输入框，没点发送");
  assert.ok(!page._state.keys.includes("Enter"), "只读探测不能回车发送");
});

test("只读探测结束后清空输入框，不留探测文本", async () => {
  const page = createFakePage(allVisible);

  await probeSelectors(page, shippedSelectors, { depth: PROBE_DEPTH_PAGE });

  assert.deepEqual(page._state.typed, ["hello"]);
  // 全选 + 删除是 contenteditable 唯一可靠的清空方式。
  const selectAllKey = process.platform === "darwin" ? "Meta+A" : "Control+A";
  assert.ok(page._state.keys.includes(selectAllKey), `按键序列：${page._state.keys.join(",")}`);
  assert.ok(page._state.keys.includes("Backspace"));
});

test("只读探测无法清空输入框时明确失败，不伪称无痕", async () => {
  const selectAllKey = process.platform === "darwin" ? "Meta+A" : "Control+A";
  const page = createFakePage(allVisible, {
    onKey: (key) => {
      if (key === selectAllKey) throw new Error("键盘操作失败");
    },
  });

  await assert.rejects(
    probeSelectors(page, shippedSelectors, { depth: PROBE_DEPTH_PAGE }),
    /无法清空探测文本/
  );
});

test("报告按固定顺序返回全部五组，不漏不重", async () => {
  const page = createFakePage(allVisible);

  const report = await probeSelectors(page, shippedSelectors, { depth: PROBE_DEPTH_PAGE });

  assert.deepEqual(
    report.groups.map((g) => g.key),
    SELECTOR_GROUPS.map((g) => g.key)
  );
});

test("输入框失配时判为整体失败，并说明后果", async () => {
  const page = createFakePage(
    allVisible.filter((s) => !shippedSelectors.composer.includes(s))
  );

  const report = await probeSelectors(page, shippedSelectors, { depth: PROBE_DEPTH_PAGE });

  assert.equal(report.ok, false);
  assert.ok(report.failedKeys.includes("composer"));
  const composer = groupOf(report, "composer");
  assert.equal(composer.status, "failed");
  assert.match(composer.detail, /候选全部未命中/);
  assert.match(composer.impact, /第一轮/);
  assert.match(summarizeSelectorReport(report), /已失效|改版/);
});

test("输入框失配时跳过发送按钮检查，而不是报第二个失败", async () => {
  const page = createFakePage(
    allVisible.filter((s) => !shippedSelectors.composer.includes(s))
  );

  const report = await probeSelectors(page, shippedSelectors, { depth: PROBE_DEPTH_PAGE });

  const send = groupOf(report, "sendButton");
  assert.equal(send.status, "skipped");
  assert.match(send.detail, /输入框未命中/);
  assert.ok(!report.failedKeys.includes("sendButton"), "跳过不等于失效");
});

test("发送按钮失配算可降级，不让整体判为失败", async () => {
  // chat.js 找不到发送按钮时会回退到回车，所以这一组失配不致命。
  const page = createFakePage(
    allVisible.filter((s) => !shippedSelectors.sendButton.includes(s))
  );

  const report = await probeSelectors(page, shippedSelectors, { depth: PROBE_DEPTH_PAGE });

  assert.equal(report.ok, true, "可降级的组失配不该让整体失败");
  assert.deepEqual(report.failedKeys, []);
  assert.ok(report.degradedKeys.includes("sendButton"));
  assert.match(summarizeSelectorReport(report), /降级/);
});

test("登录指示失配只影响旧备用判断，不误判自动对话整体失效", async () => {
  const page = createFakePage(
    allVisible.filter((s) => !shippedSelectors.loginIndicators.includes(s))
  );

  const report = await probeSelectors(page, shippedSelectors, { depth: PROBE_DEPTH_PAGE });

  assert.equal(report.ok, true);
  assert.ok(report.degradedKeys.includes("loginIndicators"));
});

test("主发送按钮可见但 disabled 时继续尝试可用的备用候选", async () => {
  const primary = shippedSelectors.sendButton[0];
  const page = createFakePage(allVisible, {
    isEnabled: (selector) => selector !== primary,
  });

  const report = await probeSelectors(page, shippedSelectors, { depth: PROBE_DEPTH_PAGE });
  const send = groupOf(report, "sendButton");

  assert.equal(send.status, "ok");
  assert.equal(send.matched, shippedSelectors.sendButton[1]);
  assert.equal(send.usedFallback, true);
});

test("靠备用候选命中时提示主选择器已漂移", async () => {
  // 主选择器 #prompt-textarea 不再存在，但兜底候选还能命中——能跑，可是改版
  // 已经开始了，这是最有价值的早期信号。
  const primary = shippedSelectors.composer[0];
  const page = createFakePage(allVisible.filter((s) => s !== primary));

  const report = await probeSelectors(page, shippedSelectors, { depth: PROBE_DEPTH_PAGE });

  const composer = groupOf(report, "composer");
  assert.equal(composer.status, "ok");
  assert.equal(composer.usedFallback, true);
  assert.notEqual(composer.matched, primary);
  assert.ok(report.fallbackKeys.includes("composer"));
  assert.match(summarizeSelectorReport(report), /备用选择器|漂移/);
});

test("命中第一个候选时不报漂移", async () => {
  const page = createFakePage(allVisible);

  const report = await probeSelectors(page, shippedSelectors, { depth: PROBE_DEPTH_PAGE });

  assert.deepEqual(report.fallbackKeys, []);
  assert.equal(groupOf(report, "composer").usedFallback, false);
  // 只读深度下后两组本来就没验证，摘要要如实说明，不能谎称全部可用。
  const summary = summarizeSelectorReport(report);
  assert.doesNotMatch(summary, /漂移|降级|已失效/);
  assert.match(summary, /2 组未验证/);
});

test("conversation 深度下全部命中时摘要是干净的", async () => {
  const page = createFakePage(allVisible);

  const report = await probeSelectors(page, shippedSelectors, {
    depth: PROBE_DEPTH_CONVERSATION,
  });

  assert.equal(summarizeSelectorReport(report), "全部选择器可用");
});

test("结构不合法的组标记为 invalid，不去浏览器里白等超时", async () => {
  const page = createFakePage(allVisible);
  const broken = { ...shippedSelectors, assistantMessage: [] };

  const report = await probeSelectors(page, broken, { depth: PROBE_DEPTH_PAGE });

  const assistant = groupOf(report, "assistantMessage");
  assert.equal(assistant.status, "invalid");
  assert.ok(report.failedKeys.includes("assistantMessage"));
  assert.ok(report.configProblems.some((p) => p.key === "assistantMessage"));
});

test("conversation 深度下的每次探测都沿用同一个超时", async () => {
  const observed = [];
  const page = createFakePage(allVisible);
  const original = page.waitForSelector.bind(page);
  page.waitForSelector = async (selector, opts) => {
    observed.push(opts?.timeout);
    return original(selector, opts);
  };

  await probeSelectors(page, shippedSelectors, {
    depth: PROBE_DEPTH_CONVERSATION,
    perCandidateTimeoutMs: 1200,
  });

  // 发送探测消息时也要用同一个超时，否则深度探测和只读探测的判定标准不一致。
  assert.ok(
    observed.every((t) => t === 1200),
    `实际超时集合：${[...new Set(observed)].join(",")}`
  );
});

test("只按可见状态判定，与 chat.js 的 firstVisible 保持一致", async () => {
  // 自检若用 attached 而非 visible，会把隐藏但存在的节点当成可用，给出比实际
  // 运行更乐观的结论。
  const observed = [];
  const page = createFakePage(allVisible);
  const original = page.waitForSelector.bind(page);
  page.waitForSelector = async (selector, opts) => {
    observed.push(opts?.state);
    return original(selector, opts);
  };

  await probeSelectors(page, shippedSelectors, { depth: PROBE_DEPTH_CONVERSATION });

  assert.ok(observed.length > 0);
  assert.ok(
    observed.every((state) => state === "visible"),
    `实际 state 集合：${[...new Set(observed)].join(",")}`
  );
});

test("报告顺序由 SELECTOR_GROUPS 决定，与探测顺序无关", async () => {
  // 探测顺序是 login/composer/send → stop/assistant，只读深度下 stop/assistant
  // 反而先被压入数组。界面按固定顺序展示，不能受这个实现细节影响。
  const page = createFakePage(
    allVisible.filter((s) => !shippedSelectors.composer.includes(s))
  );

  const report = await probeSelectors(page, shippedSelectors, { depth: PROBE_DEPTH_PAGE });

  assert.deepEqual(
    report.groups.map((g) => g.key),
    ["loginIndicators", "composer", "sendButton", "stopButton", "assistantMessage"]
  );
});

test("conversation 深度会真的发送一条消息并验证后两组", async () => {
  const page = createFakePage(allVisible);

  const report = await probeSelectors(page, shippedSelectors, {
    depth: PROBE_DEPTH_CONVERSATION,
  });

  assert.equal(report.depth, PROBE_DEPTH_CONVERSATION);
  assert.equal(groupOf(report, "stopButton").status, "ok");
  assert.equal(groupOf(report, "assistantMessage").status, "ok");
  assert.equal(page._state.clicks, 2, "点了输入框和发送按钮");
  // 真要发送，所以不能把探测文本清掉。
  assert.ok(!page._state.keys.includes("Backspace"), "发送前不该清空输入框");
});

test("conversation 深度不把页面里的旧回复误判成探测消息的新回复", async () => {
  const page = createFakePage(allVisible, {
    assistantBefore: 1,
    assistantAppears: false,
  });

  const report = await probeSelectors(page, shippedSelectors, {
    depth: PROBE_DEPTH_CONVERSATION,
  });

  assert.equal(page._state.sent, true, "探测消息应该已经尝试发送");
  assert.equal(groupOf(report, "assistantMessage").status, "failed");
  assert.ok(report.failedKeys.includes("assistantMessage"));
});

test("conversation 深度下发送按钮不可用时回退到回车", async () => {
  const page = createFakePage(
    allVisible.filter((s) => !shippedSelectors.sendButton.includes(s))
  );

  const report = await probeSelectors(page, shippedSelectors, {
    depth: PROBE_DEPTH_CONVERSATION,
  });

  assert.ok(page._state.keys.includes("Enter"), "必须回退到回车，否则消息发不出去");
  assert.equal(groupOf(report, "assistantMessage").status, "ok");
});

test("探测文本写入失败时不按回车，也不谎称已发送", async () => {
  const page = createFakePage(allVisible, {
    onType: () => {
      throw new Error("输入事件失败");
    },
  });

  const report = await probeSelectors(page, shippedSelectors, {
    depth: PROBE_DEPTH_CONVERSATION,
  });

  assert.ok(!page._state.keys.includes("Enter"));
  assert.equal(report.ok, false);
  assert.ok(report.failedKeys.includes("composer"));
  assert.equal(groupOf(report, "sendButton").status, "skipped");
  assert.equal(groupOf(report, "stopButton").status, "skipped");
  assert.equal(groupOf(report, "assistantMessage").status, "skipped");
});

test("停止按钮抓不到时判为 inconclusive，不诬告改版", async () => {
  // 回复生成很快时停止按钮可能已经消失，这不是选择器失配。
  const page = createFakePage(
    allVisible.filter((s) => !shippedSelectors.stopButton.includes(s))
  );

  const report = await probeSelectors(page, shippedSelectors, {
    depth: PROBE_DEPTH_CONVERSATION,
  });

  const stop = groupOf(report, "stopButton");
  assert.equal(stop.status, "inconclusive");
  assert.match(stop.detail, /可能已生成完成/);
  assert.equal(report.ok, true, "无法确认不等于失效");
  assert.ok(!report.failedKeys.includes("stopButton"));
  assert.ok(!report.degradedKeys.includes("stopButton"));
  assert.match(summarizeSelectorReport(report), /停止按钮未能确认/);
});

test("回复正文失配是致命的，追问链条会断", async () => {
  const page = createFakePage(
    allVisible.filter((s) => !shippedSelectors.assistantMessage.includes(s))
  );

  const report = await probeSelectors(page, shippedSelectors, {
    depth: PROBE_DEPTH_CONVERSATION,
  });

  assert.equal(report.ok, false);
  assert.ok(report.failedKeys.includes("assistantMessage"));
  assert.match(groupOf(report, "assistantMessage").impact, /追问/);
});

test("无法识别的 depth 退化为只读探测", async () => {
  const page = createFakePage(allVisible);

  const report = await probeSelectors(page, shippedSelectors, { depth: "whatever" });

  assert.equal(report.depth, PROBE_DEPTH_PAGE);
  assert.ok(!page._state.keys.includes("Enter"), "未知深度不能擅自发消息");
});

test("缺省 depth 也是只读探测", async () => {
  const page = createFakePage(allVisible);

  const report = await probeSelectors(page, shippedSelectors);

  assert.equal(report.depth, PROBE_DEPTH_PAGE);
  assert.ok(!page._state.keys.includes("Enter"));
});

test("全组失配时摘要点明可能已改版", async () => {
  const page = createFakePage([]);

  const report = await probeSelectors(page, shippedSelectors, { depth: PROBE_DEPTH_PAGE });

  assert.equal(report.ok, false);
  const summary = summarizeSelectorReport(report);
  assert.match(summary, /改版/);
  assert.match(summary, /selectors\.json/);
});

test("页面地址配置错误会让报告失败并给出配置结论", async () => {
  const broken = { ...shippedSelectors, url: "" };
  const page = createFakePage(allVisible);

  const report = await probeSelectors(page, broken, { depth: PROBE_DEPTH_PAGE });

  assert.equal(report.ok, false);
  assert.match(summarizeSelectorReport(report), /配置无效/);
  assert.match(summarizeSelectorReport(report), /url/);
});

test("摘要在没有报告时不抛异常", () => {
  assert.match(summarizeSelectorReport(null), /未执行/);
  assert.match(summarizeSelectorReport(undefined), /未执行/);
});

test("每组都带上失配后果说明", async () => {
  const page = createFakePage(allVisible);

  const report = await probeSelectors(page, shippedSelectors, { depth: PROBE_DEPTH_PAGE });

  for (const group of report.groups) {
    assert.ok(
      typeof group.impact === "string" && group.impact.length > 0,
      `${group.key} 缺少后果说明`
    );
    assert.ok(Array.isArray(group.candidates), `${group.key} 缺少候选列表`);
  }
});

test("候选超时时间有下限，不会被配成 0 导致必然失配", async () => {
  // 真实 Playwright 里 timeout=0 表示"永不超时"，但配成 1ms 这类极小值会让每个
  // 候选都还没渲染完就被判失配，自检结论就成了假的改版警报。
  const observed = [];
  const page = createFakePage(allVisible);
  const original = page.waitForSelector.bind(page);
  page.waitForSelector = async (selector, opts) => {
    observed.push(opts?.timeout);
    return original(selector, opts);
  };

  const report = await probeSelectors(page, shippedSelectors, {
    depth: PROBE_DEPTH_PAGE,
    perCandidateTimeoutMs: 0,
  });

  assert.equal(report.ok, true);
  assert.ok(observed.length > 0, "应该真的探测过");
  for (const timeout of observed) {
    assert.ok(timeout >= 500, `每个候选的超时不该低于 500ms，实际 ${timeout}`);
  }
});

test("显式给出的合理超时被原样使用", async () => {
  const observed = [];
  const page = createFakePage(allVisible);
  const original = page.waitForSelector.bind(page);
  page.waitForSelector = async (selector, opts) => {
    observed.push(opts?.timeout);
    return original(selector, opts);
  };

  await probeSelectors(page, shippedSelectors, {
    depth: PROBE_DEPTH_PAGE,
    perCandidateTimeoutMs: 1500,
  });

  assert.ok(observed.every((t) => t === 1500), `实际超时集合：${[...new Set(observed)].join(",")}`);
});
