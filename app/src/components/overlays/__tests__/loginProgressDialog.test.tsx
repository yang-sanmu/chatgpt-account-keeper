// 登录进度弹窗的阶段标题。
//
// Agent 把登录任务除 waiting 之外的所有阶段都发成 state=running（见 services.js 的
// _browserStartLogin），所以只看 state 永远只能说"正在登录"。但登录检测通过之后还有
// 保存 Session 和查优惠两步，每步几秒；标题一直停在"正在登录"，用户会以为登录本身卡住
// 了 —— 实际上账号早就登进去了。真实阶段只在 stage 里，这组用例钉的就是它被用上。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LoginProgressDialog } from "../login-progress-dialog";
import { useKeeperStore, __resetKeeperStoreForTests } from "@/store/keeperStore";
import { makeOperation, tauri } from "@/test/harness";

type OperationState = ReturnType<typeof makeOperation>["state"];

function showLogin(stage: string | null, state: OperationState = "running") {
  useKeeperStore.setState({
    login: {
      accountId: "acc-1",
      accountEmail: "person@example.com",
      accountNote: "",
      operation: makeOperation({ id: "op-login", kind: "account-login", state, stage }),
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  tauri.reset();
  __resetKeeperStoreForTests();
});

describe("登录进度弹窗的阶段标题", () => {
  it("优惠检查阶段说出正在检查优惠资格，而不是正在登录", () => {
    showLogin("promo");
    render(<LoginProgressDialog />);
    expect(screen.getByText("正在检查优惠资格")).toBeInTheDocument();
    expect(screen.queryByText("正在登录")).not.toBeInTheDocument();
  });

  it("保存与清理阶段各有自己的标题", () => {
    showLogin("saving");
    const { unmount } = render(<LoginProgressDialog />);
    expect(screen.getByText("正在保存登录状态")).toBeInTheDocument();
    unmount();

    showLogin("clearing");
    render(<LoginProgressDialog />);
    expect(screen.getByText("正在清除旧登录态")).toBeInTheDocument();
  });

  it("未知或缺失的阶段回落到正在登录", () => {
    // stage 是开放字符串（Agent 可能加新阶段）。查不到时必须回落，不能显示空标题。
    showLogin("opening");
    const { unmount } = render(<LoginProgressDialog />);
    expect(screen.getByText("正在登录")).toBeInTheDocument();
    unmount();

    showLogin(null);
    render(<LoginProgressDialog />);
    expect(screen.getByText("正在登录")).toBeInTheDocument();
  });

  it("终态标题不受 stage 影响", () => {
    // 成功那一刻 stage 仍是 complete/promo 之类，但此时该说"登录完成"。
    showLogin("promo", "succeeded");
    const { unmount } = render(<LoginProgressDialog />);
    expect(screen.getByText("登录完成")).toBeInTheDocument();
    unmount();

    showLogin("promo", "failed");
    render(<LoginProgressDialog />);
    expect(screen.getByText("登录未完成")).toBeInTheDocument();
  });
});

describe("关闭弹窗不影响后台任务", () => {
  it("点空白处关闭只清本地弹窗状态，不向 Agent 发任何取消调用", async () => {
    const user = userEvent.setup();
    showLogin("promo");
    render(<LoginProgressDialog />);
    expect(screen.getByText("正在检查优惠资格")).toBeInTheDocument();

    const before = tauri.calls.length;
    // Radix 的遮罩关闭走的就是 onOpenChange(false)，与按 Esc、点"转到后台继续"同一条路径。
    await user.keyboard("{Escape}");

    expect(useKeeperStore.getState().login).toBeNull();
    // 关键：不能有任何 IPC 调用。优惠检查跑在 Agent 侧，弹窗只是个观察窗口；
    // 这里一旦冒出 cancel/close 之类的调用，关弹窗就会真的把后台检查掐掉。
    expect(tauri.calls.slice(before)).toEqual([]);
  });

});
