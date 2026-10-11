// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApp, h, nextTick, reactive } from "vue";
import { createPinia } from "pinia";
import { createMemoryHistory, createRouter, RouterView } from "vue-router";
import RecordList from "../src/features/forms/components/RecordList.vue";
import MemberPortalView from "../src/features/forms/MemberPortalView.vue";
import { useWorkspaceStore } from "../src/stores/workspace";
import { copy, createField } from "../src/domain/form";
import { defaultAccess, newAccessGroup } from "../src/domain/access";
import {
  newForm,
  seedWorkspace,
  type FormRecord,
} from "../src/domain/workspace";
import { defaultRecordView } from "../src/domain/records";
import { downloadCsv } from "../src/services/downloadCsv";
import { downloadExcel, excelBytes, readExcel } from "../src/services/excel";
import {
  importHeaderRows,
  suggestImportMapping,
  recordImportColumns,
  prepareImportRows,
} from "../src/domain/recordImport";
import { csvText } from "../src/domain/csv";
vi.mock("../src/stores/workspace", () => ({ useWorkspaceStore: vi.fn() }));
vi.mock("../src/services/downloadCsv", () => ({ downloadCsv: vi.fn() }));
vi.mock("../src/services/excel", async (original) => ({
  ...(await original<typeof import("../src/services/excel")>()),
  downloadExcel: vi.fn(),
}));
vi.mock("../src/components/WorkspaceStorageNotice.vue", () => ({
  default: { render: () => null },
}));
const cleanups: (() => void)[] = [];
let form: FormRecord, store: ReturnType<typeof makeStore>;
function makeStore() {
  const source = {
    data: seedWorkspace(),
    writePending: false,
    storageError: "",
    notify: vi.fn(),
    saveRecordView: vi.fn(),
    refreshForRead: vi.fn(() => true),
  };
  return reactive(source) as unknown as typeof source;
}
beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div>';
  localStorage.clear();
  sessionStorage.clear();
  vi.mocked(downloadCsv).mockReset();
  vi.mocked(downloadExcel).mockReset();
  store = makeStore();
  vi.mocked(useWorkspaceStore).mockReturnValue(store as any);
  form = newForm("oa", "CSV验收");
  form.id = "csv-form";
  form.schema.fields = [
    createField("text", { id: "name", label: "名称" }),
    createField("number", { id: "amount", label: "数量" }),
    createField("text", { id: "private", label: "内部备注" }),
  ];
  const first = {
    version: 1,
    title: form.title,
    schema: copy(form.schema),
    workflow: copy(form.workflow),
    publishedAt: "2026-10-01",
  };
  first.schema.fields[0] = createField("select", {
    id: "name",
    label: "名称",
    options: [{ id: "old-option", label: "旧版选择值" }],
  });
  form.published = { ...first, version: 2, schema: copy(form.schema) };
  form.versions = [first, copy(form.published)];
  store.data.forms = [form];
  store.data.entries = Array.from({ length: 25 }, (_, i) => ({
    id: `entry-${i + 1}`,
    formId: form.id,
    definitionVersion: 2,
    createdAt: `2026-10-01T01:${String(i).padStart(2, "0")}:00Z`,
    createdBy: i < 12 ? "zhang" : "wang",
    status: "submitted",
    values: { name: `订单${i + 1}`, amount: i + 1, private: `秘密${i + 1}` },
    history: [],
  }));
  store.data.entries[0]!.definitionVersion = 1;
  store.data.entries[0]!.values.name = "old-option";
  store.data.entries.push(
    {
      ...copy(store.data.entries[1]!),
      id: "draft",
      status: "draft",
      values: { name: "未提交", amount: 0, private: "草稿内容" },
    },
    {
      ...copy(store.data.entries[1]!),
      id: "removed",
      deletedAt: "2026-10-02",
      values: { name: "已删除", amount: 0, private: "回收内容" },
    },
  );
  store.data.recordViews = {
    [form.id]: {
      ...defaultRecordView(form.schema),
      fieldIds: ["name", "amount"],
      pageSize: 10,
    },
  };
  store.saveRecordView.mockImplementation(async (id, next) => {
    store.data.recordViews![id] = next;
    return true;
  });
  const view = newAccessGroup(form.schema);
  view.identities = ["zhang"];
  view.id = "read-all";
  const own = newAccessGroup(form.schema);
  own.identities = ["zhang"];
  own.actions = ["view", "export"];
  own.scope = "self";
  own.fields.private = "hidden";
  own.id = "export-own";
  store.data.formAccess = {
    [form.id]: {
      ...defaultAccess(),
      membersEnabled: true,
      groups: [view, own],
    },
  };
});
afterEach(() => {
  cleanups.splice(0).forEach((fn) => fn());
  vi.restoreAllMocks();
});
const button = (name: string) =>
  [...document.querySelectorAll("button")].find(
    (el) => el.textContent?.trim() === name,
  )!;
