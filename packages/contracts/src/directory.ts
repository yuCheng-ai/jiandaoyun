/** The directory keeps its original identities; login accounts are explicit associations. */
export interface DirectoryDepartment {
  id: string;
  name: string;
  parentId: string | null;
  managerIds: string[];
  archived: boolean;
}
export type EmployeeStatus = "active" | "inactive" | "left";
export interface DirectoryEmployee {
  id: string;
  name: string;
  number: string;
  email: string;
  phone: string;
  departmentIds: string[];
  primaryDepartmentId: string;
  position: string;
  status: EmployeeStatus;
  joinedAt: string;
}
export interface DirectoryRoleGroup {
  id: string;
  name: string;
}
export type GrantAction = "view" | "submit" | "manage";
export interface RoleGrant {
  appId: string;
  formIds: string[];
  actions: GrantAction[];
  dataScope: "all" | "self" | "department";
}
export interface DirectoryRole {
  id: string;
  name: string;
  groupId: string;
  description: string;
  memberIds: string[];
  departmentIds: string[];
  includeChildren: boolean;
  grants: RoleGrant[];
  archived: boolean;
}
export interface DirectorySpec {
  version: 1;
  name: string;
  departments: DirectoryDepartment[];
  employees: DirectoryEmployee[];
  roleGroups: DirectoryRoleGroup[];
  roles: DirectoryRole[];
}
export interface DirectorySnapshot {
  namespace: string;
  revision: number;
  spec: DirectorySpec;
}
export interface DirectoryEditScope {
  kind: "employee" | "department" | "role" | "group" | "bulk";
  ids: string[];
}

/** Compare only the edited identities; unrelated directory changes may merge. */
export function directoryEditContext(
  spec: DirectorySpec,
  scope?: DirectoryEditScope,
): string {
  const { version, name, departments, employees, roleGroups, roles } = spec;
  const list = scope?.kind === "department"
    ? departments
    : scope?.kind === "role"
      ? roles
      : scope?.kind === "group" ? roleGroups : employees;
  const value = scope
    ? {
        items: scope.ids.map(id => list.find(item => item.id === id)),
        memberships: scope.kind === "employee" || scope.kind === "bulk"
          ? scope.ids.map(id => roles
              .filter(role => role.memberIds.includes(id))
              .map(role => role.id)
              .sort())
          : undefined,
      }
    : { version, name, departments, employees, roleGroups, roles };
  return directoryCanonical({ scope, value });
}

export function directoryContextMatches(
  spec: DirectorySpec,
  expected: string,
): boolean {
  try {
    const { scope } = JSON.parse(expected);
    return directoryEditContext(spec, scope) === expected;
  } catch {
    return false;
  }
}
export interface DirectoryIdentity {
  kind: "department" | "role" | "group";
  id: string;
  targetId: string;
}

export function directoryCanonical(value: unknown): string {
  const sort = (v: any): any =>
    Array.isArray(v)
      ? v.map(sort)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .map((key) => [key, sort(v[key])]),
          )
        : v;
  return JSON.stringify(sort(value));
}

