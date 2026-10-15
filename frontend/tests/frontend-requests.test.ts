import { seedWorkspace } from "./fixtures/workspace";
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
  type FrontendRequest,
} from "@platform/contracts";
import {
  copy,
  createField,
  emptySchema,
  parseSchema,
} from "../src/domain/form";
import {
  newFrontendRequest,
  requestParameterIssues,
} from "../src/domain/frontendRequests";
import {
  applyFrontendEvents,
  frontendEventIssues,
  frontendEventReferences,
  runFrontendEvent,
} from "../src/domain/frontendEvents";

import RequestValueInput from "../src/features/forms/components/RequestValueInput.vue";

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
const constant = (value: string) => ({ source: "constant" as const, value });
const path = (fieldId: string, value: string) => ({
  fieldId,
  path: constant(value),
});
function fixture(overrides: Partial<FrontendRequest> = {}) {
  const schema = emptySchema();
  schema.fields = [
    createField("text", { id: "code", label: "查询编号" }),
    createField("number", { id: "amount", label: "金额" }),
    createField("text", { id: "note", label: "说明" }),
  ];
  const request = {
    ...newFrontendRequest(),
    url: constant("https://example.com/api"),
    outputs: [path("amount", "$.amount")],
    simulation: { status: 200, response: '{"amount":12}' },
    ...overrides,
  };
  const event: FrontendEvent = {
    id: "event_request",
    name: "请求回填",
    description: "",
    enabled: true,
    trigger: "field",
    fieldIds: ["code"],
    request,
  };
  schema.settings.frontendEvents = [event];
  return { schema, event, request, data: seedWorkspace() };
}
it("request configuration round-trips through schema and page projection without changing legacy plugin events; malformed unions and limits reject", () => {
  const { schema, event, request } = fixture();
  expect(parseSchema(copy(schema))).toEqual(schema);
  const split = separateFormSchema(schema);
  expect(composeFormSchema(split.model, split.page)).toEqual(schema);
  for (const value of [
    { ...event, plugin: { actionId: "multiply", inputs: {}, outputs: [] } },
    { ...event, request: { ...request, method: "DELETE" } },
    {
      ...event,
      request: {
        ...request,
        headers: Array.from({ length: 51 }, () => ({
          name: "x",
          value: constant(""),
        })),
      },
    },
    {
      ...event,
      request: { ...request, simulation: { status: 700, response: "{}" } },
    },
    {
      ...event,
      request: {
        ...request,
        outputs: [{ fieldId: "__proto__", path: constant("$") }],
      },
    },
  ])
    expect(
      frontendEventSettingsErrors({
        ...schema.settings,
        frontendEvents: [value] as any,
      }),
    ).not.toEqual([]);
  request.body = [
    { name: "dormant", value: { source: "field", value: "note" } },
  ];
  expect(frontendEventReferences(event)).toContain("note");
  schema.fields = schema.fields.filter((field) => field.id !== "note");
  expect(frontendEventIssues(event, schema)).toEqual([]);
  request.method = "POST";
  expect(frontendEventIssues(event, schema)[0]?.message).toContain("引用字段");
});
it("GET encodes inserted query values, converts choices to names and dates to UTC; POST coerces body values to text in JSON and form payloads with redacted auth and no fetch", () => {
  const { schema, event, request, data } = fixture();
  schema.fields.push(
    createField("checkbox", {
      id: "tags",
      options: [
        { id: "tag_a", label: "甲" },
        { id: "tag_b", label: "乙" },
      ],
    }),
    createField("datetime", { id: "date", format: "date" }),
  );
  request.url = {
    source: "template",
    value: "https://example.com/api?code={{code}}&tags={{tags}}&date={{date}}",
  };
  request.headers = [
    { name: "Authorization", value: constant("demo-key") },
    { name: "X-Code", value: { source: "field", value: "code" } },
  ];
  request.body = [
    { name: "amount", value: { source: "field", value: "amount" } },
  ];
  const network = vi.spyOn(globalThis, "fetch"),
    values = {
      code: "甲 &/",
      tags: ["tag_a", "tag_b"],
      date: "2026-10-10",
      amount: 3,
    };
  let run = runFrontendEvent(event, schema, values, data);
  expect(run.status).toBe("success");
  const url = new URL(String(run.input.url));
  expect(url.searchParams.get("code")).toBe(values.code);
  expect(url.searchParams.get("tags")).toBe("甲,乙");
  expect(url.searchParams.get("date")).toBe(
    new Date("2026-10-10T00:00:00").toISOString(),
  );
  expect(run.input.body).toBeUndefined();
  expect(run.input.headers).toEqual({
    Authorization: "（已隐藏）",
    "X-Code": values.code,
  });
  expect(JSON.stringify(run.input)).not.toContain("demo-key");
  request.method = "POST";
  run = runFrontendEvent(event, schema, values, data);
  expect(run.input.body).toEqual({ amount: "3" });
  request.body[0]!.value = { source: "template", value: "{{amount}}" };
  expect(runFrontendEvent(event, schema, values, data).input.body).toEqual({
    amount: "3",
  });
  request.bodyFormat = "form";
  run = runFrontendEvent(event, schema, values, data);
  expect(run.input.body).toBe("amount=3");
  expect(run.mode).toBe("simulation");
  expect(network).not.toHaveBeenCalled();
  request.url = { source: "template", value: "{{code}}" };
  expect(
    runFrontendEvent(
      event,
      schema,
      { ...values, code: "https://example.com/full" },
      data,
    ).status,
  ).toBe("success");
  request.headers.push({ name: "authorization", value: constant("duplicate") });
  expect(requestParameterIssues(request)[0]?.message).toContain("重复");
});
it("JSONPath handles quoted Chinese keys, filters, slices and wildcard arrays; field values convert through existing option/date/address formats", () => {
  const { schema, event, request, data } = fixture();
  schema.fields.push(
    createField("multiselect", {
      id: "tags",
      options: [
        { id: "a", label: "甲" },
        { id: "b", label: "乙" },
      ],
    }),
    createField("datetime", { id: "date", format: "date" }),
    createField("address", { id: "address" }),
  );
  request.simulation.response = JSON.stringify({
    金额: 15,
    items: [
      { price: 2, title: "甲" },
      { price: 4, title: "乙" },
      { price: 8, title: "丙" },
    ],
    date: "2026-10-10",
    address: {
      province: "浙江",
      city: "杭州",
      district: "余杭",
      detail: "测试地址",
    },
  });
  request.outputs = [
    path("amount", "$['金额']"),
    path("note", "$.items[?@.price == 4].title[0]"),
  ];
  // A plural selector must not silently pick its first match for a scalar field.
  expect(runFrontendEvent(event, schema, { code: "x" }, data).status).toBe(
    "failed",
  );
  request.outputs = [
    path("amount", "$['金额']"),
    path("tags", "$.items[:2].title"),
    path("date", "$.date"),
    path("address", "$.address"),
  ];
  const run = runFrontendEvent(event, schema, { code: "x" }, data);
  expect(run.status).toBe("success");
  expect(run.mappedValues).toEqual({
    amount: 15,
    tags: ["a", "b"],
    date: "2026-10-10",
    address: {
      province: "浙江",
      city: "杭州",
      district: "余杭",
      detail: "测试地址",
    },
  });
  request.outputs = [path("tags", "$.items[?@.price < 5].title")];
  expect(
    runFrontendEvent(event, schema, { code: "x" }, data).mappedValues.tags,
  ).toEqual(["a", "b"]);
  schema.fields.find((field) => field.id === "tags")!.type = "checkbox";
  request.simulation.response = '{"tags":["乙","甲"]}';
  request.outputs = [path("tags", "$.tags")];
  expect(
    runFrontendEvent(event, schema, { code: "x" }, data).mappedValues.tags,
  ).toEqual(["a", "b"]);
});
it("XML uses native XPath for text, attributes and numbers; malformed content, paths, HTTP errors and oversized UTF8 fail without partial writes", () => {
  const { schema, event, request, data } = fixture({
    responseFormat: "xml",
    simulation: {
      status: 200,
      response:
        '<result code="测试"><amount>15</amount><note>完成</note></result>',
    },
    outputs: [
      path("amount", "number(/result/amount)"),
      path("note", "/result/@code"),
    ],
  });
  let run = runFrontendEvent(event, schema, { code: "x" }, data);
  expect(run.mappedValues).toEqual({ amount: 15, note: "测试" });
  expect(run.status).toBe("success");
  request.outputs[1] = path("note", "/result/note/text()");
  expect(
    runFrontendEvent(event, schema, { code: "x" }, data).mappedValues.note,
  ).toBe("完成");
  for (const response of [
    "<result>",
    '<!DOCTYPE result [<!ENTITY a SYSTEM "https://example.com/entity">]><result>&a;</result>',
    "汉".repeat(90000),
  ]) {
    request.simulation.response = response;
    run = runFrontendEvent(
      event,
      schema,
      { code: "x", amount: 8, note: "原值" },
      data,
    );
    expect(run.status).toBe("failed");
    expect(run.mappedValues).toEqual({});
  }
  request.responseFormat = "json";
  request.outputs = [path("amount", "$.amount")];
  request.simulation = { status: 500, response: '{"amount":20}' };
  expect(
    runFrontendEvent(event, schema, { code: "x" }, data).error?.message,
  ).toContain("500");
  request.simulation = { status: 200, response: '{"amount":20}' };
  request.outputs = [path("amount", "$.amount"), path("note", "$.missing")];
  const result = applyFrontendEvents(
    schema,
    { code: "x", amount: 8, note: "原值" },
    data,
    "field",
    { fieldId: "code" },
  );
  expect(result.values).toEqual({ code: "x", amount: 8, note: "原值" });
  expect(result.failures).toHaveLength(1);
});
function detailFixture() {
  const result = fixture({
    outputs: [
      path("amount", "$.amount"),
      path("detail_qty", "$.items[*].quantity"),
    ],
    simulation: {
      status: 200,
      response: '{"amount":16,"items":[{"quantity":3},{"quantity":4}]}',
    },
  });
  result.schema.fields.push(
    createField("subform", {
      id: "lines",
      label: "明细",
      children: [
        createField("number", { id: "detail_qty", label: "数量" }),
        createField("text", { id: "detail_note", label: "备注" }),
      ],
    }),
  );
  return result;
}
it("main-trigger arrays merge or resize detail rows, preserving unrelated columns and row identities, and refuse shrinking protected rows", () => {
  const { schema, event, request, data } = detailFixture();
  const values = {
    code: "x",
    amount: 9,
    lines: [
      { _rowId: "row_a", detail_qty: 1, detail_note: "甲" },
      { _rowId: "row_b", detail_qty: 2, detail_note: "乙" },
      { _rowId: "row_c", detail_qty: 8, detail_note: "丙" },
    ],
  };
  let result = applyFrontendEvents(schema, values, data, "field", {
    fieldId: "code",
  });
  expect(result.failures).toEqual([]);
  expect(result.values.lines).toEqual([
    { _rowId: "row_a", detail_qty: 3, detail_note: "甲" },
    { _rowId: "row_b", detail_qty: 4, detail_note: "乙" },
    { _rowId: "row_c", detail_qty: 8, detail_note: "丙" },
  ]);
  expect(values.lines[0]!.detail_qty).toBe(1);
  request.subformFill = "replace";
  result = applyFrontendEvents(schema, values, data, "field", {
    fieldId: "code",
  });
  expect((result.values.lines as any[]).length).toBe(2);
  expect((result.values.lines as any[])[1]).toEqual({
    _rowId: "row_b",
    detail_qty: 4,
    detail_note: "乙",
  });
  schema.fields[3]!.children[1]!.editable = false;
  result = applyFrontendEvents(schema, values, data, "field", {
    fieldId: "code",
  });
  expect(result.values).toEqual(values);
  expect(result.failures[0]).toContain("不能缩减");
  schema.fields[3]!.children[1]!.editable = true;
  request.simulation.response = '{"amount":16,"items":[]}';
  expect(
    runFrontendEvent(event, schema, values, data).mappedValues.lines as any[],
  ).toEqual([]);
  const detail = schema.fields.pop()!;
  schema.fields.push(
    createField("tabs", { id: "container", children: [detail] }),
  );
  schema.settings.rules = [
    {
      id: "hide_detail",
      match: "all",
      conditions: [{ sourceId: "code", operator: "equals", value: "show" }],
      targetIds: ["container"],
    },
  ];
  request.subformFill = "merge";
  request.simulation.response = '{"amount":16,"items":[{"quantity":3}]}';
  result = applyFrontendEvents(schema, values, data, "field", {
    fieldId: "code",
  });
  expect(result.values).toEqual(values);
  expect(result.failures[0]).toContain("不可编辑");
});
it("detail-trigger requests only update the current row and ancestor visibility and input/output permissions prevent data leaks", () => {
  const { schema, event, request, data } = detailFixture();
  event.fieldIds = ["detail_note"];
  request.url = {
    source: "template",
    value: "https://example.com?q={{detail_note}}",
  };
  request.outputs = [path("detail_qty", "$.amount")];
  const values = {
    lines: [
      { _rowId: "a", detail_note: "甲", detail_qty: 2 },
      { _rowId: "b", detail_note: "乙", detail_qty: 5 },
    ],
  };
  let result = applyFrontendEvents(schema, values, data, "field", {
    fieldId: "detail_note",
    row: { subformId: "lines", index: 1 },
  });
  expect((result.values.lines as any[])[0]).toEqual(values.lines[0]);
  expect((result.values.lines as any[])[1]).toEqual({
    _rowId: "b",
    detail_note: "乙",
    detail_qty: 16,
  });
  schema.fields[3]!.children[0]!.editable = false;
  expect(
    runFrontendEvent(event, schema, values, data, {
      subformId: "lines",
      index: 1,
    }).mappedValues,
  ).toEqual({});
  schema.fields[3]!.children[0]!.editable = true;
  schema.fields[3]!.children[1]!.visible = false;
  const blocked = runFrontendEvent(event, schema, values, data, {
    subformId: "lines",
    index: 1,
  });
  expect(blocked.input).toEqual({});
  expect(JSON.stringify(blocked)).not.toContain('"乙"');
  schema.fields[3]!.children[1]!.visible = true;
  schema.fields[3]!.visible = false;
  result = applyFrontendEvents(schema, values, data, "field", {
    fieldId: "detail_note",
    row: { subformId: "lines", index: 0 },
  });
  expect(result.runs).toHaveLength(0);
});
it("invalid numeric/date/option values and dynamic path syntax do not write any output", () => {
  const { schema, event, request, data } = fixture();
  schema.fields.push(
    createField("datetime", { id: "date", format: "date" }),
    createField("select", {
      id: "state",
      options: [{ id: "ok", label: "完成" }],
    }),
  );
  for (const sample of [
    { amount: " " },
    { amount: "Infinity" },
    { amount: false },
  ]) {
    request.simulation.response = JSON.stringify(sample);
    expect(
      runFrontendEvent(event, schema, { code: "x" }, data).mappedValues,
    ).toEqual({});
  }
  request.outputs = [path("amount", "$.amount"), path("date", "$.date")];
  request.simulation.response = '{"amount":3,"date":"2026-02-30T00:00:00Z"}';
  expect(
    runFrontendEvent(event, schema, { code: "x" }, data).mappedValues,
  ).toEqual({});
  request.simulation.response = '{"amount":3,"date":"2026-10-10garbage"}';
  expect(
    runFrontendEvent(event, schema, { code: "x" }, data).mappedValues,
  ).toEqual({});
  request.outputs = [path("state", "$.state")];
  request.simulation.response = '{"state":"不存在"}';
  expect(
    runFrontendEvent(event, schema, { code: "x" }, data).error?.message,
  ).toContain("选项不存在");
  request.outputs = [
    {
      fieldId: "amount",
      path: { source: "template", value: "$.items[{{code}}].amount" },
    },
  ];
  request.simulation.response = '{"items":[{"amount":3}]}';
  expect(
    runFrontendEvent(event, schema, { code: "0" }, data).mappedValues.amount,
  ).toBe(3);
  expect(
    runFrontendEvent(event, schema, { code: "a]坏路径" }, data).mappedValues,
  ).toEqual({});
});
it("field insertion shows business labels while preserving stable references and duplicates, with no storage identifiers in editable text", async () => {
  const state = reactive({
    binding: {
      source: "template" as const,
      value: "https://example.com?q={{code}}",
    },
    fields: [
      createField("text", { id: "code", label: "编号" }),
      createField("text", { id: "other", label: "编号" }),
    ],
  });
  const host = await mount(RequestValueInput, {
    get modelValue() {
      return state.binding;
    },
    get fields() {
      return state.fields;
    },
    label: "URL",
    rows: 3,
    "onUpdate:modelValue": (value: any) => (state.binding = value),
  });
  expect(input(host, "URL").value).toBe("https://example.com?q={{编号}}");
  state.fields[0]!.label = "查询编号";
  await settle();
  expect(input(host, "URL").value).toContain("{{查询编号}}");
  await set(
    input(host, "URL"),
    "https://example.com?q={{查询编号}}&other={{编号}}",
    "input",
  );
  expect(state.binding.value).toBe(
    "https://example.com?q={{code}}&other={{other}}",
  );
  expect(input(host, "URL").value).not.toContain("{{code}}");
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
async function click(label: string, index = 0) {
  const buttons = [
    ...document.querySelectorAll<HTMLButtonElement>("button"),
  ].filter((button) => {
    for (let el: HTMLElement | null = button; el; el = el.parentElement)
      if (el.inert) return false;
    return (
      (button.textContent?.trim() === label ||
        button.getAttribute("aria-label") === label) &&
      !button.disabled
    );
  });
  expect(buttons[index]).toBeTruthy();
  buttons[index]!.click();
  await settle();
}
