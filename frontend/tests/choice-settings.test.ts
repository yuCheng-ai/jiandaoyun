// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { createApp, h, nextTick, ref } from "vue";
import {
  choiceSettingsErrors,
  selectionCountMessage,
  separateFormSchema,
} from "@platform/contracts";
import {
  createField,
  emptySchema,
  parseSchema,
  validateValues,
} from "../src/domain/form";
import ManualChoiceEditor from "../src/features/forms/components/ManualChoiceEditor.vue";
import ChoiceFieldControl from "../src/features/forms/components/ChoiceFieldControl.vue";
import ChoiceSettings from "../src/features/forms/components/ChoiceSettings.vue";
const options = [
  { id: "a", label: "北京" },
  { id: "b", label: "上海" },
  { id: "c", label: "广州" },
];
let app: ReturnType<typeof createApp> | undefined;
const settle = async () => {
  for (let i = 0; i < 8; i++) await nextTick();
};
async function mount(render: Parameters<typeof createApp>[0]) {
  document.body.innerHTML = '<div id="app"></div>';
  app = createApp(render);
  app.mount("#app");
  await settle();
}
const control = <T extends HTMLElement = HTMLInputElement>(name: string) =>
  document.querySelector<T>(`[aria-label="${name}"]`)!;
afterEach(() => {
  app?.unmount();
  document.body.innerHTML = "";
});

it("colors follow option IDs across sorting, renaming, disabling and removal; shared options can keep page colors editable", async () => {
  const field = ref(createField("radio", { options, defaultValue: "b" })),
    readonly = ref(false);
  await mount({
    render: () =>
      h(ManualChoiceEditor, {
        field: field.value,
        appearance: true,
        readonlyOptions: readonly.value,
        onUpdate: (patch) => Object.assign(field.value, patch),
      }),
  });
  control("彩色选项").click();
  await settle();
  const colors = { ...field.value.optionColors };
  control("北京颜色").click();
  await settle();
  control("颜色 #5865f5").click();
  await settle();
  expect(field.value.optionColors?.a).toBe("#5865f5");
  control("拖动排序选项 1").dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "ArrowDown",
      altKey: true,
      bubbles: true,
    }),
  );
  await settle();
  expect(field.value.options.map((option) => option.id)).toEqual([
    "b",
    "a",
    "c",
  ]);
  expect(field.value.optionColors?.b).toBe(colors.b);
  control("选项 2").value = "北京市";
  control("选项 2").dispatchEvent(new Event("input", { bubbles: true }));
  await settle();
  expect(field.value.optionColors?.a).toBe("#5865f5");
  control("彩色选项").click();
  await settle();
  control("彩色选项").click();
  await settle();
  expect(field.value.optionColors?.a).toBe("#5865f5");
  control("移除选项 3").click();
  await settle();
  expect(field.value.optionColors?.c).toBeUndefined();
  readonly.value = true;
  await settle();
  expect(control("选项 1").disabled).toBe(true);
  expect(control<HTMLButtonElement>("上海颜色").disabled).toBe(false);
  control("上海颜色").click();
  await settle();
  control("颜色 #00aed1").click();
  await settle();
  expect(field.value.optionColors?.b).toBe("#00aed1");
  expect(field.value.defaultValue).toBe("b");
});

it("both checkbox and dropdown controls reuse colors, preserve their respective selection order and disable writes", async () => {
  const checkbox = createField("checkbox", {
    options,
    coloredOptions: true,
    optionColors: { a: "#eb5050" },
  });
  const selected = ref<string[]>([]),
    disabled = ref(false);
  await mount({
    render: () =>
      h(ChoiceFieldControl, {
        field: checkbox,
        modelValue: selected.value,
        label: "仓库",
        disabled: disabled.value,
        "onUpdate:modelValue": (value) => (selected.value = value as string[]),
      }),
  });
  control("仓库 广州").click();
  await settle();
  control("仓库 北京").click();
  await settle();
  expect(selected.value).toEqual(["a", "c"]);
  expect(document.querySelector(".choice-group.vertical")).not.toBeNull();
  expect(
    (document.querySelector(".choice-tag") as HTMLElement).style
      .backgroundColor,
  ).toBe("rgb(235, 80, 80)");
  disabled.value = true;
  await settle();
  control("仓库 上海").click();
  await settle();
  expect(selected.value).toEqual(["a", "c"]);
  app!.unmount();
  app = undefined;
  selected.value = [];
  disabled.value = false;
  await mount({
    render: () =>
      h(ChoiceFieldControl, {
        field: { ...checkbox, type: "multiselect", choiceLayout: undefined },
        modelValue: selected.value,
        label: "仓库",
        "onUpdate:modelValue": (value) => (selected.value = value as string[]),
      }),
  });
  document.querySelector<HTMLElement>("summary")!.click();
  await settle();
  const trigger = control<HTMLElement>("仓库");
  trigger.dispatchEvent(new Event("pointerdown", { bubbles: true }));
  await settle();
  trigger.click();
  await settle();
  expect(document.querySelector(".choice-popup")).toBeNull();
  trigger.click();
  await settle();
  control("仓库 广州").click();
  await settle();
  control("仓库 北京").click();
  await settle();
  expect(selected.value).toEqual(["c", "a"]);
  expect(
    Array.from(document.querySelectorAll("summary .choice-tag")).map(
      (item) => item.textContent,
    ),
  ).toEqual(["广州", "北京"]);
  document.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
  );
  await settle();
  expect(document.querySelector(".choice-popup")).toBeNull();
  expect((document.querySelector("details") as HTMLDetailsElement).open).toBe(
    false,
  );
});

