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
import { Actor, requireAdmin } from "./auth";
import { Database, Transaction } from "./database";
import { object, uuid } from "./schema";

@Injectable()
export class RecordViewService {
  constructor(private readonly db: Database) {}
  async read(
    tx: Transaction,
    id: string,
    schema: FormSchema,
  ): Promise<SavedRecordView> {
    const row = (
      await tx.query(
        "SELECT revision,settings FROM record_views WHERE definition_id=$1",
        [id],
      )
    ).rows[0];
    return (
      row || {
        revision: 0,
        settings: {
          fieldIds: schema.fields
            .filter((field) => hasFieldValue(field) && field.type !== "lookup")
            .slice(0, 6)
            .map((field) => field.id),
          sortField: "$createdAt",
          descending: true,
          pageSize: 20,
          rowHeight: "low",
        },
      }
    );
  }
  async save(actor: Actor, id: string, body: unknown) {
    return this.db.transaction((tx) => this.saveIn(tx, actor, id, body));
  }
  async saveIn(
    tx: Transaction,
    actor: Actor,
    id: string,
    body: unknown,
  ): Promise<SavedRecordView> {
    requireAdmin(actor);
    uuid(id);
    object(body);
    const definition = (
      await tx.query(
        "SELECT draft FROM definitions WHERE id=$1 AND workspace_id=$2 FOR UPDATE",
        [id, actor.workspaceId],
      )
    ).rows[0];
    if (!definition) throw new NotFoundException("表单不存在");
    const schemas = [
      definition.draft,
      ...(
        await tx.query(
          "SELECT schema FROM definition_versions WHERE definition_id=$1",
          [id],
        )
      ).rows.map((row) => row.schema),
    ];
    const drafts = (
      await tx.query(
        "SELECT form_model FROM pages WHERE definition_id=$1 AND form_model IS NOT NULL",
        [id],
      )
    ).rows;
    const ids = new Set<string>([
      ...schemas.flatMap((schema) =>
        schema.fields.filter(hasFieldValue).map((field: any) => field.id),
      ),
      ...drafts.flatMap((row) =>
        row.form_model.fields.map((field: any) => field.id),
      ),
    ]);
    let settings;
    try {
      settings = validateRecordView(body.settings, ids);
    } catch (error) {
      throw new BadRequestException((error as Error).message);
    }
    const current = await this.read(tx, id, definition.draft);
    if (current.revision !== body.expectedRevision)
      throw new ConflictException(
        "列表设置已被其他人修改，当前选择已保留，请重新读取后核对",
      );
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
