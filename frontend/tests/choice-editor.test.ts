import { seedWorkspace } from "./fixtures/workspace";
// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { createApp, h, nextTick, ref } from "vue";
import { createPinia } from "pinia";
import {
  createField,
  emptySchema,
  parseSchema,
  type FormField,
} from "../src/domain/form";
import { validateFieldConfiguration } from "../src/domain/fieldValidation";

import { maxChoiceOptions } from "@platform/contracts";
import ManualChoiceEditor from "../src/features/forms/components/ManualChoiceEditor.vue";
import FieldControl from "../src/features/forms/components/FieldControl.vue";

let app: ReturnType<typeof createApp> | undefined;
afterEach(() => {
  app?.unmount();
  document.body.innerHTML = "";
  localStorage.clear();
});
const settle = async () => {
  for (let i = 0; i < 6; i++) await nextTick();
};
const input = (label: string) =>
  document.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;
const button = (text: string) =>
  Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
    (item) => item.textContent?.trim() === text,
  )!;
async function fill(label: string, text: string) {
  const item = input(label);
  item.value = text;
  item.dispatchEvent(new Event("input", { bubbles: true }));
  await settle();
}
const options = [
  { id: "a", label: "北京" },
  { id: "b", label: "上海" },
  { id: "c", label: "广州" },
];
async function mountEditor(
  type: FormField["type"] = "multiselect",
  extra: Partial<FormField> = {},
  disabled = false,
) {
  const field = ref(
    createField(type, {
      options: structuredClone(options),
      defaultValue: ["b", "a"],
      ...extra,
    }),
  );
  document.body.innerHTML = '<div id="app"></div>';
  app = createApp({
    render: () =>
      h(ManualChoiceEditor, {
        field: field.value,
        disabled,
        onUpdate: (patch) => Object.assign(field.value, patch),
      }),
  });
  app.mount("#app");
  await settle();
  return field;
}

it("single defaults can be replaced or cleared; renaming and deleting keep unaffected identities and defaults", async () => {
  const field = await mountEditor("radio", { defaultValue: "a" });
  input("默认选中上海").click();
  await settle();
  expect(field.value.defaultValue).toBe("b");
  input("默认选中上海").click();
  await settle();
  expect(field.value.defaultValue).toBe("");
  input("默认选中北京").click();
  await settle();
  await fill("选项 1", "北京市");
  expect(field.value.options[0]).toEqual({ id: "a", label: "北京市" });
  input("移除选项 2").click();
  await settle();
  expect(field.value.defaultValue).toBe("a");
  input("移除选项 1").click();
  await settle();
  expect(field.value.defaultValue).toBe("");
});

