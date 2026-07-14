import { getConversations, updateAccount } from "./store.js";

// 主题轮换：账号不绑定单个会话集，而是在所有会话集之间按规则切换。
// 1 个窗口 = 1 次对话。某主题连续跑够随机窗口数后，切换到下一个主题。

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

// 按规则选下一个主题名。sequential 从当前主题的下一个循环，random 随机挑（尽量不与当前相同）。
function pickNextSet(names, rule, current) {
  if (names.length === 0) return null;
  if (names.length === 1) return names[0];

  if (rule === "sequential") {
    const idx = current ? names.indexOf(current) : -1;
    return names[(idx + 1) % names.length];
  }
  // random：随机挑一个与 current 不同的
  let pick = current;
  for (let i = 0; i < 10 && pick === current; i++) {
    pick = names[Math.floor(secureRandom() * names.length)];
  }
  return pick;
}

/**
 * 为账号决定本次对话使用哪个会话集（主题），并推进轮换状态。
 * 逻辑：若无当前主题或已达目标窗口数 → 切换主题、随机定新目标窗口数、重置计数。
 * 返回 { set, setName } 或 null（没有任何会话集时）。
 *
 * 注意：本函数只“选择并在切换时初始化状态”，不增加 windowsDone；
 * 跑完一次对话后由 commitWindow() 递增计数并持久化。
 */
export function selectSetForAccount(account) {
  const sets = getConversations();
  const names = Object.keys(sets).filter((n) => (sets[n]?.topic || "").trim());
  if (names.length === 0) return null;

  const rule = account.switchRule ?? "random";
  const rot = account.rotation ?? { currentSet: null, windowsDone: 0, windowsTarget: 0 };

  const needSwitch =
    !rot.currentSet ||
    !names.includes(rot.currentSet) ||
    rot.windowsDone >= rot.windowsTarget ||
    rot.windowsTarget <= 0;

  let currentSet = rot.currentSet;
  let windowsDone = rot.windowsDone;
  let windowsTarget = rot.windowsTarget;

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
 */
export function commitWindow(accountId, prevRotation) {
  const rot = prevRotation ?? { currentSet: null, windowsDone: 0, windowsTarget: 0 };
  const next = { ...rot, windowsDone: (rot.windowsDone ?? 0) + 1 };
  updateAccount(accountId, { rotation: next });
  return next;
}
