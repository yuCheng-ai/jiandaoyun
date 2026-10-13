import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { modelFormSchema, type FormSchema, type RecordOrigin } from "@platform/contracts";
import { Actor, requireAdmin } from "../../core/auth/auth.service";
import { Database, Transaction } from "../../core/database/database";
import { MigrationIdentityService } from "./migration-identities.service";
import { migrationDigest } from "./migration-resource-plan";
import { legacyRecordLifecycle } from "../records/legacy-record";
import { uuid } from "../../core/database/schema";

/** 按指定字段名对数组元素建立分组索引 */
function groupByKey(items: any[], key: string): Map<string, any[]> {
  const values = new Map<string, any[]>();
  for (const item of items) {
    const list = values.get(item[key]) || [];
    list.push(item);
    values.set(item[key], list);
  }
  return values;
}

/**
 * 历史记录来源与导入服务：
 * 负责将通过检查的历史记录快照写入正式记录表，并保存记录的原始迁移档案。
 */
@Injectable()
export class RecordOriginService {
  constructor(
    private readonly db: Database,
    private readonly identities: MigrationIdentityService,
  ) {}

  /** 内部事务原语：按快照导入单条记录（需在应用与配置导入完成后调用） */
  async importIn(tx: Transaction, actor: Actor, snapshotId: string, sourceRecordId: string) {
    const context = await this.importContext(tx, actor, snapshotId);
    return this.importRecordIn(tx, actor, context, sourceRecordId);
  }

  /** 内部事务原语：按快照批量导入全部历史记录 */
  async importSnapshotIn(tx: Transaction, actor: Actor, snapshotId: string) {
    const context = await this.importContext(tx, actor, snapshotId);
    for (const record of context.snapshot.projection.records) {
      await this.importRecordIn(tx, actor, context, record.sourceId);
    }
  }

  /** 校验并构建记录导入所需的快照、批次与索引上下文 */
  private async importContext(tx: Transaction, actor: Actor, snapshotId: string) {
    requireAdmin(actor);
    uuid(snapshotId);

    const snapshotSql = `
      SELECT s.*
      FROM migration_resource_snapshots s
      JOIN migration_batches b ON b.id = s.batch_id
      WHERE s.id = $1 AND b.workspace_id = $2
    `;
    const { rows: snapshotRows } = await tx.query(snapshotSql, [snapshotId, actor.workspaceId]);
    const snapshot = snapshotRows[0];
    if (!snapshot) {
      throw new NotFoundException("迁移资源快照不存在");
    }

    const batch = await this.identities.lockedBatch(tx, actor, snapshot.batch_id);
    const review = await this.identities.reviewIn(tx, actor, batch);

    const latestSql = `
      SELECT id
      FROM migration_resource_snapshots
      WHERE batch_id = $1
      ORDER BY revision DESC
      LIMIT 1
    `;
    const { rows: latestRows } = await tx.query(latestSql, [batch.id]);
    const latest = latestRows[0];

    if (
      !review.confirmationCurrent ||
      batch.revision !== snapshot.batch_revision ||
      latest.id !== snapshot.id ||
      review.token !== snapshot.identity_review_token ||
      batch.source.fingerprint !== snapshot.source_fingerprint
    ) {
      throw new ConflictException("迁移来源、身份或组织依据已变化，请重新检查");
    }

    return {
      snapshot,
      batch,
      records: groupByKey(snapshot.projection.records, "sourceId"),
      entries: groupByKey(snapshot.payload.entries, "id"),
      definitions: new Map<string, any>(),
    };
  }

