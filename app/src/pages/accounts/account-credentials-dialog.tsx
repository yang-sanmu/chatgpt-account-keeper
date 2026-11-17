import { useEffect, useState } from "react";
import type { Account } from "@/ipc/types";
import { useKeeperStore } from "@/store/keeperStore";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { KeyRound, Loader2, RefreshCw } from "lucide-react";

interface AccountCredentialsDialogProps {
  account: Account | null;
  onClose: () => void;
  onAutoRelogin?: (id: string) => void;
}

export function AccountCredentialsDialog({
  account,
  onClose,
  onAutoRelogin,
}: AccountCredentialsDialogProps) {
  const setAccountCredentials = useKeeperStore((s) => s.setAccountCredentials);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [clearPassword, setClearPassword] = useState(false);
  const [totpSecret, setTotpSecret] = useState("");
  const [clearTotp, setClearTotp] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!account) return;
    setEmail(account.email ?? "");
    setPassword("");
    setClearPassword(false);
    setTotpSecret("");
    setClearTotp(false);
    setSaving(false);
  }, [account]);

  if (!account) return null;

  const buildPatch = () => {
    const trimmedEmail = email.trim();
    return {
      id: account.id,
      ...(trimmedEmail !== (account.email ?? "") ? { email: trimmedEmail || null } : {}),
      ...(clearPassword
        ? { password: null }
        : password.length > 0
          ? { password }
          : {}),
      ...(clearTotp
        ? { totpSecret: null }
        : totpSecret.trim().length > 0
          ? { totpSecret: totpSecret.trim() }
          : {}),
    };
  };

  const handleSave = async (triggerRelogin = false) => {
    setSaving(true);
    try {
      await setAccountCredentials(buildPatch());
      const targetId = account.id;
      onClose();
      if (triggerRelogin) onAutoRelogin?.(targetId);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !saving) onClose(); }}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <KeyRound className="size-4 text-accent" />
            <DialogTitle>自动重登凭据</DialogTitle>
          </div>
          <DialogDescription>
            纯邮箱验证码账号（含 iCloud 隐私邮箱 / 域名转发）只需邮箱与全局 IMAP 即可；仅在账号设有密码或两步验证时需要补充密码/TOTP。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label htmlFor="cred-email">登录邮箱</Label>
            <Input
              id="cred-email"
              value={email}
              disabled={saving}
              placeholder="name@example.com"
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="cred-password">账号密码（可选）</Label>
              {account.hasPassword && !clearPassword && (
                <button
                  type="button"
                  className="text-xs text-muted hover:text-danger"
                  onClick={() => {
                    setPassword("");
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
              id="cred-password"
              type="password"
              value={password}
              disabled={saving || clearPassword}
              placeholder={
                clearPassword
                  ? "保存后将清除密码"
                  : account.hasPassword
                    ? "已加密保存（留空则保持不变）"
                    : "无密码 / 仅邮箱验证码可留空"
              }
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="cred-totp">2FA / TOTP 密钥（可选）</Label>
              {account.hasTotpSecret && !clearTotp && (
                <button
                  type="button"
                  className="text-xs text-muted hover:text-danger"
                  onClick={() => {
                    setTotpSecret("");
                    setClearTotp(true);
                  }}
                >
                  清除已保存密钥
                </button>
              )}
              {clearTotp && (
                <button
                  type="button"
                  className="text-xs text-accent hover:underline"
                  onClick={() => setClearTotp(false)}
                >
                  撤销清除
                </button>
              )}
            </div>
            <Input
              id="cred-totp"
              type="password"
              value={totpSecret}
              disabled={saving || clearTotp}
              placeholder={
                clearTotp
                  ? "保存后将清除 2FA 密钥"
                  : account.hasTotpSecret
                    ? "已加密保存（留空则保持不变）"
                    : "支持 Base32 密钥或 otpauth:// URI"
              }
              onChange={(e) => setTotpSecret(e.target.value)}
            />
          </div>
        </div>

        <DialogFooter className="gap-2">
          <Button type="button" variant="outline" disabled={saving} onClick={onClose}>
            取消
          </Button>
          {onAutoRelogin && (
            <Button
              type="button"
              variant="secondary"
              disabled={saving || !email.trim()}
              onClick={() => void handleSave(true)}
            >
              {saving ? <Loader2 className="mr-1.5 size-4 animate-spin" /> : <RefreshCw className="mr-1.5 size-4" />}
              保存并自动重登
            </Button>
          )}
          <Button type="button" disabled={saving} onClick={() => void handleSave(false)}>
            {saving && <Loader2 className="mr-1.5 size-4 animate-spin" />}
            保存凭据
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
