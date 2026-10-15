import { seedWorkspace } from "./fixtures/workspace";
// @vitest-environment jsdom
// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { createApp, h, nextTick, reactive } from "vue";
import { createPinia } from "pinia";

import {
  formatNumberValue,
  parseNumberInput,
  numberValueIssue,
  separateFormSchema,
  composeFormSchema,
  fieldValueLabel,
  fieldDefaultValue,
} from "@platform/contracts";
import {
  createField,
  copy,
  emptySchema,
  parseSchema,
  validateValues,
  calculate,
} from "../src/domain/form";
import { displayValue } from "../src/domain/relations";
import { validateFieldConfiguration } from "../src/domain/fieldValidation";

import FieldControl from "../src/features/forms/components/FieldControl.vue";

let app: ReturnType<typeof createApp> | undefined;
afterEach(() => {
  app?.unmount();
  document.body.innerHTML = "";
  localStorage.clear();
});
const settle = async () => {
  for (let i = 0; i < 4; i++) await nextTick();
};

it("decimal formatting and grouping retain the original value through schema and compatibility projections", () => {
  const f = createField("number", {
    defaultValue: 12345.6789,
    retainPrecision: true,
    precision: 2,
    numberGrouping: true,
  });
  const schema = { ...emptySchema(), fields: [f] };
  const restored = parseSchema(JSON.parse(JSON.stringify(schema)));
  const parts = separateFormSchema(restored);
  const composed = composeFormSchema(parts.model, parts.page).fields[0]!;
  expect(composed).toMatchObject({
    retainPrecision: true,
    numberGrouping: true,
    defaultValue: 12345.6789,
  });
  expect(formatNumberValue(composed, composed.defaultValue)).toBe("12,345.68");
  expect(
    formatNumberValue(composed, composed.defaultValue, { editing: true }),
  ).toBe("12345.6789");
  expect(displayValue(composed, composed.defaultValue, seedWorkspace())).toBe(
    "12,345.68",
  );
  expect(fieldValueLabel(composed, composed.defaultValue)).toBe("12,345.68");
  expect(composed.defaultValue).toBe(12345.6789);
});
it("percent input and display use ratios without decimal-shift artifacts or shortening the entered value", () => {
  const f = createField("number", {
    format: "percent",
    retainPrecision: true,
    precision: 2,
  });
  expect(parseNumberInput(f, "29")).toBe(0.29);
  expect(parseNumberInput(f, "39.3%")).toBe(0.393);
  expect(formatNumberValue(f, 0.29, { editing: true })).toBe("29");
  expect(formatNumberValue(f, 0.123456, { editing: true })).toBe("12.3456");
  expect(formatNumberValue(f, 0.123456)).toBe("12.35%");
  expect(formatNumberValue(f, 0.123456, { percentSuffix: false })).toBe(
    "12.35",
  );
  expect(
    calculate("{{amount}}*{{rate}}", {
      amount: 2,
      rate: parseNumberInput(f, "0.000001"),
    }),
  ).toBe(2e-8);
  expect(calculate("1e + 2", {})).toBeNull();
});
it("invalid numeric input remains available for correction and cannot silently become NaN, zero or null", () => {
  const f = createField("number", { numberGrouping: true });
  expect(parseNumberInput(f, "1,234.5")).toBe(1234.5);
  for (const input of ["1,2", "0x10", "1e999", "not a number"])
    expect(parseNumberInput(f, input)).toBe(input);
  expect(parseNumberInput({ ...f, numberGrouping: false }, "1,234")).toBe(
    "1,234",
  );
  expect(parseNumberInput(f, "")).toBe("");
  expect(parseNumberInput(f, "0")).toBe(0);
  expect(numberValueIssue(f, "1,234")).toBe("invalid");
  expect(numberValueIssue(f, Number.MAX_SAFE_INTEGER + 1)).toBe("invalid");
});
it("range toggles affect validation while legacy published precision rules and display remain unchanged", () => {
  const f = createField("number", {
    min: 0,
    max: 100,
    limitRange: true,
    retainPrecision: true,
    precision: 2,
  });
  const schema = { ...emptySchema(), fields: [f] };
  expect(validateValues(schema, { [f.id]: 100.001 })[0]!.message).toContain(
    "范围",
  );
  f.limitRange = false;
  expect(validateValues(schema, { [f.id]: 100.001 })).toEqual([]);
  expect(f.max).toBe(100);
  f.limitRange = true;
  f.min = 200;
  expect(validateFieldConfiguration(schema, seedWorkspace())[0]).toContain(
    "最小值不能大于最大值",
  );
  const legacy = createField("number", { format: "none" });
  delete legacy.retainPrecision;
  delete legacy.numberGrouping;
  const restored = parseSchema({ ...emptySchema(), fields: [legacy] })
    .fields[0]!;
  expect(restored.retainPrecision).toBeUndefined();
  expect(formatNumberValue(restored, 12.3)).toBe("12.3");
  expect(numberValueIssue(restored, 12.345)).toBe("precision");
});
async function mountControl(
  field = createField("number", {
    numberGrouping: true,
    retainPrecision: true,
  }),
  initial: unknown = 1234.5678,
) {
  const state = reactive({ value: initial, field });
  document.body.innerHTML = '<div id="mount"></div>';
  app = createApp({
    render: () =>
      h(FieldControl, {
        field: state.field,
        modelValue: state.value,
        "onUpdate:modelValue": (value: unknown) => {
          state.value = value;
        },
      }),
  });
  app.use(createPinia()).mount("#mount");
  await settle();
  return {
    state,
    input: document.querySelector<HTMLInputElement>(".number-control input")!,
  };
}
it("the shared numeric control preserves incomplete typing, formats on blur and reveals full precision on focus", async () => {
  const f = await mountControl();
  expect(f.input.value).toBe("1,234.57");
  f.input.focus();
  await settle();
  expect(f.input.value).toBe("1234.5678");
  f.input.value = "12.";
  f.input.dispatchEvent(new Event("input", { bubbles: true }));
  await settle();
  expect(f.input.value).toBe("12.");
  f.input.value = "12.3456";
  f.input.dispatchEvent(new Event("input", { bubbles: true }));
  await settle();
  f.input.blur();
  await settle();
  expect(f.input.value).toBe("12.35");
  expect(f.state.value).toBe(12.3456);
  f.input.focus();
  await settle();
  expect(f.input.value).toBe("12.3456");
  f.input.value = "1,2";
  f.input.dispatchEvent(new Event("input", { bubbles: true }));
  await settle();
  f.input.blur();
  await settle();
  expect(f.input.value).toBe("1,2");
  expect(f.state.value).toBe("1,2");
});
it("percent controls emit ratios, show one suffix and respect readonly calculated fields", async () => {
  const f = await mountControl(
    createField("number", { format: "percent", retainPrecision: true }),
    0.125678,
  );
  expect(f.input.value).toBe("12.57");
  expect(document.querySelector(".number-suffix")!.textContent).toBe("%");
  f.input.focus();
  await settle();
  expect(f.input.value).toBe("12.5678");
  f.input.value = "25";
  f.input.dispatchEvent(new Event("input", { bubbles: true }));
  await settle();
  expect(f.state.value).toBe(0.25);
  f.state.field.type = "calculated";
  await settle();
  expect(f.input.readOnly).toBe(true);
  f.input.value = "99";
  f.input.dispatchEvent(new Event("input", { bubbles: true }));
  await settle();
  expect(f.state.value).toBe(0.25);
});
it("updates a focused numeric control when a parent rule replaces its value without re-emitting the stale input", async () => {
  const f = await mountControl();
  f.input.focus();
  f.input.value = "12.";
  f.input.dispatchEvent(new Event("input", { bubbles: true }));
  await settle();
  expect(f.input.value).toBe("12.");
  f.state.value = 7.89123;
  await settle();
  expect(f.input.value).toBe("7.89123");
  f.input.blur();
  await settle();
  expect(f.input.value).toBe("7.89");
  expect(f.state.value).toBe(7.89123);
});

