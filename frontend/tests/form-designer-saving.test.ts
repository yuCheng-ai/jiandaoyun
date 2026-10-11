// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApp, defineComponent, h, nextTick, reactive } from "vue";
import FormDesignerView from "../src/features/forms/FormDesignerView.vue";
import { newForm, seedWorkspace } from "../src/domain/workspace";
import { copy, createField, parseSchema, fieldTypePatch, isFieldVisible } from "../src/domain/form";
const mocks = vi.hoisted(() => ({
  workspace: undefined as any,
  push: vi.fn(),
}));
vi.mock("vue-router", () => ({
  useRoute: () => ({ params: { appId: "oa", formId: "form" } }),
  useRouter: () => ({ push: mocks.push, replace: vi.fn() }),
}));
vi.mock("../src/stores/workspace", () => ({
  useWorkspaceStore: () => mocks.workspace,
  syncFormWorkflow: vi.fn(),
}));
vi.mock("../src/components/shared/DesignerHeader.vue", () => ({
  default: defineComponent({ render: () => h("header") }),
}));
let app: ReturnType<typeof createApp> | undefined;
async function settle() {
  for (let i = 0; i < 12; i++) await nextTick();
}
const button = (name: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (el) => el.textContent?.trim() === name,
  )!;
beforeEach(() => {
  const draft = newForm("oa", "验收表单");
  draft.id = "form";
  const data = seedWorkspace();
  data.forms = [copy(draft)];
  mocks.workspace = reactive({
    data,
    drafts: { form: draft },
    openForm: vi.fn(() => draft),
    saveForm: vi.fn(),
    notify: vi.fn(),
  });
  mocks.push.mockReset();
  document.body.innerHTML = '<div id="mount"></div>';
});
afterEach(() => {
  app?.unmount();
  document.body.innerHTML = "";
});
async function mount() {
  app = createApp(FormDesignerView);
  app.mount("#mount");
  await settle();
}
it("a pending save visibly blocks repeat clicks and shortcuts until it finishes", async () => {
  let done!: (value: boolean) => void;
  mocks.workspace.saveForm.mockImplementation(
    () =>
      new Promise((resolve) => {
        done = resolve;
      }),
  );
  await mount();
  button("保存").click();
  await settle();
  expect(document.querySelector('[role="status"]')?.textContent).toContain(
    "正在保存",
  );
  expect(button("保存").disabled).toBe(true);
  expect(button("预览").disabled).toBe(true);
  expect(
    document.querySelector(".form-editor-body")?.hasAttribute("inert"),
  ).toBe(true);
  window.dispatchEvent(
    new KeyboardEvent("keydown", { key: "s", ctrlKey: true, cancelable: true }),
  );
  await settle();
  expect(mocks.workspace.saveForm).toHaveBeenCalledTimes(1);
  done(true);
  await settle();
  expect(button("保存").disabled).toBe(false);
  expect(mocks.workspace.notify).toHaveBeenCalledWith("表单已保存");
});
it("a failed save keeps the new field and its stable ID available for retry", async () => {
  mocks.workspace.saveForm
    .mockResolvedValueOnce(false)
    .mockResolvedValueOnce(true);
  await mount();
  document
    .querySelector<HTMLButtonElement>('[aria-label="添加单行文本"]')!
    .click();
  await settle();
  const id = mocks.workspace.drafts.form.schema.fields[0].id;
  button("保存").click();
  await settle();
  expect(mocks.workspace.notify).not.toHaveBeenCalledWith("表单已保存");
  expect(mocks.workspace.drafts.form.schema.fields[0].id).toBe(id);
  expect(button("保存").disabled).toBe(false);
  button("保存").click();
  await settle();
  expect(mocks.workspace.saveForm).toHaveBeenCalledTimes(2);
  expect(mocks.workspace.drafts.form.schema.fields[0].id).toBe(id);
});
it("the sharing control uses the form publishing route without changing workflow configuration", async () => {
  await mount();
  const workflow = copy(mocks.workspace.drafts.form.workflow);
  document
    .querySelector<HTMLButtonElement>('[aria-label="表单发布与访问链接"]')!
    .click();
  await settle();
  expect(mocks.push).toHaveBeenCalledWith("/apps/oa/forms/form/publish");
  expect(mocks.workspace.drafts.form.workflow).toEqual(workflow);
  expect(mocks.workspace.saveForm).not.toHaveBeenCalled();
});

