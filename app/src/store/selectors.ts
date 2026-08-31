// 组件订阅用的 selector hooks。
//
// 全部走这里而不是让组件自己写 useKeeperStore(s => ...)：订阅粒度是这套状态层的全部意义，
// 一个不小心返回新对象的 selector 就会让某个页面每次事件都重渲染，而这种退化在功能上
// 看不出来。集中在一个文件里，至少能一眼看完所有订阅面。

import { useCallback, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { useKeeperStore } from "./keeperStore";
import { displayEmail, shortId } from "@/lib/format";
import {
  isFilterActive,
  selectVisibleAccounts,
  type AccountRecord,
} from "./accountModel";
import type { Operation } from "@/ipc/types";

/// 当前筛选下可见的账号记录。
///
/// useMemo 的依赖是三份**引用**：records、ids、filter。一条巡检事件只会换掉 records 里
/// 的一个条目，records 本身的引用变了所以会重算 —— 这是必要的（那条记录可能不再匹配
/// 筛选），代价是一次 O(n) 遍历，n 是几十。
export function useVisibleAccounts(): AccountRecord[] {
  const records = useKeeperStore((state) => state.accounts);
  const ids = useKeeperStore((state) => state.accountIds);
  const filter = useKeeperStore((state) => state.accountFilter);
  return useMemo(() => selectVisibleAccounts(records, ids, filter), [records, ids, filter]);
}

/// 单条账号记录。卡片组件用它，一条事件只唤醒对应的那一张。
export function useAccountRecord(id: string): AccountRecord | undefined {
  return useKeeperStore((state) => state.accounts[id]);
}

export function useAccountFilter() {
  return useKeeperStore(
    useShallow((state) => ({
      filter: state.accountFilter,
      active: isFilterActive(state.accountFilter),
      setFilter: state.setAccountFilter,
      reset: state.resetAccountFilter,
    }))
  );
}

export function useAccountSelection() {
  return useKeeperStore(
    useShallow((state) => ({
      selectedIds: state.selectedAccountIds,
      count: state.selectedAccountIds.size,
      toggle: state.toggleAccountSelected,
      select: state.selectAccounts,
      clear: state.clearAccountSelection,
    }))
  );
}

/// 账号卡片用到的动作。全部是 store 上的稳定引用，所以这个对象在整个进程生命周期里
/// 浅比较恒等，不会破坏卡片的 memo。
export function useAccountActions() {
  return useKeeperStore(
    useShallow((state) => ({
      edit: state.editAccount,
      discard: state.discardAccountEdits,
      save: state.saveAccount,
      remove: state.removeAccount,
      refreshStatus: state.refreshAccountStatus,
      runNow: state.runAccountNow,
      checkSelectors: state.checkAccountSelectors,
      startLogin: state.startLogin,
      togglePage: state.toggleAccountPage,
      /// 卡片上的「历史」按钮开抽屉，不跳页 —— 看一眼记录不该把用户从账号页赶走。
      openHistory: state.openHistoryDrawer,
    }))
  );
}

export function useBulkActions() {
  return useKeeperStore(
    useShallow((state) => ({
      setEnabled: state.bulkSetEnabled,
      refreshStatus: state.bulkRefreshStatus,
      runNow: state.bulkRunNow,
      remove: state.bulkRemove,
    }))
  );
}

export function useConnectionStatus() {
  return useKeeperStore(
    useShallow((state) => ({
      connection: state.connection,
      draining: state.draining,
      agentVersion: state.connection.agentVersion ?? null,
      instanceId: state.connection.instanceId ?? null,
    }))
  );
}

export function useSchedulerControls() {
  return useKeeperStore(
    useShallow((state) => ({
      scheduler: state.scheduler,
      running: state.scheduler.running,
      start: state.startScheduler,
      stop: state.stopScheduler,
      toggle: state.toggleScheduler,
    }))
  );
}

/// 仍在进行中的操作。
///
/// 从 operations 派生而不是单独维护一份 activeOperations：两份列表靠事件分别更新，
/// 迟早会对不上（一条 operation.changed 更新了其中一份而漏掉另一份）。
export function useActiveOperations(): Operation[] {
  const operations = useKeeperStore((state) => state.operations);
  return useMemo(
    () =>
      operations.filter(
        (operation) =>
          operation.state === "queued" ||
          operation.state === "running" ||
          operation.state === "waiting_user"
      ),
    [operations]
  );
}

/// 正在跑任务的账号 → 那个任务。
///
/// 账号卡片要在有任务在跑时醒目显示并说明在跑什么。数据来自 operations 里的非终态记录：
/// 它们的 resourceId 就是账号 id。
///
/// 返回 Map 而不是让每张卡片自己 filter：28 张卡片各扫一遍 operations 是 28×N 次比较，
/// 而这里算一次给所有卡片用。
export function useRunningOperationsByAccount(): ReadonlyMap<string, Operation> {
  const operations = useKeeperStore((state) => state.operations);

  return useMemo(() => {
    const running = new Map<string, Operation>();
    for (const operation of operations) {
      if (
        operation.state !== "queued" &&
        operation.state !== "running" &&
        operation.state !== "waiting_user"
      ) {
        continue;
      }
      const accountId = operation.resourceId;
      if (!accountId) continue;
      // 同一账号可能有多条在途（例如刷新状态排在立即运行后面）。保留**最新**的那条：
      // operations 是新的在前，所以先写入的就是最新的，后面的不覆盖。
      if (!running.has(accountId)) running.set(accountId, operation);
    }
    return running;
  }, [operations]);
}

/// 单个账号是否正在跑任务。卡片用它，订阅粒度到那一条。
export function useAccountRunningOperation(accountId: string): Operation | undefined {
  return useKeeperStore((state) => {
    for (const operation of state.operations) {
      if (
        operation.resourceId === accountId &&
        (operation.state === "queued" ||
          operation.state === "running" ||
          operation.state === "waiting_user")
      ) {
        return operation;
      }
    }
    return undefined;
  });
}

export function useNav() {
  return useKeeperStore(
    useShallow((state) => ({
      nav: state.nav,
      setNav: state.setNav,
      collapsed: state.sidebarCollapsed,
      toggleSidebar: state.toggleSidebar,
    }))
  );
}

export function useProfileScanState() {
  return useKeeperStore(
    useShallow((state) => ({
      scan: state.profileScan,
      scanning: state.profileScanning,
      failed: state.profileScanFailed,
      request: state.requestProfileScan,
    }))
  );
}

export function useDesktopSettings() {
  return useKeeperStore(
    useShallow((state) => ({
      settings: state.desktopSettings,
      update: state.updateDesktopSettings,
    }))
  );
}

/// 按 id 取账号的显示标签。
///
/// 任务列表、Chrome 运行明细、历史侧栏都只拿到账号 id，而 id 对用户没有意义 —— 他认得的是
/// 邮箱。这个 hook 返回一个查表函数，调用方按需查，避免每个列表各写一遍回退链。
///
/// 回退顺序：邮箱 → 备注 → 短 id。账号已被删除时返回短 id 并标记 known=false，让调用方
/// 能显示「已删除的账号」而不是假装那个 id 是个正常账号。
export function useAccountLabeler(): (id: string | null | undefined) => {
  label: string;
  known: boolean;
} {
  const records = useKeeperStore((state) => state.accounts);
  const revealed = useKeeperStore((state) => state.emailsRevealed);

  return useCallback(
    (id) => {
      if (!id) return { label: "—", known: false };
      const account = records[id]?.effective;
      if (!account) return { label: shortId(id), known: false };
      if (account.email) return { label: displayEmail(account.email, revealed), known: true };
      if (account.note.trim().length > 0) return { label: account.note, known: true };
      return { label: shortId(id), known: true };
    },
    [records, revealed]
  );
}

export function useAgentSettings() {
  return useKeeperStore(
    useShallow((state) => ({
      settings: state.agentSettings,
      update: state.updateAgentSettings,
    }))
  );
}
