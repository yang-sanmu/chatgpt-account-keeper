import { useEffect, useState } from "react";
import { useAgentSettings } from "@/store/selectors";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { AgentSettings } from "@/ipc/types";
import { Loader2 } from "lucide-react";

export function AgentSettingsCard() {
  const { settings, update } = useAgentSettings();
  const [draft, setDraft] = useState<AgentSettings | null>(null);
  const [saving, setSaving] = useState(false);

  // 只在还没有草稿时从服务端灌一次。
  //
  // 不能在 settings 每次变化时都覆盖草稿：settings.changed 事件会在别处改配置时到达，
  // 那时用户可能正在这个表单里输入，覆盖等于把他刚敲的内容清掉。
  useEffect(() => {
    if (settings && draft === null) {
      setDraft(settings);
    }
  }, [settings, draft]);

  if (!draft) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Agent 后台配置</CardTitle>
          <CardDescription>配置自动任务调度器与浏览器运行时行为。</CardDescription>
        </CardHeader>
        <CardContent className="flex items-center justify-center py-8 text-muted">
          <Loader2 className="size-6 animate-spin" />
        </CardContent>
      </Card>
    );
  }

  const isDirty = settings !== null && JSON.stringify(draft) !== JSON.stringify(settings);

  const errors = {
    intervalMinutes: draft.intervalMinutes < 1 ? "最小值为 1 分钟" : null,
    jitterMinutes: draft.jitterMinutes < 0 ? "不能为负数" : null,
    statusCheckMinutes: draft.statusCheckMinutes < 1 ? "最小值为 1 分钟" : null,
    openPageTimeoutMinutes: draft.openPageTimeoutMinutes < 0 ? "不能为负数" : null,
  };
  const hasErrors = Object.values(errors).some((e) => e !== null);

  /// 数字字段的受控更新。
  ///
  /// 空串必须原样保留而不是折成 0：Number("") === 0，而「调度间隔 0 分钟」是个会让调度器
  /// 不停拉起 Chrome 的值。这里在清空时不动草稿，等用户敲进数字再更新。
  const setNumber = (field: keyof AgentSettings, raw: string) => {
    if (raw.trim() === "") return;
    const value = Number(raw);
    if (!Number.isFinite(value)) return;
    setDraft({ ...draft, [field]: value });
  };

  const handleSave = async () => {
    if (hasErrors) return;
    setSaving(true);
    try {
      await update(draft);
    } catch {
      // 失败提示已由 store 发出（带稳定错误码）。草稿保持不动，用户可以直接改一改重试。
    } finally {
      setSaving(false);
    }
  };

  const handleDiscard = () => {
    if (settings) {
      setDraft(settings);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Agent 后台配置</CardTitle>
        <CardDescription>配置自动任务调度器与浏览器运行时行为。修改后需保存。</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="space-y-2">
            <Label htmlFor="agent-interval">调度间隔 (分钟)</Label>
            <Input
              id="agent-interval"
              type="number"
              min={1}
              value={draft.intervalMinutes}
              onChange={(e) => setNumber("intervalMinutes", e.target.value)}
            />
            {errors.intervalMinutes ? (
              <p className="text-xs text-danger">{errors.intervalMinutes}</p>
            ) : (
              <p className="text-xs text-secondary">调度器每隔多久运行一轮。建议 5-15 分钟。</p>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="agent-jitter">随机抖动 (分钟)</Label>
            <Input
              id="agent-jitter"
              type="number"
              min={0}
              value={draft.jitterMinutes}
              onChange={(e) => setNumber("jitterMinutes", e.target.value)}
            />
            {errors.jitterMinutes ? (
              <p className="text-xs text-danger">{errors.jitterMinutes}</p>
            ) : (
              <p className="text-xs text-secondary">为每次任务添加随机延迟，避免固定特征。建议 1-5 分钟。</p>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="agent-status-check">状态检查间隔 (分钟)</Label>
            <Input
              id="agent-status-check"
              type="number"
              min={1}
              value={draft.statusCheckMinutes}
              onChange={(e) => setNumber("statusCheckMinutes", e.target.value)}
            />
            {errors.statusCheckMinutes ? (
              <p className="text-xs text-danger">{errors.statusCheckMinutes}</p>
            ) : (
              <p className="text-xs text-secondary">自动检查账号状态（如封禁或掉线）的频率。建议 60-120 分钟。</p>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="agent-open-page-timeout">页面加载超时 (分钟)</Label>
            <Input
              id="agent-open-page-timeout"
              type="number"
              min={0}
              value={draft.openPageTimeoutMinutes}
              onChange={(e) => setNumber("openPageTimeoutMinutes", e.target.value)}
            />
            {errors.openPageTimeoutMinutes ? (
              <p className="text-xs text-danger">{errors.openPageTimeoutMinutes}</p>
            ) : (
              <p className="text-xs text-secondary">
                限制手动打开页面时的最大时长。设为 0 表示不限制，需手动关闭。
              </p>
            )}
          </div>
        </div>
        
        <div className="flex flex-col gap-4 pt-2">
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label htmlFor="agent-headless">无头模式 (Headless)</Label>
              <p className="text-xs text-secondary">后台自动任务时不显示浏览器窗口。</p>
            </div>
            <Switch
              id="agent-headless"
              checked={draft.headless}
              onCheckedChange={(checked) => setDraft({ ...draft, headless: checked })}
            />
          </div>
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label htmlFor="agent-status-on-startup">启动时检查所有账号状态</Label>
              <p className="text-xs text-secondary">在应用启动后，批量检测未确认状态的账号。</p>
            </div>
            <Switch
              id="agent-status-on-startup"
              checked={draft.statusCheckOnStartup}
              onCheckedChange={(checked) => setDraft({ ...draft, statusCheckOnStartup: checked })}
            />
          </div>
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label htmlFor="agent-auto-clean">自动清理孤立 Profile</Label>
              <p className="text-xs text-secondary">在后台空闲时，自动归档或清理未关联任何账号的浏览器缓存目录。</p>
            </div>
            <Switch
              id="agent-auto-clean"
              checked={draft.profileAutoCleanEnabled}
              onCheckedChange={(checked) => setDraft({ ...draft, profileAutoCleanEnabled: checked })}
            />
          </div>
        </div>
      </CardContent>
      <CardFooter className="justify-end gap-2 border-t border-subtle pt-4">
        <Button variant="outline" onClick={handleDiscard} disabled={!isDirty || saving}>
          放弃修改
        </Button>
        <Button onClick={handleSave} disabled={!isDirty || hasErrors || saving}>
          {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          保存设置
        </Button>
      </CardFooter>
    </Card>
  );
}
