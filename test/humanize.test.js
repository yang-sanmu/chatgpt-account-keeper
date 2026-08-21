import test from "node:test";
import assert from "node:assert/strict";
import {
  ROUND_PAUSE_MS,
  TEMPLATE_COUNTS,
  TYPING_DELAY_MS,
  buildFirstPrompt,
  buildFollowupPrompt,
  preSendPauseMs,
  randomInt,
  roundPauseMs,
  typingDelayMs,
} from "../src/humanize.js";

// 行为节奏拟真的价值在于"不再是定值"，所以这里既要验证区间边界，也要验证同一
// 主题在多次调用间真的会产出不同的文本和间隔。

/** 把 random 钉成给定序列，用完循环最后一个值。 */
function seq(values) {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)];
}

test("randomInt 覆盖闭区间的两个端点", () => {
  assert.equal(randomInt(3, 7, () => 0), 3);
  assert.equal(randomInt(3, 7, () => 0.999999), 7);
});

test("randomInt 在 min 大于 max 时不产生空区间", () => {
  assert.equal(randomInt(9, 2, () => 0), 9);
  assert.equal(randomInt(9, 2, () => 0.999999), 9);
});

test("打字延迟覆盖区间且随随机输入变化", () => {
  assert.equal(typingDelayMs(() => 0), TYPING_DELAY_MS.min);
  assert.equal(typingDelayMs(() => 0.999999), TYPING_DELAY_MS.max);
  assert.notEqual(typingDelayMs(() => 0.25), typingDelayMs(() => 0.75));
});

test("轮次停顿的常规分支落在 4-15 秒", () => {
  // 第一次取值决定走不走长尾，第二次决定具体时长。
  assert.equal(roundPauseMs(seq([0.99, 0])), ROUND_PAUSE_MS.min);
  assert.equal(roundPauseMs(seq([0.99, 0.999999])), ROUND_PAUSE_MS.max);
});

test("轮次停顿有长尾分支，不是均匀矩形", () => {
  // 真人偶尔会停下来想很久。全是 4-15 秒的均匀分布本身就是一种指纹。
  assert.equal(roundPauseMs(seq([0, 0])), ROUND_PAUSE_MS.longTailMin);
  assert.equal(roundPauseMs(seq([0, 0.999999])), ROUND_PAUSE_MS.longTailMax);
});

test("长尾分支严格按配置概率边界选择", () => {
  assert.ok(roundPauseMs(seq([ROUND_PAUSE_MS.longTailChance - 0.0001, 0])) >= ROUND_PAUSE_MS.longTailMin);
  assert.ok(roundPauseMs(seq([ROUND_PAUSE_MS.longTailChance, 0])) < ROUND_PAUSE_MS.longTailMin);
});

test("轮次停顿绝不会短于旧实现的下限", () => {
  // 旧实现是 3000 + rand*5000。拟真不该反而让节奏变得更急。
  for (let i = 0; i < 500; i++) {
    assert.ok(roundPauseMs() >= 3000, "停顿不该短于 3 秒");
  }
});

test("发送前停顿覆盖合理区间", () => {
  assert.equal(preSendPauseMs(() => 0), 250);
  assert.equal(preSendPauseMs(() => 0.999999), 900);
  assert.notEqual(preSendPauseMs(() => 0.25), preSendPauseMs(() => 0.75));
});

test("首问 prompt 带主题并要求给出下一个问题", () => {
  const prompt = buildFirstPrompt("数据库索引", () => 0);
  assert.match(prompt, /数据库索引/);
  // 这个前缀是 extractNextQuestion 的硬约定，任何模板变体都不能丢。
  assert.match(prompt, /下一个问题：/);
});

test("主题和追问中的 replacement 特殊符号保持原样", () => {
  assert.match(buildFirstPrompt("正则里的 $&", () => 0), /正则里的 \$&/);
  assert.match(buildFollowupPrompt("$& 会替换成什么？", () => 0), /\$& 会替换成什么？/);
});

test("首问模板有多个变体，同一主题不会每次都是同一句", () => {
  const seen = new Set();
  for (let i = 0; i < TEMPLATE_COUNTS.first; i++) {
    seen.add(buildFirstPrompt("缓存", seq([i / TEMPLATE_COUNTS.first, 0])));
  }
  assert.equal(seen.size, TEMPLATE_COUNTS.first);
});

