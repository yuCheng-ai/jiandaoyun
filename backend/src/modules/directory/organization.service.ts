import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import {
  emptyOrganizationSpec,
  directoryCanonical,
  type DirectoryIdentity,
  organizationSubjectMembers,
  type GrantSubject,
  type OrganizationSpec,
  type ServerOrganization,
} from "@platform/contracts";
import { Actor, requireAdmin } from "../../core/auth/auth.service";
import { Database, type Transaction } from "../../core/database/database";
import { object, title, uuid } from "../../core/database/schema";
type Queryable = Pick<Database, "query">;

export function parseSubject(value: unknown): GrantSubject {
  object(value);
  uuid(value.id);
  if (
    !["department", "role"].includes(value.kind) ||
    (value.includeChildren !== undefined &&
      typeof value.includeChildren !== "boolean")
  )
    throw new BadRequestException("授权对象不合法");
  return {
    kind: value.kind,
    id: value.id,
    ...(value.kind === "department"
      ? { includeChildren: value.includeChildren === true }
      : {}),
  };
}
export function requireSubject(spec: OrganizationSpec, subject: GrantSubject) {
  const found = (
    subject.kind === "department" ? spec.departments : spec.roles
  ).find((item) => item.id === subject.id && !item.archived);
  if (!found)
    throw new BadRequestException("部门或角色不存在、已归档或不属于当前组织");
  return found;
}

