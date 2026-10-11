// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApp, h, nextTick, reactive, toRef } from "vue";
import { createPinia } from "pinia";
import { createMemoryHistory, createRouter, RouterView } from "vue-router";
import MemberPortalView from "../src/features/forms/MemberPortalView.vue";
import { useWorkspaceStore } from "../src/stores/workspace";
import { useEditorDraftStore } from "../src/stores/editorDrafts";
import { accessActions } from "../src/stores/accessActions";
import { defaultAccess, newAccessGroup } from "../src/domain/access";
import { copy, createField } from "../src/domain/form";
import {
  newForm,
  seedWorkspace,
  type FormRecord,
} from "../src/domain/workspace";

vi.mock("../src/stores/workspace", () => ({ useWorkspaceStore: vi.fn() }));
vi.mock("../src/components/WorkspaceStorageNotice.vue", () => ({
  default: { render: () => null },
}));
let form: FormRecord, store: ReturnType<typeof makeStore>;
const cleanups: (() => void)[] = [];
function makeStore() {
  const source = {
    data: seedWorkspace(),
    writePending: false,
    refreshForRead: vi.fn(() => true),
    notify: vi.fn(),
    memberSubmit: vi.fn(),
    memberUpdate: vi.fn(),
  };
  return reactive(source) as unknown as typeof source;
}
beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div>';
  localStorage.clear();
  sessionStorage.clear();
  store = makeStore();
  vi.mocked(useWorkspaceStore).mockReturnValue(store as any);
  form = newForm("oa", "成员恢复验收");
  form.id = "member-recovery";
  form.schema.settings.cacheDraft = true;
  form.schema.fields = [
    createField("text", { id: "name", label: "业务名称" }),
    createField("text", { id: "locked", label: "只读结论" }),
    createField("text", { id: "hidden", label: "内部备注" }),
  ];
  form.published = {
    version: 1,
    title: form.title,
    schema: copy(form.schema),
    workflow: copy(form.workflow),
    publishedAt: "2026-10-01",
  };
  form.versions = [copy(form.published)];
  store.data.forms = [form];
  store.data.entries = [
    {
      id: "record",
      formId: form.id,
      definitionVersion: 1,
      createdAt: "2026-10-01",
      createdBy: "zhang",
      status: "submitted",
      values: { name: "原业务", locked: "当前结论", hidden: "内部内容" },
      history: [],
    },
  ];
  const group = newAccessGroup(form.schema);
  group.id = "restricted";
  group.identities = ["zhang", "li"];
  group.actions = ["view", "create", "edit", "print"];
  group.scope = "all";
  group.fields = { name: "edit", locked: "read", hidden: "hidden" };
  store.data.formAccess = {
    [form.id]: { ...defaultAccess(), membersEnabled: true, groups: [group] },
  };
  const actions = accessActions(
    toRef(store, "data"),
    () => true,
    store.notify,
    (id, values, status, draftId, actor) => {
      const entry = {
        ...copy(store.data.entries[0]!),
        id: "created",
        formId: id,
        values: copy(values),
        createdBy: actor,
        status: status!,
      };
      store.data.entries.push(entry);
      return entry;
    },
    (id, values) => {
      store.data.entries.find((e) => e.id === id)!.values = values;
      return true;
    },
    () => false,
  );
  store.memberSubmit.mockImplementation(async (...args) =>
    actions.memberSubmit(...(args as Parameters<typeof actions.memberSubmit>)),
  );
  store.memberUpdate.mockImplementation(async (...args) =>
    actions.memberUpdate(...(args as Parameters<typeof actions.memberUpdate>)),
  );
});
afterEach(() => {
  cleanups.splice(0).forEach((fn) => fn());
  vi.restoreAllMocks();
});
const button = (name: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (el) => el.textContent?.trim() === name,
  )!;
const input = (id = "name") =>
  document.querySelector<HTMLInputElement>(`[data-field-id="${id}"] input`)!;
async function click(name: string) {
  expect(button(name), name).toBeDefined();
  button(name).click();
  await nextTick();
  await new Promise((resolve) => setTimeout(resolve, 0));
}
async function fill(value: string) {
  input().value = value;
  input().dispatchEvent(new Event("input", { bubbles: true }));
  await nextTick();
}
async function mount() {
  const pinia = createPinia(),
    router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: "/forms/:formId", component: MemberPortalView }],
    });
  await router.push(`/forms/${form.id}`);
  const app = createApp({ render: () => h(RouterView) });
  app.use(pinia).use(router).mount(document.getElementById("app")!);
  let mounted = true;
  const unmount = () => {
    if (mounted) {
      app.unmount();
      mounted = false;
    }
  };
  cleanups.push(unmount);
  await nextTick();
  return { drafts: useEditorDraftStore(pinia), unmount };
}
async function restore() {
  await click("恢复内容");
  await click("确认恢复");
}

