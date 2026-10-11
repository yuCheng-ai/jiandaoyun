import { expect, it } from "vitest";
import type { FrontendEvent } from "@platform/contracts";
import {
  copy,
  createField,
  emptySchema,
  type FormValues,
} from "../src/domain/form";
import { seedWorkspace } from "../src/domain/workspace";
import { createRelationDemo } from "../src/domain/relationDemo";
import { newFrontendRequest } from "../src/domain/frontendRequests";
import { newFrontendSelection } from "../src/domain/frontendSelections";
import {
  applyFrontendEvents,
  runFrontendEvent,
} from "../src/domain/frontendEvents";
import {
  frontendValueFields,
  mapFrontendValues,
} from "../src/domain/frontendEventValues";

it("fills members with their department in root or detail scope without requiring a mapping order", () => {
  for (const detail of [false, true]) {
    const data = seedWorkspace(),
      schema = emptySchema();
    const department = createField("department", { id: "department" });
    const person = createField("member", { id: "person" });
    person.organization.scope.mode = "fieldDepartment";
    person.organization.scope.fieldId = department.id;
    const fields = [person, department];
    schema.fields = detail
      ? [createField("subform", { id: "lines", children: fields })]
      : fields;
    const values: FormValues = detail
      ? { lines: [{ person: "zhang", department: "product" }] }
      : { person: "zhang", department: "product" };
    const before = copy(values);
    const mapped = mapFrontendValues(
      schema,
      values,
      data,
      frontendValueFields(schema),
      [
        { fieldId: "person", value: detail ? ["wang", "zhao"] : "wang" },
        {
          fieldId: "department",
          value: detail ? ["engineering", "finance"] : "engineering",
        },
      ],
      "replace",
    );
    expect(
      detail
        ? (mapped.lines as FormValues[]).map((r) => [r.person, r.department])
        : [mapped.person, mapped.department],
    ).toEqual(
      detail
        ? [
            ["wang", "engineering"],
            ["zhao", "finance"],
          ]
        : ["wang", "engineering"],
    );
    expect(values).toEqual(before);
    expect(() =>
      mapFrontendValues(
        schema,
        values,
        data,
        frontendValueFields(schema),
        [
          { fieldId: "person", value: detail ? ["wang"] : "wang" },
          { fieldId: "department", value: detail ? ["product"] : "product" },
        ],
        "replace",
      ),
    ).toThrow("不在当前可选范围");
    expect(values).toEqual(before);
  }
});

function fixture(detail = false, rootFilter = false) {
  const data = seedWorkspace(),
    demo = createRelationDemo("oa");
  data.forms.push(...demo.forms);
  data.entries.push(...demo.entries);
  const source = demo.forms[0]!,
    order = demo.forms[1]!;
  const region = copy(order.schema.fields.find((f) => f.label === "业务区域")!);
  const customer = copy(
    order.schema.fields.find((f) => f.label === "客户简称（动态选项）")!,
  );
  const button = createField("button", { id: "choose", label: "选择客户" });
  const memo = createField("text", { id: "memo", label: "备注" });
  const schema = emptySchema();
  schema.fields = detail
    ? [
        ...(rootFilter ? [region] : []),
        createField("subform", {
          id: "lines",
          label: "明细",
          children: [button, ...(!rootFilter ? [region] : []), customer, memo],
        }),
      ]
    : [button, region, customer, memo];
  const base = {
    id: "fill",
    name: "回填客户",
    description: "",
    enabled: true,
    trigger: "field" as const,
    fieldIds: ["choose"],
  };
  const sourceRegion = source.schema.fields.find(
    (f) => f.label === "所在区域",
  )!;
  const sourceName = source.schema.fields.find((f) => f.label === "客户名称")!;
  const selection: FrontendEvent = {
    ...base,
    selection: {
      ...newFrontendSelection(),
      formId: source.id,
      columns: [sourceName.id, sourceRegion.id],
      mappings: [
        { sourceFieldId: sourceName.id, targetFieldId: customer.id },
        { sourceFieldId: sourceRegion.id, targetFieldId: region.id },
      ],
    },
  };
  const request: FrontendEvent = {
    ...base,
    request: {
      ...newFrontendRequest(),
      url: { source: "constant", value: "https://example.com/customers" },
      outputs: [
        {
          fieldId: customer.id,
          path: { source: "constant", value: "$.customer" },
        },
        { fieldId: region.id, path: { source: "constant", value: "$.region" } },
      ],
      simulation: {
        status: 200,
        response: JSON.stringify({ region: "华南", customer: "南屿科技" }),
      },
    },
  };
  const row = {
    _rowId: "row_a",
    [region.id]: "east",
    [customer.id]: "青禾设计",
    memo: "保留",
  };
  const values: FormValues = detail
    ? {
        ...(rootFilter ? { [region.id]: "east" } : {}),
        lines: [copy(row), { ...copy(row), _rowId: "row_b", memo: "另一行" }],
      }
    : copy(row);
  return {
    data,
    schema,
    region,
    customer,
    selection,
    request,
    values,
    selected: demo.entries[1]!,
  };
}

