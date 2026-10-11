// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { createApp, h, nextTick, reactive } from "vue";
import {
  emptyDateRange,
  dateBoundaryValue,
  datePanelValue,
  selectableDateValue,
  dateScopeFields,
  dateRangeErrors,
  dateFormatPatch,
  separateFormSchema,
  composeFormSchema,
  type FormField,
} from "@platform/contracts";
import {
  createField,
  duplicateField,
  emptySchema,
  parseSchema,
  validateValues,
} from "../src/domain/form";
import DateFieldControl from "../src/features/forms/components/DateFieldControl.vue";
import DateRangeInspector from "../src/features/forms/components/DateRangeInspector.vue";
import { validateFieldConfiguration } from "../src/domain/fieldValidation";
import { seedWorkspace } from "../src/domain/workspace";
import FormFields from "../src/features/forms/components/FormFields.vue";
import { createPinia } from "pinia";

let app: ReturnType<typeof createApp> | undefined;
afterEach(() => {
  app?.unmount();
  document.body.innerHTML = "";
  localStorage.clear();
});
const settle = async () => {
  for (let i = 0; i < 5; i++) await nextTick();
};
const now = new Date("2024-02-29T16:03:04Z"); // Beijing: Friday March 1.
const ranged = (format = "date") =>
  createField("datetime", { id: "end", format, dateRange: emptyDateRange() });
const click = async (selector: string) => {
  document.querySelector<HTMLButtonElement>(selector)!.click();
  await settle();
};

it("dynamic bounds use civil calendar periods rather than treating a month or week as a number of days", () => {
  const field = ranged("datetime-second"),
    range = field.dateRange!;
  range.earliest.enabled = range.latest.enabled = true;
  expect(dateBoundaryValue(field, "earliest", {}, now)).toBe(
    "2024-03-01T00:00:00",
  );
  expect(dateBoundaryValue(field, "latest", {}, now)).toBe(
    "2024-03-01T23:59:59",
  );
  range.earliest.preset = -1;
  expect(dateBoundaryValue(field, "earliest", {}, now)).toBe(
    "2024-02-29T00:00:00",
  );
  for (const [unit, earliest, latest] of [
    ["week", "2024-02-26", "2024-03-03"],
    ["month", "2024-03-01", "2024-03-31"],
    ["quarter", "2024-01-01", "2024-03-31"],
    ["year", "2024-01-01", "2024-12-31"],
  ] as const) {
    Object.assign(range.earliest, {
      preset: "custom",
      direction: "current",
      unit,
    });
    Object.assign(range.latest, range.earliest);
    expect(dateBoundaryValue(field, "earliest", {}, now)).toBe(
      `${earliest}T00:00:00`,
    );
    expect(dateBoundaryValue(field, "latest", {}, now)).toBe(
      `${latest}T23:59:59`,
    );
  }
  Object.assign(range.earliest, {
    direction: "past",
    unit: "month",
    amount: 1,
  });
  Object.assign(range.latest, range.earliest);
  expect(dateBoundaryValue(field, "latest", {}, now)).toBe(
    "2024-02-29T23:59:59",
  );
  Object.assign(range.latest, { direction: "future", unit: "year", amount: 2 });
  expect(dateBoundaryValue(field, "latest", {}, now)).toBe(
    "2026-12-31T23:59:59",
  );
});

it("weekday and two date bounds intersect, while existing defaults and manual values are not rejected", () => {
  const field = ranged(),
    range = field.dateRange!;
  range.weekdaysEnabled = true;
  range.weekdays = [1, 2, 3, 4, 5];
  Object.assign(range.earliest, {
    enabled: true,
    mode: "fixed",
    value: "2024-02-29",
  });
  Object.assign(range.latest, {
    enabled: true,
    mode: "fixed",
    value: "2024-03-05",
  });
  for (const day of ["2024-02-28", "2024-03-02", "2024-03-03", "2024-03-06"])
    expect(selectableDateValue(field, day)).toBe(false);
  for (const day of ["2024-02-29", "2024-03-01", "2024-03-04", "2024-03-05"])
    expect(selectableDateValue(field, day)).toBe(true);
  expect(
    validateValues(
      { ...emptySchema(), fields: [field] },
      { end: "2020-01-01" },
    ),
  ).toEqual([]);
  range.earliest.enabled = range.latest.enabled = range.weekdaysEnabled = false;
  expect(selectableDateValue(field, "2020-01-01")).toBe(true);
  expect(range.earliest.value).toBe("2024-02-29");
});