it("choice type changes preserve options, defaults, references and publications and undo as one edit", async () => {
  const draft = mocks.workspace.drafts.form;
  const single = createField("radio", { id: "single", options: [{ id: "a", label: "甲" }, { id: "b", label: "乙" }], defaultValue: "b", coloredOptions: true, optionColors: { b: "#5865f5" }, choiceLayout: "horizontal" });
  const multi = createField("multiselect", { id: "multi", options: single.options, defaultValue: ["b", "a"], selectionLimit: { enabled: true, min: 1, max: 2 } });
  draft.schema.fields = [single, createField("subform", { id: "lines", children: [multi] })];
  draft.schema.settings.rules = [{ id: "visible", sourceId: "single", operator: "equals", value: "b", targetIds: ["lines"] }];
  const original = copy(draft.schema);
  draft.published = { version: 1, title: draft.title, schema: copy(original), workflow: copy(draft.workflow), publishedAt: "2026-10-09" };
  const workflow = copy(draft.workflow);
  await mount();
  document.querySelector<HTMLElement>('[data-field-id="single"]')!.click();
  await settle();
  const change = async (type: string) => {
    const select = document.querySelector<HTMLSelectElement>('[aria-label="字段类型"]')!;
    select.value = type;
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await settle();
  };
  await change("select");
  expect(draft.schema.fields[0]).toEqual({ ...original.fields[0], type: "select" });
  expect(document.querySelector('[data-field-id="single"] [role="combobox"]')).not.toBeNull();
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, cancelable: true }));
  await settle();
  expect(draft.schema).toEqual(original);
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "y", ctrlKey: true, cancelable: true }));
  await settle();
  expect(draft.schema.fields[0].type).toBe("select");
  await change("radio");
  expect(draft.schema).toEqual(original);
  document.querySelector<HTMLElement>('[data-field-id="multi"]')!.click();
  await settle();
  await change("checkbox");
  const switched = draft.schema.fields[1].children[0];
  expect(switched).toEqual({ ...original.fields[1].children[0], type: "checkbox", choiceLayout: "vertical" });
  await change("multiselect");
  expect(switched.defaultValue).toEqual(["b", "a"]);
  expect(parseSchema(draft.schema).fields[1]!.children[0]!.selectionLimit).toEqual(multi.selectionLimit);
  expect(draft.schema.settings.rules).toEqual(original.settings.rules);
  expect(parseSchema(draft.schema).settings.rules).toEqual(original.settings.rules);
  expect(draft.published.schema).toEqual(original);
  expect(draft.workflow).toEqual(workflow);
  expect(fieldTypePatch(single, "checkbox")).toBeUndefined();
  expect(fieldTypePatch(multi, "text")).toBeUndefined();
});

it("text switching uses the existing inspector and undo restores the complete field and condition meaning", async () => {
  const draft = mocks.workspace.drafts.form;
  draft.schema.fields = [createField("select", { id: "kind", options: [{ id: "a", label: "甲" }] }), createField("text", { id: "detail" })];
  draft.schema.settings.rules = [{ id: "show", sourceId: "kind", operator: "equals", value: "a", targetIds: ["detail"] }];
  const original = copy(draft.schema);
  const workflow = copy(draft.workflow);
  await mount();
  document.querySelector<HTMLElement>('[data-field-id="kind"]')!.click();
  await settle();
  const select = document.querySelector<HTMLSelectElement>('[aria-label="字段类型"]')!;
  expect([...select.options].map(option => option.value)).toContain("text");
  select.value = "text"; select.dispatchEvent(new Event("change", { bubbles: true }));
  await settle();
  expect(draft.schema.fields[0].type).toBe("text");
  expect(isFieldVisible(draft.schema.fields[1], draft.schema, { kind: "甲" })).toBe(true);
  const converted = parseSchema(draft.schema);
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, cancelable: true }));
  await settle();
  expect(draft.schema).toEqual(original);
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "y", ctrlKey: true, cancelable: true }));
  await settle();
  expect(parseSchema(draft.schema)).toEqual(converted);
  expect(draft.workflow).toEqual(workflow);
});

