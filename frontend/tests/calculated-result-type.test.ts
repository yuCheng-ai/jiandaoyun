import { seedWorkspace } from "./fixtures/workspace";
// @vitest-environment jsdom
// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { createApp, h, nextTick, reactive } from "vue";
import { createPinia } from "pinia";
import { createMemoryHistory, createRouter } from "vue-router";
import {
  copy,
  createField,
  duplicateField,
  emptySchema,
  parseSchema,
  resolveCalculations,
} from "../src/domain/form";
import { formulaConfigurationErrors, formulaValue } from "@platform/contracts";
import {
  linkTypesMatch,
  selectionFilterOperators,
} from "../src/domain/fieldConfig";
import {
  applyFieldChange,
  displayValue,
  matchesFilters,
} from "../src/domain/relations";
import { createLookupFields } from "../src/domain/lookup";
import { defaultRecordView, filterAndSortRecords } from "../src/domain/records";
import { fieldValueType } from "../src/domain/extensions";
import { type FormEntry } from "../src/domain/workspace";

import FieldControl from "../src/features/forms/components/FieldControl.vue";

import FormulaEditor from "../src/features/forms/components/FormulaEditor.vue";

const source = createField("text", { id: "name", label: "姓名" });
const text = createField("calculated", {
  id: "label",
  label: "展示名称",
  format: "text",
  expression: 'CONCATENATE("客户：",{{name}})',
});
const numeric = createField("calculated", {
  id: "length",
  label: "名称长度",
  expression: "LEN({{label}})",
});
const fields = [copy(numeric), copy(text), copy(source)];
let app: ReturnType<typeof createApp> | undefined;
afterEach(() => {
  app?.unmount();
  app = undefined;
  document.body.innerHTML = "";
  localStorage.clear();
  vi.restoreAllMocks();
});
async function mount(component: any, props: Record<string, unknown>) {
  const host = document.createElement("div");
  document.body.append(host);
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: "/", component: { render: () => null } }],
  });
  await router.push("/");
  await router.isReady();
  app = createApp({ render: () => h(component, props) });
  app.use(createPinia());
  app.use(router);
  app.mount(host);
  await nextTick();
  return host;
}

it("preserves text result types, stable copies and old numeric formats through the shared reader", () => {
  const schema = emptySchema();
  schema.fields = copy(fields);
  const parsed = parseSchema(schema);
  expect(parsed.fields.find((f) => f.id === text.id)?.format).toBe("text");
  const duplicated = duplicateField(text);
  expect(duplicated.format).toBe("text");
  expect(duplicated.id).not.toBe(text.id);
  for (const format of ["none", "number", "percent"])
    expect(
      parseSchema({
        ...schema,
        fields: [createField("calculated", { format })],
      }).fields[0]?.format,
    ).toBe(format);
});

it("validates and evaluates text and numeric calculated outputs without coercing the wrong type", () => {
  expect(formulaConfigurationErrors(text, fields)).toEqual([]);
  expect(formulaValue(text, fields, { name: "甲" })).toEqual({
    value: "客户：甲",
    error: "",
  });
  expect(
    formulaConfigurationErrors({ ...text, expression: "2" }, fields),
  ).toContain("公式需要返回文本");
  expect(formulaValue({ ...text, expression: "2" }, fields, {})).toMatchObject({
    error: "公式需要返回文本",
  });
  expect(
    formulaConfigurationErrors({ ...numeric, expression: '"文本"' }, fields),
  ).toContain("公式需要返回数字");
});

it("recomputes mixed result dependencies on initialization and edits and ignores forged calculated inputs", () => {
  const initial = resolveCalculations(fields, {
    name: "甲",
    label: "伪造",
    length: 999,
  });
  expect(initial).toMatchObject({ label: "客户：甲", length: 4 });
  const next = applyFieldChange(
    fields,
    initial,
    "name",
    "客户乙",
    seedWorkspace(),
  );
  expect(next).toMatchObject({ label: "客户：客户乙", length: 6 });
  const ordinary = createField("text", {
    id: "ordinary",
    defaultFormula: true,
    expression: 'CONCATENATE({{label}},"!")',
  });
  expect(
    resolveCalculations(
      [...fields, ordinary],
      { name: "甲" },
      {},
      { defaults: [ordinary.id] },
    ).ordinary,
  ).toBe("客户：甲!");
});

