import { seedWorkspace } from "./fixtures/workspace";
// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { createApp, h, nextTick, reactive } from "vue";
import { createPinia } from "pinia";

import {
  copy,
  createField,
  emptySchema,
  parseSchema,
  type FormValues,
} from "../src/domain/form";
import { validateFieldConfiguration } from "../src/domain/fieldValidation";

import FormFields from "../src/features/forms/components/FormFields.vue";

let app: ReturnType<typeof createApp> | undefined;
const settle = async () => {
  for (let i = 0; i < 8; i++) await nextTick();
};
afterEach(() => {
  app?.unmount();
  document.body.innerHTML = "";
  localStorage.clear();
});
async function mount(render: Parameters<typeof createApp>[0]) {
  document.body.innerHTML = '<div id="mount"></div>';
  app = createApp(render);
  app.use(createPinia());
  app.mount("#mount");
  await settle();
}
const input = (label: string) =>
  document.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;
async function enter(element: HTMLInputElement, value: string) {
  element.focus();
  element.value = value;
  element.dispatchEvent(new Event("input", { bubbles: true }));
  await settle();
}

it("publication validates text properties in one place while compatibility reads preserve saved definitions", () => {
  const schema = emptySchema(),
    data = seedWorkspace();
  const field = createField("text", {
    id: "child",
    label: " ",
    placeholder: "示".repeat(101),
  });
  schema.fields = [createField("subform", { children: [field] })];
  expect(validateFieldConfiguration(schema, data).join()).toContain(
    "字段标题不能为空",
  );
  expect(validateFieldConfiguration(schema, data).join()).toContain(
    "提示文字不能超过100个字符",
  );
  field.label = "名".repeat(1001);
  expect(validateFieldConfiguration(schema, data).join()).toContain(
    "字段标题不能超过1000个字符",
  );
  const saved = copy(schema);
  expect(parseSchema(saved).fields[0]!.children[0]!.placeholder.length).toBe(
    101,
  );
  expect(saved).toEqual(schema);
  field.label = "名".repeat(1000);
  field.placeholder = "示".repeat(100);
  expect(validateFieldConfiguration(schema, data)).toEqual([]);
});

it("shared authoring checks preserve long rich descriptions and validate nested text properties without changing history", () => {
  const schema = emptySchema(),
    data = seedWorkspace();
  const description = `<p><strong>${"说明".repeat(1200)}</strong></p><img src="https://example.test/guide.png">`;
  const child = createField("text", {
    label: "题".repeat(1000),
    description,
    placeholder: "示".repeat(100),
  });
  schema.fields = [
    createField("text", { description }),
    createField("subform", { children: [child] }),
  ];
  const saved = copy(schema);
  expect(validateFieldConfiguration(schema, data)).toEqual([]);
  expect(parseSchema(saved).fields[1]!.children[0]!.description).toBe(
    description,
  );
  child.description = {} as unknown as string;
  child.placeholder = [] as unknown as string;
  const errors = validateFieldConfiguration(schema, data).join();
  expect(errors).toContain("描述信息格式不合法");
  expect(errors).toContain("提示文字格式不合法");
  expect(saved.fields[1]!.children[0]!.description).toBe(description);
});

it("desktop and mobile hints use the actual rendering device, and selected values replace the hint", async () => {
  const schema = emptySchema();
  schema.fields = [
    createField("text", { id: "text", label: "姓名" }),
    createField("select", { id: "choice", label: "分类" }),
    createField("datetime", {
      id: "date",
      label: "日期",
      placeholder: "请选择交付日期",
    }),
  ];
  const state = reactive({
    device: "desktop" as "desktop" | "mobile",
    values: {} as FormValues,
  });
  await mount(() =>
    h(FormFields, {
      schema,
      fields: schema.fields,
      values: state.values,
      device: state.device,
      onChange: (id, value) => {
        state.values[id] = value;
      },
    }),
  );
  expect(input("姓名").placeholder).toBe("");
  expect(
    document.querySelector('[aria-label="分类"]')!.textContent?.trim(),
  ).toBe("");
  expect(document.querySelector(".date-placeholder")?.textContent).toBe(
    "请选择交付日期",
  );
  state.device = "mobile";
  await settle();
  expect(input("姓名").placeholder).toBe("请输入");
  expect(document.querySelector('[aria-label="分类"]')!.textContent).toContain(
    "请选择",
  );
  await enter(input("姓名"), "李四");
  await enter(input("日期"), "2026-10-12");
  state.values.choice = schema.fields[1]!.options[0]!.id;
  await settle();
  expect(document.querySelector(".date-placeholder")).toBeNull();
  expect(document.querySelector('[aria-label="分类"]')!.textContent).toContain(
    "选项一",
  );
  state.device = "desktop";
  await settle();
  expect(input("姓名").value).toBe("李四");
  expect(input("日期").value).toBe("2026-10-12");
});

it("subform controls inherit device hints and custom hints survive hiding the title and filling a default", async () => {
  const schema = emptySchema(),
    child = createField("text", {
      id: "line",
      label: "行说明",
      placeholder: "填写行说明",
      showLabel: false,
    });
  schema.fields = [
    createField("text", {
      id: "main",
      label: "隐藏标题",
      showLabel: false,
      placeholder: "填写姓名",
      defaultValue: "张三",
    }),
    createField("subform", {
      id: "rows",
      label: "明细",
      children: [child, createField("select", { id: "kind", label: "行分类" })],
    }),
  ];
  const values = {
    main: "张三",
    rows: [{ _rowId: "one", line: "", kind: "" }],
  };
  await mount(() =>
    h(FormFields, { schema, fields: schema.fields, values, device: "mobile" }),
  );
  expect(input("隐藏标题").value).toBe("张三");
  expect(input("隐藏标题").placeholder).toBe("填写姓名");
  const line = document.querySelector<HTMLInputElement>(
    'input[placeholder="填写行说明"]',
  )!;
  expect(line).not.toBeNull();
  expect(line.getAttribute("aria-label")).toContain("行说明");
  expect(
    document.querySelector('[role="combobox"][aria-label*="行分类"]')
      ?.textContent,
  ).toContain("请选择");
});
