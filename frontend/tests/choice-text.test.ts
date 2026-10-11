// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { createApp, h, nextTick, ref } from "vue";
import { createPinia } from "pinia";
import { createMemoryHistory, createRouter } from "vue-router";
import {
  choiceValueIssue,
  fieldValueLabel,
  isChoiceTextValue,
  selectionCountMessage,
  separateFormSchema,
} from "@platform/contracts";
import {
  createField,
  emptySchema,
  parseSchema,
  isFieldVisible,
  type FormField,
} from "../src/domain/form";
import { validateDynamicValues } from "../src/domain/fieldValidation";
import {
  displayValue,
  matchesFilters,
  resolveChoices,
} from "../src/domain/relations";
import { seedWorkspace } from "../src/domain/workspace";
import { filterAndSortRecords, defaultRecordView } from "../src/domain/records";
import ChoiceFieldControl from "../src/features/forms/components/ChoiceFieldControl.vue";
import ManualChoiceEditor from "../src/features/forms/components/ManualChoiceEditor.vue";
import FormRuntime from "../src/features/forms/components/FormRuntime.vue";
const options = [
  { id: "a", label: "北京" },
  { id: "b", label: "上海" },
];
let app: ReturnType<typeof createApp> | undefined;
afterEach(() => {
  app?.unmount();
  document.body.innerHTML = "";
});
const settle = async () => {
  for (let i = 0; i < 8; i++) await nextTick();
};
const control = <T extends HTMLElement = HTMLInputElement>(name: string) =>
  document.querySelector<T>(`[aria-label="${name}"]`)!;
const button = (text: string) =>
  Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
    (item) => item.textContent?.trim() === text,
  )!;
async function fill(label: string, text: string) {
  const input = control(label);
  input.value = text;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await settle();
}
async function mount(render: Parameters<typeof createApp>[0]) {
  document.body.innerHTML = '<div id="app"></div>';
  app = createApp(render);
  app.mount("#app");
  await settle();
}

for (const type of ["radio", "select"] as const)
  it(`${type} other keeps the option identity, optional text and read-only display across selection and reopen`, async () => {
    const field = createField(type, {
      required: true,
      coloredOptions: true,
      options: [...options, { id: "other", label: "其他", other: true }],
    });
    const value = ref<unknown>(""),
      disabled = ref(false);
    await mount({
      render: () =>
        h(ChoiceFieldControl, {
          field,
          label: "仓库",
          modelValue: value.value,
          disabled: disabled.value,
          "onUpdate:modelValue": (next) => (value.value = next),
        }),
    });
    async function choose(label: string) {
      if (type === "radio") control(`仓库 ${label}`).click();
      else {
        control("仓库").click();
        await settle();
        Array.from(document.querySelectorAll<HTMLElement>('[role="option"]'))
          .find((item) => item.textContent?.trim() === label)!
          .click();
      }
      await settle();
    }
    await choose("其他");
    expect(value.value).toBe("other");
    expect(choiceValueIssue(field, value.value)).toBeUndefined();
    await fill("仓库其他说明", "成都仓");
    expect(value.value).toEqual({ optionId: "other", text: "成都仓" });
    expect(fieldValueLabel(field, value.value)).toBe("成都仓");
    if (type === "select") {
      control("仓库").click();
      await settle();
      document
        .querySelector<HTMLElement>('[role="option"][aria-selected="true"]')!
        .click();
      await settle();
      expect(control("仓库其他说明").value).toBe("成都仓");
    }
    disabled.value = true;
    await settle();
    expect(control("仓库其他说明").disabled).toBe(true);
    await fill("仓库其他说明", "伪造写入");
    expect(value.value).toEqual({ optionId: "other", text: "成都仓" });
    disabled.value = false;
    await settle();
    await choose("北京");
    expect(value.value).toBe("a");
    expect(control("仓库其他说明")).toBeNull();
    value.value = { optionId: "other", text: "已保存说明" };
    await settle();
    expect(control("仓库其他说明").value).toBe("已保存说明");
  });

