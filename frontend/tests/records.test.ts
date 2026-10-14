import { it, expect } from "vitest";
import { createField, copy } from "../src/domain/form";
import {
  emptyWorkspace,
  newForm,
  type FormEntry,
} from "../src/domain/workspace";
import {
  defaultRecordView,
  filterAndSortRecords,
  parseRecordView,
} from "../src/domain/records";

function setup() {
  const data = emptyWorkspace();
  const form = newForm("oa", "记录测试");
  form.schema.fields = [
    createField("text", {
      id: "code",
      label: "编号",
      required: true,
      unique: true,
    }),
    createField("number", { id: "quantity", label: "数量", min: 0 }),
    createField("select", {
      id: "choice",
      label: "类别",
      options: [{ id: "opt", label: "办公用品" }],
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
  const a: FormEntry = {
    id: "a",
    formId: form.id,
    definitionVersion: 1,
    createdAt: "2026-10-10",
    status: "submitted",
    values: { code: "A", quantity: 2, choice: "opt" },
    history: [],
  };
  const b: FormEntry = { ...a, id: "b", values: { code: "B", quantity: 10 } };
  data.forms = [form];
  data.entries = [a, b];
  return { data, form, a, b };
}

it("searches display labels and sorts numeric values correctly, with immutable filters", () => {
  const { data, form, a, b } = setup(),
    all = [a, b],
    before = copy(all);
  const view = {
    ...defaultRecordView(form.schema),
    sortField: "quantity",
    descending: false,
  };
  expect(
    filterAndSortRecords(all, form.schema, data, {
      query: "办公用品",
      filters: [],
      view,
    }).map((e) => e.id),
  ).toEqual([a.id]);
  expect(
    filterAndSortRecords(all, form.schema, data, {
      query: "",
      filters: [],
      view,
    }).map((e) => e.id),
  ).toEqual([a.id, b.id]);
  expect(
    filterAndSortRecords(all, form.schema, data, {
      query: "",
      filters: [
        {
          id: "n",
          sourceFieldId: "quantity",
          source: "constant",
          operator: "greater",
          value: "5",
        },
      ],
      view,
    }).map((e) => e.id),
  ).toEqual([b.id]);
  expect(all).toEqual(before);
});

it("preserves old column and sort settings when adopting low row height, and rejects unknown heights", () => {
  const legacy = {
    fieldIds: ["quantity", "code"],
    pageSize: 50,
    sortField: "quantity",
    descending: false,
  };
  expect(parseRecordView(legacy)).toEqual({ ...legacy, rowHeight: "low" });
  expect(parseRecordView({ ...legacy, rowHeight: "invalid" })).toEqual({
    ...legacy,
    rowHeight: "low",
  });
  for (const rowHeight of ["low", "medium", "high", "auto"])
    expect(parseRecordView({ ...legacy, rowHeight })).toEqual({
      ...legacy,
      rowHeight,
    });
});