it("recovers restricted edits after remount, keeps readonly/hidden values and clears only after successful save", async () => {
  const first = await mount();
  await click("编辑");
  await fill("恢复后的业务");
  first.unmount();
  const next = await mount();
  await click("编辑");
  expect(input().value).toBe("原业务");
  await restore();
  expect(input().value).toBe("恢复后的业务");
  expect(input("locked").disabled || input("locked").readOnly).toBe(true);
  expect(input("hidden")).toBeNull();
  store.memberUpdate.mockResolvedValueOnce(false);
  await click("保存修改");
  expect(input().value).toBe("恢复后的业务");
  expect(document.body.textContent).toContain("保存失败");
  expect(next.drafts.entries.length).toBeGreaterThan(0);
  await click("保存修改");
  expect(store.data.entries[0]!.values).toEqual({
    name: "恢复后的业务",
    locked: "当前结论",
    hidden: "内部内容",
  });
  expect(next.drafts.entries).toHaveLength(0);
  expect(document.querySelector("dialog[open]")).toBeNull();
});
it("recovers merged groups with distinct existing, inserted and appended column grants and saves the same record", async () => {
  const lines = createField("subform", {
    id: "lines",
    label: "明细",
    children: [
      createField("text", { id: "item", label: "商品" }),
      createField("number", { id: "qty", label: "数量", defaultValue: 7 }),
    ],
  });
  form.schema.fields.push(lines);
  form.published!.schema = copy(form.schema);
  form.versions = [copy(form.published!)];
  const config = store.data.formAccess![form.id]!,
    insertion = config.groups[0]!;
  insertion.fields = {
    ...insertion.fields,
    lines: "edit",
    item: "edit",
    qty: "read",
  };
  insertion.subformPermissions = {
    lines: {
      add: false,
      insert: true,
      editExisting: false,
      deleteExisting: false,
    },
  };
  const other = copy(insertion);
  other.id = "quantities";
  other.fields.item = "read";
  other.fields.qty = "edit";
  other.subformPermissions!.lines = {
    add: true,
    insert: false,
    editExisting: true,
    deleteExisting: false,
  };
  config.groups.push(other);
  store.data.entries[0]!.values.lines = [
    { _rowId: "original-one", item: "原一", qty: 11 },
    { _rowId: "original-two", item: "原二", qty: 22 },
  ];
  const cell = (row: number, label: string) =>
    document.querySelector<HTMLInputElement>(
      `[aria-label="明细 第${row}行 ${label}"]`,
    )!;
  const enterCell = async (row: number, label: string, value: string) => {
    cell(row, label).value = value;
    cell(row, label).dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();
  };
  const first = await mount();
  await click("编辑");
  expect(cell(1, "商品").disabled).toBe(true);
  await enterCell(1, "数量", "44");
  document
    .querySelector<HTMLButtonElement>('[aria-label="明细第1行操作"]')!
    .click();
  await nextTick();
  await click("上方插入");
  await enterCell(1, "商品", "插入商品");
  expect(cell(1, "数量").disabled).toBe(true);
  document.querySelector<HTMLButtonElement>(".subform-add")!.click();
  await nextTick();
  expect(cell(4, "商品").disabled).toBe(false);
  await enterCell(4, "商品", "末尾商品");
  await enterCell(4, "数量", "0");
  first.unmount();
  const next = await mount();
  await click("编辑");
  await restore();
  expect(cell(1, "商品").value).toBe("插入商品");
  expect(cell(1, "数量").value).toBe("7");
  expect(cell(1, "数量").disabled).toBe(true);
  expect(cell(2, "商品").value).toBe("原一");
  expect(cell(2, "商品").disabled).toBe(true);
  expect(cell(2, "数量").value).toBe("44");
  expect(cell(4, "商品").value).toBe("末尾商品");
  expect(cell(4, "数量").value).toBe("0");
  await click("保存修改");
  expect(store.data.entries).toHaveLength(1);
  expect(store.data.entries[0]!.id).toBe("record");
  expect(store.data.entries[0]!.values.lines).toEqual([
    expect.objectContaining({ item: "插入商品", qty: 7 }),
    { _rowId: "original-one", item: "原一", qty: 44 },
    { _rowId: "original-two", item: "原二", qty: 22 },
    expect.objectContaining({ item: "末尾商品", qty: 0 }),
  ]);
  expect(next.drafts.entries).toHaveLength(0);
});
function quickFillGroups() {
  const lines = createField("subform", {
    id: "lines",
    label: "明细",
    subformQuickFill: true,
    children: [
      createField("text", { id: "item", label: "商品" }),
      createField("number", { id: "qty", label: "数量", defaultValue: 7 }),
      createField("text", { id: "note", label: "说明" }),
    ],
  });
  form.schema.fields.push(lines);
  form.published!.schema = copy(form.schema);
  form.versions = [copy(form.published!)];
  const config = store.data.formAccess![form.id]!,
    insertion = config.groups[0]!;
  insertion.fields = {
    ...insertion.fields,
    lines: "edit",
    item: "edit",
    qty: "read",
    note: "edit",
  };
  insertion.subformPermissions = {
    lines: {
      add: false,
      insert: true,
      editExisting: false,
      deleteExisting: false,
    },
  };
  const quantities = copy(insertion);
  quantities.id = "quantities";
  quantities.fields.item = "read";
  quantities.fields.qty = "edit";
  quantities.subformPermissions!.lines = {
    add: true,
    insert: false,
    editExisting: true,
    deleteExisting: false,
  };
  config.groups.push(quantities);
  store.data.entries[0]!.values.lines = [
    { _rowId: "original-one", item: "88", qty: 22, note: "原说明" },
  ];
  return { quantities: config.groups[1]! };
}
async function fillQuickCell(label: string, value: string) {
  const cell = document.querySelector<HTMLTextAreaElement>(
    `.subform-fill-grid [aria-label="${label}"]`,
  )!;
  cell.value = value;
  cell.dispatchEvent(new Event("input", { bubbles: true }));
  await nextTick();
}
it("saves mixed member row grants through quick fill without remapping readonly source values", async () => {
  quickFillGroups();
  await mount();
  await click("编辑");
  document
    .querySelector<HTMLButtonElement>('[aria-label="明细第1行操作"]')!
    .click();
  await nextTick();
  await click("上方插入");
  const inserted = document.querySelector<HTMLInputElement>(
    '[aria-label="明细 第1行 商品"]',
  )!;
  inserted.value = "31";
  inserted.dispatchEvent(new Event("input", { bubbles: true }));
  await nextTick();
  await click("快速填报");
  const edit = [
    ...document.querySelectorAll<HTMLInputElement>('input[type="radio"]'),
  ].find((e) => e.parentElement?.textContent?.trim() === "编辑已有记录")!;
  edit.checked = true;
  edit.dispatchEvent(new Event("change", { bubbles: true }));
  await nextTick();
  expect(
    document.querySelector<HTMLTextAreaElement>('[aria-label="第1行 数量"]')!
      .readOnly,
  ).toBe(true);
  expect(
    document.querySelector<HTMLTextAreaElement>('[aria-label="第2行 商品"]')!
      .readOnly,
  ).toBe(true);
  await fillQuickCell("第1行 说明", "新插说明");
  await fillQuickCell("第2行 说明", "更新说明");
  await click("下一步");
  for (const [label, choice] of [
    ["第2列对应字段", "不粘贴"],
    ["第1列对应字段", "数量"],
  ]) {
    document.querySelector<HTMLElement>(`[aria-label="${label}"]`)!.click();
    await nextTick();
    await click(choice!);
  }
  expect(document.body.textContent).toContain("粘贴 1 列 / 共 3 列");
  await click("确定");
  await click("保存修改");
  expect(store.data.entries).toHaveLength(1);
  expect(store.data.entries[0]!.id).toBe("record");
  expect(store.data.entries[0]!.values.lines).toEqual([
    expect.objectContaining({ item: "31", qty: 7, note: "新插说明" }),
    { _rowId: "original-one", item: "88", qty: 22, note: "更新说明" },
  ]);
  expect(store.data.entries[0]!.values.hidden).toBe("内部内容");
  expect(store.memberUpdate).toHaveBeenCalledOnce();
});
it("retains staged member quick-fill input and performs no write after a column grant is revoked", async () => {
  const { quantities } = quickFillGroups();
  const before = copy(store.data.entries[0]!.values);
  await mount();
  await click("编辑");
  await fill("保留主字段");
  await click("快速填报");
  await fillQuickCell("第1行 商品", "保留商品");
  await fillQuickCell("第1行 数量", "44");
  await click("下一步");
  quantities.fields.qty = "read";
  await nextTick();
  await click("确定");
  expect(document.body.textContent).toContain("明细权限或字段已变化");
  expect(input().value).toBe("保留主字段");
  expect(
    document.querySelector<HTMLTextAreaElement>('[aria-label="第1行 商品"]')!
      .value,
  ).toBe("保留商品");
  expect(
    document.querySelector<HTMLTextAreaElement>('[aria-label="第1行 数量"]')!
      .value,
  ).toBe("44");
  expect(store.data.entries[0]!.values).toEqual(before);
  expect(store.memberUpdate).not.toHaveBeenCalled();
});
it("keeps the entire member edit unsaved when a column grant changes after quick fill is applied", async () => {
  const { quantities } = quickFillGroups();
  const before = copy(store.data.entries[0]!.values);
  await mount();
  await click("编辑");
  await fill("主字段也不能部分保存");
  await click("快速填报");
  await fillQuickCell("第1行 商品", "待保存商品");
  await fillQuickCell("第1行 数量", "55");
  await fillQuickCell("第1行 说明", "待保存说明");
  await click("下一步");
  await click("确定");
  quantities.fields.qty = "read";
  await nextTick();
  await click("保存修改");
  expect(store.data.entries[0]!.values).toEqual(before);
  expect(store.notify).toHaveBeenCalledWith(
    "这条记录的编辑权限已变化，当前输入已保留，请重新打开后核对。",
    "warning",
  );
  expect(input().value).toBe("主字段也不能部分保存");
  expect(
    document.querySelector<HTMLInputElement>('[aria-label="明细 第2行 商品"]')!
      .value,
  ).toBe("待保存商品");
  expect(
    document.querySelector<HTMLInputElement>('[aria-label="明细 第2行 数量"]')!
      .value,
  ).toBe("55");
  expect(document.querySelector("dialog[open]")).not.toBeNull();
});
it("recovers member creation separately and creates exactly one record on submit", async () => {
  const first = await mount();
  await click("新增数据");
  await fill("新增恢复");
  first.unmount();
  const next = await mount();
  await click("新增数据");
  expect(input().value).toBe("");
  await restore();
  expect(input().value).toBe("新增恢复");
  expect(next.drafts.entries[0]!.key).toContain("member-create");
  await click("提交");
  expect(store.data.entries.filter((e) => e.id === "created")).toHaveLength(1);
  expect(next.drafts.entries).toHaveLength(0);
});
it("refuses direct recovery when record content or effective field permissions changed", async () => {
  const first = await mount();
  await click("编辑");
  await fill("旧输入");
  first.unmount();
  store.data.entries[0]!.values.locked = "更新结论";
  const next = await mount();
  await click("编辑");
  expect(button("恢复内容").disabled).toBe(true);
  expect(document.body.textContent).toContain("原数据或当前成员已变化");
  next.unmount();
  store.data.entries[0]!.values.locked = "当前结论";
  store.data.formAccess![form.id]!.groups[0]!.fields.name = "read";
  await mount();
  await click("编辑");
  expect(button("恢复内容").disabled).toBe(true);
  expect(input().value).toBe("原业务");
});
it("does not offer another member's edits or a creation draft in the edit dialog", async () => {
  const first = await mount();
  await click("新增数据");
  await fill("张三的新增");
  first.unmount();
  const second = await mount();
  await click("编辑");
  expect(button("恢复内容")).toBeUndefined();
  second.unmount();
  store.data.organization.currentUserId = "li";
  await mount();
  await click("新增数据");
  expect(button("恢复内容")).toBeUndefined();
  expect(input().value).toBe("");
});
it("respects disabled automatic retention and explicit discard", async () => {
  form.published!.schema.settings.cacheDraft = false;
  form.versions[0]!.schema.settings.cacheDraft = false;
  store.data.forms = [form];
  const first = await mount();
  await click("编辑");
  await fill("不暂存");
  first.unmount();
  expect(sessionStorage.length).toBe(0);
  form.published!.schema.settings.cacheDraft = true;
  form.versions[0]!.schema.settings.cacheDraft = true;
  store.data.forms = [form];
  const next = await mount();
  await click("编辑");
  await fill("明确放弃");
  document.querySelector<HTMLButtonElement>('[aria-label="关闭"]')!.click();
  await nextTick();
  await click("放弃修改");
  expect(next.drafts.entries).toHaveLength(0);
  await click("编辑");
  expect(button("恢复内容")).toBeUndefined();
  expect(input().value).toBe("原业务");
});

it("keeps print fields inside the printing grant when a view-only group reveals more data", async () => {
  const view = newAccessGroup(form.schema);
  view.id = "view-more";
  view.identities = ["zhang"];
  view.actions = ["view"];
  view.scope = "all";
  store.data.formAccess![form.id]!.groups.push(view);
  await mount();
  expect(document.body.textContent).toContain("内部内容");
  await click("打印");
  const dialog = document.querySelector("dialog[open]")!;
  expect(dialog.textContent).toContain("原业务");
  expect(dialog.textContent).toContain("当前结论");
  expect(dialog.textContent).not.toContain("内部备注");
  expect(dialog.textContent).not.toContain("内部内容");
});