it("masked text switching asks in the shared dialog, cancel retains selection, and confirm is one undoable edit", async () => {
  const draft = mocks.workspace.drafts.form;
  draft.schema.fields = [createField("text", { id: "private", masked: true, defaultValue: "001" })];
  const original = copy(draft.schema);
  await mount();
  document.querySelector<HTMLElement>('[data-field-id="private"]')!.click();
  await settle();
  const change = async () => {
    const select = document.querySelector<HTMLSelectElement>('[aria-label="字段类型"]')!;
    select.value = "select"; select.dispatchEvent(new Event("change", { bubbles: true }));
    await settle();
    return select;
  };
  const select = await change();
  expect(select.value).toBe("text");
  expect(document.querySelector('dialog')?.textContent).toContain("不再脱敏");
  button("取消").click(); await settle();
  expect(draft.schema).toEqual(original);
  await change(); button("切换").click(); await settle();
  expect(draft.schema.fields[0]).toMatchObject({ id: "private", type: "select", masked: false });
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, cancelable: true }));
  await settle();
  expect(draft.schema).toEqual(original);
});


it("a shared child dialog owns shortcuts until its configuration is applied or cancelled", async () => {
  const draft = mocks.workspace.drafts.form;
  draft.schema.fields = [createField("radio", { id: "source" }), createField("text", { id: "target" })];
  await mount();
  document.querySelector<HTMLElement>('[data-field-id="source"]')!.click();
  await settle();
  button("设置").click();
  await settle();
  button("显隐规则").click();
  await settle();
  button("确定").focus();
  const before = copy(draft.schema);
  for (const key of ["s", "z", "y"]) window.dispatchEvent(new KeyboardEvent("keydown", { key, ctrlKey: true, cancelable: true }));
  await settle();
  expect(mocks.workspace.saveForm).not.toHaveBeenCalled();
  expect(draft.schema).toEqual(before);
  expect(document.querySelector('dialog[aria-label="显隐规则"]')).not.toBeNull();
});

it("legacy groups retain horizontal appearance after switching to a dropdown, parsing and switching back", async () => {
  const draft = mocks.workspace.drafts.form;
  const legacy = createField("checkbox", { id: "legacy", choiceLayout: undefined, options: [{ id: "zero", label: "旧选项" }], defaultValue: ["zero"] });
  draft.schema.fields = [legacy];
  await mount();
  document.querySelector<HTMLElement>('[data-field-id="legacy"]')!.click();
  await settle();
  const change = async (type: string) => {
    const select = document.querySelector<HTMLSelectElement>('[aria-label="字段类型"]')!;
    select.value = type;
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await settle();
  };
  await change("multiselect");
  draft.schema = parseSchema(JSON.parse(JSON.stringify(draft.schema)));
  await settle();
  await change("checkbox");
  expect(document.querySelector('.choice-group.vertical')).toBeNull();
  expect(draft.schema.fields[0]).toEqual({ ...legacy, type: "checkbox", choiceLayout: "horizontal" });
  expect(document.querySelector<HTMLInputElement>('[aria-label="复选框组 旧选项"]')?.checked).toBe(true);
});