async function click(name: string) {
  expect(button(name), name).toBeDefined();
  button(name).click();
  await nextTick();
}
async function set(selector: string, value: string) {
  const el = document.querySelector<HTMLInputElement | HTMLSelectElement>(
    selector,
  )!;
  el.value = value;
  el.dispatchEvent(
    new Event(el.tagName === "SELECT" ? "change" : "input", { bubbles: true }),
  );
  await nextTick();
}
async function check(id: string) {
  const el = document.querySelector<HTMLInputElement>(`input[value="${id}"]`)!;
  el.checked = true;
  el.dispatchEvent(new Event("change", { bubbles: true }));
  await nextTick();
}
async function mount(member = false) {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      {
        path: "/forms/:formId",
        component: member
          ? MemberPortalView
          : { render: () => h(RecordList, { form, schema: form.schema }) },
      },
    ],
  });
  await router.push(`/forms/${form.id}`);
  const app = createApp({ render: () => h(RouterView) });
  app.use(createPinia()).use(router).mount(document.getElementById("app")!);
  cleanups.push(() => app.unmount());
  await nextTick();
}
const exported = () =>
  vi.mocked(downloadCsv).mock.calls.at(-1)![1] as string[][];
async function exportCsv(label = "导出") {
  if (!document.querySelector('dialog[aria-label="导出数据"]'))
    await click(label);
  await set('[aria-label="导出文件格式"]', "csv");
  const dialog = document.querySelector('dialog[aria-label="导出数据"]')!;
  Array.from(dialog.querySelectorAll<HTMLButtonElement>("button"))
    .find((item) => item.textContent?.trim() === "导出")!
    .click();
  await nextTick();
}

it("exports all filtered rows across pages, keeps order and current columns, then intersects selection", async () => {
  await mount();
  await set('[aria-label="筛选数据状态"]', "submitted");
  await exportCsv();
  expect(document.querySelectorAll("tbody tr")).toHaveLength(10);
  expect(exported()).toHaveLength(26);
  expect(exported()[0]).toEqual([
    "数据标题",
    "创建时间",
    "状态",
    "名称",
    "数量",
  ]);
  expect(exported()[1]!.at(-1)).toBe("25");
  expect(exported().at(-1)!.at(-2)).toBe("旧版选择值");
  expect(JSON.stringify(exported())).not.toContain("秘密");
  await check("entry-25");
  await click("下一页");
  await check("entry-15");
  await exportCsv("导出所选");
  expect(
    exported()
      .slice(1)
      .map((row) => row.at(-1)),
  ).toEqual(["25", "15"]);
  await set('[aria-label="搜索提交数据"]', "订单2");
  expect(button("导出所选")).toBeUndefined();
  await exportCsv();
  expect(exported()).toHaveLength(8);
  expect(
    exported()
      .slice(1)
      .map((row) => row.at(-2)),
  ).toEqual([
    "订单25",
    "订单24",
    "订单23",
    "订单22",
    "订单21",
    "订单20",
    "订单2",
  ]);
});

it("applies structured filters and distinguishes draft, active and recycled records", async () => {
  await mount();
  await click("筛选");
  await click("添加筛选条件");
  await set('[aria-label="条件1来源字段"]', "amount");
  await set('[aria-label="条件1运算符"]', "greater");
  await set('[aria-label="条件1固定值"]', "23");
  await exportCsv();
  expect(
    exported()
      .slice(1)
      .map((row) => row.at(-1)),
  ).toEqual(["25", "24"]);
  await click("清除筛选条件");
  await set('[aria-label="筛选数据状态"]', "draft");
  await exportCsv();
  expect(exported()).toHaveLength(2);
  expect(exported()[1]![3]).toBe("未提交");
  await set('[aria-label="筛选数据状态"]', "all");
  await click("回收站");
  await exportCsv();
  expect(exported()).toHaveLength(2);
  expect(exported()[1]![3]).toBe("已删除");
});

