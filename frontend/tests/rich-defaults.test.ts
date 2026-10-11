// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApp, h, nextTick, reactive, shallowRef } from "vue";
import { createPinia, setActivePinia } from "pinia";
import {
  copy,
  createField,
  emptySchema,
  parseSchema,
  validateValues,
  type FormField,
} from "../src/domain/form";
import { fieldCountLimitError } from "../src/domain/form";
import { richTextValueIssue } from "../src/domain/richText";
import {
  defaultLinkErrors,
  richTextDefaultErrors,
} from "../src/domain/fieldValidation";
import {
  applyFieldChange,
  linkedDefault,
  runtimeDefaults,
} from "../src/domain/relations";
import {
  defaultAccess,
  newAccessGroup,
  memberContext,
} from "../src/domain/access";
import {
  newForm,
  seedWorkspace,
  type FormRecord,
} from "../src/domain/workspace";
import { useFormDesigner } from "../src/features/forms/useFormDesigner";
import { editFormTabs } from "../src/domain/formTabs";
import { useWorkspaceStore } from "../src/stores/workspace";
import {
  LocalWorkspaceRepository,
  WORKSPACE_KEY,
} from "../src/repositories/workspaceRepository";
import RichTextDefaultInspector from "../src/features/forms/components/RichTextDefaultInspector.vue";
import FieldInspector from "../src/features/forms/components/FieldInspector.vue";

const apps: ReturnType<typeof createApp>[] = [];
const settle = async () => {
  for (let i = 0; i < 8; i++) await nextTick();
};
beforeEach(() => {
  localStorage.clear();
  setActivePinia(createPinia());
});
afterEach(() => {
  apps.splice(0).forEach((app) => app.unmount());
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});
function button(label: string) {
  return [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (el) =>
      el.getAttribute("aria-label") === label ||
      el.textContent?.trim() === label,
  )!;
}
function mount(component: Parameters<typeof createApp>[0]) {
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp(component);
  app.use(createPinia());
  app.mount(host);
  apps.push(app);
  return app;
}
async function defaultEditor(value = "<p>原默认值</p>") {
  const field = reactive(createField("richtext", { defaultValue: value }));
  const update = vi.fn((patch: Partial<FormField>) =>
    Object.assign(field, patch),
  );
  mount({
    render: () => h(RichTextDefaultInspector, { field, onUpdate: update }),
  });
  button("设置富文本默认值").click();
  await settle();
  return {
    field,
    update,
    input: document.querySelector<HTMLElement>('[aria-label="富文本默认值"]')!,
  };
}
function edit(input: HTMLElement, html: string) {
  input.innerHTML = html;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}
function seed(form: FormRecord) {
  const data = seedWorkspace();
  data.forms = [form];
  data.entries = [];
  data.recentFormIds = [];
  localStorage.setItem(WORKSPACE_KEY, JSON.stringify(data));
  return data;
}
function publish(form: FormRecord) {
  form.published = {
    version: 1,
    schema: copy(form.schema),
    workflow: copy(form.workflow),
    extensions: copy(form.extensions),
    title: form.title,
    publishedAt: form.createdAt,
  };
  form.versions = [copy(form.published)];
}
const richFields = (count: number) =>
  Array.from({ length: count }, () => createField("richtext"));

