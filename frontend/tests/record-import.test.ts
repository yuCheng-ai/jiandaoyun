import { expect, it } from "vitest";
import { copy, createField } from "../src/domain/form";
import { emptyWorkspace, newForm } from "../src/domain/workspace";
import {
  prepareImportRows,
  type RecordImportRequest,
} from "../src/domain/recordImport";
import type { ExcelValue } from "../src/services/excel";

function setup() {
  const data = emptyWorkspace();
  const form = newForm("oa", "导入解析");
  form.schema.fields = [
    createField("text", { id: "code", label: "编号", unique: true }),
    createField("number", { id: "quantity", label: "数量", min: 0, max: 10 }),
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
    fields: string[],
    options: Partial<RecordImportRequest> = {},
  ): RecordImportRequest => ({
    mode: "create",
    definitionVersion: 1,
    rows,
    firstRow: 2,
    validate: false,
    triggerWorkflow: false,
    targets: [],
    mapping: fields.map((fieldId, column) => ({
      column,
      fieldId,
      type: form.schema.fields.find((field) => field.id === fieldId)!.type,
    })),
    ...options,
  });
  return { data, form, request };
}

it("rejects empty, repeated or invalid retry row selections", () => {
  const { data, form, request } = setup();
  for (const onlyRows of [[], [0, 0], [-1], [0.5], [2]]) {
    expect(() =>
      prepareImportRows(
        form,
        request([["C"], ["D"]], ["code"], { onlyRows }),
        data,
      ),
    ).toThrow("完整的失败数据");
  }
});

it("does not allow malformed mappings and prepares a large unique file without repeated full-record scans", () => {
  const { data, form, request } = setup();
  expect(() =>
    prepareImportRows(
      form,
      request([[0]], ["quantity"], { mode: "update" }),
      data,
    ),
  ).toThrow();
  const malformed = request([[0]], ["quantity"]);
  malformed.mapping.push({ column: 0, fieldId: "quantity", type: "number" });
  expect(() => prepareImportRows(form, malformed, data)).toThrow();
  const rows = prepareImportRows(
    form,
    request(
      Array.from({ length: 10000 }, (_, i) => ["N" + i, 0]),
      ["code", "quantity"],
      { validate: true },
    ),
    data,
  );
  expect(rows.filter((r) => r.kind === "create")).toHaveLength(10000);
}, 20000);
