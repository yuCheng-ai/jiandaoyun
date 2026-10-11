// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApp, computed, h, shallowRef, type Ref } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { copy, createField, findField } from "../src/domain/form";
import {
  newForm,
  seedWorkspace,
  type FormRecord,
} from "../src/domain/workspace";
import { useFormDesigner } from "../src/features/forms/useFormDesigner";
import { useWorkspaceStore } from "../src/stores/workspace";
import {
  LocalWorkspaceRepository,
  parseWorkspace,
  WORKSPACE_KEY,
} from "../src/repositories/workspaceRepository";

const disposers = new Set<() => void>();
beforeEach(() => {
  localStorage.clear();
  setActivePinia(createPinia());
});
afterEach(() => {
  [...disposers].forEach((dispose) => dispose());
  vi.restoreAllMocks();
});
function mountEditor(form: Ref<FormRecord>, report = vi.fn()) {
  let editor!: ReturnType<typeof useFormDesigner>;
  const node = document.createElement("div");
  document.body.append(node);
  const app = createApp({
    setup() {
      editor = useFormDesigner(form, report);
      return () => h("div");
    },
  });
  app.mount(node);
  const unmount = () => {
    app.unmount();
    node.remove();
    disposers.delete(unmount);
  };
  disposers.add(unmount);
  return { editor, unmount, report };
}
function simpleForm() {
  const form = newForm("oa", "回收站验收");
  form.schema.fields = [
    createField("text", {
      id: "name",
      label: "名称",
      defaultValue: "默认名称",
    }),
  ];
  return shallowRef(form);
}

it("keeps a single serial in the main form across add, drag, copy and recycle restoration", () => {
  const form = simpleForm(),
    { editor, report } = mountEditor(form);
  const rows = editor.add("subform")!,
    serial = editor.add("serial", null)!;
  expect(editor.add("serial", null)).toBeUndefined();
  expect(editor.add("serial", rows.id)).toBeUndefined();
  editor.duplicate(serial.id);
  editor.drop({ id: serial.id, parentId: rows.id, index: 0 });
  expect(
    form.value.schema.fields.filter((f) => f.type === "serial"),
  ).toHaveLength(1);
  expect(rows.children).toHaveLength(0);
  editor.remove([serial.id]);
  expect(editor.restore(0)).toBe(true);
  editor.remove([serial.id]);
  editor.add("serial", null);
  expect(editor.restore(0)).toBe(false);
  expect(editor.trash.value).toHaveLength(1);
  expect(report).toHaveBeenCalledWith("一个表单只能添加一个流水号字段");
});

it("keeps removed fields in the same unsaved form when the designer is reopened", () => {
  const form = simpleForm(),
    original = copy(form.value.schema.fields[0]);
  const first = mountEditor(form);
  first.editor.remove(["name"]);
  first.unmount();
  const second = mountEditor(form);
  expect(second.editor.trash.value).toHaveLength(1);
  expect(second.editor.restore(0)).toBe(true);
  expect(form.value.schema.fields[0]).toEqual(original);
  expect(second.editor.trash.value).toHaveLength(0);
});

it("undoes and redoes the canvas and recycle list together without creating duplicate fields", async () => {
  const form = simpleForm(),
    { editor } = mountEditor(form);
  editor.remove(["name"]);
  await editor.undo();
  expect(form.value.schema.fields.map((f) => f.id)).toEqual(["name"]);
  expect(editor.trash.value).toHaveLength(0);
  await editor.redo();
  expect(form.value.schema.fields).toHaveLength(0);
  expect(editor.trash.value).toHaveLength(1);
  expect(editor.restore(0)).toBe(true);
  await editor.undo();
  expect(form.value.schema.fields).toHaveLength(0);
  expect(editor.trash.value).toHaveLength(1);
  await editor.redo();
  expect(form.value.schema.fields.map((f) => f.id)).toEqual(["name"]);
  expect(editor.trash.value).toHaveLength(0);
});

it("persists removed subform columns and inactive rules across publication/reload, preserving old versions and record values", async () => {
  const store = useWorkspaceStore(),
    created = (await store.createForm("oa", "列恢复验收", "form"))!;
  const draft = store.openForm(created.id)!;
  draft.schema.fields = [
    createField("text", { id: "name" }),
    createField("subform", {
      id: "rows",
      children: [
        createField("number", { id: "qty" }),
        createField("text", {
          id: "note",
          label: "明细说明",
          defaultValue: "保留默认值",
        }),
      ],
    }),
  ];
  draft.schema.settings.rules = [
    {
      id: "row-rule",
      conditions: [{ sourceId: "qty", operator: "greater", value: "0" }],
      match: "all",
      targetIds: ["note"],
    },
  ];
  expect(await store.publishForm(created.id)).toBe(true);
  const entry = (await store.submitEntry(created.id, {
    name: "旧记录",
    rows: [{ qty: 2, note: "历史说明" }],
  }))!;
  const originalColumn = copy(findField(draft.schema.fields, "note")!),
    originalRules = copy(draft.schema.settings.rules);
  const publication = copy(draft.published),
    values = copy(entry.values);
  const first = mountEditor(computed(() => draft));
  first.editor.remove(["note"]);
  expect(draft.schema.settings.rules).toEqual([]);
  expect(await store.publishForm(created.id)).toBe(true);
  first.unmount();
  const fresh = useWorkspaceStore(createPinia()),
    restored = fresh.openForm(created.id)!;
  const second = mountEditor(computed(() => restored));
  expect(second.editor.trash.value[0]!.parentId).toBe("rows");
  expect(second.editor.trash.value[0]!.rules).toEqual(originalRules);
  expect(second.editor.restore(0)).toBe(true);
  expect(findField(restored.schema.fields, "note")).toEqual(originalColumn);
  expect(restored.schema.settings.rules).toEqual(originalRules);
  expect(await fresh.publishForm(created.id)).toBe(true);
  const saved = new LocalWorkspaceRepository().load()!,
    form = saved.forms.find((f) => f.id === created.id)!;
  expect(form.versions[0]).toEqual(publication);
  expect(findField(form.versions[1]!.schema.fields, "note")).toBeUndefined();
  expect(findField(form.versions[2]!.schema.fields, "note")!.id).toBe("note");
  expect(saved.entries.find((e) => e.id === entry.id)!.values).toEqual(values);
  expect(saved.entries.find((e) => e.id === entry.id)!.definitionVersion).toBe(
    1,
  );
  expect(form.fieldTrash).toEqual([]);
});

