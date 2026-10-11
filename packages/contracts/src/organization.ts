import type { AccessPolicy, SessionUser } from "./index";

export interface ServerDepartment { id: string; name: string; parentId: string | null; archived: boolean; managerIds?: string[] }
export interface ServerRoleGroup { id: string; name: string }
export interface ServerRole { id: string; name: string; groupId: string; description: string; memberIds: string[]; departmentIds: string[]; includeChildren: boolean; archived: boolean }
export interface MemberAssignment { userId: string; departmentIds: string[]; primaryDepartmentId: string | null }
export interface OrganizationSpec { departments: ServerDepartment[]; roleGroups: ServerRoleGroup[]; roles: ServerRole[]; assignments: MemberAssignment[] }
export interface AccountUser extends SessionUser { active: boolean; revision: number }
export interface AccountCreateRequest { requestId: string; username: string; name: string; password: string }
export interface MemberAccountSource { namespace: string; memberId: string; name: string; number: string }
export interface MemberAccountLink { id: string; source: MemberAccountSource; revision: number; account: AccountUser }
export interface MemberAccounts { links: MemberAccountLink[]; accounts: AccountUser[] }
export interface ServerOrganization { revision: number; spec: OrganizationSpec; users: AccountUser[] }
export type GrantSubject = { kind: "department" | "role"; id: string; includeChildren?: boolean };
export interface SubjectGrant { subject: GrantSubject; policy: AccessPolicy; revision: number }
export type AssigneeSelector = GrantSubject;
export const emptyOrganizationSpec = (): OrganizationSpec => ({ departments: [], roleGroups: [], roles: [], assignments: [] });

/** Only identities selected in readable cells are returned to record readers. */
export interface OrganizationIdentity { id: string; name: string; kind: "member" | "department"; active: boolean; historical?: boolean }
export const organizationIdentityLabel = (identity: { name: string; active?: boolean; historical?: boolean }): string => `${identity.name}${identity.historical ? "（历史身份）" : identity.active === false ? "（已停用）" : ""}`;
export interface OrganizationFieldOptions { options: OrganizationIdentity[]; defaultValue: string | string[]; organizationRevision: number }

export function organizationDepartments(spec: OrganizationSpec, id: string, includeChildren: boolean): string[] {
  const root = spec.departments.find(item => item.id === id && !item.archived);
  if (!root) return [];
  const found = new Set([id]);
  if (includeChildren) for (let changed = true; changed;) {
    changed = false;
    for (const department of spec.departments) if (!department.archived && department.parentId && found.has(department.parentId) && !found.has(department.id)) { found.add(department.id); changed = true; }
  }
  return [...found];
}
export function organizationSubjectMembers(spec: OrganizationSpec, subject: GrantSubject): string[] {
  const role = subject.kind === "role" ? spec.roles.find(item => item.id === subject.id && !item.archived) : undefined;
  if (subject.kind === "role" && !role) return [];
  const departmentIds = role ? role.departmentIds.flatMap(id => organizationDepartments(spec, id, role.includeChildren)) : organizationDepartments(spec, subject.id, !!subject.includeChildren);
  const departments = new Set(departmentIds);
  return [...new Set([...(role?.memberIds || []), ...spec.assignments.filter(item => item.departmentIds.some(id => departments.has(id))).map(item => item.userId)])];
}
/** Scope follows the creator's current membership; employment/account activity does not erase historical records. */
export function organizationScopeCreators(spec: OrganizationSpec, userId: string): string[] {
  const own = spec.assignments.find(item => item.userId === userId);
  const departments = new Set((own?.departmentIds || []).flatMap(id => organizationDepartments(spec, id, true)));
  return spec.assignments.filter(item => item.departmentIds.some(id => departments.has(id))).map(item => item.userId);
}
