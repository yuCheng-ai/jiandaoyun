// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApp, h, nextTick, reactive } from "vue";
import { createPinia, setActivePinia } from "pinia";
import {
  identifySubformRows,
  subformRowId,
  newSubformPermissions,
} from "@platform/contracts";
import {
  copy,
  createField,
  emptySchema,
  type FormValues,
} from "../src/domain/form";
import FormFields from "../src/features/forms/components/FormFields.vue";

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
});
async function fixture() {
  const schema = reactive(emptySchema());
  schema.fields = [
    createField("subform", {
      id: "lines",
      label: "明细",
      children: [
        createField("text", { id: "item", label: "商品" }),
        createField("number", {
          id: "qty",
          label: "数量",
          editable: false,
          defaultValue: 7,
        }),
        createField("text", {
          id: "secret",
          label: "内部备注",
          visible: false,
          editable: false,
          defaultValue: "内部默认",
        }),
      ],
    }),
  ];
  const field = schema.fields[0]!;
  const baseline = identifySubformRows(schema.fields, {
    lines: [
      { item: "A", qty: 11, secret: "A秘密" },
      { item: "B", qty: 22, secret: "B秘密" },
    ],
  });
  const values = reactive(copy(baseline));
  const writes = vi.fn((id: string, value: unknown) => {
    values[id] = value;
  });
  const state = reactive({ readonly: false, disabled: false });
  const host = document.createElement("div");
  host.id = "app";
  document.body.append(host);
  const app = createApp({
    render: () =>
      h(FormFields, {
        fields: schema.fields,
        schema,
        values,
        existingRows: baseline,
        readonly: state.readonly,
        disabled: state.disabled,
        onChange: writes,
      }),
  });
  app.use(pinia).mount(host);
  cleanup.push(() => app.unmount());
  await nextTick();
  return { host, schema, field, values, baseline, writes, state };
}
function control<T extends HTMLElement = HTMLButtonElement>(
  label: string,
  root: ParentNode = document,
) {
  const element = root.querySelector<T>(`[aria-label="${label}"]`);
  expect(element, label).not.toBeNull();
  return element!;
}
async function click(label: string, root: ParentNode = document) {
  control(label, root).click();
  await nextTick();
}
async function check(label: string, checked = true) {
  const input = control<HTMLInputElement>(label);
  input.checked = checked;
  input.dispatchEvent(new Event("change", { bubbles: true }));
  await nextTick();
}
async function button(text: string, root: ParentNode = document) {
  const item = Array.from(
    root.querySelectorAll<HTMLButtonElement>("button"),
  ).find((item) => item.textContent?.trim() === text);
  expect(item, text).toBeTruthy();
  item!.click();
  await nextTick();
}
function rows(values: FormValues) {
  return values.lines as FormValues[];
}
function detail() {
  return document.querySelector<HTMLDialogElement>('[aria-label="明细"]')!;
}

it("selects only deletable manual rows; cancel is inert and batch deletion retains protected rows and hidden values", async () => {
  const { field, values, baseline, writes } = await fixture();
  field.subformPermissions = {
    ...newSubformPermissions(),
    deleteExisting: false,
  };
  rows(values).push(
    { _rowId: "manual-zero", item: "C", qty: 0, secret: "C秘密" },
    { _rowId: "manual-other", item: "D", qty: 7 },
  );
  await nextTick();
  await click("批量删除明细");
  expect(control<HTMLInputElement>("选择明细第1行").disabled).toBe(true);
  expect(control<HTMLInputElement>("选择明细第2行").disabled).toBe(true);
  await check("全选可删除的明细");
  expect(control<HTMLInputElement>("选择明细第3行").checked).toBe(true);
  await button("取消操作");
  expect(rows(values)).toHaveLength(4);
  expect(writes).not.toHaveBeenCalled();
  await click("批量删除明细");
  await check("全选可删除的明细");
  await button("删除选中");
  expect(writes).toHaveBeenCalledTimes(1);
  expect(values).toEqual(baseline);
  expect(document.querySelector('[aria-label="选择明细第1行"]')).toBeNull();
});

it("tracks selections by row identity when another row is inserted before them", async () => {
  const { values, baseline } = await fixture();
  await click("批量删除明细");
  await check("选择明细第2行");
  rows(values).unshift({ _rowId: "inserted", item: "NEW", qty: 0 });
  await nextTick();
  expect(control<HTMLInputElement>("选择明细第2行").checked).toBe(false);
  expect(control<HTMLInputElement>("选择明细第3行").checked).toBe(true);
  await button("删除选中");
  expect(rows(values).map((row) => row.item)).toEqual(["NEW", "A"]);
  expect(rows(values)[1]).toEqual(rows(baseline)[0]);
});

it("rechecks delete permission after selection and does not write a partially allowed deletion", async () => {
  const { field, values, baseline, writes } = await fixture();
  await click("批量删除明细");
  await check("全选可删除的明细");
  field.subformPermissions!.deleteExisting = false;
  await nextTick();
  expect(control<HTMLInputElement>("选择明细第1行").checked).toBe(false);
  expect(control<HTMLInputElement>("选择明细第1行").disabled).toBe(true);
  await button("删除选中");
  expect(writes).not.toHaveBeenCalled();
  expect(values).toEqual(baseline);
});

