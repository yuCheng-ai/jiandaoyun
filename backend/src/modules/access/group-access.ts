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

export const directGroupConfiguration = (): RecordGroupConfiguration => ({
  revision: 0,
  mode: "direct",
  allowMerged: false,
  groups: [],
});
export function eligibleRecordGroups(
  actor: Actor,
  org: ServerOrganization,
  config: RecordGroupConfiguration,
) {
  if (!org.users.some((user) => user.id === actor.id && user.active)) return [];
  return config.groups.filter(
    (group) =>
      group.enabled &&
      !group.archived &&
      group.subjects.some((subject) =>
        subject.kind === "member"
          ? subject.id === actor.id
          : organizationSubjectMembers(
              org.spec,
              subject as {
                kind: "department" | "role";
                id: string;
                includeChildren?: boolean;
              },
            ).includes(actor.id),
      ),
  );
}
export function selectRecordGroups(
  actor: Actor,
  definitionId: string,
  org: ServerOrganization,
  config: RecordGroupConfiguration,
) {
  const groups = eligibleRecordGroups(actor, org, config),
    selected = actor.accessGroups?.[definitionId];
  if (!groups.length) throw new ForbiddenException("没有此数据对象的权限组");
  if (selected === "*") {
    if (!config.allowMerged && groups.length > 1)
      throw new ForbiddenException(
        "当前数据对象不允许合并权限组，请选择一个组",
      );
    return groups;
  }
  if (!selected) {
    if (groups.length === 1) return groups;
    throw new ForbiddenException("请先选择一个权限组；不会自动合并权限");
  }
  const group = groups.find((group) => group.id === selected);
  if (!group) throw new ForbiddenException("所选权限组已不可用，请重新选择");
  return [group];
}
const ids = (value: unknown): string[] =>
  (Array.isArray(value) ? value : [value])
    .filter((v) => v !== null && v !== undefined && v !== "")
    .map(String);