test("结尾的追问要求也有多个变体", () => {
  const prompts = new Set();
  for (let i = 0; i < TEMPLATE_COUNTS.instruction; i++) {
    prompts.add(buildFirstPrompt("固定主题", seq([0, i / TEMPLATE_COUNTS.instruction])));
  }
  assert.equal(prompts.size, TEMPLATE_COUNTS.instruction);
});

test("首问的正文与结尾独立变化，组合数是两者相乘", () => {
  const combos = new Set();
  for (let t = 0; t < TEMPLATE_COUNTS.first; t++) {
    for (let n = 0; n < TEMPLATE_COUNTS.instruction; n++) {
      combos.add(buildFirstPrompt(
        "组合",
        seq([t / TEMPLATE_COUNTS.first, n / TEMPLATE_COUNTS.instruction])
      ));
    }
  }
  assert.equal(combos.size, TEMPLATE_COUNTS.first * TEMPLATE_COUNTS.instruction);
});

test("每个首问模板变体都保留追问约定", () => {
  // 遍历所有模板与所有结尾指令的组合。
  for (let t = 0; t < TEMPLATE_COUNTS.first; t++) {
    for (let n = 0; n < TEMPLATE_COUNTS.instruction; n++) {
      const random = seq([t / TEMPLATE_COUNTS.first, n / TEMPLATE_COUNTS.instruction]);
      const prompt = buildFirstPrompt("消息队列", random);
      assert.match(prompt, /消息队列/, `模板 ${t}/${n} 丢了主题`);
      assert.match(prompt, /下一个问题：/, `模板 ${t}/${n} 丢了追问约定`);
      assert.ok(!prompt.includes("{topic}"), `模板 ${t}/${n} 占位符未替换`);
    }
  }
});

test("追问 prompt 带上一轮问题，且不重复塞主题", () => {
  const prompt = buildFollowupPrompt("什么是覆盖索引？", () => 0);
  assert.match(prompt, /什么是覆盖索引？/);
  assert.match(prompt, /下一个问题：/);
});

test("追问模板有多个变体", () => {
  const seen = new Set();
  for (let i = 0; i < TEMPLATE_COUNTS.followup; i++) {
    seen.add(buildFollowupPrompt("追问内容？", seq([i / TEMPLATE_COUNTS.followup, 0])));
  }
  assert.equal(seen.size, TEMPLATE_COUNTS.followup);
});

test("每个追问模板变体都保留追问约定", () => {
  for (let t = 0; t < TEMPLATE_COUNTS.followup; t++) {
    for (let n = 0; n < TEMPLATE_COUNTS.instruction; n++) {
      const random = seq([t / TEMPLATE_COUNTS.followup, n / TEMPLATE_COUNTS.instruction]);
      const prompt = buildFollowupPrompt("上一轮的问题？", random);
      assert.match(prompt, /上一轮的问题？/, `模板 ${t}/${n} 丢了问题`);
      assert.match(prompt, /下一个问题：/, `模板 ${t}/${n} 丢了追问约定`);
      assert.ok(!prompt.includes("{question}"), `模板 ${t}/${n} 占位符未替换`);
    }
  }
});

test("random 返回 1 时不会索引越界", () => {
  // Math.random 规范上不返回 1，但注入的实现可能会。越界会产出 undefined 模板。
  const first = buildFirstPrompt("边界", () => 1);
  const followup = buildFollowupPrompt("边界问题？", () => 1);
  assert.match(first, /边界/);
  assert.match(first, /下一个问题：/);
  assert.match(followup, /边界问题？/);
  assert.ok(!first.includes("undefined"));
  assert.ok(!followup.includes("undefined"));
});

test("生成的 prompt 里能被自己的抽取逻辑找到约定前缀", async () => {
  // prompt 要求模型用「下一个问题：」开头回答；如果模板措辞漂移到 extractNextQuestion
  // 认不出的形式，追问链条会整体失效。这里用真实抽取函数验证闭环。
  const { extractNextQuestion } = await import("../src/chat.js");
  for (let i = 0; i < 50; i++) {
    const prompt = buildFirstPrompt("闭环");
    // 模拟模型照约定作答。
    const reply = `讲解内容。\n\n下一个问题：接下来的问题？`;
    assert.match(prompt, /下一个问题：/);
    assert.equal(extractNextQuestion(reply), "接下来的问题？");
  }
});