it("exports an Excel snapshot with record IDs and stable column IDs for reimport, using exact historical labels", async () => {
  await mount();
  await set('[aria-label="筛选数据状态"]', "submitted");
  await click("导出");
  expect(
    document.querySelector<HTMLSelectElement>('[aria-label="导出文件格式"]')
      ?.value,
  ).toBe("xlsx");
  const checkbox = Array.from(
    document.querySelectorAll<HTMLLabelElement>("dialog label"),
  )
    .find((label) => label.textContent?.includes("同时导出 data_id"))!
    .querySelector<HTMLInputElement>("input")!;
  checkbox.checked = true;
  checkbox.dispatchEvent(new Event("change", { bubbles: true }));
  await nextTick();
  store.data.entries.find((e) => e.id === "entry-25")!.values.amount = 99;
  const dialog = document.querySelector('dialog[aria-label="导出数据"]')!;
  Array.from(dialog.querySelectorAll<HTMLButtonElement>("button"))
    .find((b) => b.textContent?.trim() === "导出")!
    .click();
  await vi.waitFor(() => expect(downloadExcel).toHaveBeenCalledTimes(1));
  const [filename, rows, ids] = vi.mocked(downloadExcel).mock.calls[0]!;
  expect(filename).toBe("CSV验收-筛选结果.xlsx");
  expect(ids).toEqual(["data_id", "", "", "", "name", "amount"]);
  expect(rows).toHaveLength(26);
  expect(rows[1]![0]).toBe("entry-25");
  expect(rows[1]!.at(-1)).toBe(25);
  expect(rows.at(-1)!.at(-2)).toBe("旧版选择值");
  expect(JSON.stringify(rows)).not.toContain("秘密");
});

