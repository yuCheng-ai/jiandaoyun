// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApp, h, nextTick, reactive } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { createMemoryHistory, createRouter } from "vue-router";
import {
  emptyDateRange,
  identifySubformRows,
  type FrontendEvent,
  type FrontendFieldChange,
} from "@platform/contracts";
import {
  copy,
  createField,
  emptySchema,
  parseSchema,
  type FormValues,
} from "../src/domain/form";
import { newForm, seedWorkspace } from "../src/domain/workspace";
import {
  parseSheetText,
  prepareSubformFill,
  sheetText,
  subformFillColumns,
  subformFillText,
} from "../src/domain/subformQuickFill";
import FormFields from "../src/features/forms/components/FormFields.vue";
import FormRuntime from "../src/features/forms/components/FormRuntime.vue";

let pinia = createPinia();
const cleanup: (() => void)[] = [];
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  pinia = createPinia();
  setActivePinia(pinia);
});
afterEach(() => {
  cleanup.splice(0).forEach((fn) => fn());
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});
function fixture() {
  const schema = reactive(emptySchema());
  schema.settings.cacheDraft = false;
  schema.fields = [
    createField("subform", {
      id: "lines",
      label: "明细",
      subformQuickFill: true,
      children: [
        createField("text", { id: "item", label: "商品" }),
        createField("number", {
          id: "qty",
          label: "数量",
          editable: false,
          defaultValue: 7,
        }),
        createField("text", { id: "note", label: "说明" }),
        createField("text", {
          id: "secret",
          label: "内部",
          visible: false,
          editable: false,
          defaultValue: "内部默认",
        }),
      ],
    }),
  ];
  const field = schema.fields[0]!;
  const values = reactive(
    identifySubformRows(schema.fields, {
      lines: [{ item: "A", qty: 0, note: "旧说明", secret: "原值" }],
    }),
  );
  return { schema, field, values, data: seedWorkspace() };
}
async function mount(runtime = false, external = false, reject = false) {
  const f = fixture(),
    writes = vi.fn(
      (
        id: string,
        value: unknown,
        _source?: FrontendFieldChange | FrontendFieldChange[],
        acknowledge?: (error?: string) => void,
      ) => {
        if (reject) {
          acknowledge?.("原明细已变化，请重新打开记录");
          return;
        }
        f.values[id] = value;
      },
    );
  const host = document.createElement("div");
  host.id = "app";
  document.body.append(host);
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: "/", component: { render: () => null } }],
  });
  await router.push("/");
  const app = createApp({
    render: () =>
      runtime
        ? h(FormRuntime, {
            schema: f.schema,
            formId: "quick-test",
            initialValues: f.values,
            onChange: (values: FormValues) => Object.assign(f.values, values),
          })
        : h(FormFields, {
            fields: f.schema.fields,
            schema: f.schema,
            values: f.values,
            external,
            onChange: writes,
          }),
  });
  app.use(pinia).use(router).mount(host);
  cleanup.push(() => app.unmount());
  await nextTick();
  return { ...f, writes, host };
}
function get<T extends HTMLElement = HTMLTextAreaElement>(label: string) {
  const item = document.querySelector<T>(`[aria-label="${label}"]`);
  expect(item, label).not.toBeNull();
  return item!;
}
async function button(text: string) {
  const item = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find((b) => b.textContent?.trim() === text);
  expect(item, text).toBeTruthy();
  item!.click();
  await nextTick();
  await nextTick();
}
async function paste(label: string, text: string) {
  const cell = get(label);
  cell.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: { getData: () => text },
  });
  cell.dispatchEvent(event);
  await nextTick();
}
async function editMode() {
  const radio = Array.from(
    document.querySelectorAll<HTMLInputElement>('input[type="radio"]'),
  ).find(
    (input) => input.parentElement?.textContent?.trim() === "编辑已有记录",
  )!;
  radio.checked = true;
  radio.dispatchEvent(new Event("change", { bubbles: true }));
  await nextTick();
}
async function value(label: string, text: string) {
  const cell = get(label);
  cell.value = text;
  cell.dispatchEvent(new Event("input", { bubbles: true }));
  await nextTick();
}

