import { ConflictException } from "@nestjs/common";
import type { MigrationIdentityChoice, MigrationIdentitySource, OrganizationIdentity } from "@platform/contracts";
import type { Actor } from "./auth";
import type { Database, Transaction } from "./database";
type Queryable = Pick<Database, "query">;

/** Called inside the locked and verified identity-confirmation transaction. */
export async function retainHistoricalIdentities(tx: Transaction, actor: Actor, batch: { id: string; source: MigrationIdentitySource; choices: MigrationIdentityChoice[] }) {
  for (const choice of batch.choices.filter(item => item.mode === "historical")) {
    const identity = batch.source.identities.find(item => item.kind === choice.kind && item.sourceId === choice.sourceId)!;
    const reserved = (await tx.query("SELECT historical_id FROM migration_identity_keys WHERE workspace_id=$1 AND source_namespace=$2 AND kind=$3 AND source_id=$4", [actor.workspaceId, batch.source.namespace, choice.kind, choice.sourceId])).rows[0];
    if (!identity || reserved?.historical_id !== choice.targetId) throw new ConflictException("历史身份对应已变化，请重新检查后确认");
    await tx.query("INSERT INTO historical_identities(id,workspace_id,source_namespace,kind,source_id,name,first_batch_id) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO NOTHING", [choice.targetId, actor.workspaceId, batch.source.namespace, choice.kind, choice.sourceId, identity.name, batch.id]);
    const saved = (await tx.query("SELECT workspace_id,source_namespace,kind,source_id FROM historical_identities WHERE id=$1", [choice.targetId])).rows[0];
    if (saved.workspace_id !== actor.workspaceId || saved.source_namespace !== batch.source.namespace || saved.kind !== choice.kind || saved.source_id !== choice.sourceId) throw new ConflictException("历史身份来源不一致，未确认本次对应");
  }
}

/** Resolve only identities already exposed by readable cells, never a browsable archive directory. */
export async function historicalLabels(tx: Queryable, actor: Actor, labels: OrganizationIdentity[]): Promise<OrganizationIdentity[]> {
  const ids = labels.filter(item => !item.active).map(item => item.id);
  if (!ids.length) return labels;
  const rows = (await tx.query("SELECT id,kind,name FROM historical_identities WHERE workspace_id=$1 AND id::text=ANY($2::text[])", [actor.workspaceId, ids])).rows;
  return labels.map(item => {
    const found = rows.find(row => row.id === item.id && row.kind === item.kind);
    return found ? { ...item, name: found.name, active: false, historical: true } : item;
  });
}

export async function recordCreator(tx: Queryable, actor: Actor, id: string): Promise<OrganizationIdentity> {
  const row = (await tx.query("SELECT p.id,u.name,u.active,h.name AS historical_name FROM record_principals p LEFT JOIN users u ON u.id=p.user_id AND u.workspace_id=p.workspace_id LEFT JOIN historical_identities h ON h.id=p.historical_id AND h.workspace_id=p.workspace_id WHERE p.id=$1 AND p.workspace_id=$2", [id, actor.workspaceId])).rows[0];
  return { id, kind: "member", name: row?.historical_name || row?.name || "已不可用身份", active: !!row?.active, ...(row?.historical_name ? { historical: true } : {}) };
}
