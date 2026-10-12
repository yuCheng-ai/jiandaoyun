import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { modelFormSchema, type FormSchema, type RecordOrigin } from "@platform/contracts";
import { Actor, requireAdmin } from "../../core/auth/auth.service";
import { Database, Transaction } from "../../core/database/database";
import { MigrationIdentityService } from "./migration-identities.service";
import { migrationDigest } from "./migration-resource-plan";
import { legacyRecordLifecycle } from "../records/legacy-record";
import { uuid } from "../../core/database/schema";

@Injectable()
export class RecordOriginService {
  constructor(private readonly db: Database, private readonly identities: MigrationIdentityService) {}
  /** Internal transaction primitive. Application/configuration import must precede this; no public partial-import route. */
  async importIn(tx: Transaction, actor: Actor, snapshotId: string, sourceRecordId: string) {
    return this.importRecordIn(tx, actor, await this.importContext(tx, actor, snapshotId), sourceRecordId);
  }
  async importSnapshotIn(tx: Transaction, actor: Actor, snapshotId: string) {
    const context = await this.importContext(tx, actor, snapshotId);
    for (const record of context.snapshot.projection.records) await this.importRecordIn(tx, actor, context, record.sourceId);
  }
  private async importContext(tx: Transaction, actor: Actor, snapshotId: string) {
    requireAdmin(actor); uuid(snapshotId);
    const snapshot = (await tx.query("SELECT s.* FROM migration_resource_snapshots s JOIN migration_batches b ON b.id=s.batch_id WHERE s.id=$1 AND b.workspace_id=$2", [snapshotId, actor.workspaceId])).rows[0];
    if (!snapshot) throw new NotFoundException("迁移资源快照不存在");
    const batch = await this.identities.lockedBatch(tx, actor, snapshot.batch_id), review = await this.identities.reviewIn(tx, actor, batch);
    const latest = (await tx.query("SELECT id FROM migration_resource_snapshots WHERE batch_id=$1 ORDER BY revision DESC LIMIT 1", [batch.id])).rows[0];
    if (!review.confirmationCurrent || batch.revision !== snapshot.batch_revision || latest.id !== snapshot.id || review.token !== snapshot.identity_review_token || batch.source.fingerprint !== snapshot.source_fingerprint) throw new ConflictException("迁移来源、身份或组织依据已变化，请重新检查");
    const index = (items: any[], key: string) => {
      const values = new Map<string, any[]>();
      for (const item of items) { const list = values.get(item[key]) || []; list.push(item); values.set(item[key], list); }
      return values;
    };
    return { snapshot, batch, records: index(snapshot.projection.records, "sourceId"), entries: index(snapshot.payload.entries, "id"), definitions: new Map<string, any>() };
  }
  private async importRecordIn(tx: Transaction, actor: Actor, context: Awaited<ReturnType<RecordOriginService["importContext"]>>, sourceRecordId: string) {
    const { snapshot, batch } = context, snapshotId = snapshot.id;
    const projected = context.records.get(sourceRecordId) || [], entries = context.entries.get(sourceRecordId) || [];
    if (projected.length !== 1 || entries.length !== 1) throw new ConflictException("记录没有唯一且通过检查的原版本转换结果");
    const record = projected[0], entry = entries[0], lifecycle = legacyRecordLifecycle(entry);
    const form = snapshot.projection.forms.find((f: any) => f.definitionId === record.definitionId), sourceForm = snapshot.payload.forms.find((f: any) => f.id === entry.formId);
    const projectedVersion = form?.versions.find((v: any) => v.version === record.version);
    const key = `${record.definitionId}/${record.version}`;
    let definition = context.definitions.get(key);
    if (!definition) {
      definition = (await tx.query("SELECT d.workspace_id,d.application_id,v.schema FROM definitions d JOIN definition_versions v ON v.definition_id=d.id AND v.version=$2 WHERE d.id=$1 FOR SHARE OF d", [record.definitionId, record.version])).rows[0];
      if (!definition || definition.workspace_id !== actor.workspaceId || definition.application_id !== snapshot.plan.targetApplicationId || !projectedVersion || migrationDigest(definition.schema) !== migrationDigest(modelFormSchema(projectedVersion.model))) throw new ConflictException("原发布数据结构尚未按检查结果导入，不能将旧记录写入另一份结构");
      context.definitions.set(key, definition);
    }
    const existing = (await tx.query("SELECT r.id,o.snapshot_id,o.source_record_id FROM records r LEFT JOIN record_origins o ON o.record_id=r.id WHERE r.id=$1 FOR UPDATE OF r", [record.targetId])).rows[0];
    if (existing) {
      if (existing.snapshot_id === snapshotId && existing.source_record_id === sourceRecordId) return record.targetId;
      throw new ConflictException("目标记录已有其他来源，未覆盖数据");
    }
    const sourceIdentity = (kind: string, id: string) => batch.source.identities.find((item: any) => item.kind === kind && item.sourceId === id);
    const sourceDepartments = entry.createdDepartmentIds === undefined ? null : entry.createdDepartmentIds.map((id: string, index: number) => ({ sourceId: id, name: sourceIdentity("department", id)?.name || "原部门名称未留存", targetId: record.createdDepartmentIds[index] }));
    const metadata = { ...lifecycle, sourceApplicationName: snapshot.payload.application.name || batch.source.applicationName, sourceFormName: sourceForm.title, sourceVersion: record.version, sourceCreatorName: sourceIdentity("member", entry.createdBy)?.name || "原创建者名称未留存", sourceDepartments };
    const revisions: Record<string, number> = {};
    for (const field of (definition.schema as FormSchema).fields) {
      if (field.type !== "subform") revisions[field.id] = 1;
      else { revisions[`@rows/${field.id}`] = 1; for (const row of record.values[field.id] || []) for (const child of field.children) revisions[`${field.id}/${row._rowId}/${child.id}`] = 1; }
    }
    await tx.query("INSERT INTO records(id,workspace_id,definition_id,definition_version,values,cell_revisions,created_by,created_department_ids,created_at,updated_at,archived_at,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)", [record.targetId, actor.workspaceId, record.definitionId, record.version, record.values, revisions, record.creatorId, record.createdDepartmentIds ?? null, lifecycle.createdAt, lifecycle.updatedAt || lifecycle.createdAt, lifecycle.deletedAt || null, lifecycle.status === "draft" ? "draft" : "active"]);
    await tx.query("INSERT INTO record_origins(record_id,workspace_id,snapshot_id,source_form_id,source_record_id,metadata,imported_by) VALUES($1,$2,$3,$4,$5,$6,$7)", [record.targetId, actor.workspaceId, snapshotId, entry.formId, entry.id, metadata, actor.id]);
    await tx.query("INSERT INTO record_events(id,record_id,actor_id,revision,changes) VALUES($1,$2,$3,1,$4)", [randomUUID(), record.targetId, actor.id, { action: "import", snapshotId, sourceRecordId }]);
    return record.targetId;
  }
  async get(actor: Actor, recordId: string): Promise<RecordOrigin> {
    // Original free-text history has no field/row permissions. Do not leak it through masked task or member responses.
    requireAdmin(actor); uuid(recordId);
    const origin = (await this.db.query("SELECT * FROM record_origins WHERE record_id=$1 AND workspace_id=$2", [recordId, actor.workspaceId])).rows[0];
    if (!origin) throw new NotFoundException("此记录没有迁移来源档案");
    return { ...origin.metadata, sourceRecordId: origin.source_record_id, sourceFormId: origin.source_form_id, importedBy: origin.imported_by, importedAt: origin.imported_at.toISOString() };
  }
}