it("roundtrips quoted Excel tabs, line breaks, quotes and zero without an extra trailing row", () => {
  const rows = [
    ["a\tb", "line1\nline2", '"quoted"', "0"],
    ["", "尾行"],
  ];
  expect(parseSheetText(sheetText(rows) + "\r\n")).toEqual(rows);
});
it("persists only a boolean subform setting without opting historical definitions in", () => {
  const { schema, field } = fixture();
  expect(parseSchema(copy(schema)).fields[0]!.subformQuickFill).toBe(true);
  delete field.subformQuickFill;
  expect(parseSchema(copy(schema)).fields[0]!.subformQuickFill).toBeUndefined();
  (field as any).subformQuickFill = "true";
  expect(() => parseSchema(copy(schema))).toThrow("快速填报配置无效");
  schema.fields = [createField("text", { subformQuickFill: true })];
  expect(() => parseSchema(copy(schema))).toThrow("快速填报配置无效");
});
it("keeps hidden and readonly fields out of new columns, shows readonly edit columns and excludes organization on external links", () => {
  const { schema, field } = fixture();
  field.children.push(
    createField("member", { id: "member", label: "经办人" }),
    createField("file", { id: "file" }),
  );
  expect(
    subformFillColumns(field, schema, [{}], "add").map((c) => c.key),
  ).toEqual(["item", "note", "member"]);
  expect(
    subformFillColumns(field, schema, [{}], "edit", true).map((c) => c.key),
  ).toEqual(["item", "qty", "note"]);
});
it("converts partial choices, custom/other options, scoped organizations, dates and address parts", () => {
  const { schema, field, data } = fixture();
  const department = data.organization.departments[0]!,
    employee = data.organization.employees[0]!;
  field.children = [
    createField("checkbox", {
      id: "choices",
      options: [{ id: "x", label: "甲" }],
    }),
    createField("select", {
      id: "other",
      options: [{ id: "other-id", label: "其他", other: true }],
    }),
    createField("multiselect", {
      id: "custom",
      allowCustomChoices: true,
      options: [],
    }),
    createField("members", { id: "members" }),
    createField("department", { id: "department" }),
    createField("datetime", {
      id: "date",
      format: "date",
      dateRange: { ...emptyDateRange(), weekdaysEnabled: true, weekdays: [] },
    }),
    createField("address", { id: "address", format: "detail" }),
  ];
  const columns = subformFillColumns(field, schema, [{}], "add");
  const result = prepareSubformFill({
    field,
    schema,
    root: {},
    before: [],
    mode: "add",
    columns,
    mapping: columns.map((c) => c.key),
    data,
    editable: () => true,
    grid: [
      [
        "甲,不存在",
        "新产品",
        "自填",
        `${employee.name},不存在`,
        department.name,
        "2026-10-11",
        "不存在省",
        "不存在市",
        "不存在区",
        "道路123",
      ],
    ],
  });
  expect(result.rows[0]).toMatchObject({
    choices: ["x"],
    other: { optionId: "other-id", text: "新产品" },
    custom: [{ text: "自填" }],
    members: [employee.id],
    department: department.id,
    date: "",
    address: { detail: "道路123" },
  });
  expect(result.errors.some((e) => e.message.includes("选项不匹配"))).toBe(
    true,
  );
  expect(result.errors.some((e) => e.message.includes("重名"))).toBe(true);
  expect(result.errors.some((e) => e.message.includes("日期"))).toBe(true);
  expect(result.errors.some((e) => e.message.includes("省"))).toBe(true);
});
it("stages paste, drops empty new rows, remaps columns once and applies defaults with fresh IDs", async () => {
  const { values, writes } = await mount();
  await button("快速填报");
  await paste("第1行 商品", "SYN-NEW\t说明一\n\t\nSYN-ZERO\t说明二\n");
  expect(writes).not.toHaveBeenCalled();
  expect(values.lines as FormValues[]).toHaveLength(1);
  await button("下一步");
  expect(document.querySelectorAll(".subform-fill-grid tbody tr")).toHaveLength(
    2,
  );
  await button("确定");
  const rows = values.lines as FormValues[];
  expect(writes).toHaveBeenCalledTimes(1);
  expect(rows).toHaveLength(3);
  expect(rows[0]!.qty).toBe(0);
  expect(rows[1]).toMatchObject({
    item: "SYN-NEW",
    note: "说明一",
    qty: 7,
    secret: "内部默认",
  });
  expect(new Set(rows.map((row) => row._rowId)).size).toBe(3);
  expect(writes.mock.calls[0]![2]).toEqual(
    expect.arrayContaining([
      { fieldId: "item", row: { subformId: "lines", index: 1 } },
    ]),
  );
});
it("skips readonly pasted cells without shifting columns and keeps original identities and hidden values", async () => {
  const { values } = await mount();
  const original = (values.lines as FormValues[])[0]!._rowId;
  await button("快速填报");
  await editMode();
  await paste("第1行 商品", "SYN-EDIT\t999\t新说明\n第二行\t88\t不应新增");
  expect(get("第1行 数量").value).toBe("0");
  expect(document.querySelectorAll(".subform-fill-grid tbody tr")).toHaveLength(
    1,
  );
  await button("下一步");
  await button("确定");
  expect((values.lines as FormValues[])[0]).toEqual({
    _rowId: original,
    item: "SYN-EDIT",
    qty: 0,
    note: "新说明",
    secret: "原值",
  });
});
it("supports row selection, scalar paste, undo, arrows and drag fill without touching original rows", async () => {
  const { writes } = await mount();
  await button("快速填报");
  get<HTMLButtonElement>("选择第1行").click();
  await nextTick();
  await pasteWithoutSelecting("统一");
  expect(get("第1行 商品").value).toBe("统一");
  expect(get("第1行 说明").value).toBe("统一");
  get("第1行 商品").dispatchEvent(
    new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true }),
  );
  await nextTick();
  expect(get("第1行 商品").value).toBe("");
  await paste("第1行 商品", "填充\t原说明");
  document
    .querySelector(".subform-fill-handle")!
    .dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
  get("第3行 商品").parentElement!.dispatchEvent(
    new MouseEvent("pointerenter"),
  );
  document.dispatchEvent(new MouseEvent("pointerup"));
  await nextTick();
  expect(get("第3行 商品").value).toBe("填充");
  get("第1行 商品").dispatchEvent(
    new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
  );
  await nextTick();
  expect(document.activeElement).toBe(get("第2行 商品"));
  expect(writes).not.toHaveBeenCalled();
});
async function pasteWithoutSelecting(text: string) {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: { getData: () => text },
  });
  (document.activeElement as HTMLElement).dispatchEvent(event);
  await nextTick();
}
it("requires an explicit discard after staging and remapping, and mode switching resets grid contents", async () => {
  const { writes } = await mount();
  await button("快速填报");
  await paste("第1行 商品", "取消内容");
  await button("下一步");
  get<HTMLButtonElement>("关闭").click();
  await nextTick();
  expect(
    document.querySelector('[aria-label="放弃快速填报修改？"]'),
  ).not.toBeNull();
  await button("继续编辑");
  await button("上一步");
  await editMode();
  expect(get("第1行 商品").value).toBe("A");
  await value("第1行 商品", "切换后修改");
  get<HTMLButtonElement>("关闭").click();
  await nextTick();
  await button("放弃修改");
  expect(writes).not.toHaveBeenCalled();
  expect(document.querySelector('[aria-label="快速填报"]')).toBeNull();
});
it("holds invalid values for correction then preserves matching multiple choices on continue", async () => {
  const { field, values } = await mount();
  field.children.push(
    createField("checkbox", {
      id: "choices",
      label: "分类",
      options: [{ id: "a", label: "甲" }],
    }),
  );
  await nextTick();
  await button("快速填报");
  await paste("第1行 商品", "校验\t说明\t甲,不存在");
  await button("下一步");
  await button("确定");
  expect(
    document.querySelectorAll(".subform-fill-grid td.invalid"),
  ).toHaveLength(1);
  expect(values.lines as FormValues[]).toHaveLength(1);
  await button("继续操作");
  expect((values.lines as FormValues[])[1]!.choices).toEqual(["a"]);
});
it("rejects over-capacity paste atomically and rechecks field permissions before applying", async () => {
  const { field, writes } = await mount();
  await button("快速填报");
  await paste(
    "第1行 商品",
    Array.from({ length: 200 }, (_, i) => `SYN-${i}`).join("\n"),
  );
  expect(document.body.textContent).toContain("最多添加200行");
  expect(get("第1行 商品").value).toBe("");
  await paste("第1行 商品", "可用");
  await button("下一步");
  field.children[0]!.editable = false;
  await nextTick();
  await button("确定");
  expect(document.body.textContent).toContain("明细权限或字段已变化");
  expect(writes).not.toHaveBeenCalled();
});
it("uses edit mode at 200 and never truncates historical rows", async () => {
  const { values } = await mount();
  values.lines = Array.from({ length: 205 }, (_, i) => ({
    _rowId: `old-${i}`,
    item: `旧${i}`,
    qty: i,
    note: "",
  }));
  await nextTick();
  await button("快速填报");
  expect(document.querySelectorAll(".subform-fill-grid tbody tr")).toHaveLength(
    205,
  );
  await paste("第1行 商品", "修改\t999\t说明");
  await button("下一步");
  await button("确定");
  expect(values.lines as FormValues[]).toHaveLength(205);
  expect((values.lines as FormValues[])[204]!.item).toBe("旧204");
});
it("recomputes formula and frontend events for all changed rows through FormRuntime", async () => {
  const { schema, field, values } = await mount(true);
  field.children = [
    createField("number", { id: "qty", label: "数量" }),
    createField("number", { id: "price", label: "单价", defaultValue: 2 }),
    createField("number", { id: "amount", label: "金额" }),
    createField("number", {
      id: "double",
      label: "双倍",
      defaultFormula: true,
      expression: "{{qty}}*2",
      editable: false,
    }),
  ];
  schema.settings.frontendEvents = [
    {
      id: "multiply-rows",
      name: "计算金额",
      description: "",
      enabled: true,
      trigger: "field",
      fieldIds: ["qty", "price"],
      plugin: {
        actionId: "multiply",
        inputs: {
          quantity: { source: "field", value: "qty" },
          price: { source: "field", value: "price" },
        },
        outputs: [{ outputKey: "amount", fieldId: "amount" }],
      },
    } as FrontendEvent,
  ];
  await nextTick();
  await button("快速填报");
  await paste("第1行 数量", "3\t5\n4\t2");
  await button("下一步");
  await button("确定");
  expect((values.lines as FormValues[]).slice(-2)).toEqual([
    expect.objectContaining({ qty: 3, price: 5, amount: 15, double: 6 }),
    expect.objectContaining({ qty: 4, price: 2, amount: 8, double: 8 }),
  ]);
});

