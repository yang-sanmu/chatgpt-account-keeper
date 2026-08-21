import { sendPrompt, startNewChat, extractNextQuestion } from "./chat.js";
import {
  buildFirstPrompt,
  buildFollowupPrompt,
  randomInt,
  roundPauseMs,
} from "./humanize.js";
import * as log from "./logger.js";

// 计划轮数至少为 1：契约允许 minRounds/maxRounds 为 0，真按 0 轮跑等于开个新对话
// 什么都不问，白起一次浏览器。上界不需要单独兜底——randomInt 自己会把 hi 抬到
// 不低于 lo，区间反转（min > max）也落在那里。
function plannedRounds(min, max) {
  return randomInt(Math.max(1, min), max);
}

/**
 * 每轮回复存历史时的截断长度。
 *
 * 500 字上限会把正常长回答砍掉大半，跑过几十轮后没有可回看的原始内容，改了
 * prompt 模板也没法对比前后差异。安装版历史已进 SQLite；旧 CLI 仍可能写 JSONL，
 * 因此不能完全取消上限。
 *
 * 放宽到 20000 字（约等于一次长回答的完整长度），仍然保留上限：模型偶发的重复
 * 输出可以刷出几十万字，不设界会让单行历史变得难以处理。
 */
export const REPLY_STORE_LIMIT = 20000;

/**
 * Agent 模式：一次调用 = 开一个新对话线程，围绕主题连续自我追问随机轮数。
 * 「新开对话」由更上层的调度周期自然驱动——每个调度周期跑一次本函数，
 * 即开一个新对话；下个周期再来一次，就是新的对话。
 *
 * 每轮问题来自上一轮 GPT 回答末尾的「下一个问题」，抽不到则提前结束。
 *
 * 结束原因通过 stopReason 明确给出，配合 targetRounds 才能在历史里区分
 * "计划 8 轮跑满 8 轮"和"计划 8 轮只跑了 2 轮"——后者又分为模型没给出下一个
 * 问题（no-next-question）和发送本身失败（send-failed）。只写日志的话，界面
 * 上这三种情况长得一模一样。
 *
 * @param page Playwright page（已登录、已在 ChatGPT）
 * @param selectors 选择器配置
 * @param set 会话集 { topic, minRounds, maxRounds }
 * @returns { ok, topic, rounds:[{q,a}], totalRounds, targetRounds, stopReason, reason? }
 */
export async function runAgent(page, selectors, set) {
  const topic = (set.topic || "").trim();
  if (!topic) {
    return { ok: false, reason: "会话集未设置主题", stopReason: "no-topic" };
  }

  const targetRounds = plannedRounds(set.minRounds ?? 2, set.maxRounds ?? 10);
  log.info(`Agent 主题「${topic}」，本对话计划 ${targetRounds} 轮`);

  await startNewChat(page, selectors);
  const rounds = [];
  let nextQuestion = null;
  // 跑满全部计划轮数时循环自然结束，此时结束原因就是 completed。
  let stopReason = "completed";
  let sendError = null;

  for (let i = 0; i < targetRounds; i++) {
    const question = i === 0 ? topic : nextQuestion;
    const prompt =
      i === 0 ? buildFirstPrompt(topic) : buildFollowupPrompt(nextQuestion);

    let reply;
    try {
      reply = await sendPrompt(page, selectors, prompt);
    } catch (e) {
      log.warn(`第 ${i + 1} 轮发送失败: ${e.message}`);
      stopReason = "send-failed";
      sendError = e;
      break;
    }

    // 精简存储：只留问题与截断后的回复，不存完整 prompt 模板。
    rounds.push({
      q: question,
      a: reply.length > REPLY_STORE_LIMIT ? reply.slice(0, REPLY_STORE_LIMIT) + "…" : reply,
    });

    // 最后一轮不需要再要下一个问题，抽不到也不算提前结束。
    if (i === targetRounds - 1) break;

    nextQuestion = extractNextQuestion(reply);
    if (!nextQuestion) {
      log.info(`第 ${i + 1} 轮未解析到“下一个问题”，结束本对话线程`);
      stopReason = "no-next-question";
      break;
    }
    // 轮次间隔。带长尾的分布，不是一个整齐的矩形。
    await page.waitForTimeout(roundPauseMs());
  }

  // 发送失败即使已经跑过几轮也要留下原始错误，否则历史里只剩一个轮数，
  // 排查时分不清是网络问题还是选择器失效。
  const reason = rounds.length === 0
    ? sendError
      ? `没有完成任何一轮对话：${sendError.message}`
      : "没有完成任何一轮对话"
    : sendError
      ? `第 ${rounds.length + 1} 轮发送失败：${sendError.message}`
      : undefined;

  return {
    // 模型不再给追问时，已完成的轮次仍是有效对话；真正的发送失败则不能冒充
    // 成功，否则任务中心会显示绿色并错误推进主题窗口。
    ok: rounds.length > 0 && stopReason !== "send-failed",
    topic,
    rounds,
    totalRounds: rounds.length,
    targetRounds,
    stopReason,
    reason,
  };
}