it("preserves selected export scope after a download error and retries", async () => {
  await mount();
  await check("entry-25");
  vi.mocked(downloadCsv).mockImplementationOnce(() => {
    throw Error("download unavailable");
  });
  await exportCsv("导出所选");
  expect(document.querySelector('[role="alert"]')?.textContent).toContain(
    "选择已保留",
  );
  expect(
    document.querySelector<HTMLInputElement>('input[value="entry-25"]')!
      .checked,
  ).toBe(true);
  await exportCsv("导出所选");
  expect(exported()).toHaveLength(2);
  expect(exported()[1]!.at(-1)).toBe("25");
  expect(document.querySelector('[role="alert"]')).toBeNull();
});
it("exports relation record titles rather than display-field codes and reimports actual Excel bytes to the same targets", async () => {
  const source = newForm("oa", "客户信息");
  source.id = "clients";
  source.schema.fields = [
    createField("text", { id: "clientName", label: "客户名称" }),
    createField("text", { id: "clientCode", label: "客户编号" }),
  ];
  source.published = {
    version: 1,
    title: source.title,
    schema: copy(source.schema),
    workflow: copy(source.workflow),
    publishedAt: "2026-10-01",
  };
  source.versions = [copy(source.published)];
  store.data.forms.push(source);
  const relation = createField("relation", {
    id: "customer",
    label: "关联客户",
    referenceFormId: source.id,
    referenceFieldId: "clientCode",
  });
  form.schema.fields.push(relation);
  form.published!.schema = copy(form.schema);
  form.versions.forEach((v) => v.schema.fields.push(copy(relation)));
  store.data.recordViews![form.id]!.fieldIds = ["name", "customer"];
  store.data.entries = store.data.entries.slice(0, 2);
  store.data.entries[0]!.values.customer = "client-a";
  store.data.entries[1]!.values.customer = "client-b";
  for (const [id, name, code] of [
    ["client-a", "甲公司", "A"],
    ["client-b", "乙公司", "B"],
  ])
    store.data.entries.push({
      ...copy(store.data.entries[0]!),
      id: id!,
      formId: source.id,
      definitionVersion: 1,
      values: { clientName: name, clientCode: code },
    });
  await mount();
  await click("导出");
  const dialog = document.querySelector('dialog[aria-label="导出数据"]')!;
  Array.from(dialog.querySelectorAll<HTMLButtonElement>("button"))
    .find((b) => b.textContent?.trim() === "导出")!
    .click();
  await vi.waitFor(() => expect(downloadExcel).toHaveBeenCalledTimes(1));
  const [, rows, ids, merges] = vi.mocked(downloadExcel).mock.calls[0]!;
  expect(rows.slice(1).map((row) => row.at(-1))).toEqual(["乙公司", "甲公司"]);
  const [sheet] = await readExcel(
    await excelBytes(rows, ids, merges),
    "关联.xlsx",
  );
  const columns = recordImportColumns(form.published!.schema);
  const mapping = suggestImportMapping(
    sheet!,
    1,
    form.published!.schema,
  ).flatMap((id, column) => {
    const field = columns.find((c) => c.field.id === id);
    return field
      ? [
          {
            column,
            fieldId: id,
            type: field.field.type,
            ...(field.field.type === "relation"
              ? { matchFieldId: "clientName" }
              : {}),
          },
        ]
      : [];
  });
  const result = prepareImportRows(
    form,
    {
      mode: "create",
      definitionVersion: 2,
      rows: sheet!.rows.slice(2),
      firstRow: 3,
      mapping,
      validate: false,
      triggerWorkflow: false,
      targets: [],
    },
    store.data,
  );
  expect(result.map((row) => row.values?.customer)).toEqual([
    "client-b",
    "client-a",
  ]);
});
it("exports merged details from exact historical fields and reimports multiple subforms and numeric zero", async () => {
  const details = createField("subform", {
    id: "items",
    label: "订单明细",
    children: [
      createField("text", { id: "item", label: "商品" }),
      createField("number", { id: "qty", label: "数量" }),
    ],
  });
  const notes = createField("subform", {
    id: "notes",
    label: "备注明细",
    children: [
      createField("text", { id: "note", label: "说明" }),
      createField("select", {
        id: "tag",
        label: "类别",
        options: [{ id: "a", label: "新版甲" }],
      }),
    ],
  });
  form.schema.fields.push(details, notes);
  form.published!.schema = copy(form.schema);
  form.versions[1]!.schema = copy(form.schema);
  form.versions[0]!.schema.fields.push(copy(details), copy(notes));
  form.versions[0]!.schema.fields.find(
    (f) => f.id === "notes",
  )!.children[1]!.options[0]!.label = "原版甲";
  store.data.recordViews![form.id]!.fieldIds = ["name", "items", "notes"];
  store.data.entries = [copy(store.data.entries[0]!)];
  store.data.entries[0]!.values.items = [
    { item: "甲", qty: 0 },
    { item: "乙", qty: 2 },
  ];
  store.data.entries[0]!.values.notes = [{ note: "说明一", tag: "a" }];
  await mount();
  await click("导出");
  const dialog = document.querySelector('dialog[aria-label="导出数据"]')!;
  Array.from(dialog.querySelectorAll<HTMLButtonElement>("button"))
    .find((b) => b.textContent?.trim() === "导出")!
    .click();
  await vi.waitFor(() => expect(downloadExcel).toHaveBeenCalledTimes(1));
  const [, rows, ids, merges] = vi.mocked(downloadExcel).mock.calls[0]!;
  const [sheet] = await readExcel(
    await excelBytes(rows, ids, merges),
    "明细.xlsx",
  );
  expect(importHeaderRows(sheet!, 1)).toBe(2);
  expect(sheet!.merges).toContainEqual({
    s: { r: 3, c: 0 },
    e: { r: 4, c: 0 },
  });
  expect(rows[2]!.at(-1)).toBe("原版甲");
  const columns = recordImportColumns(form.published!.schema);
  const mapping = suggestImportMapping(
    sheet!,
    1,
    form.published!.schema,
  ).flatMap((id, column) => {
    const field = columns.find((c) => c.field.id === id);
    return field
      ? [
          {
            column,
            fieldId: id,
            type: field.field.type,
            parentId: field.parent?.id,
          },
        ]
      : [];
  });
  // Exact historical choice labels are preserved by export, so an old label cannot be silently mapped to a renamed current choice.
  const source = copy(form);
  source.published!.schema.fields.find(
    (f) => f.id === "notes",
  )!.children[1]!.options[0]!.label = "原版甲";
  const result = prepareImportRows(
    source,
    {
      mode: "create",
      definitionVersion: 2,
      rows: sheet!.rows.slice(3),
      firstRow: 4,
      mapping,
      validate: false,
      triggerWorkflow: false,
      targets: [],
      merges: sheet!
        .merges!.filter((m) => m.s.r >= 3)
        .map((m) => ({
          s: { ...m.s, r: m.s.r - 3 },
          e: { ...m.e, r: m.e.r - 3 },
        })),
    },
    store.data,
  );
  expect(result).toHaveLength(1);
  expect(result[0]!.values?.items).toEqual([
    { item: "甲", qty: 0 },
    { item: "乙", qty: 2 },
  ]);
  expect(result[0]!.values?.notes).toEqual([{ note: "说明一", tag: "a" }]);
});

