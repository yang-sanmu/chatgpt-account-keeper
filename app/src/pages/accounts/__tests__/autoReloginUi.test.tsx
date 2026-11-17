import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { makeAccount, makeBootstrap, makeOperation, tauri } from "@/test/harness";
import { __resetKeeperStoreForTests, useKeeperStore } from "@/store/keeperStore";
import { AccountsPage } from "../accounts-page";
import { MailSettingsCard } from "../../settings/mail-settings-card";

const DEFAULT_MAIL_SETTINGS = {
  imapHost: "imap.qq.com",
  imapPort: 993,
  imapTls: true,
  imapUser: "sanmu@qq.com",
  imapPasswordConfigured: true,
  autoReloginDefault: true,
  reloginHeadless: null,
};

beforeEach(async () => {
  tauri.reset();
  tauri.onMethod("mail.getSettings", () => DEFAULT_MAIL_SETTINGS);
  __resetKeeperStoreForTests();
  await useKeeperStore.getState().bootstrapApp();
  tauri.emitBootstrap(makeBootstrap({
    accounts: [
      makeAccount({ id: "acc-401", email: "bad@icloud.com", status: "unknown", lastRunReason: "鉴权接口返回 401，未能确认会话状态" }),
      makeAccount({ id: "acc-ok", email: "good@icloud.com", status: "ok", hasAccessToken: true }),
    ],
  }));
});

it("一键巡检弹窗支持勾选遇到 401/失效自动重登并透传 autoRelogin 参数", async () => {
  const call = vi.fn(() =>
    makeOperation({
      kind: "account-inspection",
      state: "succeeded",
      result: { total: 2, succeeded: 2, successIds: ["acc-401", "acc-ok"], failures: [] },
    })
  );
  tauri.onMethod("accounts.inspect", call);

  render(<TooltipProvider><AccountsPage /></TooltipProvider>);
  fireEvent.click(screen.getByRole("button", { name: "一键巡检" }));

  const dialog = within(screen.getByRole("dialog", { name: "一键巡检" }));
  const toggle = await dialog.findByRole("switch", { name: /遇到 401 \/ 登录失效时自动重登/ });
  expect(toggle).toBeChecked();

  fireEvent.click(dialog.getByRole("button", { name: "开始巡检" }));
  await waitFor(() =>
    expect(call).toHaveBeenCalledWith({
      ids: ["acc-401", "acc-ok"],
      autoRelogin: true,
    })
  );
});

it("工具栏一键自动重登优先筛选 401/失效账号并支持窗口模式覆盖", async () => {
  const reloginCall = vi.fn(() =>
    makeOperation({
      kind: "account-relogin",
      state: "succeeded",
      result: { total: 1, succeeded: 1, successIds: ["acc-401"], failures: [] },
    })
  );
  tauri.onMethod("accounts.relogin", reloginCall);

  render(<TooltipProvider><AccountsPage /></TooltipProvider>);
  const reloginBtn = screen.getByRole("button", { name: /自动重登 \(1\)/ });
  fireEvent.click(reloginBtn);

  const dialog = within(screen.getByRole("dialog", { name: /一键自动重登/ }));
  expect(dialog.getByText("本次自动重登 1 个账号")).toBeVisible();

  fireEvent.change(dialog.getByLabelText("执行窗口模式"), { target: { value: "headed" } });
  fireEvent.click(dialog.getByRole("switch", { name: /强制清空会话后重登/ }));
  fireEvent.click(dialog.getByRole("button", { name: "开始自动重登" }));

  await waitFor(() =>
    expect(reloginCall).toHaveBeenCalledWith({
      ids: ["acc-401"],
      force: true,
      headless: false,
    })
  );
});

