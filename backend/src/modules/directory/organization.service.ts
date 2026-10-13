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

/** 校验并解析部门或角色授权主体（GrantSubject） */
export function parseSubject(value: unknown): GrantSubject {
  object(value);
  uuid(value.id);
  if (
    !["department", "role"].includes(value.kind) ||
    (value.includeChildren !== undefined && typeof value.includeChildren !== "boolean")
  ) {
    throw new BadRequestException("授权对象不合法");
  }
  return {
    kind: value.kind,
    id: value.id,
    ...(value.kind === "department" ? { includeChildren: value.includeChildren === true } : {}),
  };
}

/** 校验授权主体对应的部门或角色在当前组织中存在且未归档 */
export function requireSubject(spec: OrganizationSpec, subject: GrantSubject) {
  const list = subject.kind === "department" ? spec.departments : spec.roles;
  const found = list.find((item) => item.id === subject.id && !item.archived);
  if (!found) {
    throw new BadRequestException("部门或角色不存在、已归档或不属于当前组织");
  }
  return found;
}

@Injectable()
export class OrganizationService {
  constructor(private readonly db: Database) {}

  /**
   * 获取工作空间组织架构的事务级咨询锁（Advisory Lock）：
   * - 依赖组织关系的写路径持有共享锁（shared）直至事务提交；
   * - 组织架构自身的修改持有排他锁（exclusive）。
   */
  async lock(tx: Queryable, workspaceId: string, exclusive = false) {
    const lockFn = exclusive ? "pg_advisory_xact_lock" : "pg_advisory_xact_lock_shared";
    await tx.query(`SELECT ${lockFn}(hashtextextended($1, 0))`, [`organization:${workspaceId}`]);
  }

  /** 读取当前工作空间的组织架构快照与全体成员账号列表，并校验当前操作人处于启用状态 */
  async snapshot(tx: Queryable, actor: Actor): Promise<ServerOrganization> {
    await this.lock(tx, actor.workspaceId);

    const { rows: orgRows } = await tx.query(
      "SELECT revision, spec FROM workspace_organizations WHERE workspace_id = $1",
      [actor.workspaceId],
    );
    const row = orgRows[0];

    const { rows: users } = await tx.query(
      "SELECT id, name, username, role, active, account_revision AS revision FROM users WHERE workspace_id = $1 ORDER BY id",
      [actor.workspaceId],
    );

    if (!users.some((user) => user.id === actor.id && user.active)) {
      throw new ForbiddenException("当前成员已停用或不属于此组织");
    }

    return {
      revision: row?.revision || 0,
      spec: row?.spec || emptyOrganizationSpec(),
      users,
    };
  }

  /** 获取组织架构详情（仅管理员可访问） */
  async get(actor: Actor) {
    requireAdmin(actor);
    return this.db.transaction((tx) => this.snapshot(tx, actor));
  }

  /** 解析指定部门或角色授权主体下的所有活跃成员列表 */
  async members(tx: Queryable, actor: Actor, subject: GrantSubject) {
    const organization = await this.snapshot(tx, actor);
    requireSubject(organization.spec, subject);
    const ids = new Set(organizationSubjectMembers(organization.spec, subject));
    return {
      organization,
      users: organization.users.filter((user) => user.active && ids.has(user.id)),
    };
  }