it("does not borrow all-record or hidden-field visibility from a separate non-export group", async () => {
  for (const version of store.data.forms[0]!.versions) {
    version.extensions = {
      ...form.extensions!,
      collaboration: {
        titleMode: "custom",
        titleParts: [{ id: "title-private", kind: "field", value: "private" }],
        inlineEdit: false,
      },
    };
  }
  await mount(true);
  expect(document.querySelectorAll("tbody tr")).toHaveLength(20);
  expect(document.body.textContent).toContain("秘密");
  await exportCsv("导出当前结果");
  expect(exported()).toHaveLength(13);
  expect(exported()[0]).toEqual(["数据标题", "名称", "数量"]);
  expect(JSON.stringify(exported())).not.toMatch(
    /秘密|内部备注|草稿内容|回收内容|订单13/,
  );
  expect(exported()[1]![1]).toBe("旧版选择值");
  const group = [...document.querySelectorAll("select")].find((el) =>
    [...el.options].some((option) => option.value === "read-all"),
  )!;
  group.value = "read-all";
  group.dispatchEvent(new Event("change", { bubbles: true }));
  await nextTick();
  expect(button("导出当前结果")).toBeUndefined();
});

it("intersects search with export permission at click time, and hides download after revocation", async () => {
  await mount(true);
  await set('[aria-label="搜索有权限的数据"]', "订单1");
  await exportCsv("导出当前结果");
  expect(
    exported()
      .slice(1)
      .map((row) => row[1]),
  ).toEqual(["订单10", "订单11", "订单12"]);
  vi.mocked(downloadCsv).mockImplementationOnce(() => {
    throw Error("blocked");
  });
  await exportCsv("导出当前结果");
  expect(document.body.textContent).toContain("当前筛选和导出设置已保留");
  await exportCsv("导出当前结果");
  expect(exported()).toHaveLength(4);
  store.data.formAccess![form.id]!.groups[1]!.actions = ["view"];
  await nextTick();
  expect(button("导出当前结果")).toBeUndefined();
});

it("serializes Chinese, embedded quotes and multiline cells without allowing prefixed formulas", () => {
  const text = csvText([
    ["名称", "说明"],
    ['中文,"名称"', "第一行\n第二行"],
    [" =1+1", "\t@SUM(1,2)"],
    ["\r\n-1", "普通文字"],
  ]);
  expect(text).toBe(
    '\uFEFF"名称","说明"\r\n"中文,""名称""","第一行\n第二行"\r\n"\' =1+1","\'\t@SUM(1,2)"\r\n"\'\r\n-1","普通文字"',
  );
});

async function exportMemberExcel(ids = false) {
  await click("导出当前结果");
  const dialog = document.querySelector('dialog[aria-label="导出数据"]')!;
  if (ids) {
    const checkbox = dialog.querySelector<HTMLInputElement>(
      'input[type="checkbox"]',
    )!;
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event("change", { bubbles: true }));
    await nextTick();
  }
  await click("导出");
  await vi.waitFor(() => expect(downloadExcel).toHaveBeenCalled());
  const [, rows, fields, merges] = vi.mocked(downloadExcel).mock.calls.at(-1)!;
  return (
    await readExcel(await excelBytes(rows, fields, merges), "成员导出.xlsx")
  )[0]!;
}

