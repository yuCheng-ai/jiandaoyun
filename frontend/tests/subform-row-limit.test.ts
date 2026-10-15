import { seedWorkspace } from "./fixtures/workspace";
// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { createApp, h, nextTick, reactive } from "vue";
import { createPinia } from "pinia";
import {
  copy,
  createField,
  emptySchema,
  parseSchema,
  validateValues,
} from "../src/domain/form";
import { applyFieldChange, runtimeDefaults } from "../src/domain/relations";
import {
  frontendValueFields,
  mapFrontendValues,
} from "../src/domain/frontendEventValues";
import { prepareImportRows } from "../src/domain/recordImport";
import { newForm } from "../src/domain/workspace";
import FormFields from "../src/features/forms/components/FormFields.vue";
import { applyLookupSelection } from "../src/domain/lookup";

const cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.splice(0).forEach((fn) => fn());
  document.body.innerHTML = "";
});
const rows = (count: number) =>
  Array.from({ length: count }, (_, i) => ({ item: `物料${i + 1}` }));
function fixture() {
  const schema = emptySchema();
  const detail = createField("subform", {
    id: "lines",
    label: "物料明细",
    children: [createField("text", { id: "item", label: "物料" })],
  });
  schema.fields = [createField("text", { id: "title" }), detail];
  return { schema, detail, data: seedWorkspace() };
}

it("counts blank and hidden rows and applies the 200-row boundary inside tabs", () => {
  const { schema, detail } = fixture();
  detail.visible = false;
  schema.fields = [createField("tabs", { children: [detail] })];
  expect(validateValues(schema, { lines: rows(200) })).toEqual([]);
  const blank = Array.from({ length: 201 }, () => ({}));
  expect(validateValues(schema, { lines: blank })).toContainEqual(
    expect.objectContaining({
      fieldId: "lines",
      message: expect.stringContaining("200"),
    }),
  );
  expect(blank).toHaveLength(201);
});

it("rejects growth atomically while keeping historical oversized rows readable and editable", () => {
  const { schema, data } = fixture();
  const before = { title: "原值", lines: rows(200) };
  expect(() =>
    applyFieldChange(schema.fields, before, "lines", rows(201), data),
  ).toThrow(/200/);
  expect(before.lines).toHaveLength(200);
  const old = { title: "原值", lines: rows(205) };
  expect(parseSchema(schema).fields).toHaveLength(2);
  expect(
    applyFieldChange(schema.fields, old, "title", "新值", data).lines,
  ).toHaveLength(205);
  expect(validateValues(schema, old, [], old)).toEqual([]);
  expect(
    validateValues(schema, { lines: rows(206) }, [], old)[0]?.message,
  ).toContain("200");
  expect(() =>
    applyFieldChange(schema.fields, old, "lines", rows(206), data),
  ).toThrow(/200/);
  expect(old.lines).toHaveLength(205);
});

it("shares the boundary with array mappings, rejecting the whole fill without changing scalar values", () => {
  const { schema, data } = fixture();
  const before = { title: "原值", lines: rows(1) },
    fields = frontendValueFields(schema);
  const fill = (count: number) =>
    mapFrontendValues(
      schema,
      before,
      data,
      fields,
      [
        { fieldId: "title", value: "回填值" },
        { fieldId: "item", value: rows(count).map((row) => row.item) },
      ],
      "replace",
    );
  expect(fill(200).lines).toHaveLength(200);
  expect(() => fill(201)).toThrow(/200/);
  expect(before).toEqual({ title: "原值", lines: rows(1) });
});

it("preserves old literal defaults without silently truncating, but blocks new oversized submission", () => {
  const { schema, detail, data } = fixture();
  detail.defaultRows = rows(201);
  const parsed = parseSchema(schema);
  const defaults = runtimeDefaults(parsed.fields, data);
  expect(defaults.lines).toHaveLength(201);
  expect(validateValues(parsed, defaults)[0]?.message).toContain("200");
  expect(detail.defaultRows).toHaveLength(201);
});

it("rejects whole-table linkage growth without changing the triggering field or original rows", () => {
  const { schema, detail, data } = fixture();
  const source = newForm("oa", "超限联动来源");
  const remote = createField("subform", {
    id: "remote",
    children: [createField("text", { id: "remoteItem" })],
  });
  source.schema.fields = [createField("text", { id: "key" }), remote];
  source.published = {
    version: 1,
    title: source.title,
    schema: copy(source.schema),
    workflow: copy(source.workflow),
    publishedAt: "2026-10-10",
  };
  source.versions = [copy(source.published)];
  data.forms.push(source);
  data.entries.push({
    id: "oversized-source",
    formId: source.id,
    definitionVersion: 1,
    createdBy: "admin",
    createdAt: "2026-10-10",
    status: "submitted",
    values: {
      key: "命中",
      remote: rows(201).map((row) => ({ remoteItem: row.item })),
    },
    history: [],
  });
  detail.defaultLink = {
    enabled: true,
    formId: source.id,
    fieldId: remote.id,
    match: "all",
    filters: [
      {
        id: "key-filter",
        sourceFieldId: "key",
        operator: "equals",
        source: "field",
        value: "title",
      },
    ],
    mappings: [{ sourceFieldId: "remoteItem", targetFieldId: "item" }],
  };
  const before = { title: "原值", lines: rows(2) };
  expect(() =>
    applyFieldChange(schema.fields, before, "title", "命中", data),
  ).toThrow(/200/);
  expect(before).toEqual({ title: "原值", lines: rows(2) });
});

