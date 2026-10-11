import type { OrganizationSpec } from "./organization";

/** Source IDs refer to the batch's explicitly confirmed identity correspondence. */
export interface MigrationOrganizationSource {
  fingerprint: string;
  departments: { id: string; parentId: string | null; managerIds: string[] }[];
  roles: {
    id: string;
    memberIds: string[];
    departmentIds: string[];
    includeChildren: boolean;
  }[];
  assignments: {
    userId: string;
    departmentIds: string[];
    primaryDepartmentId: string | null;
  }[];
}
export interface MigrationOrganizationReview {
  token: string;
  batchRevision: number;
  organizationRevision: number;
  blockers: string[];
  changes: {
    kind: "department" | "role" | "member";
    name: string;
    before: string;
    after: string;
  }[];
  historical: number;
  spec: OrganizationSpec;
}
