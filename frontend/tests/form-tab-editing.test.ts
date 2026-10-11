// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { createApp, h, nextTick, shallowRef, triggerRef } from "vue";
import { createPinia } from "pinia";
import {
  copy,
  countFormFields,
  createField,
  emptySchema,
  findField,
  flattenFields,
  parseSchema,
  defaultValues,
  resolveCalculations,
} from "../src/domain/form";
import { editFormTabs } from "../src/domain/formTabs";
import { emptyDateRange } from "@platform/contracts";
import { newForm, type FormRecord } from "../src/domain/workspace";
import { useFormDesigner } from "../src/features/forms/useFormDesigner";
import TabFieldInspector from "../src/features/forms/components/TabFieldInspector.vue";
import FieldCanvas from "../src/features/forms/components/FieldCanvas.vue";
import FormFields from "../src/features/forms/components/FormFields.vue";
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
it("copies a complete tab with fresh field identities, internal formulas and visibility rules while retaining external references", () => {
  const { schema } = fixture(),
    before = copy(schema);
  const result = editFormTabs(schema, "tabs", { type: "copy", tabId: "a" });
  const tabs = findField(result.schema.fields, "tabs")!;
  expect(tabs.tabs.map((t) => t.label)).toEqual([
    "申请",
    "申请_拷贝",
    "审批",
    "其他",
  ]);
  const clones = tabs.children.filter((f) => f.tabId === result.tabId);
  expect(clones.map((f) => f.label)).toEqual(["金额_拷贝", "总额_拷贝"]);
  expect(clones[0]!.id).not.toBe("amount");
  expect(clones[1]!.expression).toBe(`{{${clones[0]!.id}}}*2+{{external}}`);
  expect(result.schema.settings.rules[1]).toMatchObject({
    sourceId: clones[0]!.id,
    targetIds: [clones[1]!.id],
  });
  const values = resolveCalculations(
    result.schema.fields,
    defaultValues(result.schema.fields),
  );
  expect(values[clones[1]!.id]).toBe(7);
  expect(values.total).toBe(7);
  expect(schema).toEqual(before);
  expect(parseSchema(result.schema)).toEqual(result.schema);
});
it("remaps organization, date, source filters and mapping targets across copied siblings", () => {
  const { schema, tabs } = fixture();
  const member = createField("member", { tabId: "a" });
  member.organization.scope = {
    ...member.organization.scope,
    fieldId: "amount",
  };
  member.reference.mappings = [
    { sourceFieldId: "remote", targetFieldId: "total" },
  ];
  member.choiceSource.filters = [
    {
      id: "filter",
      sourceFieldId: "remote",
      source: "field",
      value: "amount",
      operator: "equals",
    },
  ];
  const date = createField("datetime", {
    tabId: "a",
    dateRange: emptyDateRange(),
  });
  date.dateRange!.earliest.fieldId = "amount";
  date.dateRange!.latest.fieldId = "external";
  tabs.children.push(member, date);
  const result = editFormTabs(schema, "tabs", { type: "copy", tabId: "a" });
  const clones = findField(result.schema.fields, "tabs")!.children.filter(
    (f) => f.tabId === result.tabId,
  );
  expect(clones[2]!.organization.scope.fieldId).toBe(clones[0]!.id);
  expect(clones[2]!.choiceSource.filters[0]!.value).toBe(clones[0]!.id);
  expect(clones[2]!.reference.mappings[0]!.targetFieldId).toBe(clones[1]!.id);
  expect(clones[2]!.reference.mappings[0]!.sourceFieldId).toBe("remote");
  expect(clones[3]!.dateRange!.earliest.fieldId).toBe(clones[0]!.id);
  expect(clones[3]!.dateRange!.latest.fieldId).toBe("external");
});
it("copies subform columns together, omits serial fields and leaves existing records and published snapshots unchanged", () => {
  const { schema, tabs } = fixture();
  const rows = createField("subform", {
    id: "rows",
    tabId: "a",
    children: [
      createField("number", { id: "qty" }),
      createField("calculated", { id: "subtotal", expression: "{{qty}}*2" }),
    ],
  });
  tabs.children.push(createField("serial", { id: "serial", tabId: "a" }), rows);
  const record = {
    serial: "SN001",
    amount: 4,
    rows: [{ id: "saved-row", qty: 5, subtotal: 10 }],
  };
  const snapshot = copy(schema),
    before = copy(record);
  const result = editFormTabs(schema, "tabs", { type: "copy", tabId: "a" });
  const clones = findField(result.schema.fields, "tabs")!.children.filter(
    (f) => f.tabId === result.tabId,
  );
  expect(flattenFields(clones).some((f) => f.type === "serial")).toBe(false);
  const copiedRows = clones.find((f) => f.type === "subform")!;
  expect(copiedRows.children[1]!.expression).toBe(
    `{{${copiedRows.children[0]!.id}}}*2`,
  );
  expect(
    new Set(flattenFields(result.schema.fields).map((f) => f.id)).size,
  ).toBe(flattenFields(result.schema.fields).length);
  expect(schema).toEqual(snapshot);
  expect(record).toEqual(before);
});
it("removes only the tab and returns its fields in their original order without changing identities, rules or values", () => {
  const { schema } = fixture(),
    before = copy(schema),
    values = { amount: 3, total: 7, note: "已保存", external: 1 };
  const result = editFormTabs(schema, "tabs", { type: "remove", tabId: "a" });
  expect(result.schema.fields.map((f) => f.id)).toEqual([
    "external",
    "tabs",
    "amount",
    "total",
    "after",
  ]);
  expect(
    findField(result.schema.fields, "tabs")!.children.map((f) => f.id),
  ).toEqual(["note"]);
  expect(findField(result.schema.fields, "amount")!.tabId).toBeUndefined();
  expect(findField(result.schema.fields, "total")!.expression).toBe(
    "{{amount}}*2+{{external}}",
  );
  expect(result.schema.settings.rules).toEqual(schema.settings.rules);
  expect(resolveCalculations(result.schema.fields, values)).toEqual(values);
  expect(schema).toEqual(before);
});
it("reorders persisted tabs without rewriting field order, identity or data", () => {
  const { schema } = fixture();
  const result = editFormTabs(schema, "tabs", {
    type: "move",
    tabId: "c",
    index: 0,
  });
  expect(
    findField(parseSchema(result.schema).fields, "tabs")!.tabs.map((t) => t.id),
  ).toEqual(["c", "a", "b"]);
  expect(findField(result.schema.fields, "tabs")!.children).toEqual(
    findField(schema.fields, "tabs")!.children,
  );
});
it("enforces 2–50 on remove, add and copy without partial changes, including stale confirmations", () => {
  const { schema, tabs } = fixture();
  tabs.tabs = tabs.tabs.slice(0, 2);
  const before = copy(schema);
  expect(() =>
    editFormTabs(schema, "tabs", { type: "remove", tabId: "a" }),
  ).toThrow("2");
  expect(schema).toEqual(before);
  tabs.tabs = Array.from({ length: 50 }, (_, i) => ({
    id: `t${i}`,
    label: String(i),
  }));
  expect(() => editFormTabs(schema, "tabs", { type: "add" })).toThrow("50");
  expect(() =>
    editFormTabs(schema, "tabs", { type: "copy", tabId: "t0" }),
  ).toThrow("50");
  expect(() =>
    editFormTabs(schema, "tabs", { type: "remove", tabId: "missing" }),
  ).toThrow("重新选择");
  expect(tabs.tabs).toHaveLength(50);
});
it("adds an empty tab at the end and can copy an empty tab at the field limit", () => {
  const schema = emptySchema(),
    tabs = createField("tabs");
  schema.fields = [
    tabs,
    ...Array.from({ length: 300 }, () => createField("text")),
  ];
  const result = editFormTabs(schema, tabs.id, { type: "add" });
  expect(findField(result.schema.fields, tabs.id)!.tabs.at(-1)!.id).toBe(
    result.tabId,
  );
  const copied = editFormTabs(result.schema, tabs.id, {
    type: "copy",
    tabId: result.tabId,
  });
  expect(countFormFields(copied.schema.fields)).toBe(300);
  expect(() => parseSchema(copied.schema)).not.toThrow();
});
it("counts tab children but not tab containers, and rejects a copy beyond 300 atomically", () => {
  const { schema, tabs } = fixture();
  schema.fields.push(...Array.from({ length: 293 }, () => createField("text")));
  expect(countFormFields(schema.fields)).toBe(298);
  const result = editFormTabs(schema, "tabs", { type: "copy", tabId: "a" });
  expect(countFormFields(result.schema.fields)).toBe(300);
  expect(() => parseSchema(result.schema)).not.toThrow();
  const before = copy(result.schema);
  expect(() =>
    editFormTabs(result.schema, "tabs", { type: "copy", tabId: "a" }),
  ).toThrow("300");
  expect(result.schema).toEqual(before);
  tabs.children.push(createField("text"));
  schema.fields.push(createField("text"), createField("text"));
  expect(() => parseSchema(schema)).toThrow("数量超限");
});
it("loads old single-tab and nested layouts without silently changing them; copying cannot create another nested tabs field", () => {
  const { schema, tabs } = fixture();
  const nested = createField("tabs", {
    tabId: "a",
    tabs: [{ id: "old", label: "旧标签" }],
  });
  tabs.children.push(nested);
  expect(findField(parseSchema(schema).fields, nested.id)!.tabs).toEqual(
    nested.tabs,
  );
  const before = copy(schema);
  expect(() =>
    editFormTabs(schema, "tabs", { type: "copy", tabId: "a" }),
  ).toThrow("一个");
  expect(schema).toEqual(before);
});
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
      return () => {
        const field = editor.selected.value;
        return h("main", [
          h(
            "button",
            {
              onClick: () => {
                editor.add("text");
                triggerRef(form);
              },
            },
            "新增文本",
          ),
          h(FieldCanvas, {
            fields: form.value.schema.fields,
            selectedIds: editor.selectedIds.value,
            activeTabId: editor.activeTabId.value,
            onSelect: editor.select,
            onContext: editor.setContext,
            onDrop: editor.drop,
          }),
          field?.type === "tabs"
            ? h(TabFieldInspector, {
                field,
                schema: form.value.schema,
                applySchema: (schema: ReturnType<typeof emptySchema>) => {
                  editor.transact(() => {
                    form.value.schema = schema;
                    triggerRef(form);
                  });
                },
                onUpdate: (patch: Record<string, unknown>) => {
                  Object.assign(field, patch);
                  triggerRef(form);
                },
                onSelect: (id: string) => {
                  editor.setContext(field.id, id);
                },
              })
            : null,
        ]);
      };
    },
  });
  app.use(createPinia());
  app.mount(host);
  cleanups.push(() => app.unmount());
  await flush();
  return { host, form, editor, messages };
}
const button = (host: Element, label: string) =>
  host.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;
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
it("cancels deletion using Escape, outside click and Cancel without changing the schema", async () => {
  const { host, form } = await harness(),
    before = copy(form.value.schema);
  const remove = button(host, "删除标签页 1");
  remove.focus();
  remove.click();
  await flush();
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  document.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
  );
  await flush();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement).toBe(remove);
  remove.click();
  await flush();
  document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
  await flush();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  remove.click();
  await flush();
  Array.from(
    document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button'),
  )
    .find((b) => b.textContent?.trim() === "取消")!
    .click();
  await flush();
  expect(form.value.schema).toEqual(before);
});
it("confirms deletion in one undoable change and restores the exact fields, tabs and rules on undo/redo", async () => {
  const { host, form, editor } = await harness(),
    before = copy(form.value.schema);
  button(host, "删除标签页 1").click();
  await flush();
  Array.from(
    document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button'),
  )
    .find((b) => b.textContent?.trim() === "删除")!
    .click();
  await flush();
  expect(findField(form.value.schema.fields, "amount")!.tabId).toBeUndefined();
  const after = copy(form.value.schema);
  await editor.undo();
  triggerRef(form);
  await flush();
  expect(form.value.schema).toEqual(before);
  await editor.redo();
  triggerRef(form);
  await flush();
  expect(form.value.schema).toEqual(after);
});
it("selects the copied tab on the canvas and puts the next dragged/click-added field in that tab", async () => {
  const { host, form, editor } = await harness();
  button(host, "复制标签页 1").click();
  await flush();
  const tabs = findField(form.value.schema.fields, "tabs")!,
    clone = tabs.tabs[1]!;
  expect(
    host.querySelector('[role="tab"][aria-selected="true"]')!.textContent,
  ).toBe("申请_拷贝");
  expect(document.activeElement?.id).toBe(`tab-label-${clone.id}`);
  expect(editor.activeTabId.value).toBe(clone.id);
  Array.from(host.querySelectorAll<HTMLButtonElement>("button"))
    .find((b) => b.textContent === "新增文本")!
    .click();
  await flush();
  expect(
    findField(form.value.schema.fields, "tabs")!.children.at(-1)!.tabId,
  ).toBe(clone.id);
});

