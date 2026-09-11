import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AccountDeleteDialog } from "../account-delete-dialog";
import { __resetKeeperStoreForTests } from "@/store/keeperStore";
import { makeAccount, tauri } from "@/test/harness";

beforeEach(() => {
  vi.clearAllMocks();
  tauri.reset();
  __resetKeeperStoreForTests();
});

describe("account lifecycle choices", () => {
  it("defaults to disabling the account while retaining its Profile", async () => {
    const user = userEvent.setup();
    tauri.onMethod("accounts.update", (params) =>
      makeAccount({ id: String(params.id), enabled: false }),
    );
    render(
      <AccountDeleteDialog
        open
        onOpenChange={vi.fn()}
        accounts={[{ id: "acc-1", name: "user@example.com" }]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "停用并保留" }));

    await waitFor(() => {
      const call = tauri.calls.find(
        (item) => item.command === "agent_call" && item.args?.method === "accounts.update",
      );
      expect(call?.args?.params).toEqual({ id: "acc-1", patch: { enabled: false } });
    });
    expect(tauri.methodSequence()).not.toContain("accounts.remove");
  });

  it("permanent deletion always purges the account Profile", async () => {
    const user = userEvent.setup();
    tauri.onMethod("accounts.remove", () => ({ ok: true }));
    render(
      <AccountDeleteDialog
        open
        onOpenChange={vi.fn()}
        accounts={[{ id: "acc-1", name: "user@example.com" }]}
      />,
    );

    await user.click(screen.getByRole("radio", { name: /永久删除账号和 Profile/ }));
    await user.click(screen.getByRole("button", { name: "永久删除" }));

    await waitFor(() => {
      const call = tauri.calls.find(
        (item) => item.command === "agent_call" && item.args?.method === "accounts.remove",
      );
      expect(call?.args?.params).toEqual({ id: "acc-1", profileAction: "purge" });
    });
  });
});
