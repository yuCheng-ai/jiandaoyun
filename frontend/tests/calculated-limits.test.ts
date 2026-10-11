// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApp, h, nextTick, shallowRef, type Ref } from "vue";
import { createMemoryHistory, createRouter, RouterView } from "vue-router";
import { createPinia, setActivePinia } from "pinia";
import {
  copy,
  createField,
  flattenFields,
  parseSchema,
} from "../src/domain/form";
import {
  newForm,
  seedWorkspace,
  type FormRecord,
} from "../src/domain/workspace";
import { editFormTabs } from "../src/domain/formTabs";
import { useFormDesigner } from "../src/features/forms/useFormDesigner";
import FormDesignerView from "../src/features/forms/FormDesignerView.vue";
import { useWorkspaceStore } from "../src/stores/workspace";
import {
  LocalWorkspaceRepository,
  WORKSPACE_KEY,
} from "../src/repositories/workspaceRepository";

const unmounts: (() => void)[] = [];
beforeEach(() => {
  localStorage.clear();
  setActivePinia(createPinia());
});
afterEach(() => {
  unmounts.splice(0).forEach((fn) => fn());
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});
const calculations = (count: number) =>
  Array.from({ length: count }, () =>
    createField("calculated", { expression: "2" }),
  );
const count = (form: FormRecord) =>
  flattenFields(form.schema.fields).filter((f) => f.type === "calculated")
    .length;
function editorFor(form: Ref<FormRecord>, forms?: () => FormRecord[]) {
  const report = vi.fn();
  let editor!: ReturnType<typeof useFormDesigner>;
  const app = createApp({
    setup() {
      editor = useFormDesigner(form, report, forms);
      return () => h("div");
    },
  });
  const host = document.createElement("div");
  document.body.append(host);
  app.mount(host);
  unmounts.push(() => app.unmount());
  return { editor, report };
}
function seed(count: number, extra: FormRecord[] = []) {
  const data = seedWorkspace();
  data.forms = [
    ...Array.from({ length: count }, (_, i) => {
      const form = newForm("oa", `含计算 ${i}`);
      form.schema.fields = calculations(1);
      return form;
    }),
    ...extra,
  ];
  data.entries = [];
  data.recentFormIds = [];
  localStorage.setItem(WORKSPACE_KEY, JSON.stringify(data));
  return data;
}

it("allows the 100th calculation and rejects click/drag additions without changing the draft or other field operations", () => {
  const form = shallowRef(newForm("oa", "字段上限"));
  form.value.schema.fields = calculations(99);
  const inspect = vi.fn(() => []);
  const { editor, report } = editorFor(form, inspect);
  expect(
    editor.add("calculated", null, undefined, undefined, { expression: "2" }),
  ).toBeTruthy();
  const before = copy(form.value);
  expect(editor.add("calculated", null)).toBeUndefined();
  editor.drop({ type: "calculated", index: 0 });
  expect(form.value).toEqual(before);
  expect(report).toHaveBeenCalledWith("单个表单最多 100 个计算字段");
  inspect.mockClear();
  expect(editor.add("text", null)).toBeTruthy();
  expect(inspect).not.toHaveBeenCalled();
  expect(count(form.value)).toBe(100);
  editor.undo();
  editor.undo();
  expect(count(form.value)).toBe(99);
});

it("checks whole-field copies and restoration before mutating children, IDs or recycle metadata", () => {
  const form = shallowRef(newForm("oa", "复制恢复"));
  const archived = calculations(1)[0]!;
  const legacyRows = createField("subform", { children: calculations(2) });
  form.value.schema.fields = [...calculations(98), legacyRows];
  form.value.fieldTrash = [{ field: archived, parentId: null, rules: [] }];
  const { editor, report } = editorFor(form);
  const before = copy(form.value);
  editor.duplicate(legacyRows.id);
  expect(editor.restore(0)).toBe(false);
  expect(form.value).toEqual(before);
  editor.remove([form.value.schema.fields[0]!.id]);
  expect(
    editor.restore(
      form.value.fieldTrash!.findIndex((item) => item.field.id === archived.id),
    ),
  ).toBe(true);
  expect(count(form.value)).toBe(100);
  expect(form.value.schema.fields.at(-1)?.id).toBe(archived.id);
  expect(report).toHaveBeenCalledWith("单个表单最多 100 个计算字段");
});

it("copies tab calculations to exactly 100 and rejects the next whole tab atomically", () => {
  const form = newForm("oa", "标签复制");
  const tabs = createField("tabs");
  tabs.children = calculations(50).map((field) => ({
    ...field,
    tabId: tabs.tabs[0]!.id,
  }));
  form.schema.fields = [tabs];
  const result = editFormTabs(form.schema, tabs.id, {
    type: "copy",
    tabId: tabs.tabs[0]!.id,
  });
  expect(
    flattenFields(result.schema.fields).filter((f) => f.type === "calculated"),
  ).toHaveLength(100);
  const before = copy(result.schema);
  expect(() =>
    editFormTabs(result.schema, tabs.id, { type: "copy", tabId: result.tabId }),
  ).toThrow("100 个计算字段");
  expect(result.schema).toEqual(before);
  expect(tabs.children).toHaveLength(50);
});

