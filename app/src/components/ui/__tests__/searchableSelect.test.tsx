import { expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SearchableSelect } from "../searchable-select";

it("filters partial names case-insensitively and selects with Enter", async () => {
  const user = userEvent.setup();
  const change = vi.fn();
  render(<SearchableSelect label="节点" value="none" onValueChange={change} options={[
    { value: "none", label: "未绑定" }, { value: "us", label: "US 美国 01" }, { value: "jp", label: "日本 02" },
  ]} />);
  await user.click(screen.getByRole("combobox"));
  await user.type(screen.getByRole("textbox"), "us 01");
  expect(screen.getAllByRole("option")).toHaveLength(1);
  await user.keyboard("{Enter}");
  expect(change).toHaveBeenCalledWith("us");
  await user.click(screen.getByRole("combobox"));
  expect(screen.getAllByRole("option")).toHaveLength(3);
  await user.type(screen.getByRole("textbox"), "不存在");
  expect(screen.getByText("没有匹配项")).toBeInTheDocument();
});


it("does not select on IME confirmation and supports arrow navigation", async () => {
  const user = userEvent.setup();
  const change = vi.fn();
  render(<SearchableSelect label="分组" value="a" onValueChange={change} options={[
    { value: "a", label: "美国" }, { value: "b", label: "日本" },
  ]} />);
  await user.click(screen.getByRole("combobox"));
  const input = screen.getByRole("textbox");
  fireEvent.keyDown(input, { key: "Enter", isComposing: true });
  expect(change).not.toHaveBeenCalled();
  expect(screen.getByRole("listbox")).toBeInTheDocument();
  await user.keyboard("{ArrowDown}{ArrowDown}{Enter}");
  expect(change).toHaveBeenCalledWith("b");
});
