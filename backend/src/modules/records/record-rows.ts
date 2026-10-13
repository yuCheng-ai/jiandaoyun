import type { Database } from "../../core/database/database";

/**
 * 查询指定记录下每个子表明细行（subformId + rowId）最新的一条结构性变更事件（删除或恢复），
 * 防止恢复已被更新操作覆盖的旧删除快照。
 */
export async function latestRowEvents(tx: Pick<Database, "query">, recordId: string) {
  const sql = `
    SELECT DISTINCT ON (change->>'subformId', change->>'rowId')
      e.id,
      e.revision,
      e.created_at,
      change
    FROM record_events e
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(e.changes) = 'array' THEN e.changes ELSE '[]'::jsonb END
    ) AS change
    WHERE e.record_id = $1
      AND change->>'action' IN ('row-remove', 'row-restore')
    ORDER BY change->>'subformId', change->>'rowId', e.revision DESC
  `;
  const { rows } = await tx.query(sql, [recordId]);
  return rows;
}