export function filterExpected(
  filter: DataFilter,
  actor: Actor,
  organization: ServerOrganization,
) {
  return filter.source === "currentUser"
    ? actor.id
    : filter.source === "currentDepartment"
      ? organization.spec.assignments.find((a) => a.userId === actor.id)
          ?.primaryDepartmentId || ""
      : filter.value;
}
export function matchesGroupFilters(
  filters: DataFilter[],
  values: FormValues,
  actor: Actor,
  organization: ServerOrganization,
) {
  return filters.every((filter) => {
    const actual = choiceConditionValue(values[filter.sourceFieldId]),
      expected = filterExpected(filter, actor, organization),
      a = ids(actual);
    if (filter.operator === "notEmpty") return !!a.length;
    if (!expected && filter.source !== "constant") return false;
    if (filter.operator === "equals") return a.includes(expected);
    if (filter.operator === "notEquals") return !a.includes(expected);
    if (filter.operator === "contains")
      return Array.isArray(actual)
        ? a.includes(expected)
        : String(actual ?? "").includes(expected);
    if (
      typeof actual !== "number" ||
      !Number.isFinite(actual) ||
      !Number.isFinite(Number(expected))
    )
      return false;
    return filter.operator === "greater"
      ? actual > Number(expected)
      : actual < Number(expected);
  });
}
export interface GroupRecordContext {
  createdBy?: string;
  createdDepartmentIds?: string[] | null;
  values?: FormValues;
  operation?: "create" | "export" | "print";
}
export function groupMatches(
  group: RecordPermissionGroup,
  actor: Actor,
  org: ServerOrganization,
  record: GroupRecordContext,
) {
  if (!record.createdBy) return true; // Definition metadata only; never use this result to authorize a record.
  if (group.scope === "all") return true;
  if (group.scope === "self") return record.createdBy === actor.id;
  if (group.scope === "department") {
    const own =
      org.spec.assignments.find((a) => a.userId === actor.id)?.departmentIds ||
      [];
    return (record.createdDepartmentIds || []).some((id) => own.includes(id));
  }
  return (
    !!record.values &&
    matchesGroupFilters(group.filters, record.values, actor, org)
  );
}
export function groupedRecordAccess(
  actor: Actor,
  definitionId: string,
  schema: FormSchema,
  org: ServerOrganization,
  config: RecordGroupConfiguration,
  target: GroupRecordContext,
): AccessGrant {
  const selected = selectRecordGroups(actor, definitionId, org, config);
  // The form entry still opens for a view-only group. Its field mask is read-only.
  // Drafts and writes use only groups granting create; existing-record scopes never
  // turn a registration permission into permission to read the submitted record.
  const action: RecordGroupAction =
    target.operation === "create" && selected.some(group => group.actions.includes("create"))
      ? "create"
      : target.operation === "export" || target.operation === "print"
      ? target.operation
      : "view";
  const groups = selected.filter(
    (group) =>
      group.actions.includes(action) && (action === "create" || groupMatches(group, actor, org, target)),
  );
  if (target.operation === "create" && target.createdBy && action !== "create")
    throw new ForbiddenException("当前没有继续填写此草稿的权限");
  if (!groups.length)
    throw new ForbiddenException("所选权限组没有此记录或操作的权限");
  const can = (action: RecordGroupAction) =>
    groups.some((group) => group.actions.includes(action));
  const access: AccessGrant = {
    userId: actor.id,
    read: action === "create" ? selected.some(group => group.actions.includes("view")) : true,
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
  const rank: Record<FieldPermission, number> = { hidden: 0, read: 1, edit: 2 };
  const add = (
    bag: Record<string, FieldPermission>,
    id: string,
    level: FieldPermission,
  ) => {
    if (rank[level] > rank[bag[id] || "hidden"]) bag[id] = level;
  };
  for (const group of groups) {
    const grant = { ...access, fields: group.fields };
    const canWrite = action === "create" || (
      action === "view" &&
      target.operation !== "create" &&
      group.actions.includes("edit"));
    const put = (
      field: FormSchema["fields"][number],
      parent?: FormSchema["fields"][number],
    ) => {
      let level = permission(grant, field, parent) as FieldPermission;
      if (level === "edit" && !canWrite) level = "read";
      add(access.fields, field.id, level);
    };
    for (const field of schema.fields) {
      put(field);
      field.children.forEach((child) => put(child, field));
    }
    for (const [id, level] of Object.entries(group.relations))
      add(
        access.relations!,
        id,
        level === "edit" && !canWrite ? "read" : level,
      );
  }
  return access;
}

/** Parameterized SQL projects supplementary choices just like matchesGroupFilters. */
export function groupRecordSql(
  groups: RecordPermissionGroup[],
  actor: Actor,
  org: ServerOrganization,
  alias: string,
  parameters: unknown[],
): string {
  if (!/^[a-z][a-z_]*$/.test(alias)) throw new Error("Invalid record alias");
  const bind = (value: unknown) => {
    parameters.push(value);
    return `$${parameters.length}`;
  };
  const filterSql = (filter: DataFilter) => {
    const expected = filterExpected(filter, actor, org);
    if (
      filter.operator !== "notEmpty" &&
      filter.source !== "constant" &&
      !expected
    )
      return "false";
    const field = `${alias}.values -> ${bind(filter.sourceFieldId)}::text`;
    const list = `CASE WHEN jsonb_typeof(${field})='array' THEN ${field} ELSE jsonb_build_array(${field}) END`;
    const textValue = (value: string) => `CASE WHEN jsonb_typeof(${value})='object' THEN COALESCE(${value}->>'optionId',${value}->>'text') ELSE ${value} #>> '{}' END`;
    const elements = `(SELECT ${textValue("item.value")} AS value FROM jsonb_array_elements(${list}) item(value)) v`;
    const nonempty = `(v.value IS NOT NULL AND v.value<>'')`;
    if (filter.operator === "notEmpty")
      return `EXISTS(SELECT 1 FROM ${elements} WHERE ${nonempty})`;
    const value = bind(expected);
    const same = `EXISTS(SELECT 1 FROM ${elements} WHERE ${nonempty} AND v.value=${value}::text)`;
    if (filter.operator === "equals") return same;
    if (filter.operator === "notEquals") return `NOT (${same})`;
    if (filter.operator === "contains")
      return `(CASE WHEN jsonb_typeof(${field})='array' THEN ${same} ELSE position(${value}::text in COALESCE((${textValue(field)}),''))>0 END)`;
    return `(CASE WHEN jsonb_typeof(${field})='number' THEN (${field} #>> '{}')::numeric ${filter.operator === "greater" ? ">" : "<"} ${value}::numeric ELSE false END)`;
  };
  return (
    groups
      .filter((group) => group.actions.includes("view"))
      .map((group) => {
        if (group.scope === "all") return "true";
        if (group.scope === "self")
          return `${alias}.created_by=${bind(actor.id)}::uuid`;
        if (group.scope === "department")
          return `${alias}.created_department_ids && ${bind(org.spec.assignments.find((a) => a.userId === actor.id)?.departmentIds || [])}::uuid[]`;
        return group.filters.length
          ? `(${group.filters.map(filterSql).join(" AND ")})`
          : "false";
      })
      .map((sql) => `(${sql})`)
      .join(" OR ") || "false"
  );
}
