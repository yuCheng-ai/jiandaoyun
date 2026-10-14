// @vitest-environment jsdom
// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApp, h, shallowRef, type Ref } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { copy, createField } from "../src/domain/form";
import { newForm, type FormRecord } from "../src/domain/workspace";
import { useFormDesigner } from "../src/features/forms/useFormDesigner";

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
