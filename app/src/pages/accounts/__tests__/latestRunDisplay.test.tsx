import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeAccount, makeBootstrap, makeOperation, tauri } from "@/test/harness";
import { __resetKeeperStoreForTests, useKeeperStore } from "@/store/keeperStore";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AccountCard } from "../account-card";

const oldError = "无法连接 Headless Chrome 的本地调试端口：等待超时";
const account = makeAccount({
  lastRunAt: "2026-08-31T10:00:00Z",
  lastRunOk: false,
  lastRunReason: oldError,
});

function renderCard() {
  return render(
    <TooltipProvider>
      <AccountCard id="acc-1" onDelete={() => {}} />
    </TooltipProvider>
  );
}

beforeEach(async () => {
  vi.clearAllMocks();
  tauri.reset();
  __resetKeeperStoreForTests();
  await useKeeperStore.getState().bootstrapApp();
  tauri.emitBootstrap(makeBootstrap({ accounts: [account] }));
});

describe("账号卡片的最近运行结果", () => {
  it("手动运行成功后不再显示更早的调度错误，也不改写自动调度记录", () => {
    renderCard();
    expect(screen.getByText(`失败: ${oldError}`)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "强制重登" })).toBeInTheDocument();

    act(() => {
      tauri.emitAgentEvent("operation.changed", makeOperation({
        kind: "account-run",
        resourceId: "acc-1",
        state: "succeeded",
        finishedAt: "2026-08-31T10:10:00Z",
      }));
    });

    expect(screen.queryByText(`失败: ${oldError}`)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "强制重登" })).not.toBeInTheDocument();
    expect(useKeeperStore.getState().accounts["acc-1"]?.effective.lastRunOk).toBe(false);
  });

  it("较新对话成功不能隐藏会话本身要求重新登录的入口", () => {
    tauri.emitBootstrap(makeBootstrap({
      accounts: [makeAccount({ ...account, status: "reauth" })],
      operations: [makeOperation({
        kind: "account-run", resourceId: "acc-1", state: "succeeded",
        finishedAt: "2026-08-31T10:10:00Z",
      })],
    }));
    renderCard();
    expect(screen.getByRole("button", { name: "强制重登" })).toBeInTheDocument();
  });

  it("重连补齐的最新失败优先于较旧的成功历史和大量巡检", () => {
    tauri.emitBootstrap(makeBootstrap({
      accounts: [account],
      operations: [
        ...Array.from({ length: 100 }, (_, index) => makeOperation({
          id: `check-${index}`, kind: "account-status-refresh", resourceId: "acc-1",
          state: "succeeded", finishedAt: "2026-08-31T10:30:00Z",
        })),
        makeOperation({
          id: "latest-failure", kind: "account-run", resourceId: "acc-1",
          state: "failed", finishedAt: "2026-08-31T10:20:00Z",
          error: { code: "INTERNAL", message: "新的 Chrome 启动失败", retryable: true },
        }),
      ],
      historyAccounts: [{
        accountId: "acc-1", entryCount: 2, deleted: false,
        lastAt: "2026-08-31T10:10:00Z", lastOk: true,
      }],
    }));
    renderCard();
    expect(screen.getByText("失败: 新的 Chrome 启动失败")).toBeInTheDocument();
  });

  it("重连快照中较新的成功历史也能覆盖旧错误，不依赖最近任务列表的容量", () => {
    tauri.emitBootstrap(makeBootstrap({
      accounts: [account],
      operations: [],
      historyAccounts: [{
        accountId: "acc-1", entryCount: 2, deleted: false,
        lastAt: "2026-08-31T10:10:00Z", lastOk: true,
      }],
    }));
    renderCard();

    expect(screen.queryByText(`失败: ${oldError}`)).not.toBeInTheDocument();
  });

  it("较新的运行失败显示这次的错误而不是更早的端口错误", () => {
    tauri.emitAgentEvent("operation.changed", makeOperation({
      kind: "account-run",
      resourceId: "acc-1",
      state: "failed",
      finishedAt: "2026-08-31T10:10:00Z",
      message: "正在关闭 Chrome",
      error: { code: "INTERNAL", message: "本次对话发送失败", retryable: true },
    }));
    renderCard();

    expect(screen.getByText("失败: 本次对话发送失败")).toBeInTheDocument();
    expect(screen.queryByText(`失败: ${oldError}`)).not.toBeInTheDocument();
  });

  it("较新的失败历史没有明细时引导看历史，不把旧错误冒充成新原因", () => {
    tauri.emitBootstrap(makeBootstrap({
      accounts: [account],
      historyAccounts: [{
        accountId: "acc-1", entryCount: 2, deleted: false,
        lastAt: "2026-08-31T10:10:00Z", lastOk: false,
      }],
    }));
    renderCard();

    expect(screen.getByText(/最近一次对话失败，请查看历史记录/)).toBeInTheDocument();
    expect(screen.queryByText(`失败: ${oldError}`)).not.toBeInTheDocument();
  });

  it("更早的成功和状态巡检成功都不能抹掉较新的对话失败", () => {
    tauri.emitBootstrap(makeBootstrap({
      accounts: [account],
      operations: [
        makeOperation({
          id: "check", kind: "account-status-refresh", resourceId: "acc-1",
          state: "succeeded", finishedAt: "2026-08-31T10:20:00Z",
        }),
        makeOperation({
          id: "old-run", kind: "account-run", resourceId: "acc-1",
          state: "succeeded", finishedAt: "2026-08-31T09:00:00Z",
        }),
      ],
    }));
    renderCard();

    expect(screen.getByText(`失败: ${oldError}`)).toBeInTheDocument();
  });

  it("按完成时间选择结果，不依赖任务排列顺序", () => {
    tauri.emitBootstrap(makeBootstrap({
      accounts: [account],
      operations: [
        makeOperation({
          id: "older-failure", kind: "account-run", resourceId: "acc-1",
          state: "failed", finishedAt: "2026-08-31T10:05:00Z", message: oldError,
        }),
        makeOperation({
          id: "latest-success", kind: "account-run", resourceId: "acc-1",
          state: "succeeded", finishedAt: "2026-08-31T10:10:00Z",
        }),
      ],
    }));
    renderCard();

    expect(screen.queryByText(`失败: ${oldError}`)).not.toBeInTheDocument();
  });
});
