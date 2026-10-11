import { Injectable, NotFoundException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { Actor, requireAdmin } from "./auth";
import { Database } from "./database";
import { object, title, uuid } from "./schema";
import { once } from "./commands";
import { AccessService } from "./access";

export async function applicationId(tx: Pick<Database, "query">, actor: Actor, id?: string): Promise<string> {
  if (id !== undefined) uuid(id);
  const row = (await tx.query("SELECT id FROM applications WHERE workspace_id=$1 AND (($2::uuid IS NULL AND is_default) OR id=$2)", [actor.workspaceId, id || null])).rows[0];
  if (!row) throw new NotFoundException("应用不存在或不可访问");
  return row.id;
}
@Injectable()
export class ApplicationService {
  constructor(private readonly db: Database, private readonly access: AccessService) {}
  async seed() {
    await this.db.query("INSERT INTO applications(workspace_id,title,is_default) SELECT DISTINCT workspace_id,'协作应用',true FROM users ON CONFLICT(workspace_id) WHERE is_default DO NOTHING");
  }
  async list(actor: Actor) {
    return this.db.transaction(async tx => {
      const ids = await this.access.definitions(tx, actor);
      return (await tx.query(`SELECT a.id,a.title FROM applications a WHERE workspace_id=$1 AND ($2::uuid[] IS NULL OR EXISTS(
        SELECT 1 FROM definitions d WHERE d.application_id=a.id AND d.id=ANY($2))) ORDER BY a.created_at,a.id`, [actor.workspaceId, ids])).rows;
    });
  }
  async create(actor: Actor, body: unknown) {
    requireAdmin(actor); object(body); title(body.title);
    const id = await this.db.transaction(tx => once(tx, actor, body.requestId, { application: body.title.trim() }, async () => {
      const id = randomUUID();
      await tx.query("INSERT INTO applications(id,workspace_id,title) VALUES($1,$2,$3)", [id, actor.workspaceId, body.title.trim()]);
      return id;
    }));
    await applicationId(this.db, actor, id);
    return { id, title: body.title.trim() };
  }
}
