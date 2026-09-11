import { SearchableSelect } from "@/components/ui/searchable-select";
import { useAccountFilter } from "@/store/selectors";
import { useKeeperStore } from "@/store/keeperStore";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Eye, EyeOff, Plus, X } from "lucide-react";
import { AccountPromoFilter, AccountStatusFilter } from "@/store/accountModel";
import { SwitchRule } from "@/ipc/types";

interface AccountsToolbarProps {
  onCreateClick: () => void;
}

export function AccountsToolbar({ onCreateClick }: AccountsToolbarProps) {
  const { filter, active, setFilter, reset } = useAccountFilter();
  const emailsRevealed = useKeeperStore((s) => s.emailsRevealed);
  const setEmailsRevealed = useKeeperStore((s) => s.setEmailsRevealed);
  const groups = useKeeperStore((s) => s.groups);

  return (
    <div className="flex flex-wrap items-center gap-3 mb-4">
      <div className="w-64">
        <Input
          placeholder="搜索账号..."
          value={filter.keyword}
          onChange={(e) => setFilter({ keyword: e.target.value })}
          className="h-9"
        />
      </div>

      <SearchableSelect label="分组" className="w-40 h-9 justify-between" value={filter.groupId} onValueChange={(v) => setFilter({ groupId: v })} options={[{ value: "all", label: "全部分组" }, { value: "none", label: "未分组" }, ...groups.map((g) => ({ value: g.id, label: g.name }))]} />

      <Select
        value={filter.status}
        onValueChange={(v) => setFilter({ status: v as AccountStatusFilter })}
      >
        <SelectTrigger className="w-32 h-9">
          <SelectValue placeholder="全部状态" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">全部状态</SelectItem>
          <SelectItem value="ok">正常</SelectItem>
          <SelectItem value="reauth">需重新登录</SelectItem>
          <SelectItem value="out">未登录</SelectItem>
          <SelectItem value="stale">待复核</SelectItem>
          <SelectItem value="node_missing">节点已失效</SelectItem>
          <SelectItem value="disabled">已停用</SelectItem>
          <SelectItem value="page_open">网页已打开</SelectItem>
          <SelectItem value="unknown">未知</SelectItem>
        </SelectContent>
      </Select>

      <Select
        value={filter.promo}
        onValueChange={(v) => setFilter({ promo: v as AccountPromoFilter })}
      >
        <SelectTrigger className="w-32 h-9">
          <SelectValue placeholder="优惠资格" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">全部优惠</SelectItem>
          <SelectItem value="eligible">有优惠资格</SelectItem>
          <SelectItem value="free_trial">免费试用</SelectItem>
          <SelectItem value="half_price">半价优惠</SelectItem>
          <SelectItem value="none">无优惠资格</SelectItem>
          <SelectItem value="unchecked">优惠未检查</SelectItem>
        </SelectContent>
      </Select>

      <Select
        value={filter.switchRule}
        onValueChange={(v) => setFilter({ switchRule: v as SwitchRule | "all" })}
      >
        <SelectTrigger className="w-28 h-9">
          <SelectValue placeholder="全部规则" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">全部规则</SelectItem>
          <SelectItem value="random">随机</SelectItem>
          <SelectItem value="sequential">顺序</SelectItem>
        </SelectContent>
      </Select>

      {active && (
        <Button variant="ghost" size="sm" onClick={reset} className="h-9 text-muted hover:text-primary">
          <X className="mr-1.5" /> 清除筛选
        </Button>
      )}

      <div className="ml-auto flex items-center gap-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setEmailsRevealed(!emailsRevealed)}
              className="h-9"
              aria-label={emailsRevealed ? "点击隐藏完整邮箱" : "点击展示完整邮箱"}
            >
              {emailsRevealed ? (
                <>
                  <Eye className="mr-1.5 size-4" /> 邮箱已显示
                </>
              ) : (
                <>
                  <EyeOff className="mr-1.5 size-4" /> 邮箱已隐藏
                </>
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {emailsRevealed ? "点击隐藏完整邮箱" : "点击展示完整邮箱"}
          </TooltipContent>
        </Tooltip>
        <Button variant="default" size="sm" onClick={onCreateClick} className="h-9">
          <Plus className="mr-1.5" /> 新建账号
        </Button>
      </div>
    </div>
  );
}
