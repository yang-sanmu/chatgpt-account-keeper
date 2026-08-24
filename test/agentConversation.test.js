import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { REPLY_STORE_LIMIT, runAgent } from "../src/agent.js";

// runAgent 走的是 chat.js 的真实实现，所以这里不 mock chat.js，而是给一个最小的
// 假 ChatGPT 页面：它按脚本吐回复，并模拟"生成中/生成结束"的停止按钮。这样一次
// 覆盖两层——追问链条本身，以及 sendPrompt 对 DOM 的假设。
// 选择器直接读随版本分发的真实配置，配置结构被改坏时测试会一起报警。

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const selectors = JSON.parse(
  fs.readFileSync(path.join(repoRoot, "config/selectors.json"), "utf8")
);

class NotFound extends Error {}

/**
 * 最小假页面。replies 是按轮次给出的回复文本；用完后继续给最后一条。
 * options.stopButton=false 模拟"抓不到停止按钮"，用于走文本稳定降级分支。
 * options.failSendAtRound 让指定轮次（1 起）的发送直接抛错。
 */
function createFakePage(replies, options = {}) {
  const state = {
    assistantMessages: [],
    stopVisible: false,
    typed: [],
    typeDelays: [],
    sends: 0,
    waits: [],
    navigations: [],
    clickedSendButton: 0,
    pressedEnter: 0,
  };
  const stopButtonWorks = options.stopButton !== false;
  const sendButtonWorks = options.sendButton !== false;
  const activeSelectors = options.selectors ?? selectors;
  const asList = (value) => Array.isArray(value) ? value : [value];
  const queryIncludes = (query, values) => String(query)
    .split(/\s*,\s*/)
    .some((candidate) => asList(values).includes(candidate));

  const isComposer = (sel) => queryIncludes(sel, activeSelectors.composer)
    || queryIncludes(sel, activeSelectors.loginIndicators);
  const isSend = (sel) => queryIncludes(sel, activeSelectors.sendButton);
  const isStop = (sel) => queryIncludes(sel, activeSelectors.stopButton);
  const isAssistant = (sel) => queryIncludes(sel, activeSelectors.assistantMessage);

  function replyFor(round) {
    if (replies.length === 0) return "";
    return replies[Math.min(round, replies.length - 1)];
  }

  function commitSend() {
    state.sends += 1;
    if (options.failSendAtRound === state.sends) {
      throw new Error(`第 ${state.sends} 轮网络中断`);
    }
    if (options.noReplyAtRound === state.sends) {
      state.stopVisible = false;
      return;
    }
    state.assistantMessages.push({ innerText: replyFor(state.sends - 1) });
    const virtualizeLimit = Number(options.virtualizeAssistantLimit);
    if (Number.isFinite(virtualizeLimit) && virtualizeLimit > 0) {
      while (state.assistantMessages.length > virtualizeLimit) {
        state.assistantMessages.shift();
      }
    }
    state.stopVisible = stopButtonWorks;
  }

  const handle = (kind, node = null) => ({
    _node: node,
    click: async () => {
      if (kind === "send") {
        state.clickedSendButton += 1;
        commitSend();
      }
    },
    isEnabled: async () => true,
    innerText: async () => node?.innerText ?? state.assistantMessages.at(-1)?.innerText ?? "",
    evaluate: async (fn, arg) => fn(node, arg?._node ?? arg),
  });

  const page = {
    _state: state,
    async goto(url) {
      state.navigations.push(url);
    },
    async waitForSelector(sel, opts = {}) {
      // firstVisible 会把候选逐个试过来，未命中的必须抛错。
      if (isComposer(sel)) return handle("composer");
      if (isSend(sel)) return handle("send");
      if (isStop(sel)) {
        if (!stopButtonWorks) throw new NotFound(sel);
        if (opts.state === "hidden") {
          state.stopVisible = false;
          return null;
        }
        if (state.stopVisible) return handle("stop");
        throw new NotFound(sel);
      }
      throw new NotFound(sel);
    },
    async $(sel) {
      if (isSend(sel)) return sendButtonWorks ? handle("send") : null;
      if (isComposer(sel)) return handle("composer");
      return null;
    },
    async $$(sel) {
      if (isAssistant(sel)) {
        return state.assistantMessages.map((node) => handle("assistant", node));
      }
      return [];
    },
    async waitForFunction(fn, args) {
      // 真实实现用 document.querySelectorAll 数 assistant 节点，这里按同样方式
      // 提供一个最小 document 让传进来的函数原样执行。
      const hadDocument = Object.hasOwn(globalThis, "document");
      const previous = globalThis.document;
      globalThis.document = {
        querySelectorAll: (selector) => isAssistant(selector) ? state.assistantMessages : [],
      };
      try {
        const browserArgs = args.map((arg) => arg?._node ?? arg);
        if (!fn(browserArgs)) throw new NotFound("waitForFunction 条件未满足");
        return true;
      } finally {
        if (hadDocument) globalThis.document = previous;
        else delete globalThis.document;
      }
    },
    async waitForTimeout(ms) {
      state.waits.push(ms);
    },
    keyboard: {
      async type(text, options) {
        state.typed.push(text);
        // 打字延迟是拟真的一部分，定值会成为可测量的指纹。
        if (options?.delay !== undefined) state.typeDelays.push(options.delay);
      },
      async press(key) {
        if (key === "Enter") {
          state.pressedEnter += 1;
          commitSend();
        }
      },
    },
  };
  return page;
}

