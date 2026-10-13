import {
  organizationSubjectMembers,
  roleGrantMatches,
  type AccessPolicy,
  type DirectoryIdentity,
  type DirectorySpec,
  type ServerOrganization,
} from "@platform/contracts";
import type { Actor } from "../../core/auth/auth.service";
import type { Database } from "../../core/database/database";

type Queryable = Pick<Database, "query">;
export type RuntimePolicy = AccessPolicy & { allFormFields?: true };

/**
 * 查询工作空间下的应用与表单目录（包含迁移导入关联的来源应用 ID 与来源表单 ID）。
 * 注意：来源别名（sourceId）仅在应用完成完整迁移导入后才可被解析执行。
 */
export async function directoryApplications(
  tx: Queryable,
  actor: Actor,
  namespace: string | null,
  definitionId?: string,
) {
  const sql = `
    SELECT
      a.id AS application_id,
      a.title AS application_title,
      d.id,
      d.title,
      i.source_application_id,
      f.value->>'sourceId' AS source_form_id,
      COALESCE(g.config->>'mode' = 'groups', false) AS grouped
    FROM applications a
    LEFT JOIN definitions d ON d.application_id = a.id
    LEFT JOIN record_permission_groups g ON g.definition_id = d.id
    LEFT JOIN application_imports i
      ON i.application_id = a.id
      AND i.workspace_id = a.workspace_id
      AND i.source_namespace = $2
    LEFT JOIN migration_resource_snapshots s ON s.id = i.snapshot_id
    LEFT JOIN LATERAL jsonb_array_elements(s.projection->'forms') f(value)
      ON f.value->>'definitionId' = d.id::text
    WHERE a.workspace_id = $1
      AND ($3::uuid IS NULL OR d.id = $3)
    ORDER BY a.created_at, a.id, d.created_at, d.id
  `;
  const { rows } = await tx.query(sql, [actor.workspaceId, namespace, definitionId || null]);
  return rows;
}

/**
 * 实时读取当前通讯录中对指定用户生效的角色表单授权策略（不冗余持久化第二份授权副本）。
 */
export async function directoryRolePolicies(
  tx: Queryable,
  actor: Actor,
  organization: ServerOrganization,
  definitionId?: string,
): Promise<{ definitionId: string; policy: RuntimePolicy }[]> {
  const { rows } = await tx.query(
    "SELECT source_namespace, spec, identities FROM organization_directories WHERE workspace_id = $1",
    [actor.workspaceId],
  );
  const row = rows[0];
  if (!row) return [];

  const identities = row.identities as DirectoryIdentity[];
  const spec = row.spec as DirectorySpec;

  // 1. 筛选出当前用户所属且未归档的通讯录角色，并汇总其配置的权限规则
  const grants = spec.roles
    .filter((role) => {
      if (role.archived) return false;
      const target = identities.find((item) => item.kind === "role" && item.id === role.id);
      if (!target) return false;
      const memberIds = organizationSubjectMembers(organization.spec, {
        kind: "role",
        id: target.targetId,
      });
      return memberIds.includes(actor.id);
    })
    .flatMap((role) => role.grants)
    .filter((grant) => grant.actions.length > 0);

  if (grants.length === 0) return [];

  // 2. 将角色授权与实际应用/表单匹配，转换为运行时权限策略
  const forms = await directoryApplications(tx, actor, row.source_namespace, definitionId);

  return forms.flatMap((form) =>
    grants
      .filter(
        (grant) =>
          form.id &&
          roleGrantMatches(
            grant,
            form.application_id,
            form.id,
            form.source_application_id,
            form.source_form_id,
          ),
      )
      .map((grant) => ({
        definitionId: form.id,
        policy: {
          read: grant.actions.includes("view") || grant.actions.includes("manage"),
          create: grant.actions.includes("submit"),
          edit: grant.actions.includes("manage"),
          remove: grant.actions.includes("manage"),
          scope: grant.dataScope,
          fields: {},
          allFormFields: true as const,
        },
      })),
  );
}
