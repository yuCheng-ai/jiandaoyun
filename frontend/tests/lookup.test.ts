// @vitest-environment jsdom
// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  computed,
  createApp,
  h,
  nextTick,
  reactive,
  shallowReactive,
} from "vue";
import { createPinia, setActivePinia } from "pinia";

import {
  composeFormSchema,
  separateFormSchema,
  frontendEventSettingsErrors,
} from "@platform/contracts";
import {
  copy,
  createField,
  emptySchema,
  findField,
  flattenFields,
  parseSchema,
  prepareSubmission,
  type FormField,
  type FormValues,
} from "../src/domain/form";
import {
  applyLookupSelection,
  createLookupFields,
  lookupDisplay,
  lookupIssues,
  lookupMultiple,
  lookupSelection,
} from "../src/domain/lookup";
import {
  selectionCandidates,
  selectionSourceFields,
  filterSelectionCandidates,
  selectionFilterFields,
  selectionFilterError,
} from "../src/domain/frontendSelections";
import {
  buildRecordBlocks,
  defaultDetailSettings,
  presentationFields,
  newPrintTemplate,
  printFieldChoices,
  expandedPrintFieldIds,
  printTemplateIssues,
  printTemplateReferences,
} from "../src/domain/presentation";
import { fieldExtensionImpacts } from "../src/domain/extensions";

import { validateFieldConfiguration } from "../src/domain/fieldValidation";
import { runtimeDataKey } from "../src/composables/useRuntimeData";
import {
  seedWorkspace,
  newForm,
  type FormEntry,
} from "../src/domain/workspace";

import SelectionRecords from "../src/features/forms/components/SelectionRecords.vue";

import DataFilterEditor from "../src/features/forms/components/DataFilterEditor.vue";
import type { DataFilter, SelectionFilter } from "../src/domain/fieldConfig";
import { referenceDependencies } from "../src/domain/relations";
import {
  quickFillFields,
  quickFillIssues,
  newQuickFill,
} from "../src/domain/quickFill";
import RecordBody from "../src/features/forms/components/RecordBody.vue";
import LookupControl from "../src/features/forms/components/LookupControl.vue";