const withNext = (body, question) => `${body}\n\n下一个问题：${question}`;

test("会话集没有主题时直接失败，不启动对话", async () => {
  const page = createFakePage([]);
  const result = await runAgent(page, selectors, { topic: "   " });

  assert.equal(result.ok, false);
  assert.match(result.reason, /主题/);
  assert.deepEqual(page._state.navigations, [], "不该导航到新对话页");
});

test("按追问链条跑满计划轮数", async () => {
  const page = createFakePage([
    withNext("讲解索引基础。", "什么是覆盖索引？"),
    withNext("讲解覆盖索引。", "什么是回表？"),
    withNext("讲解回表。", "什么是索引下推？"),
  ]);

  const result = await runAgent(page, selectors, {
    topic: "数据库索引",
    minRounds: 3,
    maxRounds: 3,
  });

  assert.equal(result.ok, true);
  assert.equal(result.totalRounds, 3);
  assert.equal(result.topic, "数据库索引");
  assert.equal(page._state.navigations.length, 1, "一次调用只开一个新对话");

  // 第一轮问的是主题本身，后续轮次问的是上一轮抽出的问题。
  assert.deepEqual(
    result.rounds.map((r) => r.q),
    ["数据库索引", "什么是覆盖索引？", "什么是回表？"]
  );
});

test("首轮 prompt 带主题并要求给出下一个问题，追问轮不再重复主题", async () => {
  const page = createFakePage([
    withNext("第一轮。", "追问一？"),
    withNext("第二轮。", "追问二？"),
  ]);

  await runAgent(page, selectors, { topic: "分布式事务", minRounds: 2, maxRounds: 2 });

  const [first, second] = page._state.typed;
  assert.match(first, /分布式事务/);
  assert.match(first, /下一个问题/, "必须要求模型给出下一个问题");
  assert.match(second, /追问一？/);
  assert.doesNotMatch(second, /分布式事务/, "追问轮不该再塞主题模板");
  assert.match(second, /下一个问题/);
});

test("抽不到下一个问题时提前结束，并记录可辨别的结束原因", async () => {
  const page = createFakePage([
    withNext("第一轮有追问。", "追问一？"),
    "第二轮忘了给下一个问题。",
    withNext("不该跑到第三轮。", "追问三？"),
  ]);

  const result = await runAgent(page, selectors, {
    topic: "缓存",
    minRounds: 5,
    maxRounds: 5,
  });

  assert.equal(result.ok, true, "已完成的轮次仍算有效");
  assert.equal(result.totalRounds, 2);
  assert.equal(result.targetRounds, 5, "必须暴露计划轮数，否则看不出提前结束");
  assert.equal(result.stopReason, "no-next-question");
});

test("跑满计划轮数时结束原因是 completed", async () => {
  const page = createFakePage([withNext("内容。", "追问？")]);

  const result = await runAgent(page, selectors, {
    topic: "缓存",
    minRounds: 2,
    maxRounds: 2,
  });

  assert.equal(result.totalRounds, 2);
  assert.equal(result.stopReason, "completed");
});

test("最后一轮没给下一个问题不算提前结束", async () => {
  // 跑满计划轮数后本来就不需要再追问，把它记成 no-next-question 会让历史里
  // 每次正常完成的对话都带上一个假的异常原因。
  const page = createFakePage([
    withNext("第一轮有追问。", "追问一？"),
    "第二轮是最后一轮，不再给下一个问题。",
  ]);

  const result = await runAgent(page, selectors, {
    topic: "收尾",
    minRounds: 2,
    maxRounds: 2,
  });

  assert.equal(result.totalRounds, 2);
  assert.equal(result.stopReason, "completed");
});

test("单轮计划且没有追问时同样算正常完成", async () => {
  const page = createFakePage(["只有一轮，没有下一个问题。"]);

  const result = await runAgent(page, selectors, {
    topic: "单轮",
    minRounds: 1,
    maxRounds: 1,
  });

  assert.equal(result.ok, true);
  assert.equal(result.totalRounds, 1);
  assert.equal(result.stopReason, "completed");
});

