import { ForbiddenException } from "@nestjs/common";
import {
  choiceConditionValue,
  organizationSubjectMembers,
  type AccessGrant,
  type DataFilter,
  type FieldPermission,
  type FormSchema,
  type FormValues,
  type RecordGroupAction,
  type RecordGroupConfiguration,
  type RecordPermissionGroup,
  type ServerOrganization,
} from "@platform/contracts";
import type { Actor } from "../../core/auth/auth.service";
import { permission } from "../../core/database/schema";

/** 权限组计算上下文：包含记录创建人、归属部门、记录值以及当前触发的操作类型 */
export interface GroupRecordContext {
  createdBy?: string;
  createdDepartmentIds?: string[] | null;
  values?: FormValues;
  operation?: "create" | "export" | "print";
}

// ============================================================================
// 1. 跨模式共用基础函数（供权限组模式与常规策略模式共同复用）
// ============================================================================

const PERMISSION_RANK: Record<FieldPermission, number> = { hidden: 0, read: 1, edit: 2 };

/** 获取指定成员所属的部门 ID 列表 */
export function userDepartmentIds(org: ServerOrganization, userId: string): string[] {
  return org.spec.assignments.find((item) => item.userId === userId)?.departmentIds || [];
}

/** 判断成员 / 角色 / 部门主体是否包含目标用户 */
export function subjectContainsUser(
  org: ServerOrganization,
  subject: { kind: "member" | "role" | "department"; id: string; includeChildren?: boolean },
  userId: string,
): boolean {
  if (subject.kind === "member") {
    return subject.id === userId;
  }
  return organizationSubjectMembers(org.spec, {
    kind: subject.kind,
    id: subject.id,
    includeChildren: subject.includeChildren,
  }).includes(userId);
}

/**
 * 将单条策略或单个权限组的字段权限、子表字段权限及关联表权限按最大权限（edit > read > hidden）合并到目标授权对象中
 */
export function mergeGrantPermissions(
  access: AccessGrant,
  schema: FormSchema,
  fields: Record<string, FieldPermission>,
  relations: Record<string, FieldPermission> | undefined,
  canWrite: boolean,
): void {
  const upgrade = (bag: Record<string, FieldPermission>, id: string, level: FieldPermission) => {
    if (PERMISSION_RANK[level] > PERMISSION_RANK[bag[id] || "hidden"]) {
      bag[id] = level;
    }
  };

  const grant = { ...access, fields };
  const applyField = (
    field: FormSchema["fields"][number],
    parent?: FormSchema["fields"][number],
  ) => {
    let level = permission(grant, field, parent) as FieldPermission;
    if (level === "edit" && !canWrite) level = "read";
    upgrade(access.fields, field.id, level);
  };

  for (const field of schema.fields) {
    applyField(field);
    for (const child of field.children) applyField(child, field);
  }

  for (const [id, level] of Object.entries(relations || {})) {
    upgrade(access.relations!, id, level === "edit" && !canWrite ? "read" : level);
  }
}

// ============================================================================
// 2. 权限组匹配与选择
// ============================================================================

/** 生成默认的权限组模式配置 */
export const directGroupConfiguration = (): RecordGroupConfiguration => ({
  revision: 0,
  mode: "groups",
  allowMerged: false,
  groups: [],
});

/** 筛选当前活跃用户在组织架构下命中的全部启用态权限组 */
export function eligibleRecordGroups(
  actor: Actor,
  org: ServerOrganization,
  config: RecordGroupConfiguration,
): RecordPermissionGroup[] {
  const isActiveMember = org.users.some((user) => user.id === actor.id && user.active);
  if (!isActiveMember) return [];

  return config.groups.filter(
    (group) =>
      group.enabled &&
      !group.archived &&
      group.subjects.some((subject) => subjectContainsUser(org, subject, actor.id)),
  );
}

/**
 * 解析当前请求在目标表单下实际生效的权限组集合：
 * - 支持显式指定单个权限组 ID，或在允许合并时传 `*` 合并全部可用权限组；
 * - 若未显式指定且用户仅命中唯一权限组，则自动选用该组；若有多个则要求前端先选择。
 */
