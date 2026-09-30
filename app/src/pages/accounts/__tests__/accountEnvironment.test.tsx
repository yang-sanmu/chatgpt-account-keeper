import { beforeEach, expect, it } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { tauri } from "@/test/harness";
import type { EnvironmentStateResult } from "@/ipc/generated";
import { AccountEnvironmentPanel } from "../account-environment-panel";

function result(mode: "inherit" | "fixed" = "inherit", version = 0): EnvironmentStateResult {
  return { configuration: { accountId: "a", mode, locale: mode === "fixed" ? "de-DE" : null,
    timezone: mode === "fixed" ? "Europe/Berlin" : null, version, updatedAt: null },
  next: { mode, version, groupId: null, locale: "de-DE", timezoneId: "Europe/Berlin", localeSource: "system", timezoneSource: "system" },
  running: [], pending: version > 0 };
}
beforeEach(() => { tauri.reset(); tauri.onInvoke("plugin:window|is_visible", () => true); });

it("saves a versioned fixed environment and explicitly restores inheritance", async () => {
  tauri.onMethod("environments.get", () => result());
  let saved: unknown; let reset: unknown;
  tauri.onMethod("environments.update", params => { saved = params; return result("fixed", 1); });
  tauri.onMethod("environments.reset", params => { reset = params; return result("inherit", 2); });
  render(<AccountEnvironmentPanel accountId="a" />);
  const save = screen.getByRole("button", { name: "保存为账号固定" });
  await waitFor(() => expect(save).toBeEnabled());
  fireEvent.change(screen.getByLabelText("语言"), { target: { value: "de-DE" } });
  fireEvent.click(save);
  await waitFor(() => expect(saved).toEqual({ accountId: "a", expectedVersion: 0, locale: "de-DE", timezone: "Europe/Berlin" }));
  expect(await screen.findByRole("status")).toHaveTextContent("待生效：版本 1");
  fireEvent.click(screen.getByRole("button", { name: "恢复继承" }));
  await waitFor(() => expect(reset).toEqual({ accountId: "a", expectedVersion: 1 }));
  expect(tauri.calls.filter(c => c.command === "agent_call" && c.args?.method === "environments.update")[0]?.args?.commandId).toBeTruthy();
});

it("serializes queries across cards and does not query while the native window is hidden", async () => {
  let finish!: (value: EnvironmentStateResult) => void;
  tauri.onMethod("environments.get", () => new Promise<EnvironmentStateResult>(resolve => { finish = resolve; }));
  const view = render(<><AccountEnvironmentPanel accountId="a" /><AccountEnvironmentPanel accountId="b" /></>);
  await waitFor(() => expect(tauri.methodSequence()).toEqual(["environments.get"]));
  tauri.onInvoke("plugin:window|is_visible", () => false);
  await act(async () => { finish(result()); });
  expect(tauri.methodSequence()).toEqual(["environments.get"]);
  view.unmount();
});
