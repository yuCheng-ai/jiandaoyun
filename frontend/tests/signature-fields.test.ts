import { seedWorkspace } from "./fixtures/workspace";
// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApp, h, nextTick, reactive, ref } from "vue";
import { createPinia } from "pinia";
import { createMemoryHistory, createRouter } from "vue-router";
import SignaturePad from "../src/features/forms/components/SignaturePad.vue";

import FieldControl from "../src/features/forms/components/FieldControl.vue";
import FormRuntime from "../src/features/forms/components/FormRuntime.vue";
import {
  createField,
  emptySchema,
  copy,
  parseSchema,
  validateValues,
} from "../src/domain/form";
import {
  buildRecordBlocks,
  defaultDetailSettings,
} from "../src/domain/presentation";


let app: ReturnType<typeof createApp> | undefined;
const image = "data:image/png;base64,c2lnbmF0dXJl";
const context = {
  clearRect: vi.fn(),
  beginPath: vi.fn(),
  moveTo: vi.fn(),
  lineTo: vi.fn(),
  stroke: vi.fn(),
  strokeStyle: "",
  lineWidth: 0,
  lineCap: "",
  lineJoin: "",
};
const flush = async () => {
  for (let i = 0; i < 8; i++) await nextTick();
};
const button = (text: string) =>
  Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
    (el) => el.textContent?.trim() === text,
  )!;
const canvas = () => document.querySelector<HTMLCanvasElement>("canvas")!;
function pointer(type: string, x = 30, y = 50, id = 1, mouseButton = 0) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, {
    pointerId: id,
    button: mouseButton,
    clientX: x,
    clientY: y,
  });
  canvas().dispatchEvent(event);
}
function write(id = 1) {
  pointer("pointerdown", 30, 50, id);
  pointer("pointermove", 70, 70, id);
  pointer("pointerup", 70, 70, id);
}
async function mount(component: Parameters<typeof createApp>[0]) {
  document.body.innerHTML = '<div id="app"></div>';
  app = createApp(component);
  app.use(createPinia());
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: "/", component: { render: () => null } }],
  });
  app.use(router);
  await router.push("/");
  app.mount("#app");
  await flush();
}
async function control(initial: unknown = "", disabled = false) {
  const value = ref(initial),
    readonly = ref(disabled),
    changes = vi.fn();
  await mount({
    render: () =>
      h(SignaturePad, {
        modelValue: value.value,
        disabled: readonly.value,
        label: "客户确认",
        "onUpdate:modelValue": (next: string) => {
          value.value = next;
          changes(next);
        },
      }),
  });
  return { value, readonly, changes };
}
async function open() {
  button("添加签名").click();
  await flush();
}
beforeEach(() => {
  for (const key of [
    "clearRect",
    "beginPath",
    "moveTo",
    "lineTo",
    "stroke",
  ] as const)
    context[key].mockClear();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    context as unknown as CanvasRenderingContext2D,
  );
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(image);
  vi.spyOn(
    HTMLCanvasElement.prototype,
    "getBoundingClientRect",
  ).mockReturnValue({
    left: 10,
    top: 20,
    width: 300,
    height: 170,
    right: 310,
    bottom: 190,
    x: 10,
    y: 20,
    toJSON: () => ({}),
  });
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(
    function (this: HTMLElement) {
      return (this.isConnected && !this.hidden
        ? [{}]
        : []) as unknown as DOMRectList;
    },
  );
  document.body.style.overflow = "auto";
});
afterEach(() => {
  app?.unmount();
  app = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
  localStorage.clear();
});