it("single dropdown search shows matching labels, selects stable IDs, clears values and never exposes a disabled popup", async () => {
  const value = ref<unknown>(""),
    disabled = ref(false);
  await mount({
    render: () =>
      h(ChoiceFieldControl, {
        field: createField("select", { options }),
        modelValue: value.value,
        label: "地点",
        disabled: disabled.value,
        "onUpdate:modelValue": (next) => (value.value = next),
      }),
  });
  control("地点").click();
  await settle();
  control("地点搜索选项").value = "上海";
  control("地点搜索选项").dispatchEvent(new Event("input", { bubbles: true }));
  await settle();
  expect(document.querySelectorAll('[role="option"]')).toHaveLength(1);
  document.querySelector<HTMLElement>('[role="option"]')!.click();
  await settle();
  expect(value.value).toBe("b");
  expect(document.querySelector(".choice-popup")).toBeNull();
  control("地点").click();
  await settle();
  document.querySelector<HTMLElement>(".choice-clear")!.click();
  await settle();
  expect(value.value).toBe("");
  disabled.value = true;
  await settle();
  control("地点").click();
  await settle();
  expect(document.querySelector(".choice-popup")).toBeNull();
});

it("selection limits are submission rules for visible fields and rows, not restrictions on configuring defaults", () => {
  const multi = createField("multiselect", {
    id: "checks",
    options,
    selectionLimit: { enabled: true, min: 1, max: 2 },
    defaultValue: [],
  });
  const schema = {
    ...emptySchema(),
    fields: [
      multi,
      createField("subform", {
        id: "lines",
        children: [{ ...multi, id: "rowchecks" }],
      }),
    ],
  };
  expect(
    validateValues(schema, {
      checks: [],
      lines: [{ rowchecks: ["a", "b", "c"] }],
    }).map((issue) => [issue.path, issue.message]),
  ).toEqual([
    ["checks", "需选择1~2项"],
    ["lines.0.rowchecks", "需选择1~2项"],
  ]);
  expect(
    validateValues(schema, {
      checks: ["a"],
      lines: [{ rowchecks: ["a", "b"] }],
    }),
  ).toEqual([]);
  expect(
    validateValues(
      { ...schema, fields: [{ ...multi, visible: false }] },
      { checks: [] },
    ),
  ).toEqual([]);
  expect(
    selectionCountMessage(
      { ...multi, selectionLimit: { enabled: true, min: 0, max: 0 } },
      [],
    ),
  ).toBeUndefined();
  expect(
    selectionCountMessage(
      { ...multi, selectionLimit: { enabled: false, min: 2, max: 1 } },
      ["a"],
    ),
  ).toBeUndefined();
  expect(
    parseSchema({ ...emptySchema(), fields: [multi] }).fields[0]!.defaultValue,
  ).toEqual([]);
  const split = separateFormSchema(schema);
  expect(split.model.fields[0]!.settings).not.toHaveProperty("selectionLimit");
  expect(split.page.controls[0]!.properties.selectionLimit).toEqual(
    multi.selectionLimit,
  );
});

it("malformed configurations fail explicitly, incomplete ranges stay repairable, and legacy missing layout stays unchanged", () => {
  const field = createField("checkbox", { options });
  for (const extra of [
    { optionColors: { a: "url(javascript:bad)" } },
    { selectionLimit: { enabled: true, min: -1 } },
    { selectionLimit: { enabled: true, max: 1.5 } },
    { choiceLayout: "other" },
  ]) {
    expect(() =>
      parseSchema({ ...emptySchema(), fields: [{ ...field, ...extra }] }),
    ).toThrow();
  }
  expect(
    choiceSettingsErrors({
      ...field,
      selectionLimit: { enabled: true, min: 2, max: 1 },
    }),
  ).toContain("最少可选项数不能大于最多可选项数");
  expect(
    choiceSettingsErrors(
      { ...field, selectionLimit: { enabled: true, min: 2, max: 1 } },
      true,
    ),
  ).toEqual([]);
  expect(parseSchema({ ...emptySchema(), fields: [{ ...field, options: [{ id: "0", label: "旧选项" }], optionColors: { "0": "#eb5050" } }] }).fields[0]!.optionColors?.["0"]).toBe("#eb5050");
  delete field.choiceLayout;
  expect(
    parseSchema({ ...emptySchema(), fields: [field] }).fields[0],
  ).not.toHaveProperty("choiceLayout");
});

it("layout and count controls update original field settings and retain bounds when disabled", async () => {
  const field = ref(createField("checkbox", { options }));
  await mount({
    render: () =>
      h(ChoiceSettings, {
        field: field.value,
        onUpdate: (patch) => Object.assign(field.value, patch),
      }),
  });
  Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
    .find((button) => button.textContent === "横向排列")!
    .click();
  await settle();
  expect(field.value.choiceLayout).toBe("horizontal");
  document.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click();
  await settle();
  for (const [name, value] of [
    ["最少可选项数", "1"],
    ["最多可选项数", "2"],
  ]) {
    control(name).value = value!;
    control(name).dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
  }
  document.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click();
  await settle();
  expect(field.value.selectionLimit).toEqual({
    enabled: false,
    min: 1,
    max: 2,
  });
});
