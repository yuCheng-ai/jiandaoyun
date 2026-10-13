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
import { createMemoryHistory, createRouter } from "vue-router";
import {
  composeFormSchema,
  separateFormSchema,
  frontendEventSettingsErrors,
  type FrontendEvent,
  type FormValues,
} from "@platform/contracts";
import {
  copy,
  createField,
  emptySchema,
  parseSchema,
} from "../src/domain/form";
import {
  newFrontendSelection,
  selectionCandidates,
  selectionSourceFields,
} from "../src/domain/frontendSelections";
import {
  applyFrontendEvents,
  frontendEventIssues,
  frontendEventReferences,
  frontendEventScope,
  runFrontendEvent,
} from "../src/domain/frontendEvents";
import { runtimeDataKey } from "../src/composables/useRuntimeData";
import { useWorkspaceStore } from "../src/stores/workspace";
import FormRuntime from "../src/features/forms/components/FormRuntime.vue";
import type { WorkspaceData } from "../src/domain/workspace";

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
type SelectionEvent = Extract<FrontendEvent, { selection: unknown }>;
async function fixture() {
  const store = useWorkspaceStore(),
    created = (await store.createForm("oa", "来源订单", "form"))!;
  const form = store.openForm(created.id)!;
  form.schema.fields = [
    createField("text", { id: "source_code", label: "订单号" }),
    createField("number", { id: "source_qty", label: "数量" }),
    createField("select", {
      id: "source_state",
      label: "状态",
      options: [
        { id: "source_ready", label: "可用" },
        { id: "source_hold", label: "待定" },
      ],
    }),
    createField("datetime", {
      id: "source_date",
      label: "日期",
      format: "date",
    }),
    createField("subform", {
      id: "source_lines",
      label: "来源明细",
      children: [createField("number", { id: "source_cost", label: "费用" })],
    }),
  ];
  expect(await store.publishForm(form.id)).toBe(true);
  const first = (await store.submitEntry(form.id, {
    source_code: "ORD-甲",
    source_qty: 2,
    source_state: "source_ready",
    source_date: "2026-10-10",
    source_lines: [{ source_cost: 4 }, { source_cost: 6 }],
  }))!;
  const second = (await store.submitEntry(form.id, {
    source_code: "ORD-乙",
    source_qty: 12,
    source_state: "source_hold",
    source_date: "2026-10-09",
    source_lines: [{ source_cost: 9 }],
  }))!;
  const schema = emptySchema();
  schema.fields = [
    createField("button", {
      id: "choose",
      label: "选择订单",
      buttonText: "选择订单",
    }),
    createField("text", { id: "code", label: "订单号" }),
    createField("number", { id: "qty", label: "数量" }),
    createField("select", {
      id: "state",
      label: "状态",
      options: [
        { id: "target_ready", label: "可用" },
        { id: "target_hold", label: "待定" },
      ],
    }),
    createField("datetime", { id: "date", label: "日期", format: "date" }),
    createField("subform", {
      id: "lines",
      label: "明细",
      children: [
        createField("number", { id: "cost", label: "费用" }),
        createField("text", { id: "memo", label: "备注" }),
      ],
    }),
  ];
  const event: SelectionEvent = {
    id: "event_select",
    name: "选择订单回填",
    description: "",
    enabled: true,
    trigger: "field",
    fieldIds: ["choose"],
    selection: {
      ...newFrontendSelection(),
      formId: form.id,
      columns: ["source_code", "source_qty", "source_state"],
      mappings: [
        { sourceFieldId: "source_code", targetFieldId: "code" },
        { sourceFieldId: "source_qty", targetFieldId: "qty" },
        { sourceFieldId: "source_state", targetFieldId: "state" },
        { sourceFieldId: "source_date", targetFieldId: "date" },
      ],
    },
  };
  schema.settings.frontendEvents = [event];
  return { store, form, first, second, schema, event, data: store.data };
}
it("selection configuration retains stable references across schema/page projections and rejects ambiguous unions, duplicate columns and invalid filters", async () => {
  const { schema, event, data } = await fixture();
  expect(parseSchema(copy(schema))).toEqual(schema);
  const split = separateFormSchema(schema);
  expect(composeFormSchema(split.model, split.page)).toEqual(schema);
  expect(frontendEventIssues(event, schema, data)).toEqual([]);
  for (const invalid of [
    { ...event, plugin: { actionId: "multiply", inputs: {}, outputs: [] } },
    {
      ...event,
      selection: {
        ...event.selection,
        columns: ["source_code", "source_code"],
      },
    },
    {
      ...event,
      selection: {
        ...event.selection,
        sort: { fieldId: "__proto__", direction: "asc" },
      },
    },
    {
      ...event,
      selection: {
        ...event.selection,
        filters: [
          {
            id: "filter_a",
            sourceFieldId: "source_qty",
            operator: "equals",
            source: "field",
            value: "",
          },
        ],
      },
    },
    { ...event, selection: { ...event.selection, extra: true } },
  ])
    expect(
      frontendEventSettingsErrors({
        ...schema.settings,
        frontendEvents: [invalid] as any,
      }),
    ).not.toEqual([]);
  event.selection.filters = [
    {
      id: "filter_a",
      sourceFieldId: "source_qty",
      operator: "equals",
      source: "field",
      value: "qty",
    },
  ];
  expect(frontendEventReferences(event)).toContain("qty");
  expect(frontendEventReferences(event)).not.toContain("source_qty");
  schema.fields = schema.fields.filter((field) => field.id !== "qty");
  expect(
    frontendEventIssues(event, schema, data).some((issue) =>
      issue.message.includes("引用字段"),
    ),
  ).toBe(true);
  expect(
    parseSchema(schema).settings.frontendEvents![0]!.selection!.filters[0]!
      .value,
  ).toBe("qty");
});
it("only published, submitted, readable records with compatible historical fields are candidates; no current defaults or hidden values are substituted", async () => {
  const { event, data, form, first, second } = await fixture();
  const select = event.selection;
  const firstRecord = data.entries.find((entry) => entry.id === first.id)!;
  expect(
    selectionCandidates(select, data, {}).map((entry) => entry.id),
  ).toEqual([first.id, second.id]);
  firstRecord.status = "draft";
  expect(
    selectionCandidates(select, data, {}).map((entry) => entry.id),
  ).toEqual([second.id]);
  firstRecord.status = "submitted";
  delete firstRecord.values.source_qty;
  expect(
    selectionCandidates(select, data, {}).map((entry) => entry.id),
  ).toEqual([second.id]);
  firstRecord.values.source_qty = 2;
  firstRecord.definitionVersion = 999;
  expect(
    selectionCandidates(select, data, {}).map((entry) => entry.id),
  ).toEqual([second.id]);
  data.forms.find((item) => item.id === form.id)!.archived = true;
  expect(selectionSourceFields(data, form.id)).toEqual([]);
  expect(selectionCandidates(select, data, {})).toEqual([]);
});
it("search, numeric sorting and all/any filtering reuse business values, including cross-form option names and current-row filter inputs", async () => {
  const { event, data, schema, first, second } = await fixture(),
    inputs = frontendEventScope(schema, event).fields;
  event.selection.sort = { fieldId: "source_qty", direction: "desc" };
  expect(
    selectionCandidates(event.selection, data, {}, inputs).map(
      (entry) => entry.id,
    ),
  ).toEqual([second.id, first.id]);
  expect(
    selectionCandidates(event.selection, data, {}, inputs, "可用").map(
      (entry) => entry.id,
    ),
  ).toEqual([first.id]);
  event.selection.filters = [
    {
      id: "state_filter",
      sourceFieldId: "source_state",
      operator: "equals",
      source: "field",
      value: "state",
    },
    {
      id: "qty_filter",
      sourceFieldId: "source_qty",
      operator: "greater",
      source: "constant",
      value: "5",
    },
  ];
  expect(
    selectionCandidates(
      event.selection,
      data,
      { state: "target_ready" },
      inputs,
    ),
  ).toEqual([]);
  event.selection.match = "any";
  expect(
    selectionCandidates(
      event.selection,
      data,
      { state: "target_ready" },
      inputs,
    ).map((entry) => entry.id),
  ).toEqual([second.id, first.id]);
  event.selection.filters = event.selection.filters.slice(0, 1);
  expect(
    selectionCandidates(
      event.selection,
      data,
      { state: "target_ready" },
      inputs,
    ).map((entry) => entry.id),
  ).toEqual([first.id]);
  expect(selectionCandidates(event.selection, data, {}, inputs)).toEqual([]);
});
it("one selection converts option identities and dates atomically without network calls; incompatible outputs preserve every original value", async () => {
  const { event, schema, data, first } = await fixture(),
    values = {
      code: "原单",
      qty: 99,
      state: "target_hold",
      date: "2026-01-01",
    };
  const network = vi.spyOn(globalThis, "fetch");
  let run = runFrontendEvent(
    event,
    schema,
    values,
    data,
    undefined,
    false,
    first.id,
  );
  expect(run.status).toBe("success");
  expect(run.mode).toBe("local");
  expect(run.mappedValues).toEqual({
    code: "ORD-甲",
    qty: 2,
    state: "target_ready",
    date: "2026-10-10",
  });
  expect(network).not.toHaveBeenCalled();
  schema.fields.find((field) => field.id === "state")!.options = [];
  run = runFrontendEvent(
    event,
    schema,
    values,
    data,
    undefined,
    false,
    first.id,
  );
  expect(run.status).toBe("failed");
  expect(run.mappedValues).toEqual({});
  const applied = applyFrontendEvents(
    schema,
    values,
    data,
    "field",
    { fieldId: "choose" },
    { [event.id]: first.id },
  );
  expect(applied.values).toEqual(values);
  expect(applied.failures[0]).toContain("选项");
});
it("source child arrays preserve unmapped columns and row identities; protected-column shrink and source arrays into the current row fail explicitly", async () => {
  const { event, schema, data, first } = await fixture();
  event.selection.mappings = [
    { sourceFieldId: "source_cost", targetFieldId: "cost" },
  ];
  const values = {
    lines: [
      { _rowId: "row_a", cost: 1, memo: "保留甲" },
      { _rowId: "row_b", cost: 2, memo: "保留乙" },
      { _rowId: "row_c", cost: 3, memo: "保留丙" },
    ],
  };
  event.selection.subformFill = "merge";
  let run = runFrontendEvent(
    event,
    schema,
    values,
    data,
    undefined,
    false,
    first.id,
  );
  expect(run.mappedValues.lines).toEqual([
    { _rowId: "row_a", cost: 4, memo: "保留甲" },
    { _rowId: "row_b", cost: 6, memo: "保留乙" },
    { _rowId: "row_c", cost: 3, memo: "保留丙" },
  ]);
  event.selection.subformFill = "replace";
  run = runFrontendEvent(
    event,
    schema,
    values,
    data,
    undefined,
    false,
    first.id,
  );
  expect(
    (run.mappedValues.lines as FormValues[]).map((row) => row._rowId),
  ).toEqual(["row_a", "row_b"]);
  schema.fields.find((field) => field.id === "lines")!.children[1]!.editable =
    false;
  expect(
    runFrontendEvent(event, schema, values, data, undefined, false, first.id)
      .mappedValues,
  ).toEqual({});
  const button = schema.fields.shift()!;
  schema.fields.find((field) => field.id === "lines")!.children.push(button);
  run = runFrontendEvent(
    event,
    schema,
    values,
    data,
    { subformId: "lines", index: 1 },
    false,
    first.id,
  );
  expect(run.error?.message).toContain("当前明细行请选择来源主表字段");
  event.selection.mappings = [
    { sourceFieldId: "source_qty", targetFieldId: "cost" },
  ];
  const result = applyFrontendEvents(
    schema,
    values,
    data,
    "field",
    { fieldId: "choose", row: { subformId: "lines", index: 1 } },
    { [event.id]: first.id },
  );
  expect(result.failures).toEqual([]);
  expect(result.values.lines).toEqual([
    values.lines[0],
    { ...values.lines[1], cost: 2 },
    values.lines[2],
  ]);
});
it("runtime opens only on the configured button, cancel preserves inputs and confirmation fills before draft saving and submission", async () => {
  const { schema, first } = await fixture(),
    persist = vi.fn((_values: FormValues, _draft: boolean) => true);
  const host = await mount(FormRuntime, {
    schema,
    formId: "selection_qa",
    initialValues: {
      code: "原单",
      qty: 99,
      state: "target_hold",
      date: "2026-01-01",
      lines: [],
    },
    preview: false,
    persistValues: persist,
  });
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  await click("选择订单");
  expect(document.body.textContent).toContain("ORD-甲");
  await choose("ORD-甲");
  await click("取消");
  expect(input(host, "订单号").value).toBe("原单");
  expect(input(host, "数量").value).toBe("99");
  expect(persist).not.toHaveBeenCalled();
  await click("选择订单");
  await click("确定");
  expect(document.body.textContent).toContain("请选择一条数据");
  await choose("ORD-甲");
  await click("确定");
  expect(input(host, "订单号").value).toBe("ORD-甲");
  expect(input(host, "数量").value).toBe("2");
  await click("保存草稿");
  expect(persist.mock.calls[0]?.[0]).toMatchObject({
    code: "ORD-甲",
    qty: 2,
    state: "target_ready",
  });
  expect(persist.mock.calls[0]?.[0]).not.toHaveProperty("choose");
  expect(persist.mock.calls[0]?.[0]).not.toHaveProperty("_links");
  expect(persist.mock.calls[0]?.[1]).toBe(true);
  await click("提交");
  expect(persist.mock.calls[1]?.[1]).toBe(false);
  expect(host.textContent).toContain("提交成功");
  expect(first.values.source_qty).toBe(2);
});
it("runtime candidates use injected permission-scoped data and recheck source removal or revoked fields while the picker is open", async () => {
  const { schema, data, first } = await fixture(),
    scoped = shallowReactive(copy(data));
  scoped.entries = scoped.entries.filter((entry) => entry.id === first.id);
  const host = await mount(
    FormRuntime,
    {
      schema,
      formId: "selection_qa",
      initialValues: { code: "原单", qty: 99 },
    },
    scoped,
  );
  await click("选择订单");
  expect(document.body.textContent).toContain("ORD-甲");
  expect(document.body.textContent).not.toContain("ORD-乙");
  await choose("ORD-甲");
  delete scoped.entries[0]!.values.source_qty;
  scoped.entries = [...scoped.entries];
  await settle();
  await click("确定");
  expect(document.body.textContent).toContain("所选数据已变化");
  expect(input(host, "数量").value).toBe("99");
  await click("取消");
});
it("schema or member changes while choosing do not apply stale choices or discard current inputs", async () => {
  const { schema, data } = await fixture(),
    props = reactive({
      schema,
      formId: "selection_qa",
      initialValues: { code: "原单", qty: 99 },
    }),
    scoped = shallowReactive(copy(data));
  const host = await mount(FormRuntime, props, scoped);
  await click("选择订单");
  await choose("ORD-甲");
  props.schema.fields.find((field) => field.id === "code")!.label = "订单编号";
  await click("确定");
  expect(document.body.textContent).toContain("表单已变化");
  expect(input(host, "数量").value).toBe("99");
  await click("选择订单");
  await choose("ORD-甲");
  scoped.organization = {
    ...scoped.organization,
    currentUserId: "another_member",
  };
  await click("确定");
  expect(input(host, "数量").value).toBe("99");
});
it("a button with multiple selection events applies nothing until every choice is confirmed, including no effect when the second chooser is cancelled", async () => {
  const { schema, event } = await fixture();
  schema.settings.frontendEvents!.push({
    ...copy(event),
    id: "event_second",
    name: "第二次选数",
    selection: {
      ...copy(event.selection),
      mappings: [{ sourceFieldId: "source_qty", targetFieldId: "qty" }],
    },
  });
  const host = await mount(FormRuntime, {
    schema,
    formId: "selection_qa",
    initialValues: { code: "原单", qty: 99 },
  });
  await click("选择订单");
  await choose("ORD-甲");
  await click("确定");
  expect(input(host, "数量").value).toBe("99");
  await click("取消");
  expect(input(host, "订单号").value).toBe("原单");
  await click("选择订单");
  await choose("ORD-甲");
  await click("确定");
  await choose("ORD-乙");
  await click("确定");
  expect(input(host, "数量").value).toBe("12");
  expect(input(host, "订单号").value).toBe("ORD-甲");
});
it("saved selections pin published settings through reload and reject new publication when a source is archived without changing historical versions or records", async () => {
  const { store, schema, form } = await fixture(),
    target = (await store.createForm("oa", "选数回填验收", "form"))!,
    current = store.openForm(target.id)!;
  current.schema = copy(schema);
  expect(await store.publishForm(current.id)).toBe(true);
  const published = copy(current.versions[0]);
  await store.submitEntry(current.id, {
    code: "原单",
    qty: 99,
    state: "target_hold",
    date: "2026-01-01",
    lines: [],
  });
  const records = copy(store.data.entries);
  setActivePinia(createPinia());
  const fresh = useWorkspaceStore(),
    saved = fresh.openForm(current.id)!;
  expect(saved.schema.settings.frontendEvents).toEqual(
    schema.settings.frontendEvents,
  );
  expect(await fresh.archiveForm(form.id)).toBe(true);
  expect(await fresh.publishForm(saved.id)).toBe(false);
  expect(saved.versions[0]).toEqual(published);
  expect(fresh.data.entries).toEqual(records);
});
async function settle() {
  await nextTick();
  await nextTick();
  await Promise.resolve();
}
async function mount(component: any, props: any, data?: WorkspaceData) {
  const host = document.createElement("div");
  document.body.append(host);
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: "/", component: { render: () => null } }],
  });
  await router.push("/");
  await router.isReady();
  const app = createApp({ render: () => h(component, props) });
  app.use(pinia);
  app.use(router);
  if (data)
    app.provide(
      runtimeDataKey,
      computed(() => data),
    );
  app.mount(host);
  cleanup.push(() => app.unmount());
  await settle();
  return host;
}
function input(host: Element, label: string) {
  return host.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;
}
async function click(label: string) {
  const button = [
    ...document.querySelectorAll<HTMLButtonElement>("button"),
  ].find((button) => {
    for (
      let element: HTMLElement | null = button;
      element;
      element = element.parentElement
    )
      if (element.inert) return false;
    return (
      !button.disabled &&
      (button.textContent?.trim() === label ||
        button.getAttribute("aria-label") === label)
    );
  });
  expect(button, label).toBeTruthy();
  button!.click();
  await settle();
}
async function choose(label: string) {
  const radio = input(document.body, `选择记录 ${label}`);
  expect(radio).toBeTruthy();
  radio.checked = true;
  radio.dispatchEvent(new Event("change", { bubbles: true }));
  await settle();
}