it("retains staged content and the original record when the parent rejects the final mutation", async () => {
  const { values } = await mount(false, false, true);
  await button("快速填报");
  await paste("第1行 商品", "保留输入\t说明");
  await button("下一步");
  await button("确定");
  expect(document.body.textContent).toContain("原明细已变化，请重新打开记录");
  expect(get("第1行 商品").value).toBe("保留输入");
  expect(values.lines as FormValues[]).toHaveLength(1);
  expect((values.lines as FormValues[])[0]!.item).toBe("A");
});
it("requires both add and existing-row editing permissions to expose spreadsheet filling", async () => {
  const { field } = await mount();
  field.subformPermissions = {
    add: true,
    insert: true,
    editExisting: false,
    deleteExisting: false,
  };
  await nextTick();
  expect(
    Array.from(document.querySelectorAll("button")).some(
      (button) => button.textContent?.trim() === "快速填报",
    ),
  ).toBe(false);
  field.subformPermissions.editExisting = true;
  await nextTick();
  await button("快速填报");
  expect(document.querySelector('[aria-label="快速填报"]')).not.toBeNull();
});
it("remaps pasted columns by field identity and skips an unmatched column without losing original readonly values", () => {
  const { schema, field, values, data } = fixture();
  const before = values.lines as FormValues[];
  const columns = subformFillColumns(field, schema, [before[0]!], "edit");
  const options = {
    field,
    schema,
    root: values,
    before,
    mode: "edit" as const,
    columns,
    data,
    editable: (child: any) => child.editable,
  };
  const result = prepareSubformFill({
    ...options,
    mapping: ["note", "", "item"],
    grid: [["交换说明", "无效数量", "交换商品"]],
  });
  expect(result.rows[0]).toMatchObject({
    item: "交换商品",
    note: "交换说明",
    qty: 0,
    secret: "原值",
    _rowId: before[0]!._rowId,
  });
  expect(() =>
    prepareSubformFill({
      ...options,
      mapping: ["item", "", "item"],
      grid: [["A", "", "B"]],
    }),
  ).toThrow("同一字段只能匹配一列");
});

