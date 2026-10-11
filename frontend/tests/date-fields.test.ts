// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { createApp, h, nextTick, reactive } from "vue";
import { createPinia } from "pinia";
import {
  dateFormats,
  dateValueAt,
  validDateValue,
  separateFormSchema,
  composeFormSchema,
  type PublishedAccess,
} from "@platform/contracts";
import {
  createField,
  emptySchema,
  parseSchema,
  defaultValues,
  validateValues,
} from "../src/domain/form";
import { validateFieldConfiguration } from "../src/domain/fieldValidation";
import { quickFillValue } from "../src/domain/quickFill";
import { emptyServerRecord } from "../src/domain/serverRecords";
import { seedWorkspace } from "../src/domain/workspace";
import FieldControl from "../src/features/forms/components/FieldControl.vue";
import FieldInspector from "../src/features/forms/components/FieldInspector.vue";
import ServerFieldControl from "../src/features/collaboration/ServerFieldControl.vue";

let app: ReturnType<typeof createApp> | undefined;
afterEach(() => {
  app?.unmount();
  document.body.innerHTML = "";
  localStorage.clear();
});
const settle = async () => {
  for (let i = 0; i < 4; i++) await nextTick();
};
const now = new Date("2024-02-29T16:03:04Z");

it("date granularities validate civil calendar values without rollover or timezone conversion", () => {
  for (const [format, values] of [
    ["month", ["2024-02", "2024-13", "2024-02-01"]],
    ["date", ["2024-02-29", "2023-02-29", "2024-04-31", "0000-01-01"]],
    [
      "datetime-local",
      ["2024-02-29T23:59", "2024-02-29T24:00", "2024-02-29T23:60"],
    ],
    [
      "datetime-second",
      ["2024-02-29T23:59:59", "2024-02-29T23:59:60", "2024-02-29T23:60:00"],
    ],
  ] as const) {
    expect(validDateValue(format, values[0])).toBe(true);
    for (const value of values.slice(1))
      expect(validDateValue(format, value)).toBe(false);
  }
  expect(validDateValue("date", "2000-02-29")).toBe(true);
  expect(validDateValue("date", "1900-02-29")).toBe(false);
  expect(validDateValue("datetime-second", "2024-02-29T23:59")).toBe(true);
  // Historical minute-type records and quick-fill previously allowed seconds.
  expect(validDateValue("datetime-local", "2024-02-29T23:59:10")).toBe(true);
});

it("new forms and new detail rows take one current timestamp, while legacy static and blank defaults remain unchanged", () => {
  const fields = dateFormats.map((item) =>
    createField("datetime", { id: item.value, format: item.value }),
  );
  expect(defaultValues(fields, now)).toEqual({
    month: "2024-03",
    date: "2024-03-01",
    "datetime-local": "2024-03-01T00:03",
    "datetime-second": "2024-03-01T00:03:04",
  });
  const fixed = createField("datetime", {
    id: "fixed",
    format: "date",
    defaultValue: "2020-01-01",
  });
  const blank = createField("datetime", { id: "blank" });
  delete blank.dateDefault;
  const restored = parseSchema({
    ...emptySchema(),
    fields: [...fields, fixed, blank],
  });
  expect(restored.fields.at(-1)!.dateDefault).toBeUndefined();
  expect(defaultValues(restored.fields, now)).toMatchObject({
    fixed: "2020-01-01",
    blank: "",
  });
  const parts = separateFormSchema(restored);
  expect(
    composeFormSchema(parts.model, parts.page).fields[0]!.dateDefault,
  ).toBe("now");
  expect(
    defaultValues(
      [createField("subform", { id: "lines", children: fields })],
      now,
    ),
  ).toEqual({ lines: [] });
  expect(
    defaultValues(fields, new Date("2024-02-29T16:03:09Z"))["datetime-second"],
  ).toBe("2024-03-01T00:03:09");
  expect(dateValueAt("date", new Date("invalid"))).toBe("");
});

it("nested invalid dates and invalid custom defaults cannot pass existing validation gates", () => {
  const child = createField("datetime", {
    id: "day",
    format: "date",
    defaultValue: "2023-02-29",
  });
  const schema = {
    ...emptySchema(),
    fields: [createField("subform", { id: "lines", children: [child] })],
  };
  expect(validateFieldConfiguration(schema, seedWorkspace()).join()).toContain(
    "默认日期或时间不合法",
  );
  const errors = validateValues(schema, {
    lines: [{ _rowId: "one", day: "2024-04-31" }],
  });
  expect(errors).toEqual([
    expect.objectContaining({
      path: "lines.0.day",
      message: "请输入有效的日期或时间",
    }),
  ]);
  expect(
    validateValues(schema, { lines: [{ _rowId: "one", day: "2024-02-29" }] }),
  ).toEqual([]);
});

