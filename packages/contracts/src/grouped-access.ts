import type { DataFilter } from "./form";
import type { FieldPermission } from "./index";

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
  mode: 'direct' | 'groups';
  allowMerged: boolean;
  groups: RecordPermissionGroup[];
}
export interface RecordGroupOptions {
  mode: 'direct' | 'groups';
  revision: number;
  allowMerged: boolean;
  groups: Pick<RecordPermissionGroup, 'id' | 'name' | 'actions'>[];
}
