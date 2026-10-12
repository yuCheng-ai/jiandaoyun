import type { Database } from "../../core/database/database";
/** One latest structural event per row prevents restoring an older deleted snapshot. */
export async function latestRowEvents(tx: Pick<Database, "query">, recordId: string) {
  return (await tx.query(`SELECT DISTINCT ON (change->>'subformId',change->>'rowId') e.id,e.revision,e.created_at,change
    FROM record_events e CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(e.changes)='array' THEN e.changes ELSE '[]'::jsonb END) AS change
    WHERE e.record_id=$1 AND change->>'action' IN ('row-remove','row-restore')
    ORDER BY change->>'subformId',change->>'rowId',e.revision DESC`, [recordId])).rows;
}
