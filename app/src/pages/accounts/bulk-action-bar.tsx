import { useAccountSelection, useBulkActions } from "@/store/selectors";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Play, RefreshCw, Trash2, Power, PowerOff } from "lucide-react";

interface BulkActionBarProps {
  visibleIds: string[];
  onBulkDelete: (ids: string[]) => void;
}

export function BulkActionBar({ visibleIds, onBulkDelete }: BulkActionBarProps) {
  const { selectedIds, count, select, clear } = useAccountSelection();
  const bulkActions = useBulkActions();

  if (count === 0) return null;

  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every(id => selectedIds.has(id));
  const someVisibleSelected = visibleIds.some(id => selectedIds.has(id));

  const handleToggleAll = (checked: boolean) => {
    if (checked) {
      // 合并当前选中的和当前可见的
      const next = new Set(selectedIds);
      for (const id of visibleIds) next.add(id);
      select(Array.from(next));
    } else {
      // 仅取消当前可见的，保留可能存在于其他筛选下的选中项
      const next = new Set(selectedIds);
      for (const id of visibleIds) next.delete(id);
      select(Array.from(next));
    }
  };

  const selectedArray = Array.from(selectedIds);

  return (
    <div className="sticky bottom-0 left-0 right-0 z-10 mt-4 flex animate-in items-center justify-between rounded-t-panel border-t border-line bg-raised p-4 shadow-overlay slide-in-from-bottom-4">
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2">
          <Checkbox 
            id="bulk-select-all" 
            checked={allVisibleSelected ? true : someVisibleSelected ? "indeterminate" : false}
            onCheckedChange={(c) => handleToggleAll(c === true)}
          />
          <Label htmlFor="bulk-select-all" className="cursor-pointer font-medium text-primary">
            已选 {count} 个
          </Label>
        </div>
        <Button variant="ghost" size="sm" onClick={clear} className="text-muted hover:text-primary h-8">
          取消选择
        </Button>
      </div>

      <div className="flex items-center gap-2">
        <Button variant="secondary" size="sm" onClick={() => bulkActions.setEnabled(selectedArray, true)} className="h-8">
          <Power className="mr-1.5 size-4 text-ok" /> 启用
        </Button>
        <Button variant="secondary" size="sm" onClick={() => bulkActions.setEnabled(selectedArray, false)} className="h-8">
          <PowerOff className="mr-1.5 size-4 text-muted" /> 停用
        </Button>
        <div className="w-px h-4 bg-line mx-1" />
        <Button variant="secondary" size="sm" onClick={() => bulkActions.refreshStatus(selectedArray)} className="h-8">
          <RefreshCw className="mr-1.5 size-4" /> 刷新状态
        </Button>
        <Button variant="secondary" size="sm" onClick={() => bulkActions.runNow(selectedArray)} className="h-8">
          <Play className="mr-1.5 size-4" /> 立即运行
        </Button>
        <div className="w-px h-4 bg-line mx-1" />
        <Button variant="danger" size="sm" onClick={() => onBulkDelete(selectedArray)} className="h-8">
          <Trash2 className="mr-1.5 size-4" /> 删除
        </Button>
      </div>
    </div>
  );
}
