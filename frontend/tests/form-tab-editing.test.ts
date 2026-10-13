// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { createApp, h, nextTick, shallowRef } from "vue";
import { createPinia } from "pinia";
import {
  copy,
  countFormFields,
  createField,
  emptySchema,
  findField,
  parseSchema,
} from "../src/domain/form";
import { newForm, type FormRecord } from "../src/domain/workspace";
import { useFormDesigner } from "../src/features/forms/useFormDesigner";
import FieldCanvas from "../src/features/forms/components/FieldCanvas.vue";
const cleanups: (() => void)[] = [];
const flush = async () => {
  for (let i = 0; i < 8; i++) await nextTick();
};
afterEach(() => {
  cleanups.splice(0).forEach((fn) => fn());
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});
function fixture() {
  const schema = emptySchema();
  const tabs = createField("tabs", {
    id: "tabs",
    tabs: [
      { id: "a", label: "申请" },
      { id: "b", label: "审批" },
      { id: "c", label: "其他" },
    ],
  });
  const amount = createField("number", {
    id: "amount",
    label: "金额",
    defaultValue: 3,
    tabId: "a",
  });
  const total = createField("calculated", {
    id: "total",
    label: "总额",
    expression: "{{amount}}*2+{{external}}",
    tabId: "a",
  });
  const note = createField("text", {
    id: "note",
    label: "意见",
    tabId: "b",
    defaultValue: "已保存",
  });
  const external = createField("number", { id: "external", defaultValue: 1 });
  tabs.children = [amount, note, total];
  schema.fields = [external, tabs, createField("text", { id: "after" })];
  schema.settings.rules = [
    {
      id: "rule",
      sourceId: "amount",
      operator: "greater",
      value: "0",
      targetIds: ["total", "after"],
    },
  ];
  return { schema, tabs };
}
async function harness(schema = fixture().schema) {
  const form = shallowRef<FormRecord>({
    ...newForm("oa", "标签编辑验收"),
    schema: copy(schema),
  });
  let editor!: ReturnType<typeof useFormDesigner>;
  const messages: string[] = [];
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp({
    setup() {
      editor = useFormDesigner(form, (message) => messages.push(message));
      const tabField = form.value.schema.fields.find((f) => f.type === "tabs");
      if (tabField) editor.select(tabField.id);
      return () =>
        h(FieldCanvas, {
          fields: form.value.schema.fields,
          selectedIds: editor.selectedIds.value,
          activeTabId: editor.activeTabId.value,
          onSelect: editor.select,
          onContext: editor.setContext,
          onDrop: editor.drop,
        });
    },
  });
  app.use(createPinia());
  app.mount(host);
  cleanups.push(() => app.unmount());
  await flush();
  return { host, form, editor, messages };
}
it("keeps one main tabs field across add, duplicate, drop and restore; ordinary fields may still be added inside it", async () => {
  const { editor, form, messages } = await harness();
  const before = copy(form.value.schema);
  editor.add("tabs", null);
  editor.add("tabs", "tabs");
  editor.duplicate("tabs");
  editor.drop({ id: "tabs", parentId: "amount", index: 0 });
  expect(form.value.schema).toEqual(before);
  expect(messages).toHaveLength(4);
  editor.add("text", "tabs", "deleted-tab");
  expect(
    findField(form.value.schema.fields, "tabs")!.children.at(-1)!.tabId,
  ).toBe("a");
  form.value.fieldTrash = [
    { field: createField("tabs"), parentId: null, rules: [] },
  ];
  expect(editor.restore(0)).toBe(false);
  expect(form.value.fieldTrash).toHaveLength(1);
});
it("allows 300 real fields plus one tabs container consistently on add and trash restore", async () => {
  const schema = emptySchema();
  schema.fields = Array.from({ length: 299 }, () => createField("text"));
  const { editor, form } = await harness(schema);
  expect(editor.add("tabs", null)).toBeTruthy();
  expect(editor.add("text", null)).toBeTruthy();
  expect(editor.add("text", null)).toBeUndefined();
  expect(countFormFields(form.value.schema.fields)).toBe(300);
  const id = form.value.schema.fields[0]!.id;
  editor.remove([id]);
  expect(editor.restore(0)).toBe(true);
  expect(() => parseSchema(form.value.schema)).not.toThrow();
});
it("moves a field into a tab with more than 150 children instead of silently ignoring the drop", async () => {
  const schema = emptySchema(),
    tabs = createField("tabs");
  tabs.children = Array.from({ length: 151 }, () =>
    createField("text", { tabId: tabs.tabs[0]!.id }),
  );
  const moved = createField("text");
  schema.fields = [tabs, moved];
  const { editor, form } = await harness(schema);
  editor.drop({
    id: moved.id,
    parentId: tabs.id,
    tabId: tabs.tabs[0]!.id,
    index: 151,
  });
  expect(
    findField(form.value.schema.fields, tabs.id)!.children.at(-1)!.id,
  ).toBe(moved.id);
});

it("reveals the owning tab when restoring selection of a nested field or moving between tabs", async () => {
  const { schema, tabs } = fixture();
  const rows = createField("subform", {
    id: "rows",
    tabId: "b",
    children: [createField("text", { id: "sku" })],
  });
  tabs.children.push(rows);
  const { host, editor } = await harness(schema);
  editor.select("sku");
  await flush();
  expect(
    host.querySelector('[role="tab"][aria-selected="true"]')?.textContent,
  ).toBe("审批");
  editor.select("amount");
  editor.drop({ id: "amount", parentId: "tabs", tabId: "b", index: 0 });
  await flush();
  expect(editor.activeTabId.value).toBe("b");
  expect(
    host.querySelector('[role="tab"][aria-selected="true"]')?.textContent,
  ).toBe("审批");
});