it("precise fixed and row field boundaries clamp calendar selection without rewriting existing record values", () => {
  const field = ranged("datetime-second"),
    range = field.dateRange!;
  Object.assign(range.earliest, {
    enabled: true,
    mode: "field",
    fieldId: "start",
  });
  Object.assign(range.latest, {
    enabled: true,
    mode: "fixed",
    value: "2024-03-01T12:13:20",
  });
  const row = { start: "2024-03-01T12:13:14" };
  expect(datePanelValue(field, "2024-03-01", "2024-02-29T01:00:00", row)).toBe(
    "2024-03-01T12:13:14",
  );
  expect(datePanelValue(field, "2024-03-01", "2024-02-29T23:00:00", row)).toBe(
    "2024-03-01T12:13:20",
  );
  expect(selectableDateValue(field, "2024-03-01T12:13:13", row)).toBe(false);
  expect(selectableDateValue(field, "2024-03-01T12:13:14", row)).toBe(true);
});

it("a minute panel rounds a legacy seconds boundary upwards and disables days with no representable minute", () => {
  const field = ranged("datetime-local"),
    range = field.dateRange!;
  Object.assign(range.earliest, {
    enabled: true,
    mode: "fixed",
    value: "2024-03-01T12:13:14",
  });
  Object.assign(range.latest, {
    enabled: true,
    mode: "fixed",
    value: "2024-03-01T12:15:20",
  });
  const selected = datePanelValue(field, "2024-03-01", "2024-03-01T00:00");
  expect(selected).toBe("2024-03-01T12:14");
  expect(datePanelValue(field, "2024-03-01", "2024-03-01T12:13:15")).toBe(
    "2024-03-01T12:14",
  );
  expect(selectableDateValue(field, selected)).toBe(true);
  range.earliest.value = "2024-03-01T23:59:01";
  range.latest.enabled = false;
  expect(datePanelValue(field, "2024-03-01", "2024-03-01T00:00")).toBe("");
});

it("the month panel applies month bounds without losing a custom month default", async () => {
  const field = ranged("month");
  Object.assign(field.dateRange!.earliest, {
    enabled: true,
    mode: "fixed",
    value: "2024-02",
  });
  Object.assign(field.dateRange!.latest, {
    enabled: true,
    mode: "fixed",
    value: "2024-04",
  });
  const state = reactive({ value: "2024-03" });
  document.body.innerHTML = '<div id="mount"></div>';
  app = createApp({
    render: () =>
      h(DateFieldControl, {
        field,
        label: "账期",
        modelValue: state.value,
        "onUpdate:modelValue": (value: string) => (state.value = value),
      }),
  });
  app.mount("#mount");
  await settle();
  await click(".date-calendar-trigger");
  document
    .querySelector<HTMLButtonElement>(".date-calendar-trigger")!
    .dispatchEvent(new Event("pointerdown", { bubbles: true }));
  await click(".date-calendar-trigger");
  expect(document.querySelector(".date-calendar-panel")).toBeNull();
  await click(".date-calendar-trigger");
  expect(
    document.querySelector<HTMLButtonElement>('[data-day="2024-01"]')!.disabled,
  ).toBe(true);
  await click('[data-day="2024-04"]');
  expect(state.value).toBe("2024-04");
  expect(document.querySelector(".date-calendar-panel")).toBeNull();
});

it("range field choices respect tab/main/row scope and granularity; invalid references block publication but survive drafts", () => {
  const main = createField("datetime", { id: "main" }),
    other = createField("datetime", { id: "other" }),
    minute = createField("datetime", {
      id: "minute",
      format: "datetime-local",
    });
  const end = ranged(),
    start = createField("datetime", { id: "start" }),
    children = [start, end];
  const fields = [
    main,
    createField("tabs", { children: [other, minute] }),
    createField("subform", { id: "lines", children }),
  ];
  expect(dateScopeFields(fields, "main").map((field) => field.id)).toEqual([
    "main",
    "other",
    "minute",
    "lines",
  ]);
  expect(dateScopeFields(fields, "end")).toEqual(children);
  Object.assign(end.dateRange!.earliest, {
    enabled: true,
    mode: "field",
    fieldId: "main",
  });
  expect(dateRangeErrors(end, children)).toHaveLength(1);
  expect(dateRangeErrors(end, children, true)).toEqual([]);
  end.dateRange!.earliest.fieldId = "start";
  expect(dateRangeErrors(end, children)).toEqual([]);
  start.format = "month";
  expect(dateRangeErrors(end, children)).toHaveLength(1);
});

