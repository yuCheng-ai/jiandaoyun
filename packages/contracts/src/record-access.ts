import { choiceConditionValue } from "./field-runtime";
import { organizationSubjectMembers, type OrganizationSpec } from "./organization";
import type { FormSchema, FormValues, DataFilter } from "./form";
import type { AccessGrant, FieldPermission, SessionUser } from "./index";
import type {
  RecordGroupAction,
  RecordGroupConfiguration,
  RecordPermissionGroup,
} from "./grouped-access";

/** 权限计算只消费已认证的稳定身份，不读取 Cookie、请求头或数据库。 */
export type RecordAccessActor = Pick<SessionUser, "id" | "role">;

export interface RecordAccessOrganization {
  spec: OrganizationSpec;
  users: readonly { id: string; active: boolean }[];
}

/** 记录事实由调用方提供；未提供 createdBy 时只计算表单入口权限。 */
export interface RecordAccessContext {
  createdBy?: string;
  createdDepartmentIds?: string[] | null;
  values?: FormValues;
  operation?: "create" | "export" | "print";
}

export interface RecordAccessPolicy {
  organization: RecordAccessOrganization;
  definitionId: string;
  config: Pick<RecordGroupConfiguration, "revision" | "groups">;
  selection?: string;
}

/** 纯规则用领域错误拒绝访问，由服务端入口转换为 HTTP 403。 */
export class RecordAccessDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecordAccessDeniedError";
  }
}

const PERMISSION_RANK: Record<FieldPermission, number> = { hidden: 0, read: 1, edit: 2 };

/** 尚未配置权限时，普通成员默认没有访问权。 */
export const emptyRecordGroupConfiguration = (): RecordGroupConfiguration => ({
  revision: 0,
  mode: "groups",
  allowMerged: true,
  groups: [],
});

/** 字段和父容器取权限交集；无读取或新建权时一律隐藏。 */
export function fieldPermission(
  grant: Pick<AccessGrant, "read" | "create" | "fields">,
  field: { id: string },
  parent?: { id: string },
): FieldPermission {
  const own = grant.fields[field.id] || "hidden";
  const outer = parent ? grant.fields[parent.id] || "hidden" : "edit";
  if ((!grant.read && !grant.create) || own === "hidden" || outer === "hidden") {
    return "hidden";
  }
  return own === "edit" && outer === "edit" ? "edit" : "read";
}

/** 获取指定成员所属的部门 ID 列表 */
export function recordDepartmentIds(org: RecordAccessOrganization, userId: string): string[] {
  return org.spec.assignments.find((item) => item.userId === userId)?.departmentIds || [];
}

/** 筛选当前在职用户在组织架构下命中的全部启用态权限组 */
export function eligibleRecordGroups(
  actor: RecordAccessActor,
  org: RecordAccessOrganization,
  config: Pick<RecordGroupConfiguration, "groups">,
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
  actor: RecordAccessActor,
  org: RecordAccessOrganization,
  config: Pick<RecordGroupConfiguration, "groups">,
  selection?: string,
): RecordPermissionGroup[] {
  const groups = eligibleRecordGroups(actor, org, config);
  if (!groups.length) {
    throw new RecordAccessDeniedError("没有此数据对象的权限组");
  }

  const selected = selection;
  if (!selected || selected === "*") {
    return groups;
  }

  const group = groups.find((item) => item.id === selected);
  if (!group) {
    throw new RecordAccessDeniedError("所选权限组已不可用，请重新选择");
  }
  return [group];
}

/** 解析自定义筛选条件右侧的对比值（固定常量 / 当前用户 ID / 当前用户主部门 ID） */
export function filterExpected(
  filter: DataFilter,
  actor: RecordAccessActor,
  organization: RecordAccessOrganization,
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
  actor: RecordAccessActor,
  organization: RecordAccessOrganization,
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
  actor: RecordAccessActor,
  org: RecordAccessOrganization,
  record: RecordAccessContext,
): boolean {
  if (!record.createdBy) return true; // 仅打开表单外壳（尚未指定具体记录）时先放行
  if (group.scope === "all") return true;
  if (group.scope === "self") return record.createdBy === actor.id;
  if (group.scope === "department") {
    const ownDepts = recordDepartmentIds(org, actor.id);
    return (record.createdDepartmentIds || []).some((id) => ownDepts.includes(id));
  }
  return Boolean(record.values) && matchesGroupFilters(group.filters, record.values!, actor, org);
}

/**
 * 计算单条记录或单个表单的最终权限（按钮权限 + 每个字段是 edit / read / hidden）：
 * - 系统管理员直接拥有全部权限；
 * - 普通成员合并其命中的权限组，字段权限按 `edit > read > hidden` 取最大并集。
 */
export function effectiveRecordAccess(
  actor: RecordAccessActor,
  schema: FormSchema,
  context: RecordAccessPolicy,
  target: RecordAccessContext = {},
): AccessGrant {
  // 1. 管理员拥有全部权限
  if (actor.role === "admin") {
    const allFields = schema.fields.flatMap((field) => [field, ...field.children]);
    const fields = Object.fromEntries(allFields.map((field) => [field.id, "edit" as const]));
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
    context.organization,
    context.config,
    context.selection,
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
    throw new RecordAccessDeniedError("当前没有继续填写此草稿的权限");
  }
  if (!groups.length) {
    throw new RecordAccessDeniedError("所选权限组没有此记录或操作的权限");
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
      selection: context.selection || groups[0]!.id,
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
      let level = fieldPermission(grant, field, parent);
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

