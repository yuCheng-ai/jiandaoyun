// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { downloadExcel } from "../src/services/excel";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
function downloads() {
  const create = vi.fn(() => "blob:member-export");
  const revoke = vi.fn();
  vi.stubGlobal(
    "URL",
    class extends URL {
      static createObjectURL = create;
      static revokeObjectURL = revoke;
    },
  );
  const click = vi
    .spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(() => {});
  return { create, revoke, click };
}
it("does not create a browser download after the authorization check rejects the generated Excel", async () => {
  const { create, click } = downloads();
  await expect(
    downloadExcel("成员.xlsx", [["名称"], ["甲"]], ["name"], [], () => {
      throw Error("权限已撤销");
    }),
  ).rejects.toThrow("权限已撤销");
  expect(create).not.toHaveBeenCalled();
  expect(click).not.toHaveBeenCalled();
  expect(document.querySelector("a[download]")).toBeNull();
});
it("downloads once after the check succeeds, then removes the anchor and releases the file URL", async () => {
  const { create, revoke, click } = downloads();
  vi.useFakeTimers();
  let checked = false;
  click.mockImplementation(function (this: HTMLAnchorElement) {
    expect(checked).toBe(true);
    expect(this.download).toBe("成员_数据.xlsx");
    expect(this.isConnected).toBe(true);
  });
  await downloadExcel(
    "成员/数据.xlsx",
    [["名称"], ["甲"]],
    ["name"],
    [],
    () => (checked = true),
  );
  expect(create).toHaveBeenCalledTimes(1);
  expect(click).toHaveBeenCalledTimes(1);
  expect(document.querySelector("a[download]")).toBeNull();
  await vi.advanceTimersByTimeAsync(1000);
  expect(revoke).toHaveBeenCalledWith("blob:member-export");
});
