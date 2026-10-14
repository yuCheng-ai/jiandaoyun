import { ForbiddenException, Injectable } from "@nestjs/common";
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
import { Database } from "../../core/database/database";
import { allFields, permission } from "../../core/database/schema";
import { OrganizationService } from "../directory/organization.service";

/**
 * ============================================================================
 * 【一分钟看懂本文件：表单与记录权限服务（简道云“权限组”模式）】
 *
 * 所有表单统一通过 `record_permission_groups` 表中的“权限组”控制访问权限；
 * 当用户同时命中多个权限组时，默认自动合并所有命中权限组（取最大权限并集）。
 *
 * 文件结构：
 * - 第一部分：权限组匹配、数据范围过滤与 SQL 条件生成（纯函数）
 * - 第二部分：`AccessService` 对外提供的 5 个核心查询方法
 * ============================================================================
 */

type Queryable = Pick<Database, "query">;

/** 单条记录权限计算上下文 */
export interface GroupRecordContext {
  createdBy?: string;
  createdDepartmentIds?: string[] | null;
  values?: FormValues;
  operation?: "create" | "export" | "print";
}

export interface AccessContext extends GroupRecordContext {}

/** 权限计算上下文：包含组织架构、目标表单 ID 与权限组配置 */
export interface PolicyContext {
  organization: ServerOrganization;
  definitionId: string;
  config: RecordGroupConfiguration;
}

/** 记录列表的可见范围（用于生成 SQL 过滤条件） */
export interface ReadScope {
  creators: string[] | null;
  createdDepartments: string[];
  sql?: (alias: string, parameters: unknown[]) => string;
}

// ============================================================================
// 1. 权限组匹配、数据范围过滤与字段权限合并（纯函数）
// ============================================================================

const PERMISSION_RANK: Record<FieldPermission, number> = { hidden: 0, read: 1, edit: 2 };

/** 生成默认的空权限组配置（默认允许自动合并多个权限组） */
export const directGroupConfiguration = (): RecordGroupConfiguration => ({
  revision: 0,
  mode: "groups",
  allowMerged: true,
  groups: [],
});

/** 获取指定成员所属的部门 ID 列表 */
function userDepartmentIds(org: ServerOrganization, userId: string): string[] {
  return org.spec.assignments.find((item) => item.userId === userId)?.departmentIds || [];
}

/** 筛选当前在职用户在组织架构下命中的全部启用态权限组 */
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
      group.subjects.some((subject) => {
        if (subject.kind === "member") return subject.id === actor.id;
        return organizationSubjectMembers(org.spec, {
          kind: subject.kind,
          id: subject.id,
          includeChildren: subject.includeChildren,
        }).includes(actor.id);
      }),
  );
}

/**
 * 解析当前请求在目标表单下生效的权限组集合：
 * - 默认自动合并用户命中的全部权限组（取最大权限并集）；
 * - 若前端显式指定了某个具体权限组 ID，则仅使用该组。
 */
export function selectRecordGroups(
  actor: Actor,
  definitionId: string,
  org: ServerOrganization,
  config: RecordGroupConfiguration,
): RecordPermissionGroup[] {
  const groups = eligibleRecordGroups(actor, org, config);
  if (!groups.length) {
    throw new ForbiddenException("没有此数据对象的权限组");
  }

  const selected = actor.accessGroups?.[definitionId];
  if (!selected || selected === "*") {
    return groups;
  }

  const group = groups.find((item) => item.id === selected);
  if (!group) {
    throw new ForbiddenException("所选权限组已不可用，请重新选择");
  }
  return [group];
}

/** 解析自定义筛选条件右侧的对比值（固定常量 / 当前用户 ID / 当前用户主部门 ID） */
export function filterExpected(
  filter: DataFilter,
  actor: Actor,
  organization: ServerOrganization,
): string {
  if (filter.source === "currentUser") return actor.id;
  if (filter.source === "currentDepartment") {
    const assignment = organization.spec.assignments.find((a) => a.userId === actor.id);
    return assignment?.primaryDepartmentId || "";
  }
  return filter.value;
}

