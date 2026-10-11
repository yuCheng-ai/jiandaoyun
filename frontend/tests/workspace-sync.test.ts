import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia } from "pinia";
import { copy, createField } from "../src/domain/form";
import { seedWorkspace } from "../src/domain/workspace";
import {
  WORKSPACE_KEY,
  LocalWorkspaceRepository,
} from "../src/repositories/workspaceRepository";
import { useWorkspaceStore } from "../src/stores/workspace";

let memory: Map<string, string>;
const open = () => useWorkspaceStore(createPinia());
beforeEach(() => {
  memory = new Map([[WORKSPACE_KEY, JSON.stringify(seedWorkspace())]]);
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => memory.set(key, value),
  });
});
describe("scoped workspace synchronization", () => {
  it("also synchronizes from the first saved seed with absent optional arrays", async () => {
    memory.delete(WORKSPACE_KEY);
    const old = open();
    old.openForm("employee");
    expect(await old.saveForm("employee")).toBe(true);
    const other = open();
    await other.createForm("oa", "第二张表单", "form");
    expect(old.checkStorageChanges()).toBe(true);
    expect(await old.saveForm("employee")).toBe(true);
  });
  it("adopts other forms without writing storage or replacing an open designer draft", async () => {
    const old = open(),
      other = open(),
      draft = old.openForm("employee")!;
    const field = createField("text", { label: "保留拖入的字段" });
    draft.schema.fields.push(field);
    const created = (await other.createForm("oa", "另一个表单", "form"))!;
    const raw = memory.get(WORKSPACE_KEY);
    expect(old.checkStorageChanges()).toBe(true);
    expect(old.storageError).toBe("");
    expect(old.drafts.employee).toBe(draft);
    expect(draft.schema.fields.at(-1)?.id).toBe(field.id);
    expect(old.data.forms.some((f) => f.id === created.id)).toBe(false);
    expect(memory.get(WORKSPACE_KEY)).toBe(raw);
    expect(await old.saveForm("employee")).toBe(true);
    const saved = new LocalWorkspaceRepository().load()!;
    expect(saved.forms.some((f) => f.id === created.id)).toBe(true);
    expect(
      saved.forms.find((f) => f.id === "employee")?.schema.fields.at(-1)?.id,
    ).toBe(field.id);
  });
  it("checks additions under the write lock even without storage events", async () => {
    const old = open(),
      other = open();
    old.openForm("employee")!.title = "我的设计";
    const created = (await other.createForm("oa", "其他页面新增", "form"))!;
    other
      .openForm(created.id)!
      .schema.fields.push(createField("text", { label: "说明" }));
    expect(await other.publishForm(created.id)).toBe(true);
    expect(await other.submitEntry(created.id, {}, "draft")).toBeTruthy();
    expect(await old.saveForm("employee")).toBe(true);
    expect(new LocalWorkspaceRepository().load()!.entries).toHaveLength(1);
  });
  it("preserves a same-form conflict and names the changed content", async () => {
    const old = open(),
      other = open();
    old.openForm("employee")!.title = "我的未保存设计";
    await other.renameForm("employee", "其他页面名称");
    const raw = memory.get(WORKSPACE_KEY);
    expect(await old.saveForm("employee")).toBe(false);
    expect(old.storageChanges).toContain("表单「其他页面名称」");
    expect(old.drafts.employee!.title).toBe("我的未保存设计");
    expect(memory.get(WORKSPACE_KEY)).toBe(raw);
  });
  it("does not discard an uncommitted business mutation while adopting additions", async () => {
    const old = open(),
      other = open();
    old.data.apps[0]!.name = "尚未保存";
    await other.createForm("oa", "新增", "form");
    expect(await old.persist()).toBe(false);
    expect(old.data.apps[0]!.name).toBe("尚未保存");
  });
  it("does not silently adopt existing record, permission or organization changes", async () => {
    for (const area of ["entries", "organization", "formAccess"] as const) {
      const old = open();
      const latest = copy(old.data);
      if (area === "entries")
        latest.entries.push({
          id: "new-record",
          formId: "employee",
          status: "draft",
          history: [],
          values: {},
        } as any);
      if (area === "organization")
        latest.organization.employees[0]!.name = "已更改";
      if (area === "formAccess")
        latest.formAccess = { employee: { mode: "test" } } as any;
      memory.set(WORKSPACE_KEY, JSON.stringify(latest));
      expect(old.checkStorageChanges()).toBe(true);
      expect(old.data).not.toEqual(latest);
    }
  });
  it("refuses a lossy compatibility read and a snapshot changed during inspection", async () => {
    const old = open(),
      other = open();
    await other.createForm("oa", "新增", "form");
    const raw = JSON.parse(memory.get(WORKSPACE_KEY)!);
    raw.entries.push({
      id: "unsupported",
      formId: "employee",
      status: "future",
      values: {},
      history: [],
    });
    memory.set(WORKSPACE_KEY, JSON.stringify(raw));
    expect(old.checkStorageChanges()).toBe(true);
    const repo = new LocalWorkspaceRepository();
    expect(() => repo.load()).toThrow("无法完整读取");
    expect(repo.baselineRaw()).toBeUndefined();
    memory.set(WORKSPACE_KEY, JSON.stringify(seedWorkspace()));
    repo.load();
    memory.set(WORKSPACE_KEY, "changed again");
    expect(() => repo.adoptSnapshot(JSON.stringify(raw))).toThrow();
  });
});
