import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia } from "pinia";
import { copy, createField } from "../src/domain/form";
import {
  defaultAccess,
  newAccessGroup,
  memberSchema,
} from "../src/domain/access";
import { newWebhook } from "../src/domain/extensions";
import { seedWorkspace } from "../src/domain/workspace";
import { useWorkspaceStore } from "../src/stores/workspace";
import {
  LocalWorkspaceRepository,
  WORKSPACE_KEY,
} from "../src/repositories/workspaceRepository";

let memory: Map<string, string>;
const tab = () => useWorkspaceStore(createPinia());
const saved = () => new LocalWorkspaceRepository().load()!;
beforeEach(() => {
  memory = new Map([[WORKSPACE_KEY, JSON.stringify(seedWorkspace())]]);
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => memory.set(key, value),
  });
});
async function formWithRecords() {
  const setup = tab(),
    form = (await setup.createForm("oa", "独立记录", "form"))!;
  const draft = setup.openForm(form.id)!;
  draft.schema.fields = [
    createField("text", {
      id: "name",
      label: "名称",
      required: true,
      unique: true,
    }),
  ];
  expect(await setup.publishForm(form.id)).toBe(true);
  const a = (await setup.submitEntry(form.id, { name: "A" }))!;
  const b = (await setup.submitEntry(form.id, { name: "B" }))!;
  return { setup, form, a, b };
}

it("reopening an untouched cached design adopts the latest saved form without manufacturing unsaved edits", async () => {
  const { form } = await formWithRecords(),
    old = tab(),
    other = tab();
  const cached = old.openForm(form.id)!;
  const edited = other.openForm(form.id)!;
  edited.schema.fields[0]!.label = "最新字段名称";
  edited.schema.fields[0]!.duplicateMessage = "自定义重复提示";
  expect(await other.publishForm(form.id)).toBe(true);
  expect(old.openForm(form.id)).toBe(cached);
  expect(cached.schema).toEqual(
    old.data.forms.find((item) => item.id === form.id)!.schema,
  );
  expect(cached.schema.fields[0]!.label).toBe("最新字段名称");
  expect(cached.schema.fields[0]!.duplicateMessage).toBe("自定义重复提示");
  expect(await old.saveForm(form.id)).toBe(true);
  expect(
    saved().forms.find((item) => item.id === form.id)!.published!.version,
  ).toBe(2);
});

it("reopening a genuinely edited cached design preserves its input and original conflict baseline", async () => {
  const { form } = await formWithRecords(),
    old = tab(),
    other = tab();
  const draft = old.openForm(form.id)!;
  draft.schema.fields[0]!.label = "本页尚未保存";
  other.openForm(form.id)!.schema.fields[0]!.label = "另一页已保存";
  expect(await other.saveForm(form.id)).toBe(true);
  expect(old.openForm(form.id)).toBe(draft);
  expect(draft.schema.fields[0]!.label).toBe("本页尚未保存");
  expect(
    old.data.forms.find((item) => item.id === form.id)!.schema.fields[0]!.label,
  ).toBe("另一页已保存");
  expect(await old.saveForm(form.id)).toBe(false);
  expect(
    saved().forms.find((item) => item.id === form.id)!.schema.fields[0]!.label,
  ).toBe("另一页已保存");
});

it("clears an ended save-error context on a successful read without advancing an unsaved editor baseline", async () => {
  const { form } = await formWithRecords(),
    old = tab(),
    other = tab();
  const draft = old.openForm(form.id)!;
  draft.schema.fields[0]!.label = "本页草稿";
  other.openForm(form.id)!.schema.fields[0]!.label = "另一页已发布";
  expect(await other.publishForm(form.id)).toBe(true);
  expect(await old.saveForm(form.id)).toBe(false);
  expect(old.storageConflict).toBe(true);
  expect(old.storageError).toBeTruthy();
  expect(old.refreshForRead()).toBe(true);
  expect(old.storageError).toBe("");
  expect(old.storageConflict).toBe(false);
  expect(draft.schema.fields[0]!.label).toBe("本页草稿");
  expect(await old.saveForm(form.id)).toBe(false);
  expect(
    saved().forms.find((f) => f.id === form.id)!.published!.schema.fields[0]!
      .label,
  ).toBe("另一页已发布");
});

