import { Injectable, NotFoundException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { Actor, requireAdmin } from "../../core/auth/auth.service";
import { once } from "../../core/database/commands";
import { Database } from "../../core/database/database";
import { object, title, uuid } from "../../core/validation";
import { AccessService } from "../access/access.service";


/**
 * 解析并校验目标应用 ID：
 * - 若传入了具体应用 ID，校验该应用属于当前工作空间；
 * - 若未传入应用 ID，回退到当前工作空间的默认应用（is_default = true）。
 */
export async function applicationId(tx: Pick<Database, "query">, actor: Actor, id?: string): Promise<string> {
  if (id !== undefined) uuid(id);

  const sql = `
    SELECT id
    FROM applications
    WHERE workspace_id = $1
      AND (($2::uuid IS NULL AND is_default) OR id = $2)
  `;
  const row = (await tx.query(sql, [actor.workspaceId, id || null])).rows[0];
  if (!row) throw new NotFoundException("应用不存在或不可访问");

  return row.id;
}

@Injectable()
export class ApplicationService {
  constructor(
    private readonly db: Database,
    private readonly access: AccessService,
  ) {}

  /** 初始化时确保每个工作空间都存在一个默认的“协作应用” */
  async seed() {
    const sql = `
      INSERT INTO applications (workspace_id, title, is_default)
      SELECT DISTINCT workspace_id, '协作应用', true
      FROM users
      ON CONFLICT (workspace_id) WHERE is_default DO NOTHING
    `;
    await this.db.query(sql);
  }

  /**
   * 获取当前用户可见的应用列表：
   * - 管理员（visibleDefIds === null）可见当前工作空间下的全部应用，并附带目录配置 folders；
   * - 普通成员仅可见“至少包含一个其有权访问的表单”的应用。
   */
  async list(actor: Actor) {
    return this.db.transaction(async (tx) => {
      const visibleDefIds = await this.access.definitions(tx, actor);

      const sql = `
        SELECT a.id, a.title, a.appearance
        FROM applications a
        WHERE a.workspace_id = $1
          AND (
            $2::uuid[] IS NULL
            OR EXISTS (
              SELECT 1 FROM definitions d
              WHERE d.application_id = a.id AND d.id = ANY($2)
            )
          )
        ORDER BY a.created_at, a.id
      `;
      const { rows } = await tx.query(sql, [actor.workspaceId, visibleDefIds]);

      return rows.map(({ appearance, ...app }) => ({
        ...app,
        color: appearance.color,
        icon: appearance.icon,
        ...(actor.role === "admin" ? { folders: appearance.folders || [] } : {}),
      }));
    });
  }

  /** 创建新应用（仅管理员可用，支持通过 requestId 保证幂等创建） */
  async create(actor: Actor, body: unknown) {
    requireAdmin(actor);
    object(body);
    title(body.title);

    const appTitle = body.title.trim();

    const id = await this.db.transaction((tx) =>
      once(tx, actor, body.requestId, { application: appTitle }, async () => {
        const newId = randomUUID();
        await tx.query(
          "INSERT INTO applications (id, workspace_id, title) VALUES ($1, $2, $3)",
          [newId, actor.workspaceId, appTitle],
        );
        return newId;
      }),
    );

    await applicationId(this.db, actor, id);
    return { id, title: appTitle };
  }
}

