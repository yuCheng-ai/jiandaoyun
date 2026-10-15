import type { DataFilter, FormField } from "./form";
import type { FieldPermission } from "./index";
import { hasFieldValue } from "./field-runtime";
import { isNumericField } from "./numbers";

/** 权限筛选以字段的真实值类型为准，复合结构仅支持是否填写。 */
export function groupFilterOperators(field?: FormField): DataFilter["operator"][] {
  if (!field || !hasFieldValue(field) || field.type === "subform") return [];
  const structured = [
    "image", "file", "address", "location", "signature",
    "query", "lookup", "relation", "relationTable",
  ];
  if (structured.includes(field.type)) return ["notEmpty"];
  const operators: DataFilter["operator"][] = ["equals", "notEquals", "contains", "notEmpty"];
  if (isNumericField(field)) operators.push("greater", "less");
  return operators;
}

export type GroupSubjectKind = "member" | "department" | "role";

export const groupActionNames = {
  view: "查看",
  create: "添加",
  edit: "编辑",
  delete: "删除",
  export: "导出",
  print: "打印",
} as const;
export type GroupAction = keyof typeof groupActionNames;
export const groupScopeNames = {
  all: "所有记录",
  self: "本人创建",
  department: "记录创建部门",
  custom: "自定义条件",
} as const;
/** One subject is kept as a live directory reference, never expanded into a frozen list of members. */
export interface GroupAccessSubject {
  kind: GroupSubjectKind;
  id: string;
  sourceId: string;
  historical: boolean;
  includeChildren?: boolean;
}
export interface PermissionGroup {
  id: string;
  name: string;
  enabled: boolean;
  archived: boolean;
  subjects: GroupAccessSubject[];
  actions: GroupAction[];
  scope: keyof typeof groupScopeNames;
  departmentBasis: "record-created";
  departmentIncludesChildren: false;
  filters: DataFilter[];
  fields: Record<string, FieldPermission>;
}
export interface GroupedAccessConfig {
  version: 1;
  membersEnabled: boolean;
  publicEnabled: boolean;
  allowMerged: boolean;
  selectionMode: "explicit-or-allowed-merge";
  actionFieldMode: "same-record-scoped-group";
  creationFieldMode: "published-page-and-start-node";
  filling: import("./collection").CollectionRules;
  groups: PermissionGroup[];
}

/** Live operation policy. Collection limits and legacy start-node rules remain separate. */
export type RecordGroupAction = GroupAction;
export interface RecordPermissionGroup {
  id: string;
  name: string;
  enabled: boolean;
  archived: boolean;
  subjects: { kind: GroupSubjectKind; id: string; includeChildren?: boolean }[];
  actions: RecordGroupAction[];
  scope: keyof typeof groupScopeNames;
  filters: DataFilter[];
  fields: Record<string, FieldPermission>;
  relations: Record<string, FieldPermission>;
}
export interface RecordGroupConfiguration {
  revision: number;
  mode: "groups";
  allowMerged: boolean;
  groups: RecordPermissionGroup[];
}
export interface RecordGroupOptions {
  /** 仅描述管理员无需选择权限组的界面行为，不作为授权输入。 */
  administrator: boolean;
  revision: number;
  allowMerged: boolean;
  groups: Pick<RecordPermissionGroup, 'id' | 'name' | 'actions'>[];
}

/** 授权范围摘要，不代表任意一条记录均满足字段、页面或收集规则。 */
export interface OrganizationFormPermission {
  applicationId: string;
  applicationTitle: string;
  pageId: string;
  title: string;
  groups: Pick<RecordPermissionGroup, "id" | "name" | "actions" | "scope">[];
}

export interface OrganizationPermissionSummary {
  member?: {
    id: string;
    name: string;
    accountId: string | null;
    username: string | null;
    accountStatus: "unlinked" | "disabled" | "active" | "admin";
  };
  role?: { id: string; name: string; archived: boolean };
  forms: OrganizationFormPermission[];
}
