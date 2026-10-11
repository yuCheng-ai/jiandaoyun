export type MigrationIdentityKind = "member" | "department" | "role";
export interface MigrationSourceIdentity {
  kind: MigrationIdentityKind;
  sourceId: string;
  name: string;
  found: boolean;
  active: boolean;
}
/** Metadata only. Business records, credentials and configuration payloads are not uploaded here. */
export interface MigrationIdentitySource {
  namespace: string;
  applicationId: string;
  applicationName: string;
  fingerprint: string;
  identities: MigrationSourceIdentity[];
  counts: { forms: number; versions: number; records: number; rows: number; issues: number };
}
export interface MigrationIdentityChoice {
  kind: MigrationIdentityKind;
  sourceId: string;
  mode: "unresolved" | "existing" | "historical";
  targetId?: string;
}
export interface MigrationBatch {
  id: string;
  revision: number;
  state: "draft" | "identities_confirmed";
  source: MigrationIdentitySource;
  choices: MigrationIdentityChoice[];
  confirmedAt: string | null;
  updatedAt: string;
}
export interface MigrationIdentityReview {
  token: string;
  batchId: string;
  revision: number;
  organizationRevision: number;
  confirmationCurrent: boolean;
  counts: { existing: number; historical: number; unresolved: number };
  items: { source: MigrationSourceIdentity; choice: MigrationIdentityChoice; targetName?: string; targetActive?: boolean; warnings: string[] }[];
  blockers: string[];
}
export interface MigrationBatchEvent { id: string; revision: number; action: "create" | "save" | "refresh_source" | "confirm_identities" | "reopen"; actorName: string; createdAt: string }
export const migrationIdentityKey = (item: Pick<MigrationSourceIdentity, "kind" | "sourceId">) => `${item.kind}/${item.sourceId}`;