it("preserves absent historical readonly values instead of inserting empty or new default values", () => {
  const { schema, field, data } = fixture();
  const before = [{ _rowId: "legacy-row", item: "原商品", note: "" }];
  const columns = subformFillColumns(field, schema, [before[0]!], "edit");
  const result = prepareSubformFill({
    field,
    schema,
    root: {},
    before,
    mode: "edit",
    columns,
    mapping: columns.map((c) => c.key),
    data,
    editable: (child) => child.editable,
    grid: [["修改商品", "999", ""]],
  });
  expect(result.rows[0]).toEqual({
    _rowId: "legacy-row",
    item: "修改商品",
    note: "",
  });
});

it("discards a readonly source cell when matching columns with different per-row grants", () => {
  const { schema, field, data } = fixture();
  field.children.find((child) => child.id === "qty")!.editable = true;
  const before = [
    { _rowId: "inserted", item: "31", qty: 7, note: "插入说明" },
    { _rowId: "existing", item: "88", qty: 22, note: "原说明" },
  ];
  const columns = subformFillColumns(field, schema, before, "edit");
  const result = prepareSubformFill({
    field,
    schema,
    root: { lines: before },
    before,
    mode: "edit",
    columns,
    mapping: ["qty", "", "note"],
    data,
    editable: (child, row) =>
      child.id === "note" ||
      (child.id === "item" && row._rowId === "inserted") ||
      (child.id === "qty" && row._rowId === "existing"),
    grid: [
      ["31", "7", "插入新说明"],
      ["88", "22", "已有新说明"],
    ],
  });
  expect(result.errors).toEqual([]);
  expect(result.rows).toEqual([
    { ...before[0], note: "插入新说明" },
    { ...before[1], note: "已有新说明" },
  ]);
  expect(result.changes).toEqual([
    { fieldId: "note", row: { subformId: "lines", index: 0 } },
    { fieldId: "note", row: { subformId: "lines", index: 1 } },
  ]);
  expect(before[1]!.qty).toBe(22);
});