it.each(["request", "selection"] as const)(
  "%s fills a category and its dependent option regardless of mapping order, without discarding unmapped values",
  (kind) => {
    const f = fixture(),
      event = f[kind];
    f.schema.settings.frontendEvents = [event];
    for (const reverse of [false, true]) {
      if (reverse)
        (event.request?.outputs || event.selection!.mappings).reverse();
      const result = applyFrontendEvents(
        f.schema,
        f.values,
        f.data,
        "field",
        { fieldId: "choose" },
        { [event.id]: f.selected.id },
      );
      expect(result.failures).toEqual([]);
      expect(result.values).toEqual({
        ...f.values,
        [f.region.id]: "south",
        [f.customer.id]: "南屿科技",
      });
      expect(f.values[f.region.id]).toBe("east");
    }
  },
);

it("an option that belongs to the old category rejects the whole request instead of succeeding and clearing the option", () => {
  const f = fixture();
  f.request.request!.simulation.response = JSON.stringify({
    region: "华南",
    customer: "青禾设计",
  });
  f.schema.settings.frontendEvents = [f.request];
  const result = applyFrontendEvents(f.schema, f.values, f.data, "field", {
    fieldId: "choose",
  });
  expect(result.failures[0]).toContain("选项不存在");
  expect(result.values).toEqual(f.values);
  expect(result.runs[0]!.mappedValues).toEqual({});
});

it.each(["request", "selection"] as const)(
  "%s fills only the current detail row using the new row category",
  (kind) => {
    const f = fixture(true),
      event = f[kind];
    f.schema.settings.frontendEvents = [event];
    const result = applyFrontendEvents(
      f.schema,
      f.values,
      f.data,
      "field",
      { fieldId: "choose", row: { subformId: "lines", index: 0 } },
      { [event.id]: f.selected.id },
    );
    expect(result.failures).toEqual([]);
    const before = f.values.lines as FormValues[],
      after = result.values.lines as FormValues[];
    expect(after[0]).toEqual({
      ...before[0],
      [f.region.id]: "south",
      [f.customer.id]: "南屿科技",
    });
    expect(after[1]).toEqual(before[1]);
    expect(before[0]![f.region.id]).toBe("east");
  },
);

it.each([false, true])(
  "main request fills detail choices using the new %s row/root dependency and keeps existing row IDs and notes",
  (rootFilter) => {
    const f = fixture(true, rootFilter);
    f.schema.fields.unshift(
      createField("button", { id: "main_choose", label: "回填明细" }),
    );
    f.request.fieldIds = ["main_choose"];
    f.request.request!.outputs = [
      {
        fieldId: f.customer.id,
        path: { source: "constant", value: "$.items[*].customer" },
      },
      {
        fieldId: f.region.id,
        path: {
          source: "constant",
          value: rootFilter ? "$.region" : "$.items[*].region",
        },
      },
    ];
    f.request.request!.simulation.response = JSON.stringify({
      region: "华南",
      items: [
        { region: "华南", customer: "南屿科技" },
        { region: "华东", customer: "星河制造" },
      ],
    });
    if (rootFilter)
      f.request.request!.simulation.response = JSON.stringify({
        region: "华南",
        items: [{ customer: "南屿科技" }, { customer: "南屿科技" }],
      });
    f.schema.settings.frontendEvents = [f.request];
    const result = applyFrontendEvents(f.schema, f.values, f.data, "field", {
      fieldId: "main_choose",
    });
    expect(result.failures).toEqual([]);
    const before = f.values.lines as FormValues[],
      rows = result.values.lines as FormValues[];
    expect(rows.map((row) => row._rowId)).toEqual(["row_a", "row_b"]);
    expect(rows.map((row) => row.memo)).toEqual(["保留", "另一行"]);
    expect(rows[0]![f.customer.id]).toBe("南屿科技");
    expect(rows[1]![f.customer.id]).toBe(rootFilter ? "南屿科技" : "星河制造");
    expect(before[0]![f.customer.id]).toBe("青禾设计");
  },
);

