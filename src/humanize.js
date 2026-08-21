/**
 * 行为节奏拟真。
 *
 * 原先所有节奏都是定值：打字延迟固定 25ms、轮次间隔固定 3000 + rand*5000、首问
 * 模板每个账号每个主题都是同一段文字。前两个是可测量的机器指纹，第三个更要紧——
 * 无论多少账号跑多少主题，第一句话完全一样。
 *
 * 这里集中提供三样东西：区间化的随机节奏、带长尾的停顿、以及首问/追问的模板变体。
 * 所有随机都走注入进来的 random 函数，测试里可以钉死。
 */

function defaultRandom() {
  try {
    const array = new Uint32Array(1);
    globalThis.crypto.getRandomValues(array);
    return array[0] / 2 ** 32;
  } catch {
    return 0.5;
  }
}

/** [min, max] 闭区间随机整数。min > max 时按 min 处理，不产生空区间。 */
export function randomInt(min, max, random = defaultRandom) {
  const lo = Math.floor(min);
  const hi = Math.max(lo, Math.floor(max));
  return lo + Math.floor(random() * (hi - lo + 1));
}

/**
 * 打字延迟。真人的击键间隔不是常数，这里每次取一个区间内的值。
 * Playwright 的 delay 是每键固定值，做不到逐键抖动，但至少让每轮不同。
 */
export const TYPING_DELAY_MS = Object.freeze({ min: 18, max: 48 });

export function typingDelayMs(random = defaultRandom) {
  return randomInt(TYPING_DELAY_MS.min, TYPING_DELAY_MS.max, random);
}

/**
 * 轮次之间的停顿。
 *
 * 原来是 3000 + rand*5000，一个整齐的 3–8 秒均匀分布。真人的阅读间隔是右偏的：
 * 多数时候几秒扫一眼，偶尔停下来想很久。这里九成落在 4–15 秒，一成落在长尾的
 * 20–70 秒，让分布不再是一个矩形。
 */
export const ROUND_PAUSE_MS = Object.freeze({
  min: 4000,
  max: 15000,
  longTailMin: 20000,
  longTailMax: 70000,
  longTailChance: 0.1,
});

export function roundPauseMs(random = defaultRandom) {
  if (random() < ROUND_PAUSE_MS.longTailChance) {
    return randomInt(ROUND_PAUSE_MS.longTailMin, ROUND_PAUSE_MS.longTailMax, random);
  }
  return randomInt(ROUND_PAUSE_MS.min, ROUND_PAUSE_MS.max, random);
}

/** 发送前的短暂停顿：输入完到点发送之间，真人总有一点间隔。 */
export function preSendPauseMs(random = defaultRandom) {
  return randomInt(250, 900, random);
}

// 首问模板变体。都要求模型在末尾给出「下一个问题：」——这是追问链条的硬约定，
// 变的只是措辞。{topic} 是唯一占位符。
const FIRST_PROMPT_TEMPLATES = Object.freeze([
  "我想系统地学习「{topic}」相关的知识。请讲解一个该主题下值得掌握的知识点，尽量具体、带例子。",
  "最近在研究「{topic}」，想打牢基础。挑一个这个主题里重要的知识点讲讲，最好有实际例子。",
  "帮我入门「{topic}」。先讲一个核心概念，讲细一点，配个具体场景。",
  "关于「{topic}」，我想从一个具体的点开始了解。选一个关键知识点展开说明，举例说清。",
  "想认真学一下「{topic}」。请从中挑一个值得先掌握的知识点，讲透一些，带上例子。",
  "我对「{topic}」还不熟。麻烦讲解其中一个重要知识点，尽量具体，最好有例子帮助理解。",
]);

// 追问模板变体。{question} 是上一轮模型给出的问题。
const FOLLOWUP_PROMPT_TEMPLATES = Object.freeze([
  "{question}\n\n请详细解答。",
  "{question}\n\n麻烦讲细一些。",
  "{question}\n\n请展开说说，最好带例子。",
  "{question}\n\n这个问题请详细讲解一下。",
  "{question}\n\n想听得具体一点，麻烦详细说明。",
]);

// 结尾的追问要求。措辞可变，但「下一个问题：」这个前缀不能变——extractNextQuestion
// 依赖它抽取下一轮的问题。
const NEXT_QUESTION_INSTRUCTIONS = Object.freeze([
  "在回答的最后另起一行，用「下一个问题：」开头，提出一个可以继续深入的相关问题。",
  "回答结束后另起一行，以「下一个问题：」开头，给出一个值得继续探讨的相关问题。",
  "最后请另起一行，用「下一个问题：」开头，提一个能继续深入的问题。",
  "答完之后另起一行，以「下一个问题：」开头，接着提出一个相关的深入问题。",
]);

function pick(list, random) {
  return list[Math.min(list.length - 1, Math.floor(random() * list.length))];
}

/** 首问 prompt。围绕主题，并要求模型在末尾给出下一个问题。 */
export function buildFirstPrompt(topic, random = defaultRandom) {
  // replacement 用函数，避免主题里的 $&、$`、$' 被 String.replace 当成替换指令。
  const body = pick(FIRST_PROMPT_TEMPLATES, random).replace("{topic}", () => topic);
  return `${body}${pick(NEXT_QUESTION_INSTRUCTIONS, random)}`;
}

/** 追问 prompt。把上一轮模型给的问题作为新问题，同样要求给出下一个问题。 */
export function buildFollowupPrompt(question, random = defaultRandom) {
  const body = pick(FOLLOWUP_PROMPT_TEMPLATES, random).replace("{question}", () => question);
  return `${body}${pick(NEXT_QUESTION_INSTRUCTIONS, random)}`;
}

export const TEMPLATE_COUNTS = Object.freeze({
  first: FIRST_PROMPT_TEMPLATES.length,
  followup: FOLLOWUP_PROMPT_TEMPLATES.length,
  instruction: NEXT_QUESTION_INSTRUCTIONS.length,
});
