import { BadRequestException, ConflictException, Injectable } from "@nestjs/common";
import {
  directoryCanonical,
  mergeDirectory,
  validateDirectory,
  type DirectoryIdentity,
  type DirectorySnapshot,
  type DirectorySpec,
  type OrganizationSpec,
} from "@platform/contracts";
import { randomUUID } from "node:crypto";
import { requireAdmin, type Actor } from "../../core/auth/auth.service";
import { once } from "../../core/database/commands";
import { Database, type Transaction } from "../../core/database/database";
import { object, uuid } from "../../core/validation";
import { OrganizationService } from "./organization.service";


/** 将数据库行转换为通讯录快照 DTO */
const dto = (row: any): DirectorySnapshot => ({
  namespace: row.source_namespace,
  revision: row.revision,
  spec: row.spec,
});

@Injectable()
export class DirectoryService {
  constructor(
    private readonly db: Database,
    private readonly organizations: OrganizationService,
  ) {}

  /** 校验并解析通讯录配置结构 */
  private parse(value: unknown) {
    try {
      return validateDirectory(value);
    } catch (error) {
      throw new BadRequestException((error as Error).message);
    }
  }

  /** 获取当前工作空间已接入的通讯录快照 */
  async get(actor: Actor) {
    requireAdmin(actor);
    return this.db.transaction(async (tx) => {
      const org = await this.organizations.snapshot(tx, actor);
      requireAdmin(org.users.find((user) => user.id === actor.id)!);

      const { rows } = await tx.query(
        "SELECT * FROM organization_directories WHERE workspace_id = $1",
        [actor.workspaceId],
      );
      return rows[0] ? dto(rows[0]) : null;
    });
  }

  /**
   * 接入或保存外部通讯录配置：
   * - 支持三方合并（before / current / after）；
   * - 原样保留历史角色授权资料，拒绝继续写入不参与执行的旧授权；
   * - 将通讯录中的部门、角色、角色组投影至工作空间组织架构。
   */
  async save(actor: Actor, body: unknown, initialize = false) {
    requireAdmin(actor);
    object(body);
    uuid(body.requestId);
    uuid(body.namespace);
    body.namespace = body.namespace.toLowerCase();

    const after = this.parse(body.spec);
    const before = initialize ? undefined : this.parse(body.before);

    return this.db.transaction(async (tx) => {
      await this.organizations.lock(tx, actor.workspaceId, true);
      const organization = await this.organizations.snapshot(tx, actor);
      requireAdmin(organization.users.find((user) => user.id === actor.id)!);

      await once(tx, actor, body.requestId, { directory: body, initialize }, async () => {
        const { rows } = await tx.query(
          "SELECT * FROM organization_directories WHERE workspace_id = $1 FOR UPDATE",
          [actor.workspaceId],
        );
        const row = rows[0];

        if (initialize && row) {
          if (
            row.source_namespace !== body.namespace ||
            directoryCanonical(row.spec) !== directoryCanonical(after)
          ) {
            throw new ConflictException("通讯录已接入，请重新读取；原资料不会被覆盖");
          }
          return body.requestId;
        }

        if (!initialize && (!row || row.source_namespace !== body.namespace)) {
          throw new ConflictException("通讯录来源已变化，请重新读取");
        }

        let spec = after;
        if (row) {
          try {
            spec = mergeDirectory(row.spec, before!, after);
          } catch (error) {
            throw new ConflictException((error as Error).message);
          }
        }

        // 授权只由表单权限组执行；旧资料可保留，但不能再制造无效的角色授权。
        const previousSpec = row?.spec as DirectorySpec | undefined;
        for (const role of spec.roles) {
          const previous = previousSpec?.roles.find((item) => item.id === role.id);
          if (directoryCanonical(role.grants) !== directoryCanonical(previous?.grants || [])) {
            throw new BadRequestException("角色授权请在表单权限组中设置");
          }
        }

        // 为新增的通讯录部门、角色、角色组分配稳定的工作空间身份 ID
        const identities: DirectoryIdentity[] = row?.identities || [];
        const entityGroups = [
          ["department", spec.departments],
          ["role", spec.roles],
          ["group", spec.roleGroups],
        ] as const;

        for (const [kind, entries] of entityGroups) {
          for (const entry of entries) {
            if (identities.some((key) => key.kind === kind && key.id === entry.id)) {
              continue;
            }
            identities.push({ kind, id: entry.id, targetId: randomUUID() });
          }
        }

        const revision = (row?.revision || 0) + 1;
        const upsertSql = `
          INSERT INTO organization_directories (
            workspace_id, source_namespace, revision, spec, identities, original_spec
          )
          VALUES ($1, $2, $3, $4, $5, $4)
          ON CONFLICT (workspace_id) DO UPDATE
          SET revision = $3, spec = $4, identities = $5
        `;
        await tx.query(upsertSql, [
          actor.workspaceId,
          body.namespace,
          revision,
          spec,
          JSON.stringify(identities),
        ]);

        await this.project(tx, actor);

        await tx.query(
          "INSERT INTO directory_events (id, workspace_id, actor_id, revision, spec) VALUES ($1, $2, $3, $4, $5)",
          [randomUUID(), actor.workspaceId, actor.id, revision, spec],
        );

        return body.requestId;
      });

      const { rows } = await tx.query(
        "SELECT * FROM organization_directories WHERE workspace_id = $1",
        [actor.workspaceId],
      );
      return dto(rows[0]);
    });
  }

