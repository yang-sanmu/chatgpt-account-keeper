import { render, screen, fireEvent } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeAccount, makeBootstrap, tauri } from "@/test/harness";
import { __resetKeeperStoreForTests, useKeeperStore } from "@/store/keeperStore";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AccountCard } from "../account-card";
import { notify } from "@/lib/notify";

vi.mock("@/lib/notify", () => ({
  notify: {
    success: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
  },
}));

function renderCard(id = "acc-1") {
  return render(
    <TooltipProvider>
      <AccountCard id={id} onDelete={() => {}} />
    </TooltipProvider>
  );
}

describe("账号卡片点击复制功能", () => {
  let writeTextMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    tauri.reset();
    __resetKeeperStoreForTests();

    writeTextMock = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, {
      clipboard: {
        writeText: writeTextMock,
      },
    });

    await useKeeperStore.getState().bootstrapApp();
  });

  it("点击账号名称复制真实邮箱账号", async () => {
    tauri.emitBootstrap(
      makeBootstrap({
        accounts: [makeAccount({ id: "acc-1", email: "myuser@example.com" })],
      })
    );

    renderCard("acc-1");

    // 默认脱敏状态下显示脱敏文本
    const titleElement = screen.getByTitle("myuser@example.com (点击复制账号)");
    expect(titleElement).toBeInTheDocument();

    fireEvent.click(titleElement);

    // 即使脱敏，复制的也是完整真实邮箱
    expect(writeTextMock).toHaveBeenCalledWith("myuser@example.com");
    expect(notify.success).toHaveBeenCalledWith("已复制账号", "myuser@example.com");
  });

  it("明文显示模式下点击依然正常复制", async () => {
    useKeeperStore.getState().setEmailsRevealed(true);
    tauri.emitBootstrap(
      makeBootstrap({
        accounts: [makeAccount({ id: "acc-1", email: "myuser@example.com" })],
      })
    );

    renderCard("acc-1");

    const titleElement = screen.getByTitle("myuser@example.com (点击复制账号)");
    fireEvent.click(titleElement);

    expect(writeTextMock).toHaveBeenCalledWith("myuser@example.com");
    expect(notify.success).toHaveBeenCalledWith("已复制账号", "myuser@example.com");
  });

  it("无邮箱但有备注的账号点击复制备注", async () => {
    tauri.emitBootstrap(
      makeBootstrap({
        accounts: [makeAccount({ id: "acc-2", email: null, note: "测试账号备注" })],
      })
    );

    renderCard("acc-2");

    const titleElement = screen.getByTitle("测试账号备注 (点击复制备注)");
    fireEvent.click(titleElement);

    expect(writeTextMock).toHaveBeenCalledWith("测试账号备注");
    expect(notify.success).toHaveBeenCalledWith("已复制账号备注", "测试账号备注");
  });

  it("既无邮箱也无备注的账号点击不复制并提示", async () => {
    tauri.emitBootstrap(
      makeBootstrap({
        accounts: [makeAccount({ id: "acc-3", email: null, note: "" })],
      })
    );

    renderCard("acc-3");

    const titleElement = screen.getByTitle("未登录");
    fireEvent.click(titleElement);

    expect(writeTextMock).not.toHaveBeenCalled();
    expect(notify.success).not.toHaveBeenCalled();
  });

  it("用户正在鼠标划选文本时不触发复制", async () => {
    tauri.emitBootstrap(
      makeBootstrap({
        accounts: [makeAccount({ id: "acc-1", email: "myuser@example.com" })],
      })
    );

    renderCard("acc-1");

    const originalGetSelection = window.getSelection;
    window.getSelection = vi.fn().mockReturnValue({
      toString: () => "myuser",
    } as unknown as Selection);

    const titleElement = screen.getByTitle("myuser@example.com (点击复制账号)");
    fireEvent.click(titleElement);

    expect(writeTextMock).not.toHaveBeenCalled();
    expect(notify.success).not.toHaveBeenCalled();

    window.getSelection = originalGetSelection;
  });
});
