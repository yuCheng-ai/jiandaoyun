import {
  BadRequestException,
  ConflictException,
  Injectable,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import {
  directoryCanonical,
  mergeDirectory,
  validateDirectory,
  type DirectoryIdentity,
  type DirectorySnapshot,
  type DirectorySpec,
  type OrganizationSpec,
  type RoleApplication,
} from "@platform/contracts";
import { type Actor, requireAdmin } from "../../core/auth/auth.service";
import { Database, type Transaction } from "../../core/database/database";
import { OrganizationService } from "./organization.service";
import { once } from "../processes/commands";
import { object, uuid } from "../../core/database/schema";
import { directoryApplications } from "./directory-grants";

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
  private parse(value: unknown) {
    try {
      return validateDirectory(value);
    } catch (error) {
      throw new BadRequestException((error as Error).message);
    }
  }
  async get(actor: Actor) {
    requireAdmin(actor);
    return this.db.transaction(async (tx) => {
      const org = await this.organizations.snapshot(tx, actor);
      requireAdmin(org.users.find((user) => user.id === actor.id)!);
      const row = (
        await tx.query(
          "SELECT * FROM organization_directories WHERE workspace_id=$1",
          [actor.workspaceId],
        )
      ).rows[0];
      return row ? dto(row) : null;
    });
  }
  async applications(actor: Actor): Promise<RoleApplication[]> {
    requireAdmin(actor);
    return this.db.transaction(async (tx) => {
      const row = (
        await tx.query(
          "SELECT source_namespace FROM organization_directories WHERE workspace_id=$1",
          [actor.workspaceId],
        )
      ).rows[0];
      const apps = new Map<string, RoleApplication>();
      for (const form of await directoryApplications(
        tx,
        actor,
        row?.source_namespace || null,
      )) {
        if (!apps.has(form.application_id))
          apps.set(form.application_id, {
            id: form.application_id,
            name: form.application_title,
            ...(form.source_application_id
              ? { sourceId: form.source_application_id }
              : {}),
            forms: [],
          });
        if (form.id)
          apps
            .get(form.application_id)!
            .forms.push({
              id: form.id,
              title: form.title,
              grouped: form.grouped,
              ...(form.source_form_id ? { sourceId: form.source_form_id } : {}),
            });
      }
      return [...apps.values()];
    });
  }
  async save(actor: Actor, body: unknown, initialize = false) {
    requireAdmin(actor);
    object(body);
    uuid(body.requestId);
    uuid(body.namespace);
    body.namespace = body.namespace.toLowerCase();
    const after = this.parse(body.spec),
      before = initialize ? undefined : this.parse(body.before);
    return this.db.transaction(async (tx) => {
      await this.organizations.lock(tx, actor.workspaceId, true);
      const organization = await this.organizations.snapshot(tx, actor);
      requireAdmin(organization.users.find((user) => user.id === actor.id)!);
      await once(
        tx,
        actor,
        body.requestId,
        { directory: body, initialize },
        async () => {
          const row = (
            await tx.query(
              "SELECT * FROM organization_directories WHERE workspace_id=$1 FOR UPDATE",
              [actor.workspaceId],
            )
          ).rows[0];
          if (initialize && row) {
            if (
              row.source_namespace !== body.namespace ||
              directoryCanonical(row.spec) !== directoryCanonical(after)
            )
              throw new ConflictException(
                "通讯录已接入，请重新读取；原资料不会被覆盖",
              );
            return body.requestId;
          }
          if (!initialize && (!row || row.source_namespace !== body.namespace))
            throw new ConflictException("通讯录来源已变化，请重新读取");
          let spec = after;
          if (row) {
            try {
              spec = mergeDirectory(row.spec, before!, after);
            } catch (error) {
              throw new ConflictException((error as Error).message);
            }
          }
          // Local application IDs remain preserved until import. New native references
          // are checked here, against the authoritative catalog rather than a browser cache.
          const nativeId = (id: string) =>
            /^[a-f0-9]{8}-[a-f0-9-]{27}$/i.test(id);
          const changedGrants = spec.roles.flatMap((role) =>
            role.grants.filter(
              (grant) =>
                !row?.spec.roles
                  .find((previous: any) => previous.id === role.id)
                  ?.grants.some(
                    (previous: any) =>
                      directoryCanonical(previous) ===
                      directoryCanonical(grant),
                  ),
            ),
          );
          if (
            changedGrants.some(
              (grant) => nativeId(grant.appId) || grant.formIds.some(nativeId),
            )
          ) {
            const catalog = await directoryApplications(
              tx,
              actor,
              body.namespace,
            );
            for (const grant of changedGrants) {
              const forms = catalog.filter(
                (form) =>
                  grant.appId === "*" ||
                  grant.appId === form.application_id ||
                  grant.appId === form.source_application_id,
              );
              if (
                (nativeId(grant.appId) && !forms.length) ||
                grant.formIds.some(
                  (id) =>
                    nativeId(id) &&
                    !forms.some(
                      (form) => form.id === id || form.source_form_id === id,
                    ),
                )
              )
                throw new BadRequestException(
                  "授权的应用或表单已不存在，请重新选择；当前修改尚未保存",
                );
            }
          }
          const identities: DirectoryIdentity[] = row?.identities || [];
          const batches = (
            await tx.query(
              "SELECT choices FROM migration_batches WHERE workspace_id=$1 AND source_namespace=$2 AND state='identities_confirmed'",
              [actor.workspaceId, body.namespace],
            )
          ).rows;
          for (const [kind, entries] of [
            ["department", spec.departments],
            ["role", spec.roles],
            ["group", spec.roleGroups],
          ] as const)
            for (const entry of entries) {
              if (
                identities.some(
                  (key) => key.kind === kind && key.id === entry.id,
                )
              )
                continue;
              const choices = batches
                .flatMap((batch) => batch.choices)
                .filter(
                  (choice) =>
                    choice.kind === kind && choice.sourceId === entry.id,
                );
              if (
                choices.some((choice) => choice.mode !== "existing") ||
                new Set(choices.map((choice) => choice.targetId)).size > 1
              )
                throw new ConflictException(
                  `「${entry.name}」已有不一致的历史身份决定，请先核对`,
                );
              const targetId = choices[0]?.targetId || randomUUID();
              if (identities.some((key) => key.targetId === targetId))
                throw new ConflictException("不同组织身份不能合并");
              if (
                batches.some((batch) =>
                  batch.choices.some(
                    (choice: any) =>
                      choice.kind === kind &&
                      choice.sourceId !== entry.id &&
                      choice.targetId === targetId,
                  ),
                )
              )
                throw new ConflictException(
                  "此组织身份已对应另一个来源，不能覆盖",
                );
              identities.push({ kind, id: entry.id, targetId });
            }
          const revision = (row?.revision || 0) + 1;
          await tx.query(
            "INSERT INTO organization_directories(workspace_id,source_namespace,revision,spec,identities,original_spec) VALUES($1,$2,$3,$4,$5,$4) ON CONFLICT(workspace_id) DO UPDATE SET revision=$3,spec=$4,identities=$5",
            [
              actor.workspaceId,
              body.namespace,
              revision,
              spec,
              JSON.stringify(identities),
            ],
          );
          await this.project(tx, actor);
          await tx.query(
            "INSERT INTO directory_events(id,workspace_id,actor_id,revision,spec) VALUES($1,$2,$3,$4,$5)",
            [randomUUID(), actor.workspaceId, actor.id, revision, spec],
          );
          return body.requestId;
        },
      );
      return dto(
        (
          await tx.query(
            "SELECT * FROM organization_directories WHERE workspace_id=$1",
            [actor.workspaceId],
          )
        ).rows[0],
      );
    });
  }

  /** Called in the same transaction after directory or account-association changes. */
  async project(tx: Transaction, actor: Actor) {
    const directory = (
      await tx.query(
        "SELECT * FROM organization_directories WHERE workspace_id=$1",
        [actor.workspaceId],
      )
    ).rows[0];
    if (!directory) return;
    const source = directory.spec as DirectorySpec,
      identities = directory.identities as DirectoryIdentity[];
    const current = await this.organizations.snapshot(tx, actor),
      spec: OrganizationSpec = structuredClone(current.spec);
    const links = (
      await tx.query(
        "SELECT member_id,account_id FROM member_accounts WHERE workspace_id=$1 AND source_namespace=$2",
        [actor.workspaceId, directory.source_namespace],
      )
    ).rows;
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
      new Set(
        identities
          .filter((key) => key.kind === kind)
          .map((key) => key.targetId),
      );
    const memberIds = (ids: string[]) =>
      ids.map((id) => accounts.get(id)).filter((id): id is string => !!id);
    spec.departments = [
      ...spec.departments.filter((item) => !owned("department").has(item.id)),
      ...source.departments.map((item) => ({
        ...item,
        id: target("department", item.id),
        parentId: item.parentId ? target("department", item.parentId) : null,
        managerIds: memberIds(item.managerIds),
      })),
    ];
    spec.roleGroups = [
      ...spec.roleGroups.filter((item) => !owned("group").has(item.id)),
      ...source.roleGroups.map((item) => ({
        ...item,
        id: target("group", item.id),
      })),
    ];
    spec.roles = [
      ...spec.roles.filter((item) => !owned("role").has(item.id)),
      ...source.roles.map(({ grants: _grants, ...item }) => ({
        ...item,
        id: target("role", item.id),
        groupId: target("group", item.groupId),
        memberIds: memberIds(item.memberIds),
        departmentIds: item.departmentIds
          .filter(
            (id) => !source.departments.find((d) => d.id === id)?.archived,
          )
          .map((id) => target("department", id)),
      })),
    ];
    const ownedDepartments = owned("department");
    spec.assignments = spec.assignments.map((item) => {
      const departmentIds = item.departmentIds.filter(
        (id) => !ownedDepartments.has(id),
      );
      return {
        ...item,
        departmentIds,
        primaryDepartmentId: departmentIds.includes(
          item.primaryDepartmentId || "",
        )
          ? item.primaryDepartmentId
          : departmentIds[0] || null,
      };
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
    // Leaving employment disables the linked login and removes existing sessions atomically.
    const inactive = links
      .filter((link) => !activeMembers.has(link.member_id))
      .map((link) => link.account_id);
    if (inactive.includes(actor.id))
      throw new ConflictException("不能停用当前登录账号所关联的成员");
    for (const id of inactive) {
      const account = (
        await tx.query(
          "UPDATE users SET active=false,account_revision=account_revision+1 WHERE id=$1 AND workspace_id=$2 AND active RETURNING account_revision",
          [id, actor.workspaceId],
        )
      ).rows[0];
      if (account)
        await tx.query(
          "INSERT INTO account_events(id,workspace_id,actor_id,account_id,revision,action,detail) VALUES($1,$2,$3,$4,$5,'updated',$6)",
          [
            randomUUID(),
            actor.workspaceId,
            actor.id,
            id,
            account.account_revision,
            { active: false, reason: "directory-status" },
          ],
        );
      await tx.query("DELETE FROM sessions WHERE user_id=$1", [id]);
    }
    if (directoryCanonical(spec) !== directoryCanonical(current.spec))
      await this.organizations.saveIn(
        tx,
        actor,
        { expectedRevision: current.revision, spec },
        true,
      );
  }
}