it("卡片凭据弹窗保存邮箱/密码/TOTP 后调用 accounts.setCredentials", async () => {
  const setCreds = vi.fn((params) => ({
    ...makeAccount({ id: String(params.id), email: "updated@example.com" }),
    hasPassword: true,
    hasTotpSecret: true,
  }));
  tauri.onMethod("accounts.setCredentials", setCreds);

  render(<TooltipProvider><AccountsPage /></TooltipProvider>);
  const [firstCredBtn] = screen.getAllByRole("button", { name: "登录凭据" });
  expect(firstCredBtn).toBeDefined();
  if (!firstCredBtn) throw new Error("missing credential button");
  fireEvent.click(firstCredBtn);

  const dialog = within(screen.getByRole("dialog"));
  fireEvent.change(dialog.getByLabelText("登录邮箱"), { target: { value: "updated@example.com" } });
  fireEvent.change(dialog.getByLabelText(/账号密码/), { target: { value: "pw-secret" } });
  fireEvent.change(dialog.getByLabelText(/TOTP 密钥/), { target: { value: "JBSWY3DPEHPK3PXP" } });
  fireEvent.click(dialog.getByRole("button", { name: "保存凭据" }));

  await waitFor(() =>
    expect(setCreds).toHaveBeenCalledWith({
      id: "acc-401",
      email: "updated@example.com",
      password: "pw-secret",
      totpSecret: "JBSWY3DPEHPK3PXP",
    })
  );
});

it("设置页接码邮箱卡片支持测试连接与保存配置", async () => {
  const testConn = vi.fn(() => ({
    ok: true,
    folders: ["INBOX", "Junk"],
    inboxMessages: 42,
    message: "连接成功：INBOX 共 42 封邮件",
  }));
  const updateMail = vi.fn((patch) => ({ ...DEFAULT_MAIL_SETTINGS, ...patch }));
  tauri.onMethod("mail.testConnection", testConn);
  tauri.onMethod("mail.updateSettings", updateMail);

  render(<MailSettingsCard />);
  await waitFor(() => expect(screen.getByLabelText("IMAP 服务器")).toHaveValue("imap.qq.com"));

  fireEvent.click(screen.getByRole("button", { name: "测试连接" }));
  await waitFor(() => expect(testConn).toHaveBeenCalled());
  expect(await screen.findByText(/INBOX 共 42 封邮件/)).toBeVisible();

  fireEvent.click(screen.getByRole("button", { name: "iCloud 邮箱" }));
  fireEvent.click(screen.getByRole("button", { name: "保存设置" }));
  await waitFor(() =>
    expect(updateMail).toHaveBeenCalledWith(
      expect.objectContaining({ imapHost: "imap.mail.me.com", imapPort: 993, imapTls: true })
    )
  );
});

it("延迟返回的 mail.getSettings 不会覆盖用户在巡检弹窗中手动切换的自动重登开关", async () => {
  const pendingMail = { resolve: undefined as ((value: typeof DEFAULT_MAIL_SETTINGS) => void) | undefined };
  useKeeperStore.setState({ mailSettings: null });
  tauri.onMethod(
    "mail.getSettings",
    () =>
      new Promise<typeof DEFAULT_MAIL_SETTINGS>((resolve) => {
        pendingMail.resolve = resolve;
      })
  );
  const inspectCall = vi.fn(() =>
    makeOperation({
      kind: "account-inspection",
      state: "succeeded",
      result: { total: 2, succeeded: 2, successIds: ["acc-401", "acc-ok"], failures: [] },
    })
  );
  tauri.onMethod("accounts.inspect", inspectCall);

  render(<TooltipProvider><AccountsPage /></TooltipProvider>);
  fireEvent.click(screen.getByRole("button", { name: "一键巡检" }));

  const dialog = within(screen.getByRole("dialog", { name: "一键巡检" }));
  const toggle = dialog.getByRole("switch", { name: /遇到 401 \/ 登录失效时自动重登/ });
  // Store 尚未完成拉取 mail.getSettings，此时初始默认关闭；用户手动开启后再回包不应覆盖回 false。
  expect(toggle).not.toBeChecked();
  fireEvent.click(toggle);
  expect(toggle).toBeChecked();

  expect(pendingMail.resolve).toBeDefined();
  pendingMail.resolve?.({ ...DEFAULT_MAIL_SETTINGS, autoReloginDefault: false });
  await waitFor(() => expect(useKeeperStore.getState().mailSettings).not.toBeNull());
  expect(toggle).toBeChecked();

  fireEvent.click(dialog.getByRole("button", { name: "开始巡检" }));
  await waitFor(() =>
    expect(inspectCall).toHaveBeenCalledWith({
      ids: ["acc-401", "acc-ok"],
      autoRelogin: true,
    })
  );
});
