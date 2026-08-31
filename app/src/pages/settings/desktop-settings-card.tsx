import { useDesktopSettings } from "@/store/selectors";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";

export function DesktopSettingsCard() {
  const { settings, update } = useDesktopSettings();

  return (
    <Card>
      <CardHeader>
        <CardTitle>桌面偏好</CardTitle>
        <CardDescription>客户端界面与系统行为设置，修改后立即生效。</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="flex flex-col gap-6">
          <div className="flex items-center justify-between">
            <div className="space-y-0.5 w-full max-w-[200px]">
              <Label>外观主题</Label>
              <p className="text-xs text-secondary">选择您偏好的界面颜色。</p>
            </div>
            <Select
              value={settings.theme}
              onValueChange={(val: "light" | "dark" | "system") => update({ theme: val })}
            >
              <SelectTrigger className="w-[180px]">
                <SelectValue placeholder="选择主题" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="light">浅色 (Light)</SelectItem>
                <SelectItem value="dark">深色 (Dark)</SelectItem>
                <SelectItem value="system">跟随系统 (System)</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-center justify-between">
            <div className="space-y-0.5 w-full max-w-[300px]">
              <Label>关闭主窗口时的行为</Label>
              <p className="text-xs text-secondary">点击窗口右上角关闭按钮时执行的操作。</p>
            </div>
            <Select
              value={settings.closeBehavior}
              onValueChange={(val: "ask" | "minimizeToTray" | "exitAll") => update({ closeBehavior: val })}
            >
              <SelectTrigger className="w-[180px]">
                <SelectValue placeholder="选择行为" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ask">询问我</SelectItem>
                <SelectItem value="minimizeToTray">最小化到系统托盘</SelectItem>
                <SelectItem value="exitAll">完全退出应用</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-center justify-between">
            <div className="space-y-0.5 w-full max-w-[300px]">
              <Label>更新策略</Label>
              <p className="text-xs text-secondary">应用有新版本时的处理方式。</p>
            </div>
            <Select
              value={settings.updatePolicy}
              onValueChange={(val: "notifyOnly" | "installAtSafePoint") => update({ updatePolicy: val })}
            >
              <SelectTrigger className="w-[220px]">
                <SelectValue placeholder="选择更新策略" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="notifyOnly">仅提醒 (手动确认安装)</SelectItem>
                <SelectItem value="installAtSafePoint">安全空闲时自动安装</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label>开机自启动</Label>
              <p className="text-xs text-secondary">登录系统时自动运行此应用。</p>
            </div>
            <Switch
              checked={settings.startAtLogin}
              onCheckedChange={(checked) => update({ startAtLogin: checked })}
            />
          </div>

          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label>启动后自动开始调度</Label>
              <p className="text-xs text-secondary">应用启动时自动开启任务调度器。</p>
            </div>
            <Switch
              checked={settings.autoStartScheduler}
              onCheckedChange={(checked) => update({ autoStartScheduler: checked })}
            />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