it("quick-fill follows the selected date granularity and normalizes only omitted zero seconds", () => {
  const data = seedWorkspace();
  expect(
    quickFillValue(
      createField("datetime", { format: "month" }),
      "2024-02",
      {},
      data,
    ),
  ).toBe("2024-02");
  expect(
    quickFillValue(
      createField("datetime", { format: "datetime-second" }),
      "2024-02-29T12:13",
      {},
      data,
    ),
  ).toBe("2024-02-29T12:13:00");
  expect(() =>
    quickFillValue(
      createField("datetime", { format: "date" }),
      "2023-02-29",
      {},
      data,
    ),
  ).toThrow("有效日期");
});

it("the inspector keeps a custom value when changing sources and converts only its draft granularity", async () => {
  const field = reactive(
    createField("datetime", {
      format: "datetime-second",
      defaultValue: "2024-02-29T12:13:14",
    }),
  );
  document.body.innerHTML = '<div id="mount"></div>';
  app = createApp(FieldInspector, {
    field,
    schema: { ...emptySchema(), fields: [field] },
    formId: "test",
    onUpdate: (patch: any) => Object.assign(field, patch),
  });
  app.use(createPinia());
  app.mount("#mount");
  await settle();
  const source = document.querySelector<HTMLSelectElement>(
    "#date-default-source",
  )!;
  source.value = "now";
  source.dispatchEvent(new Event("change", { bubbles: true }));
  await settle();
  expect(document.querySelector("#field-default")).toBeNull();
  expect(field.defaultValue).toBe("2024-02-29T12:13:14");
  source.value = "custom";
  source.dispatchEvent(new Event("change", { bubbles: true }));
  await settle();
  expect(document.querySelector<HTMLInputElement>("#field-default")!.step).toBe(
    "1",
  );
  source.value = "linked";
  source.dispatchEvent(new Event("change", { bubbles: true }));
  await settle();
  expect(field.defaultLink?.enabled).toBe(true);
  expect(document.querySelector("#field-default")).toBeNull();
  source.value = "now";
  source.dispatchEvent(new Event("change", { bubbles: true }));
  await settle();
  expect(field.defaultLink?.enabled).toBe(false);
  expect(field.dateDefault).toBe("now");
  expect(field.defaultValue).toBe("2024-02-29T12:13:14");
  source.value = "custom";
  source.dispatchEvent(new Event("change", { bubbles: true }));
  await settle();
  const format = document.querySelector<HTMLSelectElement>("#date-format")!;
  expect(format.options).toHaveLength(4);
  format.value = "month";
  format.dispatchEvent(new Event("change", { bubbles: true }));
  await settle();
  expect(field.defaultValue).toBe("2024-02");
  expect(document.querySelector<HTMLInputElement>("#field-default")!.type).toBe(
    "month",
  );
  format.value = "datetime-second";
  format.dispatchEvent(new Event("change", { bubbles: true }));
  await settle();
  expect(field.defaultValue).toBe("2024-02-01T00:00:00");
});

it("both existing date controls accept months and seconds and emit canonical civil values", async () => {
  const state = reactive({
    field: createField("datetime", { format: "datetime-second" }),
    value: "",
  });
  document.body.innerHTML = '<div id="mount"></div>';
  const controlProps = (index: number) => ({
    field: state.field,
    modelValue: state.value,
    label: `日期${index}`,
    inputId: `date${index}`,
    "onUpdate:modelValue": (value: unknown) => {
      state.value = String(value);
    },
  });
  app = createApp({
    render: () =>
      h("div", [
        h(FieldControl, controlProps(0)),
        h(ServerFieldControl, controlProps(1)),
      ]),
  });
  app.use(createPinia()).mount("#mount");
  await settle();
  for (const input of document.querySelectorAll<HTMLInputElement>(
    'input[type="datetime-local"]',
  )) {
    expect(input.step).toBe("1");
    input.value = "2024-02-29T12:13";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    expect(state.value).toBe("2024-02-29T12:13:00");
  }
  state.field.format = "month";
  state.value = "2024-02";
  await settle();
  expect(
    [...document.querySelectorAll<HTMLInputElement>("input")].map((input) => [
      input.type,
      input.value,
    ]),
  ).toEqual([
    ["month", "2024-02"],
    ["month", "2024-02"],
  ]);
});

it("opening a server creation editor refreshes current-time defaults without borrowing hidden fields or replacing custom defaults", () => {
  const current = createField("datetime", {
    id: "current",
    format: "datetime-second",
  });
  const fixed = createField("datetime", {
    id: "fixed",
    defaultValue: "2020-01-01",
  });
  const hidden = createField("datetime", { id: "hidden" });
  const published = {
    definition: {
      schema: { ...emptySchema(), fields: [current, fixed, hidden] },
    },
    access: { fields: { current: "edit", fixed: "edit", hidden: "hidden" } },
    defaultValues: {
      current: "2020-01-01T00:00:00",
      fixed: "2020-01-01",
      hidden: "2020-01-01",
    },
  } as unknown as PublishedAccess;
  expect(emptyServerRecord(published, now)).toEqual({
    current: "2024-03-01T00:03:04",
    fixed: "2020-01-01",
  });
});