  /** 校验单条记录的目标版本结构并写入 records、record_origins 与 record_events */
  private async importRecordIn(
    tx: Transaction,
    actor: Actor,
    context: Awaited<ReturnType<RecordOriginService["importContext"]>>,
    sourceRecordId: string,
  ) {
    const { snapshot, batch } = context;
    const snapshotId = snapshot.id;

    const projected = context.records.get(sourceRecordId) || [];
    const entries = context.entries.get(sourceRecordId) || [];
    if (projected.length !== 1 || entries.length !== 1) {
      throw new ConflictException("记录没有唯一且通过检查的原版本转换结果");
    }

    const record = projected[0];
    const entry = entries[0];
    const lifecycle = legacyRecordLifecycle(entry);

    const form = snapshot.projection.forms.find((f: any) => f.definitionId === record.definitionId);
    const sourceForm = snapshot.payload.forms.find((f: any) => f.id === entry.formId);
    const projectedVersion = form?.versions.find((v: any) => v.version === record.version);

    // 1. 校验目标表单定义版本是否已按预期结构导入
    const key = `${record.definitionId}/${record.version}`;
    let definition = context.definitions.get(key);
    if (!definition) {
      const defSql = `
        SELECT d.workspace_id, d.application_id, v.schema
        FROM definitions d
        JOIN definition_versions v ON v.definition_id = d.id AND v.version = $2
        WHERE d.id = $1
        FOR SHARE OF d
      `;
      const { rows: defRows } = await tx.query(defSql, [record.definitionId, record.version]);
      definition = defRows[0];

      if (
        !definition ||
        definition.workspace_id !== actor.workspaceId ||
        definition.application_id !== snapshot.plan.targetApplicationId ||
        !projectedVersion ||
        migrationDigest(definition.schema) !== migrationDigest(modelFormSchema(projectedVersion.model))
      ) {
        throw new ConflictException("原发布数据结构尚未按检查结果导入，不能将旧记录写入另一份结构");
      }
      context.definitions.set(key, definition);
    }

    // 2. 检查目标记录是否已存在（支持同一快照幂等重入，拒绝不同来源覆盖）
    const existingSql = `
      SELECT r.id, o.snapshot_id, o.source_record_id
      FROM records r
      LEFT JOIN record_origins o ON o.record_id = r.id
      WHERE r.id = $1
      FOR UPDATE OF r
    `;
    const { rows: existingRows } = await tx.query(existingSql, [record.targetId]);
    const existing = existingRows[0];
    if (existing) {
      if (existing.snapshot_id === snapshotId && existing.source_record_id === sourceRecordId) {
        return record.targetId;
      }
      throw new ConflictException("目标记录已有其他来源，未覆盖数据");
    }

    // 3. 组装原始身份与来源档案元数据
    const findSourceIdentity = (kind: string, id: string) =>
      batch.source.identities.find((item: any) => item.kind === kind && item.sourceId === id);

    const sourceDepartments =
      entry.createdDepartmentIds === undefined
        ? null
        : entry.createdDepartmentIds.map((id: string, index: number) => ({
            sourceId: id,
            name: findSourceIdentity("department", id)?.name || "原部门名称未留存",
            targetId: record.createdDepartmentIds[index],
          }));

    const metadata = {
      ...lifecycle,
      sourceApplicationName: snapshot.payload.application.name || batch.source.applicationName,
      sourceFormName: sourceForm.title,
      sourceVersion: record.version,
      sourceCreatorName: findSourceIdentity("member", entry.createdBy)?.name || "原创建者名称未留存",
      sourceDepartments,
    };

    // 4. 初始化单元格版本号（主表字段与子表行列）
    const revisions: Record<string, number> = {};
    for (const field of (definition.schema as FormSchema).fields) {
      if (field.type !== "subform") {
        revisions[field.id] = 1;
      } else {
        revisions[`@rows/${field.id}`] = 1;
        for (const row of record.values[field.id] || []) {
          for (const child of field.children) {
            revisions[`${field.id}/${row._rowId}/${child.id}`] = 1;
          }
        }
      }
    }

    // 5. 写入记录主体、来源档案与导入事件
    const insertRecordSql = `
      INSERT INTO records (
        id, workspace_id, definition_id, definition_version, values, cell_revisions,
        created_by, created_department_ids, created_at, updated_at, archived_at, state
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
    `;
    await tx.query(insertRecordSql, [
      record.targetId,
      actor.workspaceId,
      record.definitionId,
      record.version,
      record.values,
      revisions,
      record.creatorId,
      record.createdDepartmentIds ?? null,
      lifecycle.createdAt,
      lifecycle.updatedAt || lifecycle.createdAt,
      lifecycle.deletedAt || null,
      lifecycle.status === "draft" ? "draft" : "active",
    ]);

    const insertOriginSql = `
      INSERT INTO record_origins (
        record_id, workspace_id, snapshot_id, source_form_id, source_record_id, metadata, imported_by
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `;
    await tx.query(insertOriginSql, [
      record.targetId,
      actor.workspaceId,
      snapshotId,
      entry.formId,
      entry.id,
      metadata,
      actor.id,
    ]);

    const insertEventSql = `
      INSERT INTO record_events (id, record_id, actor_id, revision, changes)
      VALUES ($1, $2, $3, 1, $4)
    `;
    await tx.query(insertEventSql, [
      randomUUID(),
      record.targetId,
      actor.id,
      { action: "import", snapshotId, sourceRecordId },
    ]);

    return record.targetId;
  }

  /**
   * 获取指定记录的迁移来源档案：
   * 原始自由文本历史不受字段/行级权限掩码保护，仅限管理员查看，防止通过普通成员接口泄露。
   */
  async get(actor: Actor, recordId: string): Promise<RecordOrigin> {
    requireAdmin(actor);
    uuid(recordId);

    const sql = `
      SELECT *
      FROM record_origins
      WHERE record_id = $1 AND workspace_id = $2
    `;
    const { rows } = await this.db.query(sql, [recordId, actor.workspaceId]);
    const origin = rows[0];
    if (!origin) {
      throw new NotFoundException("此记录没有迁移来源档案");
    }

    return {
      ...origin.metadata,
      sourceRecordId: origin.source_record_id,
      sourceFormId: origin.source_form_id,
      importedBy: origin.imported_by,
      importedAt: origin.imported_at.toISOString(),
    };
  }
}