it("uses current application capacity for new calculations while other applications and existing calculated forms keep working", () => {
  const others = Array.from({ length: 100 }, () => {
    const other = newForm("oa", "已有计算");
    other.schema.fields = calculations(1);
    return other;
  });
  const form = shallowRef(newForm("oa", "新表单"));
  const { editor, report } = editorFor(form, () => others);
  expect(editor.add("calculated", null)).toBeUndefined();
  expect(form.value.schema.fields).toHaveLength(0);
  expect(editor.add("text", null)).toBeTruthy();
  expect(report).toHaveBeenCalledWith("单个应用最多 100 个含计算字段的表单");
  others[0]!.archived = true;
  expect(editor.add("calculated", null)).toBeUndefined();
  others[0]!.schema.fields = [];
  expect(editor.add("calculated", null)).toBeTruthy();
  const separate = shallowRef(newForm("other", "独立应用"));
  expect(
    editorFor(separate, () => others).editor.add("calculated", null),
  ).toBeTruthy();
  const existing = shallowRef(others[1]!);
  expect(
    editorFor(existing, () => others).editor.add("calculated", null),
  ).toBeTruthy();
});

it("rechecks the last application slot under the shared write lock across independent editors", async () => {
  const a = newForm("oa", "并行 A"),
    b = newForm("oa", "并行 B");
  seed(99, [a, b]);
  const first = useWorkspaceStore(createPinia()),
    second = useWorkspaceStore(createPinia());
  const draftA = first.openForm(a.id)!,
    draftB = second.openForm(b.id)!;
  draftA.schema.fields = calculations(1);
  draftB.schema.fields = calculations(1);
  const results = await Promise.all([
    first.saveForm(a.id),
    second.saveForm(b.id),
  ]);
  expect(results.filter(Boolean)).toHaveLength(1);
  const cold = new LocalWorkspaceRepository().load()!;
  expect(cold.forms.filter((form) => count(form) > 0)).toHaveLength(100);
  expect(count(draftA)).toBe(1);
  expect(count(draftB)).toBe(1);
  const denied = results[0] ? second : first;
  const deniedId = results[0] ? b.id : a.id;
  expect(
    denied.notices.some((notice) =>
      notice.message.includes("100 个含计算字段"),
    ),
  ).toBe(true);
  const availableId = cold.forms.find(
    (form) => ![a.id, b.id].includes(form.id),
  )!.id;
  const cleanup = denied.openForm(availableId)!;
  cleanup.schema.fields = [];
  expect(await denied.saveForm(availableId)).toBe(true);
  expect(await denied.saveForm(deniedId)).toBe(true);
  expect(
    new LocalWorkspaceRepository()
      .load()!
      .forms.filter((form) => count(form) > 0),
  ).toHaveLength(100);
});

it("rejects a copied calculated form at application capacity while normal copying remains available", async () => {
  const normal = newForm("oa", "普通表单");
  const data = seed(100, [normal]);
  const store = useWorkspaceStore(createPinia());
  const before = new LocalWorkspaceRepository().load()!;
  expect(await store.duplicateForm(data.forms[0]!.id)).toBeUndefined();
  expect(new LocalWorkspaceRepository().load()!.forms).toEqual(before.forms);
  const duplicate = (await store.duplicateForm(normal.id))!;
  expect(duplicate.id).not.toBe(normal.id);
  expect(count(duplicate)).toBe(0);
  const target = store.openForm(data.forms[0]!.id)!;
  target.schema.fields = [];
  expect(await store.saveForm(target.id)).toBe(true);
  expect(await store.duplicateForm(data.forms[1]!.id)).toBeTruthy();
  expect(
    new LocalWorkspaceRepository()
      .load()!
      .forms.filter((form) => count(form) > 0),
  ).toHaveLength(100);
});

it("rejects bypassed per-form overflow before saving or publishing and preserves draft values for correction", async () => {
  const target = newForm("oa", "最终保存上限");
  target.schema.fields = calculations(100);
  seed(0, [target]);
  const store = useWorkspaceStore(createPinia());
  const draft = store.openForm(target.id)!;
  draft.schema.fields.push(...calculations(1));
  const before = copy(new LocalWorkspaceRepository().load()!);
  expect(await store.saveForm(target.id)).toBe(false);
  expect(await store.publishForm(target.id)).toBe(false);
  expect(new LocalWorkspaceRepository().load()!).toEqual(before);
  expect(draft.published).toBeUndefined();
  expect(count(draft)).toBe(101);
  draft.schema.fields.pop();
  expect(await store.saveForm(target.id)).toBe(true);
  expect(await store.publishForm(target.id)).toBe(true);
  expect(
    store.data.forms.find((f) => f.id === target.id)!.versions,
  ).toHaveLength(1);
});

