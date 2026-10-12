import { ConflictException, Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { MigrationResourcePlan } from "@platform/contracts";
import { Actor, requireAdmin } from "../../core/auth/auth.service";
import { Database, Transaction } from "../../core/database/database";
import { MigrationIdentityService } from "./migration-identities.service";
import { once } from "../processes/commands";
import { object } from "../../core/database/schema";
import { reviewMigrationRoles } from './migration-role-access';
import { canonicalMigration, migrationDigest, planMigrationResources, resourceSource } from "./migration-resource-plan";

@Injectable()
export class MigrationResourceService {
  constructor(private readonly db: Database, private readonly identities: MigrationIdentityService) {}
  private async latest(tx: Transaction, batchId: string) { return (await tx.query("SELECT * FROM migration_resource_snapshots WHERE batch_id=$1 ORDER BY revision DESC LIMIT 1", [batchId])).rows[0]; }
  private async dto(tx: Transaction, actor: Actor, batch: any, snapshot: any): Promise<MigrationResourcePlan | null> {
    if (!snapshot) return null;
    const review = await this.identities.reviewIn(tx, actor, batch);
    const latest = await this.latest(tx, batch.id);
    const roles = await reviewMigrationRoles(tx, actor, snapshot.payload, batch.choices);
    const rolesCurrent = snapshot.plan.roleAuthorization?.signature === roles.signature;
    const current = rolesCurrent && latest?.id === snapshot.id && snapshot.batch_revision === batch.revision && snapshot.source_fingerprint === batch.source.fingerprint && snapshot.identity_review_token === review.token;
    const imported = (await tx.query("SELECT application_id,imported_at FROM application_imports WHERE batch_id=$1", [batch.id])).rows[0];
    return { ...snapshot.plan, issues: [...snapshot.plan.issues, ...roles.issues.filter(issue => !snapshot.plan.issues.some((before: any) => before.message === issue.message && before.groupId === issue.groupId && before.version === issue.version))], id: snapshot.id, revision: snapshot.revision, batchId: batch.id, batchRevision: snapshot.batch_revision, sourceFingerprint: snapshot.source_fingerprint, sourceDigest: snapshot.source_digest, createdAt: snapshot.created_at.toISOString(), current, identityConfirmed: review.confirmationCurrent, importAvailable: !imported && current && review.confirmationCurrent && !snapshot.plan.issues.length, ...(imported ? { imported: { applicationId: imported.application_id, importedAt: imported.imported_at.toISOString() } } : {}) };
  }
  async get(actor: Actor, id: string) {
    requireAdmin(actor);
    return this.db.transaction(async tx => { const batch = await this.identities.lockedBatch(tx, actor, id); return { plan: await this.dto(tx, actor, batch, await this.latest(tx, id)) }; });
  }
  async prepare(actor: Actor, id: string, body: unknown) {
    requireAdmin(actor); object(body); const source = resourceSource(body.source);
    return this.db.transaction(async tx => {
      const snapshotId = await once(tx, actor, body.requestId, { resourcePreparation: id, body }, async () => {
        const batch = await this.identities.lockedBatch(tx, actor, id), previous = await this.latest(tx, id);
        if (body.expectedBatchRevision !== batch.revision || body.expectedResourceRevision !== (previous?.revision || 0)) throw new ConflictException("迁移批次或资源检查已更新，请重新读取，原应用内容保留。");
        if (source.namespace !== batch.source_namespace || source.applicationId !== batch.source_application_id || source.fingerprint !== batch.source.fingerprint) throw new ConflictException("资源与身份对应依据不同，请先更新来源清单。");
        const review = await this.identities.reviewIn(tx, actor, batch);
        const reserve = async (kind: string, parts: unknown[]) => {
          const key = JSON.stringify(canonicalMigration(parts));
          await tx.query("INSERT INTO migration_resource_keys(workspace_id,source_namespace,kind,source_key,target_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING", [actor.workspaceId, source.namespace, kind, key, randomUUID()]);
          return (await tx.query("SELECT target_id FROM migration_resource_keys WHERE workspace_id=$1 AND source_namespace=$2 AND kind=$3 AND source_key=$4", [actor.workspaceId, source.namespace, kind, key])).rows[0].target_id;
        };
        const roleReview = await reviewMigrationRoles(tx, actor, source, batch.choices);
        const result = await planMigrationResources(source, batch.choices, review, reserve, roleReview);
        for (const key of ["forms", "versions", "records", "rows"] as const) if (result.plan.totals[key] !== batch.source.counts[key]) throw new ConflictException("资源数量与身份来源盘点不一致，请重新检查来源；没有写入部分资源。");
        const snapshotId = randomUUID();
        await tx.query("INSERT INTO migration_resource_snapshots(id,batch_id,revision,batch_revision,source_fingerprint,source_digest,identity_review_token,payload,projection,plan,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)", [snapshotId, id, (previous?.revision || 0) + 1, batch.revision, source.fingerprint, migrationDigest(source), review.token, source, result.projection, result.plan, actor.id]);
        return snapshotId;
      });
      const batch = await this.identities.lockedBatch(tx, actor, id);
      const snapshot = (await tx.query("SELECT * FROM migration_resource_snapshots WHERE id=$1 AND batch_id=$2", [snapshotId, id])).rows[0];
      return this.dto(tx, actor, batch, snapshot);
    });
  }
}
