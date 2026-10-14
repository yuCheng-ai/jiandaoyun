// @vitest-environment jsdom
// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { createPinia, setActivePinia } from "pinia";

import {
  createField,
  emptySchema,
  parseSchema,
  prepareSubmission,
  resolveFormValues,
} from "../src/domain/form";
import {
  applyFieldChange,
  resolveRuntimeValues,
  runtimeDefaults,
} from "../src/domain/relations";
import { newForm, seedWorkspace } from "../src/domain/workspace";
import { validateFieldConfiguration } from "../src/domain/fieldValidation";

let pinia = createPinia();
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  pinia = createPinia();
  setActivePinia(pinia);
});
afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});
function fixture() {
  const schema = emptySchema();
  schema.settings.hiddenValueRules = {};
  schema.fields = [
    createField("number", { id: "quantity", label: "数量", defaultValue: 2 }),
    createField("number", {
      id: "static",
      label: "隐藏默认值",
      defaultValue: 9,
      visible: false,
    }),
    createField("calculated", {
      id: "amount",
      label: "隐藏金额",
      visible: false,
      expression: "{{quantity}} * 10",
    }),
    createField("number", {
      id: "echo",
      label: "金额加一",
      defaultFormula: true,
      expression: "{{amount}} + 1",
    }),
  ];
  return schema;
}
it("new ordinary forms use assignment rules while historical and workflow schemas keep their original behavior", () => {
  expect(newForm("oa", "普通表").schema.settings.hiddenValueRules).toEqual({});
  expect(
    newForm("oa", "流程表", "workflow").schema.settings.hiddenValueRules,
  ).toBeUndefined();
  const schema = fixture();
  delete schema.settings.hiddenValueRules;
  expect(
    prepareSubmission(schema, { quantity: 3, static: 7, amount: 20 }).amount,
  ).toBe(30);
  expect(parseSchema(schema).settings.hiddenValueRules).toBeUndefined();
});
it("retain freezes the stored value before dependent formulas and ignores forged hidden input; new hidden defaults stay empty", () => {
  const schema = fixture(),
    data = seedWorkspace();
  const old = { quantity: 2, static: 7, amount: 20, echo: 21 };
  const input = applyFieldChange(
    schema.fields,
    { ...old, static: 999 },
    "quantity",
    3,
    data,
  );
  expect(input.amount).toBe(30);
  const result = resolveRuntimeValues(schema, input, data, old);
  expect(result).toMatchObject({
    quantity: 3,
    static: 7,
    amount: 20,
    echo: 21,
  });
  const fresh = prepareSubmission(schema, runtimeDefaults(schema.fields, data));
  expect(fresh).not.toHaveProperty("amount");
  expect(fresh).not.toHaveProperty("static");
});
it("clear removes hidden values and recalculate updates hidden formulas/defaults, with stable per-field exceptions", () => {
  const schema = fixture();
  schema.settings.hiddenValues = "clear";
  schema.settings.hiddenValueRules = {
    amount: "recalculate",
    static: "retain",
  };
  const old = { quantity: 2, static: 7, amount: 20, echo: 21 };
  const result = prepareSubmission(schema, { ...old, quantity: 4 }, old);
  expect(result).toMatchObject({
    quantity: 4,
    static: 7,
    amount: 40,
    echo: 41,
  });
  schema.fields[2]!.label = "改名后的金额";
  const restored = parseSchema(JSON.parse(JSON.stringify(schema)));
  expect(restored.settings.hiddenValueRules).toEqual({
    amount: "recalculate",
    static: "retain",
  });
  restored.settings.hiddenValueRules = {};
  restored.settings.hiddenValues = "recalculate";
  expect(
    prepareSubmission(restored, { ...old, quantity: 3 }, old),
  ).toMatchObject({ static: 9, amount: 30, echo: 31 });
  restored.settings.hiddenValues = "clear";
  expect(prepareSubmission(restored, old, old)).not.toHaveProperty("amount");
});
it("subform columns own row values, hidden tabs mask descendants, and legacy serial numbers keep generating", () => {
  const schema = emptySchema();
  schema.settings.hiddenValues = "clear";
  schema.settings.hiddenValueRules = { price: "retain", total: "recalculate" };
  schema.fields = [
    createField("subform", {
      id: "rows",
      children: [
        createField("number", { id: "qty" }),
        createField("number", { id: "price", visible: false }),
        createField("calculated", {
          id: "total",
          visible: false,
          expression: "{{qty}} * {{price}}",
        }),
      ],
    }),
    createField("tabs", {
      id: "tabs",
      visible: false,
      children: [createField("text", { id: "note" })],
    }),
    createField("serial", { id: "serial", visible: false, serial: undefined }),
  ];
  const before = {
    rows: [
      { qty: 2, price: 5, total: 10 },
      { qty: 3, price: 7, total: 21 },
    ],
    note: "原内容",
  };
  const next = prepareSubmission(
    schema,
    {
      rows: [
        { qty: 4, price: 999 },
        { qty: 5, price: 999 },
      ],
      note: "内容",
    },
    before,
  );
  expect(next.rows).toEqual([
    { qty: 4, price: 5, total: 20 },
    { qty: 5, price: 7, total: 35 },
  ]);
  expect(next).not.toHaveProperty("note");
  expect(next.serial).toMatch(/^SN/);
  expect(before.rows[0]!.price).toBe(5);
});
it("malformed assignment settings fail visibly and deleted references survive until explicit removal or restore", () => {
  const schema = fixture();
  schema.settings.hiddenValueRules = { amount: "recalculate" };
  for (const value of [[], null, { amount: "wrong" }])
    expect(() =>
      parseSchema({
        ...schema,
        settings: { ...schema.settings, hiddenValueRules: value },
      }),
    ).toThrow(/赋值规则/);
  expect(() =>
    parseSchema({
      ...schema,
      settings: { ...schema.settings, hiddenValues: "wrong" },
    }),
  ).toThrow(/赋值设置/);
  schema.fields = schema.fields.filter((field) => field.id !== "amount");
  expect(parseSchema(schema).settings.hiddenValueRules).toEqual({
    amount: "recalculate",
  });
  expect(validateFieldConfiguration(schema, seedWorkspace()).join()).toContain(
    "特殊字段赋值规则引用了已删除字段",
  );
});
it("a field first revealed by a visibility rule receives its normal default and new hidden values stay empty on submission", () => {
  const schema = fixture();
  schema.fields[1]!.visible = true;
  schema.settings.rules = [
    {
      id: "show",
      match: "all",
      conditions: [{ sourceId: "quantity", operator: "greater", value: "2" }],
      targetIds: ["static"],
    },
  ];
  const initial = resolveFormValues(schema, { quantity: 2, static: 9 });
  expect(initial).not.toHaveProperty("static");
  const shown = resolveFormValues(schema, { ...initial, quantity: 3 });
  expect(shown.static).toBe(9);
  const hidden = prepareSubmission(schema, {
    ...shown,
    quantity: 2,
    static: 7,
  });
  expect(hidden).not.toHaveProperty("static");
});