test("最后一轮不再插入轮次间停顿", async () => {
  const page = createFakePage([withNext("唯一一轮。", "追问？")]);

  await runAgent(page, selectors, { topic: "停顿", minRounds: 1, maxRounds: 1 });

  assert.ok(
    !page._state.waits.some((ms) => ms >= 3000),
    `最后一轮后不该再等：${page._state.waits.join(",")}`
  );
});

test("发送失败与解析失败在结果里可区分", async () => {
  const page = createFakePage(
    [withNext("第一轮。", "追问一？"), withNext("第二轮。", "追问二？")],
    { failSendAtRound: 2 }
  );

  const result = await runAgent(page, selectors, {
    topic: "消息队列",
    minRounds: 4,
    maxRounds: 4,
  });

  assert.equal(result.totalRounds, 1);
  assert.equal(result.ok, false, "发送失败不能因已有一轮完成就冒充成功");
  assert.equal(result.stopReason, "send-failed");
  assert.match(result.reason ?? "", /网络中断/, "失败详情要能追溯到原始错误");
});

test("新回复未出现时不把上一轮回复重复当成本轮结果", async () => {
  const page = createFakePage(
    [withNext("第一轮。", "追问一？"), withNext("不应出现。", "追问二？")],
    { noReplyAtRound: 2 }
  );

  const result = await runAgent(page, selectors, {
    topic: "消息队列",
    minRounds: 3,
    maxRounds: 3,
  });

  assert.equal(page._state.sends, 2);
  assert.equal(result.totalRounds, 1, "第二轮没有新回复，不能重复保存第一轮内容");
  assert.equal(result.ok, false);
  assert.equal(result.stopReason, "send-failed");
  assert.match(result.reason ?? "", /未检测到新的回复/);
});

test("长会话 DOM 虚拟化时不要求回复节点总数增加", async () => {
  const replies = Array.from({ length: 5 }, (_, index) =>
    withNext(`第 ${index + 1} 轮正文。`, `追问 ${index + 1}？`)
  );
  const page = createFakePage(replies, {
    virtualizeAssistantLimit: 3,
  });

  const result = await runAgent(page, selectors, {
    topic: "虚拟列表",
    minRounds: 5,
    maxRounds: 5,
  });

  assert.equal(result.ok, true);
  assert.equal(result.totalRounds, 5);
  assert.equal(page._state.assistantMessages.length, 3, "页面应只保留最近三个回复节点");
});

test("第一轮就发送失败时整次运行判为失败", async () => {
  const page = createFakePage([withNext("内容。", "追问？")], { failSendAtRound: 1 });

  const result = await runAgent(page, selectors, {
    topic: "消息队列",
    minRounds: 3,
    maxRounds: 3,
  });

  assert.equal(result.ok, false);
  assert.equal(result.totalRounds, 0);
  assert.equal(result.stopReason, "send-failed");
  // 一轮都没跑成时，界面上只剩这个 reason，原始错误必须留在里面。
  assert.match(result.reason, /网络中断/);
});

test("回复超长时按上限截断并留下省略标记", async () => {
  const long = "答".repeat(REPLY_STORE_LIMIT + 400);
  const page = createFakePage([withNext(long, "追问？")]);

  const result = await runAgent(page, selectors, {
    topic: "存储",
    minRounds: 1,
    maxRounds: 1,
  });

  const answer = result.rounds[0].a;
  assert.ok(answer.length <= REPLY_STORE_LIMIT + 1, `实际长度 ${answer.length}`);
  assert.ok(answer.endsWith("…"), "截断过的回复要能看出被截断");
});

test("常见长度的完整回答不再被截断", async () => {
  // 500 字上限是 JSONL 时代的遗产，一次正常的长回答就会被砍掉大半，
  // 跑完几十轮后手上没有可回看的原始内容。
  const realisticAnswer = "这是一段完整的技术讲解。".repeat(150);
  assert.ok(realisticAnswer.length > 500, "测试数据必须超过旧的 500 字上限");
  const page = createFakePage([withNext(realisticAnswer, "追问？")]);

  const result = await runAgent(page, selectors, {
    topic: "存储",
    minRounds: 1,
    maxRounds: 1,
  });

  const answer = result.rounds[0].a;
  assert.doesNotMatch(answer, /…$/, "这个长度不该被截断");
  assert.ok(answer.includes(realisticAnswer), "回答正文要完整保留");
});

test("回复未超长时原样保留，不加省略号", async () => {
  const page = createFakePage([withNext("短回复。", "追问？")]);

  const result = await runAgent(page, selectors, {
    topic: "存储",
    minRounds: 1,
    maxRounds: 1,
  });

  assert.doesNotMatch(result.rounds[0].a, /…$/);
  assert.match(result.rounds[0].a, /短回复。/);
});

