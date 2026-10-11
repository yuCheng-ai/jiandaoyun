import { ForbiddenException, Injectable } from "@nestjs/common";
import { organizationScopeCreators, organizationSubjectMembers, type AccessGrant, type AccessPolicy, type FieldPermission, type FormSchema, type GrantSubject, type ServerOrganization, type RecordGroupConfiguration } from "@platform/contracts";
import type { Actor } from "./auth";
import { Database } from "./database";
import { OrganizationService } from "./organization";
import { allFields, permission } from "./schema";
import { directoryRolePolicies, type RuntimePolicy } from './directory-grants';
import { eligibleRecordGroups, selectRecordGroups, groupedRecordAccess, groupRecordSql, type GroupRecordContext } from './group-access';
type Queryable = Pick<Database, "query">;
export interface PolicyContext { organization: ServerOrganization; policies: RuntimePolicy[]; grouped?: { definitionId: string; config: RecordGroupConfiguration } }
export interface AccessContext extends GroupRecordContext {}
export interface ReadScope { creators: string[] | null; createdDepartments: string[]; sql?: (alias: string, parameters: unknown[]) => string }
const rank: Record<FieldPermission, number> = { hidden: 0, read: 1, edit: 2 };
const union = (before: FieldPermission = "hidden", after: FieldPermission) => rank[before] >= rank[after] ? before : after;

/** Filter by record first; clamp each policy's parent and operation before combining it with another policy. */
export function effectiveAccess(actor: Actor, schema: FormSchema, context: PolicyContext, target: AccessContext = {}): AccessGrant {
  if (actor.role === "admin") return { userId: actor.id, read: true, create: true, edit: true, remove: true, scope: "all", fields: Object.fromEntries(allFields(schema).map(field => [field.id, "edit"])) };
  if (context.grouped) return groupedRecordAccess(actor, context.grouped.definitionId, schema, context.organization, context.grouped.config, target);
  if (target.operation === 'export' || target.operation === 'print') throw new ForbiddenException('当前授权没有此输出操作权限');
  const departmentCreators = new Set(organizationScopeCreators(context.organization.spec, actor.id));
  const ownDepartments = context.organization.spec.assignments.find(item => item.userId === actor.id)?.departmentIds || [];
  const matches = (policy: AccessPolicy, creator: string, departments: string[] | null = ownDepartments) => policy.scope === "all" || (policy.scope === "self" ? creator === actor.id : policy.departmentBasis === "record-created" ? (departments || []).some(id => ownDepartments.includes(id)) : departmentCreators.has(creator));
  const creation = target.operation === 'create' && context.policies.some(policy => policy.create && matches(policy, actor.id));
  const policies = context.policies.filter(policy => creation ? policy.create && matches(policy, actor.id) : policy.read && (!target.createdBy || matches(policy, target.createdBy, target.createdDepartmentIds || null)));
  if (!policies.length) throw new ForbiddenException("没有此表单或记录的访问权限");
  const access: AccessGrant = { userId: actor.id, read: creation ? context.policies.some(policy => policy.read) : true, create: creation, edit: target.operation !== 'create' && policies.some(policy => policy.edit), remove: target.operation !== 'create' && policies.some(policy => policy.remove), scope: policies.some(policy => policy.scope === "all") ? "all" : policies.some(policy => policy.scope === "department") ? "department" : "self", fields: {}, relations: {} };
  for (const policy of policies) {
    const canWrite = target.operation === "create" ? policy.create && matches(policy, actor.id) : policy.edit;
    const grant = { ...policy, userId: actor.id, fields: policy.allFormFields ? Object.fromEntries(allFields(schema).map(field => [field.id, 'edit' as const])) : policy.fields };
    const add = (field: FormSchema["fields"][number], parent?: FormSchema["fields"][number]) => {
      let allowed = permission(grant, field, parent) as FieldPermission;
      if (allowed === "edit" && !canWrite) allowed = "read";
      access.fields[field.id] = union(access.fields[field.id], allowed);
    };
    for (const field of schema.fields) { add(field); for (const child of field.children) add(child, field); }
    for (const [id, value] of Object.entries(policy.relations || {})) access.relations![id] = union(access.relations![id], value === "edit" && !canWrite ? "read" : value);
  }
  return access;
}

