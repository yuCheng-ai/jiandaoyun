import { BadRequestException } from "@nestjs/common";
import {
  emptyFieldValue, equalFieldValues, isDepartmentField, isMultipleOrganization, isOrganizationField,
  organizationDepartments, organizationSubjectMembers,
  type FormField, type FormSchema, type FormValues, type OrganizationIdentity, type ServerOrganization,
} from "@platform/contracts";

const ids = (value: unknown): string[] => emptyFieldValue(value) ? [] : Array.isArray(value) ? value as string[] : [String(value)];
const validId = (value: unknown) => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const entries = (schema: FormSchema) => schema.fields.flatMap(field => [{ field, parent: undefined as FormField | undefined }, ...field.children.map(child => ({ field: child, parent: field }))]);

export function validateOrganizationRule(field: FormField) {
  if (!isOrganizationField(field.type)) return;
  const config = field.organization, scope = config?.scope;
  if (!scope || !["all", "custom", "currentDepartment", "fieldDepartment"].includes(scope.mode) || typeof scope.includeChildren !== "boolean" || typeof scope.fieldId !== "string") throw new BadRequestException(`「${field.label}」的组织选择范围不合法`);
  for (const list of [scope.departmentIds, scope.employeeIds, scope.roleIds, config.defaultIds]) {
    if (!Array.isArray(list) || list.length > 1000 || list.some(id => !validId(id)) || new Set(list).size !== list.length) throw new BadRequestException(`「${field.label}」包含无效或重复的组织身份，请选择服务端组织成员`);
  }
  if (!(isDepartmentField(field.type) ? ["none", "currentDepartment"] : ["none", "currentUser", "departmentManager"]).includes(config.defaultMode)) throw new BadRequestException(`「${field.label}」的默认方式不适用于此字段`);
  if (!isMultipleOrganization(field.type) && config.defaultIds.length > 1) throw new BadRequestException(`「${field.label}」只能配置一个默认值`);
  if (!emptyFieldValue(field.defaultValue)) throw new BadRequestException(`「${field.label}」请在组织字段规则中设置默认值`);
}

/** Publishing resolves dependencies against the complete model, never a single pending addition. */
export function validateOrganizationDefinition(schema: FormSchema, organization: ServerOrganization) {
  const all = entries(schema), dependencies = new Map<string, string>();
  for (const { field, parent } of all.filter(item => isOrganizationField(item.field.type))) {
    validateOrganizationRule(field);
    const { scope, defaultIds } = field.organization;
    if (scope.mode === "fieldDepartment") {
      const source = all.find(item => item.field.id === scope.fieldId && isDepartmentField(item.field.type) && (!item.parent || item.parent.id === parent?.id));
      if (!source || source.field.id === field.id) throw new BadRequestException(`「${field.label}」请选择主表或同一明细中的部门字段`);
      dependencies.set(field.id, source.field.id);
    }
    const has = (kind: "member" | "department" | "role", id: string) => kind === "member" ? organization.users.some(user => user.id === id && user.active) : (kind === "department" ? organization.spec.departments : organization.spec.roles).some(item => item.id === id && !item.archived);
    const references = [...(scope.mode === "custom" ? [...scope.departmentIds.map(id => ["department", id]), ...scope.employeeIds.map(id => ["member", id]), ...scope.roleIds.map(id => ["role", id])] : []), ...(field.organization.defaultMode === "none" ? defaultIds.map(id => [isDepartmentField(field.type) ? "department" : "member", id]) : [])];
    if (references.some(([kind, id]) => !has(kind as "member" | "department" | "role", id!))) throw new BadRequestException(`「${field.label}」引用的组织成员、部门或角色不存在或已停用`);
  }
  for (const id of dependencies.keys()) {
    const seen = new Set<string>(); let next: string | undefined = id;
    while (next) { if (seen.has(next)) throw new BadRequestException("组织字段的部门依赖不能形成循环"); seen.add(next); next = dependencies.get(next); }
  }
}

export function organizationCandidates(organization: ServerOrganization, actorId: string, field: FormField, values: FormValues): OrganizationIdentity[] {
  const { spec } = organization, scope = field.organization.scope;
  const own = spec.assignments.find(item => item.userId === actorId);
  const roots = scope.mode === "custom" ? scope.departmentIds : scope.mode === "currentDepartment" ? own?.departmentIds || [] : scope.mode === "fieldDepartment" ? ids(values[scope.fieldId]) : undefined;
  const departments = roots ? new Set(roots.flatMap(id => organizationDepartments(spec, id, scope.includeChildren))) : undefined;
  if (isDepartmentField(field.type)) return spec.departments.filter(item => !item.archived && (!departments || departments.has(item.id))).map(item => ({ id: item.id, name: item.name, active: true, kind: "department" }));
  const explicit = new Set(scope.mode === "custom" ? [...scope.employeeIds, ...scope.roleIds.flatMap(id => organizationSubjectMembers(spec, { kind: "role", id }))] : []);
  return organization.users.filter(user => user.active && (!departments || explicit.has(user.id) || spec.assignments.some(item => item.userId === user.id && item.departmentIds.some(id => departments.has(id))))).map(user => ({ id: user.id, name: user.name, active: true, kind: "member" }));
}