for (const type of ["checkbox", "multiselect"] as const)
  it(`${type} custom addition uses the shared popup, retains unchecked options only during this fill and clears them on reset`, async () => {
    const field = createField(type, { options, allowCustomChoices: true });
    const value = ref<unknown>([]),
      disabled = ref(false);
    await mount({
      render: () =>
        h(ChoiceFieldControl, {
          field,
          label: "部门",
          modelValue: value.value,
          disabled: disabled.value,
          "onUpdate:modelValue": (next) => (value.value = next),
        }),
    });
    if (type === "multiselect") {
      control("部门").click();
      await settle();
    }
    control("部门添加选项").click();
    await settle();
    button("确定").click();
    await settle();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "请填写",
    );
    await fill("部门新增选项", "北京");
    button("确定").click();
    await settle();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "已存在",
    );
    await fill("部门新增选项", "长".repeat(101));
    button("确定").click();
    await settle();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "100",
    );
    await fill("部门新增选项", " 临时部门 ");
    control("部门新增选项").dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
      }),
    );
    await settle();
    expect(value.value).toEqual([{ text: "临时部门" }]);
    expect(field.options).toEqual(options);
    control("部门 临时部门").click();
    await settle();
    expect(value.value).toEqual([]);
    expect(control("部门 临时部门")).not.toBeNull();
    value.value = [];
    await settle(); // Cloning another field's values must not drop unchecked temporary options.
    expect(control("部门 临时部门")).not.toBeNull();
    control("部门 临时部门").click();
    await settle();
    control("部门 北京").click();
    await settle();
    expect(value.value).toEqual(
      type === "checkbox"
        ? ["a", { text: "临时部门" }]
        : [{ text: "临时部门" }, "a"],
    );
    control("部门添加选项").click();
    await settle();
    await fill("部门新增选项", "取消内容");
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    await settle();
    expect(control("部门新增选项")).toBeNull();
    if (type === "multiselect")
      expect(document.querySelector(".choice-popup")).not.toBeNull();
    disabled.value = true;
    await settle();
    expect(control("部门添加选项")).toBeNull();
    expect(value.value).toEqual(
      type === "checkbox"
        ? ["a", { text: "临时部门" }]
        : [{ text: "临时部门" }, "a"],
    );
    value.value = [];
    disabled.value = false;
    await settle();
    if (type === "multiselect") {
      control("部门").click();
      await settle();
    }
    expect(control("部门 临时部门")).toBeNull();
    value.value = [{ text: "已保存部门" }];
    await settle();
    expect(control("部门 已保存部门").checked).toBe(true);
  });

it("temporary options remain scoped to their rows and a completed fill resets their lifetime through the real runtime", async () => {
  const multi = createField("checkbox", {
    id: "multi",
    label: "部门",
    options,
    allowCustomChoices: true,
  });
  const schema = {
    ...emptySchema(),
    fields: [
      createField("text", { id: "note", label: "备注" }),
      multi,
      createField("subform", {
        id: "rows",
        label: "明细",
        children: [{ ...multi, id: "rowmulti" }],
      }),
    ],
  };
  schema.settings.successMode = "inline";
  schema.settings.allowAnotherSubmission = true;
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: "/:pathMatch(.*)*", component: { render: () => null } }],
  });
  await router.push("/fill");
  const pinia = createPinia();
  document.body.innerHTML = '<div id="app"></div>';
  app = createApp({
    render: () =>
      h(FormRuntime, {
        formId: "choice-test",
        schema,
        preview: false,
        persistValues: async () => true,
        initialValues: {
          note: "",
          multi: [],
          rows: [{ rowmulti: [] }, { rowmulti: [] }],
        },
      }),
  });
  app.use(pinia);
  app.use(router);
  app.mount("#app");
  await settle();
  const add = async (label: string, text: string) => {
    control(`${label}添加选项`).click();
    await settle();
    await fill(`${label}新增选项`, text);
    button("确定").click();
    await settle();
  };
  await add("部门", "未选择部门");
  control("部门 未选择部门").click();
  await settle();
  await fill("备注", "其他字段已修改");
  expect(control("部门 未选择部门")).not.toBeNull();
  await add("明细 第1行 部门", "首行临时");
  control("明细 第1行 部门 首行临时").click();
  await settle();
  await add("明细 第2行 部门", "次行临时");
  control("明细 第2行 部门 次行临时").click();
  await settle();
  control("删除明细第1行").click();
  await settle();
  expect(control("明细 第1行 部门 首行临时")).toBeNull();
  expect(control("明细 第1行 部门 次行临时")).not.toBeNull();
  document
    .querySelector("form")!
    .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await settle();
  button("继续填写").click();
  await settle();
  expect(control("部门 未选择部门")).toBeNull();
  expect(control("明细 第1行 部门 次行临时")).toBeNull();
});

it("1000 predefined options do not disable adding a temporary option", async () => {
  const field = createField("checkbox", {
    allowCustomChoices: true,
    options: Array.from({ length: 1000 }, (_, i) => ({
      id: `a${i}`,
      label: `选项${i}`,
    })),
  });
  const value = ref<unknown>([]);
  await mount({
    render: () =>
      h(ChoiceFieldControl, {
        field,
        label: "部门",
        modelValue: value.value,
        "onUpdate:modelValue": (next) => (value.value = next),
      }),
  });
  control("部门添加选项").click();
  await settle();
  await fill("部门新增选项", "临时部门");
  button("确定").click();
  await settle();
  expect(value.value).toEqual([{ text: "临时部门" }]);
  expect(field.options).toHaveLength(1000);
});