it("dynamic-to-text switches its draft visibility conditions in the same undo step and rejects a missing referenced choice", async () => {
  const draft = mocks.workspace.drafts.form;
  const catalog = newForm("oa", "分类目录"); catalog.id = "catalog";
  catalog.schema.fields = [createField("text", { id: "name" })];
  const kind = createField("select", { id: "kind", label: "类别" });
  kind.choiceSource = { ...kind.choiceSource, mode: "form", formId: catalog.id, labelFieldId: "name" };
  draft.schema.fields = [kind, createField("text", { id: "detail" })];
  draft.schema.settings.rules = [{ id: "show", sourceId: "kind", operator: "equals", value: "a", targetIds: ["detail"] }];
  const original = copy(draft.schema);
  draft.published = { version: 1, schema: copy(original), title: draft.title, workflow: copy(draft.workflow), publishedAt: "2026-10-11" };
  mocks.workspace.data.forms.push(catalog);
  mocks.workspace.activeForms = mocks.workspace.data.forms;
  mocks.workspace.data.entries = [{ id: "a", formId: catalog.id, definitionVersion: 1, values: { name: "甲" }, status: "submitted", createdAt: "2026-10-11", history: [] }];
  await mount();
  document.querySelector<HTMLElement>('[data-field-id="kind"]')!.click(); await settle();
  const change = async () => {
    const select = document.querySelector<HTMLSelectElement>('[aria-label="字段类型"]')!;
    select.value = "text"; select.dispatchEvent(new Event("change", { bubbles: true })); await settle();
  };
  await change();
  expect(draft.schema.fields[0].type).toBe("text");
  expect(draft.schema.settings.rules[0]).toMatchObject({ value: "甲", valueType: "text" });
  expect(draft.published.schema).toEqual(original);
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, cancelable: true })); await settle();
  expect(draft.schema).toEqual(original);
  mocks.workspace.data.entries = [];
  await change();
  expect(draft.schema).toEqual(original);
  expect(mocks.workspace.notify).toHaveBeenLastCalledWith(expect.stringContaining("显隐条件选项已不可用"), "warning");
});

it("source deletion warns for converted choices in other forms and cancelling retains the source", async () => {
  const draft = mocks.workspace.drafts.form;
  draft.schema.fields = [createField("text", { id: "name", label: "分类名称" })];
  const consumer = newForm("oa", "申请单"), choice = createField("select", { label: "分类" });
  choice.choiceSource = { ...choice.choiceSource, mode: "form", formId: "form", labelFieldId: "name" };
  Object.assign(choice, fieldTypePatch(choice, "text"));
  consumer.schema.fields = [choice];
  mocks.workspace.activeForms = [draft, consumer];
  await mount();
  document.querySelector<HTMLElement>('[data-field-id="name"]')!.click(); await settle();
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", cancelable: true })); await settle();
  expect(document.querySelector("dialog")?.textContent).toContain("「申请单」的「分类」数据来源或填充规则");
  expect(draft.schema.fields).toHaveLength(1);
  button("保留字段").click(); await settle();
  expect(draft.schema.fields).toHaveLength(1);
  expect(document.querySelector("dialog[open]")).toBeNull();
});

it("an Other visibility condition prevents a silent semantic loss and an adjusted rule permits the same undoable conversion", async () => {
  const draft = mocks.workspace.drafts.form;
  draft.schema.fields = [createField("select", { id: "kind", label: "类别", options: [{ id: "a", label: "甲" }, { id: "other", label: "其他", other: true }] }), createField("text", { id: "detail" })];
  draft.schema.settings.rules = [{ id: "show", sourceId: "kind", operator: "equals", value: "other", targetIds: ["detail"] }];
  const original = copy(draft.schema);
  await mount();
  document.querySelector<HTMLElement>('[data-field-id="kind"]')!.click(); await settle();
  const change = async () => {
    const select = document.querySelector<HTMLSelectElement>('[aria-label="字段类型"]')!;
    select.value = "text"; select.dispatchEvent(new Event("change", { bubbles: true })); await settle();
  };
  await change();
  expect(draft.schema).toEqual(original);
  expect(mocks.workspace.notify).toHaveBeenLastCalledWith(expect.stringContaining('显隐规则使用了“其他”选项'), "warning");
  draft.schema.settings.rules[0].value = "a";
  await settle();
  const adjusted = copy(draft.schema);
  await change();
  expect(draft.schema.fields[0].type).toBe("text");
  expect(isFieldVisible(draft.schema.fields[1], draft.schema, { kind: "甲" })).toBe(true);
  expect(isFieldVisible(draft.schema.fields[1], draft.schema, { kind: "其他" })).toBe(false);
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, cancelable: true })); await settle();
  expect(draft.schema).toEqual(adjusted);
});
