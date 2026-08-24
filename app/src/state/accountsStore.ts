// 账号状态管理核心逻辑
// 严格实现 UI_BRIEF 第四节三条必须行为：
// 1. 刷新不丢草稿（草稿字段与服务端基线分离，快照只更新基线）
// 2. 提交期间编辑不丢新值（三路合并：基线、在途提交、最新草稿）
// 3. 增量事件只更新受影响卡片，保持选中态并重新应用筛选

import type { Account, AccountPatch, SwitchRule } from "../ipc/types";

export interface AccountFilter {
  keyword: string;
  groupId: string | "all" | "none";
  status: string | "all";
  switchRule: SwitchRule | "all";
}

export interface AccountItemState {
  baseline: Account;
  draft: AccountPatch;
  submitting: AccountPatch | null;
  effective: Account;
}

export interface AccountsState {
  accounts: Record<string, AccountItemState>;
  accountIds: string[];
  selectedIds: Set<string>;
  filter: AccountFilter;
}

export function createInitialAccountsState(): AccountsState {
  return {
    accounts: {},
    accountIds: [],
    selectedIds: new Set<string>(),
    filter: {
      keyword: "",
      groupId: "all",
      status: "all",
      switchRule: "all",
    },
  };
}

// 计算生效对象：草稿优先于基线，确保用户未保存的输入实时显示
export function computeEffectiveAccount(
  baseline: Account,
  draft: AccountPatch
): Account {
  const effective: Account = { ...baseline };

  if (typeof draft.note === "string") {
    effective.note = draft.note;
  }
  if (draft.groupId !== undefined) {
    effective.groupId = draft.groupId;
  }
  if (typeof draft.enabled === "boolean") {
    effective.enabled = draft.enabled;
  }
  if (draft.switchRule) {
    effective.switchRule = draft.switchRule;
  }
  if (typeof draft.minWindows === "number") {
    effective.minWindows = draft.minWindows;
  }
  if (typeof draft.maxWindows === "number") {
    effective.maxWindows = draft.maxWindows;
  }

  return effective;
}

// 检查某个字段或整张卡片是否存在未保存的脏值
export function isAccountDirty(
  item: AccountItemState,
  field?: keyof AccountPatch
): boolean {
  if (field) {
    const draftVal = item.draft[field];
    if (draftVal === undefined) return false;
    const baseVal = item.baseline[field as keyof Account];
    return draftVal !== baseVal;
  }

  // 检查任意字段是否有脏值
  if (item.draft.note !== undefined && item.draft.note !== item.baseline.note) {
    return true;
  }
  if (
    item.draft.groupId !== undefined &&
    item.draft.groupId !== item.baseline.groupId
  ) {
    return true;
  }
  if (
    item.draft.enabled !== undefined &&
    item.draft.enabled !== item.baseline.enabled
  ) {
    return true;
  }
  if (
    item.draft.switchRule !== undefined &&
    item.draft.switchRule !== item.baseline.switchRule
  ) {
    return true;
  }
  if (
    item.draft.minWindows !== undefined &&
    item.draft.minWindows !== item.baseline.minWindows
  ) {
    return true;
  }
  if (
    item.draft.maxWindows !== undefined &&
    item.draft.maxWindows !== item.baseline.maxWindows
  ) {
    return true;
  }

  return false;
}