it("edits in the expanded row with shared formulas, hides protected fields, and retains identity through navigation", async () => {
  const { field, values } = await fixture();
  field.children[1]!.editable = true;
  field.children.push(
    createField("calculated", {
      id: "total",
      label: "合计",
      expression: "{{qty}}*2",
    }),
  );
  await nextTick();
  await click("展开明细第1行");
  expect(detail()).toBeTruthy();
  expect(detail().getAttribute("aria-modal")).toBeNull();
  expect(document.getElementById("app")!.inert).not.toBe(true);
  expect(detail().textContent).not.toContain("内部备注");
  const id = rows(values)[0]!._rowId;
  const quantity = control<HTMLInputElement>("数量", detail());
  quantity.value = "3";
  quantity.dispatchEvent(new Event("input", { bubbles: true }));
  await nextTick();
  expect(rows(values)[0]).toMatchObject({
    qty: 3,
    total: 6,
    secret: "A秘密",
    _rowId: id,
  });
  await click("下一条明细");
  expect(control<HTMLInputElement>("商品", detail()).value).toBe("B");
  await click("上一条明细");
  expect(control<HTMLInputElement>("数量", detail()).value).toBe("3");
  await button("完成", detail());
  expect(detail()).toBeNull();
  expect(rows(values)[0]!._rowId).toBe(id);
});

it("keeps the expanded row attached to its ID across a reorder and closes when it disappears", async () => {
  const { values } = await fixture();
  await click("展开明细第2行");
  rows(values).reverse();
  await nextTick();
  expect(control<HTMLInputElement>("商品", detail()).value).toBe("B");
  expect(detail().textContent).toContain("1/2");
  values.lines = [rows(values)[1]];
  await nextTick();
  expect(detail()).toBeNull();
});

it("creates and copies through the same add grant with fresh IDs and readonly defaults", async () => {
  const { field, values } = await fixture();
  await click("展开明细第1行");
  await button("复制", detail());
  // The async add waits for the parent value update before selecting the new ID.
  await nextTick();
  await nextTick();
  expect(rows(values)).toHaveLength(3);
  expect(rows(values)[2]).toMatchObject({
    item: "A",
    qty: 7,
    secret: "内部默认",
  });
  expect(
    new Set(rows(values).map((row, i) => subformRowId("lines", row, i))).size,
  ).toBe(3);
  expect(detail().textContent).toContain("3/3");
  field.subformPermissions!.add = false;
  await nextTick();
  expect(
    Array.from(detail().querySelectorAll("button")).some((button) =>
      ["新增", "复制"].includes(button.textContent!.trim()),
    ),
  ).toBe(false);
  expect(rows(values)).toHaveLength(3);
});

it("preserves current input on Escape, restores focus, and clamps revoked readonly access without a new save step", async () => {
  const { field, values, writes } = await fixture();
  control("展开明细第1行").focus();
  await click("展开明细第1行");
  field.subformPermissions!.editExisting = false;
  await nextTick();
  const item = control<HTMLInputElement>("商品", detail());
  expect(item.disabled).toBe(true);
  item.value = "forged";
  item.dispatchEvent(new Event("input", { bubbles: true }));
  await nextTick();
  expect(rows(values)[0]!.item).toBe("A");
  expect(writes).not.toHaveBeenCalled();
  document.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
  );
  await nextTick();
  expect(detail()).toBeNull();
  expect(document.activeElement).toBe(control("展开明细第1行"));
});

it("makes readonly expanded rows viewable and applies the 200 row cap to both creation controls", async () => {
  const { values, state } = await fixture();
  for (let i = 2; i < 200; i++)
    rows(values).push({ _rowId: `cap-${i}`, item: `ROW-${i}`, qty: 0 });
  await nextTick();
  await click("展开明细第1行");
  for (const text of ["新增", "复制"]) {
    const button = Array.from(
      detail().querySelectorAll<HTMLButtonElement>("button"),
    ).find((button) => button.textContent!.trim() === text)!;
    expect(button.disabled).toBe(true);
    button.click();
  }
  expect(rows(values)).toHaveLength(200);
  state.readonly = true;
  await nextTick();
  expect(
    control<HTMLInputElement>("商品", detail()).disabled ||
      control<HTMLInputElement>("商品", detail()).readOnly,
  ).toBe(true);
  await button("完成", detail());
  expect(document.querySelector('[aria-label="批量删除明细"]')).toBeNull();
  await click("展开明细第1行");
  expect(detail().textContent).toContain("明细");
});

it("does not confuse disabled readonly viewing with a pending save, and keeps browsing and closing available", async () => {
  const { state, writes } = await fixture();
  state.readonly = true;
  state.disabled = true;
  await nextTick();
  await click("展开明细第1行");
  expect(detail().textContent).not.toContain("正在保存");
  expect(control<HTMLButtonElement>("关闭", detail()).disabled).toBe(false);
  expect(control<HTMLButtonElement>("下一条明细", detail()).disabled).toBe(
    false,
  );
  await click("下一条明细");
  expect(control<HTMLInputElement>("商品", detail()).value).toBe("B");
  await click("放大明细窗口");
  expect(detail().classList.contains("is-maximized")).toBe(true);
  await click("关闭", detail());
  expect(detail()).toBeNull();
  expect(writes).not.toHaveBeenCalled();
});
