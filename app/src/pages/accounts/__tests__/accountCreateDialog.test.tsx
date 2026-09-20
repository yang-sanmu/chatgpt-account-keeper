import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AccountCreateDialog } from "../account-create-dialog";
import { __resetKeeperStoreForTests } from "@/store/keeperStore";
import { makeAccount, makeOperation, tauri } from "@/test/harness";

beforeEach(() => {
  vi.clearAllMocks();
  tauri.reset();
  __resetKeeperStoreForTests();
  tauri.onMethod("accounts.create", () => makeAccount({ id: "acc-new", email: null }));
  tauri.onMethod("browser.startLogin", () => makeOperation({ id: "op-login" }));
});

describe("新增账号登录选项", () => {
  it("创建失败时保留输入和关闭选项，允许直接重试", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    tauri.failMethod("accounts.create", {
      code: "AGENT_DRAINING", message: "正在排空", retryable: true,
    });
    render(<AccountCreateDialog open onOpenChange={onOpenChange} />);
    await user.type(screen.getByLabelText("备注 (可选)"), "重试账号");
    await user.click(screen.getByRole("checkbox", { name: "登录成功后自动关闭浏览器" }));
    await user.click(screen.getByRole("button", { name: "创建并登录" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "创建并登录" })).toBeEnabled());
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByLabelText("备注 (可选)")).toHaveValue("重试账号");
    expect(screen.getByRole("checkbox")).toBeChecked();
    expect(tauri.methodSequence()).not.toContain("browser.startLogin");
    tauri.onMethod("accounts.create", () => makeAccount({ id: "acc-new", email: null }));
    await user.click(screen.getByRole("button", { name: "创建并登录" }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    const loginCall = tauri.calls.find((item) => item.args?.method === "browser.startLogin");
    expect(loginCall?.args?.params).toMatchObject({ closeOnSuccess: true, checkPromoOnSuccess: true });
  });

  it.each([false, true])("自动关闭=%s，创建后登录并检查一次优惠", async (closeOnSuccess) => {
    const user = userEvent.setup();
    render(<AccountCreateDialog open onOpenChange={vi.fn()} />);
    const checkbox = screen.getByRole("checkbox", { name: "登录成功后自动关闭浏览器" });
    expect(checkbox).not.toBeChecked();
    if (closeOnSuccess) await user.click(checkbox);
    await user.click(screen.getByRole("button", { name: "创建并登录" }));
    await waitFor(() => {
      const call = tauri.calls.find((item) => item.args?.method === "browser.startLogin");
      expect(call?.args?.params).toEqual({
        accountId: "acc-new", force: false, closeOnSuccess, checkPromoOnSuccess: true,
      });
    });
    const createCall = tauri.calls.find((item) => item.args?.method === "accounts.create");
    expect(createCall?.args?.params).not.toHaveProperty("closeOnSuccess");
  });
});