it("exports member Excel bytes with IDs, exact historical labels and only export-scoped rows/fields", async () => {
  await mount(true);
  const sheet = await exportMemberExcel(true);
  expect(sheet.fieldIds).toEqual(["data_id", "", "name", "amount"]);
  expect(sheet.rows[1]).toEqual(["data_id", "数据标题", "名称", "数量"]);
  expect(sheet.rows).toHaveLength(14);
  expect(sheet.rows[2]![0]).toBe("entry-1");
  expect(sheet.rows[2]![2]).toBe("旧版选择值");
  expect(JSON.stringify(sheet)).not.toMatch(
    /秘密|内部备注|草稿内容|回收内容|订单13/,
  );
  expect(
    suggestImportMapping(sheet, sheet.headerRow, form.published!.schema),
  ).toEqual(["data_id", "", "name", "amount"]);
});

it("exports only granted subform columns, keeping merged rows and numeric zero", async () => {
  const items = createField("subform", {
    id: "items",
    label: "明细",
    children: [
      createField("text", { id: "product", label: "产品" }),
      createField("number", { id: "qty", label: "件数" }),
      createField("number", { id: "cost", label: "内部成本" }),
    ],
  });
  form.schema.fields.push(items);
  for (const definition of [form.published!, ...form.versions])
    definition.schema.fields.push(copy(items));
  const groups = store.data.formAccess![form.id]!.groups;
  groups[0]!.fields = {
    ...groups[0]!.fields,
    items: "read",
    product: "read",
    qty: "read",
    cost: "read",
  };
  groups[1]!.fields = {
    ...groups[1]!.fields,
    items: "read",
    product: "read",
    qty: "read",
    cost: "hidden",
  };
  for (const entry of store.data.entries)
    entry.values.items = [
      { product: "甲", qty: 0, cost: 901 },
      { product: "乙", qty: 2, cost: 902 },
    ];
  await mount(true);
  const sheet = await exportMemberExcel(true);
  expect(sheet.fieldIds).toEqual([
    "data_id",
    "",
    "name",
    "amount",
    "product",
    "qty",
  ]);
  expect(sheet.rows[1]).toEqual([
    "data_id",
    "数据标题",
    "名称",
    "数量",
    "明细",
    null,
  ]);
  expect(sheet.rows[2]!.slice(4)).toEqual(["产品", "件数"]);
  expect(sheet.rows[3]!.slice(-2)).toEqual(["甲", 0]);
  expect(sheet.rows[4]![0]).toBeNull();
  expect(sheet.rows[4]!.slice(-2)).toEqual(["乙", 2]);
  expect(sheet.rows).toHaveLength(27);
  expect(sheet.merges).toContainEqual({ s: { r: 3, c: 0 }, e: { r: 4, c: 0 } });
  expect(JSON.stringify(sheet)).not.toMatch(/内部成本|901|902|秘密/);
});

it("rechecks committed permission changes before the Excel download and keeps settings for retry", async () => {
  let finish!: () => void;
  vi.mocked(downloadExcel).mockImplementationOnce(
    async (_name, _rows, _ids, _merges, ready) => {
      await new Promise<void>((resolve) => (finish = resolve));
      ready?.();
    },
  );
  await mount(true);
  await click("导出当前结果");
  await click("导出");
  await vi.waitFor(() => expect(finish).toBeDefined());
  expect(
    document
      .querySelector('dialog[aria-label="导出数据"]')!
      .getAttribute("aria-busy"),
  ).toBe("true");
  expect(document.querySelector(".dialog-footer[inert]")).not.toBeNull();
  expect(document.body.textContent).toContain("正在生成导出文件");
  button("导出").click();
  expect(downloadExcel).toHaveBeenCalledTimes(1);
  store.refreshForRead.mockImplementation(() => {
    store.data.formAccess![form.id]!.groups[1]!.fields.amount = "hidden";
    return true;
  });
  finish();
  await vi.waitFor(() =>
    expect(document.body.textContent).toContain("导出设置已保留"),
  );
  expect(
    document.querySelector('dialog[aria-label="导出数据"]'),
  ).not.toBeNull();
  expect(button("导出").disabled).toBe(false);
  await click("取消");
  expect(document.querySelector('dialog[aria-label="导出数据"]')).toBeNull();
  expect(document.body.textContent).not.toContain("导出设置已保留");
});

