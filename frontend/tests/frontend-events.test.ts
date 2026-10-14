// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApp, h, nextTick, reactive } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { createMemoryHistory, createRouter } from "vue-router";
import {
  composeFormSchema,
  separateFormSchema,
  frontendEventSettingsErrors,
  type FrontendEvent,
} from "@platform/contracts";
import {
  copy,
  createField,
  emptySchema,
  parseSchema,
} from "../src/domain/form";
import {
  applyFrontendEvents,
  frontendEventIssues,
  frontendEventScope,
  frontendEventOutputFields,
  frontendTriggerFields,
  frontendEventReferences,
  frontendEventsIssues,
  runFrontendEvent,
} from "../src/domain/frontendEvents";
import { newFrontendRequest } from "../src/domain/frontendRequests";
import { seedWorkspace } from "../src/domain/workspace";
import FormRuntime from "../src/features/forms/components/FormRuntime.vue";

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
type PluginEvent = Extract<FrontendEvent, { plugin: unknown }>;
const event = (overrides: Partial<PluginEvent> = {}): PluginEvent => ({
  id: "event_calc",
  name: "计算金额",
  description: "",
  enabled: true,
  trigger: "field",
  fieldIds: ["qty", "price"],
  plugin: {
    actionId: "multiply",
    inputs: {
      quantity: { source: "field", value: "qty" },
      price: { source: "field", value: "price" },
    },
    outputs: [{ outputKey: "amount", fieldId: "amount" }],
  },
  ...overrides,
});
function fixture() {
  const schema = emptySchema();
  schema.fields = [
    createField("number", { id: "qty", label: "数量" }),
    createField("number", { id: "price", label: "单价" }),
    createField("number", { id: "amount", label: "金额" }),
    createField("text", { id: "note", label: "说明" }),
  ];
  schema.settings.frontendEvents = [event()];
  return schema;
}
it("events survive schema/page projection, rejecting malformed or excessive configuration without losing references", () => {
  const schema = fixture();
  expect(parseSchema(copy(schema))).toEqual(schema);
  const split = separateFormSchema(schema);
  expect(composeFormSchema(split.model, split.page)).toEqual(schema);
  expect(parseSchema(emptySchema()).settings.frontendEvents).toBeUndefined();
  const invalid = [
    null,
    {},
    [null],
    [event(), event()],
    Array.from({ length: 101 }, (_, index) => event({ id: `event_${index}` })),
    [event({ enabled: "true" as any })],
    [event({ fieldIds: ["qty", "qty"] })],
    [
      event({
        plugin: {
          ...event().plugin,
          outputs: [{ outputKey: "__proto__", fieldId: "amount" }],
        },
      }),
    ],
    [event({ extra: true } as any)],
  ];
  for (const events of invalid) {
    expect(
      frontendEventsIssues({
        ...schema,
        settings: { ...schema.settings, frontendEvents: events },
      } as any).length,
    ).toBeGreaterThan(0);
    expect(() =>
      parseSchema({
        ...schema,
        settings: { ...schema.settings, frontendEvents: events },
      }),
    ).toThrow(/前端事件/);
  }
  expect(
    frontendEventSettingsErrors({
      ...schema.settings,
      frontendEvents: [
        event({ trigger: "submit", fieldIds: [] }),
        event({
          id: "event_other",
          trigger: "submit",
          fieldIds: [],
          enabled: false,
        }),
      ],
    }),
  ).toEqual(["每张表单只能配置一个提交触发事件"]);
  const removed = fixture();
  removed.fields = removed.fields.filter((field) => field.id !== "price");
  expect(parseSchema(removed).settings.frontendEvents).toEqual(
    schema.settings.frontendEvents,
  );
  expect(
    frontendEventIssues(event(), removed).some((issue) =>
      /触发字段|引用字段/.test(issue.message),
    ),
  ).toBe(true);
  expect(frontendEventReferences(event())).toContain("amount");
});
it("only a manual trigger executes enabled events; inputs use the edited snapshot and output does not start a chain", () => {
  const schema = fixture(),
    data = seedWorkspace();
  const values = { qty: 3, price: 5, amount: 1, note: "保留" };
  schema.settings.frontendEvents!.push(
    event({
      id: "event_chain",
      fieldIds: ["amount"],
      plugin: {
        actionId: "update",
        inputs: { text: { source: "constant", value: "不应触发" } },
        outputs: [{ outputKey: "value", fieldId: "note" }],
      },
    }),
  );
  const result = applyFrontendEvents(schema, values, data, "field", {
    fieldId: "qty",
  });
  expect(result.values).toEqual({ ...values, amount: 15 });
  expect(result.runs).toHaveLength(1);
  expect(values.amount).toBe(1);
  expect(
    applyFrontendEvents(schema, values, data, "field", { fieldId: "note" })
      .runs,
  ).toHaveLength(0);
  schema.settings.frontendEvents![0]!.enabled = false;
  expect(
    applyFrontendEvents(schema, values, data, "field", { fieldId: "qty" })
      .values,
  ).toEqual(values);
});
it("ordered events resolve overlapping outputs without changing the inputs seen by later events", () => {
  const schema = fixture(),
    values = { qty: 3, price: 5, amount: 1 };
  schema.settings.frontendEvents!.push(
    event({
      id: "event_second",
      plugin: {
        actionId: "multiply",
        inputs: {
          quantity: { source: "field", value: "amount" },
          price: { source: "constant", value: "2" },
        },
        outputs: [{ outputKey: "amount", fieldId: "amount" }],
      },
    }),
  );
  expect(
    applyFrontendEvents(schema, values, seedWorkspace(), "field", {
      fieldId: "qty",
    }).values.amount,
  ).toBe(2);
  schema.settings.frontendEvents!.reverse();
  expect(
    applyFrontendEvents(schema, values, seedWorkspace(), "field", {
      fieldId: "qty",
    }).values.amount,
  ).toBe(15);
});
it("subform edits fill only the triggering row and retain other columns and row identities", () => {
  const schema = fixture();
  schema.fields = [
    createField("tabs", {
      id: "tabs",
      children: [
        createField("subform", {
          id: "lines",
          label: "明细",
          children: schema.fields,
        }),
      ],
    }),
  ];
  const values = {
    lines: [
      { _rowId: "row_a", qty: 2, price: 4, amount: 1, note: "甲" },
      { _rowId: "row_b", qty: 3, price: 5, amount: 2, note: "乙" },
    ],
  };
  const result = applyFrontendEvents(schema, values, seedWorkspace(), "field", {
    fieldId: "qty",
    row: { subformId: "lines", index: 1 },
  });
  expect(result.failures).toEqual([]);
  expect(result.values.lines).toEqual([
    values.lines[0],
    { ...values.lines[1], amount: 15 },
  ]);
  expect(
    applyFrontendEvents(schema, values, seedWorkspace(), "field", {
      fieldId: "qty",
      row: { subformId: "lines", index: 3 },
    }).failures.join(),
  ).toMatch(/行已不存在/);
});
it("effective readonly/hidden field and container permissions prevent writes and hidden reads leave no input trace", () => {
  const data = seedWorkspace(),
    values = { qty: 2, price: 99, amount: 7 };
  for (const restriction of ["readonly", "hidden"]) {
    const schema = fixture();
    if (restriction === "readonly") schema.fields[2]!.editable = false;
    else schema.fields[2]!.visible = false;
    const result = applyFrontendEvents(schema, values, data, "field", {
      fieldId: "qty",
    });
    expect(result.values).toEqual(values);
    expect(result.failures.join()).toMatch(/不可编辑/);
  }
  const schema = fixture();
  schema.fields[1]!.visible = false;
  const result = applyFrontendEvents(schema, values, data, "field", {
    fieldId: "qty",
  });
  expect(result.values.amount).toBe(7);
  expect(result.runs[0]!.input).toEqual({});
  expect(result.runs[0]!.snapshot.values).toEqual({});
  const nested = fixture();
  nested.fields = [
    createField("subform", {
      id: "lines",
      editable: false,
      children: nested.fields,
    }),
  ];
  expect(
    applyFrontendEvents(nested, { lines: [values] }, data, "field", {
      fieldId: "qty",
      row: { subformId: "lines", index: 0 },
    }).runs,
  ).toHaveLength(0);
});
it("local execution failure preserves all output fields; external plugin trial remains explicitly simulated", () => {
  const schema = fixture(),
    data = seedWorkspace();
  const result = applyFrontendEvents(
    schema,
    { qty: "错误", price: 5, amount: 8 },
    data,
    "field",
    { fieldId: "qty" },
  );
  expect(result.values.amount).toBe(8);
  expect(result.failures.join()).toMatch(/有效数字/);
  const plugin = event({
    plugin: {
      actionId: "webhook",
      inputs: {
        url: { source: "constant", value: "https://example.com/api" },
        body: { source: "constant", value: '{"sample":true}' },
      },
      outputs: [{ outputKey: "statusCode", fieldId: "amount" }],
    },
  });
  const request = vi.spyOn(globalThis, "fetch");
  const run = runFrontendEvent(plugin, schema, {}, data);
  expect(run.mode).toBe("simulation");
  expect(run.output.statusCode).toBe(200);
  expect(request).not.toHaveBeenCalled();
  const failure = runFrontendEvent(
    event(),
    schema,
    { qty: 1, price: 2 },
    data,
    undefined,
    true,
  );
  expect(failure.status).toBe("failed");
  expect(failure.mappedValues).toEqual({});
});
it("preview reacts to manual controls without executing events during initialization", async () => {
  const schema = fixture();
  schema.fields[0]!.defaultValue = 1;
  schema.fields[1]!.defaultValue = 5;
  schema.fields[2]!.defaultValue = 7;
  const props = reactive({
    schema,
    formId: "qa",
  });
  const host = await mount(FormRuntime, props);
  expect(input(host, "金额").value).toBe("7");
  await set(input(host, "数量"), "3", "input");
  expect(input(host, "金额").value).toBe("15");
  props.schema.fields[2]!.editable = false;
  await set(input(host, "数量"), "4", "input");
  expect(input(host, "金额").value).toBe("15");
  expect(host.textContent).toContain("不可编辑");
});
it("actual subform control forwards the edited child and row rather than triggering computed sibling changes", async () => {
  const schema = fixture();
  schema.fields = [
    createField("subform", {
      id: "lines",
      label: "明细",
      children: schema.fields,
      defaultRows: [
        { qty: 1, price: 5, amount: 7 },
        { qty: 2, price: 3, amount: 8 },
      ],
    }),
  ];
  const host = await mount(FormRuntime, {
    schema,
    formId: "qa",
  });
  await set(input(host, "明细 第2行 数量"), "4", "input");
  expect(input(host, "明细 第1行 金额").value).toBe("7");
  expect(input(host, "明细 第2行 金额").value).toBe("12");
});

