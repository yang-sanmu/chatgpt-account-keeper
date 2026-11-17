import { useEffect, useState } from "react";
import { useKeeperStore } from "@/store/keeperStore";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2, Mail, PlugZap, RotateCcw, Save } from "lucide-react";
import { notify } from "@/lib/notify";
import type { MailTestResult } from "@/ipc/types";

const IMAP_PRESETS = [
  { label: "QQ 邮箱", host: "imap.qq.com", port: 993, tls: true },
  { label: "iCloud 邮箱", host: "imap.mail.me.com", port: 993, tls: true },
  { label: "163 邮箱", host: "imap.163.com", port: 993, tls: true },
  { label: "Gmail", host: "imap.gmail.com", port: 993, tls: true },
] as const;

type HeadlessChoice = "follow" | "headless" | "headed";

function toHeadlessChoice(value: boolean | null | undefined): HeadlessChoice {
  if (value === true) return "headless";
  if (value === false) return "headed";
  return "follow";
}

function fromHeadlessChoice(choice: HeadlessChoice): boolean | null {
  if (choice === "headless") return true;
  if (choice === "headed") return false;
  return null;
}

export function MailSettingsCard() {
  const mailSettings = useKeeperStore((s) => s.mailSettings);
  const connected = useKeeperStore((s) => s.connection.connected);
  const loadMailSettings = useKeeperStore((s) => s.loadMailSettings);
  const updateMailSettings = useKeeperStore((s) => s.updateMailSettings);
  const testMailConnection = useKeeperStore((s) => s.testMailConnection);

  const [imapHost, setImapHost] = useState("");
  const [imapPort, setImapPort] = useState("993");
  const [imapTls, setImapTls] = useState(true);
  const [imapUser, setImapUser] = useState("");
  const [imapPassword, setImapPassword] = useState("");
  const [clearPassword, setClearPassword] = useState(false);
  const [autoReloginDefault, setAutoReloginDefault] = useState(false);
  const [reloginHeadless, setReloginHeadless] = useState<HeadlessChoice>("follow");

  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<MailTestResult | null>(null);

  useEffect(() => {
    if (connected && !mailSettings) {
      void loadMailSettings().catch(() => {});
    }
  }, [connected, mailSettings, loadMailSettings]);

  useEffect(() => {
    if (!mailSettings) return;
    setImapHost(mailSettings.imapHost ?? "");
    setImapPort(String(mailSettings.imapPort || 993));
    setImapTls(mailSettings.imapTls);
    setImapUser(mailSettings.imapUser ?? "");
    setImapPassword("");
    setClearPassword(false);
    setAutoReloginDefault(mailSettings.autoReloginDefault);
    setReloginHeadless(toHeadlessChoice(mailSettings.reloginHeadless));
  }, [mailSettings]);

  const parsedPort = Number.parseInt(imapPort, 10);
  const portValid = Number.isInteger(parsedPort) && parsedPort >= 1 && parsedPort <= 65535;
  const passwordConfigured = Boolean(mailSettings?.imapPasswordConfigured);

  const handleSave = async () => {
    if (!portValid) {
      notify.error("保存失败", "IMAP 端口必须是 1 到 65535 之间的整数");
      return;
    }
    setSaving(true);
    try {
      await updateMailSettings({
        imapHost: imapHost.trim() || null,
        imapPort: parsedPort,
        imapTls,
        imapUser: imapUser.trim() || null,
        ...(clearPassword
          ? { imapPassword: null }
          : imapPassword.trim()
            ? { imapPassword }
            : {}),
        autoReloginDefault,
        reloginHeadless: fromHeadlessChoice(reloginHeadless),
      });
      setImapPassword("");
      setClearPassword(false);
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    if (!portValid) {
      notify.error("测试失败", "IMAP 端口必须是 1 到 65535 之间的整数");
      return;
    }
    setTesting(true);
    setTestResult(null);
    try {
      const result = await testMailConnection({
        imapHost: imapHost.trim(),
        imapPort: parsedPort,
        imapTls,
        imapUser: imapUser.trim(),
        ...(imapPassword.trim() ? { imapPassword } : {}),
      });
      setTestResult(result);
      if (result.ok) {
        notify.success("IMAP 测试连接成功", result.message);
      } else {
        notify.error("IMAP 测试连接失败", result.message);
      }
    } catch (error) {
      notify.error("IMAP 测试失败", error);
    } finally {
      setTesting(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Mail className="size-4 text-accent" />
          <CardTitle>接码邮箱与自动重登（IMAP）</CardTitle>
        </div>
        <CardDescription>
          用于巡检遇到 401/会话过期或批量自动重登时，从共享 IMAP 邮箱（支持 QQ / Cloudflare / iCloud 转发）自动读取 OpenAI 登录验证码。授权码以本机 AES-256-GCM 加密保存。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted">常用预设：</span>
          {IMAP_PRESETS.map((preset) => (
            <Button
              key={preset.label}
              type="button"
              variant="outline"
              size="sm"
              className="h-7 px-2.5 text-xs"
              disabled={!connected || saving}
              onClick={() => {
                setImapHost(preset.host);
                setImapPort(String(preset.port));
                setImapTls(preset.tls);
              }}
            >
              {preset.label}
            </Button>
          ))}
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="mail-imap-host">IMAP 服务器</Label>
            <Input
              id="mail-imap-host"
              placeholder="例如 imap.qq.com"
              value={imapHost}
              disabled={!connected || saving}
              onChange={(e) => setImapHost(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="mail-imap-port">端口</Label>
            <Input
              id="mail-imap-port"
              type="number"
              min={1}
              max={65535}
              value={imapPort}
              disabled={!connected || saving}
              onChange={(e) => setImapPort(e.target.value)}
            />
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="mail-imap-user">邮箱账号</Label>
            <Input
              id="mail-imap-user"
              placeholder="例如 example@qq.com"
              value={imapUser}
              disabled={!connected || saving}
              onChange={(e) => setImapUser(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="mail-imap-pass">IMAP 授权码 / 密码</Label>
              {passwordConfigured && !clearPassword && (
                <button
                  type="button"
                  className="text-xs text-muted hover:text-danger transition-colors"
                  onClick={() => {
                    setImapPassword("");
                    setClearPassword(true);
                  }}
                >
                  清除已保存密码
                </button>
              )}
              {clearPassword && (
                <button
                  type="button"
                  className="text-xs text-accent hover:underline"
                  onClick={() => setClearPassword(false)}
                >
                  撤销清除
                </button>
              )}
            </div>
            <Input
              id="mail-imap-pass"
              type="password"
              value={imapPassword}
              disabled={!connected || saving || clearPassword}
              placeholder={
                clearPassword
                  ? "保存后将清除已存授权码"
                  : passwordConfigured
                    ? "已加密保存（留空则保持不变）"
                    : "请输入邮箱 IMAP 授权码"
              }
              onChange={(e) => setImapPassword(e.target.value)}
            />
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2 pt-1 border-t border-line/60">
          <div className="flex items-center justify-between">
            <div className="space-y-0.5 pr-4">
              <Label htmlFor="mail-imap-tls">启用 SSL/TLS 加密连接</Label>
              <p className="text-xs text-muted">993 端口通常需开启</p>
            </div>
            <Switch
              id="mail-imap-tls"
              checked={imapTls}
              disabled={!connected || saving}
              onCheckedChange={setImapTls}
            />
          </div>

          <div className="flex items-center justify-between">
            <div className="space-y-0.5 pr-4">
              <Label htmlFor="mail-auto-relogin-default">巡检默认勾选自动重登</Label>
              <p className="text-xs text-muted">打开「一键巡检」时默认开启 401/失效自动重登</p>
            </div>
            <Switch
              id="mail-auto-relogin-default"
              checked={autoReloginDefault}
              disabled={!connected || saving}
              onCheckedChange={setAutoReloginDefault}
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-4 pt-1 border-t border-line/60">
          <div className="space-y-0.5">
            <Label htmlFor="mail-relogin-headless">批量自动重登窗口模式</Label>
            <p className="text-xs text-muted">触发人机验证时可设为「可见窗口」</p>
          </div>
          <Select
            value={reloginHeadless}
            disabled={!connected || saving}
            onValueChange={(val) => setReloginHeadless(val as HeadlessChoice)}
          >
            <SelectTrigger id="mail-relogin-headless" className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="follow">跟随全局 Headless</SelectItem>
              <SelectItem value="headless">后台静默（无头）</SelectItem>
              <SelectItem value="headed">弹出可见窗口</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {testResult && (
          <div
            className={`rounded-md border px-3 py-2 text-xs ${
              testResult.ok
                ? "border-ok/40 bg-ok/10 text-ok"
                : "border-danger/40 bg-danger/10 text-danger"
            }`}
          >
            {testResult.message}
          </div>
        )}

        <div className="flex flex-wrap items-center justify-end gap-2 pt-2">
          <Button
            type="button"
            variant="outline"
            disabled={!connected || testing || saving}
            onClick={() => void handleTest()}
          >
            {testing ? <Loader2 className="mr-1.5 size-4 animate-spin" /> : <PlugZap className="mr-1.5 size-4" />}
            测试连接
          </Button>
          {mailSettings && (
            <Button
              type="button"
              variant="ghost"
              disabled={!connected || saving}
              onClick={() => {
                setImapHost(mailSettings.imapHost ?? "");
                setImapPort(String(mailSettings.imapPort || 993));
                setImapTls(mailSettings.imapTls);
                setImapUser(mailSettings.imapUser ?? "");
                setImapPassword("");
                setClearPassword(false);
                setAutoReloginDefault(mailSettings.autoReloginDefault);
                setReloginHeadless(toHeadlessChoice(mailSettings.reloginHeadless));
                setTestResult(null);
              }}
            >
              <RotateCcw className="mr-1.5 size-4" /> 重置
            </Button>
          )}
          <Button
            type="button"
            disabled={!connected || saving || !portValid}
            onClick={() => void handleSave()}
          >
            {saving ? <Loader2 className="mr-1.5 size-4 animate-spin" /> : <Save className="mr-1.5 size-4" />}
            保存设置
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