const cleanups: (() => void)[] = [];
let pinia = createPinia();
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  pinia = createPinia();
  setActivePinia(pinia);
});
afterEach(() => {
  cleanups.splice(0).forEach((fn) => fn());
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});
async function fixture() {
  const data = seedWorkspace();
  const source = newForm("oa", "客户资料");
  source.schema.fields = [
    createField("text", { id: "s_name", label: "客户名称" }),
    createField("number", { id: "s_amount", label: "金额" }),
    createField("select", {
      id: "s_status",
      label: "状态",
      options: [{ id: "source_on", label: "有效" }],
    }),
    createField("subform", {
      id: "s_lines",
      label: "明细",
      children: [createField("number", { id: "s_cost", label: "费用" })],
    }),
  ];
  source.published = {
    version: 1,
    title: source.title,
    schema: copy(source.schema),
    workflow: copy(source.workflow),
    extensions: copy(source.extensions),
    publishedAt: source.createdAt,
  };
  source.versions = [copy(source.published)];
  data.forms.push(source);
  const first: FormEntry = {
    id: "first",
    formId: source.id,
    definitionVersion: 1,
    values: {
      s_name: "甲公司",
      s_amount: 4,
      s_status: "source_on",
      s_lines: [{ s_cost: 2 }, { s_cost: 3 }],
    },
    createdAt: source.createdAt,
    status: "submitted",
    history: [],
  };
  data.entries.push(first);
  const second: FormEntry = {
    id: "second",
    formId: source.id,
    definitionVersion: 1,
    values: {
      s_name: "乙公司",
      s_amount: 9,
      s_status: "source_on",
      s_lines: [{ s_cost: 7 }],
    },
    createdAt: source.createdAt,
    status: "submitted",
    history: [],
  };
  data.entries.push(second);
  const lookup = createField("lookup", {
    id: "choose",
    label: "选择客户",
    referenceFormId: source.id,
  });
  lookup.reference.columns = ["s_name", "s_amount"];
  lookup.reference.displayColumns = ["s_status", "s_name"];
  lookup.reference.mappings = [
    { sourceFieldId: "s_amount", targetFieldId: "amount" },
    { sourceFieldId: "s_status", targetFieldId: "status" },
  ];
  const schema = emptySchema();
  schema.fields = [
    lookup,
    createField("number", { id: "amount", label: "金额" }),
    createField("select", {
      id: "status",
      label: "状态",
      options: [{ id: "target_on", label: "有效" }],
    }),
    createField("text", { id: "memo", label: "备注" }),
  ];
  return { source, first, second, lookup, schema, data };
}
it("creates ordinary receivers with fresh identities and fills main values and one grouped source detail without mutating either form", async () => {
  const { schema, data, first } = await fixture();
  const original = copy(schema),
    sourceBefore = copy(data.forms);
  const next = createLookupFields(
    schema,
    "choose",
    ["s_name", "s_status", "s_cost"],
    data,
  );
  const lookup = findField(next.fields, "choose")!;
  const [name, status, cost] = lookup.reference.mappings.map((mapping) =>
    findField(next.fields, mapping.targetFieldId)!,
  );
  expect(next.fields.map((field) => field.type)).toEqual([
    "lookup",
    "text",
    "select",
    "subform",
    "number",
    "select",
    "text",
  ]);
  expect(next.fields[3]!.children).toEqual([cost]);
  expect(
    new Set(flattenFields(next.fields).map((field) => field.id)).size,
  ).toBe(flattenFields(next.fields).length);
  expect(status!.options[0]!.id).not.toBe("source_on");
  expect(lookupIssues(lookup, next, data)).toEqual([]);
  const values = applyLookupSelection(lookup, next, { memo: "保留" }, data, [
    first.id,
  ]);
  expect(values[name!.id]).toBe("甲公司");
  expect(values[status!.id]).toBe(status!.options[0]!.id);
  expect(values[next.fields[3]!.id]).toEqual([
    { [cost!.id]: 2 },
    { [cost!.id]: 3 },
  ]);
  expect(parseSchema(copy(next))).toEqual(next);
  expect(schema).toEqual(original);
  expect(data.forms).toEqual(sourceBefore);
});
it("uses receiving field types and empty defaults rather than carrying source rules, formulas or automatic identities", async () => {
  const { schema, data, source, first } = await fixture();
  const extra = [
    createField("phone", {
      id: "s_phone",
      defaultValue: "13800000000",
      required: true,
      unique: true,
    }),
    createField("serial", { id: "s_serial" }),
    createField("calculated", {
      id: "s_total",
      expression: "${s_amount}*2",
      precision: 3,
    }),
    createField("datetime", {
      id: "s_date",
      format: "datetime-local",
      defaultValue: "2026-10-10T09:00",
    }),
    createField("member", { id: "s_member" }),
    createField("file", { id: "s_file", multiple: true }),
  ];
  const published = data.forms.find((form) => form.id === source.id)!;
  for (const version of new Set([
    published.schema,
    published.published!.schema,
    published.versions[0]!.schema,
  ]))
    version.fields.push(...copy(extra));
  const record = data.entries.find((entry) => entry.id === first.id)!;
  Object.assign(record.values, {
    s_phone: "13800000000",
    s_serial: "KH-001",
    s_total: 8,
    s_date: "2026-10-10T09:00",
    s_member: data.organization.currentUserId,
    s_file: [
      { id: "file_a", name: "说明.pdf", type: "application/pdf", size: 12 },
    ],
  });
  const next = createLookupFields(
    schema,
    "choose",
    extra.map((field) => field.id),
    data,
  );
  const lookup = findField(next.fields, "choose")!;
  const receivers = lookup.reference.mappings.map((mapping) =>
    findField(next.fields, mapping.targetFieldId)!,
  );
  expect(receivers.map((field) => field.type)).toEqual([
    "text",
    "text",
    "number",
    "datetime",
    "member",
    "file",
  ]);
  expect(
    receivers.every(
      (field) =>
        field.defaultValue === "" &&
        !field.required &&
        !field.unique &&
        field.expression === "",
    ),
  ).toBe(true);
  expect(receivers[3]!.dateDefault).toBe("custom");
  const values = applyLookupSelection(lookup, next, {}, data, [first.id]);
  expect(values[receivers[0]!.id]).toBe("13800000000");
  expect(values[receivers[1]!.id]).toBe("KH-001");
  expect(values[receivers[2]!.id]).toBe(8);
  expect(values[receivers[4]!.id]).toBe(data.organization.currentUserId);
  expect(values[receivers[5]!.id]).toEqual(record.values.s_file);
});
it("remaps active source dependencies and creates child receivers in their own row scope, rejecting incomplete selections atomically", async () => {
  const { schema, data, source, lookup } = await fixture();
  const status = findField(
    data.forms.find((form) => form.id === source.id)!.published!.schema.fields,
    "s_status",
  )!;
  status.choiceSource = {
    ...status.choiceSource,
    mode: "form",
    formId: source.id,
    labelFieldId: "s_name",
    filters: [
      {
        id: "dependency",
        sourceFieldId: "s_name",
        operator: "equals",
        source: "field",
        value: "s_name",
      },
    ],
  };
  const before = copy(schema);
  expect(() =>
    createLookupFields(schema, "choose", ["s_status"], data),
  ).toThrow("请同时选择「客户名称」");
  expect(schema).toEqual(before);
  const next = createLookupFields(
    schema,
    "choose",
    ["s_name", "s_status"],
    data,
  );
  const mappings = findField(next.fields, "choose")!.reference.mappings;
  expect(
    findField(next.fields, mappings[1]!.targetFieldId)!.choiceSource.filters[0]!
      .value,
  ).toBe(mappings[0]!.targetFieldId);
  status.choiceSource.mode = "manual";
  const manual = createLookupFields(schema, "choose", ["s_status"], data);
  const manualTarget = findField(manual.fields, "choose")!.reference
    .mappings[0]!.targetFieldId;
  expect(findField(manual.fields, manualTarget)!.choiceSource.filters).toEqual(
    [],
  );
  childSchema(lookup, schema);
  const childNext = createLookupFields(
    schema,
    "choose",
    ["s_name", "s_amount"],
    data,
  );
  expect(childNext.fields).toHaveLength(schema.fields.length);
  const parent = findField(childNext.fields, "lines")!;
  expect(parent.children.slice(0, 3).map((field) => field.type)).toEqual([
    "lookup",
    "text",
    "number",
  ]);
  expect(() => createLookupFields(schema, "choose", ["s_cost"], data)).toThrow(
    "当前可填充范围",
  );
});
it("refuses stale, duplicate or over-limit creation without leaving partial fields and retains tab ownership", async () => {
  const { schema, data } = await fixture();
  const before = copy(schema);
  for (const sourceIds of [["missing"], ["s_name", "s_name"]])
    expect(() => createLookupFields(schema, "choose", sourceIds, data)).toThrow(
      "来源字段",
    );
  expect(schema).toEqual(before);
  schema.fields.push(...Array.from({ length: 296 }, () => createField("text")));
  expect(() => createLookupFields(schema, "choose", ["s_name"], data)).toThrow(
    "300",
  );
  expect(flattenFields(schema.fields)).toHaveLength(300);
  const tabSchema = emptySchema();
  const tabs = createField("tabs", { children: copy(before.fields) });
  tabs.children[0]!.tabId = tabs.tabs[1]!.id;
  tabSchema.fields = [tabs];
  const next = createLookupFields(
    tabSchema,
    "choose",
    ["s_name", "s_cost"],
    data,
  );
  expect(
    next.fields[0]!.children.slice(1, 3).map((field) => field.tabId),
  ).toEqual([tabs.tabs[1]!.id, tabs.tabs[1]!.id]);
});
it("preserves lookup configuration, source metadata and copied business values across both schema projections", async () => {
  const { lookup, schema, data, first } = await fixture();
  lookup.reference.match = "any";
  lookup.reference.sort = { fieldId: "s_amount", direction: "desc" };
  lookup.buttonText = "选择客户资料";
  expect(parseSchema(copy(schema))).toEqual(schema);
  const split = separateFormSchema(schema);
  expect(composeFormSchema(split.model, split.page)).toEqual(schema);
  const values = applyLookupSelection(
    lookup,
    schema,
    { amount: 1, status: "", memo: "保留" },
    data,
    [first.id],
  );
  expect(values).toMatchObject({
    choose: first.id,
    amount: 4,
    status: "target_on",
    memo: "保留",
  });
  expect(prepareSubmission(schema, values)).toMatchObject({
    choose: first.id,
    amount: 4,
  });
  expect(Object.keys(values)).not.toContain("s_name");
  expect(() =>
    parseSchema({
      ...copy(schema),
      fields: [
        {
          ...lookup,
          reference: {
            ...lookup.reference,
            sort: { fieldId: "s_amount", direction: "random" },
          },
        },
      ],
    }),
  ).toThrow("排序");
});
it("separates the visible source information from business record columns and prints the source labels without the internal ID", async () => {
  const { lookup, schema, data, first } = await fixture();
  const values = { choose: first.id, amount: 4, status: "target_on", memo: "" };
  expect(presentationFields(schema).map((field) => field.id)).toEqual([
    "amount",
    "status",
    "memo",
  ]);
  const display = lookupDisplay(lookup, first.id, data);
  expect(display.map((item) => [item.label, item.text])).toEqual([
    ["状态", "有效"],
    ["客户名称", "甲公司"],
  ]);
  const blocks = buildRecordBlocks(
    schema,
    values,
    defaultDetailSettings(),
    data,
  );
  expect(blocks.slice(0, 2).map((block) => [block.label, block.text])).toEqual([
    ["状态", "有效"],
    ["客户名称", "甲公司"],
  ]);
  expect(JSON.stringify(blocks)).not.toContain(first.id);
  delete data.entries.find((entry) => entry.id === first.id)!.values.s_name;
  expect(lookupDisplay(lookup, first.id, data)[1]!.text).toBe("—");
});
it("keeps source images and files in their native readonly controls and prints images in main and child scope", async () => {
  const { lookup, schema, data, first, source } = await fixture();
  const extras = [
    createField("image", { id: "photo", label: "来源图片" }),
    createField("file", { id: "document", label: "来源附件" }),
  ];
  const published = data.forms.find((f) => f.id === source.id)!;
  for (const version of new Set([
    published.schema,
    published.published!.schema,
    published.versions[0]!.schema,
  ]))
    version.fields.push(...copy(extras));
  const preview = "data:image/png;base64,AQ==";
  const image = {
    id: "image_file",
    name: "凭证.png",
    type: "image/png",
    size: 1,
    preview,
  };
  const file = {
    id: "document_file",
    name: "说明.pdf",
    type: "application/pdf",
    size: 1,
  };
  const entry = data.entries.find((e) => e.id === first.id)!;
  entry.values.photo = [image];
  entry.values.document = [file];
  lookup.reference.displayColumns = ["photo", "document"];
  const child = copy(lookup);
  child.id = "child_choose";
  schema.fields.push(
    createField("subform", { id: "lines", children: [child] }),
  );
  const values = { choose: first.id, lines: [{ child_choose: first.id }] };
  const blocks = buildRecordBlocks(
    schema,
    values,
    defaultDetailSettings(),
    data,
  );
  expect(blocks[0]!.images).toEqual([preview]);
  expect(blocks[0]!.files).toEqual([image]);
  expect(blocks[1]!.files).toEqual([file]);
  expect(blocks[1]!.images).toEqual([]);
  const table = blocks.find((b) => b.id === "lines")!;
  expect(table.rowFiles).toEqual([[[image], [file]]]);
  expect(table.rowImages).toEqual([[[preview], []]]);
  expect(table.columnFields!.map((f) => f.type)).toEqual(["image", "file"]);
  const template = newPrintTemplate(schema, "来源图片");
  template.fieldIds = ["choose:photo", "child_choose:photo"];
  const selectedBlocks = buildRecordBlocks(schema, values, template, data);
  expect(selectedBlocks).toHaveLength(2);
  expect(selectedBlocks[0]!.images).toEqual([preview]);
  expect(selectedBlocks[1]!.headers).toEqual(["来源图片"]);
  expect(selectedBlocks[1]!.rowImages).toEqual([[[preview]]]);
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp({
    render: () =>
      h(RecordBody, { schema, values, settings: defaultDetailSettings() }),
  });
  app.use(pinia);
  app.provide(
    runtimeDataKey,
    computed(() => data),
  );
  app.mount(host);
  cleanups.push(() => app.unmount());
  expect(host.querySelectorAll('img[src="' + preview + '"]')).toHaveLength(2);
  expect(host.querySelectorAll('input[type="file"]')).toHaveLength(0);
  app.unmount();
  cleanups.pop();
  const runtime = createApp({
    render: () =>
      h("div", [
        h(LookupControl, {
          field: lookup,
          modelValue: first.id,
          readonly: true,
          label: "主选择",
        }),
        h(LookupControl, {
          field: child,
          modelValue: first.id,
          readonly: true,
          label: "明细选择",
        }),
      ]),
  });
  runtime.use(pinia);
  runtime.provide(
    runtimeDataKey,
    computed(() => data),
  );
  cleanups.push(() => runtime.unmount());
  runtime.mount(host);
  await nextTick();
  expect(host.textContent).toContain("说明.pdf");
  expect(host.querySelectorAll(".file-values.cards")).toHaveLength(2);
  expect(host.querySelectorAll('input[type="file"]')).toHaveLength(0);
  expect(host.querySelectorAll('button[aria-label^="删除"]')).toHaveLength(0);
  expect(lookup.reference.columns).toEqual(["s_name", "s_amount"]);
});