export function selectRecordGroups(
  actor: Actor,
  definitionId: string,
  org: ServerOrganization,
  config: RecordGroupConfiguration,
): RecordPermissionGroup[] {
  const groups = eligibleRecordGroups(actor, org, config);
  const selected = actor.accessGroups?.[definitionId];

  if (!groups.length) {
    throw new ForbiddenException("没有此数据对象的权限组");
  }

  if (selected === "*") {
    if (!config.allowMerged && groups.length > 1) {
      throw new ForbiddenException("当前数据对象不允许合并权限组，请选择一个组");
    }
    return groups;
  }

  if (!selected) {
    if (groups.length === 1) return groups;
    throw new ForbiddenException("请先选择一个权限组；不会自动合并权限");
  }

  const group = groups.find((item) => item.id === selected);
  if (!group) {
    throw new ForbiddenException("所选权限组已不可用，请重新选择");
  }
  return [group];
}

// ============================================================================
// 3. 自定义数据范围过滤与单条记录匹配
// ============================================================================

/** 将单值或数组统一规整为非空字符串数组 */
const toStringIds = (value: unknown): string[] =>
  (Array.isArray(value) ? value : [value])
    .filter((v) => v !== null && v !== undefined && v !== "")
    .map(String);

/** 解析筛选条件右侧的期望对比值（常量 / 当前用户 ID / 当前用户主部门 ID） */
export function filterExpected(
  filter: DataFilter,
  actor: Actor,
  organization: ServerOrganization,
): string {
  if (filter.source === "currentUser") {
    return actor.id;
  }
  if (filter.source === "currentDepartment") {
    const assignment = organization.spec.assignments.find((a) => a.userId === actor.id);
    return assignment?.primaryDepartmentId || "";
  }
  return filter.value;
}

/** 在内存中判断记录字段值是否满足权限组配置的全部自定义筛选条件 */
export function matchesGroupFilters(
  filters: DataFilter[],
  values: FormValues,
  actor: Actor,
  organization: ServerOrganization,
): boolean {
  return filters.every((filter) => {
    const actual = choiceConditionValue(values[filter.sourceFieldId]);
    const expected = filterExpected(filter, actor, organization);
    const actualIds = toStringIds(actual);

    if (filter.operator === "notEmpty") return actualIds.length > 0;
    if (!expected && filter.source !== "constant") return false;
    if (filter.operator === "equals") return actualIds.includes(expected);
    if (filter.operator === "notEquals") return !actualIds.includes(expected);

    if (filter.operator === "contains") {
      return Array.isArray(actual)
        ? actualIds.includes(expected)
        : String(actual ?? "").includes(expected);
    }

    if (
      typeof actual !== "number" ||
      !Number.isFinite(actual) ||
      !Number.isFinite(Number(expected))
    ) {
      return false;
    }

    return filter.operator === "greater" ? actual > Number(expected) : actual < Number(expected);
  });
}

/** 判断单个权限组的数据范围（全部 / 本人 / 本部门 / 自定义条件）是否覆盖目标记录 */
export function groupMatches(
  group: RecordPermissionGroup,
  actor: Actor,
  org: ServerOrganization,
  record: GroupRecordContext,
): boolean {
  // 仅读取表单定义元数据时无具体记录创建人，直接放行（绝不用此结果授权真实记录）
  if (!record.createdBy) return true;
  if (group.scope === "all") return true;
  if (group.scope === "self") return record.createdBy === actor.id;

  if (group.scope === "department") {
    const ownDepts = userDepartmentIds(org, actor.id);
    return (record.createdDepartmentIds || []).some((id) => ownDepts.includes(id));
  }

  return Boolean(record.values) && matchesGroupFilters(group.filters, record.values!, actor, org);
}

// ============================================================================
// 4. 权限组模式下的字段权限合并与 SQL 过滤生成
// ============================================================================

