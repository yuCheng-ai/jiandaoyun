export * from "./formula";
export * from "./form-validation";
export * from "./visibility";
export * from "./condition-values";
export * from "./record-views";
export * from "./field-display";
export type * from "./form";
export type * from "./relations";
export type * from "./process-templates";
export { processTemplateConnectionError } from "./process-templates";
export * from "./data-view";
export * from "./organization";
export * from "./directory";
export * from "./field-runtime";
export * from "./choices";
export * from "./files";
export * from "./numbers";
export * from "./dates";
export * from "./date-range";
export * from "./grouped-access";
export * from "./collection";
export * from "./form-layout";
export * from "./form-appearance";
export * from "./frontend-events";
export * from "./serial";
export * from "./address";
export * from "./location";
export * from "./subform";

import type { FormField, FormSchema, FormValues } from "./form";

export interface SessionUser {
  id: string;
  name: string;
  username: string;
  role: "admin" | "member";
}
export type FieldPermission = "hidden" | "read" | "edit";
export interface AccessPolicy {
  read: boolean;
  create: boolean;
  edit: boolean;
  scope: "all" | "self" | "department";
  departmentBasis?: "creator-current" | "record-created";
  fields: Record<string, FieldPermission>;
  relations?: Record<string, FieldPermission>;
  remove?: boolean;
}
export interface AccessGrant extends AccessPolicy {
  userId: string;
  export?: boolean;
  print?: boolean;
  groupSelection?: {
    definitionId: string;
    revision: number;
    selection: string;
  };
}
export interface ServerDefinition {
  id: string;
  title: string;
  version: number;
  schema: FormSchema;
  createdAt: string;
}
export interface RecordCell {
  fieldId: string;
  subformId?: string;
  rowId?: string;
}
/** 字段输入校验定位；新建明细尚无行 ID 时，rowIndex 对应提交数组中的零基位置。 */
export interface FieldValidationIssue extends RecordCell {
  message: string;
  rowIndex?: number;
}
export interface CellChange extends RecordCell {
  expectedRevision: number;
  value: unknown;
}
export interface ServerRecord {
  createdDepartmentIds?: string[] | null;
  state?: "draft" | "active";
  id: string;
  definitionId: string;
  definitionVersion: number;
  revision: number;
  values: FormValues;
  cellRevisions: Record<string, number>;
  rowRevisions?: Record<string, number>;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}
export type RowChange = {
  subformId: string;
  expectedRevision: number;
} & (
  | { action: "add"; values: FormValues }
  | { action: "insert"; beforeRowId: string | null; values: FormValues }
  | { action: "remove"; rowId: string; expectedCells: Record<string, number> }
  | { action: "restore"; rowId: string; eventId: string }
);
export interface RemovedRecordRow {
  eventId: string;
  subformId: string;
  rowId: string;
  values: FormValues;
  removedAt: string;
  restorable: boolean;
  reason?: string;
}
export interface RecordDetail {
  processId?: string;
  collection?: import("./collection").CollectionStatus;
  /** Acknowledges this actor's successful command without content when current read access is absent. */
  accessLost?: true;
  canReadOrigin?: boolean;
  creator?: import("./organization").OrganizationIdentity;
  identities?: import("./organization").OrganizationIdentity[];
  task?: {
    processId: string;
    taskId: string;
    title: string;
    writable: boolean;
    rowId?: string;
    subformId?: string;
  };
  page?: { id: string; title: string; version: number };
  definition: ServerDefinition;
  record: ServerRecord;
  access: AccessGrant;
  rowActions?: Record<string, { add: boolean; remove: boolean; insert?: boolean; editExisting?: boolean }>;
}
export interface TaskSpec {
  id: string;
  title: string;
  kind?: "approval" | "copy";
  fieldPermissions?: Record<string, "edit" | "read" | "hidden">;
  assigneeId: string;
  recordBinding: string;
  dependsOn: string[];
  templateTaskId?: string;
  pageId?: string;
  pageVersion?: number;
  subformId?: string;
  rowId?: string;
  requiredFields?: string[];
  waitFor?: {
    recordBinding: string;
    fieldId: string;
    equals: string | number | boolean | string[];
    subformId?: string;
    rowId?: string;
  };
}
export interface ProcessSpec {
  title: string;
  tasks: TaskSpec[];
}
export interface DefinitionSummary {
  id: string;
  title: string;
  revision: number;
  latestVersion: number;
}
export interface RecordSummary {
  state?: "draft" | "active";
  id: string;
  definitionVersion: number;
  revision: number;
  createdAt: string;
  updatedAt: string;
}
/** Business values are present only after record and selected-page authorization. */
export interface PageRecordSummary extends RecordSummary {
  preview?: {
    fields: FormField[];
    values: FormValues;
    identities: import("./organization").OrganizationIdentity[];
  };
}
export interface PublishedAccess {
  collection?: import("./collection").CollectionStatus;
  defaultValues?: FormValues;
  identities?: import("./organization").OrganizationIdentity[];
  page?: { id: string; title: string; version: number };
  definition: ServerDefinition;
  access: AccessGrant;
  compatibleVersions?: number[];
  rowActions?: Record<string, { add: boolean; remove: boolean; insert?: boolean; editExisting?: boolean }>;
}
export interface RecordUpgradePlan {
  defaultsToken?: string;
  recordId: string;
  revision: number;
  fromVersion: number;
  toVersion: number;
  allowed: boolean;
  reason?: string;
  additions: {
    fieldId: string;
    name: string;
    parentName?: string;
    defaultDisplay?: string;
    defaultValue: unknown;
  }[];
}
export interface ProcessSummary {
  id: string;
  title: string;
  status: "running" | "completed";
  templateVersion: number | null;
  createdAt: string;
  createdByName: string | null;
  currentAssigneeNames: string[];
}
export interface ProcessView {
  id: string;
  title: string;
  status: "running" | "completed";
  templateId?: string;
  templateVersion?: number;
  applicationId?: string;
  createdAt?: string;
  checkedAt?: string;
  refreshError?: string;
  summary?: {
    total: number;
    completed: number;
    ready: number;
    waiting: number;
    blocked: number;
  };
  events?: {
    id: string;
    action: string;
    taskTitle?: string;
    actorName?: string;
    detail?: string;
    createdAt: string;
  }[];
  tasks: {
    id: string;
    key: string;
    title: string;
    kind?: "approval" | "copy";
    canOpen?: boolean;
    canHandle?: boolean;
    recordId: string;
    status: "waiting" | "ready" | "blocked" | "completed";
    reason?: string;
    assigneeName?: string;
    pageId?: string;
    pageVersion?: number;
    subformId?: string;
    rowId?: string;
    completedAt?: string;
  }[];
}
export * from "./ocr";

export {
  effectiveRecordAccess,
  eligibleRecordGroups,
  emptyRecordGroupConfiguration,
  fieldPermission,
  filterExpected,
  groupMatches,
  matchesGroupFilters,
  RecordAccessDeniedError,
  recordDepartmentIds,
  selectRecordGroups,
  type RecordAccessActor,
  type RecordAccessContext,
  type RecordAccessOrganization,
  type RecordAccessPolicy,
} from "./record-access";