// 行为 1 实现：全量同步/刷新时更新基线，但保留用户正在编辑的草稿
export function reconcileAccountsFromBootstrap(
  state: AccountsState,
  serverAccounts: Account[]
): AccountsState {
  const nextAccounts: Record<string, AccountItemState> = {};
  const nextIds: string[] = [];
  const validIds = new Set<string>();

  for (const serverAcc of serverAccounts) {
    nextIds.push(serverAcc.id);
    validIds.add(serverAcc.id);

    const existing = state.accounts[serverAcc.id];
    if (existing) {
      // 保留现有草稿与在途提交，以新基线重新计算 effective
      const nextDraft: AccountPatch = {};

      // 仅保留用户真正改动过且未与新基线相同的草稿
      if (existing.draft.note !== undefined && existing.draft.note !== serverAcc.note) {
        nextDraft.note = existing.draft.note;
      }
      if (existing.draft.groupId !== undefined && existing.draft.groupId !== serverAcc.groupId) {
        nextDraft.groupId = existing.draft.groupId;
      }
      if (existing.draft.enabled !== undefined && existing.draft.enabled !== serverAcc.enabled) {
        nextDraft.enabled = existing.draft.enabled;
      }
      if (existing.draft.switchRule !== undefined && existing.draft.switchRule !== serverAcc.switchRule) {
        nextDraft.switchRule = existing.draft.switchRule;
      }
      if (existing.draft.minWindows !== undefined && existing.draft.minWindows !== serverAcc.minWindows) {
        nextDraft.minWindows = existing.draft.minWindows;
      }
      if (existing.draft.maxWindows !== undefined && existing.draft.maxWindows !== serverAcc.maxWindows) {
        nextDraft.maxWindows = existing.draft.maxWindows;
      }

      nextAccounts[serverAcc.id] = {
        baseline: serverAcc,
        draft: nextDraft,
        submitting: existing.submitting,
        effective: computeEffectiveAccount(serverAcc, nextDraft),
      };
    } else {
      nextAccounts[serverAcc.id] = {
        baseline: serverAcc,
        draft: {},
        submitting: null,
        effective: { ...serverAcc },
      };
    }
  }

  // 清理已经不存在的选中项，但保留存在的选中项
  const nextSelected = new Set<string>();
  for (const id of state.selectedIds) {
    if (validIds.has(id)) {
      nextSelected.add(id);
    }
  }

  return {
    ...state,
    accounts: nextAccounts,
    accountIds: nextIds,
    selectedIds: nextSelected,
  };
}

// 用户更新卡片草稿
export function updateAccountDraft(
  state: AccountsState,
  id: string,
  patch: AccountPatch
): AccountsState {
  const existing = state.accounts[id];
  if (!existing) return state;

  const nextDraft: AccountPatch = { ...existing.draft, ...patch };
  const nextEffective = computeEffectiveAccount(existing.baseline, nextDraft);

  return {
    ...state,
    accounts: {
      ...state.accounts,
      [id]: {
        ...existing,
        draft: nextDraft,
        effective: nextEffective,
      },
    },
  };
}

// 放弃草稿，还原为基线
export function discardAccountDraft(
  state: AccountsState,
  id: string
): AccountsState {
  const existing = state.accounts[id];
  if (!existing) return state;

  return {
    ...state,
    accounts: {
      ...state.accounts,
      [id]: {
        ...existing,
        draft: {},
        effective: { ...existing.baseline },
      },
    },
  };
}

// 标记提交开始
export function startAccountSubmit(
  state: AccountsState,
  id: string,
  submittingPatch: AccountPatch
): AccountsState {
  const existing = state.accounts[id];
  if (!existing) return state;

  return {
    ...state,
    accounts: {
      ...state.accounts,
      [id]: {
        ...existing,
        submitting: submittingPatch,
      },
    },
  };
}

// 行为 2 实现：提交完成（三路合并）
// 若用户在提交期间又改了草稿（当前草稿 != 提交时的快照），保留新草稿并标记脏，仅更新基线
export function finishAccountSubmit(
  state: AccountsState,
  id: string,
  submittedPatch: AccountPatch,
  serverUpdatedAccount?: Account
): AccountsState {
  const existing = state.accounts[id];
  if (!existing) return state;

  // 新基线优先使用服务端返回的完整对象，无返回时使用提交内容合并
  const nextBaseline: Account = serverUpdatedAccount
    ? { ...serverUpdatedAccount }
    : {
        ...existing.baseline,
        ...(typeof submittedPatch.note === "string" ? { note: submittedPatch.note } : {}),
        ...(submittedPatch.groupId !== undefined ? { groupId: submittedPatch.groupId } : {}),
        ...(typeof submittedPatch.enabled === "boolean" ? { enabled: submittedPatch.enabled } : {}),
        ...(submittedPatch.switchRule ? { switchRule: submittedPatch.switchRule } : {}),
        ...(typeof submittedPatch.minWindows === "number" ? { minWindows: submittedPatch.minWindows } : {}),
        ...(typeof submittedPatch.maxWindows === "number" ? { maxWindows: submittedPatch.maxWindows } : {}),
      };

  // 三路合并草稿：如果草稿的值等于已提交确认的值，则清理该字段草稿；否则保留新草稿
  const nextDraft: AccountPatch = { ...existing.draft };

  if (
    submittedPatch.note !== undefined &&
    existing.draft.note === submittedPatch.note
  ) {
    delete nextDraft.note;
  }
  if (
    submittedPatch.groupId !== undefined &&
    existing.draft.groupId === submittedPatch.groupId
  ) {
    delete nextDraft.groupId;
  }
  if (
    submittedPatch.enabled !== undefined &&
    existing.draft.enabled === submittedPatch.enabled
  ) {
    delete nextDraft.enabled;
  }
  if (
    submittedPatch.switchRule !== undefined &&
    existing.draft.switchRule === submittedPatch.switchRule
  ) {
    delete nextDraft.switchRule;
  }
  if (
    submittedPatch.minWindows !== undefined &&
    existing.draft.minWindows === submittedPatch.minWindows
  ) {
    delete nextDraft.minWindows;
  }
  if (
    submittedPatch.maxWindows !== undefined &&
    existing.draft.maxWindows === submittedPatch.maxWindows
  ) {
    delete nextDraft.maxWindows;
  }

  const nextEffective = computeEffectiveAccount(nextBaseline, nextDraft);

  return {
    ...state,
    accounts: {
      ...state.accounts,
      [id]: {
        baseline: nextBaseline,
        draft: nextDraft,
        submitting: null,
        effective: nextEffective,
      },
    },
  };
}

