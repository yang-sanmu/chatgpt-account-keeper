// 组件订阅用的 selector hooks。
//
// 全部走这里而不是让组件自己写 useKeeperStore(s => ...)：订阅粒度是这套状态层的全部意义，
// 一个不小心返回新对象的 selector 就会让某个页面每次事件都重渲染，而这种退化在功能上
// 看不出来。集中在一个文件里，至少能一眼看完所有订阅面。

import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { useKeeperStore } from "./keeperStore";
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
      openHistory: state.openHistoryFor,
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

export function useAgentSettings() {
  return useKeeperStore(
    useShallow((state) => ({
      settings: state.agentSettings,
      update: state.updateAgentSettings,
    }))
  );
}
