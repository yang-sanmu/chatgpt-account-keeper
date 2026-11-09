import * as React from "react";
import { Page, PageHeader, PageBody } from "@/components/layout/page";
import { useKeeperStore } from "@/store/keeperStore";
import { useVisibleAccounts, useAccountFilter } from "@/store/selectors";
import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";
import { AccountsToolbar } from "./accounts-toolbar";
import { AccountCard } from "./account-card";
import { BulkActionBar } from "./bulk-action-bar";
import { AccountCreateDialog } from "./account-create-dialog";
import { AccountDeleteDialog } from "./account-delete-dialog";
import { AccountHistoryDrawer } from "./account-history-drawer";
import { AccountInspectionDialog } from "./account-inspection-dialog";
import { AccountPlanDialog } from "./account-plan-dialog";
import { Users, SearchX } from "lucide-react";
import { shortId } from "@/lib/format";

export function AccountsPage() {
  const visibleAccounts = useVisibleAccounts();
  const accountIds = useKeeperStore((s) => s.accountIds);
  const { reset: resetFilters } = useAccountFilter();

  const [createOpen, setCreateOpen] = React.useState(false);
  const [inspectionTarget, setInspectionTarget] = React.useState<{ title: string; ids: string[] } | null>(null);
  const [planTarget, setPlanTarget] = React.useState<{ title: string; ids: string[]; allIds?: string[] } | null>(null);
  const checkSinglePlan = React.useCallback((id: string) => {
    setPlanTarget({ title: "查询套餐", ids: [id] });
  }, []);
  
  const [deleteOpen, setDeleteOpen] = React.useState(false);
  const [deleteTargets, setDeleteTargets] = React.useState<{ id: string; name: string }[]>([]);

  const handleDeleteSingle = React.useCallback((id: string, name: string) => {
    setDeleteTargets([{ id, name }]);
    setDeleteOpen(true);
  }, []);

  // 批量删除时把邮箱一并带过去。
  //
  // 从 store 现取而不是让卡片上报：只有一个账号被选中时，确认框应该显示它是哪一个，
  // 而不是一串 id —— 用户没法从 id 判断自己选中的是不是想删的那个。
  const handleBulkDelete = (ids: string[]) => {
    const records = useKeeperStore.getState().accounts;
    setDeleteTargets(
      ids.map((id) => {
        const account = records[id]?.effective;
        return { id, name: account?.email ?? account?.note ?? shortId(id) };
      })
    );
    setDeleteOpen(true);
  };

  const visibleIds = visibleAccounts.map((a) => a.effective.id);

  return (
    <Page>
      <PageHeader 
        title="账号" 
        description="管理并监控所有 ChatGPT 账号的轮换与登录状态"
      />
      
      <AccountsToolbar onCreateClick={() => setCreateOpen(true)}
        canInspect={visibleIds.length > 0}
        onInspect={() => setInspectionTarget({ title: "一键巡检", ids: visibleIds })}
        canCheckPlans={accountIds.length > 0}
        onCheckPlans={() => setPlanTarget({ title: "一键查套餐", ids: visibleIds, allIds: accountIds })}
      />

      <PageBody className="pb-20 relative">
        {accountIds.length === 0 ? (
          <EmptyState
            icon={<Users />}
            title="暂无账号"
            description="您还没有添加任何账号，立即创建一个来开始使用吧。"
            action={
              <Button onClick={() => setCreateOpen(true)}>新建账号</Button>
            }
          />
        ) : visibleAccounts.length === 0 ? (
          <EmptyState
            icon={<SearchX />}
            title="没有符合条件的账号"
            description="当前筛选条件下没有找到匹配的账号，请尝试放宽筛选条件。"
            action={
              <Button variant="outline" onClick={resetFilters}>清除筛选</Button>
            }
          />
        ) : (
          // 卡片宽度设上限。
          //
          // 原来是 minmax(340px, 1fr)，1fr 让卡片吃掉整行剩余宽度 —— 窗口窄到只放得下一列时
          // 那一列被拉到满宽，于是「窗口越小卡片越大」。
          //
          // 上限设为 360px（卡片紧凑区间 ~340-360px）：在默认 1260px 窗口（内容区约 972px）下
          // 刚好稳定容纳 2 列卡片；1080p 全屏（约 1660px）容纳 4 列；窄窗口（约 700px）容纳 1 列。
          //
          // 下界用 min(340px, 100%)：容器比 340px 还窄时（侧栏展开 + 窄窗口）固定下界会让
          // 轨道溢出容器，出现横向滚动条。
          <div className="grid grid-cols-[repeat(auto-fill,minmax(min(340px,100%),360px))] items-start justify-start gap-4">
            {visibleAccounts.map((record) => (
              <AccountCard
                key={record.effective.id}
                id={record.effective.id}
                onDelete={handleDeleteSingle}
                onCheckPlan={checkSinglePlan}
              />
            ))}
          </div>
        )}
      </PageBody>

      <BulkActionBar 
        visibleIds={visibleIds} 
        onBulkDelete={handleBulkDelete} 
        onCheckPlans={(ids) => setPlanTarget({ title: "批量查套餐", ids })}
        onInspect={(ids) => setInspectionTarget({ title: "批量巡检", ids })}
      />

      {inspectionTarget && <AccountInspectionDialog {...inspectionTarget} onClose={() => setInspectionTarget(null)} />}
      {planTarget && <AccountPlanDialog {...planTarget} onClose={() => setPlanTarget(null)} />}

      <AccountCreateDialog 
        open={createOpen} 
        onOpenChange={setCreateOpen} 
      />
      
      <AccountDeleteDialog 
        open={deleteOpen} 
        onOpenChange={setDeleteOpen} 
        accounts={deleteTargets} 
      />

      <AccountHistoryDrawer />
    </Page>
  );
}
