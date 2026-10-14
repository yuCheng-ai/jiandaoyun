import { expect, it } from "vitest";
import { copy, createField } from "../src/domain/form";
import { emptyWorkspace, newForm } from "../src/domain/workspace";
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

function fixture() {
  const data = emptyWorkspace();
  const form = newForm("oa", "合并明细导入");
  form.schema.fields = [
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
  form.published = {
    version: 1,
    title: form.title,
    schema: copy(form.schema),
    workflow: copy(form.workflow),
    publishedAt: "2026-10-10",
  };
  form.versions = [form.published];
  data.forms = [form];
  const request = (
    rows: ExcelValue[][],
    ids: string[],
    merges: ExcelMerge[] = [],
    options: Partial<RecordImportRequest> = {},
  ): RecordImportRequest => {
    const columns = recordImportColumns(form.published!.schema);
    return {
      mode: "create",
      definitionVersion: form.published!.version,
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

  return { data, form, request };
}
const merge = (start: number, end: number, column = 0): ExcelMerge => ({
  s: { r: start, c: column },
  e: { r: end, c: column },
});

it("reads and maps real two-row templates with hidden IDs and actual vertical/horizontal merges", async () => {
  const { form } = fixture();
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

it("requires two child schema fields and checks child ownership against the pinned version", () => {
  const { data, form, request } = fixture();
  const draft = form.published!;
  draft.schema.fields.find((f) => f.id === "items")!.children =
    draft.schema.fields.find((f) => f.id === "items")!.children.slice(0, 1);
  expect(() =>
    prepareImportRows(form, request([["一", "甲"]], ["name", "item"]), data),
  ).toThrow("至少需要两个");
  const forged = request([["一", "甲"]], ["name", "note"]);
  forged.mapping[1]!.parentId = "items";
  expect(() => prepareImportRows(form, forged, data)).toThrow("归属");
});
