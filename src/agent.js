import { sendPrompt, startNewChat, extractNextQuestion } from "./chat.js";
import * as log from "./logger.js";

function secureRandom() {
  try {
    const arr = new Uint32Array(1);
    globalThis.crypto.getRandomValues(arr);
    return arr[0] / 2 ** 32;
  } catch {
    return 0.5;
  }
}

// [min, max] 闭区间随机整数
function randInt(min, max) {
  const lo = Math.max(1, Math.floor(min));
  const hi = Math.max(lo, Math.floor(max));
  return lo + Math.floor(secureRandom() * (hi - lo + 1));
}

// 首问模板：围绕主题，并要求 GPT 在结尾给出“下一个问题”。
function buildFirstPrompt(topic) {
  return (
    `我想系统地学习「${topic}」相关的知识。` +
    `请讲解一个该主题下值得掌握的知识点，尽量具体、带例子。` +
    `在回答的最后另起一行，用「下一个问题：」开头，提出一个可以继续深入的相关问题。`
  );
}

// 追问模板：把上一轮 GPT 给的问题作为新问题，同样要求给出下一个问题。
function buildFollowupPrompt(question) {
  return (
    `${question}\n\n` +
    `请详细解答。在回答的最后另起一行，用「下一个问题：」开头，` +
    `提出一个可以继续深入的相关问题。`
  );
}

// 每轮回复存历史时的截断长度，避免 logs 体积膨胀。
const REPLY_STORE_LIMIT = 500;

/**
 * Agent 模式：一次调用 = 开一个新对话线程，围绕主题连续自我追问随机轮数。
 * 「新开对话」由更上层的调度周期自然驱动——每个调度周期跑一次本函数，
 * 即开一个新对话；下个周期再来一次，就是新的对话。
 *
 * 每轮问题来自上一轮 GPT 回答末尾的「下一个问题」，抽不到则提前结束。
 *
 * @param page Playwright page（已登录、已在 ChatGPT）
 * @param selectors 选择器配置
 * @param set 会话集 { topic, minRounds, maxRounds }
 * @returns { ok, topic, rounds:[{q,a}], totalRounds, reason? }
 */
export async function runAgent(page, selectors, set) {
  const topic = (set.topic || "").trim();
  if (!topic) return { ok: false, reason: "会话集未设置主题" };

  const targetRounds = randInt(set.minRounds ?? 2, set.maxRounds ?? 10);
  log.info(`Agent 主题「${topic}」，本对话计划 ${targetRounds} 轮`);

  await startNewChat(page, selectors);
  const rounds = [];
  let nextQuestion = null;

  for (let i = 0; i < targetRounds; i++) {
    const question = i === 0 ? topic : nextQuestion;
    const prompt =
      i === 0 ? buildFirstPrompt(topic) : buildFollowupPrompt(nextQuestion);

    let reply;
    try {
      reply = await sendPrompt(page, selectors, prompt);
    } catch (e) {
      log.warn(`第 ${i + 1} 轮发送失败: ${e.message}`);
      break;
    }

    // 精简存储：只留问题与截断后的回复，不存完整 prompt 模板。
    rounds.push({
      q: question,
      a: reply.length > REPLY_STORE_LIMIT ? reply.slice(0, REPLY_STORE_LIMIT) + "…" : reply,
    });

    nextQuestion = extractNextQuestion(reply);
    if (!nextQuestion) {
      log.info(`第 ${i + 1} 轮未解析到“下一个问题”，结束本对话线程`);
      break;
    }
    // 轮次间隔，像真人阅读思考
    await page.waitForTimeout(3000 + Math.floor(secureRandom() * 5000));
  }

  return {
    ok: rounds.length > 0,
    topic,
    rounds,
    totalRounds: rounds.length,
    reason: rounds.length === 0 ? "没有完成任何一轮对话" : undefined,
  };
}