it("range properties round-trip as presentation and copied subforms remap date references", () => {
  const end = ranged();
  Object.assign(end.dateRange!.earliest, {
    enabled: true,
    mode: "field",
    fieldId: "start",
  });
  const container = createField("subform", {
    id: "lines",
    children: [createField("datetime", { id: "start" }), end],
  });
  const schema = { ...emptySchema(), fields: [container] },
    restored = parseSchema(schema),
    parts = separateFormSchema(restored);
  expect(
    (parts.model.fields[0]!.children[1]!.settings as any).dateRange,
  ).toBeUndefined();
  expect(
    composeFormSchema(parts.model, parts.page).fields[0]!.children[1]!
      .dateRange,
  ).toEqual(end.dateRange);
  const clone = duplicateField(container);
  expect(clone.children[1]!.dateRange!.earliest.fieldId).toBe(
    clone.children[0]!.id,
  );
  expect(end.dateRange!.earliest.fieldId).toBe("start");
  expect(() =>
    parseSchema({
      ...emptySchema(),
      fields: [{ ...end, dateRange: {} } as FormField],
    }),
  ).toThrow("星期");
  Object.assign(end.dateRange!.latest, { mode: "fixed", value: "2024-03-01" });
  expect(dateFormatPatch(end, "datetime-second").dateRange!.latest.value).toBe(
    "2024-03-01T00:00:00",
  );
});

it("the inspector retains disabled settings and offers only matching row fields", async () => {
  const field = reactive(ranged()),
    start = createField("datetime", { id: "start", label: "开始日期" }),
    parent = createField("subform", { children: [start, field] });
  document.body.innerHTML = '<div id="mount"></div>';
  app = createApp(DateRangeInspector, {
    field,
    fields: [
      createField("datetime", { id: "main", label: "主表日期" }),
      parent,
    ],
    onUpdate: (patch: any) => Object.assign(field, patch),
  });
  app.mount("#mount");
  await settle();
  const toggle = [
    ...document.querySelectorAll<HTMLLabelElement>(".checkbox-line"),
  ]
    .find((label) => label.textContent === "最早可选时间")!
    .querySelector<HTMLInputElement>("input")!;
  toggle.click();
  await settle();
  const mode = document.querySelector<HTMLSelectElement>(
    '[aria-label="最早可选时间方式"]',
  )!;
  mode.value = "field";
  mode.dispatchEvent(new Event("change"));
  await settle();
  const source = document.querySelector<HTMLSelectElement>(
    '[aria-label="最早可选时间字段值"]',
  )!;
  expect([...source.options].map((option) => option.text)).toEqual([
    "请选择字段",
    "开始日期",
  ]);
  source.value = "start";
  source.dispatchEvent(new Event("change"));
  await settle();
  toggle.click();
  await settle();
  toggle.click();
  await settle();
  expect(field.dateRange!.earliest.fieldId).toBe("start");
  expect(
    document.querySelector<HTMLSelectElement>(
      '[aria-label="最早可选时间字段值"]',
    )!.value,
  ).toBe("start");
});