it("the manual editor keeps a single Other last, preserves it through batches and removes its default explicitly", async () => {
  const field = ref(
    createField("radio", { options, coloredOptions: true, defaultValue: "a" }),
  );
  await mount({
    render: () =>
      h(ManualChoiceEditor, {
        field: field.value,
        appearance: true,
        onUpdate: (patch) => Object.assign(field.value, patch),
      }),
  });
  button("添加其他选项").click();
  await settle();
  const other = { ...field.value.options.at(-1)! };
  expect(other.other).toBe(true);
  expect(button("添加其他选项").disabled).toBe(true);
  expect(control("其他颜色")).toBeNull();
  expect(control("拖动排序选项 3")).toBeNull();
  control("默认选中其他").click();
  await settle();
  button("添加选项").click();
  await settle();
  expect(field.value.options.at(-1)).toEqual(other);
  button("批量编辑").click();
  await settle();
  expect(control("批量选项内容").value).not.toContain("其他");
  await fill("批量选项内容", "上海\n北京");
  button("确定").click();
  await settle();
  expect(field.value.options).toEqual([options[1], options[0], other]);
  expect(field.value.defaultValue).toBe(other.id);
  expect(
    parseSchema({
      ...emptySchema(),
      fields: [field.value],
    }).fields[0]!.options.at(-1),
  ).toEqual(other);
  button("批量编辑").click();
  await settle();
  await fill(
    "批量选项内容",
    Array.from({ length: 1000 }, (_, i) => `项${i}`).join("\n"),
  );
  expect(button("确定").disabled).toBe(true);
  expect(document.querySelector('[role="alert"]')?.textContent).toContain(
    "1001",
  );
  button("取消").click();
  await settle();
  control("移除选项 3").click();
  await settle();
  expect(field.value.defaultValue).toBe("");
  expect(button("添加其他选项").disabled).toBe(false);
});

it("structured choices validate rows, conditions, search and labels without leaking IDs or mutating definitions", () => {
  const data = seedWorkspace();
  const single = createField("select", {
    id: "single",
    options: [...options, { id: "other", label: "其他", other: true }],
  });
  const multi = createField("multiselect", {
    id: "multi",
    options,
    allowCustomChoices: true,
    selectionLimit: { enabled: true, min: 1, max: 2 },
  });
  const note = createField("text", { id: "note" });
  const schema = {
    ...emptySchema(),
    fields: [
      single,
      multi,
      note,
      createField("subform", {
        id: "rows",
        children: [{ ...multi, id: "rowmulti" }],
      }),
    ],
  };
  schema.settings.rules = [
    {
      id: "r",
      sourceId: "single",
      operator: "equals",
      value: "other",
      targetIds: ["note"],
    },
  ];
  const values = {
    single: { optionId: "other", text: "成都仓" },
    multi: ["a", { text: "临时部门" }],
    rows: [{ rowmulti: [{ text: "行部门" }] }],
  };
  expect(validateDynamicValues(schema, values, data)).toEqual([]);
  expect(selectionCountMessage(multi, values.multi)).toBeUndefined();
  expect(isFieldVisible(note, schema, values)).toBe(true);
  expect(
    matchesFilters(
      [
        {
          id: "f",
          sourceFieldId: "single",
          source: "constant",
          operator: "contains",
          value: "other",
        },
      ],
      values,
      {},
      data,
    ),
  ).toBe(true);
  expect(displayValue(single, values.single, data)).toBe("成都仓");
  expect(displayValue(multi, values.multi, data)).toBe("北京、临时部门");
  const entry = {
    id: "record",
    formId: "source",
    definitionVersion: 1,
    values,
    createdAt: "2026-01-01",
    status: "submitted" as const,
    history: [],
  };
  expect(
    filterAndSortRecords([entry], schema, data, {
      query: "成都仓",
      filters: [],
      view: defaultRecordView(schema),
    }),
  ).toEqual([entry]);
  data.forms.push({
    ...data.forms[0]!,
    id: "source",
    schema,
    published: undefined,
    versions: [],
  });
  data.entries.push(entry);
  const linked = createField("select", {
    choiceSource: {
      ...single.choiceSource,
      mode: "form",
      formId: "source",
      labelFieldId: "single",
      valueFieldId: "single",
    },
  });
  expect(resolveChoices(linked, data, {})).toEqual([
    { id: "other", label: "成都仓" },
  ]);
  expect(
    separateFormSchema(schema).model.fields[1]!.settings.allowCustomChoices,
  ).toBe(true);
  for (const invalid of [
    { optionId: "a", text: "伪造其他" },
    { text: "未经允许" },
    { optionId: "other", text: 3 },
    [],
  ])
    expect(choiceValueIssue(single, invalid)).toBeDefined();
  for (const invalid of [
    [{ text: " " }],
    [{ text: "长".repeat(101) }],
    [{ text: "重复" }, { text: "重复" }],
    [{ optionId: "a", text: "伪造" }],
  ])
    expect(choiceValueIssue(multi, invalid)).toBeDefined();
  expect(
    validateDynamicValues(
      schema,
      { ...values, rows: [{ rowmulti: [{ text: "" }] }] },
      data,
    ).map((issue) => issue.path),
  ).toEqual(["rows.0.rowmulti"]);
  expect(isChoiceTextValue(Object.create({ text: "继承内容" }))).toBe(false);
});