it("offers custom and linked rich defaults in the existing inspector without a formula mode", async () => {
  const form = newForm("oa", "默认值");
  const field = createField("richtext");
  form.schema.fields = [field];
  seed(form);
  mount({
    render: () =>
      h(FieldInspector, { field, schema: form.schema, formId: form.id }),
  });
  await settle();
  const mode = document.querySelector<HTMLSelectElement>(
    '[aria-label="默认值来源"]',
  )!;
  expect([...mode.options].map((option) => option.value)).toEqual([
    "custom",
    "linked",
  ]);
  expect(button("设置富文本默认值")).toBeDefined();
});
it("keeps default edits local until confirmation, reuses full tools and excludes image insertion", async () => {
  const f = await defaultEditor();
  expect(button("插入图片")).toBeUndefined();
  expect(button("有序列表")).toBeDefined();
  edit(
    f.input,
    "<h2>请按以下步骤处理</h2><ol><li><b>检查</b></li><li>登记</li></ol>",
  );
  await settle();
  expect(f.field.defaultValue).toBe("<p>原默认值</p>");
  button("确定").click();
  await settle();
  expect(f.update).toHaveBeenCalledTimes(1);
  const schema = emptySchema();
  schema.fields = [f.field];
  expect(
    runtimeDefaults(
      parseSchema(JSON.parse(JSON.stringify(schema))).fields,
      seedWorkspace(),
    )[f.field.id],
  ).toBe(f.field.defaultValue);
  expect(String(f.field.defaultValue)).toContain("<h2>");
});
it("requires explicit discard and does not overwrite another default change", async () => {
  const f = await defaultEditor();
  edit(f.input, "<p>未确认</p>");
  await settle();
  button("取消").click();
  await settle();
  expect(
    document.querySelector('[aria-label="放弃默认值修改？"]'),
  ).not.toBeNull();
  button("继续编辑").click();
  await settle();
  f.field.defaultValue = "<p>其他修改</p>";
  await settle();
  button("确定").click();
  await settle();
  expect(document.body.textContent).toContain("默认值设置已变化");
  expect(f.input.textContent).toBe("未确认");
  expect(f.update).not.toHaveBeenCalled();
  button("取消").click();
  await settle();
  button("放弃修改").click();
  await settle();
  expect(f.field.defaultValue).toBe("<p>其他修改</p>");
});
it("retains an oversized draft for correction instead of silently truncating it", async () => {
  const f = await defaultEditor();
  const large = "甲".repeat(30001);
  edit(f.input, large);
  await settle();
  button("确定").click();
  await settle();
  expect(document.body.textContent).toContain("上限 3 万字符");
  expect(f.input.textContent).toBe(large);
  expect(f.update).not.toHaveBeenCalled();
  edit(f.input, "<p>已缩短</p>");
  await settle();
  button("确定").click();
  await settle();
  expect(f.field.defaultValue).toBe("<p>已缩短</p>");
});
it("enforces stored HTML length while preserving and allowing reductions of legacy values", () => {
  expect(richTextValueIssue("甲".repeat(30000))).toBe("");
  expect(richTextValueIssue("<p>" + "甲".repeat(30000) + "</p>")).toContain(
    "3 万",
  );
  expect(richTextValueIssue("甲".repeat(30001), "旧".repeat(30002))).toBe("");
  const schema = emptySchema(),
    field = createField("richtext");
  schema.fields = [field];
  const previous = { [field.id]: "原".repeat(31000) };
  expect(validateValues(schema, previous, [], previous)).toEqual([]);
  expect(
    validateValues(schema, { [field.id]: "新".repeat(31001) }, [], previous),
  ).toHaveLength(1);
  expect(
    validateValues(schema, { [field.id]: "新".repeat(30001) }),
  ).toHaveLength(1);
  expect(
    validateValues(schema, { [field.id]: "<p><br></p>".repeat(3001) }),
  ).toHaveLength(1);
  field.defaultValue = previous[field.id];
  expect(richTextDefaultErrors(schema.fields, copy(schema.fields))).toEqual([]);
  expect(richTextDefaultErrors(schema.fields)).toHaveLength(1);
  expect(parseSchema(schema).fields[0]!.defaultValue).toBe(previous[field.id]);
});
it("uses stable row identities for legacy nested rich-value baselines", () => {
  const child = createField("richtext");
  const rows = createField("subform", { children: [child] });
  const schema = emptySchema();
  schema.fields = [rows];
  const previous = {
    [rows.id]: [
      { _rowId: "large", [child.id]: "原".repeat(31000) },
      { _rowId: "short", [child.id]: "短" },
    ],
  };
  const reordered = { [rows.id]: [...previous[rows.id]].reverse() };
  expect(validateValues(schema, reordered, [], previous)).toEqual([]);
  const changed = copy(reordered);
  changed[rows.id][0]![child.id] = "新".repeat(30001);
  expect(validateValues(schema, changed, [], previous)[0]!.path).toBe(
    `${rows.id}.0.${child.id}`,
  );
});
it("links only matching published rich fields and respects member field and condition access", () => {
  const data = seedWorkspace(),
    source = newForm("oa", "模板资料"),
    target = newForm("oa", "业务记录");
  const key = createField("text", { id: "key" }),
    value = createField("richtext", { id: "body" });
  source.schema.fields = [key, value];
  publish(source);
  const input = createField("text", { id: "input", defaultValue: "A" });
  const rich = createField("richtext", {
    id: "rich",
    defaultLink: {
      enabled: true,
      formId: source.id,
      fieldId: value.id,
      match: "all",
      filters: [
        {
          id: "match",
          sourceFieldId: key.id,
          operator: "equals",
          source: "field",
          value: input.id,
        },
      ],
    },
  });
  target.schema.fields = [input, rich];
  publish(target);
  data.forms = [source, target];
  data.entries = [
    {
      id: "source-entry",
      formId: source.id,
      definitionVersion: 1,
      values: {
        key: "A",
        body: '<h2>处理步骤</h2><p><b>先检查</b></p><img data-file-id="asset_example">',
      },
      status: "submitted",
      createdBy: "zhang",
      createdAt: "2026-10-01",
      history: [],
    },
  ];
  const expected = data.entries[0]!.values.body;
  expect(defaultLinkErrors(rich, target.schema.fields, data)).toEqual([]);
  expect(runtimeDefaults(target.schema.fields, data).rich).toBe(expected);
  expect(
    applyFieldChange(
      target.schema.fields,
      runtimeDefaults(target.schema.fields, data),
      "input",
      "B",
      data,
    ).rich,
  ).toBe("");
  expect(linkedDefault(rich, memberContext(data, "wang"), { input: "A" })).toBe(
    "",
  );
  const access = defaultAccess(),
    group = newAccessGroup(source.schema);
  access.membersEnabled = true;
  group.identities = ["wang"];
  access.groups = [group];
  data.formAccess = { [source.id]: access };
  expect(linkedDefault(rich, memberContext(data, "wang"), { input: "A" })).toBe(
    expected,
  );
  group.fields.body = "hidden";
  expect(linkedDefault(rich, memberContext(data, "wang"), { input: "A" })).toBe(
    "",
  );
  group.fields.body = "read";
  group.fields.key = "hidden";
  rich.defaultLink!.filters[0]!.operator = "notEquals";
  expect(linkedDefault(rich, memberContext(data, "wang"), { input: "B" })).toBe(
    "",
  );
  rich.defaultLink!.fieldId = key.id;
  expect(defaultLinkErrors(rich, target.schema.fields, data)).toContain(
    "请选择同类型的联动字段",
  );
});
it("rejects the eleventh rich field across click, drag, copy and restoration without mutating the draft", () => {
  const form = shallowRef(newForm("oa", "数量限制"));
  form.value.schema.fields = richFields(9);
  let editor!: ReturnType<typeof useFormDesigner>;
  const report = vi.fn();
  mount({
    setup: () => {
      editor = useFormDesigner(form, report);
      return () => h("div");
    },
  });
  expect(editor.add("richtext", null)).toBeTruthy();
  const before = copy(form.value);
  expect(editor.add("richtext", null)).toBeUndefined();
  editor.drop({ type: "richtext", index: 0 });
  editor.duplicate(form.value.schema.fields[0]!.id);
  expect(form.value).toEqual(before);
  form.value.fieldTrash = [
    { field: createField("richtext"), parentId: null, rules: [] },
  ];
  expect(editor.restore(0)).toBe(false);
  expect(form.value.fieldTrash).toHaveLength(1);
  expect(editor.add("text", null)).toBeTruthy();
  expect(report).toHaveBeenCalledWith("单个表单最多 10 个富文本字段");
});
it("checks whole-tab copying and preserves legacy over-limit definitions without allowing growth", () => {
  const schema = emptySchema(),
    tabs = createField("tabs");
  tabs.children = richFields(6).map((field) => ({
    ...field,
    tabId: tabs.tabs[0]!.id,
  }));
  schema.fields = [tabs];
  const before = copy(schema);
  expect(() =>
    editFormTabs(schema, tabs.id, { type: "copy", tabId: tabs.tabs[0]!.id }),
  ).toThrow("10 个富文本");
  expect(schema).toEqual(before);
  const legacy = richFields(11);
  expect(fieldCountLimitError(legacy, legacy)).toBe("");
  expect(
    fieldCountLimitError([...legacy, createField("richtext")], legacy),
  ).toContain("10 个富文本");
  schema.fields = legacy;
  expect(parseSchema(schema).fields).toHaveLength(11);
});
it("checks both count and default value on repository writes and retains rejected inputs", async () => {
  const form = newForm("oa", "保存限制");
  form.schema.fields = richFields(10);
  seed(form);
  const store = useWorkspaceStore(),
    draft = store.openForm(form.id)!;
  const original = copy(new LocalWorkspaceRepository().load()!);
  draft.schema.fields.push(createField("richtext"));
  expect(await store.saveForm(form.id)).toBe(false);
  expect(await store.publishForm(form.id)).toBe(false);
  expect(new LocalWorkspaceRepository().load()!).toEqual(original);
  expect(draft.schema.fields).toHaveLength(11);
  draft.schema.fields.pop();
  draft.schema.fields[0]!.defaultValue = "超".repeat(30001);
  expect(await store.saveForm(form.id)).toBe(false);
  expect(await store.publishForm(form.id)).toBe(false);
  expect(String(draft.schema.fields[0]!.defaultValue)).toHaveLength(30001);
  draft.schema.fields[0]!.defaultValue = "<h2>默认内容</h2>";
  expect(await store.saveForm(form.id)).toBe(true);
  expect(await store.publishForm(form.id)).toBe(true);
  const saved = new LocalWorkspaceRepository().load()!.forms[0]!;
  expect(saved.versions).toHaveLength(1);
  expect(saved.published!.schema.fields[0]!.defaultValue).toBe(
    "<h2>默认内容</h2>",
  );
});
