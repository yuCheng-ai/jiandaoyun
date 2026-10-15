import type { DirectorySpec, FormValues } from "@platform/contracts";
export type {
  DirectoryDepartment as Department,
  DirectoryEmployee as Employee,
  DirectoryRoleGroup as RoleGroup,
  DirectoryRole as OrganizationRole,
  EmployeeStatus,
  GrantAction,
  RoleGrant,
} from "@platform/contracts";
import type {
  DirectoryDepartment as Department,
  DirectoryEmployee as Employee,
  DirectoryRole as OrganizationRole,
} from "@platform/contracts";
export interface Organization extends DirectorySpec {
  currentUserId: string;
}
export function emptyOrganization(): Organization {
  return {
    version: 1,
    name: "组织与成员",
    currentUserId: "",
    departments: [],
    employees: [],
    roles: [],
    roleGroups: [],
  };
}
import type {
  SelectionScope,
  OrganizationFieldConfig,
} from "@platform/contracts";
export type {
  SelectionScope,
  OrganizationFieldConfig,
} from "@platform/contracts";
export const emptyScope = (): SelectionScope => ({
  mode: "all",
  departmentIds: [],
  roleIds: [],
  employeeIds: [],
  includeChildren: true,
  fieldId: "",
});
export const emptyOrganizationField = (): OrganizationFieldConfig => ({
  scope: emptyScope(),
  defaultMode: "none",
  defaultIds: [],
});
export function descendants(
  org: Organization,
  id: string,
  includeSelf = true,
): string[] {
  const result = new Set<string>(includeSelf ? [id] : []),
    visited = new Set<string>();
  function visit(parent: string) {
    if (visited.has(parent)) return;
    visited.add(parent);
    for (const d of org.departments.filter(
      (d) => d.parentId === parent && !d.archived,
    )) {
      result.add(d.id);
      visit(d.id);
    }
  }
  visit(id);
  return [...result];
}
export function departmentPath(org: Organization, id: string): string {
  const names: string[] = [],
    seen = new Set<string>();
  let d = org.departments.find((d) => d.id === id);
  while (d && !seen.has(d.id)) {
    seen.add(d.id);
    names.unshift(d.name);
    d = org.departments.find((item) => item.id === d!.parentId);
  }
  return names.join(" / ");
}
export function roleMembers(
  org: Organization,
  role: OrganizationRole,
): Employee[] {
  if (role.archived) return [];
  const departments = new Set(
    role.departmentIds.flatMap((id) =>
      role.includeChildren ? descendants(org, id) : [id],
    ),
  );
  return org.employees.filter(
    (e) =>
      e.status === "active" &&
      (role.memberIds.includes(e.id) ||
        e.departmentIds.some((id) => departments.has(id))),
  );
}
export function rolesFor(org: Organization, employeeId: string) {
  return org.roles.filter((r) =>
    roleMembers(org, r).some((e) => e.id === employeeId),
  );
}
export function identityLabel(org: Organization, id: string) {
  return (
    org.employees.find((e) => e.id === id)?.name ||
    org.departments.find((d) => d.id === id)?.name ||
    org.roles.find((r) => r.id === id)?.name ||
    `已失效项（${id}）`
  );
}
export function resolveIdentities(
  org: Organization,
  ids: string[],
): Employee[] {
  const result = new Set<string>();
  for (const id of ids) {
    const role = org.roles.find((r) => r.id === id);
    if (role) roleMembers(org, role).forEach((e) => result.add(e.id));
    else if (org.departments.some((d) => d.id === id)) {
      const deps = new Set(descendants(org, id));
      org.employees
        .filter((e) => e.departmentIds.some((d) => deps.has(d)))
        .forEach((e) => result.add(e.id));
    } else result.add(id);
  }
  return org.employees.filter((e) => e.status === "active" && result.has(e.id));
}
export function allowedDepartments(
  org: Organization,
  scope: SelectionScope,
  values: FormValues = {},
): Department[] {
  const current = org.employees.find((e) => e.id === org.currentUserId);
  let ids: string[] | undefined;
  if (scope.mode === "custom") ids = scope.departmentIds;
  if (scope.mode === "currentDepartment") ids = current?.departmentIds || [];
  if (scope.mode === "fieldDepartment") {
    const value = values[scope.fieldId];
    ids = Array.isArray(value)
      ? value.map(String)
      : value
        ? [String(value)]
        : [];
  }
  const allowed = ids
    ? new Set(
        ids.flatMap((id) =>
          scope.includeChildren ? descendants(org, id) : [id],
        ),
      )
    : null;
  return org.departments.filter(
    (d) => !d.archived && (!allowed || allowed.has(d.id)),
  );
}
export function allowedEmployees(
  org: Organization,
  scope: SelectionScope,
  values: FormValues = {},
): Employee[] {
  if (scope.mode === "all")
    return org.employees.filter((e) => e.status === "active");
  const deps = new Set(allowedDepartments(org, scope, values).map((d) => d.id));
  const explicit = new Set(
    scope.mode === "custom"
      ? [
          ...scope.employeeIds,
          ...scope.roleIds.flatMap((id) => {
            const role = org.roles.find((r) => r.id === id);
            return role ? roleMembers(org, role).map((e) => e.id) : [];
          }),
        ]
      : [],
  );
  return org.employees.filter(
    (e) =>
      e.status === "active" &&
      (explicit.has(e.id) || e.departmentIds.some((d) => deps.has(d))),
  );
}
export function organizationDefault(
  org: Organization,
  config: OrganizationFieldConfig,
  kind: "member" | "department",
  multiple: boolean,
  values: FormValues = {},
): string | string[] {
  const current = org.employees.find((e) => e.id === org.currentUserId);
  let ids = config.defaultIds;
  if (config.defaultMode === "currentUser") ids = current ? [current.id] : [];
  if (config.defaultMode === "currentDepartment")
    ids = current?.primaryDepartmentId ? [current.primaryDepartmentId] : [];
  if (config.defaultMode === "departmentManager")
    ids =
      org.departments.find((d) => d.id === current?.primaryDepartmentId)
        ?.managerIds || [];
  const allowed = new Set(
    (kind === "member"
      ? allowedEmployees(org, config.scope, values)
      : allowedDepartments(org, config.scope, values)
    ).map((i) => i.id),
  );
  ids = ids.filter((id) => allowed.has(id));
  return multiple ? ids : ids[0] || "";
}
export function validateDepartment(
  org: Organization,
  department: Department,
): string[] {
  const errors: string[] = [];
  if (!department.name.trim()) errors.push("请输入部门名称");
  if (
    department.parentId === department.id ||
    (department.parentId &&
      descendants(org, department.id).includes(department.parentId))
  )
    errors.push("不能将部门移动到自身或下级部门");
  if (
    department.parentId &&
    !org.departments.some((d) => d.id === department.parentId && !d.archived)
  )
    errors.push("上级部门不存在");
  if (
    org.departments.some(
      (d) =>
        d.id !== department.id &&
        !d.archived &&
        d.parentId === department.parentId &&
        d.name === department.name.trim(),
    )
  )
    errors.push("同级部门名称不能重复");
  return errors;
}
export function validateEmployee(
  org: Organization,
  employee: Employee,
): string[] {
  const errors: string[] = [];
  if (!employee.name.trim()) errors.push("请输入成员姓名");
  if (!employee.number.trim()) errors.push("请输入工号");
  if (
    org.employees.some(
      (e) => e.id !== employee.id && e.number === employee.number,
    )
  )
    errors.push("工号已存在");
  if (employee.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(employee.email))
    errors.push("邮箱格式不正确");
  if (employee.phone && !/^\+?[\d -]{6,20}$/.test(employee.phone))
    errors.push("手机格式不正确");
  if (!employee.departmentIds.length) errors.push("请选择所属部门");
  if (!employee.departmentIds.includes(employee.primaryDepartmentId))
    errors.push("主部门必须属于所属部门");
  if (
    employee.departmentIds.some(
      (id) => !org.departments.some((d) => d.id === id && !d.archived),
    )
  )
    errors.push("所属部门不存在");
  return errors;
}
export function newEmployee(): Employee {
  return {
    id: `employee_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`,
    name: "",
    number: "",
    email: "",
    phone: "",
    departmentIds: [],
    primaryDepartmentId: "",
    position: "",
    status: "active",
    joinedAt: new Date().toLocaleDateString("en-CA"),
  };
}
export function parseOrganization(raw: unknown): Organization {
  // 未载入组织时保持为空，不能凭空创建示例身份或授权。
  if (!raw) return emptyOrganization();
  const org = JSON.parse(JSON.stringify(raw)) as Organization;
  if (
    org.version !== 1 ||
    !Array.isArray(org.departments) ||
    !Array.isArray(org.employees) ||
    !Array.isArray(org.roles) ||
    !Array.isArray(org.roleGroups)
  )
    throw Error("组织数据格式无效");
  const allIds = new Set<string>();
  for (const list of [
    org.departments,
    org.employees,
    org.roles,
    org.roleGroups,
  ]) {
    const ids = new Set();
    for (const item of list) {
      if (
        typeof item.id !== "string" ||
        !item.id ||
        ids.has(item.id) ||
        allIds.has(item.id) ||
        typeof item.name !== "string"
      )
        throw Error("组织对象 ID 或名称无效");
      ids.add(item.id);
      allIds.add(item.id);
    }
  }
  for (const d of org.departments) {
    d.archived = !!d.archived;
    d.managerIds = Array.isArray(d.managerIds)
      ? d.managerIds.filter((id) => org.employees.some((e) => e.id === id))
      : [];
    if (d.parentId && !org.departments.some((p) => p.id === d.parentId))
      throw Error("上级部门不存在");
    const seen = new Set([d.id]);
    let parent = d.parentId;
    while (parent) {
      if (seen.has(parent)) throw Error("部门结构存在循环");
      seen.add(parent);
      parent = org.departments.find((p) => p.id === parent)?.parentId || null;
    }
  }
  for (const e of org.employees) {
    for (const key of [
      "number",
      "email",
      "phone",
      "position",
      "joinedAt",
    ] as const)
      if (typeof e[key] !== "string") e[key] = "";
    if (
      !Array.isArray(e.departmentIds) ||
      !["active", "inactive", "left"].includes(e.status)
    )
      throw Error("成员数据无效");
    e.departmentIds = e.departmentIds.filter((id) =>
      org.departments.some((d) => d.id === id),
    );
    if (!e.departmentIds.includes(e.primaryDepartmentId))
      e.primaryDepartmentId = e.departmentIds[0] || "";
  }
  for (const r of org.roles) {
    if (!org.roleGroups.some((g) => g.id === r.groupId))
      throw Error("角色所属分组不存在");
    if (typeof r.description !== "string") r.description = "";
    r.includeChildren = r.includeChildren !== false;
    r.memberIds = (r.memberIds || []).filter((id) =>
      org.employees.some((e) => e.id === id),
    );
    r.departmentIds = (r.departmentIds || []).filter((id) =>
      org.departments.some((d) => d.id === id),
    );
    r.grants = Array.isArray(r.grants)
      ? r.grants
          .filter(
            (g) =>
              typeof g.appId === "string" &&
              Array.isArray(g.formIds) &&
              Array.isArray(g.actions),
          )
          .map((g) => ({
            ...g,
            actions: g.actions.filter((a) =>
              ["view", "submit", "manage"].includes(a),
            ),
            dataScope: ["all", "self", "department"].includes(g.dataScope)
              ? g.dataScope
              : "self",
          }))
      : [];
    r.archived = !!r.archived;
  }
  if (
    !org.employees.some(
      (e) => e.id === org.currentUserId && e.status === "active",
    )
  )
    org.currentUserId =
      org.employees.find((e) => e.status === "active")?.id || "";
  return org;
}
