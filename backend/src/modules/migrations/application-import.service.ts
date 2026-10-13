import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { modelFormSchema } from "@platform/contracts";
import { Actor, requireAdmin } from "../../core/auth/auth.service";
import { Database, Transaction } from "../../core/database/database";
import { object, title, uuid } from "../../core/database/schema";
import { GroupConfigurationService } from "../access/group-config.service";
import { PlatformService } from "../pages/platform.service";
import { once } from "../processes/commands";
import { CollectionService } from "../records/collection.service";
import { RecordViewService } from "../records/record-views.service";
import { MigrationIdentityService } from "./migration-identities.service";
import {
  canonicalMigration,
  migrationDigest,
  planMigrationResources,
  resourceSource,
} from "./migration-resource-plan";
import { reviewMigrationRoles } from "./migration-role-access";
import { RecordOriginService } from "./record-origins.service";

/** 校验时间字符串是否为有效的时间戳格式 */
function assertValidTimestamp(value: unknown): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new ConflictException("来源时间无效，未保留部分导入结果");
  }
  return value;
}

/**
 * 应用全量导入服务：
 * 依据已通过检查的资源快照，在单一事务内原子化导入目标应用、表单定义、历史版本、页面布局、权限配置及历史记录。
 */
@Injectable()
export class ApplicationImportService {
  constructor(
    private readonly db: Database,
    private readonly identities: MigrationIdentityService,
    private readonly records: RecordOriginService,
    private readonly groups: GroupConfigurationService,
    private readonly collection: CollectionService,
    private readonly platform: PlatformService,
    private readonly recordViews: RecordViewService,
  ) {}

  /** 查询应用导入完成后的回执信息 */
  private async receipt(tx: Transaction, actor: Actor, applicationId: string) {
    const sql = `
      SELECT application_id, snapshot_id, counts, imported_at
      FROM application_imports
      WHERE application_id = $1 AND workspace_id = $2
    `;
    const { rows } = await tx.query(sql, [applicationId, actor.workspaceId]);
    const row = rows[0];
    if (!row) {
      throw new NotFoundException("应用导入结果不存在");
    }

    return {
      applicationId: row.application_id,
      snapshotId: row.snapshot_id,
      counts: row.counts,
      importedAt: row.imported_at.toISOString(),
    };
  }

