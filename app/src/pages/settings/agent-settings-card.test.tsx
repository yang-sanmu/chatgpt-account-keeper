import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Ajv2020 from "ajv/dist/2020";
import methodSchema from "../../../../contracts/ipc-v1.methods.schema.json";
import { makeBootstrap, tauri } from "@/test/harness";
import { __resetKeeperStoreForTests, useKeeperStore } from "@/store/keeperStore";
import { AgentSettingsCard } from "./agent-settings-card";

const validateUpdate = new Ajv2020({ strict: true, allErrors: true })
  .compile(methodSchema.$defs.settingsUpdateParams);

beforeEach(async () => {
  vi.clearAllMocks();
  tauri.reset();
  __resetKeeperStoreForTests();
  await useKeeperStore.getState().bootstrapApp();
});

describe("Agent 配置保存", () => {
  it.each([false, true])("调度器状态为 %s 时，修改配置通过真实 IPC 参数契约", async (schedulerEnabled) => {
    const user = userEvent.setup();
    const bootstrap = makeBootstrap();
    const settings = { ...(bootstrap.settings as Record<string, unknown>), schedulerEnabled };
    tauri.emitBootstrap({ ...bootstrap, settings });
    let savedParams: Record<string, unknown> | undefined;
    tauri.onMethod("settings.update", (params) => {
      savedParams = params;
      if (!validateUpdate(params)) throw new Error(JSON.stringify(validateUpdate.errors));
      return { ...settings, ...(params.patch as object) };
    });

    render(<AgentSettingsCard />);
    fireEvent.change(screen.getByLabelText("调度间隔 (分钟)"), { target: { value: "90" } });
    await user.click(screen.getByRole("switch", { name: "自动巡检状态" }));
    await user.click(screen.getByRole("button", { name: "保存设置" }));

    await waitFor(() => expect(savedParams).toBeDefined());
    expect(validateUpdate(savedParams), JSON.stringify(validateUpdate.errors)).toBe(true);
    expect(savedParams?.patch).not.toHaveProperty("schedulerEnabled");
    expect(savedParams?.patch).toMatchObject({ intervalMinutes: 90, statusCheckEnabled: true });
    await waitFor(() => expect(screen.getByRole("button", { name: "保存设置" })).toBeDisabled());
    expect(useKeeperStore.getState().agentSettings).toMatchObject({
      intervalMinutes: 90, statusCheckEnabled: true, schedulerEnabled,
    });
    expect(tauri.methodSequence()).not.toContain("scheduler.start");
    expect(tauri.methodSequence()).not.toContain("scheduler.stop");
  });

  it("局部更新只发送提供的可写字段", async () => {
    tauri.emitBootstrap(makeBootstrap());
    await useKeeperStore.getState().updateAgentSettings({ headless: false });
    const call = tauri.calls.find((item) => item.args?.method === "settings.update");
    expect(call?.args?.params).toEqual({ patch: { headless: false } });
  });
});
