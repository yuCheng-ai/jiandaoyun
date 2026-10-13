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

/** 迁移角色授权核对结果 */
export interface MigrationRoleReview {
  signature: string;
  roleCount: number;
  issues: MigrationResourceIssue[];
}

/**
 * 筛选角色中与当前待迁移应用相关的授权项：
 * - 直接命中目标应用 ID 的授权；
 * - 全局通配（appId === "*"）且包含本次应用表单（或未限定表单）的授权。
 */
function getRelevantGrants(role: DirectoryRole, applicationId: string, formIds: Set<unknown>) {
  return role.grants.flatMap((grant) => {
    if (grant.appId === applicationId) return [grant];
    if (grant.appId !== "*") return [];
    if (!grant.formIds.length) return [grant];
    const selected = grant.formIds.filter((id) => formIds.has(id));
    return selected.length ? [{ ...grant, formIds: selected }] : [];
  });
}

/** 提取角色在当前应用范围内的标准化结构，用于与已接入通讯录角色做一致性比对 */
function buildRoleComparisonShape(role: DirectoryRole, applicationId: string, formIds: Set<unknown>) {
  const grants = getRelevantGrants(role, applicationId, formIds)
    .map((grant) => ({
      ...grant,
      formIds: [...grant.formIds].sort(),
      actions: [...grant.actions].sort(),
    }))
    .sort((a, b) => directoryCanonical(a).localeCompare(directoryCanonical(b)));

  return {
    id: role.id,
    memberIds: [...role.memberIds].sort(),
    departmentIds: [...role.departmentIds].sort(),
    includeChildren: role.includeChildren,
    archived: role.archived,
    grants,
  };
}

/**
 * 核对迁移资源包中的角色授权与当前已接入通讯录的一致性：
 * 复用已明确接入的通讯录角色，严禁在导入应用时覆盖现有角色或生成平行的第二套授权。
 */
export async function reviewMigrationRoles(
  tx: Pick<Database, "query">,
  actor: Actor,
  source: MigrationResourceSource,
  choices: MigrationIdentityChoice[],
): Promise<MigrationRoleReview> {
  const sql = `
    SELECT source_namespace, spec, identities
    FROM organization_directories
    WHERE workspace_id = $1
  `;
  const { rows } = await tx.query(sql, [actor.workspaceId]);
  const row = rows[0];

  const issues: MigrationResourceIssue[] = [];
  const reportIssue = (message: string, groupId?: string) => {
    issues.push({
      kind: "mapping",
      formId: "",
      version: "角色应用授权",
      message,
      ...(groupId ? { groupId } : {}),
    });
  };

  const formIds = new Set(source.forms.map((form) => form.id));
  const spec = row?.spec as DirectorySpec | undefined;
  const current = (spec?.roles || []).filter(
    (role) => getRelevantGrants(role, source.applicationId, formIds).length > 0,
  );
  const bindings: unknown[] = [];

  // 1. 校验是否已接入同一来源命名空间的通讯录
  const hasGlobalGrant = current.some((role) => role.grants.some((grant) => grant.appId === "*"));
  if ((!row || row.source_namespace !== source.namespace) && (source.roles.length || hasGlobalGrant)) {
    reportIssue("请先接入同一来源的通讯录并核对角色授权；本次未导入应用。");
  } else if (row?.source_namespace === source.namespace) {
    // 2. 逐一校验来源角色与当前通讯录角色的对应关系及授权内容
    const seen = new Set<string>();
    const identities = row.identities as DirectoryIdentity[];

    for (const raw of source.roles) {
      let role: DirectoryRole;
      try {
        role = validateDirectory({ ...spec, roles: [raw] }).roles[0]!;
      } catch {
        reportIssue("来源角色配置不完整或引用已变化，请重新核对通讯录。");
        continue;
      }

      if (seen.has(role.id)) {
        reportIssue("来源角色重复，不能合并授权。", role.id);
        continue;
      }
      seen.add(role.id);

      const hasMissingForm = role.grants.some(
        (grant) =>
          grant.appId === source.applicationId &&
          grant.formIds.some((id) => !formIds.has(id)),
      );
      if (hasMissingForm) {
        reportIssue(`「${role.name}」引用了本次应用包中缺失的表单，不能忽略该授权。`, role.id);
      }

      const target = spec!.roles.find((item) => item.id === role.id);
      const identity = identities.find((item) => item.kind === "role" && item.id === role.id);
      const choice = choices.find((item) => item.kind === "role" && item.sourceId === role.id);

      if (!target || !identity || choice?.mode !== "existing" || choice.targetId !== identity.targetId) {
        reportIssue(`「${role.name}」尚未对应到当前通讯录角色，不能自动创建或启用授权。`, role.id);
        continue;
      }

      const sourceShape = buildRoleComparisonShape(role, source.applicationId, formIds);
      const targetShape = buildRoleComparisonShape(target, source.applicationId, formIds);
      if (directoryCanonical(sourceShape) !== directoryCanonical(targetShape)) {
        reportIssue(`「${role.name}」的成员或本应用授权与通讯录不一致，请重新读取来源后核对。`, role.id);
      }

      bindings.push({ role: targetShape, targetId: identity.targetId });
    }

    // 3. 检查通讯录中是否还有未包含在来源包中的相关角色授权
    for (const role of current) {
      if (!seen.has(role.id)) {
        reportIssue(`来源缺少「${role.name}」的应用授权，包含全部应用的授权也必须保留。`, role.id);
      }
    }
  }

  const sortedBindings = bindings.sort((a, b) =>
    directoryCanonical(a).localeCompare(directoryCanonical(b)),
  );
  const signature = createHash("sha256")
    .update(directoryCanonical({ bindings: sortedBindings, issues }))
    .digest("hex");

  return {
    roleCount: current.length,
    issues,
    signature,
  };
}