@Injectable()
export class AccessService {
  constructor(private readonly db: Database, private readonly organizations: OrganizationService) {}
  private applies(organization: ServerOrganization, actor: Actor, row: any) {
    const subject: GrantSubject = { kind: row.subject_kind, id: row.subject_id, includeChildren: row.include_children };
    return organizationSubjectMembers(organization.spec, subject).includes(actor.id);
  }
  async context(tx: Queryable, actor: Actor, definitionId: string): Promise<PolicyContext> {
    const organization = await this.organizations.snapshot(tx, actor);
    if (actor.role === "admin") return { organization, policies: [] };
    const groupRow = (await tx.query('SELECT config,revision FROM record_permission_groups WHERE definition_id=$1', [definitionId])).rows[0];
    if (groupRow?.config.mode === 'groups') return { organization, policies: [], grouped: { definitionId, config: { ...groupRow.config, revision: groupRow.revision } } };
    const direct = (await tx.query("SELECT policy FROM grants WHERE definition_id=$1 AND user_id=$2", [definitionId, actor.id])).rows;
    const subjects = (await tx.query("SELECT * FROM subject_grants WHERE definition_id=$1", [definitionId])).rows;
    const roles = await directoryRolePolicies(tx, actor, organization, definitionId);
    return { organization, policies: [...direct.map(row => row.policy), ...subjects.filter(row => this.applies(organization, actor, row)).map(row => row.policy), ...roles.map(row => row.policy)] };
  }
  async effective(tx: Queryable, actor: Actor, id: string, schema: FormSchema, target?: AccessContext) { return effectiveAccess(actor, schema, await this.context(tx, actor, id), target); }
  async readers(tx: Queryable, actor: Actor, id: string, policyContext?: PolicyContext): Promise<ReadScope> {
    const context = policyContext ?? await this.context(tx, actor, id);
    if (actor.role === "admin") return { creators: null, createdDepartments: [] };
    if (context.grouped) {
      const groups = selectRecordGroups(actor, id, context.organization, context.grouped.config);
      if (!groups.some(group => group.actions.includes('view'))) throw new ForbiddenException('当前权限组不能查看正式记录');
      return { creators: null, createdDepartments: [], sql: (alias, parameters) => groupRecordSql(groups, actor, context.organization, alias, parameters) };
    }
    const policies = context.policies.filter(policy => policy.read);
    if (!policies.length) throw new ForbiddenException("没有此表单的查看权限");
    if (policies.some(policy => policy.scope === "all")) return { creators: null, createdDepartments: [] };
    return {
      creators: [...new Set(policies.filter(policy => policy.scope !== "department" || policy.departmentBasis !== "record-created").flatMap(policy => policy.scope === "self" ? [actor.id] : organizationScopeCreators(context.organization.spec, actor.id)))],
      createdDepartments: policies.some(policy => policy.scope === "department" && policy.departmentBasis === "record-created") ? context.organization.spec.assignments.find(item => item.userId === actor.id)?.departmentIds || [] : [],
    };
  }
  async draftReaders(tx: Queryable, actor: Actor, id: string, policyContext?: PolicyContext): Promise<ReadScope> {
    const context = policyContext ?? await this.context(tx, actor, id);
    if (actor.role === 'admin') return { creators: null, createdDepartments: [] };
    if (!context.grouped) return context.policies.some(policy => policy.create)
      ? { creators: [actor.id], createdDepartments: [] }
      : this.readers(tx, actor, id, context);
    const groups = selectRecordGroups(actor, id, context.organization, context.grouped.config);
    if (!groups.some(group => group.actions.includes('create'))) throw new ForbiddenException('当前权限组没有填写草稿的权限');
    return { creators: [actor.id], createdDepartments: [] };
  }
  async definitions(tx: Queryable, actor: Actor): Promise<string[] | null> {
    const organization = await this.organizations.snapshot(tx, actor);
    if (actor.role === "admin") return null;
    const direct = (await tx.query("SELECT g.definition_id FROM grants g JOIN definitions d ON d.id=g.definition_id WHERE d.workspace_id=$1 AND g.user_id=$2 AND g.policy->>'read'='true'", [actor.workspaceId, actor.id])).rows;
    const subjects = (await tx.query("SELECT g.* FROM subject_grants g JOIN definitions d ON d.id=g.definition_id WHERE d.workspace_id=$1 AND g.policy->>'read'='true'", [actor.workspaceId])).rows;
    const groupRows = (await tx.query("SELECT g.definition_id,g.config,g.revision FROM record_permission_groups g JOIN definitions d ON d.id=g.definition_id WHERE d.workspace_id=$1 AND g.config->>'mode'='groups'", [actor.workspaceId])).rows;
    const overridden = new Set(groupRows.map(row => row.definition_id));
    const roles = await directoryRolePolicies(tx, actor, organization);
    return [...new Set([...direct.map(row => row.definition_id), ...subjects.filter(row => this.applies(organization, actor, row)).map(row => row.definition_id), ...roles.map(row => row.definitionId)].filter(id => !overridden.has(id)).concat(groupRows.filter(row => eligibleRecordGroups(actor, organization, { ...row.config, revision: row.revision }).length).map(row => row.definition_id)))];
  }
}