async function printFixture() {
  const f = await fixture();
  const child = copy(f.lookup);
  child.id = "row_choose";
  child.label = "明细选择客户";
  child.reference.mappings = [];
  f.schema.fields.push(
    createField("subform", {
      id: "lines",
      label: "客户明细",
      children: [
        child,
        createField("number", { id: "row_count", label: "数量" }),
      ],
    }),
  );
  const values = {
    choose: f.first.id,
    amount: 4,
    status: "target_on",
    memo: "保留备注",
    lines: [
      { row_choose: f.first.id, row_count: 1 },
      { row_choose: f.second.id, row_count: 0 },
    ],
  };
  return {
    ...f,
    child,
    values,
    template: newPrintTemplate(f.schema, "客户单据"),
  };
}
it("offers configured source columns and child columns without automatically selecting selection-only columns", async () => {
  const { schema, data, template, values } = await printFixture();
  const fields = printFieldChoices(schema, data);
  expect(fields.map((field) => field.id)).toEqual([
    "choose:s_status",
    "choose:s_name",
    "choose:s_amount",
    "amount",
    "status",
    "memo",
    "row_choose:s_status",
    "row_choose:s_name",
    "row_choose:s_amount",
    "row_count",
  ]);
  expect(
    fields.find((field) => field.id === "row_choose:s_amount")!.label,
  ).toBe("客户明细 · 明细选择客户 · 金额");
  expect(expandedPrintFieldIds(schema, template.fieldIds)).toEqual([
    "choose:s_status",
    "choose:s_name",
    "amount",
    "status",
    "memo",
    "row_choose:s_status",
    "row_choose:s_name",
    "row_count",
  ]);
  expect(template.fieldIds).toEqual([
    "choose",
    "amount",
    "status",
    "memo",
    "lines",
  ]);
  expect(buildRecordBlocks(schema, values, template, data)).toEqual(
    buildRecordBlocks(schema, values, defaultDetailSettings(), data),
  );
});
it("prints individually selected source columns in the requested order without duplicating copied fields or changing the form", async () => {
  const { schema, data, values, template } = await printFixture();
  const before = copy({ schema, values, forms: data.forms });
  template.fieldIds = ["choose:s_amount", "memo", "choose:s_name"];
  expect(
    buildRecordBlocks(schema, values, template, data).map((block) => [
      block.id,
      block.label,
      block.text,
    ]),
  ).toEqual([
    ["choose:s_amount", "金额", "4"],
    ["memo", "备注", "保留备注"],
    ["choose:s_name", "客户名称", "甲公司"],
  ]);
  expect({ schema, values, forms: data.forms }).toEqual(before);
  expect(
    buildRecordBlocks(schema, values, defaultDetailSettings(), data)
      .slice(0, 2)
      .map((block) => block.id),
  ).toEqual(["choose:s_status", "choose:s_name"]);
});
it("prints selected child columns once in their row scope and preserves unselected visibility inputs and zeroes", async () => {
  const { schema, data, values, template } = await printFixture();
  const before = copy(values);
  template.fieldIds = ["row_choose:s_name", "row_count", "row_choose:s_amount"];
  const ordered = buildRecordBlocks(schema, values, template, data);
  expect(ordered).toHaveLength(1);
  expect(ordered[0]!.headers).toEqual(["客户名称", "数量", "金额"]);
  expect(ordered[0]!.columnIds).toEqual(template.fieldIds);
  expect(ordered[0]!.rows).toEqual([
    ["甲公司", "1", "4"],
    ["乙公司", "0", "9"],
  ]);
  schema.settings.rules = [
    {
      id: "row_gate",
      sourceId: "row_count",
      operator: "greater",
      value: "0",
      targetIds: ["row_choose"],
    },
  ];
  template.fieldIds = ["row_count", "row_choose:s_amount", "choose:s_name"];
  const blocks = buildRecordBlocks(schema, values, template, data);
  expect(blocks.map((block) => block.id)).toEqual(["lines", "choose:s_name"]);
  expect(blocks[0]!.headers).toEqual(["数量", "金额"]);
  expect(blocks[0]!.rows).toEqual([
    ["1", "4"],
    ["0", "—"],
  ]);
  template.fieldIds = ["row_choose:s_amount"];
  expect(buildRecordBlocks(schema, values, template, data)[0]!.rows).toEqual([
    ["4"],
    ["—"],
  ]);
  expect(values).toEqual(before);
});
it("keeps selected source content unavailable under masking, original source visibility, deleted records and hidden local parents", async () => {
  const { schema, data, values, template, first, source } =
    await printFixture();
  template.fieldIds = ["choose:s_amount", "row_choose:s_amount"];
  for (const change of ["mask", "source-hidden", "deleted", "local-hidden"]) {
    const scoped = copy(data),
      layout = copy(schema);
    const entry = scoped.entries.find((entry) => entry.id === first.id)!;
    if (change === "mask") delete entry.values.s_amount;
    if (change === "source-hidden")
      findField(
        scoped.forms.find((form) => form.id === source.id)!.versions[0]!.schema
          .fields,
        "s_amount",
      )!.visible = false;
    if (change === "deleted") entry.deletedAt = "2026-10-10T00:00:00Z";
    if (change === "local-hidden") {
      findField(layout.fields, "choose")!.visible = false;
      findField(layout.fields, "lines")!.visible = false;
    }
    const blocks = buildRecordBlocks(layout, values, template, scoped);
    if (change === "local-hidden") expect(blocks).toEqual([]);
    else {
      expect(blocks[0]!.text, change).toBe("—");
      expect(blocks[1]!.rows![0], change).toEqual(["—"]);
    }
  }
});
it("validates source bindings and records impacts for the owning lookup, child column and parent container", async () => {
  const { schema, data, template } = await printFixture();
  template.fieldIds = ["choose:s_amount", "row_choose:s_amount", "row_count"];
  expect(printTemplateIssues(template, schema, data)).toEqual([]);
  expect(printTemplateReferences(template, schema)).toEqual([
    "choose",
    "lines",
    "row_choose",
    "row_count",
  ]);
  const form = {
    ...newForm("oa", "打印选择"),
    schema,
    extensions: { webhooks: [], printTemplates: [template] },
  };
  for (const id of ["choose", "lines", "row_choose", "row_count"])
    expect(fieldExtensionImpacts(form, [id])).toContain(
      `打印模板「${template.name}」的展示字段`,
    );
  const changed = copy(schema);
  findField(changed.fields, "choose")!.reference.columns = ["s_name"];
  expect(printTemplateIssues(template, changed, data)[0]).toContain("不再可用");
  expect(
    printTemplateIssues(
      { ...template, fieldIds: ["choose:s_cost"] },
      schema,
      data,
    )[0],
  ).toContain("不再可用");
  expect(
    printTemplateIssues({ ...template, fieldIds: [] }, schema, data),
  ).toEqual(["请至少选择一个展示字段"]);
  expect(
    printTemplateIssues(
      { ...template, fieldIds: Array(301).fill("memo") },
      schema,
      data,
    ),
  ).toContain("最多选择 300 个展示字段");
});
it("does not expose source file content after source masking, original visibility changes, type incompatibility or deletion", async () => {
  const { lookup, data, first, source } = await fixture();
  const published = data.forms.find((f) => f.id === source.id)!;
  for (const version of new Set([
    published.schema,
    published.published!.schema,
    published.versions[0]!.schema,
  ]))
    version.fields.push(createField("image", { id: "photo" }));
  data.entries.find((e) => e.id === first.id)!.values.photo = [
    {
      id: "secret_image",
      name: "不可读.png",
      type: "image/png",
      size: 1,
      preview: "data:image/png;base64,AQ==",
    },
  ];
  lookup.reference.displayColumns = ["photo"];
  for (const change of ["mask", "hidden", "type", "deleted"]) {
    const scoped = copy(data);
    const entry = scoped.entries.find((e) => e.id === first.id)!;
    const form = scoped.forms.find((f) => f.id === source.id)!;
    if (change === "mask") delete entry.values.photo;
    if (change === "hidden")
      findField(form.versions[0]!.schema.fields, "photo")!.visible = false;
    if (change === "type")
      findField(form.published!.schema.fields, "photo")!.type = "number";
    if (change === "deleted") entry.deletedAt = "2026-10-10T00:00:00Z";
    const item = lookupDisplay(lookup, first.id, scoped)[0]!;
    expect(item.files || [], change).toEqual([]);
    expect(item.text, change).toBe("—");
  }
});
it("permits display-only selection without inventing a required fill mapping", async () => {
  const { lookup, schema, data, first } = await fixture();
  lookup.reference.mappings = [];
  expect(lookupIssues(lookup, schema, data)).toEqual([]);
  expect(
    applyLookupSelection(lookup, schema, { amount: 8 }, data, [first.id]),
  ).toEqual({ amount: 8, choose: first.id });
});
it("keeps lookup actions out of quick-fill and sample value editors without rewriting configured references", async () => {
  const { lookup, schema, first } = await fixture();
  expect(quickFillFields(schema).map((field) => field.id)).toEqual([
    "amount",
    "status",
    "memo",
  ]);
  const config = {
      ...newQuickFill(),
      fields: [{ fieldId: lookup.id, aliases: [], instruction: "" }],
    },
    before = copy(config);
  expect(quickFillIssues(config, schema)).toContain(
    "填报字段已失效、不可编辑或重复",
  );
  expect(config).toEqual(before);
});
it("checks the latest source and all target permissions before applying any field", async () => {
  const { lookup, schema, data, first } = await fixture();
  const values = { amount: 8, status: "target_on", memo: "保留" },
    before = copy(values);
  schema.fields[2]!.editable = false;
  expect(() =>
    applyLookupSelection(lookup, schema, values, data, [first.id]),
  ).toThrow("不可编辑");
  expect(values).toEqual(before);
  schema.fields[2]!.editable = true;
  data.entries.find((entry) => entry.id === first.id)!.status = "draft";
  expect(() =>
    applyLookupSelection(lookup, schema, values, data, [first.id]),
  ).toThrow("不可读取");
  expect(values).toEqual(before);
});
it("main selection replaces source detail arrays including unmapped old values and refuses to erase protected columns", async () => {
  const { lookup, schema, data, first, second } = await fixture();
  const parent = createField("subform", {
    id: "lines",
    label: "明细",
    children: [
      createField("number", { id: "cost" }),
      createField("text", { id: "note" }),
    ],
  });
  schema.fields.push(parent);
  lookup.reference.mappings = [
    { sourceFieldId: "s_cost", targetFieldId: "cost" },
  ];
  const original = {
    lines: [
      { cost: 11, note: "旧备注" },
      { cost: 12, note: "旧备注二" },
    ],
  };
  const result = applyLookupSelection(lookup, schema, original, data, [
    first.id,
  ]);
  expect(result.lines).toEqual([
    { cost: 2, note: "" },
    { cost: 3, note: "" },
  ]);
  expect(
    applyLookupSelection(lookup, schema, result, data, [second.id]).lines,
  ).toEqual([{ cost: 7, note: "" }]);
  parent.children[1]!.editable = false;
  expect(() =>
    applyLookupSelection(lookup, schema, original, data, [first.id]),
  ).toThrow("不能清空");
  expect(original.lines[0]!.note).toBe("旧备注");
});
function childSchema(
  lookup: FormField,
  schema: ReturnType<typeof emptySchema>,
) {
  lookup.reference.mappings = [
    { sourceFieldId: "s_name", targetFieldId: "name" },
    { sourceFieldId: "s_amount", targetFieldId: "amount" },
  ];
  const child = createField("subform", {
    id: "lines",
    label: "明细",
    children: [
      lookup,
      createField("text", { id: "name", label: "名称" }),
      createField("number", { id: "amount", label: "金额" }),
      createField("text", { id: "note", label: "备注" }),
    ],
  });
  schema.fields = [createField("text", { id: "main_note" }), child];
  return child;
}
it("child selection creates one row per chosen record while editing a filled row stays single and leaves other rows unchanged", async () => {
  const { lookup, schema, data, first, second } = await fixture();
  childSchema(lookup, schema);
  const initial = {
    main_note: "主表",
    lines: [
      { choose: "", name: "", amount: "", note: "保留本行" },
      { choose: "", name: "手动行", amount: 55, note: "尾行" },
    ],
  };
  const row = { subformId: "lines", index: 0 };
  expect(lookupMultiple(lookup, schema, initial, row)).toBe(true);
  const result = applyLookupSelection(
    lookup,
    schema,
    initial,
    data,
    [first.id, second.id],
    row,
  );
  expect(result.lines).toEqual([
    { choose: first.id, name: "甲公司", amount: 4, note: "保留本行" },
    { choose: second.id, name: "乙公司", amount: 9, note: "" },
    initial.lines[1],
  ]);
  expect(result.main_note).toBe("主表");
  expect(lookupMultiple(lookup, schema, result, row)).toBe(false);
  expect(() =>
    applyLookupSelection(
      lookup,
      schema,
      result,
      data,
      [first.id, second.id],
      row,
    ),
  ).toThrow("选择范围");
  const edited = applyLookupSelection(
    lookup,
    schema,
    result,
    data,
    [second.id],
    row,
  );
  expect((edited.lines as FormValues[])[0]!.name).toBe("乙公司");
  expect((edited.lines as FormValues[]).slice(1)).toEqual(
    (result.lines as FormValues[]).slice(1),
  );
  expect(
    buildRecordBlocks(schema, result, defaultDetailSettings(), data)[1]!
      .headers,
  ).toEqual(["状态", "客户名称", "名称", "金额", "备注"]);
});
it("child-local filters restrict selection to one row and cannot bind another subform's local inputs", async () => {
  const { lookup, schema, data, first, second } = await fixture();
  childSchema(lookup, schema);
  const filter = {
    id: "filter",
    sourceFieldId: "s_name",
    source: "field" as const,
    operator: "equals" as const,
    value: "note",
  };
  lookup.reference.filters = [filter];
  const values = {
      lines: [{ choose: "", note: "甲公司", name: "", amount: "" }],
    },
    row = { subformId: "lines", index: 0 };
  expect(lookupMultiple(lookup, schema, values, row)).toBe(false);
  expect(() =>
    applyLookupSelection(lookup, schema, values, data, [second.id], row),
  ).toThrow("不再符合条件");
  expect(
    (
      applyLookupSelection(lookup, schema, values, data, [first.id], row)
        .lines as FormValues[]
    )[0]!.amount,
  ).toBe(4);
  schema.fields.push(
    createField("subform", {
      id: "other",
      children: [createField("text", { id: "elsewhere" })],
    }),
  );
  filter.value = "elsewhere";
  expect(lookupIssues(lookup, schema, data).join()).toContain("不在触发范围");
});
it("rejects child-to-child array fills and validates stale displayed fields before publication", async () => {
  const { lookup, schema, data } = await fixture();
  childSchema(lookup, schema);
  lookup.reference.mappings = [
    { sourceFieldId: "s_cost", targetFieldId: "amount" },
  ];
  expect(lookupIssues(lookup, schema, data).join()).toContain(
    "只能填充来源主字段",
  );
  lookup.reference.mappings = [];
  lookup.reference.displayColumns = ["removed"];
  expect(validateFieldConfiguration(schema, data).join()).toContain(
    "显示字段已移除",
  );
});
it("detects source display/sort and local fill references even when a lookup has no business column", async () => {
  const { lookup, source } = await fixture();
  lookup.reference.sort = { fieldId: "s_amount", direction: "desc" };
  const refs = referenceDependencies(lookup);
  expect(refs.formId).toBe(source.id);
  expect(refs.source).toEqual(
    expect.arrayContaining(["s_status", "s_name", "s_amount"]),
  );
  expect(refs.local).toEqual(["amount", "status"]);
});
it("does not use a dynamically hidden local filter as authorization to read or fill source data", async () => {
  const { lookup, schema, data, first } = await fixture();
  schema.fields.push(createField("text", { id: "gate" }));
  schema.settings.rules = [
    {
      id: "hide",
      sourceId: "gate",
      operator: "equals",
      value: "show",
      targetIds: ["memo"],
    },
  ];
  lookup.reference.filters = [
    {
      id: "filter",
      sourceFieldId: "s_name",
      operator: "equals",
      source: "field",
      value: "memo",
    },
  ];
  expect(() =>
    applyLookupSelection(
      lookup,
      schema,
      { gate: "hide", memo: "甲公司", amount: 9 },
      data,
      [first.id],
    ),
  ).toThrow("无权读取");
});
it("supports existing identity, attachment, phone and rich text shapes through the shared fill converter", async () => {
  const { lookup, schema, data, source, first } = await fixture();
  const user = data.organization.currentUserId;
  const file = {
    id: "local_file",
    name: "说明.pdf",
    size: 12,
    type: "application/pdf",
  };
  const extra = [
    createField("member", { id: "s_member" }),
    createField("file", { id: "s_file" }),
    createField("phone", { id: "s_phone" }),
    createField("richtext", { id: "s_rich" }),
  ];
  const currentSource = data.forms.find((form) => form.id === source.id)!;
  for (const version of new Set([
    currentSource.schema,
    currentSource.published!.schema,
    currentSource.versions[0]!.schema,
  ]))
    version.fields.push(...copy(extra));
  const record = data.entries.find((entry) => entry.id === first.id)!;
  Object.assign(record.values, {
    s_member: user,
    s_file: [file],
    s_phone: "13800000000",
    s_rich: "<p>说明</p><script>bad()</script>",
  });
  schema.fields.push(
    createField("member", { id: "member" }),
    createField("file", { id: "file" }),
    createField("text", { id: "phone" }),
    createField("richtext", { id: "rich" }),
  );
  lookup.reference.mappings = [
    { sourceFieldId: "s_member", targetFieldId: "member" },
    { sourceFieldId: "s_file", targetFieldId: "file" },
    { sourceFieldId: "s_phone", targetFieldId: "phone" },
    { sourceFieldId: "s_rich", targetFieldId: "rich" },
  ];
  const result = applyLookupSelection(lookup, schema, {}, data, [first.id]);
  expect(result).toMatchObject({
    member: user,
    file: [file],
    phone: "13800000000",
    rich: "<p>说明</p>",
  });
  expect(
    selectionSourceFields(data, source.id).some(
      (field) => field.id === "s_file",
    ),
  ).toBe(false);
  expect(
    selectionCandidates(
      lookupSelection(lookup, data),
      data,
      {},
      [],
      "甲公司",
      "lookup",
    ).map((entry) => entry.id),
  ).toEqual([first.id]);
});
async function settle() {
  await nextTick();
  await nextTick();
  await Promise.resolve();
}