it("closes without a discard prompt when switching modes only loads saved rows", async () => {
  const { writes } = await mount();
  await button("快速填报");
  await editMode();
  expect(get("第1行 商品").value).toBe("A");
  get<HTMLButtonElement>("关闭").click();
  await nextTick();
  expect(
    document.querySelector('[aria-label="放弃快速填报修改？"]'),
  ).toBeNull();
  expect(document.querySelector('[aria-label="快速填报"]')).toBeNull();
  expect(writes).not.toHaveBeenCalled();
});

it("searches column bindings, keeps duplicate destinations unavailable and applies only the chosen field IDs", async () => {
  const { values, writes, schema } = await mount();
  const definition = copy(schema);
  await button("快速填报");
  await paste("第1行 商品", "新说明\t新商品");
  await button("下一步");
  get<HTMLElement>("第1列对应字段").click();
  await nextTick();
  const search = get<HTMLInputElement>("第1列对应字段搜索选项");
  search.value = "说明";
  search.dispatchEvent(new Event("input", { bubbles: true }));
  await nextTick();
  const duplicate =
    document.querySelector<HTMLButtonElement>('[role="option"]')!;
  expect(duplicate.textContent?.trim()).toBe("说明");
  expect(duplicate.disabled).toBe(true);
  search.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
  );
  await nextTick();
  expect(document.activeElement).toBe(get("第1列对应字段"));
  expect(get<HTMLTextAreaElement>("第1行 商品").value).toBe("新说明");
  expect(writes).not.toHaveBeenCalled();
  get<HTMLElement>("第2列对应字段").click();
  await nextTick();
  await button("不粘贴");
  expect(document.body.textContent).toContain("粘贴 1 列 / 共 2 列");
  get<HTMLElement>("第1列对应字段").click();
  await nextTick();
  const secondSearch = get<HTMLInputElement>("第1列对应字段搜索选项");
  secondSearch.value = "说明";
  secondSearch.dispatchEvent(new Event("input", { bubbles: true }));
  await nextTick();
  secondSearch.dispatchEvent(
    new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
  );
  await nextTick();
  expect(document.activeElement?.textContent?.trim()).toBe("说明");
  (document.activeElement as HTMLElement).click();
  await nextTick();
  get<HTMLElement>("第2列对应字段").click();
  await nextTick();
  await button("商品");
  await button("确定");
  expect((values.lines as FormValues[])[1]).toMatchObject({
    item: "新商品",
    note: "新说明",
    qty: 7,
  });
  expect(writes).toHaveBeenCalledOnce();
  expect(schema).toEqual(definition);
});
it("keeps readonly column matching closed and closes a search without changing staged data", async () => {
  const { values, writes } = await mount();
  await button("快速填报");
  await editMode();
  await paste("第1行 商品", "保留商品\t999\t保留说明");
  await button("下一步");
  expect(get("第2列对应字段").getAttribute("aria-disabled")).toBe("true");
  expect(document.body.textContent).toContain("粘贴 2 列 / 共 3 列");
  get<HTMLElement>("第2列对应字段").click();
  await nextTick();
  expect(
    document.querySelector('[aria-label="第2列对应字段搜索选项"]'),
  ).toBeNull();
  get<HTMLElement>("第1列对应字段").click();
  await nextTick();
  const search = get<HTMLInputElement>("第1列对应字段搜索选项");
  search.value = "不存在字段";
  search.dispatchEvent(new Event("input", { bubbles: true }));
  await nextTick();
  expect(document.body.textContent).toContain("没有匹配选项");
  search.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
  );
  await nextTick();
  expect(document.querySelector('[aria-label="快速填报"]')).not.toBeNull();
  expect(get<HTMLTextAreaElement>("第1行 商品").value).toBe("保留商品");
  expect(get<HTMLTextAreaElement>("第1行 数量").value).toBe("0");
  expect(get<HTMLTextAreaElement>("第1行 说明").value).toBe("保留说明");
  expect(writes).not.toHaveBeenCalled();
  expect((values.lines as FormValues[])[0]!.item).toBe("A");
});
for (const type of [
  "text",
  "textarea",
  "number",
  "datetime",
  "radio",
  "checkbox",
  "select",
  "multiselect",
  "member",
  "members",
  "department",
  "departments",
  "address",
] as const)
  it(`round-trips ${type} quick-fill values through the original field codec and keeps edit row identity`, () => {
    const { schema, field, data } = fixture();
    const employee = data.organization.employees[0]!,
      department = data.organization.departments[0]!;
    const child = createField(type, {
      id: "value",
      label: "测试字段",
      format:
        type === "datetime"
          ? "date"
          : type === "address"
            ? "detail"
            : undefined,
      options: [
        { id: "a", label: "甲" },
        { id: "b", label: "乙" },
      ],
    });
    field.children = [child];
    const multiple = [
      "checkbox",
      "multiselect",
      "members",
      "departments",
    ].includes(type);
    const input =
      type === "number"
        ? ["0"]
        : type === "datetime"
          ? ["2026-10-11"]
          : type === "member" || type === "members"
            ? [employee.name]
            : type === "department" || type === "departments"
              ? [department.name]
              : type === "address"
                ? ["北京市", "北京市", "海淀区", "道路8号"]
                : type === "checkbox" || type === "multiselect"
                  ? ["甲,乙"]
                  : type === "radio" || type === "select"
                    ? ["甲"]
                    : [type === "textarea" ? "第一行\n第二行" : "  商品  "];
    const expected =
      type === "number"
        ? 0
        : type === "datetime"
          ? "2026-10-11"
          : type === "member" || type === "members"
            ? multiple
              ? [employee.id]
              : employee.id
            : type === "department" || type === "departments"
              ? multiple
                ? [department.id]
                : department.id
              : type === "address"
                ? {
                    province: "北京市",
                    city: "北京市",
                    district: "海淀区",
                    detail: "道路8号",
                  }
                : type === "checkbox" || type === "multiselect"
                  ? ["a", "b"]
                  : type === "radio" || type === "select"
                    ? "a"
                    : input[0];
    const columns = subformFillColumns(field, schema, [{}], "add");
    const added = prepareSubformFill({
      field,
      schema,
      root: {},
      before: [],
      mode: "add",
      columns,
      mapping: columns.map((c) => c.key),
      data,
      editable: () => true,
      grid: [input],
    });
    expect(added.errors).toEqual([]);
    expect(added.rows[0]!.value).toEqual(expected);
    const text = columns.map((c) => subformFillText(c, added.rows[0]!, data));
    const edited = prepareSubformFill({
      field,
      schema,
      root: {},
      before: added.rows,
      mode: "edit",
      columns,
      mapping: columns.map((c) => c.key),
      data,
      editable: () => true,
      grid: [text],
    });
    expect(edited.errors).toEqual([]);
    expect(edited.rows).toEqual(added.rows);
    expect(edited.changes).toEqual([]);
  });

