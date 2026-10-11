// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { createApp, h, nextTick, reactive, ref } from "vue";
import OptionColorPicker from "../src/components/OptionColorPicker.vue";
import CustomColorPanel from "../src/components/CustomColorPanel.vue";
import BaseDialog from "../src/components/BaseDialog.vue";
import {
  customColorOwnerKey,
  customColorStorageKey,
  readCustomColors,
} from "../src/repositories/customColors";

let app: ReturnType<typeof createApp> | undefined;
async function flush() {
  for (let i = 0; i < 6; i++) await nextTick();
}
afterEach(() => {
  app?.unmount();
  app = undefined;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  localStorage.clear();
});
const button = (name: string) =>
  document.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)!;
const input = (name: string) =>
  document.querySelector<HTMLInputElement>(`input[aria-label="${name}"]`)!;
async function fill(name: string, value: string) {
  const e = input(name);
  e.value = value;
  e.dispatchEvent(new Event("input", { bubbles: true }));
  await flush();
}
function escape() {
  document.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
  );
}
function pointer(
  element: HTMLElement,
  type: string,
  x: number,
  y: number,
  id = 1,
) {
  const event = new MouseEvent(type, {
    bubbles: true,
    clientX: x,
    clientY: y,
    button: 0,
  });
  Object.defineProperty(event, "pointerId", { value: id });
  element.dispatchEvent(event);
}
async function mount(
  nested = false,
  panelOnly = false,
  owner = ref("local:test"),
) {
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([
    {},
  ] as unknown as DOMRectList);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 234,
    bottom: 160,
    width: 234,
    height: 160,
    toJSON: () => ({}),
  } as DOMRect);
  const state = reactive({ color: "#123456", disabled: false, outer: true }),
    changes = vi.fn((value: string) => (state.color = value));
  document.body.innerHTML = '<div id="app"></div>';
  app = createApp({
    render: () =>
      h("div", [
        h("button", { id: "outside" }, "其他属性"),
        panelOnly
          ? h(CustomColorPanel, {
              color: state.color,
              label: "测试",
              disabled: state.disabled,
              onChange: changes,
            })
          : nested
            ? h(
                BaseDialog,
                {
                  open: state.outer,
                  title: "外观设置",
                  onClose: () => (state.outer = false),
                },
                {
                  default: () =>
                    h(OptionColorPicker, {
                      color: state.color,
                      label: "测试",
                      disabled: state.disabled,
                      onChange: changes,
                    }),
                },
              )
            : h(OptionColorPicker, {
                color: state.color,
                label: "测试",
                disabled: state.disabled,
                onChange: changes,
              }),
      ]),
  });
  app.provide(customColorOwnerKey, owner);
  app.mount("#app");
  await flush();
  if (panelOnly)
    return {
      state,
      changes,
      trigger: button("测试颜色"),
      custom: button("测试自定义颜色"),
    };
  const trigger = button("测试颜色");
  trigger.focus();
  trigger.click();
  await flush();
  const custom = button("测试自定义颜色");
  custom.focus();
  custom.click();
  await flush();
  return { state, changes, trigger, custom };
}
it("uses the custom panel without changing an existing color on open; valid HEX/RGB stay synchronized and invalid edits do not write", async () => {
  const f = await mount(false, true);
  expect(input("测试 HEX").value).toBe("#123456");
  expect(f.changes).not.toHaveBeenCalled();
  await fill("测试 HEX", "#123456");
  expect(["R", "G", "B"].map((c) => input(`测试 ${c}`).value)).toEqual([
    "18",
    "52",
    "86",
  ]);
  await fill("测试 G", "255");
  expect(f.state.color).toBe("#12ff56");
  const count = f.changes.mock.calls.length;
  for (const bad of ["#123", "url(1)", "#gggggg"]) {
    await fill("测试 HEX", bad);
    expect(input("测试 HEX").getAttribute("aria-invalid")).toBe("true");
  }
  expect(f.changes).toHaveBeenCalledTimes(count);
  input("测试 HEX").dispatchEvent(new Event("blur"));
  await flush();
  expect(input("测试 HEX").value).toBe("#gggggg");
  await fill("测试 R", "256");
  await fill("测试 R", "-1");
  await fill("测试 R", "1.5");
  expect(f.changes).toHaveBeenCalledTimes(count);
  input("测试 R").dispatchEvent(new Event("blur"));
  await flush();
  expect(input("测试 R").value).toBe("1");
  expect(f.state.color).toBe("#01ff56");
});
it("commits a saturation drag once, cancels interrupted gestures and ignores a second pointer", async () => {
  const f = await mount(false, true);
  await fill("测试 HEX", "#ff0000");
  f.changes.mockClear();
  const area = document.querySelector<HTMLElement>(".x-sv-panel")!;
  pointer(area, "pointerdown", 234, 0);
  pointer(area, "pointermove", 0, 160, 2);
  pointer(area, "pointermove", 117, 80);
  pointer(area, "pointermove", 120, 90);
  pointer(area, "pointermove", 117, 80);
  expect(f.changes).not.toHaveBeenCalled();
  pointer(area, "pointerup", 117, 80);
  await flush();
  expect(f.changes).toHaveBeenCalledOnce();
  expect(f.state.color).toBe("#804040");
  pointer(area, "pointerdown", 234, 0);
  pointer(area, "pointermove", 0, 160);
  pointer(area, "pointercancel", 0, 160);
  await flush();
  expect(f.changes).toHaveBeenCalledOnce();
  expect(input("测试 HEX").value).toBe("#804040");
});
it("offers keyboard hue and two-axis color selection including neutral and black colors", async () => {
  const f = await mount(false, true);
  await fill("测试 HEX", "#ff0000");
  const hue = input("色相");
  hue.value = "240";
  hue.dispatchEvent(new Event("input", { bubbles: true }));
  expect(f.state.color).toBe("#ff0000");
  hue.dispatchEvent(new Event("change", { bubbles: true }));
  await flush();
  expect(f.state.color).toBe("#0000ff");
  const area = document.querySelector<HTMLElement>(".x-sv-panel")!;
  area.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Home", bubbles: true }),
  );
  await flush();
  expect(f.state.color).toBe("#ffffff");
  area.dispatchEvent(
    new KeyboardEvent("keydown", { key: "End", bubbles: true }),
  );
  await flush();
  expect(f.state.color).toBe("#0000ff");
  await fill("测试 HEX", "#000000");
  expect(["R", "G", "B"].map((c) => input(`测试 ${c}`).value)).toEqual([
    "0",
    "0",
    "0",
  ]);
});
it("Escape dismisses one picker at a time and preserves the enclosing settings dialog and focus", async () => {
  const f = await mount(true);
  expect(document.activeElement).toBe(document.querySelector(".x-sv-panel"));
  escape();
  await flush();
  expect(document.querySelector(".custom-color-panel")).toBeNull();
  expect(document.querySelector(".option-color-panel")).not.toBeNull();
  expect(document.activeElement).toBe(f.custom);
  expect(f.trigger.isConnected).toBe(true);
  expect(f.trigger.closest("[inert]")).toBeNull();
  escape();
  await flush();
  expect(document.querySelector(".option-color-panel")).toBeNull();
  expect(document.activeElement).toBe(f.trigger);
  expect(f.state.outer).toBe(true);
  escape();
  await flush();
  expect(f.state.outer).toBe(false);
  expect(document.body.style.overflow).toBe("");
  expect(f.changes).not.toHaveBeenCalled();
});
it("leaving both popovers closes both without stealing focus, and outside pointer dismissal leaves a parent dialog open", async () => {
  await mount();
  const elsewhere = document.querySelector<HTMLButtonElement>("#outside")!;
  elsewhere.focus();
  await flush();
  expect(
    document.querySelector(".custom-color-panel,.option-color-panel"),
  ).toBeNull();
  expect(document.activeElement).toBe(elsewhere);
  app?.unmount();
  app = undefined;
  const f = await mount(true);
  document
    .querySelector(".dialog-header")!
    .dispatchEvent(new Event("pointerdown", { bubbles: true }));
  await flush();
  expect(
    document.querySelector(".custom-color-panel,.option-color-panel"),
  ).toBeNull();
  expect(f.state.outer).toBe(true);
});
it("disabling the owner or updating its color ends a pending gesture without a late write", async () => {
  const f = await mount();
  const area = document.querySelector<HTMLElement>(".x-sv-panel")!;
  pointer(area, "pointerdown", 234, 0);
  f.state.color = "#00ff00";
  await flush();
  pointer(area, "pointerup", 117, 80);
  await flush();
  expect(f.changes).not.toHaveBeenCalled();
  expect(input("测试 HEX").value).toBe("#00FF00");
  pointer(area, "pointerdown", 234, 0);
  f.state.disabled = true;
  await flush();
  pointer(area, "pointerup", 117, 80);
  expect(
    document.querySelector(".custom-color-panel,.option-color-panel"),
  ).toBeNull();
  expect(f.changes).not.toHaveBeenCalled();
});