it("keyboard and native dragging reorder options without changing defaults or leaking drag events to the field canvas", async () => {
  const field = await mountEditor();
  input("拖动排序选项 1").dispatchEvent(
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
  const transfer = { effectAllowed: "", setData: () => {} };
  const start = new Event("dragstart", { bubbles: true, cancelable: true });
  Object.defineProperty(start, "dataTransfer", { value: transfer });
  input("拖动排序选项 3").dispatchEvent(start);
  const row = document.querySelector<HTMLElement>(".manual-option-list > div")!;
  const over = new Event("dragover", { bubbles: true, cancelable: true });
  Object.defineProperty(over, "clientY", { value: -1 });
  row.dispatchEvent(over);
  row.dispatchEvent(new Event("drop", { bubbles: true, cancelable: true }));
  await settle();
  expect(field.value.options.map((option) => option.id)).toEqual([
    "c",
    "b",
    "a",
  ]);
  expect(field.value.defaultValue).toEqual(["b", "a"]);
  expect(
    parseSchema({ ...emptySchema(), fields: [field.value] }).fields[0]!.options,
  ).toEqual(field.value.options);
});

it("a batch edit preserves repeated names and existing IDs, removes only deleted defaults, and cancel leaves the field untouched", async () => {
  const field = await mountEditor("multiselect", {
    options: [
      { id: "a", label: "同名" },
      { id: "b", label: "同名" },
      { id: "c", label: "保留" },
    ],
    defaultValue: ["b", "c"],
  });
  button("批量编辑").click();
  await settle();
  button("确定").click();
  await settle();
  expect(field.value.options.map((option) => option.id)).toEqual([
    "a",
    "b",
    "c",
  ]);
  expect(field.value.defaultValue).toEqual(["b", "c"]);
  button("批量编辑").click();
  await settle();
  await fill("批量选项内容", " 同名\r\n\r\n保留\n新增 ");
  button("确定").click();
  await settle();
  expect(field.value.options.slice(0, 2)).toEqual([
    { id: "a", label: "同名" },
    { id: "c", label: "保留" },
  ]);
  expect(field.value.options[2]!.label).toBe("新增");
  expect(field.value.defaultValue).toEqual(["c"]);
  const before = structuredClone(JSON.parse(JSON.stringify(field.value)));
  button("批量编辑").click();
  await settle();
  await fill("批量选项内容", "未确认");
  button("取消").click();
  await settle();
  expect(field.value).toEqual(before);
});

it("oversized or long-name batches retain the whole input and field; repairing to 1000 options succeeds without truncation", async () => {
  const field = await mountEditor();
  const before = JSON.parse(JSON.stringify(field.value));
  button("批量编辑").click();
  await settle();
  const text = Array.from({ length: 1001 }, (_, index) => `名称${index}`).join(
    "\n",
  );
  await fill("批量选项内容", text);
  expect(button("确定").disabled).toBe(true);
  expect(document.querySelector('[role="alert"]')?.textContent).toContain(
    "1001",
  );
  button("确定").click();
  await settle();
  expect(field.value).toEqual(before);
  expect(input("批量选项内容").value).toBe(text);
  await fill("批量选项内容", "长".repeat(101));
  expect(button("确定").disabled).toBe(true);
  await fill("批量选项内容", text.split("\n").slice(0, 1000).join("\n"));
  button("确定").click();
  await settle();
  expect(field.value.options).toHaveLength(maxChoiceOptions);
  expect(field.value.options.at(-1)!.label).toBe("名称999");
  expect(button("添加选项").disabled).toBe(true);
  const schema = { ...emptySchema(), fields: [field.value] };
  expect(validateFieldConfiguration(schema, seedWorkspace())).toEqual([]);
  schema.fields[0]!.options.push({ id: "extra", label: "超出" });
  expect(
    validateFieldConfiguration(schema, seedWorkspace()).join(" "),
  ).toContain("1000");
}, 15000);

it("a disabled editor prevents adding, changing defaults, reordering and opening batch editing", async () => {
  const field = await mountEditor("multiselect", {}, true),
    before = JSON.parse(JSON.stringify(field.value));
  button("添加选项").click();
  button("批量编辑").click();
  input("默认选中广州").click();
  input("拖动排序选项 1").dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "ArrowDown",
      altKey: true,
      bubbles: true,
    }),
  );
  await settle();
  expect(field.value).toEqual(before);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

it("the local multiselect summary follows selection order, including after options are reordered", async () => {
  const field = ref(createField("multiselect", { label: "验收选项", options })),
    value = ref<unknown>(["c", "a"]);
  document.body.innerHTML = '<div id="app"></div>';
  app = createApp({
    render: () =>
      h(FieldControl, {
        field: field.value,
        modelValue: value.value,
        "onUpdate:modelValue": (next) => (value.value = next),
      }),
  });
  app.use(createPinia());
  app.mount("#app");
  await settle();
  expect(document.querySelector("summary")?.textContent).toContain(
    "广州、北京",
  );
  field.value.options = [...options].reverse();
  await settle();
  expect(document.querySelector("summary")?.textContent).toContain(
    "广州、北京",
  );
  document.querySelector<HTMLElement>("summary")!.click();
  await settle();
  input("验收选项 上海").click();
  await settle();
  expect(value.value).toEqual(["c", "a", "b"]);
  expect(document.querySelector("summary")?.textContent).toContain(
    "广州、北京、上海",
  );
});