it("checks multi-selection expansion against the same capacity before converting any selected record", () => {
  const { schema, detail, data } = fixture();
  const source = newForm("oa", "选数来源");
  source.schema.fields = [createField("text", { id: "remoteItem" })];
  source.published = {
    version: 1,
    title: source.title,
    schema: copy(source.schema),
    workflow: copy(source.workflow),
    publishedAt: "2026-10-10",
  };
  source.versions = [copy(source.published)];
  data.forms.push(source);
  const ids = rows(201).map((row, i) => {
    const id = `source-${i}`;
    data.entries.push({
      id,
      formId: source.id,
      definitionVersion: 1,
      createdBy: "admin",
      createdAt: "2026-10-10",
      status: "submitted",
      values: { remoteItem: row.item },
      history: [],
    });
    return id;
  });
  const lookup = createField("lookup", {
    id: "choose",
    referenceFormId: source.id,
  });
  lookup.reference.columns = ["remoteItem"];
  lookup.reference.mappings = [
    { sourceFieldId: "remoteItem", targetFieldId: "item" },
  ];
  detail.children.unshift(lookup);
  const before = { lines: [{ choose: "", item: "" }] };
  expect(
    applyLookupSelection(lookup, schema, before, data, ids.slice(0, 200), {
      subformId: "lines",
      index: 0,
    }).lines,
  ).toHaveLength(200);
  expect(() =>
    applyLookupSelection(lookup, schema, before, data, ids, {
      subformId: "lines",
      index: 0,
    }),
  ).toThrow(/200/);
  expect(before).toEqual({ lines: [{ choose: "", item: "" }] });
});

it("rejects an oversized merged Excel group even when field validation is disabled", () => {
  const { schema, detail, data } = fixture();
  detail.children.push(createField("number", { id: "qty", label: "数量" }));
  const form = newForm("oa", "行数导入验收");
  form.schema = schema;
  form.published = {
    version: 1,
    title: form.title,
    schema: copy(schema),
    workflow: copy(form.workflow),
    publishedAt: "2026-10-10",
  };
  form.versions = [copy(form.published)];
  data.forms.push(form);
  const input = (count: number) => ({
    mode: "create" as const,
    definitionVersion: 1,
    rows: rows(count).map((row, i) => [i ? null : "合并组", row.item, 1]),
    firstRow: 4,
    mapping: [
      { column: 0, fieldId: "title", type: "text" as const },
      { column: 1, fieldId: "item", type: "text" as const, parentId: "lines" },
      { column: 2, fieldId: "qty", type: "number" as const, parentId: "lines" },
    ],
    validate: false,
    triggerWorkflow: false,
    targets: [],
    merges: [{ s: { r: 0, c: 0 }, e: { r: count - 1, c: 0 } }],
  });
  expect(
    prepareImportRows(form, input(200), data)[0]?.values?.lines,
  ).toHaveLength(200);
  expect(prepareImportRows(form, input(201), data)[0]).toMatchObject({
    kind: "error",
    message: expect.stringContaining("200"),
  });
  expect(data.entries.filter((entry) => entry.formId === form.id)).toHaveLength(
    0,
  );
});

it("disables adding at capacity and enables it after a deletion through the existing runtime", async () => {
  const { schema } = fixture();
  const values = reactive({ lines: rows(200) });
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp({
    render: () =>
      h(FormFields, {
        fields: schema.fields,
        schema,
        values,
        onChange: (id: string, value: unknown) => {
          (values as any)[id] = value;
        },
      }),
  });
  app.use(createPinia()).mount(host);
  cleanups.push(() => app.unmount());
  const add = () => host.querySelector<HTMLButtonElement>(".subform-add")!;
  expect(add().disabled).toBe(true);
  add().click();
  await nextTick();
  expect(values.lines).toHaveLength(200);
  host
    .querySelector<HTMLButtonElement>('[aria-label="删除物料明细第1行"]')!
    .click();
  await nextTick();
  expect(values.lines).toHaveLength(199);
  expect(add().disabled).toBe(false);
  add().click();
  await nextTick();
  expect(values.lines).toHaveLength(200);
  expect(add().disabled).toBe(true);
});