test("轮次之间会插入停顿，不是连续发送", async () => {
  const page = createFakePage([
    withNext("一。", "追问一？"),
    withNext("二。", "追问二？"),
  ]);

  await runAgent(page, selectors, { topic: "限流", minRounds: 2, maxRounds: 2 });

  // 轮次间停顿按 3000ms 起跳，必须真的出现在等待序列里。
  assert.ok(
    page._state.waits.some((ms) => ms >= 3000),
    `等待序列里没有轮次间停顿：${page._state.waits.join(",")}`
  );
});

test("抓不到停止按钮时退化为文本稳定判定，仍能完成对话", async () => {
  const page = createFakePage([withNext("内容。", "追问？")], { stopButton: false });

  const result = await runAgent(page, selectors, {
    topic: "可观测性",
    minRounds: 1,
    maxRounds: 1,
  });

  assert.equal(result.ok, true);
  assert.equal(result.totalRounds, 1);
});

test("发送按钮不可用时回退到回车发送", async () => {
  const page = createFakePage([withNext("内容。", "追问？")], { sendButton: false });

  const result = await runAgent(page, selectors, {
    topic: "可观测性",
    minRounds: 1,
    maxRounds: 1,
  });

  assert.equal(result.ok, true);
  assert.equal(page._state.pressedEnter, 1);
  assert.equal(page._state.clickedSendButton, 0);
});

test("单字符串选择器配置与数组配置行为一致", async () => {
  const scalarSelectors = {
    ...selectors,
    loginIndicators: selectors.loginIndicators[0],
    composer: selectors.composer[0],
    sendButton: selectors.sendButton[0],
    stopButton: selectors.stopButton[0],
    assistantMessage: selectors.assistantMessage[0],
  };
  const page = createFakePage([withNext("内容。", "追问？")], {
    selectors: scalarSelectors,
  });

  const result = await runAgent(page, scalarSelectors, {
    topic: "选择器形态",
    minRounds: 1,
    maxRounds: 1,
  });

  assert.equal(result.ok, true);
  assert.equal(result.totalRounds, 1);
});

test("计划轮数落在会话集给出的区间内", async () => {
  const replies = Array.from({ length: 20 }, (_, i) => withNext(`第 ${i} 轮。`, `追问 ${i}？`));
  for (let attempt = 0; attempt < 12; attempt++) {
    const page = createFakePage(replies);
    const result = await runAgent(page, selectors, {
      topic: "区间",
      minRounds: 2,
      maxRounds: 4,
    });
    assert.ok(
      result.targetRounds >= 2 && result.targetRounds <= 4,
      `targetRounds=${result.targetRounds} 越界`
    );
    assert.equal(result.totalRounds, result.targetRounds);
  }
});

test("轮数为 0 的会话集仍至少跑一轮", async () => {
  // 契约允许 minRounds/maxRounds 为 0，真按 0 轮跑就等于开了个新对话什么都不问，
  // 白起一次浏览器。
  const page = createFakePage([withNext("内容。", "追问？")]);

  const result = await runAgent(page, selectors, {
    topic: "零轮",
    minRounds: 0,
    maxRounds: 0,
  });

  assert.equal(result.targetRounds, 1);
  assert.equal(result.totalRounds, 1);
  assert.equal(result.ok, true);
});

test("minRounds 大于 maxRounds 时不会算出空区间", async () => {
  // 会话集这两个字段没有 min<=max 校验（账号的窗口数才有），区间反转会让
  // randInt 取到负数或 0。
  const replies = Array.from({ length: 20 }, (_, i) => withNext(`第 ${i} 轮。`, `追问 ${i}？`));
  const page = createFakePage(replies);

  const result = await runAgent(page, selectors, {
    topic: "反转区间",
    minRounds: 6,
    maxRounds: 2,
  });

  assert.equal(result.targetRounds, 6);
  assert.equal(result.totalRounds, 6);
});

test("缺省轮数区间也能跑起来", async () => {
  const replies = Array.from({ length: 20 }, (_, i) => withNext(`第 ${i} 轮。`, `追问 ${i}？`));
  const page = createFakePage(replies);

  const result = await runAgent(page, selectors, { topic: "缺省" });

  assert.ok(result.targetRounds >= 2 && result.targetRounds <= 10);
  assert.equal(result.ok, true);
});

test("开新对话用的是 newChatUrl", async () => {
  const page = createFakePage([withNext("内容。", "追问？")]);

  await runAgent(page, selectors, { topic: "导航", minRounds: 1, maxRounds: 1 });

  assert.equal(page._state.navigations[0], selectors.newChatUrl);
});