  /**
   * 校验组织架构配置（部门树、角色组、角色、成员部门归属）的完整性与业务约束：
   * - 部门层级不得成环，同级未归档部门不能重名；
   * - 角色组名称不能重复，同组未归档角色不能重名；
   * - 已有部门和角色只能归档，禁止直接物理删除其身份。
   */
  validateSpec(input: unknown, current: ServerOrganization): OrganizationSpec {
    object(input);
    for (const key of ["departments", "roleGroups", "roles", "assignments"]) {
      if (!Array.isArray(input[key]) || input[key].length > 1000) {
        throw new BadRequestException("组织结构不合法或超过 1000 项");
      }
    }

    const parseUniqueIds = (raw: unknown): string[] => {
      if (!Array.isArray(raw) || raw.length > 1000) {
        throw new BadRequestException("组织成员或部门范围不合法");
      }
      raw.forEach(uuid);
      if (new Set(raw).size !== raw.length) {
        throw new BadRequestException("组织引用不能重复");
      }
      return [...raw];
    };

    const spec: OrganizationSpec = {
      departments: input.departments.map((item: unknown) => {
        object(item);
        uuid(item.id);
        title(item.name);
        if (item.parentId !== null) uuid(item.parentId);
        if (typeof item.archived !== "boolean") {
          throw new BadRequestException("部门状态不合法");
        }
        return {
          id: item.id,
          name: item.name.trim(),
          parentId: item.parentId,
          archived: item.archived,
          managerIds: parseUniqueIds(item.managerIds || []),
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
        ) {
          throw new BadRequestException("角色配置不合法");
        }
        return {
          id: item.id,
          name: item.name.trim(),
          groupId: item.groupId,
          description: item.description,
          memberIds: parseUniqueIds(item.memberIds),
          departmentIds: parseUniqueIds(item.departmentIds),
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
          departmentIds: parseUniqueIds(item.departmentIds),
          primaryDepartmentId: item.primaryDepartmentId,
        };
      }),
    };

    for (const list of [spec.departments, spec.roleGroups, spec.roles]) {
      if (new Set(list.map((item) => item.id)).size !== list.length) {
        throw new BadRequestException("组织标识重复");
      }
    }
    if (new Set(spec.assignments.map((item) => item.userId)).size !== spec.assignments.length) {
      throw new BadRequestException("成员部门配置重复");
    }

    const users = new Set(current.users.map((user) => user.id));
    const departments = new Map(spec.departments.map((item) => [item.id, item]));

    for (const department of spec.departments) {
      if (department.managerIds?.some((id) => !users.has(id))) {
        throw new BadRequestException("部门负责人不属于当前组织");
      }

      const visited = new Set([department.id]);
      let parent = department.parentId;
      while (parent) {
        if (visited.has(parent)) {
          throw new BadRequestException("部门不能形成循环");
        }
        visited.add(parent);
        const next = departments.get(parent);
        if (!next || (!department.archived && next.archived)) {
          throw new BadRequestException("上级部门不存在或已归档");
        }
        parent = next.parentId;
      }

      const duplicateDeptName =
        !department.archived &&
        spec.departments.some(
          (other) =>
            other.id !== department.id &&
            !other.archived &&
            other.parentId === department.parentId &&
            other.name === department.name,
        );
      if (duplicateDeptName) {
        throw new BadRequestException("同级部门名称不能重复");
      }
    }

    const isActiveDepartment = (id: string) =>
      !!departments.get(id) && !departments.get(id)!.archived;

    for (const assignment of spec.assignments) {
      if (
        !users.has(assignment.userId) ||
        assignment.departmentIds.some((id) => !isActiveDepartment(id)) ||
        (assignment.primaryDepartmentId &&
          !assignment.departmentIds.includes(assignment.primaryDepartmentId)) ||
        !!assignment.departmentIds.length !== !!assignment.primaryDepartmentId
      ) {
        throw new BadRequestException("成员、部门或主部门配置不合法");
      }
    }

    for (const role of spec.roles) {
      if (
        !spec.roleGroups.some((group) => group.id === role.groupId) ||
        role.memberIds.some((id) => !users.has(id)) ||
        role.departmentIds.some((id) => !isActiveDepartment(id))
      ) {
        throw new BadRequestException("角色的成员、部门或角色组不属于当前组织");
      }

      const duplicateRoleName =
        !role.archived &&
        spec.roles.some(
          (other) =>
            other.id !== role.id &&
            !other.archived &&
            other.groupId === role.groupId &&
            other.name === role.name,
        );
      if (duplicateRoleName) {
        throw new BadRequestException("同组角色名称不能重复");
      }
    }

    if (new Set(spec.roleGroups.map((group) => group.name)).size !== spec.roleGroups.length) {
      throw new BadRequestException("角色组名称不能重复");
    }

    // 已发布的模板与审计历史依赖稳定的身份 ID，因此已有部门与角色只允许归档、不允许删除
    const removedDepartment = current.spec.departments.some((item) => !departments.has(item.id));
    const removedRole = current.spec.roles.some(
      (item) => !spec.roles.some((role) => role.id === item.id),
    );
    if (removedDepartment || removedRole) {
      throw new ConflictException("已有部门和角色请归档，不可直接删除其身份");
    }

    return spec;
  }