  /** 执行应用全量导入（支持幂等重入，若快照或身份依据已变化则拒绝执行并回滚） */
  async apply(actor: Actor, id: string, body: unknown) {
    requireAdmin(actor);
    object(body);
    uuid(body.snapshotId);

    return this.db.transaction(async (tx) => {
      const applicationId = await once(
        tx,
        actor,
        body.requestId,
        { applicationImport: id, body },
        async () => {
          const batch = await this.identities.lockedBatch(tx, actor, id);

          // 1. 幂等检查：若该批次已导入过相同快照与摘要，直接返回已导入的应用 ID
          const prevSql = `
            SELECT application_id, snapshot_id, source_digest
            FROM application_imports
            WHERE batch_id = $1
          `;
          const { rows: prevRows } = await tx.query(prevSql, [id]);
          const previous = prevRows[0];
          if (previous) {
            if (
              previous.snapshot_id !== body.snapshotId ||
              previous.source_digest !== body.sourceDigest
            ) {
              throw new ConflictException("此来源应用已导入，不能用另一份快照覆盖现有应用");
            }
            return previous.application_id;
          }

          // 2. 校验最新资源快照与当前批次版本、身份确认令牌是否完全匹配
          const snapshotSql = `
            SELECT *
            FROM migration_resource_snapshots
            WHERE batch_id = $1
            ORDER BY revision DESC
            LIMIT 1
          `;
          const { rows: snapshotRows } = await tx.query(snapshotSql, [id]);
          const snapshot = snapshotRows[0];

          const isSnapshotStale =
            !snapshot ||
            snapshot.id !== body.snapshotId ||
            snapshot.revision !== body.expectedResourceRevision ||
            batch.revision !== body.expectedBatchRevision ||
            snapshot.batch_revision !== batch.revision ||
            snapshot.source_digest !== body.sourceDigest;
          if (isSnapshotStale) {
            throw new ConflictException("导入依据已变化，请重新检查；原应用保留");
          }

          const review = await this.identities.reviewIn(tx, actor, batch);
          if (
            !review.confirmationCurrent ||
            snapshot.identity_review_token !== review.token ||
            snapshot.source_fingerprint !== batch.source.fingerprint
          ) {
            throw new ConflictException("来源或身份对应已变化，请重新检查；原应用保留");
          }

          const source = resourceSource(snapshot.payload);
          if (migrationDigest(source) !== snapshot.source_digest) {
            throw new ConflictException("资源快照校验失败，未写入目标应用");
          }

          // 3. 重新演算资源转换计划，确保转换规则与预留的目标资源 ID 完全一致
          const reserve = async (kind: string, parts: unknown[]) => {
            const keySql = `
              SELECT target_id
              FROM migration_resource_keys
              WHERE workspace_id = $1 AND source_namespace = $2 AND kind = $3 AND source_key = $4
            `;
            const { rows } = await tx.query(keySql, [
              actor.workspaceId,
              source.namespace,
              kind,
              JSON.stringify(canonicalMigration(parts)),
            ]);
            const row = rows[0];
            if (!row) {
              throw new ConflictException("资源对应不完整，请重新检查；没有生成替代身份");
            }
            return row.target_id;
          };

          const roleReview = await reviewMigrationRoles(tx, actor, source, batch.choices);
          const checked = await planMigrationResources(
            source,
            batch.choices,
            review,
            reserve,
            roleReview,
          );
          if (checked.plan.issues.length) {
            throw new ConflictException(
              checked.plan.issues.map((item) => item.message).join("；"),
            );
          }

          const isDigestMismatch =
            migrationDigest(checked.projection) !== migrationDigest(snapshot.projection) ||
            migrationDigest(checked.plan) !== migrationDigest(snapshot.plan);
          if (isDigestMismatch) {
            throw new ConflictException("转换规则已更新，请重新生成资源检查后导入");
          }

          // 4. 创建目标应用
          const appId = checked.plan.targetApplicationId;
          const existingApp = await tx.query("SELECT 1 FROM applications WHERE id = $1", [appId]);
          if (existingApp.rowCount) {
            throw new ConflictException("目标应用已存在，未覆盖原有内容");
          }

          title(source.application.name);
          const insertAppSql = `
            INSERT INTO applications (id, workspace_id, title, appearance)
            VALUES ($1, $2, $3, $4)
          `;
          await tx.query(insertAppSql, [
            appId,
            actor.workspaceId,
            source.application.name,
            {
              color: source.application.color,
              icon: source.application.icon,
              folders: source.application.folders || [],
              description: source.application.description || "",
            },
          ]);

          // 5. 逐个导入表单定义、历史发布版本、页面草稿、字段回收站、视图配置与权限配置
          for (const form of checked.projection.forms) {
            const original = source.forms.find((item) => item.id === form.sourceId)!;
            const published = form.versions.find(
              (version: any) => version.version === form.publishedVersion,
            );
            const version = form.publishedVersion || 0;
            title(original.title);

            // 保持已发布的数据模型基线与可编辑的表单草稿分离
            const model = published?.model || form.draft.model;
            const insertDefSql = `
              INSERT INTO definitions (
                id, workspace_id, application_id, title, draft, model_draft, latest_version, created_at
              )
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            `;
            await tx.query(insertDefSql, [
              form.definitionId,
              actor.workspaceId,
              appId,
              original.title,
              modelFormSchema(model),
              model,
              version,
              assertValidTimestamp(original.createdAt),
            ]);

            for (const historical of form.versions) {
              title(historical.title);
              const historicalSchema = modelFormSchema(historical.model);
              await this.platform.validateStableFields(tx, form.definitionId, historicalSchema);

              const insertDefVerSql = `
                INSERT INTO definition_versions (definition_id, version, title, schema, created_at)
                VALUES ($1, $2, $3, $4, $5)
              `;
              await tx.query(insertDefVerSql, [
                form.definitionId,
                historical.version,
                historical.title,
                historicalSchema,
                assertValidTimestamp(historical.publishedAt),
              ]);

              const insertObjVerSql = `
                INSERT INTO data_object_versions (definition_id, version, model)
                VALUES ($1, $2, $3)
              `;
              await tx.query(insertObjVerSql, [
                form.definitionId,
                historical.version,
                historical.model,
              ]);
            }

            await this.platform.validateStableFields(
              tx,
              form.definitionId,
              modelFormSchema(form.draft.model),
            );

            const insertPageSql = `
              INSERT INTO pages (
                id, workspace_id, definition_id, definition_version, title, draft,
                latest_version, created_at, folder, archived_at, archived_by,
                form_model, base_definition_revision, initial_model, initial_model_revision
              )
              VALUES (
                $1, $2, $3, $4, $5, $6,
                $4, $7, $8, CASE WHEN $9 THEN now() ELSE NULL END, CASE WHEN $9 THEN $10::uuid ELSE NULL END,
                $11, 1, $12, $13
              )
            `;
            await tx.query(insertPageSql, [
              form.pageId,
              actor.workspaceId,
              form.definitionId,
              version,
              original.title,
              form.draft.page,
              assertValidTimestamp(original.createdAt),
              original.folder || "",
              original.archived === true,
              actor.id,
              form.draft.model,
              version ? null : model,
              version ? null : 1,
            ]);

            for (const historical of form.versions) {
              const insertPageVerSql = `
                INSERT INTO page_versions (
                  page_id, version, title, definition_id, definition_version, schema, created_at
                )
                VALUES ($1, $2, $3, $4, $2, $5, $6)
              `;
              await tx.query(insertPageVerSql, [
                form.pageId,
                historical.version,
                historical.title,
                form.definitionId,
                historical.page,
                historical.publishedAt,
              ]);
            }

            await tx.query("UPDATE pages SET field_trash = $2 WHERE id = $1", [
              form.pageId,
              JSON.stringify(form.fieldTrash || []),
            ]);

            if (form.recordView) {
              await this.recordViews.saveIn(tx, actor, form.definitionId, {
                expectedRevision: 0,
                settings: form.recordView,
              });
            }

            const access = form.access;
            const cleanedGroups = access.groups.map(
              ({ subjects, departmentBasis, departmentIncludesChildren, ...group }: any) => ({
                ...group,
                subjects: subjects.map(({ sourceId, historical, ...subject }: any) => subject),
                relations: {},
              }),
            );
            await this.groups.saveIn(tx, actor, form.definitionId, {
              expectedRevision: 0,
              mode: access.membersEnabled ? "groups" : "direct",
              allowMerged: access.allowMerged,
              groups: cleanedGroups,
            });

            await this.collection.saveIn(tx, actor, form.definitionId, {
              expectedRevision: 0,
              rules: access.filling,
            });
          }

          // 6. 导入全部历史记录并记录应用导入台账
          await this.records.importSnapshotIn(tx, actor, snapshot.id);

          const insertImportSql = `
            INSERT INTO application_imports (
              application_id, workspace_id, batch_id, snapshot_id,
              source_namespace, source_application_id, source_digest, imported_by, counts
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          `;
          await tx.query(insertImportSql, [
            appId,
            actor.workspaceId,
            id,
            snapshot.id,
            source.namespace,
            source.applicationId,
            snapshot.source_digest,
            actor.id,
            checked.plan.totals,
          ]);

          return appId;
        },
      );

      return this.receipt(tx, actor, applicationId);
    });
  }
}
