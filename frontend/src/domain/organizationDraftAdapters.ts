import { checkedDraftValue, contextFingerprint } from "./editorDrafts";
import type {
  Department,
  Employee,
  OrganizationRole,
  RoleGroup,
} from "./organization";
import type { WorkspaceData } from "./workspace";

export interface OrganizationEditScope {
  kind: "employee" | "department" | "role" | "group" | "bulk";
  ids: string[];
}
export function organizationScopeValue(
  data: WorkspaceData,
  scope?: OrganizationEditScope,
) {
  const org = data.organization;
  if (!scope) return org;
  const list =
    scope.kind === "department"
      ? org.departments
      : scope.kind === "role"
        ? org.roles
        : scope.kind === "group"
          ? org.roleGroups
          : org.employees;
  return {
    member: org.currentUserId,
    items: scope.ids.map((id) => list.find((item) => item.id === id)),
    memberships:
      scope.kind === "employee" || scope.kind === "bulk"
        ? scope.ids.map((id) =>
            org.roles
              .filter((r) => r.memberIds.includes(id))
              .map((r) => r.id)
              .sort(),
          )
        : undefined,
  };
}
export function organizationEditContext(
  data: WorkspaceData,
  scope?: OrganizationEditScope,
) {
  const signature = contextFingerprint(
    JSON.stringify(organizationScopeValue(data, scope)),
  );
  return scope ? JSON.stringify({ scope, signature }) : signature;
}
export function organizationContextMatches(
  data: WorkspaceData,
  expected: string,
) {
  if (!expected.startsWith("{"))
    return expected === organizationEditContext(data);
  try {
    const { scope } = JSON.parse(expected);
    return expected === organizationEditContext(data, scope);
  } catch {
    return false;
  }
}
function object(value: unknown): Record<string, any> {
  const raw = checkedDraftValue(value);
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw Error("组织编辑内容格式无效");
  return raw as Record<string, any>;
}
const text = (value: unknown): value is string => typeof value === "string";
const strings = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.every(text) &&
  new Set(value).size === value.length;
function identity(
  raw: Record<string, any>,
  expectedId?: string,
  existingIds: string[] = [],
) {
  if (
    !text(raw.id) ||
    !raw.id ||
    (expectedId ? raw.id !== expectedId : existingIds.includes(raw.id))
  )
    throw Error("暂存身份不属于当前编辑对象");
}
/** Preserve unfinished input exactly; current business rules still run when saving. */
export function restoreEmployeeDraft(
  value: unknown,
  expectedId?: string,
  existingIds?: string[],
): { employee: Employee; roleIds: string[] } {
  const raw = object(value),
    employee = object(raw.employee);
  identity(employee, expectedId, existingIds);
  if (
    ![
      "name",
      "number",
      "phone",
      "email",
      "position",
      "joinedAt",
      "primaryDepartmentId",
    ].every((key) => text(employee[key])) ||
    !strings(employee.departmentIds) ||
    !strings(raw.roleIds) ||
    !["active", "inactive", "left"].includes(employee.status)
  )
    throw Error("成员信息或角色暂存格式无效");
  return { employee: employee as Employee, roleIds: raw.roleIds };
}
export function restoreDepartmentDraft(
  value: unknown,
  expectedId?: string,
  existingIds?: string[],
): Department {
  const raw = object(value);
  identity(raw, expectedId, existingIds);
  if (
    !text(raw.name) ||
    !(raw.parentId === null || text(raw.parentId)) ||
    !strings(raw.managerIds) ||
    typeof raw.archived !== "boolean"
  )
    throw Error("部门信息暂存格式无效");
  return raw as Department;
}
export function restoreRoleDraft(
  value: unknown,
  expectedId?: string,
  existingIds?: string[],
): OrganizationRole {
  const raw = object(value);
  identity(raw, expectedId, existingIds);
  if (
    !["name", "groupId", "description"].every((key) => text(raw[key])) ||
    !strings(raw.memberIds) ||
    !strings(raw.departmentIds) ||
    typeof raw.includeChildren !== "boolean" ||
    typeof raw.archived !== "boolean" ||
    !Array.isArray(raw.grants) ||
    raw.grants.some(
      (grant: any) =>
        !grant ||
        !text(grant.appId) ||
        !strings(grant.formIds) ||
        !strings(grant.actions) ||
        grant.actions.some(
          (action: string) => !["view", "submit", "manage"].includes(action),
        ) ||
        !["all", "self", "department"].includes(grant.dataScope),
    )
  )
    throw Error("角色成员或授权暂存格式无效");
  return raw as OrganizationRole;
}
export function restoreRoleGroupDraft(
  value: unknown,
  expectedId?: string,
  existingIds?: string[],
): RoleGroup {
  const raw = object(value);
  identity(raw, expectedId, existingIds);
  if (!text(raw.name)) throw Error("角色分组暂存格式无效");
  return { id: raw.id, name: raw.name };
}
export function restoreBulkOrganizationDraft(
  value: unknown,
  expectedIds: string[],
): string {
  const raw = object(value);
  if (
    !text(raw.value) ||
    !strings(raw.ids) ||
    JSON.stringify([...raw.ids].sort()) !==
      JSON.stringify([...expectedIds].sort())
  )
    throw Error("批量编辑暂存不属于当前选择的成员");
  return raw.value;
}
