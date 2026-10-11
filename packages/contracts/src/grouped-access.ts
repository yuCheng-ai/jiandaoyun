import type { DataFilter } from "./form";
import type { FieldPermission } from "./index";
import type { MigrationIdentityKind } from "./migration";

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
  kind: MigrationIdentityKind;
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
/** Declarative migration contract. This is not the live direct/subject grant format. */
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
export interface MigrationAccessGroupSummary {
  id: string;
  name: string;
  enabled: boolean | null;
  archived: boolean | null;
  checked: boolean;
  actions: GroupAction[];
  scope: keyof typeof groupScopeNames | null;
  subjects: number;
  mappedSubjects: number;
  historicalSubjects: number;
  fields: number;
  filters: number;
}
export interface MigrationAccessSummary {
  formId: string;
  checked: boolean;
  membersEnabled: boolean | null;
  publicEnabled: boolean | null;
  allowMerged: boolean | null;
  filling: GroupedAccessConfig["filling"] | null;
  groups: MigrationAccessGroupSummary[];
  executionReady: boolean;
}

/** Live operation policy. Collection limits and legacy start-node rules remain separate. */
export type RecordGroupAction = GroupAction;
export interface RecordPermissionGroup {
  id: string;
  name: string;
  enabled: boolean;
  archived: boolean;
  subjects: { kind: MigrationIdentityKind; id: string; includeChildren?: boolean }[];
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