it("the shared calendar greys out unavailable days, preserves manual values, and Escape returns focus", async () => {
  const field = ranged(),
    range = field.dateRange!;
  range.weekdaysEnabled = true;
  range.weekdays = [1, 2, 3, 4, 5];
  Object.assign(range.earliest, {
    enabled: true,
    mode: "fixed",
    value: "2024-02-29",
  });
  Object.assign(range.latest, {
    enabled: true,
    mode: "fixed",
    value: "2024-03-05",
  });
  const state = reactive({ value: "2024-03-01" });
  document.body.innerHTML = '<div id="mount"></div>';
  app = createApp({
    render: () =>
      h(DateFieldControl, {
        field,
        label: "办理日期",
        modelValue: state.value,
        "onUpdate:modelValue": (value: string) => (state.value = value),
      }),
  });
  app.mount("#mount");
  await settle();
  await click(".date-calendar-trigger");
  expect(
    document.querySelector<HTMLButtonElement>('[data-day="2024-03-02"]')!
      .disabled,
  ).toBe(true);
  expect(
    document.querySelector<HTMLButtonElement>('[data-day="2024-03-04"]')!
      .disabled,
  ).toBe(false);
  await click('[data-day="2024-03-02"]');
  expect(state.value).toBe("2024-03-01");
  await click('[data-day="2024-03-04"]');
  expect(state.value).toBe("2024-03-04");
  expect(document.querySelector(".date-calendar-panel")).toBeNull();
  const input = document.querySelector<HTMLInputElement>("input")!;
  input.value = "2020-01-01";
  input.dispatchEvent(new Event("input"));
  await settle();
  expect(state.value).toBe("2020-01-01");
  await click(".date-calendar-trigger");
  document.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
  );
  await settle();
  expect(document.querySelector(".date-calendar-panel")).toBeNull();
  field.editable = false; // The parent controls effective permissions, not the range.
  app.unmount();
  app = undefined;
});

it("subform calendar bounds come from that row, and updating a sibling does not overwrite the selected value", async () => {
  const start = createField("datetime", { id: "start" }),
    end = ranged();
  Object.assign(end.dateRange!.earliest, {
    enabled: true,
    mode: "field",
    fieldId: "start",
  });
  const state = reactive({
    values: {
      lines: [
        { start: "2024-03-01", end: "2024-03-10" },
        { start: "2024-03-15", end: "2024-03-20" },
      ],
    },
  });
  const schema = {
    ...emptySchema(),
    fields: [createField("subform", { id: "lines", children: [start, end] })],
  };
  document.body.innerHTML = '<div id="mount"></div>';
  app = createApp({
    render: () =>
      h(FormFields, { schema, fields: schema.fields, values: state.values }),
  });
  app.use(createPinia()).mount("#mount");
  await settle();
  document
    .querySelectorAll<HTMLButtonElement>(".date-calendar-trigger")[3]!
    .click();
  await settle();
  expect(
    document.querySelector<HTMLButtonElement>('[data-day="2024-03-10"]')!
      .disabled,
  ).toBe(true);
  expect(
    document.querySelector<HTMLButtonElement>('[data-day="2024-03-15"]')!
      .disabled,
  ).toBe(false);
  state.values.lines[1]!.start = "2024-03-16";
  await settle();
  expect(
    document.querySelector<HTMLButtonElement>('[data-day="2024-03-15"]')!
      .disabled,
  ).toBe(true);
  expect(state.values.lines[1]!.end).toBe("2024-03-20");
});

function mountPicker(format = "date", initial = "2024-03-15") {
  const state = reactive({ value: initial, disabled: false });
  const field = ranged(format);
  const emitted: string[] = [];
  document.body.innerHTML = '<div id="mount"></div><div id="unrelated"></div>';
  app = createApp({
    render: () =>
      h(DateFieldControl, {
        field,
        label: "办理日期",
        modelValue: state.value,
        disabled: state.disabled,
        "onUpdate:modelValue": (value: string) => {
          emitted.push(value);
          state.value = value;
        },
      }),
  });
  app.mount("#mount");
  return { state, field, emitted };
}
const arrow = async (key: string) => {
  document.activeElement!.dispatchEvent(
    new KeyboardEvent("keydown", { key, bubbles: true }),
  );
  await settle();
};

it("year and month shortcuts navigate without committing, then select a leap day", async () => {
  const { state, emitted } = mountPicker();
  await click(".date-calendar-trigger");
  await click('[aria-label="选择年份"]');
  await click('[aria-label="前十年"]');
  await click('[data-year="2016"]');
  expect(document.activeElement?.getAttribute("data-month")).toBe("2016-03");
  await click('[data-month="2016-02"]');
  expect(state.value).toBe("2024-03-15");
  expect(emitted).toEqual([]);
  await click('[data-day="2016-02-29"]');
  expect(state.value).toBe("2016-02-29");
  expect(emitted).toEqual(["2016-02-29"]);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement?.className).toBe("date-calendar-trigger");
});

