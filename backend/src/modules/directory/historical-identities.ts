import { ConflictException } from "@nestjs/common";
import type {
  MigrationIdentityChoice,
  MigrationIdentitySource,
  OrganizationIdentity,
} from "@platform/contracts";
import type { Actor } from "../../core/auth/auth.service";
import type { Database, Transaction } from "../../core/database/database";

type Queryable = Pick<Database, "query">;

/**
 * 在身份确认事务（已加锁并完成校验）中，将用户选择保留为“独立历史身份”的条目写入历史身份表。
 */
export async function retainHistoricalIdentities(
  tx: Transaction,
  actor: Actor,
  batch: { id: string; source: MigrationIdentitySource; choices: MigrationIdentityChoice[] },
) {
  const historicalChoices = batch.choices.filter((item) => item.mode === "historical");

  for (const choice of historicalChoices) {
    const identity = batch.source.identities.find(
      (item) => item.kind === choice.kind && item.sourceId === choice.sourceId,
    )!;

    const reserveSql = `
      SELECT historical_id
      FROM migration_identity_keys
      WHERE workspace_id = $1
        AND source_namespace = $2
        AND kind = $3
        AND source_id = $4
    `;
    const { rows: reservedRows } = await tx.query(reserveSql, [
      actor.workspaceId,
      batch.source.namespace,
      choice.kind,
      choice.sourceId,
    ]);
    const reserved = reservedRows[0];

    if (!identity || reserved?.historical_id !== choice.targetId) {
      throw new ConflictException("历史身份对应已变化，请重新检查后确认");
    }

    const insertSql = `
      INSERT INTO historical_identities (
        id, workspace_id, source_namespace, kind, source_id, name, first_batch_id
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (id) DO NOTHING
    `;
    await tx.query(insertSql, [
      choice.targetId,
      actor.workspaceId,
      batch.source.namespace,
      choice.kind,
      choice.sourceId,
      identity.name,
      batch.id,
    ]);

    const { rows: savedRows } = await tx.query(
      "SELECT workspace_id, source_namespace, kind, source_id FROM historical_identities WHERE id = $1",
      [choice.targetId],
    );
    const saved = savedRows[0];

    if (
      saved.workspace_id !== actor.workspaceId ||
      saved.source_namespace !== batch.source.namespace ||
      saved.kind !== choice.kind ||
      saved.source_id !== choice.sourceId
    ) {
      throw new ConflictException("历史身份来源不一致，未确认本次对应");
    }
  }
}

/**
 * 仅针对可读单元格中已暴露的非活跃身份 ID 解析其历史身份名称（不提供可遍历的历史身份归档目录）。
 */
export async function historicalLabels(
  tx: Queryable,
  actor: Actor,
  labels: OrganizationIdentity[],
): Promise<OrganizationIdentity[]> {
  const ids = labels.filter((item) => !item.active).map((item) => item.id);
  if (!ids.length) return labels;

  const sql = `
    SELECT id, kind, name
    FROM historical_identities
    WHERE workspace_id = $1
      AND id::text = ANY($2::text[])
  `;
  const { rows } = await tx.query(sql, [actor.workspaceId, ids]);

  return labels.map((item) => {
    const found = rows.find((row) => row.id === item.id && row.kind === item.kind);
    if (!found) return item;
    return { ...item, name: found.name, active: false, historical: true };
  });
}

/**
 * 解析记录创建人身份标签（优先识别历史迁移身份，其次为当前组织成员，若均不存在则回退为“已不可用身份”）。
 */
export async function recordCreator(
  tx: Queryable,
  actor: Actor,
  id: string,
): Promise<OrganizationIdentity> {
  const sql = `
    SELECT
      p.id,
      u.name,
      u.active,
      h.name AS historical_name
    FROM record_principals p
    LEFT JOIN users u
      ON u.id = p.user_id AND u.workspace_id = p.workspace_id
    LEFT JOIN historical_identities h
      ON h.id = p.historical_id AND h.workspace_id = p.workspace_id
    WHERE p.id = $1
      AND p.workspace_id = $2
  `;
  const { rows } = await tx.query(sql, [id, actor.workspaceId]);
  const row = rows[0];

  return {
    id,
    kind: "member",
    name: row?.historical_name || row?.name || "已不可用身份",
    active: !!row?.active,
    ...(row?.historical_name ? { historical: true } : {}),
  };
}