function buttonFixture() {
  const schema = fixture();
  schema.fields.push(
    createField("button", {
      id: "calculate",
      label: "计算金额",
      buttonText: "计算金额",
    }),
  );
  schema.settings.frontendEvents = [event({ fieldIds: ["calculate"] })];
  return schema;
}
it("button activation reuses field events without adding a data value or exposing buttons as action inputs and outputs", () => {
  const schema = buttonFixture(),
    configured = schema.settings.frontendEvents![0]!;
  expect(frontendTriggerFields(schema).map((field) => field.id)).toContain(
    "calculate",
  );
  expect(
    frontendEventScope(schema, configured).fields.map((field) => field.id),
  ).not.toContain("calculate");
  expect(
    frontendEventOutputFields(schema, configured).map((field) => field.id),
  ).not.toContain("calculate");
  const values = { qty: 2, price: 5, amount: 99 };
  const result = applyFrontendEvents(schema, values, seedWorkspace(), "field", {
    fieldId: "calculate",
  });
  expect(result.values).toEqual({ ...values, amount: 10 });
  expect(result.failures).toEqual([]);
  expect(result.runs).toHaveLength(1);
  const invalid = event({
    fieldIds: configured.fieldIds,
    plugin: {
      ...event().plugin,
      inputs: {
        ...event().plugin.inputs,
        quantity: { source: "field", value: "calculate" },
      },
    },
  });
  expect(frontendEventIssues(invalid, schema).length).toBeGreaterThan(0);
  schema.fields = schema.fields.filter((field) => field.id !== "calculate");
  expect(frontendEventReferences(configured)).toContain("calculate");
  expect(frontendEventIssues(configured, schema)[0]?.message).toMatch(
    /触发字段/,
  );
});
it("preview buttons require a configured enabled event and execute only on click", async () => {
  const schema = buttonFixture();
  schema.fields[0]!.defaultValue = 3;
  schema.fields[1]!.defaultValue = 5;
  schema.fields[2]!.defaultValue = 7;
  const props = reactive({
    schema,
    formId: "qa",
  });
  const host = await mount(FormRuntime, props);
  const button = () =>
    host.querySelector<HTMLButtonElement>('[aria-label="计算金额"]')!;
  expect(input(host, "金额").value).toBe("7");
  await set(input(host, "数量"), "4", "input");
  expect(input(host, "金额").value).toBe("7");
  props.schema.settings.frontendEvents![0]!.enabled = false;
  await settle();
  expect(button().disabled).toBe(true);
  expect(button().title).toBe("尚未配置前端事件");
  await click("计算金额");
  expect(input(host, "金额").value).toBe("7");
  props.schema.settings.frontendEvents![0]!.enabled = true;
  await settle();
  await click("计算金额");
  expect(input(host, "金额").value).toBe("20");
});
it("button controls nested in tabs and detail rows forward current-row context, retaining other rows and rejecting cross-scope output", async () => {
  const schema = buttonFixture(),
    tab = createField("tabs", { id: "tabs" });
  tab.children = [
    createField("subform", {
      id: "lines",
      label: "明细",
      tabId: tab.tabs[0]!.id,
      children: schema.fields,
    }),
  ];
  schema.fields = [tab];
  const values = {
    lines: [
      { _rowId: "a", qty: 1, price: 2, amount: 99 },
      { _rowId: "b", qty: 3, price: 4, amount: 88 },
    ],
  };
  tab.children[0]!.defaultRows = values.lines;
  const host = await mount(FormRuntime, {
    schema,
    formId: "qa",
  });
  await click("明细 第2行 计算金额");
  expect(input(host, "明细 第1行 金额").value).toBe("99");
  expect(input(host, "明细 第2行 金额").value).toBe("12");
  const result = applyFrontendEvents(schema, values, seedWorkspace(), "field", {
    fieldId: "calculate",
    row: { subformId: "lines", index: 1 },
  });
  expect(result.values.lines).toEqual([
    values.lines[0],
    { ...values.lines[1], amount: 12 },
  ]);
  expect(
    applyFrontendEvents(schema, values, seedWorkspace(), "field", {
      fieldId: "calculate",
    }).runs,
  ).toHaveLength(0);
  const configured = schema.settings.frontendEvents![0]!;
  schema.fields.push(createField("number", { id: "parentAmount" }));
  configured.plugin!.outputs = [
    { outputKey: "amount", fieldId: "parentAmount" },
  ];
  expect(
    frontendEventIssues(configured, schema).some((issue) =>
      /同一子表单/.test(issue.message),
    ),
  ).toBe(true);
});
it("hidden and readonly buttons or containers cannot execute; restricted output columns fail atomically", async () => {
  const values = { qty: 3, price: 4, amount: 88 },
    data = seedWorkspace();
  for (const restriction of [
    "hidden",
    "readonly",
    "hidden-container",
    "readonly-container",
  ]) {
    const schema = buttonFixture();
    if (restriction.endsWith("container"))
      schema.fields = [
        createField("tabs", {
          id: "restricted",
          visible: restriction !== "hidden-container",
          editable: restriction !== "readonly-container",
          children: schema.fields,
        }),
      ];
    else {
      schema.fields[4]!.visible = restriction !== "hidden";
      schema.fields[4]!.editable = restriction !== "readonly";
    }
    expect(
      applyFrontendEvents(schema, values, data, "field", {
        fieldId: "calculate",
      }).runs,
    ).toHaveLength(0);
  }
  const schema = buttonFixture();
  schema.fields[2]!.editable = false;
  schema.fields[0]!.defaultValue = values.qty;
  schema.fields[1]!.defaultValue = values.price;
  schema.fields[2]!.defaultValue = values.amount;
  const host = await mount(FormRuntime, {
    schema,
    formId: "qa",
  });
  await click("计算金额");
  expect(input(host, "金额").value).toBe("88");
  expect(host.textContent).toContain("不可编辑");
});
it("button-triggered requests use the same simulated adapter, retaining current-row values and preserving all values on failure", async () => {
  const schema = buttonFixture(),
    request = newFrontendRequest();
  request.url = {
    source: "template",
    value: "https://example.com/api?qty={{qty}}",
  };
  request.outputs = [
    { fieldId: "amount", path: { source: "constant", value: "$.amount" } },
  ];
  request.simulation.response = '{"amount":42}';
  const {
    plugin: _plugin,
    request: _request,
    selection: _selection,
    ...base
  } = schema.settings.frontendEvents![0]!;
  schema.settings.frontendEvents = [{ ...base, request }];
  const fetch = vi.spyOn(globalThis, "fetch");
  schema.fields[0]!.defaultValue = 3;
  schema.fields[1]!.defaultValue = 4;
  schema.fields[2]!.defaultValue = 88;
  const host = await mount(FormRuntime, {
    schema,
    formId: "qa",
  });
  await click("计算金额");
  expect(input(host, "金额").value).toBe("42");
  expect(fetch).not.toHaveBeenCalled();
  request.simulation.response = '{"amount":"invalid"}';
  schema.fields = [
    createField("subform", { id: "lines", children: schema.fields }),
  ];
  const values = { lines: [{ _rowId: "a", qty: 2, price: 4, amount: 88 }] };
  const result = applyFrontendEvents(schema, values, seedWorkspace(), "field", {
    fieldId: "calculate",
    row: { subformId: "lines", index: 0 },
  });
  expect(result.values).toEqual(values);
  expect(result.failures.join()).toMatch(/有效数字/);
  request.simulation.response = '{"amount":21}';
  const valid = applyFrontendEvents(schema, values, seedWorkspace(), "field", {
    fieldId: "calculate",
    row: { subformId: "lines", index: 0 },
  });
  expect(valid.failures).toEqual([]);
  expect(valid.values.lines).toEqual([{ ...values.lines[0], amount: 21 }]);
  expect(valid.runs[0]!.input.url).toContain("qty=2");
  expect(fetch).not.toHaveBeenCalled();
});
async function settle() {
  await nextTick();
  await nextTick();
  await Promise.resolve();
}
async function mount(component: any, props: any) {
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
  app.mount(host);
  cleanup.push(() => app.unmount());
  await settle();
  return host;
}
function input(host: Element, label: string) {
  return host.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;
}
async function set(
  element: HTMLInputElement | HTMLSelectElement,
  value: string,
  event: string,
) {
  expect(element).toBeTruthy();
  element.value = value;
  element.dispatchEvent(new Event(event, { bubbles: true }));
  await settle();
}
async function click(label: string) {
  const buttons = [
    ...document.querySelectorAll<HTMLButtonElement>("button"),
  ].filter((button) => {
    for (
      let element: HTMLElement | null = button;
      element;
      element = element.parentElement
    )
      if (element.inert) return false;
    return true;
  });
  const button = buttons.find(
    (button) =>
      button.getAttribute("aria-label") === label ||
      button.textContent?.trim() === label,
  )!;
  expect(button).toBeTruthy();
  button.focus();
  button.click();
  await settle();
}