export function organizationDefault(organization: ServerOrganization, actorId: string, field: FormField, context: FormValues) {
  const config = field.organization, own = organization.spec.assignments.find(item => item.userId === actorId);
  const raw = config.defaultMode === "currentUser" ? [actorId] : config.defaultMode === "currentDepartment" ? own?.primaryDepartmentId ? [own.primaryDepartmentId] : [] : config.defaultMode === "departmentManager" ? organization.spec.departments.find(item => item.id === own?.primaryDepartmentId && !item.archived)?.managerIds || [] : config.defaultIds;
  const allowed = new Set(organizationCandidates(organization, actorId, field, context).map(item => item.id)), selected = raw.filter(id => allowed.has(id));
  return isMultipleOrganization(field.type) ? selected : selected[0] || "";
}

/** Defaults are resolved from the authenticated actor, including forward department dependencies. */
export function organizationDefaultResolver(schema: FormSchema, organization: ServerOrganization, actorId: string, input: FormValues, base: FormValues = {}) {
  const all = entries(schema);
  const resolve = (field: FormField, row?: FormValues, stack = new Set<string>()): any => {
    if (!isOrganizationField(field.type)) return field.defaultValue;
    if (stack.has(field.id)) throw new BadRequestException("组织字段的默认值依赖循环");
    stack = new Set(stack).add(field.id);
    const context: FormValues = { ...base, ...input, ...row }, dependency = field.organization.scope.fieldId;
    if (field.organization.scope.mode === "fieldDepartment" && context[dependency] == null) {
      const found = all.find(item => item.field.id === dependency);
      if (found) context[dependency] = resolve(found.field, found.parent ? row : undefined, stack);
    }
    return organizationDefault(organization, actorId, field, context);
  };
  return resolve;
}

/** Preserve unchanged historical identities; new selections and changed department dependencies are current. */
export function validateOrganizationValues(schema: FormSchema, values: FormValues, organization: ServerOrganization, actorId: string, before?: FormValues) {
  const check = (field: FormField, current: FormValues, previous?: FormValues) => {
    if (!isOrganizationField(field.type)) return;
    const dependency = field.organization.scope.mode === "fieldDepartment" ? field.organization.scope.fieldId : undefined;
    const contextChanged = !!dependency && !equalFieldValues(current[dependency], previous?.[dependency]);
    if (previous && !contextChanged && equalFieldValues(current[field.id], previous[field.id])) return;
    const retained = new Set(previous && !contextChanged ? ids(previous[field.id]) : []);
    const allowed = new Set(organizationCandidates(organization, actorId, field, current).map(item => item.id));
    if (ids(current[field.id]).some(id => !allowed.has(id) && !retained.has(id))) throw new BadRequestException(`「${field.label}」包含已停用或不在当前选择范围内的成员／部门，请重新选择`);
  };
  for (const field of schema.fields) {
    if (field.type !== "subform") check(field, values, before);
    else for (const row of (values[field.id] || []) as FormValues[]) {
      const old = (before?.[field.id] as FormValues[] | undefined)?.find(item => item._rowId === row._rowId);
      for (const child of field.children) check(child, { ...values, ...row }, old && { ...before, ...old });
    }
  }
}

export function organizationLabels(schema: FormSchema, values: FormValues, organization: ServerOrganization): OrganizationIdentity[] {
  const result = new Map<string, OrganizationIdentity>();
  const add = (field: FormField, value: unknown) => {
    if (!isOrganizationField(field.type)) return;
    const department = isDepartmentField(field.type);
    for (const id of ids(value)) {
      const found = department ? organization.spec.departments.find(item => item.id === id) : organization.users.find(item => item.id === id);
      result.set(`${department}:${id}`, { id, kind: department ? "department" : "member", name: found?.name || "已不可用身份", active: !!found && (department ? !(found as { archived: boolean }).archived : (found as { active: boolean }).active) });
    }
  };
  for (const field of schema.fields) {
    add(field, values[field.id]);
    if (field.type === "subform") for (const row of (values[field.id] || []) as FormValues[]) for (const child of field.children) add(child, row[child.id]);
  }
  return [...result.values()];
}
