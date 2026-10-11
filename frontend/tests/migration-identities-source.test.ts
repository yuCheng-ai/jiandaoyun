// @vitest-environment jsdom
import { webcrypto } from "node:crypto";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { seedWorkspace } from "../src/domain/workspace";
import { WORKSPACE_KEY } from "../src/repositories/workspaceRepository";
import { MIGRATION_NAMESPACE_KEY, migrationFingerprint, readMigrationIdentities } from "../src/repositories/migrationIdentities";
beforeEach(() => { localStorage.clear(); vi.stubGlobal("crypto", webcrypto); });
afterEach(() => vi.unstubAllGlobals());
it("hashes original business content independent of object key order and navigation cache", async () => {
  const a = { fields: [{ id: "a", name: "原名" }], recentFormIds: ["a"] };
  const first = await migrationFingerprint(JSON.stringify(a));
  expect(await migrationFingerprint(JSON.stringify({ recentFormIds: ["b"], fields: [{ name: "原名", id: "a" }] }))).toBe(first);
  a.fields[0].name = "已修改"; expect(await migrationFingerprint(JSON.stringify(a))).not.toBe(first);
});
it("expands referenced departments, hierarchy, managers, members and roles without exposing private fields", async () => {
  const data = seedWorkspace(); data.forms = []; data.entries = []; data.formAccess = {};
  const employee = data.organization.employees[0], role = data.organization.roles[0];
  data.organization.departments = [{ id: "parent", name: "父部门", parentId: null, managerIds: ["manager"], archived: false }, { id: "child", name: "子部门", parentId: "parent", managerIds: [], archived: false }];
  data.organization.employees = [{ ...employee, id: "manager", name: "负责人", departmentIds: ["parent"], primaryDepartmentId: "parent", email: "private@example.test" }, { ...employee, id: "member", name: "成员", departmentIds: ["child"], primaryDepartmentId: "child" }];
  data.organization.roles = [{ ...role, id: "role", name: "业务角色", departmentIds: ["parent"], memberIds: [], grants: [{ appId: "oa", formIds: [], actions: ["view"], dataScope: "all" }] }];
  const raw = JSON.stringify(data); localStorage.setItem(WORKSPACE_KEY, raw);
  const first = await readMigrationIdentities("oa");
  expect(first.identities.map(item => item.sourceId).sort()).toEqual(["child", "manager", "member", "parent", "role"]);
  expect(JSON.stringify(first)).not.toContain("private@example.test");
  expect(localStorage.getItem(WORKSPACE_KEY)).toBe(raw);
  expect(localStorage.getItem(MIGRATION_NAMESPACE_KEY)).toBe(first.namespace);
  expect((await readMigrationIdentities("product")).namespace).toBe(first.namespace);
});
it("refuses a missing or lossy source, preserving the original snapshot", async () => {
  await expect(readMigrationIdentities("oa")).rejects.toThrow("还没有已保存");
  const data = seedWorkspace(); (data.forms[0].extensions as any).extraConfig = ["unsupported"];
  const raw = JSON.stringify(data); localStorage.setItem(WORKSPACE_KEY, raw);
  await expect(readMigrationIdentities("oa")).rejects.toThrow("extraConfig"); expect(localStorage.getItem(WORKSPACE_KEY)).toBe(raw);
});
it("rejects a source that changes while its fingerprint is being computed", async () => {
  const raw = JSON.stringify(seedWorkspace()); let reads = 0;
  const storage = { getItem: (key: string) => key === MIGRATION_NAMESPACE_KEY ? "11111111-1111-4111-8111-111111111111" : ++reads === 1 ? raw : `${raw} `, setItem: vi.fn() };
  await expect(readMigrationIdentities("oa", storage)).rejects.toThrow("读取期间应用已变化"); expect(storage.setItem).not.toHaveBeenCalled();
});

it("includes identities referenced only by permission filter constants in historical fields, without changing source", async () => {
  const { createField } = await import("../src/domain/form");
  const { defaultAccess, newAccessGroup } = await import("../src/domain/access");
  const { newForm } = await import("../src/domain/workspace");
  const data = seedWorkspace(), form = newForm("oa", "历史筛选");
  const member = createField("member"), department = createField("department");
  form.schema.fields = [member, department];
  form.versions = [{ version: 1, title: form.title, schema: structuredClone(form.schema), workflow: structuredClone(form.workflow), extensions: structuredClone(form.extensions), publishedAt: "2025-01-01T00:00:00Z" }];
  form.schema.fields = [];
  const group = newAccessGroup(form.schema); group.archived = true; group.enabled = false;
  group.scope = "custom"; group.filters = [
    { id: "f1", sourceFieldId: member.id, source: "constant", operator: "equals", value: "departed-filter-only" },
    { id: "f2", sourceFieldId: department.id, source: "constant", operator: "notEquals", value: "removed-department-only" },
  ];
  data.forms = [form]; data.entries = []; data.formAccess = { [form.id]: { ...defaultAccess(), groups: [group] } }; data.organization.roles = [];
  const raw = JSON.stringify(data); localStorage.setItem(WORKSPACE_KEY, raw);
  const source = await readMigrationIdentities("oa");
  expect(source.identities).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: "member", sourceId: "departed-filter-only", found: false }),
    expect.objectContaining({ kind: "department", sourceId: "removed-department-only", found: false }),
  ]));
  expect(localStorage.getItem(WORKSPACE_KEY)).toBe(raw);
});
