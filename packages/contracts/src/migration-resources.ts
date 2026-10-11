/** Explicit application snapshot, separate from identity-only preparation. */
export interface MigrationResourceSource {
  format: 1;
  namespace: string;
  applicationId: string;
  fingerprint: string;
  application: Record<string, unknown>;
  forms: Record<string, unknown>[];
  entries: Record<string, unknown>[];
  access: Record<string, unknown>;
  recordViews: Record<string, unknown>;
  roles: Record<string, unknown>[];
  orders: Record<string, unknown>[];
  runs: Record<string, unknown>[];
}
export interface MigrationResourceIssue {
  kind: "invalid" | "mapping" | "unsupported";
  formId: string;
  version: string;
  recordId?: string;
  fieldId?: string;
  rowIndex?: number;
  groupId?: string;
  message: string;
}
export interface MigrationResourcePlan {
  id: string;
  revision: number;
  batchId: string;
  batchRevision: number;
  sourceFingerprint: string;
  sourceDigest: string;
  createdAt: string;
  current: boolean;
  identityConfirmed: boolean;
  /** Preparation only: no runtime resource has been inserted. */
  importAvailable: false;
  targetApplicationId: string;
  forms: { sourceId: string; title: string; archived: boolean; definitionId: string; pageId: string; versions: { sourceVersion: number; targetVersion: number; variants: number; checked: boolean }[]; draftChecked: boolean }[];
  records: { sourceId: string; formId: string; targetId: string; version: number; status: string; deleted: boolean; rows: { fieldId: string; sourceRowId?: string; index: number; targetId: string }[]; checked: boolean }[];
  totals: { forms: number; versions: number; records: number; rows: number; archivedForms: number; deletedRecords: number; draftRecords: number; historyEvents: number; orders: number; runs: number };
  issues: MigrationResourceIssue[];
  access?: import('./grouped-access').MigrationAccessSummary[];
}