it("previews the last valid color and applies it once when the custom panel closes", async () => {
  const f = await mount(true);
  await fill("测试 HEX", "#abcdef");
  await fill("测试 HEX", "#2468ac");
  await fill("测试 HEX", "#invalid");
  expect(f.state.color).toBe("#123456");
  expect(f.changes).not.toHaveBeenCalled();
  expect(readCustomColors("local:test")).toEqual([]);
  escape();
  await flush();
  expect(f.changes).toHaveBeenCalledExactlyOnceWith("#2468ac");
  expect(readCustomColors("local:test")).toEqual(["#2468ac"]);
  expect(button("自定义颜色 #123456")).not.toBeNull();
  expect(document.querySelector(".option-color-panel")).not.toBeNull();
  expect(document.activeElement).toBe(f.custom);
  escape();
  await flush();
  expect(f.state.outer).toBe(true);
  expect(f.changes).toHaveBeenCalledOnce();
});

it("changing back to the original color replaces the preview without writing the intermediate choice", async () => {
  const f = await mount();
  await fill("测试 HEX", "#abcdef");
  await fill("测试 HEX", "#123456");
  escape();
  await flush();
  expect(f.state.color).toBe("#123456");
  expect(f.changes).not.toHaveBeenCalled();
  expect(readCustomColors("local:test")).toEqual(["#123456"]);
});

