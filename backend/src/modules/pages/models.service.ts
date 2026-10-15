import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  dataKind,
  fieldPermission as permission,
  separateFormSchema,
  type FormField,
  type FormSchema,
} from "@platform/contracts";
import { randomUUID } from "node:crypto";
import { Actor, requireAdmin } from "../../core/auth/auth.service";
import { Database } from "../../core/database/database";
import { object, title } from "../../core/validation";
import { AccessService } from "../access/access.service";
import { applicationId } from "../applications/applications.service";
import { OrganizationService } from "../directory/organization.service";
import { CollectionService } from "../records/collection.service";
import { storeModelDraft, storeModelVersion } from "../records/data-projection";
import { parseSchema, rowActions } from "../records/record-schema";
import { RecordValuesService } from "../records/record-values.service";
import { RecordService, definitionDto } from "../records/records.service";
import { dataModelImpact } from "./model-impact";

type Queryable = Pick<Database, "query">;

/** 数据模型草稿、发布和跨页面影响检查，独立于记录读写。 */
@Injectable()
export class ModelService {
  constructor(
    private readonly db: Database,
    private readonly recordService: RecordService,
    private readonly values: RecordValuesService,
    private readonly authorization: AccessService,
    private readonly organizations: OrganizationService,
    private readonly collection: CollectionService,
  ) {}

  /** 查询当前用户可访问的表单定义列表（支持按应用过滤） */
  async definitions(actor: Actor, appId?: string) {
    if (appId) await applicationId(this.db, actor, appId);
    return this.db.transaction(async (tx) => {
      const ids = await this.authorization.definitions(tx, actor);
      const sql = `
        SELECT d.id, d.title, d.revision, d.latest_version AS "latestVersion"
        FROM definitions d
        WHERE d.workspace_id = $1
          AND ($2::uuid[] IS NULL OR d.id = ANY($2))
          AND ($3::uuid IS NULL OR d.application_id = $3)
        ORDER BY d.created_at DESC
      `;
      const { rows } = await tx.query(sql, [actor.workspaceId, ids, appId || null]);
      return rows;
    });
  }

  /** 新建或保存数据对象草稿，页面由页面设计器独立保存与发布 */
  async saveDefinition(actor: Actor, body: unknown, id?: string) {
    requireAdmin(actor);
    object(body);
    title(body.title);
    const schema = parseSchema(body.schema, true);

    return this.db.transaction(async (tx) => {
      if (!id) {
        const newId = randomUUID();
        const appId = await applicationId(tx, actor, body.applicationId);
        await tx.query(
          "INSERT INTO definitions(id, workspace_id, title, draft, application_id) VALUES($1, $2, $3, $4, $5)",
          [newId, actor.workspaceId, body.title.trim(), schema, appId],
        );
        await storeModelDraft(
          tx,
          {
            id: newId,
            workspace_id: actor.workspaceId,
            title: body.title.trim(),
          },
          schema,
          false,
        );
        return { id: newId, revision: 1 };
      }

      const def = await this.recordService.definition(tx, actor, id, "FOR UPDATE");
      if (body.expectedRevision !== def.revision) {
        throw new ConflictException("表单配置已更新，请重新读取");
      }

      await this.validateStableFields(tx, id, schema);

      await tx.query(
        "UPDATE definitions SET title = $2, draft = $3, revision = revision + 1 WHERE id = $1",
        [id, body.title.trim(), schema],
      );
      await storeModelDraft(tx, { ...def, title: body.title.trim() }, schema, false);
      return { id, revision: def.revision + 1 };
    });
  }