function button(label: string) {
  return [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) =>
      !button.disabled &&
      (button.getAttribute("aria-label") || button.textContent?.trim()) ===
        label &&
      !button.parentElement?.inert,
  )!;
}

it("checkbox Shift selection applies a whole visible range using the shared records table", async () => {
  const { lookup, data, first, second } = await fixture();
  data.entries.push({
    ...copy(second),
    id: "third",
    values: { ...copy(second.values), s_name: "丙公司" },
  });
  const host = document.createElement("div");
  document.body.append(host);
  const state = reactive({ ids: [] as string[] });
  const app = createApp({
    render: () =>
      h(SelectionRecords, {
        config: lookupSelection(lookup, data),
        data,
        values: {},
        inputs: [],
        multiple: true,
        profile: "lookup",
        selectedIds: state.ids,
        onChangeSelection: (ids: string[]) => {
          state.ids = ids;
        },
      }),
  });
  app.mount(host);
  cleanups.push(() => app.unmount());
  await settle();
  const boxes = [
    ...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
  ];
  expect(boxes).toHaveLength(3);
  boxes[0]!.click();
  await settle();
  boxes[2]!.dispatchEvent(
    new MouseEvent("click", { bubbles: true, shiftKey: true }),
  );
  await settle();
  expect(state.ids).toHaveLength(3);
  expect(
    [
      ...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
    ].every((box) => box.checked),
  ).toBe(true);
  state.ids = [];
  await settle();
  host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[2]!.click();
  await settle();
  const search = host.querySelector<HTMLInputElement>(
    '[aria-label="搜索数据"]',
  )!;
  search.value = "甲";
  search.dispatchEvent(new Event("input", { bubbles: true }));
  await settle();
  search.value = "";
  search.dispatchEvent(new Event("input", { bubbles: true }));
  await settle();
  host
    .querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[0]!
    .dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }));
  await settle();
  expect(new Set(state.ids)).toEqual(new Set(["third", first.id]));
});
it("rejects malformed chooser aliases and preserves the absent optional property on old schemas and event selections", async () => {
  const { lookup, schema } = await fixture();
  expect(parseSchema(copy(schema)).fields[0]!.reference).not.toHaveProperty(
    "columnLabels",
  );
  for (const labels of [
    { s_name: " " },
    { missing: "名称" },
    ["名称"],
    JSON.parse('{"__proto__":"名称"}'),
    { s_name: "名".repeat(101) },
  ]) {
    const invalid = copy(schema);
    invalid.fields[0]!.reference.columnLabels = labels as any;
    expect(() => parseSchema(invalid)).toThrow("显示列");
  }
  schema.settings.frontendEvents = [
    {
      id: "event_choose",
      name: "选数",
      description: "",
      enabled: true,
      trigger: "field",
      fieldIds: [lookup.id],
      selection: {
        ...lookupSelection(lookup, (await fixture()).data),
        columnLabels: { s_name: "名称" },
      },
    },
  ];
  expect(frontendEventSettingsErrors(schema.settings)).toEqual([]);
  schema.settings.frontendEvents[0]!.selection!.columnLabels = {
    missing: "名称",
  };
  expect(frontendEventSettingsErrors(schema.settings)).toEqual([
    "前端事件选数配置不合法",
  ]);
});
async function changeControl(label: string, value: string) {
  const control = document.querySelector<HTMLInputElement | HTMLSelectElement>(
    `[aria-label="${label}"]`,
  )!;
  expect(control).not.toBeNull();
  control.value = value;
  control.dispatchEvent(
    new Event(control.tagName === "SELECT" ? "change" : "input", {
      bubbles: true,
    }),
  );
  await settle();
  return control;
}