// 提交失败时恢复提交标记
export function failAccountSubmit(
  state: AccountsState,
  id: string
): AccountsState {
  const existing = state.accounts[id];
  if (!existing) return state;

  return {
    ...state,
    accounts: {
      ...state.accounts,
      [id]: {
        ...existing,
        submitting: null,
      },
    },
  };
}

// 行为 3 实现：单条增量事件只更新对应卡片，保持其他卡片引用稳定与选择状态
export function handleSingleAccountChanged(
  state: AccountsState,
  updatedAccount: Account
): AccountsState {
  const existing = state.accounts[updatedAccount.id];
  const isNew = !existing;

  let nextItem: AccountItemState;
  if (existing) {
    // 保留草稿并重新计算
    nextItem = {
      baseline: updatedAccount,
      draft: existing.draft,
      submitting: existing.submitting,
      effective: computeEffectiveAccount(updatedAccount, existing.draft),
    };
  } else {
    nextItem = {
      baseline: updatedAccount,
      draft: {},
      submitting: null,
      effective: { ...updatedAccount },
    };
  }

  return {
    ...state,
    accountIds: isNew ? [...state.accountIds, updatedAccount.id] : state.accountIds,
    accounts: {
      ...state.accounts,
      [updatedAccount.id]: nextItem,
    },
  };
}

// 行为 3 实现：状态变更增量事件（如巡检结果）只更新该卡片状态
export function handleSingleAccountStatusChanged(
  state: AccountsState,
  payload: {
    id: string;
    status?: string;
    state?: string;
    loggedIn?: boolean;
    stale?: boolean;
    statusCheckedAt?: string;
    checkedAt?: string;
    lastRunOk?: boolean | null;
    lastRunReason?: string | null;
    statusDetail?: string | null;
    pageOpen?: boolean;
    rotationDone?: number;
    rotationWindowsDone?: number;
    rotationTarget?: number;
    rotationWindowsTarget?: number;
    rotationTopic?: string | null;
    exitNode?: string | null;
    proxyName?: string | null;
    exitNodeMissing?: boolean;
    proxyMissing?: boolean;
  }
): AccountsState {
  const existing = state.accounts[payload.id];
  if (!existing) return state;

  let nextStatus = existing.baseline.status;
  if (typeof payload.status === "string" && payload.status.length > 0) {
    nextStatus = payload.status;
  } else if (typeof payload.state === "string" && payload.state.length > 0) {
    nextStatus = payload.state;
  } else if (payload.loggedIn === false) {
    nextStatus = "needs_login";
  } else if (payload.loggedIn === true) {
    nextStatus = "ok";
  }

  const nextBaseline: Account = {
    ...existing.baseline,
    status: nextStatus,
    stale: payload.stale !== undefined ? payload.stale : existing.baseline.stale,
    statusCheckedAt:
      payload.statusCheckedAt ?? payload.checkedAt ?? existing.baseline.statusCheckedAt,
    lastRunOk:
      payload.lastRunOk !== undefined ? payload.lastRunOk : existing.baseline.lastRunOk,
    lastRunReason:
      payload.lastRunReason ?? payload.statusDetail ?? existing.baseline.lastRunReason,
    pageOpen:
      payload.pageOpen !== undefined ? payload.pageOpen : existing.baseline.pageOpen,
    rotationDone:
      payload.rotationDone ?? payload.rotationWindowsDone ?? existing.baseline.rotationDone,
    rotationTarget:
      payload.rotationTarget ?? payload.rotationWindowsTarget ?? existing.baseline.rotationTarget,
    rotationTopic:
      payload.rotationTopic !== undefined ? payload.rotationTopic : existing.baseline.rotationTopic,
    exitNode:
      payload.exitNode ?? payload.proxyName ?? existing.baseline.exitNode,
    exitNodeMissing:
      payload.exitNodeMissing ?? payload.proxyMissing ?? existing.baseline.exitNodeMissing,
  };

  const nextEffective = computeEffectiveAccount(nextBaseline, existing.draft);

  return {
    ...state,
    accounts: {
      ...state.accounts,
      [payload.id]: {
        ...existing,
        baseline: nextBaseline,
        effective: nextEffective,
      },
    },
  };
}

