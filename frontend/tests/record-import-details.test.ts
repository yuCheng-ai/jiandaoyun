import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createPinia } from "pinia";
import { copy, createField } from "../src/domain/form";
import { useWorkspaceStore } from "../src/stores/workspace";
import {
  WORKSPACE_KEY,
  LocalWorkspaceRepository,
} from "../src/repositories/workspaceRepository";
import { seedWorkspace } from "../src/domain/workspace";
import {
  recordImportColumns,
  suggestImportMapping,
  importExcelLayout,
  importHeaderRows,
  importHeaders,
  prepareImportRows,
  type RecordImportRequest,
} from "../src/domain/recordImport";
import {
  excelBytes,
  readExcel,
  type ExcelMerge,
  type ExcelValue,
} from "../src/services/excel";
let memory: Map<string, string>,
  failSave = false;
beforeEach(() => {
  failSave = false;
  memory = new Map([[WORKSPACE_KEY, JSON.stringify(seedWorkspace())]]);
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => memory.get(k) ?? null,
    setItem: (k: string, v: string) => {
      if (failSave) throw Error("quota");
      memory.set(k, v);
    },
  });
});
afterEach(() => vi.unstubAllGlobals());
async function fixture() {
  const store = useWorkspaceStore(createPinia());
  const form = (await store.createForm("oa", "合并明细导入", "form"))!;
  const draft = store.openForm(form.id)!;
  draft.schema.fields = [
    createField("text", { id: "name", label: "名称", unique: true }),
    createField("serial", {
      id: "serial",
      serial: {
        digits: 3,
        fixed: true,
        initial: 1,
        reset: "none",
        rules: [{ id: "counter", type: "counter" }],
      },
    }),
    createField("subform", {
      id: "items",
      label: "明细",
      children: [
        createField("text", {
          id: "item",
          label: "名称",
          required: true,
          maxLength: 2,
        }),
        createField("number", { id: "qty", label: "数量", min: 0, max: 10 }),
      ],
    }),
    createField("subform", {
      id: "notes",
      label: "备注明细",
      children: [
        createField("text", { id: "note", label: "名称" }),
        createField("select", {
          id: "tag",
          label: "类别",
          options: [
            { id: "a", label: "甲" },
            { id: "b", label: "乙" },
          ],
        }),
      ],
    }),
  ];
  expect(await store.publishForm(form.id)).toBe(true);
  const live = () => store.data.forms.find((f) => f.id === form.id)!;
  const request = (
    rows: ExcelValue[][],
    ids: string[],
    merges: ExcelMerge[] = [],
    options: Partial<RecordImportRequest> = {},
  ): RecordImportRequest => {
    const columns = recordImportColumns(live().published!.schema);
    return {
      mode: "create",
      definitionVersion: live().published!.version,
      rows,
      firstRow: 4,
      validate: false,
      triggerWorkflow: false,
      targets: [],
      merges,
      mapping: ids.map((fieldId, column) =>
        fieldId === "data_id"
          ? { column, fieldId, type: "data_id" }
          : {
              column,
              fieldId,
              type: columns.find((c) => c.field.id === fieldId)!.field.type,
              ...(columns.find((c) => c.field.id === fieldId)!.parent
                ? {
                    parentId: columns.find((c) => c.field.id === fieldId)!
                      .parent!.id,
                  }
                : {}),
            },
      ),
      ...options,
    };
  };
  return { store, form: live(), live, request };
}
it("keeps physical child issue coordinates and requires whole merged groups for a retry", async () => {
  const f = await fixture();
  const input = f.request(
    [
      ["订单", "太长的名称", -1],
      [null, "乙", 99],
      ["成功", "丙", 0],
    ],
    ["name", "item", "qty"],
    [{ s: { r: 0, c: 0 }, e: { r: 1, c: 0 } }],
    { validate: true },
  );
  const imported = await f.store.importEntries(f.form.id, input);
  expect(imported).toMatchObject({ created: 1 });
  if (!imported) throw Error("import failed");
  expect(imported.rows[0]).toMatchObject({ row: 4, lastRow: 5, kind: "error" });
  expect(imported.rows[0]!.issues!.map((i) => [i.fieldId, i.row])).toEqual([
    ["item", 4],
    ["qty", 4],
    ["qty", 5],
  ]);
  expect(() =>
    prepareImportRows(f.form, { ...input, onlyRows: [1] }, f.store.data),
  ).toThrow("完整的失败数据");
  input.rows[0] = ["订单", "甲", 0];
  input.rows[1] = [null, "乙", 2];
  const retried = await f.store.importEntries(f.form.id, {
    ...input,
    onlyRows: [0],
  });
  expect(retried).toMatchObject({
    created: 1,
    rows: [{ row: 4, lastRow: 5, kind: "create" }],
  });
  expect(f.store.data.entries).toHaveLength(2);
  expect(
    f.store.data.entries.find((e) => e.values.name === "订单")!.values.items,
  ).toEqual([
    { item: "甲", qty: 0 },
    { item: "乙", qty: 2 },
  ]);
});
const merge = (start: number, end: number, column = 0): ExcelMerge => ({
  s: { r: start, c: column },
  e: { r: end, c: column },
});
it("reads and maps real two-row templates with hidden IDs and actual vertical/horizontal merges", async () => {
  const { form } = await fixture();
  const columns = recordImportColumns(form.published!.schema);
  const layout = importExcelLayout(columns);
  const bytes = await excelBytes(
    [
      ...layout.headers,
      ["主一", null, "长名称", 0, "备注", "甲"],
      [null, null, "乙", 2, null, null],
    ],
    layout.fieldIds,
    [...layout.merges, merge(2, 3), merge(2, 3, 1)],
  );
  const [sheet] = await readExcel(bytes, "明细.xlsx");
  expect(importHeaderRows(sheet!, 1)).toBe(2);
  expect(importHeaders(sheet!, 1)).toEqual([
    "名称",
    "流水号",
    "明细 · 名称",
    "明细 · 数量",
    "备注明细 · 名称",
    "备注明细 · 类别",
  ]);
  expect(suggestImportMapping(sheet!, 1, form.published!.schema)).toEqual(
    layout.fieldIds,
  );
  expect(sheet!.merges).toContainEqual(merge(3, 4));
  expect(
    suggestImportMapping(
      { ...sheet!, fieldIds: undefined },
      1,
      form.published!.schema,
    ),
  ).toEqual(["name", "serial", "item", "qty", "note", "tag"]);
});
it("creates one parent per merge and retains multiple subforms, zero, choices, empty fields and serial count", async () => {
  const { store, form, request } = await fixture();
  const result = await store.importEntries(
    form.id,
    request(
      [
        ["一", "长名称", 0, "备注", "甲"],
        [null, "乙", 2, null, null],
        ["二", "丙", 3, "说明", "乙"],
      ],
      ["name", "item", "qty", "note", "tag"],
      [merge(0, 1)],
    ),
  );
  expect(result && [result.created, result.updated]).toEqual([2, 0]);
  const saved = new LocalWorkspaceRepository().load()!;
  const one = saved.entries.find((e) => e.values.name === "一")!;
  expect(one.values.items).toEqual([
    { item: "长名称", qty: 0 },
    { item: "乙", qty: 2 },
  ]);
  expect(one.values.notes).toEqual([{ note: "备注", tag: "a" }]);
  expect(one.values.serial).toBe("001");
  expect(saved.entries.find((e) => e.values.name === "二")!.values.serial).toBe(
    "002",
  );
  expect(result && result.rows[0]!.lastRow).toBe(5);
});
it("validates all child rows as a record, reports physical Excel rows, and never commits a partial detail group", async () => {
  const { store, form, request } = await fixture();
  const invalid = await store.importEntries(
    form.id,
    request(
      [
        ["一", "甲", 1],
        [null, "超长名称", 2],
        ["二", "乙", 0],
      ],
      ["name", "item", "qty"],
      [merge(0, 1)],
      { validate: true },
    ),
  );
  expect(invalid && invalid.created).toBe(1);
  expect(invalid && invalid.rows[0]!.kind).toBe("error");
  expect(store.data.entries).toHaveLength(1);
  expect(store.data.entries[0]!.values.serial).toBe("001");
  const warning = await store.importEntries(
    form.id,
    request(
      [
        ["三", "甲", 1],
        [null, "乙", "错"],
      ],
      ["name", "item", "qty"],
      [merge(0, 1)],
    ),
  );
  expect(warning && warning.rows[0]!.warnings[0]).toContain("Excel 第 5 行");
  expect(
    store.data.entries.find((e) => e.values.name === "三")!.values.items,
  ).toEqual([
    { item: "甲", qty: 1 },
    { item: "乙", qty: null },
  ]);
});
it("ignores child updates while keeping existing rows and makes mixed empty-ID groups into one new record", async () => {
  const { store, form, request } = await fixture();
  await store.importEntries(
    form.id,
    request([["一", "甲", 1]], ["name", "item", "qty"]),
  );
  const entry = store.data.entries[0]!;
  const target = {
    id: entry.id,
    definitionVersion: entry.definitionVersion,
    values: copy(entry.values),
  };
  const result = await store.importEntries(
    form.id,
    request(
      [
        [entry.id, "改名", "替换", 9],
        [null, null, "删除原行", 4],
        [null, "二", "乙", 0],
        [null, null, "丙", 2],
      ],
      ["data_id", "name", "item", "qty"],
      [merge(0, 1), merge(0, 1, 1), merge(2, 3), merge(2, 3, 1)],
      { mode: "both", targets: [target] },
    ),
  );
  expect(result && [result.created, result.updated]).toEqual([1, 1]);
  expect(
    store.data.entries.find((e) => e.id === entry.id)!.values.items,
  ).toEqual([{ item: "甲", qty: 1 }]);
  expect(
    store.data.entries.find((e) => e.values.name === "二")!.values.items,
  ).toEqual([
    { item: "乙", qty: 0 },
    { item: "丙", qty: 2 },
  ]);
  expect(result && result.rows[0]!.warnings).toContain(
    "仅更新主表字段，原子表明细保持不变",
  );
  const conflict = await store.importEntries(
    form.id,
    request(
      [
        [entry.id, "误改", "甲", 1],
        ["different-record", null, "乙", 2],
      ],
      ["data_id", "name", "item", "qty"],
      [merge(0, 1, 1)],
      {
        mode: "both",
        targets: store.data.entries.map((e) => ({
          id: e.id,
          definitionVersion: e.definitionVersion,
          values: copy(e.values),
        })),
      },
    ),
  );
  expect(conflict && conflict.rows[0]!.message).toContain(
    "data_id 在合并行内含不同值",
  );
  expect(store.data.entries.find((e) => e.id === entry.id)!.values.name).toBe(
    "改名",
  );
});
it("rejects crossing/misaligned/child merges and conflicting main values without losing or joining data", async () => {
  const { store, form, request } = await fixture();
  const rows = [
    ["一", "甲", 1],
    [null, "乙", 2],
    ["二", "丙", 3],
  ];
  for (const merges of [
    [merge(0, 1), merge(1, 2)],
    [merge(0, 1), merge(0, 2, 2)],
    [merge(0, 1, 1)],
    [merge(0, 4)],
  ])
    expect(
      await store.importEntries(
        form.id,
        request(rows, ["name", "item", "qty"], merges),
      ),
    ).toBe(false);
  const conflict = await store.importEntries(
    form.id,
    request(
      [
        ["一", "甲", 1],
        ["二", "乙", 2],
      ],
      ["name", "item", "qty"],
      [merge(0, 1)],
    ),
  );
  expect(conflict && conflict.created).toBe(0);
  expect(conflict && conflict.rows[0]!.message).toContain("不同值");
  expect(store.data.entries).toHaveLength(0);
});
it("keeps unmerged equal parent values separate and rolls back all child data and serials on failed persistence", async () => {
  const { store, form, request } = await fixture();
  failSave = true;
  expect(
    await store.importEntries(
      form.id,
      request(
        [
          ["一", "甲", 0],
          [null, "乙", 2],
        ],
        ["name", "item", "qty"],
        [merge(0, 1)],
      ),
    ),
  ).toBe(false);
  expect(store.data.entries).toHaveLength(0);
  failSave = false;
  const result = await store.importEntries(
    form.id,
    request(
      [
        ["一", "甲", 0],
        ["一", "乙", 2],
      ],
      ["name", "item", "qty"],
      [],
      { validate: true },
    ),
  );
  expect(result && result.created).toBe(1); // checked unique main field, second record fails instead of being silently joined
  expect(store.data.entries[0]!.values.items).toEqual([{ item: "甲", qty: 0 }]);
  expect(store.data.entries[0]!.values.serial).toBe("001");
});
it("requires two child schema fields and checks child ownership against the pinned version", async () => {
  const { store, form, request, live } = await fixture();
  const draft = store.openForm(form.id)!;
  draft.schema.fields.find((f) => f.id === "items")!.children =
    draft.schema.fields.find((f) => f.id === "items")!.children.slice(0, 1);
  expect(await store.publishForm(form.id)).toBe(true);
  expect(() =>
    prepareImportRows(
      live(),
      request([["一", "甲"]], ["name", "item"]),
      store.data,
    ),
  ).toThrow("至少需要两个");
  const forged = request([["一", "甲"]], ["name", "note"]);
  forged.mapping[1]!.parentId = "items";
  expect(() => prepareImportRows(live(), forged, store.data)).toThrow("归属");
});
it("updates only main fields across child schema changes without interpreting or replacing historical details", async () => {
  const { store, form, request, live } = await fixture();
  await store.importEntries(
    form.id,
    request([["一", "甲", 0]], ["name", "item", "qty"]),
  );
  const entry = copy(store.data.entries[0]!);
  const draft = store.openForm(form.id)!;
  draft.schema.fields.find((f) => f.id === "items")!.children[0] = createField(
    "number",
    { id: "item", label: "名称" },
  );
  expect(await store.publishForm(form.id)).toBe(true);
  const result = await store.importEntries(
    form.id,
    request(
      [[entry.id, "改名", "无效数字", 99]],
      ["data_id", "name", "item", "qty"],
      [],
      {
        mode: "both",
        definitionVersion: live().published!.version,
        targets: [entry],
      },
    ),
  );
  expect(result && result.updated).toBe(1);
  expect(store.data.entries[0]!.definitionVersion).toBe(1);
  expect(store.data.entries[0]!.values).toEqual({
    ...entry.values,
    name: "改名",
  });
});