it("keeps an empty click and pointer cancellation out of the value and required validation", async () => {
  const { changes, value } = await control();
  await open();
  expect(button("确定").disabled).toBe(true);
  pointer("pointerdown");
  pointer("pointerup");
  expect(button("确定").disabled).toBe(true);
  pointer("pointerdown");
  pointer("pointermove", 90, 70);
  pointer("pointercancel");
  await flush();
  expect(button("确定").disabled).toBe(true);
  expect(changes).not.toHaveBeenCalled();
  const field = createField("signature", { id: "sig", required: true });
  const schema = emptySchema();
  schema.fields = [field];
  expect(validateValues(schema, { sig: value.value })).toMatchObject([
    { fieldId: "sig", message: "请填写手写签名" },
  ]);
});
it("only confirms completed ink once; reopening starts a new draft and cancelling retains the old image", async () => {
  const { changes, value } = await control();
  await open();
  write();
  await flush();
  expect(changes).not.toHaveBeenCalled();
  button("确定").click();
  await flush();
  expect(changes).toHaveBeenCalledExactlyOnceWith(image);
  expect(document.querySelector("dialog")).toBeNull();
  expect(document.querySelector("img")!.getAttribute("src")).toBe(image);
  button("重新签名").click();
  await flush();
  expect(button("确定").disabled).toBe(true);
  write();
  document.querySelector<HTMLButtonElement>('[aria-label="关闭"]')!.click();
  await flush();
  expect(value.value).toBe(image);
  expect(changes).toHaveBeenCalledOnce();
});
it("rewrites only the draft and does not clear the existing signature until the explicit field action", async () => {
  const { value, changes } = await control(image);
  button("重新签名").click();
  await flush();
  write();
  await flush();
  button("重写").click();
  await flush();
  expect(button("确定").disabled).toBe(true);
  expect(value.value).toBe(image);
  document.querySelector<HTMLButtonElement>('[aria-label="关闭"]')!.click();
  await flush();
  document
    .querySelector<HTMLButtonElement>('[aria-label="清除客户确认"]')!
    .click();
  await flush();
  expect(changes).toHaveBeenCalledExactlyOnceWith("");
  expect(value.value).toBe("");
});
it("ignores secondary buttons and other pointers and drops a lost capture instead of storing it", async () => {
  const { changes } = await control();
  await open();
  pointer("pointerdown", 30, 50, 1, 2);
  pointer("pointermove", 70, 70);
  pointer("pointerup");
  expect(context.stroke).not.toHaveBeenCalled();
  pointer("pointerdown", 30, 50, 1);
  pointer("pointerdown", 40, 60, 2);
  pointer("pointermove", 70, 70, 2);
  pointer("pointerup", 70, 70, 2);
  expect(context.stroke).not.toHaveBeenCalled();
  pointer("pointermove", 70, 70, 1);
  pointer("lostpointercapture", 70, 70, 1);
  await flush();
  expect(button("确定").disabled).toBe(true);
  expect(changes).not.toHaveBeenCalled();
});
it("preserves completed strokes when a later stroke is cancelled and confirms only the retained ink", async () => {
  const { changes } = await control();
  await open();
  write();
  pointer("pointerdown", 40, 60, 2);
  pointer("pointermove", 100, 80, 2);
  pointer("pointercancel", 100, 80, 2);
  await flush();
  expect(button("确定").disabled).toBe(false);
  expect(context.lineTo.mock.calls.at(-1)).toEqual([180, 150]);
  button("确定").click();
  await flush();
  expect(changes).toHaveBeenCalledExactlyOnceWith(image);
});
it("maps the rotated mobile sheet back to canvas coordinates and preserves ink on both direction changes", async () => {
  vi.stubGlobal("innerWidth", 390);
  const { changes } = await control();
  await open();
  write();
  await flush();
  document
    .querySelector<HTMLButtonElement>('[aria-label="切换横屏书写"]')!
    .click();
  await flush();
  expect(
    document.querySelector(".signature-dialog.is-landscape"),
  ).not.toBeNull();
  pointer("pointerdown", 85, 105);
  pointer("pointermove", 160, 150);
  pointer("pointerup", 160, 150);
  await flush();
  expect(context.moveTo.mock.calls.at(-1)).toEqual([450, 382.5]);
  expect(context.lineTo.mock.calls.at(-1)![0]).toBeCloseTo((900 * 130) / 170);
  expect(context.lineTo.mock.calls.at(-1)![1]).toBe(255);
  expect(changes).not.toHaveBeenCalled();
  document
    .querySelector<HTMLButtonElement>('[aria-label="切换竖屏书写"]')!
    .click();
  await flush();
  expect(button("确定").disabled).toBe(false);
  button("确定").click();
  await flush();
  expect(changes).toHaveBeenCalledExactlyOnceWith(image);
});
it("drops unfinished ink on direction changes and uses unrotated coordinates after a physical viewport resize", async () => {
  vi.stubGlobal("innerWidth", 390);
  await control();
  await open();
  pointer("pointerdown");
  pointer("pointermove", 100, 80);
  document
    .querySelector<HTMLButtonElement>('[aria-label="切换横屏书写"]')!
    .click();
  await flush();
  expect(button("确定").disabled).toBe(true);
  vi.stubGlobal("innerWidth", 844);
  write();
  await flush();
  expect(context.lineTo.mock.calls.at(-1)).toEqual([180, 150]);
});
it("keeps ink and a useful error after image serialization fails, then retries without another stroke", async () => {
  const { changes } = await control();
  await open();
  write();
  await flush();
  vi.mocked(HTMLCanvasElement.prototype.toDataURL).mockImplementationOnce(
    () => {
      throw new Error("canvas unavailable");
    },
  );
  button("确定").click();
  await flush();
  expect(document.querySelector('[role="alert"]')!.textContent).toContain(
    "签名未能保存",
  );
  expect(changes).not.toHaveBeenCalled();
  expect(button("确定").disabled).toBe(false);
  button("确定").click();
  await flush();
  expect(changes).toHaveBeenCalledExactlyOnceWith(image);
});
it("closes on a new source value or revoked editability without overwriting it", async () => {
  const { value, readonly, changes } = await control(image);
  button("重新签名").click();
  await flush();
  write();
  value.value = "data:image/jpeg;base64,bmV3";
  await flush();
  expect(document.querySelector("dialog")).toBeNull();
  expect(document.querySelector("img")!.getAttribute("src")).toBe(value.value);
  button("重新签名").click();
  await flush();
  write();
  readonly.value = true;
  await flush();
  expect(document.querySelector("dialog")).toBeNull();
  expect(button("重新签名")).toBeUndefined();
  expect(changes).not.toHaveBeenCalled();
});
it("readonly and designer controls keep images, reject drawing and never load a remote image", async () => {
  const field = reactive(createField("signature", { id: "sig" })),
    value = ref<unknown>("https://example.test/signature.png"),
    readonly = ref(true);
  const changes = vi.fn();
  await mount({
    render: () =>
      h(FieldControl, {
        field,
        modelValue: value.value,
        readonly: readonly.value,
        "onUpdate:modelValue": changes,
      }),
  });
  expect(document.querySelector("img")).toBeNull();
  expect(document.body.textContent).toContain("签名无法显示");
  expect(button("重新签名")).toBeUndefined();
  value.value = image;
  await flush();
  expect(document.querySelector("img")!.getAttribute("src")).toBe(image);
  value.value = "";
  await flush();
  expect(button("添加签名").disabled).toBe(true);
  field.editable = false;
  readonly.value = false;
  await flush();
  expect(button("添加签名").disabled).toBe(true);
  expect(changes).not.toHaveBeenCalled();
});
it("uses shared Escape dismissal, restores focus and does not carry an unfinished draft into another opening", async () => {
  const { changes } = await control();
  const opener = button("添加签名");
  opener.focus();
  await open();
  write();
  await flush();
  document.activeElement!.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    }),
  );
  await flush();
  expect(document.querySelector("dialog")).toBeNull();
  expect(document.activeElement).toBe(opener);
  expect(document.body.style.overflow).toBe("auto");
  expect(changes).not.toHaveBeenCalled();
  await open();
  expect(button("确定").disabled).toBe(true);
});