/** 在内存中判断记录字段值是否满足权限组的自定义筛选条件 */
export function matchesGroupFilters(
  filters: DataFilter[],
  values: FormValues,
  actor: Actor,
  organization: ServerOrganization,
): boolean {
  return filters.every((filter) => {
    const actual = choiceConditionValue(values[filter.sourceFieldId]);
    const expected = filterExpected(filter, actor, organization);
    const items = Array.isArray(actual) ? actual : [actual];

    // 结构字段只判断是否有内容，不能把地址、附件等对象当选项或字符串比较。
    if (filter.operator === "notEmpty") {
      return items.some((value) => {
        if (value === null || value === undefined || value === "") return false;
        if (typeof value === "object") return Object.keys(value).length > 0;
        return true;
      });
    }
    if (items.some((value) => value !== null && typeof value === "object")) {
      return false;
    }
    const actualIds = items
      .filter((value) => value !== null && value !== undefined && value !== "")
      .map(String);

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
  if (!record.createdBy) return true; // 仅打开表单外壳（尚未指定具体记录）时先放行
  if (group.scope === "all") return true;
  if (group.scope === "self") return record.createdBy === actor.id;
  if (group.scope === "department") {
    const ownDepts = userDepartmentIds(org, actor.id);
    return (record.createdDepartmentIds || []).some((id) => ownDepts.includes(id));
  }
  return Boolean(record.values) && matchesGroupFilters(group.filters, record.values!, actor, org);
}

/**
 * 计算单条记录或单个表单的最终权限（按钮权限 + 每个字段是 edit / read / hidden）：
 * - 系统管理员直接拥有全部权限；
 * - 普通成员合并其命中的权限组，字段权限按 `edit > read > hidden` 取最大并集。
 */
export function effectiveAccess(
  actor: Actor,
  schema: FormSchema,
  context: PolicyContext,
  target: AccessContext = {},
): AccessGrant {
  // 1. 管理员拥有全部权限
  if (actor.role === "admin") {
    const fields = Object.fromEntries(allFields(schema).map((f) => [f.id, "edit" as const]));
    return {
      userId: actor.id,
      read: true,
      create: true,
      edit: true,
      remove: true,
      export: true,
      print: true,
      scope: "all",
      fields,
    };
  }

  // 2. 筛选出当前用户对本次操作生效的权限组
  const selected = selectRecordGroups(
    actor,
    context.definitionId,
    context.organization,
    context.config,
  );

  let action: RecordGroupAction = "view";
  if (target.operation === "create" && selected.some((group) => group.actions.includes("create"))) {
    action = "create";
  } else if (target.operation === "export" || target.operation === "print") {
    action = target.operation;
  }

  const groups = selected.filter(
    (group) =>
      group.actions.includes(action) &&
      (action === "create" || groupMatches(group, actor, context.organization, target)),
  );

  if (target.operation === "create" && target.createdBy && action !== "create") {
    throw new ForbiddenException("当前没有继续填写此草稿的权限");
  }
  if (!groups.length) {
    throw new ForbiddenException("所选权限组没有此记录或操作的权限");
  }

  // 3. 汇总表级按钮权限与字段级读写掩码（取最大权限并集）
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
      definitionId: context.definitionId,
      revision: context.config.revision,
      selection: actor.accessGroups?.[context.definitionId] || groups[0]!.id,
    },
  };

  const upgrade = (bag: Record<string, FieldPermission>, id: string, level: FieldPermission) => {
    if (PERMISSION_RANK[level] > PERMISSION_RANK[bag[id] || "hidden"]) {
      bag[id] = level;
    }
  };

  for (const group of groups) {
    const canWrite =
      action === "create" ||
      (action === "view" && target.operation !== "create" && group.actions.includes("edit"));
    const grant = { ...access, fields: group.fields };

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

    for (const [id, level] of Object.entries(group.relations || {})) {
      upgrade(access.relations!, id, level === "edit" && !canWrite ? "read" : level);
    }
  }

  return access;
}