// 账号被移除
export function handleSingleAccountRemoved(
  state: AccountsState,
  id: string
): AccountsState {
  if (!state.accounts[id]) return state;

  const nextAccounts = { ...state.accounts };
  delete nextAccounts[id];

  const nextIds = state.accountIds.filter((accId) => accId !== id);
  const nextSelected = new Set(state.selectedIds);
  nextSelected.delete(id);

  return {
    ...state,
    accounts: nextAccounts,
    accountIds: nextIds,
    selectedIds: nextSelected,
  };
}

// 选择管理
export function toggleAccountSelection(
  state: AccountsState,
  id: string
): AccountsState {
  const nextSelected = new Set(state.selectedIds);
  if (nextSelected.has(id)) {
    nextSelected.delete(id);
  } else {
    nextSelected.add(id);
  }
  return {
    ...state,
    selectedIds: nextSelected,
  };
}

export function selectAllAccounts(
  state: AccountsState,
  idsToSelect: string[]
): AccountsState {
  const nextSelected = new Set(state.selectedIds);
  for (const id of idsToSelect) {
    nextSelected.add(id);
  }
  return {
    ...state,
    selectedIds: nextSelected,
  };
}

export function deselectAllAccounts(state: AccountsState): AccountsState {
  return {
    ...state,
    selectedIds: new Set<string>(),
  };
}

// 设置筛选条件
export function setAccountFilter(
  state: AccountsState,
  filter: Partial<AccountFilter>
): AccountsState {
  return {
    ...state,
    filter: {
      ...state.filter,
      ...filter,
    },
  };
}

// 行为 3 配合函数：计算筛选后的可见卡片列表（增量事件到达后调用此函数重新应用筛选）
export function getFilteredAccounts(state: AccountsState): AccountItemState[] {
  const { keyword, groupId, status, switchRule } = state.filter;
  const kw = keyword.trim().toLowerCase();

  return state.accountIds
    .map((id) => state.accounts[id])
    .filter((item): item is AccountItemState => Boolean(item))
    .filter((item) => {
      const acc = item.effective;

      // 关键词匹配：邮箱、备注、ID、GPT 昵称
      if (kw.length > 0) {
        const emailMatch = acc.email?.toLowerCase().includes(kw) ?? false;
        const noteMatch = acc.note.toLowerCase().includes(kw);
        const idMatch = acc.id.toLowerCase().includes(kw);
        const gptNameMatch = acc.gptName?.toLowerCase().includes(kw) ?? false;
        if (!emailMatch && !noteMatch && !idMatch && !gptNameMatch) {
          return false;
        }
      }

      // 分组筛选
      if (groupId !== "all") {
        if (groupId === "none") {
          if (acc.groupId !== null && acc.groupId !== "") return false;
        } else {
          if (acc.groupId !== groupId) return false;
        }
      }

      // 状态筛选
      if (status !== "all") {
        if (status === "stale") {
          if (!acc.stale) return false;
        } else if (status === "node_missing") {
          if (!acc.exitNodeMissing) return false;
        } else if (status === "disabled") {
          if (acc.enabled) return false;
        } else {
          if (acc.status !== status) return false;
        }
      }

      // 轮换规则筛选
      if (switchRule !== "all") {
        if (acc.switchRule !== switchRule) return false;
      }

      return true;
    });
}