it("keeps two subform row signatures independent and never transfers cancelled strokes between controls", async () => {
  const schema = emptySchema(),
    signature = createField("signature", { id: "sig" });
  schema.fields = [
    createField("subform", {
      id: "rows",
      children: [signature],
      defaultRows: [{ sig: "" }, { sig: "" }],
    }),
  ];

  await mount({
    render: () =>
      h(FormRuntime, {
        schema,
        formId: "signature-rows",
      }),
  });
  const openers = () =>
    Array.from(document.querySelectorAll<HTMLButtonElement>(".signature-add"));
  openers()[0]!.click();
  await flush();
  write();
  await flush();
  button("确定").click();
  await flush();
  expect(document.querySelectorAll(".signature-value img")).toHaveLength(1);
  openers()[0]!.click();
  await flush();
  expect(button("确定").disabled).toBe(true);
  write();
  await flush();
  document.querySelector<HTMLButtonElement>('[aria-label="关闭"]')!.click();
  await flush();
  button("提交").click();
  await flush();
});

it("keeps confirmed signatures valid in preview and preserves schema and record/print presentation", async () => {
  const schema = emptySchema(),
    field = createField("signature", { id: "sig", required: true });
  schema.fields = [field];
  const original = copy(schema);
  await mount({
    render: () =>
      h(FormRuntime, {
        schema,
        formId: "signature-test",
      }),
  });
  button("提交").click();
  await flush();

  await open();
  write();
  await flush();
  button("确定").click();
  await flush();
  button("提交").click();
  await flush();

  expect(parseSchema(schema)).toEqual(original);
  expect(
    buildRecordBlocks(
      schema,
      { sig: image },
      defaultDetailSettings(),
      seedWorkspace(),
    )[0]!.images,
  ).toEqual([image]);
});