it("a mapped field becoming hidden after the category changes rejects every mapped value", () => {
  const f = fixture();
  // Use an ordinary text target so invalid choices cannot mask this check.
  f.customer.type = "text";
  f.schema.settings.rules = [
    {
      id: "show_customer",
      match: "all",
      conditions: [
        { sourceId: f.region.id, operator: "equals", value: "east" },
      ],
      targetIds: [f.customer.id],
    },
  ];
  f.schema.settings.frontendEvents = [f.request];
  const run = runFrontendEvent(f.request, f.schema, f.values, f.data);
  expect(run.status).toBe("failed");
  expect(run.error?.message).toContain("不可编辑");
  expect(run.mappedValues).toEqual({});
});

it("an explicit null still clears numbers and choices without turning an empty value into a conversion error", () => {
  const f = fixture(),
    amount = createField("number", { id: "amount", label: "金额" });
  f.schema.fields.push(amount);
  f.values.amount = 25;
  f.request.request!.outputs = [
    { fieldId: amount.id, path: { source: "constant", value: "$.amount" } },
    {
      fieldId: f.customer.id,
      path: { source: "constant", value: "$.customer" },
    },
  ];
  f.request.request!.simulation.response = '{"amount":null,"customer":null}';
  f.schema.settings.frontendEvents = [f.request];
  const result = applyFrontendEvents(f.schema, f.values, f.data, "field", {
    fieldId: "choose",
  });
  expect(result.failures).toEqual([]);
  expect(result.values).toEqual({
    ...f.values,
    amount: "",
    [f.customer.id]: "",
  });
});

it("three linked choices fill in dependency order using target option IDs", () => {
  const f = fixture();
  const source = f.data.forms.find(
    (form) => form.id === f.customer.choiceSource.formId,
  )!;
  const name = source.schema.fields.find(
    (field) => field.label === "客户名称",
  )!;
  const contact = source.schema.fields.find(
    (field) => field.label === "联系人",
  )!;
  const selectedContact = createField("select", {
    id: "contact",
    label: "联系人",
    choiceSource: {
      ...copy(f.customer.choiceSource),
      labelFieldId: contact.id,
      valueFieldId: "",
      filters: [
        {
          id: "customer_filter",
          sourceFieldId: name.id,
          operator: "equals",
          source: "field",
          value: f.customer.id,
        },
      ],
    },
  });
  f.schema.fields.push(selectedContact);
  f.request.request!.outputs.unshift({
    fieldId: selectedContact.id,
    path: { source: "constant", value: "$.contact" },
  });
  f.request.request!.simulation.response = JSON.stringify({
    region: "华南",
    customer: "南屿科技",
    contact: "陈知南",
  });
  f.schema.settings.frontendEvents = [f.request];
  const result = applyFrontendEvents(f.schema, f.values, f.data, "field", {
    fieldId: "choose",
  });
  expect(result.failures).toEqual([]);
  expect(result.values[selectedContact.id]).toBe(f.selected.id);
  expect(result.values[f.customer.id]).toBe("南屿科技");
});

it("a dynamic choice filtered by a formula sees the newly filled formula inputs", () => {
  const f = fixture(),
    amount = createField("number", { id: "amount", label: "金额" });
  f.schema.fields.splice(
    f.schema.fields.indexOf(f.region),
    1,
    createField("text", {
      id: f.region.id,
      label: "业务区域",
      defaultFormula: true,
      expression: 'IF({{amount}}>10,"south","east")',
    }),
  );
  f.schema.fields.push(amount);
  f.values.amount = 5;
  f.request.request!.outputs = [
    f.request.request!.outputs[0]!,
    { fieldId: amount.id, path: { source: "constant", value: "$.amount" } },
  ];
  f.request.request!.simulation.response = JSON.stringify({
    amount: 20,
    customer: "南屿科技",
  });
  f.schema.settings.frontendEvents = [f.request];
  const result = applyFrontendEvents(f.schema, f.values, f.data, "field", {
    fieldId: "choose",
  });
  expect(result.failures).toEqual([]);
  expect(result.values).toEqual({
    ...f.values,
    amount: 20,
    [f.region.id]: "south",
    [f.customer.id]: "南屿科技",
  });
});
