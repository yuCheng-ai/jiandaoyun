// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { createApp, h, nextTick, reactive, shallowRef } from "vue";
import { createPinia } from "pinia";
import {
  createField,
  emptySchema,
  copy,
  parseSchema,
} from "../src/domain/form";
import { newForm } from "../src/domain/workspace";
import { useFormDesigner } from "../src/features/forms/useFormDesigner";
import VisibilityRules from "../src/features/forms/components/VisibilityRules.vue";

let app: ReturnType<typeof createApp> | undefined;
const settle = async () => {
  for (let i = 0; i < 10; i++) await nextTick();
};
const control = <T extends HTMLElement = HTMLElement>(label: string) =>
  document.querySelector<T>(`[aria-label="${label}"]`)!;
const button = (name: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (el) => el.textContent?.trim() === name,
  )!;
async function mount(render: Parameters<typeof createApp>[0]) {
  document.body.innerHTML = '<div id="app"></div>';
  app = createApp(render);
  app.use(createPinia());
  app.mount("#app");
  await settle();
}
function sample() {
  const schema = reactive(emptySchema());
  schema.fields = [
    createField("radio", {
      id: "kind",
      label: "仓库",
      options: [
        { id: "sh", label: "上海仓" },
        { id: "gz", label: "广州仓" },
        { id: "other", label: "其他", other: true },
      ],
    }),
    createField("text", { id: "detail", label: "办理说明" }),
    createField("text", { id: "note", label: "备注" }),
  ];
  return schema;
}
afterEach(() => {
  app?.unmount();
  document.body.innerHTML = "";
  localStorage.clear();
});

it("new main and subform rule pickers only show fields in their value scope; invalid input stays editable", async () => {
  const schema = sample();
  schema.fields.push(
    createField("subform", {
      id: "rows",
      label: "明细",
      children: [
        createField("radio", { id: "rowKind", label: "行类型" }),
        createField("text", { id: "rowDetail", label: "行说明" }),
      ],
    }),
  );
  await mount({ render: () => h(VisibilityRules, { schema }) });
  button("添加显隐规则").click();
  await settle();
  button("确定").click();
  await settle();
  expect(document.querySelector('[role="alert"]')?.textContent).toContain(
    "请选择",
  );
  button("添加条件").click();
  await settle();
  expect(
    [...control<HTMLSelectElement>("条件字段 1").options].map(
      (option) => option.value,
    ),
  ).not.toContain("rowKind");
  button("取消").click();
  await settle();
  expect(schema.settings.rules).toEqual([]);
  app!.unmount();
  await mount({
    render: () => h(VisibilityRules, { schema, scopeId: "rows" }),
  });
  button("添加显隐规则").click();
  await settle();
  button("添加条件").click();
  await settle();
  expect(
    [...control<HTMLSelectElement>("条件字段 1").options].map(
      (option) => option.value,
    ),
  ).toEqual(["", "rowKind", "rowDetail"]);
});

it("field deletion, trash restore and undo preserve rule identities and immutable publication", async () => {
  const record = newForm("oa", "验收");
  record.schema = sample();
  record.schema.settings.rules = [
    {
      id: "r",
      conditions: [{ sourceId: "kind", operator: "equals", value: "sh" }],
      match: "all",
      targetIds: ["detail", "note"],
    },
  ];
  record.published = {
    version: 1,
    title: record.title,
    schema: copy(record.schema),
    workflow: copy(record.workflow),
    publishedAt: "2026-10-09",
  };
  const original = copy(record.schema),
    published = copy(record.published),
    form = shallowRef(record);
  let editor!: ReturnType<typeof useFormDesigner>;
  await mount({
    setup() {
      editor = useFormDesigner(form);
      return () => h("div");
    },
  });
  editor.remove(["detail"]);
  await settle();
  expect(form.value.schema.settings.rules[0]!.targetIds).toEqual(["note"]);
  expect(() => parseSchema(form.value.schema)).not.toThrow();
  editor.restore(0);
  await settle();
  expect(form.value.schema.fields.map((field) => field.id)).toEqual([
    "kind",
    "note",
    "detail",
  ]);
  expect(
    form.value.schema.fields.find((field) => field.id === "detail"),
  ).toEqual(original.fields[1]);
  expect(form.value.schema.settings).toEqual(original.settings);
  editor.remove(["kind"]);
  editor.remove(["detail", "note"]);
  await settle();
  expect(form.value.schema.settings.rules).toEqual([]);
  editor.restore(2);
  await settle();
  editor.restore(1);
  await settle();
  editor.restore(0);
  await settle();
  expect(form.value.schema.settings.rules).toEqual(original.settings.rules);
  editor.remove(["kind"]);
  await settle();
  await editor.undo();
  await settle();
  expect(form.value.schema.settings.rules).toEqual(original.settings.rules);
  expect(form.value.published).toEqual(published);
});