  /** 在独立事务中保存工作空间组织架构 */
  async save(actor: Actor, body: unknown) {
    return this.db.transaction((tx) => this.saveIn(tx, actor, body));
  }

  /**
   * 在给定事务内校验并保存组织架构配置：
   * - 若非来自通讯录投影（fromDirectory = false），禁止直接修改已由通讯录托管的部门、角色与成员部门关系；
   * - 递增版本号并写入组织变更审计事件。
   */
  async saveIn(tx: Transaction, actor: Actor, body: unknown, fromDirectory = false) {
    requireAdmin(actor);
    object(body);

    await this.lock(tx, actor.workspaceId, true);
    const current = await this.snapshot(tx, actor);
    requireAdmin(current.users.find((user) => user.id === actor.id)!);

    if (body.expectedRevision !== current.revision) {
      throw new ConflictException("组织配置已被修改，当前输入已保留；请重新读取后合并");
    }

    const spec = this.validateSpec(body.spec, current);

    if (!fromDirectory) {
      const { rows } = await tx.query(
        "SELECT identities FROM organization_directories WHERE workspace_id = $1",
        [actor.workspaceId],
      );
      const directory = rows[0];

      if (directory) {
        const identities = directory.identities as DirectoryIdentity[];
        const kindToKey = [
          ["department", "departments"],
          ["role", "roles"],
          ["group", "roleGroups"],
        ] as const;

        for (const [kind, key] of kindToKey) {
          for (const item of identities.filter((entry) => entry.kind === kind)) {
            const nextEntity = spec[key].find((value) => value.id === item.targetId);
            const prevEntity = current.spec[key].find((value) => value.id === item.targetId);
            if (directoryCanonical(nextEntity) !== directoryCanonical(prevEntity)) {
              throw new ConflictException("请在通讯录中修改已接入的部门和角色");
            }
          }
        }

        const ownedDeptIds = new Set(
          identities
            .filter((item) => item.kind === "department")
            .map((item) => item.targetId),
        );

        const memberships = (value: OrganizationSpec) =>
          value.assignments
            .map((item) => ({
              userId: item.userId,
              departmentIds: item.departmentIds.filter((id) => ownedDeptIds.has(id)),
              primaryDepartmentId: ownedDeptIds.has(item.primaryDepartmentId || "")
                ? item.primaryDepartmentId
                : null,
            }))
            .filter((item) => item.departmentIds.length > 0)
            .sort((a, b) => a.userId.localeCompare(b.userId));

        if (
          directoryCanonical(memberships(spec)) !== directoryCanonical(memberships(current.spec))
        ) {
          throw new ConflictException("请在通讯录中调整已接入的成员部门");
        }
      }
    }

    // 恢复快照后的版本号可能低于保留的审计事件最大版本号，取两者较大值 + 1 以保证版本号单调递增
    const { rows: eventRows } = await tx.query(
      "SELECT COALESCE(MAX(revision), 0)::integer AS revision FROM organization_events WHERE workspace_id = $1",
      [actor.workspaceId],
    );
    const latestEvent = eventRows[0].revision as number;
    const revision = Math.max(current.revision, latestEvent) + 1;

    const upsertSql = `
      INSERT INTO workspace_organizations (workspace_id, revision, spec)
      VALUES ($1, $2, $3)
      ON CONFLICT (workspace_id) DO UPDATE
      SET revision = $2, spec = $3, updated_at = now()
    `;
    await tx.query(upsertSql, [actor.workspaceId, revision, spec]);

    await tx.query(
      "INSERT INTO organization_events (id, workspace_id, actor_id, revision, spec) VALUES ($1, $2, $3, $4, $5)",
      [randomUUID(), actor.workspaceId, actor.id, revision, spec],
    );

    return {
      revision,
      spec,
      users: current.users,
    } satisfies ServerOrganization;
  }
}
