import { BadRequestException } from "@nestjs/common";
import {
  emptyFieldValue,
  equalFieldValues,
  isDepartmentField,
  isMultipleOrganization,
  isOrganizationField,
  organizationDepartments,
  organizationSubjectMembers,
  type FieldValidationIssue,
  type FormField,
  type FormSchema,
  type FormValues,
  type OrganizationIdentity,
  type ServerOrganization,
} from "@platform/contracts";
import type { Actor } from "../../core/auth/auth.service";
import type { Database } from "../../core/database/database";

type Queryable = Pick<Database, "query">;

// ============================================================================
// 1. 基础辅助函数
// ============================================================================

/** 将字段值标准化为组织身份 ID 数组 */
function ids(value: unknown): string[] {
  if (emptyFieldValue(value)) return [];
  return Array.isArray(value) ? (value as string[]) : [String(value)];
}

/** 校验是否为合法的 UUID 字符串 */
function validId(value: unknown): boolean {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

/** 展平表单中的全部字段（包含主表字段与子表明细字段及其所属父字段引用） */
function entries(schema: FormSchema): { field: FormField; parent: FormField | undefined }[] {
  return schema.fields.flatMap((field) => [
    { field, parent: undefined as FormField | undefined },
    ...field.children.map((child) => ({ field: child, parent: field })),
  ]);
}

// ============================================================================
// 2. 组织字段规则与定义校验
// ============================================================================

/** 校验单个组织字段（成员/部门）的基础属性配置是否合法 */
export function validateOrganizationRule(field: FormField) {
  if (!isOrganizationField(field.type)) return;

  const config = field.organization;
  const scope = config?.scope;
  if (
    !scope ||
    !["all", "custom", "currentDepartment", "fieldDepartment"].includes(scope.mode) ||
    typeof scope.includeChildren !== "boolean" ||
    typeof scope.fieldId !== "string"
  ) {
    throw new BadRequestException(`「${field.label}」的组织选择范围不合法`);
  }

  const idLists = [scope.departmentIds, scope.employeeIds, scope.roleIds, config.defaultIds];
  for (const list of idLists) {
    if (
      !Array.isArray(list) ||
      list.length > 1000 ||
      list.some((id) => !validId(id)) ||
      new Set(list).size !== list.length
    ) {
      throw new BadRequestException(
        `「${field.label}」包含无效或重复的组织身份，请选择服务端组织成员`,
      );
    }
  }

  const allowedDefaultModes = isDepartmentField(field.type)
    ? ["none", "currentDepartment"]
    : ["none", "currentUser", "departmentManager"];
  if (!allowedDefaultModes.includes(config.defaultMode)) {
    throw new BadRequestException(`「${field.label}」的默认方式不适用于此字段`);
  }

  if (!isMultipleOrganization(field.type) && config.defaultIds.length > 1) {
    throw new BadRequestException(`「${field.label}」只能配置一个默认值`);
  }

  if (!emptyFieldValue(field.defaultValue)) {
    throw new BadRequestException(`「${field.label}」请在组织字段规则中设置默认值`);
  }
}

/**
 * 发布表单时校验整张表单的组织字段定义：
 * - 校验字段联动依赖（如“按部门字段过滤”）是否存在且不跨其他子表；
 * - 校验静态引用的成员、部门、角色在当前组织中存在且有效；
 * - 检查部门字段之间的依赖是否构成循环。
 */
export function validateOrganizationDefinition(
  schema: FormSchema,
  organization: ServerOrganization,
) {
  const all = entries(schema);
  const dependencies = new Map<string, string>();

  const hasEntity = (kind: "member" | "department" | "role", id: string): boolean => {
    if (kind === "member") {
      return organization.users.some((user) => user.id === id && user.active);
    }
    const list =
      kind === "department" ? organization.spec.departments : organization.spec.roles;
    return list.some((item) => item.id === id && !item.archived);
  };

  for (const { field, parent } of all.filter((item) => isOrganizationField(item.field.type))) {
    validateOrganizationRule(field);
    const { scope, defaultIds } = field.organization;

    if (scope.mode === "fieldDepartment") {
      const source = all.find(
        (item) =>
          item.field.id === scope.fieldId &&
          isDepartmentField(item.field.type) &&
          (!item.parent || item.parent.id === parent?.id),
      );
      if (!source || source.field.id === field.id) {
        throw new BadRequestException(`「${field.label}」请选择主表或同一明细中的部门字段`);
      }
      dependencies.set(field.id, source.field.id);
    }

    const customRefs: [string, string][] =
      scope.mode === "custom"
        ? [
            ...scope.departmentIds.map((id): [string, string] => ["department", id]),
            ...scope.employeeIds.map((id): [string, string] => ["member", id]),
            ...scope.roleIds.map((id): [string, string] => ["role", id]),
          ]
        : [];
    const defaultKind = isDepartmentField(field.type) ? "department" : "member";
    const defaultRefs: [string, string][] =
      field.organization.defaultMode === "none"
        ? defaultIds.map((id): [string, string] => [defaultKind, id])
        : [];

    const references = [...customRefs, ...defaultRefs];
    if (references.some(([kind, id]) => !hasEntity(kind as "member" | "department" | "role", id))) {
      throw new BadRequestException(`「${field.label}」引用的组织成员、部门或角色不存在或已停用`);
    }
  }

  for (const id of dependencies.keys()) {
    const seen = new Set<string>();
    let next: string | undefined = id;
    while (next) {
      if (seen.has(next)) {
        throw new BadRequestException("组织字段的部门依赖不能形成循环");
      }
      seen.add(next);
      next = dependencies.get(next);
    }
  }
}

// ============================================================================
// 3. 候选范围计算、默认值解析与记录值校验
// ============================================================================

/** 计算指定组织字段在当前上下文下的可选成员或可选部门候选列表 */
export function organizationCandidates(
  organization: ServerOrganization,
  actorId: string,
  field: FormField,
  values: FormValues,
): OrganizationIdentity[] {
  const { spec } = organization;
  const scope = field.organization.scope;
  const own = spec.assignments.find((item) => item.userId === actorId);

  let roots: string[] | undefined;
  if (scope.mode === "custom") {
    roots = scope.departmentIds;
  } else if (scope.mode === "currentDepartment") {
    roots = own?.departmentIds || [];
  } else if (scope.mode === "fieldDepartment") {
    roots = ids(values[scope.fieldId]);
  }

  const departments = roots
    ? new Set(roots.flatMap((id) => organizationDepartments(spec, id, scope.includeChildren)))
    : undefined;

  if (isDepartmentField(field.type)) {
    return spec.departments
      .filter((item) => !item.archived && (!departments || departments.has(item.id)))
      .map((item) => ({ id: item.id, name: item.name, active: true, kind: "department" }));
  }

  const explicit = new Set(
    scope.mode === "custom"
      ? [
          ...scope.employeeIds,
          ...scope.roleIds.flatMap((id) => organizationSubjectMembers(spec, { kind: "role", id })),
        ]
      : [],
  );

  return organization.users
    .filter(
      (user) =>
        user.active &&
        (!departments ||
          explicit.has(user.id) ||
          spec.assignments.some(
            (item) =>
              item.userId === user.id && item.departmentIds.some((id) => departments.has(id)),
          )),
    )
    .map((user) => ({ id: user.id, name: user.name, active: true, kind: "member" }));
}

/** 计算单个组织字段的默认值（仅保留在当前可选范围内的身份 ID） */
export function organizationDefault(
  organization: ServerOrganization,
  actorId: string,
  field: FormField,
  context: FormValues,
) {
  const config = field.organization;
  const own = organization.spec.assignments.find((item) => item.userId === actorId);

  let raw: string[];
  if (config.defaultMode === "currentUser") {
    raw = [actorId];
  } else if (config.defaultMode === "currentDepartment") {
    raw = own?.primaryDepartmentId ? [own.primaryDepartmentId] : [];
  } else if (config.defaultMode === "departmentManager") {
    const primaryDept = organization.spec.departments.find(
      (item) => item.id === own?.primaryDepartmentId && !item.archived,
    );
    raw = primaryDept?.managerIds || [];
  } else {
    raw = config.defaultIds;
  }

  const allowed = new Set(
    organizationCandidates(organization, actorId, field, context).map((item) => item.id),
  );
  const selected = raw.filter((id) => allowed.has(id));

  return isMultipleOrganization(field.type) ? selected : selected[0] || "";
}

/**
 * 构造表单组织字段默认值解析器：
 * 支持基于当前登录用户动态计算默认值，并自动递归解析前置依赖的部门字段默认值。
 */
export function organizationDefaultResolver(
  schema: FormSchema,
  organization: ServerOrganization,
  actorId: string,
  input: FormValues,
  base: FormValues = {},
) {
  const all = entries(schema);

  const resolve = (field: FormField, row?: FormValues, stack = new Set<string>()): any => {
    if (!isOrganizationField(field.type)) return field.defaultValue;
    if (stack.has(field.id)) {
      throw new BadRequestException("组织字段的默认值依赖循环");
    }

    const nextStack = new Set(stack).add(field.id);
    const context: FormValues = { ...base, ...input, ...row };
    const dependency = field.organization.scope.fieldId;

    if (field.organization.scope.mode === "fieldDepartment" && context[dependency] == null) {
      const found = all.find((item) => item.field.id === dependency);
      if (found) {
        context[dependency] = resolve(found.field, found.parent ? row : undefined, nextStack);
      }
    }

    return organizationDefault(organization, actorId, field, context);
  };

  return resolve;
}

/**
 * 校验提交的组织字段值是否合法：
 * - 若字段值及所依赖的部门字段均未修改，保留已有的历史身份（即使已停用）；
 * - 若新增了选择或所依赖的部门字段发生了变化，则所选身份必须在当前有效候选范围内。
 */
export function validateOrganizationValues(
  schema: FormSchema,
  values: FormValues,
  organization: ServerOrganization,
  actorId: string,
  before?: FormValues,
  visibleFieldIds?: ReadonlySet<string>,
) {
  const issues: FieldValidationIssue[] = [];
  const check = (
    field: FormField,
    current: FormValues,
    previous?: FormValues,
    location: Omit<FieldValidationIssue, "fieldId" | "message"> = {},
  ) => {
    if (!isOrganizationField(field.type)) return;

    const dependency =
      field.organization.scope.mode === "fieldDepartment"
        ? field.organization.scope.fieldId
        : undefined;
    const contextChanged =
      !!dependency && !equalFieldValues(current[dependency], previous?.[dependency]);

    if (previous && !contextChanged && equalFieldValues(current[field.id], previous[field.id])) {
      return;
    }

    const retained = new Set(previous && !contextChanged ? ids(previous[field.id]) : []);
    const allowed = new Set(
      organizationCandidates(organization, actorId, field, current).map((item) => item.id),
    );

    if (ids(current[field.id]).some((id) => !allowed.has(id) && !retained.has(id))) {
      const message = `「${field.label}」包含已停用或不在当前选择范围内的成员／部门，请重新选择`;
      if (!visibleFieldIds) throw new BadRequestException(message);
      if (!visibleFieldIds.has(field.id)) {
        throw new BadRequestException("组织字段不符合当前选择范围，请联系表单管理员");
      }
      issues.push({ fieldId: field.id, ...location, message });
    }
  };

  for (const field of schema.fields) {
    if (field.type !== "subform") {
      check(field, values, before);
    } else {
      const rows = (values[field.id] || []) as FormValues[];
      const oldRows = before?.[field.id] as FormValues[] | undefined;
      for (const [rowIndex, row] of rows.entries()) {
        const old = oldRows?.find((item) => item._rowId === row._rowId);
        for (const child of field.children) {
          check(child, { ...values, ...row }, old && { ...before, ...old }, {
            subformId: field.id,
            rowId: row._rowId as string,
            rowIndex,
          });
        }
      }
    }
  }
  if (issues.length) {
    throw new BadRequestException({ message: issues[0]!.message, issues });
  }
}

/** 提取记录值中所有组织字段引用的成员与部门展示标签 */
export function organizationLabels(
  schema: FormSchema,
  values: FormValues,
  organization: ServerOrganization,
): OrganizationIdentity[] {
  const result = new Map<string, OrganizationIdentity>();

  const add = (field: FormField, value: unknown) => {
    if (!isOrganizationField(field.type)) return;
    const isDept = isDepartmentField(field.type);

    for (const id of ids(value)) {
      const found = isDept
        ? organization.spec.departments.find((item) => item.id === id)
        : organization.users.find((item) => item.id === id);

      const isActive =
        !!found &&
        (isDept
          ? !(found as { archived: boolean }).archived
          : (found as { active: boolean }).active);

      result.set(`${isDept}:${id}`, {
        id,
        kind: isDept ? "department" : "member",
        name: found?.name || "已不可用身份",
        active: isActive,
      });
    }
  };

  for (const field of schema.fields) {
    add(field, values[field.id]);
    if (field.type === "subform") {
      const rows = (values[field.id] || []) as FormValues[];
      for (const row of rows) {
        for (const child of field.children) {
          add(child, row[child.id]);
        }
      }
    }
  }

  return [...result.values()];
}

/** 补充已停用或历史身份的展示名称 */
export async function historicalLabels(
  tx: Queryable,
  actor: Actor,
  labels: OrganizationIdentity[],
): Promise<OrganizationIdentity[]> {
  const ids = labels.filter((item) => !item.active).map((item) => item.id);
  if (!ids.length) return labels;

  const sql = `
    SELECT id, kind, name
    FROM historical_identities
    WHERE workspace_id = $1
      AND id::text = ANY($2::text[])
  `;
  const { rows } = await tx.query(sql, [actor.workspaceId, ids]);

  return labels.map((item) => {
    const found = rows.find((row) => row.id === item.id && row.kind === item.kind);
    if (!found) return item;
    return { ...item, name: found.name, active: false, historical: true };
  });
}

/** 解析记录创建人身份标签 */
export async function recordCreator(
  tx: Queryable,
  actor: Actor,
  id: string,
): Promise<OrganizationIdentity> {
  const sql = `
    SELECT
      p.id,
      u.name,
      u.active,
      h.name AS historical_name
    FROM record_principals p
    LEFT JOIN users u
      ON u.id = p.user_id AND u.workspace_id = p.workspace_id
    LEFT JOIN historical_identities h
      ON h.id = p.historical_id AND h.workspace_id = p.workspace_id
    WHERE p.id = $1
      AND p.workspace_id = $2
  `;
  const { rows } = await tx.query(sql, [id, actor.workspaceId]);
  const row = rows[0];

  return {
    id,
    kind: "member",
    name: row?.historical_name || row?.name || "已不可用身份",
    active: !!row?.active,
    ...(row?.historical_name ? { historical: true } : {}),
  };
}