it("renders text calculations as readonly text and rejects synthetic input events", async () => {
  const updates: unknown[] = [];
  const host = await mount(FieldControl, {
    field: text,
    modelValue: "客户：甲",
    "onUpdate:modelValue": (value: unknown) => updates.push(value),
  });
  const input = host.querySelector("input")!;
  expect(input.value).toBe("客户：甲");
  expect(input.readOnly).toBe(true);
  expect(input.hasAttribute("inputmode")).toBe(false);
  input.value = "伪造";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await nextTick();
  expect(updates).toEqual([]);
});

it("uses calculated result types for mappings and text versus numeric filter operators", () => {
  const ordinary = createField("text");
  const number = createField("number");
  expect(linkTypesMatch(text, ordinary)).toBe(true);
  expect(linkTypesMatch(text, number)).toBe(false);
  expect(linkTypesMatch(numeric, number)).toBe(true);
  expect(linkTypesMatch(text, numeric)).toBe(false);
  expect(selectionFilterOperators(text)).toContain("contains");
  expect(selectionFilterOperators(text)).not.toContain("greater");
  expect(selectionFilterOperators(numeric)).toContain("greater");
  const condition = {
    id: "condition",
    sourceFieldId: text.id,
    operator: "equals" as const,
    source: "constant" as const,
    value: "1",
  };
  expect(
    matchesFilters([condition], { label: "01" }, {}, seedWorkspace(), "all", [
      text,
    ]),
  ).toBe(false);
});

it("creates a text receiver for a text calculation without creating a second calculation", () => {
  const data = seedWorkspace();
  const remote = data.forms[0]!;
  remote.schema.fields = [copy(text)];
  remote.published = {
    version: 1,
    title: remote.title,
    schema: copy(remote.schema),
    workflow: copy(remote.workflow),
    publishedAt: "2026-10-11T00:00:00Z",
  };
  const schema = emptySchema();
  const lookup = createField("lookup", { referenceFormId: remote.id });
  schema.fields = [lookup];
  const next = createLookupFields(schema, lookup.id, [text.id], data);
  const receiver = next.fields.find((f) => f.id !== lookup.id)!;
  expect(receiver.type).toBe("text");
  expect(receiver.format).toBe("none");
  expect(
    next.fields.find((f) => f.id === lookup.id)!.reference.mappings,
  ).toEqual([{ sourceFieldId: text.id, targetFieldId: receiver.id }]);
});

it("keeps text calculations textual in output bindings, display and record sorting", () => {
  const data = seedWorkspace();
  const form = data.forms[0]!;
  form.schema.fields = [copy(text)];
  form.published = {
    version: 1,
    title: form.title,
    schema: copy(form.schema),
    workflow: copy(form.workflow),
    publishedAt: "2026-10-11T00:00:00Z",
  };
  expect(fieldValueType(text)).toBe("text");
  expect(displayValue(text, "0007", data)).toBe("0007");
  const rows = [
    {
      id: "a",
      formId: form.id,
      values: { label: "乙" },
      status: "submitted",
      createdAt: "2026-10-11T00:00:00Z",
    },
    {
      id: "b",
      formId: form.id,
      values: { label: "甲" },
      status: "submitted",
      createdAt: "2026-10-11T00:00:00Z",
    },
  ] as unknown as FormEntry[];
  const view = {
    ...defaultRecordView(form.schema),
    sortField: text.id,
    descending: false,
  };
  const expected = [...rows].sort((a, b) =>
    String(a.values.label).localeCompare(String(b.values.label), "zh-CN", {
      numeric: true,
    }),
  );
  expect(
    filterAndSortRecords(rows, form.schema, data, {
      query: "",
      filters: [],
      view,
    }).map((r) => r.id),
  ).toEqual(expected.map((r) => r.id));
});

it("preserves an open formula editor when its target result type changes", async () => {
  const field = reactive(
    createField("calculated", { id: "open", expression: "" }),
  );
  const schema = emptySchema();
  schema.fields = [field];
  const updates: unknown[] = [];
  const host = await mount(FormulaEditor, {
    field,
    schema,
    onUpdate: (patch: unknown) => updates.push(patch),
  });
  host.querySelector<HTMLButtonElement>("button")!.click();
  await nextTick();
  const editor = document.querySelector<HTMLElement>(
    '[contenteditable="true"]',
  )!;
  editor.textContent = '"保留输入"';
  editor.dispatchEvent(new InputEvent("input", { bubbles: true }));
  await nextTick();
  field.format = "text";
  await nextTick();
  Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
    .find((b) => b.textContent?.trim() === "确定")!
    .click();
  await nextTick();
  expect(document.body.textContent).toContain("当前公式设置已变化");
  expect(
    document.querySelector('[contenteditable="true"]')?.textContent,
  ).toContain("保留输入");
  expect(updates).toEqual([]);
});