it("validates custom numeric defaults against the effective range and old precision without constraining dormant formula values", () => {
  const field = createField("number", {
    id: "amount",
    label: "金额",
    defaultValue: "1e999",
    limitRange: true,
    min: 0,
    max: 1,
  });
  const schema = { ...emptySchema(), fields: [field] },
    data = seedWorkspace();
  expect(validateFieldConfiguration(schema, data)).toContain(
    "「金额」请填写有效的数字默认值",
  );
  field.defaultValue = 2;
  expect(validateFieldConfiguration(schema, data)).toContain(
    "「金额」默认值超出限定数值范围",
  );
  field.limitRange = false;
  expect(validateFieldConfiguration(schema, data)).toEqual([]);
  field.defaultValue = 0.123456;
  expect(validateFieldConfiguration(schema, data)).toEqual([]);
  delete field.retainPrecision;
  expect(validateFieldConfiguration(schema, data)).toContain(
    "「金额」默认值最多保留2位小数",
  );
  field.defaultFormula = true;
  field.expression = "1";
  expect(validateFieldConfiguration(schema, data)).toEqual([]);
});
it("reads historical numeric defaults as stored numbers without rewriting schemas or dividing percentage ratios again", () => {
  const field = createField("number", {
    id: "rate",
    format: "percent",
    defaultValue: "0.125678",
    retainPrecision: true,
    precision: 2,
  });
  const before = copy(field);
  expect(fieldDefaultValue(field)).toBe(0.125678);
  expect(formatNumberValue(field, fieldDefaultValue(field))).toBe("12.57%");
  expect(
    validateFieldConfiguration(
      { ...emptySchema(), fields: [field] },
      seedWorkspace(),
    ),
  ).toEqual([]);
  expect(field).toEqual(before);
  expect(fieldDefaultValue({ ...field, defaultValue: "1,234" })).toBe("1,234");
  expect(fieldDefaultValue({ ...field, defaultValue: "bad" })).toBe("bad");
  expect(fieldDefaultValue({ ...field, defaultValue: "0" })).toBe(0);
});