it("year, month and day grids support keyboard navigation across boundaries and Escape discards navigation", async () => {
  const { state, emitted } = mountPicker();
  await click(".date-calendar-trigger");
  await click('[aria-label="选择年份"]');
  await arrow("ArrowDown");
  expect(document.activeElement?.getAttribute("data-year")).toBe("2027");
  (document.activeElement as HTMLButtonElement).click();
  await settle();
  await click('[data-month="2027-12"]');
  await click('[aria-label="选择月份"]');
  await arrow("ArrowRight");
  expect(document.activeElement?.getAttribute("data-month")).toBe("2028-01");
  (document.activeElement as HTMLButtonElement).click();
  await settle();
  await arrow("ArrowLeft");
  expect(document.activeElement?.getAttribute("data-day")).toBe("2027-12-31");
  await arrow("Escape");
  expect(state.value).toBe("2024-03-15");
  expect(emitted).toEqual([]);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

it("month keyboard selection honors bounds and the year picker never offers year zero or 10000", async () => {
  const { state, field } = mountPicker("month", "2024-03");
  Object.assign(field.dateRange!.earliest, {
    enabled: true,
    mode: "fixed",
    value: "2024-03",
  });
  Object.assign(field.dateRange!.latest, {
    enabled: true,
    mode: "fixed",
    value: "2024-04",
  });
  await click(".date-calendar-trigger");
  await arrow("ArrowLeft");
  expect(document.activeElement?.getAttribute("data-month")).toBe("2024-03");
  await arrow("ArrowRight");
  expect(document.activeElement?.getAttribute("data-month")).toBe("2024-04");
  (document.activeElement as HTMLButtonElement).click();
  await settle();
  expect(state.value).toBe("2024-04");
  for (const value of ["0001-01", "9999-12"]) {
    state.value = value;
    await settle();
    await click(".date-calendar-trigger");
    await click('[aria-label="选择年份"]');
    const boundary = value.startsWith("0001") ? "0" : "10000";
    expect(
      document.querySelector<HTMLButtonElement>(`[data-year="${boundary}"]`)!
        .disabled,
    ).toBe(true);
    expect(
      document.querySelector<HTMLButtonElement>(
        `[aria-label="${boundary === "0" ? "前十年" : "后十年"}"]`,
      )!.disabled,
    ).toBe(true);
    await arrow("Escape");
  }
});

it("timed selection retains seconds and requires confirmation after year and month navigation", async () => {
  const { state, emitted } = mountPicker(
    "datetime-second",
    "2024-03-15T12:34:56",
  );
  await click(".date-calendar-trigger");
  await click('[aria-label="选择年份"]');
  expect(document.querySelector('[aria-label="选择时间"]')).toBeNull();
  await click('[data-year="2023"]');
  await click('[data-month="2023-04"]');
  await click('[data-day="2023-04-20"]');
  expect(emitted).toEqual([]);
  expect(
    document.querySelector<HTMLInputElement>('[aria-label="选择时间"]')!.value,
  ).toBe("12:34:56");
  await click(".date-calendar-time button");
  expect(state.value).toBe("2023-04-20T12:34:56");
});

it("external linked values and readonly transitions cancel pending timed edits instead of overwriting them", async () => {
  const { state, emitted } = mountPicker("datetime-local", "2024-03-15T12:34");
  await click(".date-calendar-trigger");
  await click('[data-day="2024-03-20"]');
  state.value = "2025-05-01T09:00";
  await settle();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  await click(".date-calendar-trigger");
  expect(
    document.querySelector<HTMLInputElement>('[aria-label="选择时间"]')!.value,
  ).toBe("09:00");
  state.disabled = true;
  await settle();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  await click(".date-calendar-trigger");
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(emitted).toEqual([]);
  expect(state.value).toBe("2025-05-01T09:00");
});

it("only scrolling the calendar's own anchor ancestors dismisses it", async () => {
  mountPicker();
  await click(".date-calendar-trigger");
  document.querySelector("#unrelated")!.dispatchEvent(new Event("scroll"));
  await settle();
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  document.querySelector("#mount")!.dispatchEvent(new Event("scroll"));
  await settle();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

it("an inverted fixed range survives draft save but blocks publication until repaired", () => {
  const field = ranged();
  Object.assign(field.dateRange!.earliest, {
    enabled: true,
    mode: "fixed",
    value: "2026-11-30",
  });
  Object.assign(field.dateRange!.latest, {
    enabled: true,
    mode: "fixed",
    value: "2026-11-01",
  });
  const schema = { ...emptySchema(), fields: [field] };
  const restored = parseSchema(JSON.parse(JSON.stringify(schema)));
  expect(restored.fields[0]!.dateRange).toEqual(field.dateRange);
  expect(
    validateFieldConfiguration(restored, seedWorkspace()).join(),
  ).toContain("最早可选时间不能晚于最晚可选时间");
  restored.fields[0]!.dateRange!.latest.value = "2026-12-01";
  expect(validateFieldConfiguration(restored, seedWorkspace())).toEqual([]);
});

it("all dynamic presets and custom periods retain civil boundaries across leap dates and year changes", () => {
  const field = ranged("datetime-second"),
    config = field.dateRange!;
  config.earliest.enabled = config.latest.enabled = true;
  for (const [preset, day] of [
    [0, "2024-03-01"],
    [-1, "2024-02-29"],
    [1, "2024-03-02"],
    [-7, "2024-02-23"],
    [7, "2024-03-08"],
    [-30, "2024-01-31"],
    [30, "2024-03-31"],
  ] as const) {
    config.earliest.preset = config.latest.preset = preset;
    expect(dateBoundaryValue(field, "earliest", {}, now)).toBe(
      `${day}T00:00:00`,
    );
    expect(dateBoundaryValue(field, "latest", {}, now)).toBe(`${day}T23:59:59`);
  }
  for (const [unit, pastStart, pastEnd, futureStart, futureEnd] of [
    ["day", "2024-02-28", "2024-02-28", "2024-03-03", "2024-03-03"],
    ["week", "2024-02-12", "2024-02-18", "2024-03-11", "2024-03-17"],
    ["month", "2024-01-01", "2024-01-31", "2024-05-01", "2024-05-31"],
    ["quarter", "2023-07-01", "2023-09-30", "2024-07-01", "2024-09-30"],
    ["year", "2022-01-01", "2022-12-31", "2026-01-01", "2026-12-31"],
  ] as const) {
    for (const [direction, start, end] of [
      ["past", pastStart, pastEnd],
      ["future", futureStart, futureEnd],
    ] as const) {
      Object.assign(config.earliest, {
        preset: "custom",
        amount: 2,
        unit,
        direction,
      });
      Object.assign(config.latest, config.earliest);
      expect(dateBoundaryValue(field, "earliest", {}, now)).toBe(
        `${start}T00:00:00`,
      );
      expect(dateBoundaryValue(field, "latest", {}, now)).toBe(
        `${end}T23:59:59`,
      );
      const draft = parseSchema({ ...emptySchema(), fields: [field] })
        .fields[0]!;
      expect(draft.dateRange).toEqual(config);
      draft.format = "month";
      expect(dateBoundaryValue(draft, "earliest", {}, now)).toBe(
        start.slice(0, 7),
      );
      expect(dateBoundaryValue(draft, "latest", {}, now)).toBe(end.slice(0, 7));
    }
  }
});

it("switching a dynamic boundary between past and current preserves its committed amount", async () => {
  const field = reactive(ranged());
  Object.assign(field.dateRange!.earliest, {
    enabled: true,
    mode: "dynamic",
    preset: "custom",
    direction: "past",
    amount: 1,
  });
  document.body.innerHTML = '<div id="mount"></div>';
  app = createApp(DateRangeInspector, {
    field,
    fields: [field],
    onUpdate: (patch: any) => Object.assign(field, patch),
  });
  app.mount("#mount");
  await settle();
  const amount = document.querySelector<HTMLInputElement>(
    '[aria-label="最早可选时间数量"]',
  )!;
  amount.value = "2";
  amount.dispatchEvent(new Event("input", { bubbles: true }));
  amount.dispatchEvent(new Event("change", { bubbles: true }));
  await settle();
  expect(field.dateRange!.earliest.amount).toBe(2);
  const direction = document.querySelector<HTMLSelectElement>(
    '[aria-label="最早可选时间时间状态"]',
  )!;
  direction.value = "current";
  direction.dispatchEvent(new Event("change", { bubbles: true }));
  await settle();
  expect(amount.disabled).toBe(true);
  direction.value = "past";
  direction.dispatchEvent(new Event("change", { bubbles: true }));
  await settle();
  expect(amount.value).toBe("2");
});