/** 将生效权限组的数据范围编译为数据库 SQL WHERE 条件片段 */
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

    // 与 choiceConditionValue 的选项对象识别一致，其他 JSON 对象保留原形。
    const normalized = `CASE WHEN jsonb_typeof(item.value)='object' THEN
      CASE WHEN jsonb_typeof(item.value->'text')='string'
        AND length(item.value->>'text') <= 10000
        AND (item.value - 'text' - 'optionId')='{}'::jsonb
        AND (NOT (item.value ? 'optionId') OR (
          jsonb_typeof(item.value->'optionId')='string'
          AND length(item.value->>'optionId') BETWEEN 1 AND 100
        ))
      THEN COALESCE(item.value->'optionId',item.value->'text')
      ELSE item.value END
      ELSE item.value END`;
    const elements = `(SELECT ${normalized} AS value FROM jsonb_array_elements(${list}) item(value)) v`;
    const nonempty = `(v.value IS NOT NULL AND v.value NOT IN ('null'::jsonb,'""'::jsonb,'[]'::jsonb,'{}'::jsonb))`;

    if (filter.operator === "notEmpty") {
      return `EXISTS(SELECT 1 FROM ${elements} WHERE ${nonempty})`;
    }

    // 旧配置即便曾允许对象比较，也不能靠“不等于”将不支持的值放行。
    const comparable = `NOT EXISTS(SELECT 1 FROM ${elements} WHERE jsonb_typeof(v.value) IN ('object','array'))`;
    const value = bind(expected);
    const same = `EXISTS(SELECT 1 FROM ${elements} WHERE ${nonempty} AND v.value #>> '{}'=${value}::text)`;
    if (filter.operator === "equals") return `(${comparable} AND ${same})`;
    if (filter.operator === "notEquals") return `(${comparable} AND NOT (${same}))`;

    if (filter.operator === "contains") {
      const contains = `EXISTS(SELECT 1 FROM ${elements} WHERE position(${value}::text in COALESCE(v.value #>> '{}',''))>0)`;
      return `(${comparable} AND CASE WHEN jsonb_typeof(${field})='array' THEN ${same} ELSE ${contains} END)`;
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

// ============================================================================
// 2. 权限服务类（对外提供 5 个核心方法）
// ============================================================================

@Injectable()
export class AccessService {
  constructor(
    private readonly db: Database,
    private readonly organizations: OrganizationService,
  ) {}

  /** 方法 1：加载指定表单的组织架构与权限组配置 */
  async context(tx: Queryable, actor: Actor, definitionId: string): Promise<PolicyContext> {
    const organization = await this.organizations.snapshot(tx, actor);
    if (actor.role === "admin") {
      return { organization, definitionId, config: directGroupConfiguration() };
    }

    const { rows } = await tx.query(
      "SELECT config, revision FROM record_permission_groups WHERE definition_id = $1",
      [definitionId],
    );
    const row = rows[0];
    const config = row
      ? { ...row.config, mode: "groups" as const, allowMerged: true, revision: row.revision }
      : directGroupConfiguration();

    return { organization, definitionId, config };
  }

  /** 方法 2：计算用户在指定表单或单条记录上的最终操作权限与字段掩码 */
  async effective(
    tx: Queryable,
    actor: Actor,
    definitionId: string,
    schema: FormSchema,
    target?: AccessContext,
  ): Promise<AccessGrant> {
    const ctx = await this.context(tx, actor, definitionId);
    return effectiveAccess(actor, schema, ctx, target);
  }

  /** 方法 3：计算“正式记录列表”的可见范围（生成权限组对应的 SQL WHERE 条件） */
  async readers(
    tx: Queryable,
    actor: Actor,
    definitionId: string,
    policyContext?: PolicyContext,
  ): Promise<ReadScope> {
    const ctx = policyContext ?? (await this.context(tx, actor, definitionId));
    if (actor.role === "admin") {
      return { creators: null, createdDepartments: [] };
    }

    const groups = selectRecordGroups(actor, definitionId, ctx.organization, ctx.config);
    if (!groups.some((g) => g.actions.includes("view"))) {
      throw new ForbiddenException("当前权限组不能查看正式记录");
    }

    return {
      creators: null,
      createdDepartments: [],
      sql: (alias, params) => groupRecordSql(groups, actor, ctx.organization, alias, params),
    };
  }

  /** 方法 4：计算“草稿箱列表”的可见范围（有填报权限即可查看本人保存的草稿） */
  async draftReaders(
    tx: Queryable,
    actor: Actor,
    definitionId: string,
    policyContext?: PolicyContext,
  ): Promise<ReadScope> {
    const ctx = policyContext ?? (await this.context(tx, actor, definitionId));
    if (actor.role === "admin") {
      return { creators: null, createdDepartments: [] };
    }

    const groups = selectRecordGroups(actor, definitionId, ctx.organization, ctx.config);
    if (!groups.some((g) => g.actions.includes("create"))) {
      throw new ForbiddenException("当前权限组没有填写草稿的权限");
    }

    return { creators: [actor.id], createdDepartments: [] };
  }

  /** 方法 5：获取当前用户在工作空间下有权看到的全部表单 ID（用于应用首页左侧表单树） */
  async definitions(tx: Queryable, actor: Actor): Promise<string[] | null> {
    const organization = await this.organizations.snapshot(tx, actor);
    if (actor.role === "admin") return null;

    const sql = `
      SELECT g.definition_id, g.config, g.revision
      FROM record_permission_groups g
      JOIN definitions d ON d.id = g.definition_id
      WHERE d.workspace_id = $1
    `;
    const { rows } = await tx.query(sql, [actor.workspaceId]);

    return rows
      .filter(
        (r) =>
          eligibleRecordGroups(actor, organization, {
            ...r.config,
            mode: "groups",
            allowMerged: true,
            revision: r.revision,
          }).length > 0,
      )
      .map((r) => r.definition_id);
  }
}





