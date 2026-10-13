import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import {
  hasFieldValue,
  validateRecordView,
  type FormSchema,
  type SavedRecordView,
} from "@platform/contracts";
import { Actor, requireAdmin } from "../../core/auth/auth.service";
import { Database, Transaction } from "../../core/database/database";
import { object, uuid } from "../../core/database/schema";

/** 记录列表视图服务：管理表单在数据管理页的列展示、默认排序、分页大小与行高配置 */
@Injectable()
export class RecordViewService {
  constructor(private readonly db: Database) {}

  /** 读取表单已保存的列表视图设置；若尚未配置，则基于表单前 6 个非关联查询字段生成默认视图 */
  async read(tx: Transaction, id: string, schema: FormSchema): Promise<SavedRecordView> {
    const { rows } = await tx.query(
      "SELECT revision,settings FROM record_views WHERE definition_id=$1",
      [id],
    );
    const row = rows[0];
    if (row) return row;

    const defaultFieldIds = schema.fields
      .filter((field) => hasFieldValue(field) && field.type !== "lookup")
      .slice(0, 6)
      .map((field) => field.id);

    return {
      revision: 0,
      settings: {
        fieldIds: defaultFieldIds,
        sortField: "$createdAt",
        descending: true,
        pageSize: 20,
        rowHeight: "low",
      },
    };
  }

  /** 保存更新表单的列表视图配置（外部事务入口） */
  async save(actor: Actor, id: string, body: unknown) {
    return this.db.transaction((tx) => this.saveIn(tx, actor, id, body));
  }

  /** 在事务内校验并保存表单的列表视图配置，同时记录变更历史事件 */
  async saveIn(
    tx: Transaction,
    actor: Actor,
    id: string,
    body: unknown,
  ): Promise<SavedRecordView> {
    requireAdmin(actor);
    uuid(id);
    object(body);

    const { rows: defRows } = await tx.query(
      "SELECT draft FROM definitions WHERE id=$1 AND workspace_id=$2 FOR UPDATE",
      [id, actor.workspaceId],
    );
    const definition = defRows[0];
    if (!definition) throw new NotFoundException("表单不存在");

    const { rows: versionRows } = await tx.query(
      "SELECT schema FROM definition_versions WHERE definition_id=$1",
      [id],
    );
    const schemas = [definition.draft, ...versionRows.map((row) => row.schema)];

    const { rows: drafts } = await tx.query(
      "SELECT form_model FROM pages WHERE definition_id=$1 AND form_model IS NOT NULL",
      [id],
    );

    const allowedFieldIds = new Set<string>([
      ...schemas.flatMap((schema) =>
        schema.fields.filter(hasFieldValue).map((field: any) => field.id),
      ),
      ...drafts.flatMap((row) => row.form_model.fields.map((field: any) => field.id)),
    ]);

    let settings;
    try {
      settings = validateRecordView(body.settings, allowedFieldIds);
    } catch (error) {
      throw new BadRequestException((error as Error).message);
    }

    const current = await this.read(tx, id, definition.draft);
    if (current.revision !== body.expectedRevision) {
      throw new ConflictException(
        "列表设置已被其他人修改，当前选择已保留，请重新读取后核对",
      );
    }

    const revision = current.revision + 1;
    await tx.query(
      "INSERT INTO record_views(definition_id,revision,settings) VALUES($1,$2,$3) ON CONFLICT(definition_id) DO UPDATE SET revision=$2,settings=$3",
      [id, revision, settings],
    );
    await tx.query(
      "INSERT INTO record_view_events(id,definition_id,actor_id,revision,settings) VALUES($1,$2,$3,$4,$5)",
      [randomUUID(), id, actor.id, revision, settings],
    );
    return { revision, settings };
  }
}
