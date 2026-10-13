// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApp, h, nextTick, reactive } from "vue";
import { createPinia, setActivePinia } from "pinia";
import {
  composeFormSchema,
  separateFormSchema,
  subformFixedColumnIds,
} from "@platform/contracts";
import {
  copy,
  createField,
  emptySchema,
  parseSchema,
  type FormValues,
} from "../src/domain/form";
import FormFields from "../src/features/forms/components/FormFields.vue";

import FieldControl from "../src/features/forms/components/FieldControl.vue";

let pinia = createPinia();
const cleanup: (() => void)[] = [];
beforeEach(() => {
  localStorage.clear();
  pinia = createPinia();
  setActivePinia(pinia);
});
afterEach(() => {
  cleanup.splice(0).forEach((fn) => fn());
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function field() {
  return createField("subform", {
    id: "lines",
    label: "明细",
    subformQuickFill: true,
    subformFixedColumns: { desktop: 3, mobile: 1 },
    children: [
      createField("text", { id: "item", label: "商品", subformWidth: "half" }),
      createField("number", {
        id: "qty",
        label: "数量",
        editable: false,
        subformWidth: "half",
      }),
      createField("textarea", { id: "note", label: "说明" }),
      createField("image", { id: "picture", label: "图片" }),
      createField("text", { id: "tail", label: "末列" }),
    ],
  });
}
async function mount(render: () => any) {
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp({ render });
  app.use(pinia).mount(host);
  cleanup.push(() => app.unmount());
  await nextTick();
  return host;
}
function byLabel<T extends HTMLElement = HTMLElement>(
  host: ParentNode,
  label: string,
) {
  const node = host.querySelector<T>(`[aria-label="${label}"]`);
  expect(node, label).not.toBeNull();
  return node!;
}
async function fixture() {
  const schema = reactive(emptySchema());
  schema.fields = [field()];
  const values = reactive<FormValues>({
    lines: [
      {
        _rowId: "stable",
        item: "商品A",
        qty: 0,
        note: "说明",
        picture: [],
        tail: "末列值",
      },
    ],
  });
  const state = reactive({
    device: "desktop" as "desktop" | "mobile",
    readonly: false,
  });
  const writes = vi.fn((id: string, value: unknown) => {
    values[id] = value;
  });
  const host = await mount(() =>
    h(FormFields, {
      fields: schema.fields,
      schema,
      values,
      device: state.device,
      readonly: state.readonly,
      onChange: writes,
    }),
  );
  return { host, schema, field: schema.fields[0]!, values, state, writes };
}
it("preserves display configuration and historical omission through reading and page projection", () => {
  const schema = emptySchema();
  schema.fields = [field()];
  expect(parseSchema(schema).fields[0]!.subformFixedColumns).toEqual({
    desktop: 3,
    mobile: 1,
  });
  const split = separateFormSchema(schema);
  expect(
    composeFormSchema(split.model, split.page).fields[0]!.subformFixedColumns,
  ).toEqual({ desktop: 3, mobile: 1 });
  expect(split.model.fields[0]).not.toHaveProperty("subformFixedColumns");
  delete schema.fields[0]!.subformFixedColumns;
  expect(parseSchema(schema).fields[0]).not.toHaveProperty(
    "subformFixedColumns",
  );
  for (const invalid of [
    false,
    [],
    { desktop: 1 },
    { desktop: -1, mobile: 0 },
    { desktop: 1.2, mobile: 0 },
    { desktop: 301, mobile: 0 },
    { desktop: 1, mobile: 0, extra: true },
  ]) {
    (schema.fields[0] as any).subformFixedColumns = invalid;
    expect(() => parseSchema(schema)).toThrow(/固定列/);
  }
  schema.fields = [
    createField("text", { subformFixedColumns: { desktop: 1, mobile: 0 } }),
  ];
  expect(() => parseSchema(schema)).toThrow(/固定列/);
});
it("selects the original prefix and never lends removed columns to later fields", () => {
  const f = field();
  f.children[0]!.visible = false;
  expect([...subformFixedColumnIds(f)]).toEqual(["item", "qty", "note"]);
  expect([...subformFixedColumnIds(f, true)]).toEqual(["item"]);
  f.children.reverse();
  expect([...subformFixedColumnIds(f)]).toEqual(["tail", "picture", "note"]);
  f.subformFixedColumns = { desktop: 100, mobile: 0 };
  expect(subformFixedColumnIds(f).size).toBe(5);
});

it("uses column widths for desktop offsets and current visible fields without writing values", async () => {
  const { host, field: f, values, writes, state } = await fixture();
  const before = copy(values);
  const cell = (label: string) =>
    byLabel(host, `明细 第1行 ${label}`).closest("td")!;
  expect(cell("商品").style.left).toBe("45px");
  expect(cell("数量").style.left).toBe("145px");
  expect(cell("说明").style.left).toBe("245px");
  expect(cell("末列").classList.contains("subform-fixed-column")).toBe(false);
  f.children[0]!.visible = false;
  await nextTick();
  expect(host.textContent).not.toContain("商品A");
  expect(cell("数量").style.left).toBe("45px");
  expect(cell("说明").style.left).toBe("145px");
  expect(cell("图片").classList.contains("subform-fixed-column")).toBe(false);
  state.device = "mobile";
  await nextTick();
  expect(host.querySelectorAll(".subform-fixed-column")).toHaveLength(0);
  f.children[0]!.visible = true;
  await nextTick();
  expect(cell("商品").style.left).toBe("45px");
  expect(cell("数量").classList.contains("subform-fixed-column")).toBe(false);
  f.subformFixedColumns = { desktop: 0, mobile: 0 };
  await nextTick();
  expect(host.querySelectorAll(".subform-fixed-column")).toHaveLength(0);
  expect(values).toEqual(before);
  expect(writes).not.toHaveBeenCalled();
});
it("inherits only writable supported original fixed columns in quick-fill edit and add modes", async () => {
  const { host, field: f } = await fixture();
  Array.from(host.querySelectorAll<HTMLButtonElement>("button"))
    .find((b) => b.textContent?.trim() === "快速填报")!
    .click();
  await nextTick();
  const panel = document.querySelector(".subform-quick-fill-dialog")!;
  panel.querySelectorAll<HTMLInputElement>('input[type="radio"]')[1]!.click();
  await nextTick();
  const cell = (label: string) =>
    byLabel(panel, `第1行 ${label}`).closest("td")!;
  expect(cell("商品").style.left).toBe("72px");
  expect(cell("数量").classList.contains("subform-fixed-column")).toBe(false);
  expect(cell("说明").style.left).toBe("252px");
  expect(cell("末列").classList.contains("subform-fixed-column")).toBe(false);
  panel.querySelectorAll<HTMLInputElement>('input[type="radio"]')[0]!.click();
  await nextTick();
  expect(panel.querySelector('[aria-label="第1行 数量"]')).toBeNull();
  expect(cell("说明").style.left).toBe("252px");
  f.subformFixedColumns = { desktop: 0, mobile: 0 };
  await nextTick();
  expect(panel.querySelectorAll(".subform-fixed-column")).toHaveLength(0);
});
it("retains fixed-column layout inside a tab and readonly records without opening editing", async () => {
  const schema = emptySchema();
  const f = field();
  const tabs = createField("tabs", { children: [f] });
  f.tabId = tabs.tabs[0]!.id;
  schema.fields = [tabs];
  const values = {
    lines: [{ _rowId: "saved", item: "历史商品", qty: 0, note: "历史说明" }],
  };
  const host = await mount(() =>
    h(FormFields, {
      fields: schema.fields,
      schema,
      values,
      readonly: true,
      disabled: true,
      device: "desktop",
    }),
  );
  const input = byLabel<HTMLInputElement>(host, "明细 第1行 商品");
  expect(input.disabled).toBe(true);
  expect(input.closest("td")!.style.left).toBe("45px");
  expect(host.textContent).not.toContain("快速填报");
  expect(values.lines[0]!._rowId).toBe("saved");
});
it("resizes subform text from a single line to a scrolling limit without changing ordinary textareas", async () => {
  let contentHeight = 20;
  vi.spyOn(
    HTMLTextAreaElement.prototype,
    "scrollHeight",
    "get",
  ).mockImplementation(() => contentHeight);
  const state = reactive({ value: "", auto: true, disabled: false });
  const f = createField("textarea", { id: "note", rows: 3 });
  const host = await mount(() =>
    h(FieldControl, {
      field: f,
      modelValue: state.value,
      autoTextarea: state.auto,
      disabled: state.disabled,
    }),
  );
  const input = host.querySelector("textarea")!;
  expect(input.rows).toBe(1);
  expect(input.style.height).toBe("32px");
  contentHeight = 100;
  state.value = "多行\n文本";
  await nextTick();
  expect(input.style.height).toBe("102px");
  contentHeight = 400;
  state.disabled = true;
  state.value += "\n长内容";
  await nextTick();
  expect(input.style.height).toBe("180px");
  expect(input.style.overflowY).toBe("auto");
  expect(input.disabled).toBe(true);
  contentHeight = 20;
  state.value = "";
  await nextTick();
  expect(input.style.height).toBe("32px");
  state.auto = false;
  await nextTick();
  expect(input.rows).toBe(3);
  expect(input.style.height).toBe("");
});
it("observes widths only for active automatic textareas and reuses the observer across edits", async () => {
  const observers: {
    observe: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
  }[] = [];
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe = vi.fn();
      disconnect = vi.fn();
      constructor() {
        observers.push(this);
      }
    },
  );
  const state = reactive({ value: "", auto: false });
  const host = await mount(() =>
    h(FieldControl, {
      field: createField("textarea"),
      modelValue: state.value,
      autoTextarea: state.auto,
    }),
  );
  expect(host.querySelector("textarea")).not.toBeNull();
  expect(observers).toHaveLength(0);
  state.auto = true;
  await nextTick();
  expect(observers).toHaveLength(1);
  expect(observers[0]!.observe).toHaveBeenCalledTimes(1);
  state.value = "一次修改";
  await nextTick();
  state.value = "再次修改";
  await nextTick();
  expect(observers).toHaveLength(1);
  state.auto = false;
  await nextTick();
  expect(observers[0]!.disconnect).toHaveBeenCalledTimes(1);
});