/** 计算权限组模式下当前用户对指定表单或记录的最终访问授权 */
export function groupedRecordAccess(
  actor: Actor,
  definitionId: string,
  schema: FormSchema,
  org: ServerOrganization,
  config: RecordGroupConfiguration,
  target: GroupRecordContext,
): AccessGrant {
  const selected = selectRecordGroups(actor, definitionId, org, config);

  // 仅具备查看权限的组也可打开表单入口（字段掩码为只读）；
  // 草稿与新建提交仅使用包含 create 动作的权限组，避免把填报权限当作已提交记录的查看权限。
  let action: RecordGroupAction = "view";
  if (target.operation === "create" && selected.some((group) => group.actions.includes("create"))) {
    action = "create";
  } else if (target.operation === "export" || target.operation === "print") {
    action = target.operation;
  }

  const groups = selected.filter(
    (group) =>
      group.actions.includes(action) &&
      (action === "create" || groupMatches(group, actor, org, target)),
  );

  if (target.operation === "create" && target.createdBy && action !== "create") {
    throw new ForbiddenException("当前没有继续填写此草稿的权限");
  }
  if (!groups.length) {
    throw new ForbiddenException("所选权限组没有此记录或操作的权限");
  }

  const can = (act: RecordGroupAction) => groups.some((group) => group.actions.includes(act));

  const access: AccessGrant = {
    userId: actor.id,
    read: action === "create" ? selected.some((group) => group.actions.includes("view")) : true,
    create: action === "create",
    edit: action === "view" && target.operation !== "create" && can("edit"),
    remove: action === "view" && target.operation !== "create" && can("delete"),
    export: action !== "create" && can("export"),
    print: action !== "create" && can("print"),
    scope: "all",
    fields: {},
    relations: {},
    groupSelection: {
      definitionId,
      revision: config.revision,
      selection: actor.accessGroups?.[definitionId] || groups[0]!.id,
    },
  };

  for (const group of groups) {
    const canWrite =
      action === "create" ||
      (action === "view" && target.operation !== "create" && group.actions.includes("edit"));
    mergeGrantPermissions(access, schema, group.fields, group.relations, canWrite);
  }

  return access;
}

/**
 * 将生效权限组的数据范围编译为参数化 SQL WHERE 条件片段：
 * - 与内存端 `matchesGroupFilters` 保持一致的选项值解包与比较语义。
 */
export function groupRecordSql(
  groups: RecordPermissionGroup[],
  actor: Actor,
  org: ServerOrganization,
  alias: string,
  parameters: unknown[],
): string {
  if (!/^[a-z][a-z_]*$/.test(alias)) {
    throw new Error("Invalid record alias");
  }

  const bind = (value: unknown) => {
    parameters.push(value);
    return `$${parameters.length}`;
  };

  const filterSql = (filter: DataFilter) => {
    const expected = filterExpected(filter, actor, org);
    if (filter.operator !== "notEmpty" && filter.source !== "constant" && !expected) {
      return "false";
    }

    const field = `${alias}.values -> ${bind(filter.sourceFieldId)}::text`;
    const list = `CASE WHEN jsonb_typeof(${field})='array' THEN ${field} ELSE jsonb_build_array(${field}) END`;
    const textValue = (value: string) =>
      `CASE WHEN jsonb_typeof(${value})='object' THEN COALESCE(${value}->>'optionId',${value}->>'text') ELSE ${value} #>> '{}' END`;
    const elements = `(SELECT ${textValue("item.value")} AS value FROM jsonb_array_elements(${list}) item(value)) v`;
    const nonempty = `(v.value IS NOT NULL AND v.value<>'')`;

    if (filter.operator === "notEmpty") {
      return `EXISTS(SELECT 1 FROM ${elements} WHERE ${nonempty})`;
    }

    const value = bind(expected);
    const same = `EXISTS(SELECT 1 FROM ${elements} WHERE ${nonempty} AND v.value=${value}::text)`;
    if (filter.operator === "equals") return same;
    if (filter.operator === "notEquals") return `NOT (${same})`;

    if (filter.operator === "contains") {
      return `(CASE WHEN jsonb_typeof(${field})='array' THEN ${same} ELSE position(${value}::text in COALESCE((${textValue(field)}),''))>0 END)`;
    }

    const op = filter.operator === "greater" ? ">" : "<";
    return `(CASE WHEN jsonb_typeof(${field})='number' THEN (${field} #>> '{}')::numeric ${op} ${value}::numeric ELSE false END)`;
  };

  const clauses = groups
    .filter((group) => group.actions.includes("view"))
    .map((group) => {
      if (group.scope === "all") return "true";
      if (group.scope === "self") return `${alias}.created_by=${bind(actor.id)}::uuid`;
      if (group.scope === "department") {
        return `${alias}.created_department_ids && ${bind(userDepartmentIds(org, actor.id))}::uuid[]`;
      }
      return group.filters.length ? `(${group.filters.map(filterSql).join(" AND ")})` : "false";
    })
    .map((sql) => `(${sql})`);

  return clauses.join(" OR ") || "false";
}
