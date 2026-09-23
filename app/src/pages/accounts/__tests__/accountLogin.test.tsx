import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { makeAccount, makeBootstrap, tauri } from "@/test/harness";
import { __resetKeeperStoreForTests, useKeeperStore } from "@/store/keeperStore";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AccountCard } from "../account-card";

beforeEach(async () => {
  tauri.reset();
  __resetKeeperStoreForTests();
  await useKeeperStore.getState().bootstrapApp();
  tauri.emitBootstrap(makeBootstrap({ accounts: [makeAccount({ id: "acc-1", status: "out" })] }));
});

it("普通登录不清会话；强制重登只有明确确认后才发送", async () => {
  const startLogin = vi.fn().mockResolvedValue(undefined);
  useKeeperStore.setState({ startLogin });
  render(<TooltipProvider><AccountCard id="acc-1" onDelete={() => {}} /></TooltipProvider>);

  fireEvent.click(screen.getByRole("button", { name: "登录" }));
  await waitFor(() => expect(startLogin).toHaveBeenCalledWith("acc-1", false));
  await waitFor(() => expect(screen.getByRole("button", { name: "强制重登" })).toBeEnabled());
  startLogin.mockClear();

  fireEvent.click(screen.getByRole("button", { name: "强制重登" }));
  expect(screen.getByRole("alertdialog")).toHaveTextContent("清除该账号浏览器中已保存的登录态");
  expect(startLogin).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  expect(startLogin).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("button", { name: "强制重登" }));
  fireEvent.click(screen.getByRole("button", { name: "清除并重新登录" }));
  await waitFor(() => expect(startLogin).toHaveBeenCalledExactlyOnceWith("acc-1", true));
});
