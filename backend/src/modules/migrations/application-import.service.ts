import { RecordViewService } from "../records/record-views.service";
import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { modelFormSchema } from "@platform/contracts";
import { Actor, requireAdmin } from "../../core/auth/auth.service";
import { Database, Transaction } from "../../core/database/database";
import { MigrationIdentityService } from "./migration-identities.service";
import { RecordOriginService } from "./record-origins.service";
import { GroupConfigurationService } from "../access/group-config.service";
import { CollectionService } from "../records/collection.service";
import { PlatformService } from "../pages/platform.service";
import { canonicalMigration, migrationDigest, planMigrationResources, resourceSource } from "./migration-resource-plan";
import { once } from "../processes/commands";
import { object, title, uuid } from "../../core/database/schema";
import { reviewMigrationRoles } from './migration-role-access';

/** Import one complete checked snapshot. No source mutation or partial application cutover. */
@Injectable()
export class ApplicationImportService {
  constructor(private readonly db: Database, private readonly identities: MigrationIdentityService,
    private readonly records: RecordOriginService, private readonly groups: GroupConfigurationService,
    private readonly collection: CollectionService, private readonly platform: PlatformService, private readonly recordViews: RecordViewService) {}

  private async receipt(tx: Transaction, actor: Actor, applicationId: string) {
    const row = (await tx.query("SELECT application_id,snapshot_id,counts,imported_at FROM application_imports WHERE application_id=$1 AND workspace_id=$2", [applicationId, actor.workspaceId])).rows[0];
    if (!row) throw new NotFoundException("应用导入结果不存在");
    return { applicationId: row.application_id, snapshotId: row.snapshot_id, counts: row.counts, importedAt: row.imported_at.toISOString() };
  }
  async apply(actor: Actor, id: string, body: unknown) {
    requireAdmin(actor); object(body); uuid(body.snapshotId);
    return this.db.transaction(async tx => {
      const applicationId = await once(tx, actor, body.requestId, { applicationImport: id, body }, async () => {
        const batch = await this.identities.lockedBatch(tx, actor, id);
        const previous = (await tx.query("SELECT application_id,snapshot_id,source_digest FROM application_imports WHERE batch_id=$1", [id])).rows[0];
        if (previous) {
          if (previous.snapshot_id !== body.snapshotId || previous.source_digest !== body.sourceDigest) throw new ConflictException("此来源应用已导入，不能用另一份快照覆盖现有应用");
          return previous.application_id;
        }
        const snapshot = (await tx.query("SELECT * FROM migration_resource_snapshots WHERE batch_id=$1 ORDER BY revision DESC LIMIT 1", [id])).rows[0];
        if (!snapshot || snapshot.id !== body.snapshotId || snapshot.revision !== body.expectedResourceRevision || batch.revision !== body.expectedBatchRevision || snapshot.batch_revision !== batch.revision || snapshot.source_digest !== body.sourceDigest) throw new ConflictException("导入依据已变化，请重新检查；原应用保留");
        const review = await this.identities.reviewIn(tx, actor, batch);
        if (!review.confirmationCurrent || snapshot.identity_review_token !== review.token || snapshot.source_fingerprint !== batch.source.fingerprint) throw new ConflictException("来源或身份对应已变化，请重新检查；原应用保留");
        const source = resourceSource(snapshot.payload);
        if (migrationDigest(source) !== snapshot.source_digest) throw new ConflictException("资源快照校验失败，未写入目标应用");
        const reserve = async (kind: string, parts: unknown[]) => {
          const row = (await tx.query("SELECT target_id FROM migration_resource_keys WHERE workspace_id=$1 AND source_namespace=$2 AND kind=$3 AND source_key=$4", [actor.workspaceId, source.namespace, kind, JSON.stringify(canonicalMigration(parts))])).rows[0];
          if (!row) throw new ConflictException("资源对应不完整，请重新检查；没有生成替代身份");
          return row.target_id;
        };
        const roleReview = await reviewMigrationRoles(tx, actor, source, batch.choices);
        const checked = await planMigrationResources(source, batch.choices, review, reserve, roleReview);
        if (checked.plan.issues.length) throw new ConflictException(checked.plan.issues.map(item => item.message).join("；"));
        if (migrationDigest(checked.projection) !== migrationDigest(snapshot.projection) || migrationDigest(checked.plan) !== migrationDigest(snapshot.plan)) throw new ConflictException("转换规则已更新，请重新生成资源检查后导入");
        const appId = checked.plan.targetApplicationId;
        if ((await tx.query("SELECT 1 FROM applications WHERE id=$1", [appId])).rowCount) throw new ConflictException("目标应用已存在，未覆盖原有内容");
        title(source.application.name);
        await tx.query("INSERT INTO applications(id,workspace_id,title,appearance) VALUES($1,$2,$3,$4)", [appId, actor.workspaceId, source.application.name, { color: source.application.color, icon: source.application.icon, folders: source.application.folders || [], description: source.application.description || "" }]);
        const time = (value: unknown) => {
          if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new ConflictException("来源时间无效，未保留部分导入结果");
          return value;
        };
        for (const form of checked.projection.forms) {
          const original = source.forms.find(item => item.id === form.sourceId)!;
          const published = form.versions.find((version: any) => version.version === form.publishedVersion);
          const version = form.publishedVersion || 0;
          title(original.title);
          // Keep the published model baseline separate from the editable form draft.
          const model = published?.model || form.draft.model;
          await tx.query("INSERT INTO definitions(id,workspace_id,application_id,title,draft,model_draft,latest_version,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)", [form.definitionId, actor.workspaceId, appId, original.title, modelFormSchema(model), model, version, time(original.createdAt)]);
          for (const historical of form.versions) {
            title(historical.title);
            await this.platform.validateStableFields(tx, form.definitionId, modelFormSchema(historical.model));
            await tx.query("INSERT INTO definition_versions(definition_id,version,title,schema,created_at) VALUES($1,$2,$3,$4,$5)", [form.definitionId, historical.version, historical.title, modelFormSchema(historical.model), time(historical.publishedAt)]);
            await tx.query("INSERT INTO data_object_versions(definition_id,version,model) VALUES($1,$2,$3)", [form.definitionId, historical.version, historical.model]);
          }
          await this.platform.validateStableFields(tx, form.definitionId, modelFormSchema(form.draft.model));
          await tx.query(`INSERT INTO pages(id,workspace_id,definition_id,definition_version,title,draft,latest_version,created_at,folder,archived_at,archived_by,form_model,base_definition_revision,initial_model,initial_model_revision)
            VALUES($1,$2,$3,$4,$5,$6,$4,$7,$8,CASE WHEN $9 THEN now() ELSE NULL END,CASE WHEN $9 THEN $10::uuid ELSE NULL END,$11,1,$12,$13)`, [form.pageId, actor.workspaceId, form.definitionId, version, original.title, form.draft.page, time(original.createdAt), original.folder || "", original.archived === true, actor.id, form.draft.model, version ? null : model, version ? null : 1]);
          for (const historical of form.versions) await tx.query("INSERT INTO page_versions(page_id,version,title,definition_id,definition_version,schema,created_at) VALUES($1,$2,$3,$4,$2,$5,$6)", [form.pageId, historical.version, historical.title, form.definitionId, historical.page, historical.publishedAt]);
          await tx.query("UPDATE pages SET field_trash=$2 WHERE id=$1", [form.pageId, JSON.stringify(form.fieldTrash || [])]);
          if (form.recordView) await this.recordViews.saveIn(tx, actor, form.definitionId, { expectedRevision: 0, settings: form.recordView });
          const access = form.access;
          await this.groups.saveIn(tx, actor, form.definitionId, { expectedRevision: 0, mode: access.membersEnabled ? "groups" : "direct", allowMerged: access.allowMerged, groups: access.groups.map(({ subjects, departmentBasis, departmentIncludesChildren, ...group }: any) => ({ ...group, subjects: subjects.map(({ sourceId, historical, ...subject }: any) => subject), relations: {} })) });
          await this.collection.saveIn(tx, actor, form.definitionId, { expectedRevision: 0, rules: access.filling });
        }
        await this.records.importSnapshotIn(tx, actor, snapshot.id);
        await tx.query("INSERT INTO application_imports(application_id,workspace_id,batch_id,snapshot_id,source_namespace,source_application_id,source_digest,imported_by,counts) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)", [appId, actor.workspaceId, id, snapshot.id, source.namespace, source.applicationId, snapshot.source_digest, actor.id, checked.plan.totals]);
        return appId;
      });
      return this.receipt(tx, actor, applicationId);
    });
  }
}