it("resolves row-specific choice and member sources before pasted dependent fields and rejects out-of-scope values", () => {
  const { schema, field, data } = fixture();
  const source = newForm("oa", "选项目录", "form");
  source.id = "quick-fill-source";
  source.schema.fields = [
    createField("text", { id: "name" }),
    createField("department", { id: "dept" }),
  ];
  source.published = {
    version: 1,
    title: source.title,
    schema: copy(source.schema),
    workflow: copy(source.workflow),
    publishedAt: "2026-10-11",
  };
  source.versions = [copy(source.published)];
  data.forms.push(source);
  for (const [id, name, dept] of [
    ["product-option", "产品选项", "product"],
    ["engineering-option", "研发选项", "engineering"],
  ])
    data.entries.push({
      id: id!,
      formId: source.id,
      definitionVersion: 1,
      status: "submitted",
      createdAt: "2026-10-11",
      values: { name, dept },
      history: [],
    });
  const choice = createField("select", { id: "choice", label: "选项" });
  choice.choiceSource = {
    ...choice.choiceSource,
    mode: "form",
    formId: source.id,
    labelFieldId: "name",
    filters: [
      {
        id: "filter",
        sourceFieldId: "dept",
        operator: "equals",
        source: "field",
        value: "department",
      },
    ],
  };
  const person = createField("member", { id: "person", label: "经办人" });
  person.organization.scope.mode = "fieldDepartment";
  person.organization.scope.fieldId = "department";
  field.children = [
    choice,
    person,
    createField("department", { id: "department", label: "部门" }),
  ];
  const originalSource = copy(
    data.entries.filter((e) => e.formId === source.id),
  );
  const columns = subformFillColumns(field, schema, [{}], "add");
  const options = {
    field,
    schema,
    root: {},
    before: [],
    mode: "add" as const,
    columns,
    mapping: columns.map((c) => c.key),
    data,
    editable: () => true,
  };
  const result = prepareSubformFill({
    ...options,
    grid: [
      ["产品选项", "张三", "产品部"],
      ["研发选项", "王五", "研发部"],
    ],
  });
  expect(result.errors).toEqual([]);
  expect(result.rows).toEqual([
    expect.objectContaining({
      choice: "product-option",
      person: "zhang",
      department: "product",
    }),
    expect.objectContaining({
      choice: "engineering-option",
      person: "wang",
      department: "engineering",
    }),
  ]);
  const invalid = prepareSubformFill({
    ...options,
    grid: [["研发选项", "王五", "产品部"]],
  });
  expect(invalid.errors.map((e) => e.column)).toEqual([0, 1]);
  expect(invalid.rows[0]).toMatchObject({
    choice: "",
    person: "",
    department: "product",
  });
  expect(data.entries.filter((e) => e.formId === source.id)).toEqual(
    originalSource,
  );
});