  /** 发布表单定义新版本，校验发布影响令牌并写入配置审计事件 */
  async publish(actor: Actor, id: string, body: unknown) {
    requireAdmin(actor);
    object(body);
    return this.db.transaction(async (tx) => {
      const def = await this.recordService.definition(tx, actor, id, "FOR UPDATE");
      if (body.expectedRevision !== def.revision) {
        throw new ConflictException("表单配置已更新，请重新读取");
      }

      const version = def.latest_version + 1;
      const schema = parseSchema(def.draft);
      await this.values.validateOrganizationModel(tx, actor, schema);
      await this.validateStableFields(tx, id, schema);

      const impact = await dataModelImpact(tx, def, separateFormSchema(schema).model, {
        organization: await this.organizations.snapshot(tx, actor),
        actorId: actor.id,
      });
      if (impact.blockers.length) {
        throw new ConflictException(impact.blockers.join("；"));
      }
      if ((impact.changes.removed.length || impact.changes.changed.length) && !body.impactToken) {
        throw new ConflictException("移除字段或修改数据约束前，请先检查发布影响");
      }
      if (body.impactToken !== undefined && body.impactToken !== impact.token) {
        throw new ConflictException("字段或使用情况已变化，请重新检查发布影响；草稿已保留");
      }

      const { rows } = await tx.query(
        "INSERT INTO definition_versions(definition_id, version, title, schema) VALUES($1, $2, $3, $4) RETURNING *",
        [id, version, def.title, schema],
      );
      const row = rows[0];

      await storeModelVersion(tx, id, version, row.schema, false);
      await tx.query(
        "UPDATE definitions SET latest_version = $2, revision = revision + 1 WHERE id = $1",
        [id, version],
      );
      await tx.query(
        "INSERT INTO configuration_events(id, workspace_id, actor_id, resource_kind, resource_id, action, revision, detail) VALUES($1, $2, $3, 'data_object', $4, 'publish', $5, $6)",
        [
          randomUUID(),
          actor.workspaceId,
          actor.id,
          id,
          def.revision + 1,
          {
            fromVersion: def.latest_version,
            toVersion: version,
            reviewedToken: body.impactToken || null,
            changes: impact.changes,
          },
        ],
      );

      return definitionDto(row);
    });
  }

  /** 预览数据模型发布对关联配置与存量记录的影响 */
  async modelImpact(actor: Actor, id: string, body: unknown) {
    requireAdmin(actor);
    object(body);
    return this.db.transaction(async (tx) => {
      // 持有排他锁执行存量记录统计与批次校验，防止并发写入导致计数漂移
      const definition = await this.recordService.definition(tx, actor, id, "FOR UPDATE");
      if (definition.revision !== body.expectedRevision) {
        throw new ConflictException("数据草稿已修改，请重新读取后检查");
      }

      const schema = parseSchema(definition.draft);
      await this.values.validateOrganizationModel(tx, actor, schema);
      await this.validateStableFields(tx, id, schema);

      return dataModelImpact(tx, definition, separateFormSchema(schema).model, {
        organization: await this.organizations.snapshot(tx, actor),
        actorId: actor.id,
      });
    });
  }

  /** 校验已发布过的字段是否保持相同的数据类型与子表归属路径 */
  async validateStableFields(tx: Queryable, id: string, schema: FormSchema) {
    const { rows: versions } = await tx.query(
      "SELECT schema FROM definition_versions WHERE definition_id = $1",
      [id],
    );
    const paths = (value: FormSchema) =>
      new Map(
        value.fields.flatMap(
          (field) =>
            [
              [field.id, `${dataKind(field.type)}:root`],
              ...field.children.map((child) => [child.id, `${dataKind(child.type)}:${field.id}`]),
            ] as [string, string][],
        ),
      );

    const next = paths(schema);
    for (const version of versions) {
      for (const [key, type] of paths(version.schema)) {
        if (next.has(key) && next.get(key) !== type) {
          throw new BadRequestException("已发布字段不能变更类型或所属子表，请新建字段");
        }
      }
    }
  }

  /** 获取表单最新已发布版本的定义、默认值与当前用户权限 */
  async published(actor: Actor, id: string) {
    return this.db.transaction(async (tx) => {
      const def = await this.recordService.definition(tx, actor, id, "FOR SHARE");
      const { rows } = await tx.query(
        "SELECT * FROM definition_versions WHERE definition_id = $1 AND version = $2",
        [id, def.latest_version],
      );
      const row = rows[0];
      if (!row) {
        throw new NotFoundException("表单尚未发布");
      }

      const access = await this.authorization.effective(tx, actor, id, row.schema, {
        operation: "create",
      });
      const fields = row.schema.fields
        .filter((f: FormField) => permission(access, f) !== "hidden")
        .map((f: FormField) => ({
          ...f,
          children: f.children.filter((c) => permission(access, c, f) !== "hidden"),
        }));

      const defaults = await this.values.recordDefaults(tx, actor, row.schema);
      const defaultValues = Object.fromEntries(
        fields.map((field: FormField) => [field.id, defaults[field.id]]),
      );

      return {
        defaultValues,
        identities: await this.values.identityLabels(
          tx,
          actor,
          { ...row.schema, fields },
          defaultValues,
        ),
        rowActions: rowActions(row.schema, { ...access, edit: access.create }),
        ...(access.create ? { collection: await this.collection.statusIn(tx, actor, id) } : {}),
        definition: {
          ...definitionDto(row),
          schema: { ...row.schema, fields },
        },
        access,
      };
    });
  }
}
