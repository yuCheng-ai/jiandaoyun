import { seedWorkspace } from "./fixtures/workspace";
// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApp, h, nextTick, reactive } from "vue";
import { createPinia, setActivePinia } from "pinia";
import {
  composeFormSchema,
  separateFormSchema,
  subformSummaryFields,
  subformMobileErrors,
} from "@platform/contracts";
import {
  copy,
  createField,
  duplicateField,
  emptySchema,
  parseSchema,
  type FormValues,
  type FormField,
} from "../src/domain/form";
import { validateFieldConfiguration } from "../src/domain/fieldValidation";

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
function field(): FormField {
  return createField("subform", {
    id: "lines",
    label: "明细",
    subformMobile: { layout: "vertical", summary: "first", fieldIds: [] },
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
      }),
      createField("textarea", { id: "note", label: "说明" }),
      createField("file", { id: "attachment", label: "附件" }),
    ],
  });
}
async function mount(render: () => any) {
  const host = document.createElement("div");
  host.id = "app";
  document.body.append(host);
  const app = createApp({ render });
  app.use(pinia).mount(host);
  cleanup.push(() => app.unmount());
  await nextTick();
  return host;
}
async function fixture(acceptWrites = true) {
  const schema = reactive(emptySchema());
  schema.fields = [field()];
  const values = reactive<FormValues>({
    lines: [
      { _rowId: "A", item: "商品A", qty: 0, secret: "秘密A", note: "A说明" },
      { _rowId: "B", item: "商品B", qty: 22, secret: "秘密B", note: "B说明" },
    ],
  });
  const baseline = copy(values);
  const state = reactive({
    device: "mobile" as "mobile" | "desktop",
    readonly: false,
    disabled: false,
    attempt: 0,
    errors: [] as any[],
  });
  const writes = vi.fn((id: string, value: unknown) => {
    if (acceptWrites) values[id] = value;
  });
  const host = await mount(() =>
    h(FormFields, {
      fields: schema.fields,
      schema,
      values,
      existingRows: baseline,
      device: state.device,
      readonly: state.readonly,
      disabled: state.disabled,
      errors: state.errors,
      validationAttempt: state.attempt,
      onChange: writes,
    }),
  );
  return { host, schema, field: schema.fields[0]!, values, state, writes };
}
const rows = (v: FormValues) => v.lines as FormValues[];
function control<T extends HTMLElement = HTMLButtonElement>(
  label: string,
  root: ParentNode = document,
) {
  const item = root.querySelector<T>(`[aria-label="${label}"]`);
  expect(item, label).not.toBeNull();
  return item!;
}
async function click(label: string, root: ParentNode = document) {
  control(label, root).click();
  await nextTick();
}
async function textButton(text: string, root: ParentNode = document) {
  const btn = [...root.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.textContent?.trim() === text,
  );
  expect(btn, text).toBeTruthy();
  btn!.click();
  await nextTick();
}
it("preserves optional mobile presentation and page-only metadata, validates shape, and remaps copied summaries", () => {
  const schema = emptySchema();
  schema.fields = [field()];
  schema.fields[0]!.subformMobile = {
    layout: "vertical",
    summary: "custom",
    fieldIds: ["note", "qty"],
  };
  expect(parseSchema(schema).fields[0]!.subformMobile).toEqual(
    schema.fields[0]!.subformMobile,
  );
  const split = separateFormSchema(schema);
  expect(split.model.fields[0]).not.toHaveProperty("subformMobile");
  expect(
    composeFormSchema(split.model, split.page).fields[0]!.subformMobile,
  ).toEqual(schema.fields[0]!.subformMobile);
  const cloned = duplicateField(schema.fields[0]!);
  expect(cloned.subformMobile!.fieldIds).toEqual([
    cloned.children[3]!.id,
    cloned.children[1]!.id,
  ]);
  delete schema.fields[0]!.subformMobile;
  expect(parseSchema(schema).fields[0]).not.toHaveProperty("subformMobile");
  for (const invalid of [
    true,
    [],
    { layout: "bad", summary: "first", fieldIds: [] },
    { layout: "vertical", summary: "bad", fieldIds: [] },
    { layout: "vertical", summary: "first", fieldIds: ["A", "B", "C", "D"] },
    { layout: "vertical", summary: "first", fieldIds: ["A", "A"] },
    { layout: "vertical", summary: "first", fieldIds: [3] },
    { layout: "vertical", summary: "first", fieldIds: [], extra: 1 },
  ]) {
    (schema.fields[0] as any).subformMobile = invalid;
    expect(() => parseSchema(schema)).toThrow(/简报/);
  }
  schema.fields = [
    createField("text", {
      subformMobile: { layout: "table", summary: "first", fieldIds: [] },
    }),
  ];
  expect(() => parseSchema(schema)).toThrow(/简报/);
});
it("keeps the original first-three range and custom order without leaking hidden or unsupported values", () => {
  const f = field();
  expect(subformSummaryFields(f).map((c) => c.id)).toEqual(["item", "qty"]);
  f.children[0]!.masked = true;
  expect(subformSummaryFields(f).map((c) => c.id)).toEqual(["qty"]);
  f.subformMobile = {
    layout: "vertical",
    summary: "custom",
    fieldIds: ["note", "qty", "secret"],
  };
  expect(subformSummaryFields(f).map((c) => c.id)).toEqual(["note", "qty"]);
  f.subformMobile.fieldIds = ["attachment"];
  expect(subformMobileErrors(f, true)).not.toEqual([]);
  expect(subformSummaryFields(f)).toEqual([]);
});
it("preserves an unfinished reference for correction but blocks publication and rejects another subform's column", () => {
  const schema = emptySchema();
  schema.fields = [field()];
  const f = schema.fields[0]!;
  f.subformMobile = {
    layout: "vertical",
    summary: "custom",
    fieldIds: ["missing"],
  };
  expect(parseSchema(schema).fields[0]!.subformMobile!.fieldIds).toEqual([
    "missing",
  ]);
  expect(
    validateFieldConfiguration(schema, seedWorkspace()).some((e) =>
      e.includes("简报字段"),
    ),
  ).toBe(true);
  f.subformMobile.fieldIds = ["qty"];
  expect(
    validateFieldConfiguration(schema, seedWorkspace()).some((e) =>
      e.includes("简报字段"),
    ),
  ).toBe(false);
});
it("renders permission-safe collapsed summaries, expands in place and preserves row IDs and readonly columns", async () => {
  const { host, values, writes } = await fixture();
  expect(host.querySelector(".subform-scroll")).toBeNull();
  expect(host.querySelectorAll(".subform-mobile-row")).toHaveLength(2);
  expect(host.querySelector(".subform-mobile-summary")!.textContent).toContain(
    "商品A",
  );
  expect(host.textContent).not.toContain("秘密A");
  expect(host.querySelector(".subform-mobile-summary")!.textContent).toContain(
    "0",
  );
  expect(host.textContent).not.toContain("A说明");
  await click("展开明细第1行");
  const body = host.querySelector(".subform-mobile-body")!;
  expect(body.textContent).not.toContain("内部备注");
  const input = control<HTMLInputElement>("商品", body);
  input.value = "商品A修改";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await nextTick();
  expect(rows(values)[0]).toMatchObject({
    _rowId: "A",
    item: "商品A修改",
    qty: 0,
    secret: "秘密A",
  });
  expect(control<HTMLInputElement>("数量", body).disabled).toBe(true);
  expect(writes).toHaveBeenCalledTimes(1);
  await click("收起明细第1行");
  expect(host.textContent).toContain("商品A修改");
  expect(rows(values)).toHaveLength(2);
});
it("tracks expansion by stable identity when rows reorder or another row is removed", async () => {
  const { host, values } = await fixture();
  await click("展开明细第2行");
  rows(values).unshift({ _rowId: "new", item: "新行" });
  await nextTick();
  expect(host.querySelectorAll(".subform-mobile-body")).toHaveLength(1);
  expect(
    control<HTMLInputElement>(
      "商品",
      host.querySelector(".subform-mobile-body")!,
    ).value,
  ).toBe("商品B");
  rows(values).splice(0, 2);
  await nextTick();
  expect(
    control<HTMLInputElement>(
      "商品",
      host.querySelector(".subform-mobile-body")!,
    ).value,
  ).toBe("商品B");
  expect(host.textContent).not.toContain("秘密B");
});
it("reveals invalid rows on submit, supports expand all and collapse all without writes", async () => {
  const { host, state, writes } = await fixture();
  state.errors = [
    { fieldId: "item", path: "lines.1.item", message: "请输入商品" },
  ];
  state.attempt++;
  await nextTick();
  expect(host.querySelectorAll(".subform-mobile-body")).toHaveLength(1);
  expect(host.textContent).toContain("请输入商品");
  await textButton("全部展开", host);
  expect(host.querySelectorAll(".subform-mobile-body")).toHaveLength(2);
  await textButton("全部收起", host);
  expect(host.querySelector(".subform-mobile-body")).toBeNull();
  expect(writes).not.toHaveBeenCalled();
});
it("opens added rows for direct filling, observes the 200 cap, and hides write controls in readonly mode", async () => {
  const { host, values, field: f, state } = await fixture();
  await textButton("添加记录", host);
  expect(rows(values)).toHaveLength(3);
  expect(host.querySelectorAll(".subform-mobile-body")).toHaveLength(1);
  expect(rows(values)[2]!.qty).toBe(7);
  f.subformPermissions = {
    add: false,
    insert: false,
    editExisting: false,
    deleteExisting: false,
  };
  await nextTick();
  expect(host.textContent).not.toContain("添加记录");
  expect(host.querySelector('[aria-label="删除明细第1行"]')).toBeNull();
  expect(host.querySelector('[aria-label="删除明细第2行"]')).toBeNull();
  expect(host.querySelector('[aria-label="删除明细第3行"]')).not.toBeNull();
  state.readonly = true;
  await nextTick();
  await click("展开明细第1行");
  expect(
    control<HTMLInputElement>(
      "商品",
      host.querySelector(".subform-mobile-body")!,
    ).disabled,
  ).toBe(true);
  state.readonly = false;
  f.subformPermissions = {
    add: true,
    insert: true,
    editExisting: true,
    deleteExisting: true,
  };
  values.lines = Array.from({ length: 200 }, (_, i) => ({
    _rowId: `cap-${i}`,
    item: `商品${i}`,
  }));
  await nextTick();
  expect(control<HTMLButtonElement>("新增明细记录").disabled).toBe(true);
});
it("keeps desktop and omitted historical mobile layout as tables, and opens horizontal mobile additions in the existing detail window", async () => {
  const { host, field: f, state, values } = await fixture();
  state.device = "desktop";
  await nextTick();
  expect(host.querySelector(".subform-scroll")).not.toBeNull();
  expect(host.querySelector(".subform-mobile-rows")).toBeNull();
  delete f.subformMobile;
  state.device = "mobile";
  await nextTick();
  expect(host.querySelector(".subform-scroll")).not.toBeNull();
  await textButton("添加明细", host);
  expect(rows(values)).toHaveLength(3);
  expect(document.querySelector('dialog[aria-label="明细"]')).not.toBeNull();
});
it.each(["table", "vertical"] as const)(
  "does not open or expand a rejected %s mobile row",
  async (layout) => {
    const { host, field: f, values, writes } = await fixture(false);
    f.subformMobile!.layout = layout;
    await nextTick();
    await textButton(layout === "table" ? "添加明细" : "添加记录", host);
    expect(writes).toHaveBeenCalledTimes(1);
    expect(rows(values)).toHaveLength(2);
    expect(host.querySelector(".subform-mobile-body")).toBeNull();
    expect(document.querySelector('dialog[aria-label="明细"]')).toBeNull();
  },
);