it("keeps historical over-limit definitions readable and permits unrelated edits or reductions without granting further growth", async () => {
  const target = newForm("oa", "历史超限");
  target.schema.fields = calculations(101);
  target.published = {
    version: 1,
    title: target.title,
    schema: copy(target.schema),
    workflow: copy(target.workflow),
    publishedAt: target.createdAt,
  };
  target.versions = [copy(target.published)];
  seed(0, [target]);
  expect(() => parseSchema(target.schema)).not.toThrow();
  const oldVersion = copy(
    new LocalWorkspaceRepository()
      .load()!
      .forms.find((f) => f.id === target.id)!.versions[0],
  );
  const store = useWorkspaceStore(createPinia());
  const draft = store.openForm(target.id)!;
  const editor = editorFor(shallowRef(draft)).editor;
  expect(editor.add("calculated", null)).toBeUndefined();
  expect(editor.add("text", null)).toBeTruthy();
  draft.title = "历史表单改名";
  expect(await store.saveForm(target.id)).toBe(true);
  draft.schema.fields.push(...calculations(1));
  expect(await store.saveForm(target.id)).toBe(false);
  draft.schema.fields.pop();
  draft.schema.fields.splice(0, 2);
  expect(await store.saveForm(target.id)).toBe(true);
  const saved = new LocalWorkspaceRepository()
    .load()!
    .forms.find((f) => f.id === target.id)!;
  expect(count(saved)).toBe(99);
  expect(copy(saved.versions[0])).toEqual(oldVersion);
});

it("keeps a legacy application over capacity editable, counts archived forms and releases slots only after saved field removal", async () => {
  const target = newForm("oa", "待添加计算");
  const data = seed(101, [target]);
  const store = useWorkspaceStore(createPinia());
  const existing = store.openForm(data.forms[0]!.id)!;
  existing.title = "改名保留历史";
  expect(await store.saveForm(existing.id)).toBe(true);
  expect(await store.archiveForm(data.forms[1]!.id)).toBe(true);
  const draft = store.openForm(target.id)!;
  draft.schema.fields = calculations(1);
  expect(await store.saveForm(target.id)).toBe(false);
  existing.schema.fields = [];
  expect(await store.saveForm(existing.id)).toBe(true);
  expect(await store.saveForm(target.id)).toBe(false);
  const another = store.openForm(data.forms[2]!.id)!;
  another.schema.fields = [];
  expect(await store.saveForm(another.id)).toBe(true);
  expect(await store.saveForm(target.id)).toBe(true);
  const cold = new LocalWorkspaceRepository().load()!;
  expect(cold.forms.filter((form) => count(form) > 0)).toHaveLength(100);
  expect(
    cold.forms.find((form) => form.id === data.forms[1]!.id)!.archived,
  ).toBe(true);
});

it("uses fresh capacity in the actual designer without rebasing unfinished edits when another editor releases or takes a slot", async () => {
  const target = newForm("oa", "跨页容量");
  const data = seed(100, [target]);
  const pinia = createPinia();
  const store = useWorkspaceStore(pinia);
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      {
        path: "/apps/:appId/forms/:formId/design",
        component: FormDesignerView,
      },
    ],
  });
  await router.push(`/apps/oa/forms/${target.id}/design`);
  await router.isReady();
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp({ render: () => h(RouterView) });
  app.use(pinia).use(router).mount(host);
  unmounts.push(() => app.unmount());
  await nextTick();
  const click = async (label: string) => {
    const button = host.querySelector<HTMLButtonElement>(
      `button[aria-label="${label}"]`,
    )!;
    expect(button).not.toBeNull();
    button.click();
    await nextTick();
  };
  await click("添加单行文本");
  const draft = store.drafts[target.id]!;
  draft.title = "保留本页未保存名称";
  const textId = draft.schema.fields[0]!.id;
  const other = useWorkspaceStore(createPinia());
  const removed = other.openForm(data.forms[0]!.id)!;
  removed.schema.fields = [];
  expect(await other.saveForm(removed.id)).toBe(true);
  expect(count(store.data.forms.find((f) => f.id === removed.id)!)).toBe(1);
  await click("添加计算");
  expect(count(draft)).toBe(1);
  expect(draft.schema.fields[0]!.id).toBe(textId);
  expect(draft.title).toBe("保留本页未保存名称");
  expect(count(store.data.forms.find((f) => f.id === removed.id)!)).toBe(1);
  const taken = (await other.createForm("oa", "其他页占用最后名额", "form"))!;
  other.openForm(taken.id)!.schema.fields = calculations(1);
  expect(await other.saveForm(taken.id)).toBe(true);
  expect(await store.saveForm(target.id)).toBe(false);
  expect(draft.schema.fields[0]!.id).toBe(textId);
  expect(draft.title).toBe("保留本页未保存名称");
  expect(
    count(
      new LocalWorkspaceRepository()
        .load()!
        .forms.find((f) => f.id === target.id)!,
    ),
  ).toBe(0);
});