it("keeps an inspector-selected tab visible when adding and editing its nested subform", async () => {
  const { host, form, editor } = await harness();
  const label = host.querySelector<HTMLInputElement>(
    '[aria-label="标签页 2"]',
  )!;
  label.focus();
  label.value = "审批资料";
  label.dispatchEvent(new Event("input", { bubbles: true }));
  await flush();
  const rows = editor.add("subform")!;
  triggerRef(form);
  await flush();
  expect(rows.tabId).toBe("b");
  expect(
    host.querySelector('[role="tab"][aria-selected="true"]')?.textContent,
  ).toBe("审批资料");
  const child = editor.add("text")!;
  triggerRef(form);
  await flush();
  expect(findField(form.value.schema.fields, rows.id)!.children[0]!.id).toBe(
    child.id,
  );
  expect(
    host.querySelector(`[aria-label="${rows.label}子字段"]`),
  ).not.toBeNull();
  editor.select("external");
  await flush();
  expect(
    host.querySelector('[role="tab"][aria-selected="true"]')?.textContent,
  ).toBe("审批资料");
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
it("supports keyboard reorder with the same saved and runtime order, without treating rename keystrokes as drag commands", async () => {
  const { host, form } = await harness();
  const handle = button(host, "排序标签页 2");
  handle.focus();
  handle.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "ArrowUp",
      altKey: true,
      bubbles: true,
      cancelable: true,
    }),
  );
  await flush();
  expect(document.activeElement).toBe(handle);
  expect(
    findField(form.value.schema.fields, "tabs")!.tabs.map((t) => t.id),
  ).toEqual(["b", "a", "c"]);
  const runtime = document.createElement("div");
  document.body.append(runtime);
  const schema = parseSchema(form.value.schema),
    app = createApp(FormFields, {
      schema,
      fields: schema.fields,
      values: defaultValues(schema.fields),
    });
  app.use(createPinia());
  app.mount(runtime);
  cleanups.push(() => app.unmount());
  await flush();
  expect(
    Array.from(runtime.querySelectorAll('[role="tab"]')).map(
      (t) => t.textContent,
    ),
  ).toEqual(["审批", "申请"]);
  const input = host.querySelector<HTMLInputElement>(
    '[aria-label="标签页 1"]',
  )!;
  input.dispatchEvent(
    new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }),
  );
  await flush();
  expect(findField(form.value.schema.fields, "tabs")!.tabs[0]!.id).toBe("b");
});
it("disables both add/copy at 50 and deletion at 2, while allowing copy of a populated tab", async () => {
  const { schema, tabs } = fixture();
  tabs.tabs = tabs.tabs.slice(0, 2);
  const { host } = await harness(schema);
  expect(button(host, "删除标签页 1").disabled).toBe(true);
  expect(button(host, "复制标签页 1").disabled).toBe(false);
  const large = fixture();
  large.tabs.tabs = Array.from({ length: 50 }, (_, i) => ({
    id: String(i),
    label: String(i),
  }));
  const fifty = await harness(large.schema);
  expect(button(fifty.host, "复制标签页 1").disabled).toBe(true);
  expect(
    Array.from(fifty.host.querySelectorAll<HTMLButtonElement>("button")).find(
      (b) => b.textContent?.includes("添加标签页"),
    )!.disabled,
  ).toBe(true);
});