/** Strict validation never filters out source people, references or grants. */
export function validateDirectory(value: unknown): DirectorySpec {
  const fail = (message: string): never => {
    throw Error(message);
  };
  const object = (v: any, keys: string[]) => {
    if (
      !v ||
      typeof v !== "object" ||
      Array.isArray(v) ||
      Object.keys(v).some((key) => !keys.includes(key))
    )
      fail("通讯录包含不支持的内容");
  };
  const text = (v: any, required = false, max = 200) => {
    if (
      typeof v !== "string" ||
      v.length > max ||
      (required && !v.trim()) ||
      /[\u0000-\u001f]/.test(v)
    )
      fail("通讯录名称或标识不合法");
  };
  const list = (v: any) => {
    if (!Array.isArray(v) || v.length > 1000)
      fail("通讯录列表不合法或超过1000项");
  };
  const ids = (v: any) => {
    list(v);
    v.forEach((id: any) => text(id, true));
    if (new Set(v).size !== v.length) fail("通讯录引用重复");
  };
  const flag = (v: any) => {
    if (typeof v !== "boolean") fail("通讯录状态不合法");
  };
  const raw = value as DirectorySpec;
  object(raw, [
    "version",
    "name",
    "departments",
    "employees",
    "roles",
    "roleGroups",
  ]);
  if (raw.version !== 1) fail("通讯录版本不支持");
  text(raw.name, true);
  const allIds = new Set<string>();
  for (const entries of [
    raw.departments,
    raw.employees,
    raw.roles,
    raw.roleGroups,
  ]) {
    list(entries);
    for (const item of entries) {
      if (!item) fail("通讯录对象不合法");
      text(item.id, true);
      text(item.name, true);
      if (allIds.has(item.id)) fail("通讯录身份重复");
      allIds.add(item.id);
    }
  }
  const members = new Set(raw.employees.map((e) => e.id));
  const departments = new Map(raw.departments.map((d) => [d.id, d]));
  const numbers = new Set<string>();
  for (const d of raw.departments) {
    object(d, ["id", "name", "parentId", "managerIds", "archived"]);
    ids(d.managerIds);
    flag(d.archived);
    if (d.managerIds.some((id) => !members.has(id))) fail("部门负责人不存在");
    if (d.parentId !== null) text(d.parentId, true);
    const seen = new Set([d.id]);
    let parent = d.parentId;
    while (parent) {
      if (seen.has(parent)) fail("部门不能形成循环");
      seen.add(parent);
      const next = departments.get(parent);
      if (!next || (!d.archived && next.archived))
        fail("上级部门不存在或已归档");
      parent = next!.parentId;
    }
    if (
      !d.archived &&
      raw.departments.some(
        (other) =>
          other.id !== d.id &&
          !other.archived &&
          other.parentId === d.parentId &&
          other.name.trim() === d.name.trim(),
      )
    )
      fail("同级部门名称不能重复");
  }
  for (const e of raw.employees) {
    object(e, [
      "id",
      "name",
      "number",
      "email",
      "phone",
      "departmentIds",
      "primaryDepartmentId",
      "position",
      "status",
      "joinedAt",
    ]);
    for (const key of [
      "number",
      "email",
      "phone",
      "primaryDepartmentId",
      "position",
      "joinedAt",
    ] as const)
      text(e[key], key === "number");
    ids(e.departmentIds);
    if (!["active", "inactive", "left"].includes(e.status))
      fail("成员状态不合法");
    if (numbers.has(e.number)) fail("成员工号重复");
    numbers.add(e.number);
    if (e.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.email))
      fail("成员邮箱格式不正确");
    if (e.phone && !/^\+?[\d -]{6,20}$/.test(e.phone))
      fail("成员手机格式不正确");
    if (
      e.departmentIds.some(
        (id) =>
          !departments.has(id) ||
          (e.status === "active" && departments.get(id)!.archived),
      ) ||
      (e.departmentIds.length
        ? !e.departmentIds.includes(e.primaryDepartmentId)
        : !!e.primaryDepartmentId)
    )
      fail("成员所属部门或主部门不合法");
    if (e.status === "active" && !e.departmentIds.length)
      fail("在职成员必须有所属部门");
  }
  const groupNames = new Set<string>();
  for (const group of raw.roleGroups) {
    object(group, ["id", "name"]);
    if (groupNames.has(group.name.trim())) fail("角色分组名称重复");
    groupNames.add(group.name.trim());
  }
  for (const r of raw.roles) {
    object(r, [
      "id",
      "name",
      "groupId",
      "description",
      "memberIds",
      "departmentIds",
      "includeChildren",
      "grants",
      "archived",
    ]);
    text(r.groupId, true);
    text(r.description, false, 2000);
    ids(r.memberIds);
    ids(r.departmentIds);
    flag(r.includeChildren);
    flag(r.archived);
    list(r.grants);
    if (
      !raw.roleGroups.some((g) => g.id === r.groupId) ||
      r.memberIds.some((id) => !members.has(id)) ||
      r.departmentIds.some(
        (id) =>
          !departments.has(id) ||
          (!r.archived && departments.get(id)!.archived),
      )
    )
      fail("角色引用的分组、成员或部门不存在");
    if (
      !r.archived &&
      raw.roles.some(
        (other) =>
          other.id !== r.id &&
          !other.archived &&
          other.groupId === r.groupId &&
          other.name.trim() === r.name.trim(),
      )
    )
      fail("同组角色名称不能重复");
    for (const g of r.grants) {
      object(g, ["appId", "formIds", "actions", "dataScope"]);
      text(g.appId, true);
      ids(g.formIds);
      ids(g.actions);
      if (
        g.actions.some((a) => !["view", "submit", "manage"].includes(a)) ||
        !["all", "self", "department"].includes(g.dataScope)
      )
        fail("角色应用授权不合法");
    }
  }
  return structuredClone(raw);
}

/** Compare only changed resources; changes to unrelated members do not block a save. */
export function mergeDirectory(
  current: DirectorySpec,
  before: DirectorySpec,
  after: DirectorySpec,
): DirectorySpec {
  const result = structuredClone(current);
  if (before.name !== after.name) {
    if (current.name !== before.name)
      throw Error("组织名称已被修改，请关闭后重开编辑器核对");
    result.name = after.name;
  }
  for (const key of [
    "departments",
    "employees",
    "roles",
    "roleGroups",
  ] as const) {
    const old = new Map<string, any>(
      before[key].map((item) => [item.id, item]),
    );
    const next = new Map<string, any>(
      after[key].map((item) => [item.id, item]),
    );
    const now = new Map<string, any>(
      current[key].map((item) => [item.id, item]),
    );
    for (const id of new Set([...old.keys(), ...next.keys()])) {
      if (directoryCanonical(old.get(id)) === directoryCanonical(next.get(id)))
        continue;
      if (directoryCanonical(now.get(id)) !== directoryCanonical(old.get(id)))
        throw Error(
          `「${old.get(id)?.name || next.get(id)?.name}」已被修改。当前输入已保留，请关闭后重开编辑器核对`,
        );
      if (!next.has(id)) {
        if (key !== "roleGroups")
          throw Error("成员、部门和角色请停用或归档，不能删除原身份");
        now.delete(id);
      } else now.set(id, next.get(id));
    }
    (result[key] as any[]) = [...now.values()];
  }
  return validateDirectory(result);
}