@Injectable()
export class OrganizationService {
  constructor(private readonly db: Database) {}
  /** Mutating authorization paths hold this shared lock until commit. Org saves never lock definitions/records. */
  async lock(tx: Queryable, workspaceId: string, exclusive = false) {
    await tx.query(
      `SELECT ${exclusive ? "pg_advisory_xact_lock" : "pg_advisory_xact_lock_shared"}(hashtextextended($1,0))`,
      [`organization:${workspaceId}`],
    );
  }
  async snapshot(tx: Queryable, actor: Actor): Promise<ServerOrganization> {
    await this.lock(tx, actor.workspaceId);
    const row = (
      await tx.query(
        "SELECT revision,spec FROM workspace_organizations WHERE workspace_id=$1",
        [actor.workspaceId],
      )
    ).rows[0];
    const users = (
      await tx.query(
        "SELECT id,name,username,role,active,account_revision AS revision FROM users WHERE workspace_id=$1 ORDER BY id",
        [actor.workspaceId],
      )
    ).rows;
    if (!users.some((user) => user.id === actor.id && user.active))
      throw new ForbiddenException("当前成员已停用或不属于此组织");
    return {
      revision: row?.revision || 0,
      spec: row?.spec || emptyOrganizationSpec(),
      users,
    };
  }
  async get(actor: Actor) {
    requireAdmin(actor);
    return this.db.transaction((tx) => this.snapshot(tx, actor));
  }
  async members(tx: Queryable, actor: Actor, subject: GrantSubject) {
    const organization = await this.snapshot(tx, actor);
    requireSubject(organization.spec, subject);
    const ids = new Set(organizationSubjectMembers(organization.spec, subject));
    return {
      organization,
      users: organization.users.filter(
        (user) => user.active && ids.has(user.id),
      ),
    };
  }
  validateSpec(input: unknown, current: ServerOrganization): OrganizationSpec {
    object(input);
    for (const key of ["departments", "roleGroups", "roles", "assignments"])
      if (!Array.isArray(input[key]) || input[key].length > 1000)
        throw new BadRequestException("组织结构不合法或超过 1000 项");
    const ids = (raw: unknown): string[] => {
      if (!Array.isArray(raw) || raw.length > 1000)
        throw new BadRequestException("组织成员或部门范围不合法");
      raw.forEach(uuid);
      if (new Set(raw).size !== raw.length)
        throw new BadRequestException("组织引用不能重复");
      return [...raw];
    };
    const spec: OrganizationSpec = {
      departments: input.departments.map((item: unknown) => {
        object(item);
        uuid(item.id);
        title(item.name);
        if (item.parentId !== null) uuid(item.parentId);
        if (typeof item.archived !== "boolean")
          throw new BadRequestException("部门状态不合法");
        return {
          id: item.id,
          name: item.name.trim(),
          parentId: item.parentId,
          archived: item.archived,
          managerIds: ids(item.managerIds || []),
        };
      }),
      roleGroups: input.roleGroups.map((item: unknown) => {
        object(item);
        uuid(item.id);
        title(item.name);
        return { id: item.id, name: item.name.trim() };
      }),
      roles: input.roles.map((item: unknown) => {
        object(item);
        uuid(item.id);
        uuid(item.groupId);
        title(item.name);
        if (
          typeof item.archived !== "boolean" ||
          typeof item.includeChildren !== "boolean" ||
          typeof item.description !== "string" ||
          item.description.length > 2000
        )
          throw new BadRequestException("角色配置不合法");
        return {
          id: item.id,
          name: item.name.trim(),
          groupId: item.groupId,
          description: item.description,
          memberIds: ids(item.memberIds),
          departmentIds: ids(item.departmentIds),
          includeChildren: item.includeChildren,
          archived: item.archived,
        };
      }),
      assignments: input.assignments.map((item: unknown) => {
        object(item);
        uuid(item.userId);
        if (item.primaryDepartmentId !== null) uuid(item.primaryDepartmentId);
        return {
          userId: item.userId,
          departmentIds: ids(item.departmentIds),
          primaryDepartmentId: item.primaryDepartmentId,
        };
      }),
    };
    for (const list of [spec.departments, spec.roleGroups, spec.roles])
      if (new Set(list.map((item) => item.id)).size !== list.length)
        throw new BadRequestException("组织标识重复");
    if (
      new Set(spec.assignments.map((item) => item.userId)).size !==
      spec.assignments.length
    )
      throw new BadRequestException("成员部门配置重复");
    const users = new Set(current.users.map((user) => user.id)),
      departments = new Map(spec.departments.map((item) => [item.id, item]));
    for (const department of spec.departments) {
      if (department.managerIds?.some((id) => !users.has(id)))
        throw new BadRequestException("部门负责人不属于当前组织");
      const visited = new Set([department.id]);
      let parent = department.parentId;
      while (parent) {
        if (visited.has(parent))
          throw new BadRequestException("部门不能形成循环");
        visited.add(parent);
        const next = departments.get(parent);
        if (!next || (!department.archived && next.archived))
          throw new BadRequestException("上级部门不存在或已归档");
        parent = next.parentId;
      }
      if (
        !department.archived &&
        spec.departments.some(
          (other) =>
            other.id !== department.id &&
            !other.archived &&
            other.parentId === department.parentId &&
            other.name === department.name,
        )
      )
        throw new BadRequestException("同级部门名称不能重复");
    }
    const activeDepartment = (id: string) =>
      !!departments.get(id) && !departments.get(id)!.archived;
    for (const assignment of spec.assignments) {
      if (
        !users.has(assignment.userId) ||
        assignment.departmentIds.some((id) => !activeDepartment(id)) ||
        (assignment.primaryDepartmentId &&
          !assignment.departmentIds.includes(assignment.primaryDepartmentId)) ||
        !!assignment.departmentIds.length !== !!assignment.primaryDepartmentId
      )
        throw new BadRequestException("成员、部门或主部门配置不合法");
    }
    for (const role of spec.roles) {
      if (
        !spec.roleGroups.some((group) => group.id === role.groupId) ||
        role.memberIds.some((id) => !users.has(id)) ||
        role.departmentIds.some((id) => !activeDepartment(id))
      )
        throw new BadRequestException("角色的成员、部门或角色组不属于当前组织");
      if (
        !role.archived &&
        spec.roles.some(
          (other) =>
            other.id !== role.id &&
            !other.archived &&
            other.groupId === role.groupId &&
            other.name === role.name,
        )
      )
        throw new BadRequestException("同组角色名称不能重复");
    }
    if (
      new Set(spec.roleGroups.map((group) => group.name)).size !==
      spec.roleGroups.length
    )
      throw new BadRequestException("角色组名称不能重复");
    // Stable principals remain addressable by published templates and audit history.
    if (
      current.spec.departments.some((item) => !departments.has(item.id)) ||
      current.spec.roles.some(
        (item) => !spec.roles.some((role) => role.id === item.id),
      )
    )
      throw new ConflictException("已有部门和角色请归档，不可直接删除其身份");
    return spec;
  }
  async save(actor: Actor, body: unknown) {
    return this.db.transaction((tx) => this.saveIn(tx, actor, body));
  }
  async saveIn(
    tx: Transaction,
    actor: Actor,
    body: unknown,
    fromDirectory = false,
  ) {
    requireAdmin(actor);
    object(body);
    await this.lock(tx, actor.workspaceId, true);
    const current = await this.snapshot(tx, actor);
    requireAdmin(current.users.find((user) => user.id === actor.id)!);
    if (body.expectedRevision !== current.revision)
      throw new ConflictException(
        "组织配置已被修改，当前输入已保留；请重新读取后合并",
      );
    const spec = this.validateSpec(body.spec, current);
    if (!fromDirectory) {
      const directory = (
        await tx.query(
          "SELECT identities FROM organization_directories WHERE workspace_id=$1",
          [actor.workspaceId],
        )
      ).rows[0];
      if (directory) {
        const identities = directory.identities as DirectoryIdentity[];
        for (const [kind, key] of [
          ["department", "departments"],
          ["role", "roles"],
          ["group", "roleGroups"],
        ] as const)
          for (const item of identities.filter((item) => item.kind === kind)) {
            if (
              directoryCanonical(
                spec[key].find((value) => value.id === item.targetId),
              ) !==
              directoryCanonical(
                current.spec[key].find((value) => value.id === item.targetId),
              )
            )
              throw new ConflictException("请在通讯录中修改已接入的部门和角色");
          }
        const owned = new Set(
          identities
            .filter((item) => item.kind === "department")
            .map((item) => item.targetId),
        );
        const memberships = (value: OrganizationSpec) =>
          value.assignments
            .map((item) => ({
              userId: item.userId,
              departmentIds: item.departmentIds.filter((id) => owned.has(id)),
              primaryDepartmentId: owned.has(item.primaryDepartmentId || "")
                ? item.primaryDepartmentId
                : null,
            }))
            .filter((item) => item.departmentIds.length)
            .sort((a, b) => a.userId.localeCompare(b.userId));
        if (
          directoryCanonical(memberships(spec)) !==
          directoryCanonical(memberships(current.spec))
        )
          throw new ConflictException("请在通讯录中调整已接入的成员部门");
      }
    }
    // A restored snapshot may predate retained audit events. Never reuse a
    // committed revision or discard history when saving that snapshot.
    const latestEvent = (
      await tx.query(
        "SELECT COALESCE(MAX(revision),0)::integer AS revision FROM organization_events WHERE workspace_id=$1",
        [actor.workspaceId],
      )
    ).rows[0].revision as number;
    const revision = Math.max(current.revision, latestEvent) + 1;
    await tx.query(
      "INSERT INTO workspace_organizations(workspace_id,revision,spec) VALUES($1,$2,$3) ON CONFLICT(workspace_id) DO UPDATE SET revision=$2,spec=$3,updated_at=now()",
      [actor.workspaceId, revision, spec],
    );
    await tx.query(
      "INSERT INTO organization_events(id,workspace_id,actor_id,revision,spec) VALUES($1,$2,$3,$4,$5)",
      [randomUUID(), actor.workspaceId, actor.id, revision, spec],
    );
    return {
      revision,
      spec,
      users: current.users,
    } satisfies ServerOrganization;
  }
}