it("refuses member download when the latest committed data cannot be read", async () => {
  await mount(true);
  store.refreshForRead.mockReturnValue(false);
  await click("导出当前结果");
  await click("导出");
  expect(document.body.textContent).toContain("暂时无法读取最新数据");
  expect(downloadExcel).not.toHaveBeenCalled();
  expect(downloadCsv).not.toHaveBeenCalled();
  store.refreshForRead.mockReturnValue(true);
  await click("导出");
  await vi.waitFor(() => expect(downloadExcel).toHaveBeenCalledTimes(1));
});

it("does not stop a member download for unrelated record changes outside the export grant", async () => {
  let finish!: () => void;
  vi.mocked(downloadExcel).mockImplementationOnce(
    async (_name, _rows, _ids, _merges, ready) => {
      await new Promise<void>((resolve) => (finish = resolve));
      ready?.();
    },
  );
  await mount(true);
  await click("导出当前结果");
  await click("导出");
  await vi.waitFor(() => expect(finish).toBeDefined());
  store.refreshForRead.mockImplementation(() => {
    store.data.entries.find((entry) => entry.id === "entry-25")!.values.amount =
      888;
    return true;
  });
  finish();
  await vi.waitFor(() =>
    expect(document.querySelector('dialog[aria-label="导出数据"]')).toBeNull(),
  );
  expect(store.notify).toHaveBeenCalledWith("已请求导出 12 条有导出权限的记录");
});

it("keeps attachment labels and reverse relation counts when administrator Excel export uses the shared builder", async () => {
  const file = createField("file", { id: "attachments", label: "附件" });
  const reverse = createField("relationTable", {
    id: "reverse",
    label: "关联订单",
    referenceFormId: "child-form",
  });
  reverse.reference.mode = "reverse";
  reverse.reference.reverseFieldId = "link";
  form.schema.fields.push(file, reverse);
  for (const definition of [form.published!, ...form.versions])
    definition.schema.fields.push(copy(file), copy(reverse));
  const child = newForm("oa", "关联订单");
  child.id = "child-form";
  child.schema.fields = [
    createField("relation", { id: "link", referenceFormId: form.id }),
  ];
  child.published = {
    version: 1,
    title: child.title,
    schema: copy(child.schema),
    workflow: copy(child.workflow),
    publishedAt: "2026-10-10",
  };
  child.versions = [copy(child.published)];
  store.data.forms.push(child);
  store.data.entries[0]!.values.attachments = [
    { name: "合同.txt" },
    { name: "说明.pdf" },
  ];
  store.data.entries.push(
    ...["related-1", "related-2"].map((id) => ({
      id,
      formId: child.id,
      definitionVersion: 1,
      createdAt: "2026-10-10",
      status: "submitted" as const,
      values: { link: "entry-1" },
      history: [],
    })),
  );
  store.data.recordViews![form.id]!.fieldIds = [
    "name",
    "attachments",
    "reverse",
  ];
  await mount();
  await set('[aria-label="筛选数据状态"]', "submitted");
  await click("导出");
  const exportDialog = document.querySelector('dialog[aria-label="导出数据"]')!;
  [...exportDialog.querySelectorAll<HTMLButtonElement>("button")]
    .find((b) => b.textContent?.trim() === "导出")!
    .click();
  await nextTick();
  await vi.waitFor(() => expect(downloadExcel).toHaveBeenCalledTimes(1));
  const [, rows, fields, merges] = vi.mocked(downloadExcel).mock.calls[0]!;
  const sheet = (
    await readExcel(await excelBytes(rows, fields, merges), "管理员导出.xlsx")
  )[0]!;
  expect(sheet.rows[1]!.slice(-2)).toEqual(["附件", "关联订单"]);
  expect(sheet.rows.at(-1)!.slice(-2)).toEqual([
    "合同.txt、说明.pdf",
    "2 条关联",
  ]);
});
