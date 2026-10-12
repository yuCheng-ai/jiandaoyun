import { createHash } from "node:crypto";
import {
  directoryCanonical,
  validateDirectory,
  type DirectoryIdentity,
  type DirectoryRole,
  type DirectorySpec,
  type MigrationIdentityChoice,
  type MigrationResourceIssue,
  type MigrationResourceSource,
} from "@platform/contracts";
import type { Actor } from "../../core/auth/auth.service";
import type { Database } from "../../core/database/database";

export interface MigrationRoleReview {
  signature: string;
  roleCount: number;
  issues: MigrationResourceIssue[];
}

/** Reuse the explicitly connected directory. Import must never overwrite roles or
 * materialize a second grant set, especially when a role also covers other apps. */
export async function reviewMigrationRoles(
  tx: Pick<Database, "query">,
  actor: Actor,
  source: MigrationResourceSource,
  choices: MigrationIdentityChoice[],
): Promise<MigrationRoleReview> {
  const row = (
    await tx.query(
      "SELECT source_namespace,spec,identities FROM organization_directories WHERE workspace_id=$1",
      [actor.workspaceId],
    )
  ).rows[0];
  const issues: MigrationResourceIssue[] = [];
  const issue = (message: string, groupId?: string) =>
    issues.push({
      kind: "mapping",
      formId: "",
      version: "角色应用授权",
      message,
      ...(groupId ? { groupId } : {}),
    });
  const formIds = new Set(source.forms.map((form) => form.id));
  const relevant = (role: DirectoryRole) =>
    role.grants.flatMap((grant) => {
      if (grant.appId === source.applicationId) return [grant];
      if (grant.appId !== "*") return [];
      if (!grant.formIds.length) return [grant];
      const selected = grant.formIds.filter((id) => formIds.has(id));
      return selected.length ? [{ ...grant, formIds: selected }] : [];
    });
  const spec = row?.spec as DirectorySpec | undefined;
  const current = (spec?.roles || []).filter((role) => relevant(role).length);
  const bindings: unknown[] = [];
  if (
    (!row || row.source_namespace !== source.namespace) &&
    (source.roles.length ||
      current.some((role) => role.grants.some((grant) => grant.appId === "*")))
  ) {
    issue("请先接入同一来源的通讯录并核对角色授权；本次未导入应用。");
  } else if (row?.source_namespace === source.namespace) {
    const seen = new Set<string>();
    const identities = row.identities as DirectoryIdentity[];
    const shape = (role: DirectoryRole) => ({
      id: role.id,
      memberIds: [...role.memberIds].sort(),
      departmentIds: [...role.departmentIds].sort(),
      includeChildren: role.includeChildren,
      archived: role.archived,
      grants: relevant(role)
        .map((grant) => ({
          ...grant,
          formIds: [...grant.formIds].sort(),
          actions: [...grant.actions].sort(),
        }))
        .sort((a, b) =>
          directoryCanonical(a).localeCompare(directoryCanonical(b)),
        ),
    });
    for (const raw of source.roles) {
      let role: DirectoryRole;
      try {
        role = validateDirectory({ ...spec, roles: [raw] }).roles[0]!;
      } catch {
        issue("来源角色配置不完整或引用已变化，请重新核对通讯录。");
        continue;
      }
      if (seen.has(role.id)) {
        issue("来源角色重复，不能合并授权。", role.id);
        continue;
      }
      seen.add(role.id);
      if (
        role.grants.some(
          (grant) =>
            grant.appId === source.applicationId &&
            grant.formIds.some((id) => !formIds.has(id)),
        )
      )
        issue(
          `「${role.name}」引用了本次应用包中缺失的表单，不能忽略该授权。`,
          role.id,
        );
      const target = spec!.roles.find((item) => item.id === role.id);
      const identity = identities.find(
        (item) => item.kind === "role" && item.id === role.id,
      );
      const choice = choices.find(
        (item) => item.kind === "role" && item.sourceId === role.id,
      );
      if (
        !target ||
        !identity ||
        choice?.mode !== "existing" ||
        choice.targetId !== identity.targetId
      ) {
        issue(
          `「${role.name}」尚未对应到当前通讯录角色，不能自动创建或启用授权。`,
          role.id,
        );
        continue;
      }
      if (directoryCanonical(shape(role)) !== directoryCanonical(shape(target)))
        issue(
          `「${role.name}」的成员或本应用授权与通讯录不一致，请重新读取来源后核对。`,
          role.id,
        );
      bindings.push({ role: shape(target), targetId: identity.targetId });
    }
    for (const role of current)
      if (!seen.has(role.id))
        issue(
          `来源缺少「${role.name}」的应用授权，包含全部应用的授权也必须保留。`,
          role.id,
        );
  }
  return {
    roleCount: current.length,
    issues,
    signature: createHash("sha256")
      .update(
        directoryCanonical({
          bindings: bindings.sort((a, b) =>
            directoryCanonical(a).localeCompare(directoryCanonical(b)),
          ),
          issues,
        }),
      )
      .digest("hex"),
  };
}