  /**
   * 在通讯录变更或成员账号绑定变更的同一事务内，将通讯录数据投影同步到工作空间组织架构：
   * - 同步部门树、角色组、角色及在职成员的部门归属；
   * - 若成员变为离职/停用状态，自动停用其关联的登录账号并吊销会话。
   */
  async project(tx: Transaction, actor: Actor) {
    const { rows: dirRows } = await tx.query(
      "SELECT * FROM organization_directories WHERE workspace_id = $1",
      [actor.workspaceId],
    );
    const directory = dirRows[0];
    if (!directory) return;

    const source = directory.spec as DirectorySpec;
    const identities = directory.identities as DirectoryIdentity[];
    const current = await this.organizations.snapshot(tx, actor);
    const spec: OrganizationSpec = structuredClone(current.spec);

    const { rows: links } = await tx.query(
      "SELECT member_id, account_id FROM member_accounts WHERE workspace_id = $1 AND source_namespace = $2",
      [actor.workspaceId, directory.source_namespace],
    );

    const activeMembers = new Set(
      source.employees
        .filter((member) => member.status === "active")
        .map((member) => member.id),
    );
    const accounts = new Map<string, string>(
      links
        .filter((link) => activeMembers.has(link.member_id))
        .map((link) => [link.member_id, link.account_id]),
    );

    const target = (kind: DirectoryIdentity["kind"], id: string) =>
      identities.find((key) => key.kind === kind && key.id === id)!.targetId;

    const owned = (kind: DirectoryIdentity["kind"]) =>
      new Set(identities.filter((key) => key.kind === kind).map((key) => key.targetId));

    const memberIds = (ids: string[]) =>
      ids.map((id) => accounts.get(id)).filter((id): id is string => !!id);

    // 1. 投影部门、角色组与角色
    const ownedDepartments = owned("department");
    spec.departments = [
      ...spec.departments.filter((item) => !ownedDepartments.has(item.id)),
      ...source.departments.map((item) => ({
        ...item,
        id: target("department", item.id),
        parentId: item.parentId ? target("department", item.parentId) : null,
        managerIds: memberIds(item.managerIds),
      })),
    ];

    const ownedGroups = owned("group");
    spec.roleGroups = [
      ...spec.roleGroups.filter((item) => !ownedGroups.has(item.id)),
      ...source.roleGroups.map((item) => ({
        ...item,
        id: target("group", item.id),
      })),
    ];

    const ownedRoles = owned("role");
    spec.roles = [
      ...spec.roles.filter((item) => !ownedRoles.has(item.id)),
      ...source.roles.map(({ grants: _grants, ...item }) => ({
        ...item,
        id: target("role", item.id),
        groupId: target("group", item.groupId),
        memberIds: memberIds(item.memberIds),
        departmentIds: item.departmentIds
          .filter((id) => !source.departments.find((d) => d.id === id)?.archived)
          .map((id) => target("department", id)),
      })),
    ];

    // 2. 重新计算在职成员的部门归属
    spec.assignments = spec.assignments.map((item) => {
      const departmentIds = item.departmentIds.filter((id) => !ownedDepartments.has(id));
      const primaryDepartmentId = departmentIds.includes(item.primaryDepartmentId || "")
        ? item.primaryDepartmentId
        : departmentIds[0] || null;
      return { ...item, departmentIds, primaryDepartmentId };
    });

    for (const member of source.employees) {
      const userId = accounts.get(member.id);
      if (!userId) continue;

      let assignment = spec.assignments.find((item) => item.userId === userId);
      if (!assignment) {
        assignment = { userId, departmentIds: [], primaryDepartmentId: null };
        spec.assignments.push(assignment);
      }

      assignment.departmentIds = [
        ...new Set([
          ...assignment.departmentIds,
          ...member.departmentIds.map((id) => target("department", id)),
        ]),
      ];
      assignment.primaryDepartmentId = member.primaryDepartmentId
        ? target("department", member.primaryDepartmentId)
        : assignment.primaryDepartmentId;
    }

    // 3. 成员离职或停用时，原子停用其关联的登录账号并清除登录会话
    const inactive = links
      .filter((link) => !activeMembers.has(link.member_id))
      .map((link) => link.account_id);
    if (inactive.includes(actor.id)) {
      throw new ConflictException("不能停用当前登录账号所关联的成员");
    }

    for (const id of inactive) {
      const { rows } = await tx.query(
        "UPDATE users SET active = false, account_revision = account_revision + 1 WHERE id = $1 AND workspace_id = $2 AND active RETURNING account_revision",
        [id, actor.workspaceId],
      );
      const account = rows[0];
      if (account) {
        await tx.query(
          "INSERT INTO account_events (id, workspace_id, actor_id, account_id, revision, action, detail) VALUES ($1, $2, $3, $4, $5, 'updated', $6)",
          [
            randomUUID(),
            actor.workspaceId,
            actor.id,
            id,
            account.account_revision,
            { active: false, reason: "directory-status" },
          ],
        );
      }
      await tx.query("DELETE FROM sessions WHERE user_id = $1", [id]);
    }

    // 4. 若投影后的组织架构发生变化，持久化新版本
    if (directoryCanonical(spec) !== directoryCanonical(current.spec)) {
      await this.organizations.saveIn(
        tx,
        actor,
        { expectedRevision: current.revision, spec },
        true,
      );
    }
  }
}