describe("task-scoped transaction boundary", () => {
  it("saves the first access configuration after another tab republishes a new form", async () => {
    const setup = tab();
    const form = (await setup.createForm("oa", "首次发布权限", "form"))!;
    setup.openForm(form.id)!.schema.fields = [
      createField("text", { id: "name" }),
    ];
    expect(await setup.publishForm(form.id)).toBe(true);
    const old = tab(),
      other = tab(),
      edited = defaultAccess();
    edited.filling.limit = 17;
    other
      .openForm(form.id)!
      .schema.fields.push(createField("number", { id: "amount" }));
    expect(await other.publishForm(form.id)).toBe(true);
    expect(await old.saveFormAccess(form.id, edited, defaultAccess())).toBe(
      true,
    );
    expect(
      saved().forms.find((f) => f.id === form.id)!.published!.version,
    ).toBe(2);
    expect(saved().formAccess![form.id]!.filling.limit).toBe(17);
  });
  it("does not save access edits under a member changed by another tab while the command waits", async () => {
    const { setup, form } = await formWithRecords();
    const access = defaultAccess();
    expect(await setup.saveFormAccess(form.id, access)).toBe(true);
    const old = tab(),
      other = tab(),
      edited = copy(access);
    edited.filling.limit = 23;
    // Both commands request the same lock; the member switch commits first.
    const switching = other.setCurrentUser("li");
    const saving = old.saveFormAccess(form.id, edited, access);
    await switching;
    expect(await saving).not.toBe(true);
    expect(saved().organization.currentUserId).toBe("li");
    expect(saved().formAccess![form.id]!.filling.limit).toBe(0);
    expect(edited.filling.limit).toBe(23);
  });
  it("saves access edits after another tab publishes fields, without overwriting that design or granting new fields", async () => {
    const { setup, form, a } = await formWithRecords();
    const group = newAccessGroup(setup.openForm(form.id)!.schema);
    group.identities = ["zhang"];
    const access = {
      ...defaultAccess(),
      membersEnabled: true,
      groups: [group],
    };
    await setup.saveFormAccess(form.id, access);
    const old = tab(),
      other = tab(),
      expected = copy(access),
      edited = copy(access);
    edited.filling.limit = 20;
    const draft = other.openForm(form.id)!;
    draft.schema.fields[0]!.label = "新的名称";
    draft.schema.fields.push(createField("number", { id: "new_number" }));
    expect(await other.publishForm(form.id)).toBe(true);
    expect(await old.saveFormAccess(form.id, edited, expected)).toBe(true);
    const current = saved(),
      published = current.forms.find((f) => f.id === form.id)!.published!;
    expect(published.version).toBe(2);
    expect(published.schema.fields[0]!.label).toBe("新的名称");
    expect(current.formAccess![form.id]!.filling.limit).toBe(20);
    expect(
      memberSchema(published.schema, current.formAccess![form.id]!.groups)
        .fields[1]!.visible,
    ).toBe(false);
    expect(current.entries.find((e) => e.id === a.id)!.definitionVersion).toBe(
      1,
    );
  });
  it("rechecks pending filter references after a new publication, and cannot overwrite concurrently changed access settings", async () => {
    const { setup, form } = await formWithRecords();
    const group = newAccessGroup(setup.openForm(form.id)!.schema);
    group.identities = ["zhang"];
    const access = {
      ...defaultAccess(),
      membersEnabled: true,
      groups: [group],
    };
    await setup.saveFormAccess(form.id, access);
    const old = tab(),
      other = tab(),
      edited = copy(access);
    edited.groups[0]!.scope = "custom";
    edited.groups[0]!.filters = [
      {
        id: "filter",
        sourceFieldId: "name",
        operator: "notEmpty",
        source: "constant",
        value: "",
      },
    ];
    other.openForm(form.id)!.schema.fields = [
      createField("text", { id: "replacement" }),
    ];
    expect(await other.publishForm(form.id)).toBe(true);
    expect(await old.saveFormAccess(form.id, edited, access)).toBe(false);
    expect(old.storageError).toBe("");
    expect(old.notices.at(-1)!.message).toContain("有效的数据筛选条件");
    const expected = copy(access),
      concurrent = copy(access);
    concurrent.publicEnabled = false;
    expect(await other.saveFormAccess(form.id, concurrent, access)).toBe(true);
    expect(await old.saveFormAccess(form.id, expected, access)).toBe(false);
    expect(saved().formAccess![form.id]!.publicEnabled).toBe(false);
  });
  it("opens a new editor from the latest saved content without writing or replacing existing drafts", async () => {
    const old = tab(),
      other = tab();
    const retained = old.openForm("employee")!;
    retained.title = "未保存";
    other.openForm("expense")!.title = "最新报销";
    await other.saveForm("expense");
    const raw = memory.get(WORKSPACE_KEY);
    expect(old.openForm("expense")!.title).toBe("最新报销");
    expect(old.drafts.employee).toBe(retained);
    expect(memory.get(WORKSPACE_KEY)).toBe(raw);
    expect(old.storageError).toBe("");
  });
  it("creates and publishes a new form after unrelated edits without disturbing either design", async () => {
    const old = tab(),
      other = tab();
    const retained = old.openForm("employee")!;
    retained.schema.fields.push(
      createField("number", { label: "保留我的草稿" }),
    );
    await other.renameForm("expense", "财务刚更新");
    expect(old.checkStorageChanges()).toBe(true);
    expect(old.storageError).toBe("");
    const created = (await old.createForm("oa", "新表单", "form", "人事类"))!;
    expect(created).toBeTruthy();
    const design = old.openForm(created.id)!;
    design.schema.fields.push(createField("text", { label: "新增字段" }));
    expect(await old.publishForm(created.id)).toBe(true);
    expect(old.drafts.employee).toBe(retained);
    expect(await old.saveForm("employee")).toBe(true);
    expect(saved().forms.find((f) => f.id === "expense")!.title).toBe(
      "财务刚更新",
    );
    expect(
      saved().forms.find((f) => f.id === created.id)!.published!.schema
        .fields[0]!.label,
    ).toBe("新增字段");
    expect(old.storageError).toBe("");
  });
  it("serializes simultaneous independent creations instead of asking one user to retry", async () => {
    const a = tab(),
      b = tab();
    const result = await Promise.all([
      a.createForm("oa", "A", "form"),
      b.createForm("oa", "B", "form"),
    ]);
    expect(result.every(Boolean)).toBe(true);
    expect(
      saved().forms.filter((f) => result.some((r) => r!.id === f.id)),
    ).toHaveLength(2);
  });
  it("keeps a stale designer baseline after another successful command, including rename", async () => {
    const old = tab(),
      other = tab();
    const design = old.openForm("employee")!;
    design.schema.fields.push(createField("text", { label: "我的修改" }));
    other
      .openForm("employee")!
      .schema.fields.push(createField("text", { label: "其他人的修改" }));
    await other.saveForm("employee");
    expect(await old.saveForm("employee")).toBe(false);
    expect(await old.createForm("oa", "仍能新建", "form")).toBeTruthy();
    expect(old.storageError).toBe("");
    expect(await old.renameForm("employee", "重命名不能解除冲突")).toBe(false);
    expect(await old.saveForm("employee")).toBe(false);
    expect(
      saved()
        .forms.find((f) => f.id === "employee")!
        .schema.fields.at(-1)!.label,
    ).toBe("其他人的修改");
    expect(design.schema.fields.at(-1)!.label).toBe("我的修改");
  });
  it("checks a new form's actual parent after synchronization", async () => {
    const app = (await tab().createApp("可移除的空应用"))!;
    const old = tab(),
      other = tab();
    other.data.apps = other.data.apps.filter((a) => a.id !== app.id);
    await other.persist();
    const before = memory.get(WORKSPACE_KEY);
    expect(await old.createForm(app.id, "孤儿表单", "form")).toBeUndefined();
    expect(old.notices.at(-1)!.message).toContain("应用已不存在");
    expect(memory.get(WORKSPACE_KEY)).toBe(before);
    expect(old.storageError).toBe("");
  });
  it("saves unrelated form configuration while preserving updates elsewhere", async () => {
    const old = tab(),
      other = tab();
    old.openForm("employee");
    await other.renameForm("expense", "财务变更");
    const hook = newWebhook();
    hook.name = "通知";
    hook.url = "https://example.com/hook";
    expect(await old.saveWebhook("employee", hook)).toBe(true);
    expect(saved().forms.find((f) => f.id === "expense")!.title).toBe(
      "财务变更",
    );
    expect(
      saved().forms.find((f) => f.id === "employee")!.extensions!.webhooks[0]!
        .name,
    ).toBe("通知");
  });
  it("allows edits to different records and keeps the latest uniqueness constraint", async () => {
    const { a, b } = await formWithRecords();
    const old = tab(),
      other = tab();
    expect(await other.updateEntry(a.id, { name: "新名称" })).toBe(true);
    expect(await old.updateEntry(b.id, { name: "新名称" })).toBe(false);
    expect(old.notices.at(-1)!.message).toContain("重复");
    expect(old.storageConflict).toBe(false);
    expect(await old.updateEntry(b.id, { name: "另一个名称" })).toBe(true);
    expect(saved().entries.map((e) => e.values.name)).toEqual(
      expect.arrayContaining(["新名称", "另一个名称"]),
    );
  });
  it("does not overwrite an open record editor after another action has refreshed its committed data", async () => {
    const { a } = await formWithRecords();
    const old = tab(),
      expected = copy(old.data.entries.find((e) => e.id === a.id)!.values);
    await tab().updateEntry(a.id, { name: "最新内容" });
    await old.createApp("另一个操作");
    expect(
      await old.updateEntry(
        a.id,
        { name: "旧编辑器修改" },
        undefined,
        undefined,
        undefined,
        expected,
      ),
    ).toBe(false);
    expect(saved().entries.find((e) => e.id === a.id)!.values.name).toBe(
      "最新内容",
    );
  });
  it("rechecks the latest collection limit without a workspace-conflict warning", async () => {
    const { setup, form } = await formWithRecords();
    const access = defaultAccess();
    access.filling.limit = 3;
    await setup.saveFormAccess(form.id, access);
    const old = tab(),
      other = tab();
    await other.submitEntry(form.id, { name: "第三条" });
    expect(await old.submitEntry(form.id, { name: "第四条" })).toBeUndefined();
    expect(saved().entries).toHaveLength(3);
    expect(old.storageError).toBe("");
    expect(old.notices.at(-1)!.message).toContain("上限");
  });
  it("checks current permissions before a member write after another tab revokes them", async () => {
    const { setup, form, a } = await formWithRecords();
    const access = defaultAccess();
    const group = newAccessGroup(setup.openForm(form.id)!.schema, "all");
    group.identities = ["zhang"];
    group.actions = ["view", "edit"];
    access.membersEnabled = true;
    access.groups = [group];
    await setup.saveFormAccess(form.id, access);
    const old = tab(),
      other = tab();
    access.groups[0]!.enabled = false;
    await other.saveFormAccess(form.id, access);
    expect(
      await old.memberUpdate(
        a.id,
        "zhang",
        group.id,
        { name: "无权修改" },
        a.values,
      ),
    ).toBe(false);
    expect(saved().entries.find((e) => e.id === a.id)!.values.name).toBe("A");
    expect(old.storageError).toBe("");
  });
  it("rejects the entire staged member update after another tab revokes one column grant", async () => {
    const { setup, form, a } = await formWithRecords();
    const access = defaultAccess();
    const group = newAccessGroup(setup.openForm(form.id)!.schema, "all");
    group.identities = ["zhang"];
    group.actions = ["view", "edit"];
    group.fields.name = "edit";
    access.membersEnabled = true;
    access.groups = [group];
    expect(await setup.saveFormAccess(form.id, access)).toBe(true);
    const old = tab(),
      other = tab();
    const expectedSchema = memberSchema(
      old.data.forms.find((f) => f.id === form.id)!.published!.schema,
      [group],
      true,
    );
    access.groups[0]!.fields.name = "read";
    expect(await other.saveFormAccess(form.id, access)).toBe(true);
    const committed = copy(saved().entries.find((e) => e.id === a.id)!);
    expect(
      await old.memberUpdate(
        a.id,
        "zhang",
        group.id,
        { name: "不能丢弃的输入" },
        a.values,
        expectedSchema,
      ),
    ).toBe(false);
    expect(saved().entries.find((e) => e.id === a.id)).toEqual(committed);
    expect(old.storageError).toBe("");
    expect(old.storageConflict).toBe(false);
    expect(old.notices.at(-1)!.message).toContain("编辑权限已变化");
  });
  it("keeps a member edit valid after a group rename and unrelated form creation", async () => {
    const { setup, form, a } = await formWithRecords();
    const access = defaultAccess();
    const group = newAccessGroup(setup.openForm(form.id)!.schema, "all");
    group.identities = ["zhang"];
    group.actions = ["view", "edit"];
    group.fields.name = "edit";
    access.membersEnabled = true;
    access.groups = [group];
    expect(await setup.saveFormAccess(form.id, access)).toBe(true);
    const old = tab(),
      other = tab();
    const expectedSchema = memberSchema(
      old.data.forms.find((f) => f.id === form.id)!.published!.schema,
      [group],
      true,
    );
    access.groups[0]!.name = "改名但权限相同";
    expect(await other.saveFormAccess(form.id, access)).toBe(true);
    expect(await other.createForm("oa", "无关的新表单", "form")).toBeTruthy();
    expect(
      await old.memberUpdate(
        a.id,
        "zhang",
        group.id,
        { name: "完整保存" },
        a.values,
        expectedSchema,
      ),
    ).toBe(true);
    expect(saved().entries.find((e) => e.id === a.id)!.values.name).toBe(
      "完整保存",
    );
    expect(saved().forms.some((f) => f.title === "无关的新表单")).toBe(true);
    expect(old.storageError).toBe("");
    expect(old.storageConflict).toBe(false);
  });
  it("keeps published record entry independent from unsubmitted design edits", async () => {
    const { form } = await formWithRecords();
    const old = tab(),
      other = tab();
    other
      .openForm(form.id)!
      .schema.fields.push(createField("text", { label: "尚未发布" }));
    await other.saveForm(form.id);
    expect(await old.submitEntry(form.id, { name: "继续填写" })).toBeTruthy();
    expect(
      saved().forms.find((f) => f.id === form.id)!.schema.fields,
    ).toHaveLength(2);
  });
  it("preserves a failed write for retry after a quota error", async () => {
    const old = tab();
    old.openForm("employee")!.title = "保留修改";
    await tab().renameForm("expense", "保留外部修改");
    const original = localStorage.setItem;
    vi.spyOn(localStorage, "setItem").mockImplementationOnce(() => {
      throw Error("容量不足");
    });
    expect(await old.saveForm("employee")).toBe(false);
    expect(saved().forms.find((f) => f.id === "expense")!.title).toBe(
      "保留外部修改",
    );
    localStorage.setItem = original;
    expect(await old.saveForm("employee")).toBe(true);
    expect(saved().forms.find((f) => f.id === "employee")!.title).toBe(
      "保留修改",
    );
  });
});