it("temporary filters narrow configured all/any candidates and source child values without reading hidden fields", async () => {
  const { lookup, data, first, second } = await fixture();
  const config = lookupSelection(lookup, data);
  config.columns = ["s_name", "s_amount", "s_cost"];
  config.filters = [
    {
      id: "base",
      sourceFieldId: "s_amount",
      operator: "less",
      source: "constant",
      value: "5",
    },
  ];
  config.match = "any";
  const base = selectionCandidates(config, data, {}, [], "", "lookup");
  const filter: DataFilter = {
    id: "temporary",
    sourceFieldId: "s_name",
    operator: "equals",
    source: "constant",
    value: "乙公司",
  };
  expect(base.map((entry) => entry.id)).toEqual([first.id]);
  expect(filterSelectionCandidates(base, config, data, [filter])).toEqual([]);
  config.filters = [];
  const all = selectionCandidates(config, data, {}, [], "", "lookup");
  expect(
    filterSelectionCandidates(all, config, data, [
      { ...filter, sourceFieldId: "s_cost", operator: "greater", value: "5" },
    ]).map((entry) => entry.id),
  ).toEqual([second.id]);
  expect(
    filterSelectionCandidates(all, config, data, [
      { ...filter, sourceFieldId: "s_amount", value: "4.0" },
    ]).map((entry) => entry.id),
  ).toEqual([first.id]);
  expect(
    filterSelectionCandidates(all, config, data, [
      { ...filter, sourceFieldId: "s_name", operator: "contains", value: "甲" },
    ]).map((entry) => entry.id),
  ).toEqual([first.id]);
  delete data.entries.find((entry) => entry.id === second.id)!.values.s_name;
  expect(filterSelectionCandidates(all, config, data, [filter])).toEqual([]);
  expect(
    filterSelectionCandidates(all, config, data, [
      { ...filter, sourceFieldId: "missing" },
    ]),
  ).toEqual([]);
  expect(
    selectionFilterError(
      [{ ...filter, source: "currentUser" }],
      selectionFilterFields(
        config,
        selectionSourceFields(data, config.formId, "lookup"),
      ),
    ),
  ).toContain("有效字段");
});
it("runtime filter popover applies, cancels and clears without storing conditions or changing selected records", async () => {
  const { lookup, data, first, second } = await fixture();
  lookup.reference.columnLabels = { s_name: "往来单位" };
  const config = lookupSelection(lookup, data),
    before = copy(config);
  const state = reactive({ ids: [second.id] });
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp({
    render: () =>
      h(SelectionRecords, {
        config,
        data,
        values: {},
        inputs: [],
        profile: "lookup",
        multiple: true,
        selectedIds: state.ids,
        onChangeSelection: (ids) => {
          state.ids = ids;
        },
      }),
  });
  app.mount(host);
  cleanups.push(() => app.unmount());
  await settle();
  button("筛选数据").click();
  await settle();
  expect(document.activeElement?.getAttribute("aria-label")).toBe(
    "条件1来源字段",
  );
  expect(document.querySelector('[aria-label="条件1值来源"]')).toBeNull();
  await changeControl("条件1来源字段", "s_name");
  await changeControl("条件1运算符", "equals");
  expect(
    [
      ...document.querySelectorAll<HTMLSelectElement>(
        '[aria-label="条件1固定值"] option',
      ),
    ].map((el) => el.textContent?.trim()),
  ).toEqual(["请选择", "甲公司", "乙公司"]);
  await changeControl("条件1固定值", "甲公司");
  document.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
  );
  await settle();
  expect(host.querySelectorAll("tbody tr")).toHaveLength(2);
  button("筛选数据").click();
  await settle();
  await changeControl("条件1来源字段", "s_name");
  await changeControl("条件1运算符", "equals");
  await changeControl("条件1固定值", "甲公司");
  button("筛选").click();
  await settle();
  expect(host.querySelectorAll("tbody tr")).toHaveLength(1);
  expect(host.textContent).toContain("1 条 / 共 2 条");
  expect(host.textContent).toContain("往来单位");
  expect(host.querySelector("tbody")?.textContent).toContain(
    first.values.s_name,
  );
  expect(state.ids).toEqual([second.id]);
  expect(config).toEqual(before);
  button("筛选数据").click();
  await settle();
  button("清空").click();
  await settle();
  expect(host.querySelectorAll("tbody tr")).toHaveLength(2);
  expect(config).toEqual(before);
});
it("selection suggestions remain scoped and changing member context clears temporary filter drafts", async () => {
  const { lookup, data, first, second } = await fixture();
  data.entries = data.entries.filter((entry) => entry.id !== second.id);
  const context = shallowReactive(copy(data));
  context.organization = reactive(copy(data.organization));
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp({
    render: () =>
      h(SelectionRecords, {
        config: lookupSelection(lookup, context),
        data: context,
        values: {},
        inputs: [],
        profile: "lookup",
      }),
  });
  app.mount(host);
  cleanups.push(() => app.unmount());
  await settle();
  button("筛选数据").click();
  await settle();
  await changeControl("条件1来源字段", "s_name");
  await changeControl("条件1运算符", "equals");
  const choices = document.querySelector<HTMLSelectElement>(
    '[aria-label="条件1固定值"]',
  )!;
  expect([...choices.options].map((option) => option.value)).toEqual([
    "",
    String(first.values.s_name),
  ]);
  context.organization.currentUserId = "another_member";
  await settle();
  expect(document.querySelector(".selection-filter-panel")).toBeNull();
  button("筛选数据").click();
  await settle();
  expect(
    document.querySelector<HTMLSelectElement>('[aria-label="条件1来源字段"]')
      ?.value,
  ).toBe("");
});
it("temporary multi-value and negative conditions keep missing or incompatible data unreadable", async () => {
  const { lookup, data, first, second } = await fixture();
  const blank = {
    ...copy(first),
    id: "blank",
    values: { ...copy(first.values), s_name: "" },
  };
  const missing = { ...copy(first), id: "missing", values: copy(first.values) };
  delete missing.values.s_name;
  const incompatible = {
    ...copy(first),
    id: "incompatible",
    definitionVersion: 999,
  };
  const entries = [first, second, blank, missing, incompatible];
  const config = lookupSelection(lookup, data);
  const filter: SelectionFilter = {
    id: "temporary",
    sourceFieldId: "s_name",
    source: "constant",
    operator: "equalsAny",
    value: ["甲公司", ""],
  };
  const ids = (conditions: SelectionFilter[]) =>
    filterSelectionCandidates(entries, config, data, conditions).map(
      (entry) => entry.id,
    );
  expect(ids([filter])).toEqual([first.id, blank.id]);
  expect(
    ids([{ ...filter, operator: "notEqualsAny", value: ["甲公司", "乙公司"] }]),
  ).toEqual([blank.id]);
  expect(ids([{ ...filter, operator: "notContains", value: "甲" }])).toEqual([
    second.id,
    blank.id,
  ]);
  expect(ids([{ ...filter, operator: "empty", value: "" }])).toEqual([
    blank.id,
  ]);
  expect(ids([{ ...filter, operator: "notEmpty", value: "" }])).toEqual([
    first.id,
    second.id,
  ]);
  expect(
    ids([
      { ...filter, value: ["甲公司", "乙公司"] },
      {
        ...filter,
        id: "amount",
        sourceFieldId: "s_amount",
        operator: "greater",
        value: "5",
      },
    ]),
  ).toEqual([second.id]);
  const fields = selectionFilterFields(
    config,
    selectionSourceFields(data, config.formId, "lookup"),
  );
  for (const invalid of [
    { ...filter, value: [] },
    { ...filter, value: "甲公司" },
    { ...filter, operator: "notEqualsAny", value: [""] },
    { ...filter, sourceFieldId: "s_amount", value: ["4"] },
  ] as SelectionFilter[])
    expect(selectionFilterError([invalid], fields)).not.toBe("");
  config.filters = [
    { ...filter, operator: "less", sourceFieldId: "s_amount", value: "5" },
  ];
  const base = selectionCandidates(config, data, {}, [], "", "lookup");
  expect(
    filterSelectionCandidates(base, config, data, [
      { ...filter, value: ["乙公司"] },
    ]),
  ).toEqual([]);
});
it("runtime multi-value picker reuses searchable selection and nested dismissal, while multiple conditions and empty values stay temporary", async () => {
  const { lookup, data, first, second } = await fixture();
  data.entries.push({
    ...copy(first),
    id: "blank",
    values: { ...copy(first.values), s_name: "" },
  });
  const config = lookupSelection(lookup, data),
    before = copy(config);
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp({
    render: () =>
      h(SelectionRecords, {
        config,
        data,
        values: {},
        inputs: [],
        profile: "lookup",
      }),
  });
  app.mount(host);
  cleanups.push(() => app.unmount());
  await settle();
  button("筛选数据").click();
  await settle();
  await changeControl("条件1来源字段", "s_name");
  expect(
    document.querySelector<HTMLSelectElement>('[aria-label="条件1运算符"]')
      ?.value,
  ).toBe("equalsAny");
  const openValues = async () => {
    document
      .querySelector<HTMLElement>(
        '[role="combobox"][aria-label="条件1固定值"]',
      )!
      .click();
    await settle();
  };
  await openValues();
  expect(document.querySelectorAll('[aria-label="条件1固定值"]')).toHaveLength(
    1,
  );
  expect(
    document.querySelector('[aria-label="条件1固定值 未填写"]'),
  ).not.toBeNull();
  await changeControl("条件1固定值搜索选项", "甲");
  document
    .querySelector<HTMLInputElement>('[aria-label="条件1固定值搜索结果全选"]')!
    .click();
  await settle();
  document.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
  );
  await settle();
  expect(document.querySelector(".choice-popup")).toBeNull();
  expect(document.querySelector(".selection-filter-panel")).not.toBeNull();
  button("筛选").click();
  await settle();
  expect(host.textContent).toContain("1 条 / 共 3 条");
  expect(host.querySelector("tbody")?.textContent).toContain("甲公司");
  button("筛选数据").click();
  await settle();
  await openValues();
  document
    .querySelector<HTMLInputElement>('[aria-label="条件1固定值 乙公司"]')!
    .click();
  await settle();
  document.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
  );
  await settle();
  button("添加过滤条件").click();
  await settle();
  await changeControl("条件2来源字段", "s_amount");
  await changeControl("条件2运算符", "greater");
  await changeControl("条件2固定值", "5");
  button("筛选").click();
  await settle();
  expect(host.querySelectorAll("tbody tr")).toHaveLength(1);
  expect(host.querySelector("tbody")?.textContent).toContain(
    second.values.s_name,
  );
  button("筛选数据").click();
  await settle();
  button("删除条件2").click();
  await settle();
  await changeControl("条件1运算符", "notEqualsAny");
  await openValues();
  expect(
    document.querySelector('[aria-label="条件1固定值 未填写"]'),
  ).toBeNull();
  expect(
    document.querySelector<HTMLInputElement>(
      '[aria-label="条件1固定值 甲公司"]',
    )?.checked,
  ).toBe(false);
  document.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
  );
  await settle();
  await changeControl("条件1运算符", "empty");
  expect(document.querySelector('[aria-label="条件1固定值"]')).toBeNull();
  button("筛选").click();
  await settle();
  expect(host.querySelectorAll("tbody tr")).toHaveLength(1);
  expect(host.querySelector("tbody")?.textContent).not.toContain("甲公司");
  expect(config).toEqual(before);
});
it("shared filters offer typed comparisons and retain configured operators and field bindings", async () => {
  const state = reactive({
    allowFieldSource: true,
    filters: [
      {
        id: "configured",
        sourceFieldId: "s_name",
        operator: "equals",
        source: "field",
        value: "local_name",
      },
    ] as DataFilter[],
  });
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp({
    render: () =>
      h(DataFilterEditor<DataFilter>, {
        modelValue: state.filters,
        allowFieldSource: state.allowFieldSource,
        sourceFields: [
          createField("text", { id: "s_name", label: "名称" }),
          createField("text", { id: "s_other", label: "其他" }),
          createField("number", { id: "s_number", label: "金额" }),
          createField("address", { id: "s_address", label: "地址" }),
        ],
        localFields: [
          createField("text", { id: "local_name", label: "当前名称" }),
        ],
        "onUpdate:modelValue": (filters: DataFilter[]) => {
          state.filters = filters;
        },
      }),
  });
  app.mount(host);
  cleanups.push(() => app.unmount());
  await settle();
  expect(
    [
      ...document.querySelectorAll<HTMLSelectElement>(
        '[aria-label="条件1运算符"] option',
      ),
    ].map((option) => option.value),
  ).toEqual(["equals", "notEquals", "contains", "notEmpty"]);
  await changeControl("条件1来源字段", "s_other");
  expect(
    document.querySelector<HTMLSelectElement>('[aria-label="条件1引用字段"]')
      ?.value,
  ).toBe("local_name");
  expect(state.filters[0]).toMatchObject({
    source: "field",
    value: "local_name",
    operator: "equals",
  });
  await changeControl("条件1来源字段", "s_number");
  expect(
    [
      ...document.querySelectorAll<HTMLSelectElement>(
        '[aria-label="条件1运算符"] option',
      ),
    ].map((o) => o.value),
  ).toEqual(["equals", "notEquals", "greater", "less", "notEmpty"]);
  state.filters[0]!.operator = "greater";
  await settle();
  await changeControl("条件1来源字段", "s_name");
  const retained = document.querySelector<HTMLOptionElement>(
    '[aria-label="条件1运算符"] option[value="greater"]',
  )!;
  expect(retained.disabled).toBe(true);
  expect(retained.textContent).toContain("请调整");
  expect(state.filters[0]!.operator).toBe("greater");
  await changeControl("条件1运算符", "equals");
  button("添加筛选条件").click();
  await settle();
  expect(state.filters[1]).toMatchObject({
    source: "field",
    operator: "equals",
    value: "",
  });
  state.allowFieldSource = false;
  await settle();
  await changeControl("条件1来源字段", "s_address");
  expect(
    [
      ...document.querySelectorAll<HTMLSelectElement>(
        '[aria-label="条件1运算符"] option',
      ),
    ].map((o) => o.value),
  ).toEqual(["notEmpty"]);
  expect(state.filters[0]!.operator).toBe("notEmpty");
  expect(document.querySelector('[aria-label="条件1值来源"]')).toBeNull();
});