it("retains the removed field in the draft after a failed save and saves it on retry", async () => {
  const store = useWorkspaceStore(),
    created = (await store.createForm("oa", "失败重试验收", "form"))!;
  const draft = store.openForm(created.id)!;
  draft.schema.fields = copy(simpleForm().value.schema.fields);
  expect(await store.saveForm(created.id)).toBe(true);
  const committed = localStorage.getItem(WORKSPACE_KEY),
    { editor } = mountEditor(computed(() => draft));
  editor.remove(["name"]);
  const fail = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw Error("quota");
  });
  expect(await store.saveForm(created.id)).toBe(false);
  expect(localStorage.getItem(WORKSPACE_KEY)).toBe(committed);
  expect(editor.trash.value[0]!.field.id).toBe("name");
  fail.mockRestore();
  expect(await store.saveForm(created.id)).toBe(true);
  expect(
    new LocalWorkspaceRepository()
      .load()!
      .forms.find((f) => f.id === created.id)!.fieldTrash![0]!.field.id,
  ).toBe("name");
});

it("requires restoring a removed parent before its child and appends the original child identity at the end", () => {
  const form = simpleForm();
  form.value.schema.fields = [
    createField("subform", {
      id: "rows",
      children: [
        createField("text", { id: "first" }),
        createField("text", { id: "second" }),
      ],
    }),
  ];
  const { editor, report } = mountEditor(form);
  editor.remove(["first"]);
  editor.remove(["rows"]);
  expect(editor.restore(1)).toBe(false);
  expect(report).toHaveBeenCalledWith(
    expect.stringContaining("先恢复原子表单"),
  );
  expect(form.value.schema.fields).toHaveLength(0);
  expect(editor.trash.value).toHaveLength(2);
  expect(editor.restore(0)).toBe(true);
  expect(editor.restore(0)).toBe(true);
  expect(form.value.schema.fields[0]!.children.map((f) => f.id)).toEqual([
    "second",
    "first",
  ]);
});

it("does not replace a colliding identity with a new field or discard the archived configuration", () => {
  const form = simpleForm(),
    { editor } = mountEditor(form);
  editor.remove(["name"]);
  const archived = copy(editor.trash.value[0]);
  form.value.schema.fields.push(
    createField("text", { id: "name", label: "当前字段" }),
  );
  expect(editor.restore(0)).toBe(false);
  expect(form.value.schema.fields).toHaveLength(1);
  expect(form.value.schema.fields[0]!.label).toBe("当前字段");
  expect(editor.trash.value[0]).toEqual(archived);
});

it("retains an archived field when restoring it would exceed the existing field limit", () => {
  const form = simpleForm(),
    { editor } = mountEditor(form);
  editor.remove(["name"]);
  form.value.schema.fields = Array.from({ length: 300 }, (_, i) =>
    createField("text", { id: `field-${i}` }),
  );
  expect(editor.restore(0)).toBe(false);
  expect(form.value.schema.fields).toHaveLength(300);
  expect(editor.trash.value).toHaveLength(1);
});

it("reads old forms without recycle metadata and rejects malformed archived fields/rules instead of silently dropping them", () => {
  const data = seedWorkspace();
  expect(
    parseWorkspace(JSON.stringify(data)).forms[0]!.fieldTrash,
  ).toBeUndefined();
  const form = data.forms[0]!;
  form.fieldTrash = [
    {
      field: createField("text", { id: "archived" }),
      parentId: null,
      rules: [],
    },
  ];
  const invalidField = copy(data);
  invalidField.forms[0]!.fieldTrash![0]!.field.id = "__proto__";
  expect(() => parseWorkspace(JSON.stringify(invalidField))).toThrow();
  const invalidRule = copy(data);
  (invalidRule.forms[0]!.fieldTrash![0]!.rules as any[]) = [
    { id: "bad", conditions: "bad", targetIds: [] },
  ];
  expect(() => parseWorkspace(JSON.stringify(invalidRule))).toThrow();
  expect(parseWorkspace(JSON.stringify(data)).forms[0]!.fieldTrash).toEqual(
    form.fieldTrash,
  );
});
