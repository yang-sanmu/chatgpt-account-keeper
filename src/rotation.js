import {
  getConversations as defaultGetConversations,
  updateAccount as defaultUpdateAccount,
} from "./store.js";

// 主题轮换：账号不绑定单个会话集，而是在所有会话集之间按规则切换。
// 1 个窗口 = 1 次对话。某主题连续跑够随机窗口数后，切换到下一个主题。
//
// 这两个函数原先直接调全局 store：读会话集、写账号都是隐式的副作用，
// 单看签名 selectSetForAccount(account) 完全看不出它会写库。改成可选注入后
// 依赖变成显式的，同时保留默认值——调用方不传就还是走全局 store，行为不变。

function secureRandom() {
  try {
    const arr = new Uint32Array(1);
    globalThis.crypto.getRandomValues(arr);
    return arr[0] / 2 ** 32;
  } catch {
    return 0.5;
  }
}

function randInt(min, max) {
  const lo = Math.max(1, Math.floor(min));
  const hi = Math.max(lo, Math.floor(max));
  return lo + Math.floor(secureRandom() * (hi - lo + 1));
}

// 轮换计数可能来自旧 JSON、手工编辑或部分写入，缺字段和字符串都出现过。
// undefined 参与数值比较全是 false，字符串参与加法会变成拼接——两者都会让
// 轮换静默失效（账号永久停在同一主题，或计数变成 "31"），所以统一归一化。
function counter(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

// 按规则选下一个主题名。sequential 从当前主题的下一个循环，random 从其他主题中挑。
function pickNextSet(names, rule, current) {
  if (names.length === 0) return null;
  if (names.length === 1) return names[0];

  if (rule === "sequential") {
    const idx = current ? names.indexOf(current) : -1;
    return names[(idx + 1) % names.length];
  }
  // 直接从其他主题中抽，避免“最多重试 10 次”仍连续抽回当前主题。后者会让已经
  // 达到窗口上限的账号偶发地继续停在原主题，随机源不可用并回落固定值时更会复现。
  const choices = names.includes(current) ? names.filter((name) => name !== current) : names;
  return choices[Math.floor(secureRandom() * choices.length)];
}

/**
 * 为账号决定本次对话使用哪个会话集（主题），并推进轮换状态。
 * 逻辑：若无当前主题或已达目标窗口数 → 切换主题、随机定新目标窗口数、重置计数。
 * 返回 { set, setName } 或 null（没有任何会话集时）。
 *
 * 注意：本函数只“选择并在切换时初始化状态”，不增加 windowsDone；
 * 跑完一次对话后由 commitWindow() 递增计数并持久化。
 *
 * deps 可注入 getConversations / updateAccount；不传则走全局 store。
 */
export function selectSetForAccount(account, deps = {}) {
  const getConversations = deps.getConversations ?? defaultGetConversations;
  const updateAccount = deps.updateAccount ?? defaultUpdateAccount;
  const sets = getConversations();
  const names = Object.keys(sets).filter((n) => (sets[n]?.topic || "").trim());
  if (names.length === 0) return null;

  const rule = account.switchRule ?? "random";
  const rot = account.rotation ?? { currentSet: null, windowsDone: 0, windowsTarget: 0 };
  const doneSoFar = counter(rot.windowsDone);
  const targetSoFar = counter(rot.windowsTarget);

  // counter() 已把缺失、非法和负数计数归一成 0，所以"还没定过目标窗口数"
  // （target 为 0）也落在下面这个比较里，不需要单独判断。
  const needSwitch =
    !rot.currentSet ||
    !names.includes(rot.currentSet) ||
    doneSoFar >= targetSoFar;

  let currentSet = rot.currentSet;
  let windowsDone = doneSoFar;
  let windowsTarget = targetSoFar;

  if (needSwitch) {
    currentSet = pickNextSet(names, rule, rot.currentSet);
    windowsTarget = randInt(account.minWindows ?? 1, account.maxWindows ?? 3);
    windowsDone = 0;
    // 立即持久化“切换后”的状态
    updateAccount(account.id, {
      rotation: { currentSet, windowsDone, windowsTarget },
    });
  }

  return { setName: currentSet, set: sets[currentSet] };
}

/**
 * 一次对话跑完后调用：windowsDone + 1 并持久化。
 * 返回更新后的 rotation。
 *
 * deps 可注入 updateAccount；不传则走全局 store。
 */
export function commitWindow(accountId, prevRotation, deps = {}) {
  const updateAccount = deps.updateAccount ?? defaultUpdateAccount;
  const rot = prevRotation ?? { currentSet: null, windowsDone: 0, windowsTarget: 0 };
  const next = { ...rot, windowsDone: counter(rot.windowsDone) + 1 };
  updateAccount(accountId, { rotation: next });
  return next;
}