it("reuses seven distinct recent colors after remounting, preserves the latest other-page choice, and does not record recommended colors", async () => {
  const f = await mount();
  for (const value of [
    "#100001",
    "#100002",
    "#100003",
    "#100004",
    "#100005",
    "#100006",
    "#100007",
    "#100008",
    "#100003",
  ]) {
    await fill("测试 HEX", value);
    escape();
    await flush();
    f.custom.click();
    await flush();
  }
  expect(readCustomColors("local:test")).toEqual([
    "#100003",
    "#100008",
    "#100007",
    "#100006",
    "#100005",
    "#100004",
    "#100002",
  ]);
  localStorage.setItem(
    customColorStorageKey("local:test"),
    JSON.stringify(["#f1f2f3", ...readCustomColors("local:test")]),
  );
  await fill("测试 HEX", "#abcdef");
  escape();
  await flush();
  expect(readCustomColors("local:test")).toContain("#f1f2f3");
  const before = readCustomColors("local:test");
  button("颜色 #2f7deb").click();
  await flush();
  expect(f.state.color).toBe("#2f7deb");
  expect(readCustomColors("local:test")).toEqual(before);
  expect(document.querySelector(".option-color-panel")).not.toBeNull();
  app?.unmount();
  app = undefined;
  const remounted = await mount();
  escape();
  await flush();
  const colors = [...document.querySelectorAll(".option-custom-color")].map(
    (e) => e.getAttribute("aria-label"),
  );
  button("自定义颜色 #f1f2f3").click();
  await flush();
  expect(remounted.state.color).toBe("#f1f2f3");
  expect(
    [...document.querySelectorAll(".option-custom-color")].map((e) =>
      e.getAttribute("aria-label"),
    ),
  ).toEqual(colors);
});

it("does not apply a pending preview after identity, permissions or the field color changes", async () => {
  const owner = ref("local:first");
  localStorage.setItem(
    customColorStorageKey(owner.value),
    JSON.stringify(["#abcdef"]),
  );
  const f = await mount(false, false, owner);
  await fill("测试 HEX", "#2468ac");
  owner.value = "local:second";
  await flush();
  expect(document.querySelector(".option-color-panel")).toBeNull();
  expect(f.state.color).toBe("#123456");
  expect(f.changes).not.toHaveBeenCalled();
  f.trigger.click();
  await flush();
  expect(button("自定义颜色 #abcdef")).toBeNull();
  f.custom.click();
  await flush();
  await fill("测试 HEX", "#2468ac");
  f.state.color = "#aabbcc";
  await flush();
  escape();
  await flush();
  expect(f.state.color).toBe("#aabbcc");
  expect(f.changes).not.toHaveBeenCalled();
  f.custom.click();
  await flush();
  await fill("测试 HEX", "#2468ac");
  f.state.disabled = true;
  await flush();
  expect(document.querySelector(".option-color-panel")).toBeNull();
  expect(f.changes).not.toHaveBeenCalled();
  expect(readCustomColors("local:first")).toEqual(["#abcdef"]);
  expect(readCustomColors("local:second")).toEqual([]);
});

