// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createApp,
  defineComponent,
  h,
  nextTick,
  reactive,
  shallowRef,
  triggerRef,
} from "vue";
import { createPinia } from "pinia";
import {
  copy,
  createField,
  fieldRegistry,
  flattenFields,
  moveField,
  parseSchema,
} from "../src/domain/form";
import {
  newForm,
  seedWorkspace,
  type FormRecord,
} from "../src/domain/workspace";
import { useFormDesigner } from "../src/features/forms/useFormDesigner";
import FieldCanvas from "../src/features/forms/components/FieldCanvas.vue";
import FormDesignerView from "../src/features/forms/FormDesignerView.vue";
const mocks = vi.hoisted(() => ({ workspace: undefined as any }));
vi.mock("vue-router", () => ({
  useRoute: () => ({ params: { appId: "oa", formId: "form" } }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
vi.mock("../src/stores/workspace", () => ({
  useWorkspaceStore: () => mocks.workspace,
  syncFormWorkflow: vi.fn(),
}));
vi.mock("../src/components/shared/DesignerHeader.vue", () => ({
  default: defineComponent({ render: () => h("header") }),
}));
const allowed = [
  "text",
  "textarea",
  "number",
  "datetime",
  "radio",
  "checkbox",
  "select",
  "multiselect",
  "member",
  "members",
  "department",
  "departments",
  "image",
  "file",
  "address",
  "location",
  "query",
  "lookup",
  "signature",
];
const cleanups: (() => void)[] = [];
beforeEach(() => {
  const draft = newForm("oa", "子表编辑验收");
  draft.id = "form";
  const data = seedWorkspace();
  data.forms = [copy(draft)];
  mocks.workspace = reactive({
    data,
    activeForms: data.forms,
    drafts: { form: draft },
    openForm: vi.fn(() => draft),
    notify: vi.fn(),
    saveForm: vi.fn(),
  });
  document.body.innerHTML = '<div id="mount"></div>';
});
afterEach(() => {
  cleanups.splice(0).forEach((fn) => fn());
  document.body.innerHTML = "";
});
async function flush() {
  for (let i = 0; i < 6; i++) await nextTick();
}
function harness(input = newForm("oa", "编辑验收")) {
  const form = shallowRef<FormRecord>(input),
    messages: string[] = [];
  let editor!: ReturnType<typeof useFormDesigner>;
  const app = createApp({
    setup() {
      editor = useFormDesigner(form, (message) => messages.push(message));
      return () => h("div");
    },
  });
  app.mount("#mount");
  cleanups.push(() => app.unmount());
  return { form, editor, messages };
}
it("adding or selecting a container makes subsequent clicks add within that container; main fields reset the target", () => {
  const { form, editor } = harness();
  const main = editor.add("text")!,
    rows = editor.add("subform", null)!;
  const child = editor.add("number")!;
  expect(form.value.schema.fields.map((f) => f.id)).toEqual([main.id, rows.id]);
  expect(rows.children[0]?.id).toBe(child.id);
  editor.select(main.id);
  expect(editor.activeParent.value).toBeNull();
  editor.select(rows.id);
  expect(editor.activeParent.value).toBe(rows.id);
  const second = editor.add("text")!;
  expect(rows.children.at(-1)?.id).toBe(second.id);
  const tabs = editor.add("tabs", null)!;
  const tabChild = editor.add("text")!;
  expect(tabs.children[0]?.id).toBe(tabChild.id);
  expect(tabChild.tabId).toBe(tabs.tabs[0]?.id);
});
it("cross-container dragging changes the subsequent click target while preserving field identity and undo", async () => {
  const { form, editor } = harness();
  const main = editor.add("text")!,
    rows = editor.add("subform", null)!;
  editor.drop({ id: main.id, parentId: rows.id, index: 0 });
  expect(rows.children[0]).toBe(main);
  expect(editor.activeParent.value).toBe(rows.id);
  editor.add("number");
  expect(rows.children).toHaveLength(2);
  await editor.undo();
  expect(form.value.schema.fields[0]?.children).toHaveLength(1);
  editor.drop({ id: main.id, index: 1 });
  expect(editor.activeParent.value).toBeNull();
  editor.add("text");
  expect(form.value.schema.fields).toHaveLength(3);
});
it("the registry supports exactly the source child types, and click/new-drop/move reject unsupported additions atomically", () => {
  const { form, editor, messages } = harness();
  const rows = editor.add("subform", null)!;
  for (const definition of fieldRegistry) {
    if (allowed.includes(definition.type)) {
      expect(editor.add(definition.type, rows.id)).toBeTruthy();
    } else {
      const before = copy(form.value.schema);
      expect(editor.add(definition.type, rows.id)).toBeUndefined();
      editor.drop({ type: definition.type, parentId: rows.id, index: 0 });
      expect(form.value.schema).toEqual(before);
      const main = createField(definition.type);
      form.value.schema.fields.push(main);
      const withMain = copy(form.value.schema);
      expect(moveField(form.value.schema.fields, main.id, rows.id, 0)).toBe(
        false,
      );
      editor.drop({ id: main.id, parentId: rows.id, index: 0 });
      expect(form.value.schema).toEqual(withMain);
    }
  }
  expect(rows.children.map((f) => f.type)).toEqual(allowed);
  expect(messages.length).toBeGreaterThan(0);
});
it("legacy child types remain loadable, editable, reorderable and recoverable without changing snapshots or saved values", () => {
  const input = newForm("oa", "旧表"),
    legacy = createField("calculated", {
      id: "total",
      expression: "{{qty}}*2",
    });
  const rows = createField("subform", {
    id: "rows",
    children: [createField("number", { id: "qty" }), legacy],
  });
  const other = createField("subform", { id: "other" });
  input.schema.fields = [rows, other];
  const published = copy(input.schema),
    values = { rows: [{ qty: 2, total: 4 }] },
    beforeValues = copy(values);
  const { form, editor } = harness(input);
  expect(parseSchema(input.schema)).toEqual(published);
  editor.duplicate("total");
  expect(input.schema).toEqual(published);
  expect(moveField(input.schema.fields, "total", "rows", 0)).toBe(true);
  const before = copy(input.schema);
  expect(moveField(input.schema.fields, "total", "other", 0)).toBe(false);
  expect(input.schema).toEqual(before);
  editor.select("rows");
  editor.remove(["total"]);
  expect(editor.selectedIds.value).toEqual(["rows"]);
  expect(editor.restore(0)).toBe(true);
  expect(form.value.schema.fields[0]?.children.at(-1)?.id).toBe("total");
  expect(values).toEqual(beforeValues);
  expect(published.fields[0]?.children[1]?.id).toBe("total");
});
it("undoing a newly added container clears its stale insertion target and allows the next main field", async () => {
  const { form, editor } = harness();
  editor.add("subform", null);
  triggerRef(form);
  await flush();
  await editor.undo();
  expect(editor.activeParent.value).toBeNull();
  const main = editor.add("text")!;
  expect(form.value.schema.fields.map((f) => f.id)).toEqual([main.id]);
});
it("clicking a container title uses the container, and clicking a tab child keeps its correct tab scope", async () => {
  const rows = createField("subform", { id: "rows" }),
    tabs = createField("tabs", { id: "tabs" });
  const child = createField("text", { id: "child", tabId: tabs.tabs[1]!.id });
  tabs.children.push(child);
  const context = vi.fn(),
    select = vi.fn();
  const app = createApp({
    render: () =>
      h(FieldCanvas, {
        fields: [rows, tabs],
        selectedIds: [],
        onContext: context,
        onSelect: select,
      }),
  });
  app.use(createPinia());
  app.mount("#mount");
  cleanups.push(() => app.unmount());
  await flush();
  document
    .querySelector<HTMLElement>('[data-field-id="rows"] > .field-design-label')!
    .click();
  expect(context).toHaveBeenLastCalledWith("rows", undefined);
  document
    .querySelector<HTMLElement>('[data-field-id="tabs"] > .field-design-label')!
    .click();
  expect(context).toHaveBeenLastCalledWith("tabs", tabs.tabs[0]?.id);
});
async function mountDesigner() {
  const app = createApp(FormDesignerView);
  app.use(createPinia());
  app.mount("#mount");
  cleanups.push(() => app.unmount());
  await flush();
}
it("the subfield menu exposes only allowed types, adds once to the selected parent and closes with focus on the new field", async () => {
  const rows = createField("subform", { id: "rows" });
  mocks.workspace.drafts.form.schema.fields = [rows];
  await mountDesigner();
  document.querySelector<HTMLElement>('[data-field-id="rows"]')!.click();
  await flush();
  document
    .querySelector<HTMLButtonElement>('[aria-label="添加子字段"]')!
    .click();
  await flush();
  const menu = document.querySelector('[aria-label="子字段类型"]')!;
  expect(menu.querySelectorAll("button[data-field-type]")).toHaveLength(19);
  expect(menu.querySelector('[data-field-type="ocr"]')).toBeNull();
  menu.querySelector<HTMLButtonElement>('[data-field-type="number"]')!.click();
  await flush();
  expect(mocks.workspace.drafts.form.schema.fields).toHaveLength(1);
  expect(mocks.workspace.drafts.form.schema.fields[0].children).toHaveLength(1);
  expect(document.querySelector('[aria-label="子字段类型"]')).toBeNull();
  expect(document.activeElement?.id).toBe("field-title");
});
it("subfield copying remaps references, sorting and delete/undo retain the parent list and identities", async () => {
  const quantity = createField("number", { id: "qty", label: "数量" }),
    amount = createField("number", {
      id: "amount",
      label: "金额",
      defaultFormula: true,
      expression: "{{qty}}*2",
    });
  const rows = createField("subform", {
    id: "rows",
    children: [quantity, amount],
  });
  mocks.workspace.drafts.form.schema.fields = [rows];
  const original = copy(rows);
  await mountDesigner();
  document.querySelector<HTMLElement>('[data-field-id="rows"]')!.click();
  await flush();
  document
    .querySelector<HTMLButtonElement>('[aria-label="复制子字段 金额"]')!
    .click();
  await flush();
  const children = mocks.workspace.drafts.form.schema.fields[0].children;
  expect(children).toHaveLength(3);
  expect(children[2].id).not.toBe("amount");
  expect(children[2].defaultFormula).toBe(true);
  expect(children[2].expression).toBe("{{qty}}*2");
  expect(document.querySelector('[aria-label="子字段"]')).not.toBeNull();
  const handle = document.querySelector<HTMLButtonElement>(
    '[aria-label="排序子字段 数量"]',
  )!;
  handle.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "ArrowDown",
      altKey: true,
      bubbles: true,
      cancelable: true,
    }),
  );
  await flush();
  expect(children[1].id).toBe("qty");
  document
    .querySelector<HTMLButtonElement>('[aria-label="删除子字段 数量"]')!
    .click();
  await flush();
  expect(
    mocks.workspace.drafts.form.schema.fields[0].children.map((f: any) => f.id),
  ).toContain("qty");
  expect(document.body.textContent).toContain("计算公式");
  [...document.querySelectorAll<HTMLButtonElement>("button")]
    .find((b) => b.textContent?.trim() === "仍然删除字段")!
    .click();
  await flush();
  expect(
    mocks.workspace.drafts.form.schema.fields[0].children.map((f: any) => f.id),
  ).not.toContain("qty");
  expect(document.querySelector('[aria-label="子字段"]')).not.toBeNull();
  window.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "z",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    }),
  );
  await flush();
  expect(
    mocks.workspace.drafts.form.schema.fields[0].children.map((f: any) => f.id),
  ).toContain("qty");
  expect(original.children.map((f) => f.id)).toEqual(["qty", "amount"]);
});
it("subfield menu keyboard navigation and Escape/outside dismissal preserve inputs and return focus", async () => {
  const rows = createField("subform", { id: "rows" });
  mocks.workspace.drafts.form.schema.fields = [rows];
  await mountDesigner();
  document.querySelector<HTMLElement>('[data-field-id="rows"]')!.click();
  await flush();
  const trigger = document.querySelector<HTMLButtonElement>(
      '[aria-label="添加子字段"]',
    )!,
    before = copy(mocks.workspace.drafts.form.schema);
  trigger.click();
  await flush();
  document.activeElement!.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "End",
      bubbles: true,
      cancelable: true,
    }),
  );
  await flush();
  expect(document.activeElement?.getAttribute("data-field-type")).toBe(
    "signature",
  );
  document.activeElement!.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    }),
  );
  await flush();
  expect(document.querySelector('[aria-label="子字段类型"]')).toBeNull();
  expect(document.activeElement).toBe(trigger);
  expect(mocks.workspace.drafts.form.schema).toEqual(before);
  trigger.click();
  await flush();
  document
    .querySelector<HTMLElement>(".form-design-scroll")!
    .dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
  await flush();
  expect(document.querySelector('[aria-label="子字段类型"]')).toBeNull();
  expect(mocks.workspace.drafts.form.schema).toEqual(before);
});
it("HTML drag payloads from the inspector and canvas use the same move rules and subsequent click target", async () => {
  const quantity = createField("number", { id: "qty", label: "数量" }),
    rows = createField("subform", { id: "rows", children: [quantity] });
  const main = createField("text", { id: "main" });
  mocks.workspace.drafts.form.schema.fields = [main, rows];
  await mountDesigner();
  document.querySelector<HTMLElement>('[data-field-id="rows"]')!.click();
  await flush();
  const data = new Map<string, string>(),
    transfer = {
      effectAllowed: "",
      setData: (type: string, value: string) => data.set(type, value),
      getData: (type: string) => data.get(type) || "",
    };
  const dispatch = (target: Element, type: string) => {
    const event = new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      clientY: 0,
    });
    Object.defineProperty(event, "dataTransfer", { value: transfer });
    target.dispatchEvent(event);
  };
  dispatch(
    document.querySelector('[aria-label="排序子字段 数量"]')!,
    "dragstart",
  );
  expect(JSON.parse(data.get("application/x-form-field")!)).toEqual({
    id: "qty",
  });
  dispatch(document.querySelector('[data-field-id="main"]')!, "drop");
  await flush();
  const fields = mocks.workspace.drafts.form.schema.fields;
  expect(fields.map((f: any) => f.id)).toEqual(["main", "qty", "rows"]);
  expect(fields[2].children).toEqual([]);
  document
    .querySelector<HTMLButtonElement>('[aria-label="添加单行文本"]')!
    .click();
  await flush();
  expect(mocks.workspace.drafts.form.schema.fields).toHaveLength(4);
  dispatch(document.querySelector('[data-field-id="qty"]')!, "dragstart");
  dispatch(
    document.querySelector('[data-field-id="rows"] .last-drop-zone')!,
    "drop",
  );
  await flush();
  expect(
    mocks.workspace.drafts.form.schema.fields.find((f: any) => f.id === "rows")
      .children[0].id,
  ).toBe("qty");
  document
    .querySelector<HTMLButtonElement>('[aria-label="添加单行文本"]')!
    .click();
  await flush();
  expect(
    mocks.workspace.drafts.form.schema.fields.find((f: any) => f.id === "rows")
      .children,
  ).toHaveLength(2);
});
it("accepts first entry into the inspector row and keeps an immediate drop in the original edit history", async () => {
  const item = createField("text", {
    id: "item",
    label: "商品",
    defaultValue: "原默认",
  });
  const note = createField("text", { id: "note", label: "备注" });
  const rows = createField("subform", {
    id: "rows",
    label: "明细",
    children: [item, note],
  });
  mocks.workspace.drafts.form.schema.fields = [rows];
  const before = copy(mocks.workspace.drafts.form.schema);
  await mountDesigner();
  document.querySelector<HTMLElement>('[data-field-id="rows"]')!.click();
  await flush();
  const target = document.querySelectorAll<HTMLElement>(".subfield-row")[1]!;
  vi.spyOn(target, "getBoundingClientRect").mockReturnValue({
    top: 10,
    height: 30,
  } as DOMRect);
  const event = (type: string) => {
    const e = new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      clientY: 35,
    });
    Object.defineProperty(e, "dataTransfer", {
      value: { getData: () => JSON.stringify({ id: "item" }) },
    });
    target.dispatchEvent(e);
    return e;
  };
  expect(event("dragenter").defaultPrevented).toBe(true);
  expect(mocks.workspace.drafts.form.schema).toEqual(before);
  event("drop");
  await flush();
  expect(
    mocks.workspace.drafts.form.schema.fields[0].children.map((c: any) => c.id),
  ).toEqual(["note", "item"]);
  expect(mocks.workspace.drafts.form.schema.fields[0].children[1]).toEqual(
    item,
  );
  window.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "z",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    }),
  );
  await flush();
  expect(mocks.workspace.drafts.form.schema).toEqual(before);
});
