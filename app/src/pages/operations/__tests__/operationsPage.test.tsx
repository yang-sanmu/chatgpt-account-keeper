import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeBootstrap, makeOperation, tauri } from "@/test/harness";
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
});