it("a preference-storage failure does not prevent applying or reusing a color in the current picker", async () => {
  const f = await mount();
  const original = Storage.prototype.setItem;
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
    this: Storage,
    key,
    value,
  ) {
    if (key.startsWith("workflow-studio-custom-colors:"))
      throw new Error("storage unavailable");
    original.call(this, key, value);
  });
  await fill("测试 HEX", "#abcdef");
  escape();
  await flush();
  expect(f.state.color).toBe("#abcdef");
  expect(f.changes).toHaveBeenCalledExactlyOnceWith("#abcdef");
  expect(button("自定义颜色 #abcdef")).not.toBeNull();
});

it("keeps valid HEX typing and invalid HEX on blur, syncing RGB without applying the field before dismissal", async () => {
  const f = await mount();
  await fill("测试 HEX", "abcdef");
  expect(input("测试 HEX").value).toBe("#abcdef");
  expect(
    ["R", "G", "B"].map((channel) => input(`测试 ${channel}`).value),
  ).toEqual(["171", "205", "239"]);
  expect(f.state.color).toBe("#123456");
  await fill("测试 HEX", "#abc");
  input("测试 HEX").dispatchEvent(new Event("blur"));
  await flush();
  expect(input("测试 HEX").value).toBe("#abc");
  expect(input("测试 HEX").getAttribute("aria-invalid")).toBe("true");
  expect(
    document.querySelector<HTMLElement>(".main-left .color-value")!.style
      .backgroundColor,
  ).toBe("rgb(171, 205, 239)");
  expect(f.changes).not.toHaveBeenCalled();
  escape();
  await flush();
  expect(f.changes).toHaveBeenCalledExactlyOnceWith("#abcdef");
  expect(readCustomColors("local:test")).toEqual(["#abcdef"]);
});

it("normalizes each invalid RGB channel on blur and applies only the final preview once", async () => {
  const f = await mount();
  for (const [channel, raw, corrected] of [
    ["R", "999", "255"],
    ["G", "-3", "0"],
    ["B", "12.8", "12"],
    ["R", "000", "0"],
    ["G", "030", "30"],
    ["B", "", "0"],
  ]) {
    await fill(`测试 ${channel}`, raw!);
    expect(input(`测试 ${channel}`).getAttribute("aria-invalid")).toBe("true");
    expect(f.state.color).toBe("#123456");
    input(`测试 ${channel}`).dispatchEvent(new Event("blur"));
    await flush();
    expect(input(`测试 ${channel}`).value).toBe(corrected);
    expect(input(`测试 ${channel}`).getAttribute("aria-invalid")).toBe("false");
  }
  expect(input("测试 HEX").value).toBe("#001E00");
  expect(f.changes).not.toHaveBeenCalled();
  escape();
  await flush();
  expect(f.changes).toHaveBeenCalledExactlyOnceWith("#001e00");
});

it("an unchanged valid RGB blur does not erase an invalid HEX edit, while a corrected channel replaces it", async () => {
  await mount();
  await fill("测试 HEX", "#zzzzzz");
  input("测试 R").dispatchEvent(new Event("blur"));
  await flush();
  expect(input("测试 HEX").value).toBe("#zzzzzz");
  await fill("测试 R", "256");
  expect(input("测试 G").getAttribute("aria-invalid")).toBe("false");
  expect(input("测试 B").getAttribute("aria-invalid")).toBe("false");
  input("测试 R").dispatchEvent(new Event("blur"));
  await flush();
  expect(input("测试 HEX").value).toBe("#FF3456");
  expect(input("测试 HEX").getAttribute("aria-invalid")).toBe("false");
});

it("late blur after disabling the owner or replacing the field color cannot apply an old correction", async () => {
  const f = await mount();
  await fill("测试 R", "999");
  const old = input("测试 R");
  f.state.disabled = true;
  await flush();
  old.dispatchEvent(new Event("blur"));
  await flush();
  expect(f.changes).not.toHaveBeenCalled();
  expect(readCustomColors("local:test")).toEqual([]);
  f.state.disabled = false;
  await flush();
  f.trigger.click();
  await flush();
  f.custom.click();
  await flush();
  await fill("测试 B", "999");
  f.state.color = "#abcdef";
  await flush();
  input("测试 B").dispatchEvent(new Event("blur"));
  escape();
  await flush();
  expect(f.state.color).toBe("#abcdef");
  expect(f.changes).not.toHaveBeenCalled();
});
