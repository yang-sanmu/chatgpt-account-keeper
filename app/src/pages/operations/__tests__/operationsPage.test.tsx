import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeAccount, makeBootstrap, makeOperation, tauri } from "@/test/harness";
import { normalizeOperationDisplay } from "@/lib/operation-labels";
import { __resetKeeperStoreForTests, useKeeperStore } from "@/store/keeperStore";
import { OperationsPage } from "../operations-page";

beforeEach(async () => {
  vi.clearAllMocks();
  tauri.reset();
  __resetKeeperStoreForTests();
  await useKeeperStore.getState().bootstrapApp();
});

describe("历史任务的完成态展示", () => {
  it("把成功任务遗留的 Chrome 关闭进度显示为完成", async () => {
    act(() => {
      tauri.emitBootstrap(
        makeBootstrap({
          operations: [
            makeOperation({
              id: "old-close-progress",
              kind: "account-run",
              state: "succeeded",
              stage: "closing",
              message: "正在关闭 Chrome",
              finishedAt: "2026-08-31T00:00:01.000Z",
            }),
          ],
        })
      );
    });
    const user = userEvent.setup();
    render(<OperationsPage />);

    await user.click(screen.getByRole("tab", { name: "成功" }));

    expect(screen.getByText("任务已完成")).toBeInTheDocument();
    expect(screen.queryByText("正在关闭 Chrome")).not.toBeInTheDocument();
    expect(screen.queryByText("[closing]")).not.toBeInTheDocument();
  });

  it("保留明确的完成摘要与非成功任务消息", () => {
    expect(normalizeOperationDisplay("succeeded", "complete", "全部选择器可用")).toEqual({
      stage: "complete",
      message: "全部选择器可用",
    });

    for (const operation of [
      { state: "running", stage: "closing", message: "正在关闭 Chrome" },
      { state: "failed", stage: "closing", message: "Chrome 未能确认回收" },
      { state: "cancelled", stage: "closing", message: "用户已取消" },
    ]) {
      expect(normalizeOperationDisplay(operation.state, operation.stage, operation.message)).toEqual({
        stage: operation.stage,
        message: operation.message,
      });
    }
  });

  it("关闭套餐弹窗后可在任务记录中查看逐账号失败原因", async () => {
    tauri.emitBootstrap(makeBootstrap({
      accounts: [makeAccount({ id: "acct-missing", email: null, note: "待巡检账号" })],
      operations: [makeOperation({
        kind: "account-plan-check",
        state: "succeeded",
        result: { total: 2, succeeded: 1, failures: [{ id: "acct-missing", detail: "缺少 accessToken，请先巡检" }] },
      })],
    }));
    const user = userEvent.setup();
    render(<OperationsPage />);

    await user.click(screen.getByRole("tab", { name: "失败" }));
    await user.click(screen.getByText("失败明细（1 个账号）"));
    expect(screen.getByText("待巡检账号 · 缺少 accessToken，请先巡检")).toBeVisible();
  });

  it("进行中的 iCloud 批量删除任务支持在任务中心停止", async () => {
    tauri.onMethod("icloud.cancelDelete", () => ({
      config: { enabled: true, intervalMinutes: 61, label: "G", note: "", networkMode: "direct" },
      status: "deleting",
      bound: true,
      busy: true,
      browserOpen: false,
      nextRunAt: null,
      cooldownUntil: null,
      lastSyncAt: null,
      lastMessage: "正在停止批量删除",
      pendingEmail: null,
      emails: [],
      history: [],
    }));
    act(() => {
      tauri.emitBootstrap(
        makeBootstrap({
          operations: [
            makeOperation({
              id: "op-icloud-del",
              kind: "icloud-delete",
              resourceId: "icloud_primary",
              state: "running",
              stage: "deleting",
              progress: 0.4,
              message: "正在删除 2 / 5：test@example.com",
            }),
          ],
        })
      );
    });
    const user = userEvent.setup();
    render(<OperationsPage />);

    expect(screen.getByText("正在删除 2 / 5：test@example.com")).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "40");
    await user.click(screen.getByRole("button", { name: "停止批量删除" }));
    expect(tauri.methodSequence()).toContain("icloud.cancelDelete");
  });
});
