import { expect, it } from "vitest";
import { copy, createField } from "../src/domain/form";
import {
  emptyWorkspace,
  newForm,
  type FormEntry,
} from "../src/domain/workspace";
import {
  importRelationFields,
  recordImportColumns,
  prepareImportRows,
  importExcelValue,
  type RecordImportRequest,
} from "../src/domain/recordImport";
import type { ExcelValue } from "../src/services/excel";

function fixture() {
  const data = emptyWorkspace();
  const source = newForm("oa", "客户信息");
  source.schema.fields = [
    createField("text", { id: "clientName", label: "客户名称" }),
    createField("text", { id: "clientCode", label: "客户编号", unique: true }),
    createField("serial", {
      id: "clientSerial",
      serial: {
        digits: 3,
        initial: 1,
        fixed: true,
        reset: "none",
        rules: [{ id: "counter", type: "counter" }],
      },
    }),
    createField("phone", { id: "clientPhone" }),
    createField("select", {
      id: "clientChoice",
      options: [
        { id: "a", label: "旧甲" },
        { id: "b", label: "乙" },
      ],
    }),
    createField("radio", {
      id: "clientRadio",
      options: [{ id: "r", label: "旧档" }],
    }),
    createField("number", { id: "forbiddenNumber" }),
    createField("subform", {
      id: "sourceItems",
      children: [
        createField("text", { id: "forbiddenChild" }),
        createField("number"),
      ],
    }),
  ];
  const original = {
    version: 1,
    title: source.title,
    schema: copy(source.schema),
    workflow: copy(source.workflow),
    publishedAt: "2026-10-10",
  };
  source.schema.fields.find(
    (field) => field.id === "clientChoice",
  )!.options[0]!.label = "新甲";
  source.schema.fields.find(
    (field) => field.id === "clientRadio",
  )!.options[0]!.label = "新档";
  source.published = { ...original, version: 2, schema: copy(source.schema) };
  source.versions = [original, source.published];
  const a: FormEntry = {
    id: "client-a",
    formId: source.id,
    definitionVersion: 1,
    createdAt: "2026-10-10",
    status: "submitted",
    values: {
      clientName: "甲公司",
      clientCode: "C-A",
      clientPhone: "13800000001",
      clientChoice: "a",
      clientRadio: "r",
    },
    history: [],
  };
  const form = newForm("oa", "联系人");
  const customer = createField("relation", {
    id: "customer",
    label: "关联客户",
    referenceFormId: source.id,
    referenceFieldId: "clientName",
  });
  customer.reference.mappings = [
    { sourceFieldId: "clientCode", targetFieldId: "filled" },
  ];
  form.schema.fields = [
    createField("text", { id: "person", label: "联系人" }),
    customer,
    createField("text", { id: "filled", defaultValue: "默认填充" }),
    createField("subform", {
      id: "items",
      label: "明细",
      children: [
        createField("relation", {
          id: "detailCustomer",
          label: "关联客户",
          referenceFormId: source.id,
        }),
        createField("number", { id: "qty", label: "数量" }),
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
  data.forms = [source, form];
  data.entries = [a];
  const request = (
    rows: ExcelValue[][],
    ids = ["person", "customer"],
    options: Partial<RecordImportRequest> = {},
    key = "clientName",
  ): RecordImportRequest => {
    const columns = recordImportColumns(form.published!.schema);
    return {
      mode: "create",
      definitionVersion: form.published!.version,
      rows,
      firstRow: 2,
      validate: false,
      triggerWorkflow: false,
      targets: [],
      mapping: ids.map((id, column) => {
        if (id === "data_id") return { column, fieldId: id, type: "data_id" };
        const field = columns.find((c) => c.field.id === id)!;
        return {
          column,
          fieldId: id,
          type: field.field.type,
          ...(field.parent ? { parentId: field.parent.id } : {}),
          ...(field.field.type === "relation" ? { matchFieldId: key } : {}),
        };
      }),
      ...options,
    };
  };

  return { data, source, form, a, request };
}

it("serializes corrected relation choices with the selected historical source key", () => {
  const f = fixture();
  const field = f.form.published!.schema.fields.find(
    (f) => f.id === "customer",
  )!;
  const record = { values: { customer: f.a.id } };
  expect(importExcelValue(field, record, f.data)).toBe("甲公司");
  expect(importExcelValue(field, record, f.data, "clientCode")).toBe("C-A");
  expect(importExcelValue(field, record, f.data, "clientChoice")).toBe("旧甲");
  expect(() =>
    importExcelValue(field, record, f.data, "forbiddenNumber"),
  ).toThrow("匹配字段不可用");
  expect(() =>
    importExcelValue(field, record, { ...f.data, entries: [] }, "clientCode"),
  ).toThrow("关联记录不可用");
});

it("uses published main scalar keys and requires an explicit key without admitting query/lookup/reverse fields", () => {
  const f = fixture();
  const relation = f.form.published!.schema.fields.find(
    (f) => f.id === "customer",
  )!;
  const sourceDraft = f.source;
  sourceDraft.schema.fields.push(createField("text", { id: "unpublished" }));
  expect(importRelationFields(relation, f.data).map((f) => f.id)).toEqual([
    "clientName",
    "clientCode",
    "clientSerial",
    "clientPhone",
    "clientChoice",
    "clientRadio",
  ]);
  for (const key of ["", "forbiddenNumber", "forbiddenChild", "unpublished"])
    expect(() =>
      prepareImportRows(
        f.form,
        f.request([["甲", "甲公司"]], undefined, {}, key),
        f.data,
      ),
    ).toThrow("主表匹配字段");
  const schema = copy(f.form.published!.schema);
  schema.fields.push(createField("lookup"), createField("query"), {
    ...copy(relation),
    id: "reverse",
    reference: { ...relation.reference, mode: "reverse" },
  });
  expect(
    recordImportColumns(schema).some(
      (c) =>
        ["lookup", "query"].includes(c.field.type) || c.field.id === "reverse",
    ),
  ).toBe(false);
});

it("does not offer unsupported child associations or accept a forged child binding", () => {
  const f = fixture();
  expect(
    recordImportColumns(f.form.published!.schema).some(
      (c) => c.field.id === "detailCustomer",
    ),
  ).toBe(false);
  const request = f.request([["联系人"]], ["person"]);
  request.mapping.push({
    column: 1,
    fieldId: "detailCustomer",
    parentId: "items",
    type: "relation",
    matchFieldId: "clientName",
  });
  expect(() => prepareImportRows(f.form, request, f.data)).toThrow("匹配字段");
});

it("exports the linked record's historical title and rejects broken, draft, archived or unknown-version targets", () => {
  const f = fixture();
  const entry = { values: { customer: f.a.id } };
  const field = f.form.published!.schema.fields.find(
    (f) => f.id === "customer",
  )!;
  f.source.schema.fields[0]!.label = "草稿标题";
  expect(importExcelValue(field, entry, f.data)).toBe("甲公司");
  const related = f.data.entries.find((e) => e.id === f.a.id)!;
  for (const change of [
    { deletedAt: "2026-10-10" },
    { status: "draft" as const },
    { definitionVersion: 999 },
  ]) {
    const data = copy(f.data);
    Object.assign(
      data.entries.find((e) => e.id === related.id)!,
      change,
    );
    expect(() => importExcelValue(field, entry, data)).toThrow(
      "关联记录不可用",
    );
  }
  const data = copy(f.data);
  data.forms.find((form) => form.id === f.source.id)!.archived = true;
  expect(() => importExcelValue(field, entry, data)).toThrow("关联记录不可用");
});
