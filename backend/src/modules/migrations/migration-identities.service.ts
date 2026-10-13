import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { createHash, randomUUID } from "node:crypto";
import {
  migrationIdentityKey,
  type DirectoryIdentity,
  type MigrationBatch,
  type MigrationIdentityChoice,
  type MigrationIdentityReview,
  type MigrationIdentitySource,
  type MigrationSourceIdentity,
  type ServerOrganization,
} from "@platform/contracts";
import { Actor, requireAdmin } from "../../core/auth/auth.service";
import { Database, Transaction } from "../../core/database/database";
import { object, uuid } from "../../core/database/schema";
import { retainHistoricalIdentities } from "../directory/historical-identities";
import { OrganizationService } from "../directory/organization.service";
import { once } from "../processes/commands";

// ============================================================================
// 1. 基础输入校验与 DTO 转换辅助函数
// ============================================================================

const IDENTITY_KINDS = ["member", "department", "role"];

/** 校验非空且不含控制字符的文本字段 */
function validateText(value: unknown, limit = 200): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > limit ||
    /[\u0000-\u001f]/.test(value)
  ) {
    throw new BadRequestException("来源身份名称或标识格式不合法");
  }
  return value;
}

/** 解析并校验来源应用的组织身份清单与统计摘要 */
function parseSourceInput(raw: unknown): MigrationIdentitySource {
  object(raw);
  uuid(raw.namespace);
  object(raw.counts);

  if (typeof raw.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(raw.fingerprint)) {
    throw new BadRequestException("需要完整的来源快照标识");
  }
  if (!Array.isArray(raw.identities) || raw.identities.length > 1000) {
    throw new BadRequestException("单次最多核对 1000 个组织身份");
  }

  const countKeys = ["forms", "versions", "records", "rows", "issues"];
  const counts = Object.fromEntries(
    countKeys.map((key) => {
      const count = raw.counts[key];
      if (!Number.isSafeInteger(count) || count < 0 || count > 1e9) {
        throw new BadRequestException("来源资源统计不合法");
      }
      return [key, count];
    }),
  ) as MigrationIdentitySource["counts"];

  const identities: MigrationSourceIdentity[] = raw.identities.map((item: unknown) => {
    object(item);
    const isInvalidState =
      !IDENTITY_KINDS.includes(item.kind) ||
      typeof item.found !== "boolean" ||
      typeof item.active !== "boolean" ||
      (!item.found && item.active);
    if (isInvalidState) {
      throw new BadRequestException("来源组织身份状态不合法");
    }
    return {
      kind: item.kind,
      sourceId: validateText(item.sourceId),
      name: validateText(item.name),
      found: item.found,
      active: item.active,
    };
  });

  if (new Set(identities.map(migrationIdentityKey)).size !== identities.length) {
    throw new BadRequestException("来源身份重复，请重新检查应用");
  }

  identities.sort((a, b) => migrationIdentityKey(a).localeCompare(migrationIdentityKey(b)));

  return {
    namespace: raw.namespace.toLowerCase(),
    applicationId: validateText(raw.applicationId),
    applicationName: validateText(raw.applicationName),
    fingerprint: raw.fingerprint,
    identities,
    counts,
  };
}

/** 将数据库迁移批次行转换为前端 DTO */
function toBatchDto(row: any): MigrationBatch {
  return {
    id: row.id,
    revision: row.revision,
    state: row.state,
    source: row.source,
    choices: row.choices,
    confirmedAt: row.confirmed_at?.toISOString() || null,
    updatedAt: row.updated_at.toISOString(),
  };
}

// ============================================================================
// 2. 迁移身份核对与批次管理服务
// ============================================================================

@Injectable()
export class MigrationIdentityService {
  constructor(
    private readonly db: Database,
    private readonly organizations: OrganizationService,
  ) {}

  /** 获取并锁定指定迁移批次及其所属的组织与来源命名空间 */
  async lockedBatch(tx: Transaction, actor: Actor, id: string) {
    requireAdmin(actor);
    const meta = await this.row(tx, actor, id);
    await this.lock(tx, actor, meta.source_namespace);
    return this.row(tx, actor, id, true);
  }

  /** 在已有事务中执行批次身份映射核对 */
  async reviewIn(tx: Transaction, actor: Actor, row: any) {
    requireAdmin(actor);
    const organization = await this.organizations.snapshot(tx, actor);
    return this.inspect(tx, actor, row, organization);
  }

  /** 加锁保护当前工作空间的组织架构与同一来源命名空间下的并发迁移批次 */
  private async lock(tx: Transaction, actor: Actor, namespace: string) {
    await this.organizations.lock(tx, actor.workspaceId);
    // 在锁定具体批次行之前先按来源命名空间串行化，防止跨应用身份映射冲突
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `migration-source:${actor.workspaceId}:${namespace}`,
    ]);
  }

  /** 按 ID 查询迁移批次行（可选 FOR UPDATE 行锁） */
  private async row(tx: Pick<Database, "query">, actor: Actor, id: string, lock = false) {
    uuid(id);
    const sql = `
      SELECT *
      FROM migration_batches
      WHERE id = $1 AND workspace_id = $2
      ${lock ? "FOR UPDATE" : ""}
    `;
    const { rows } = await tx.query(sql, [id, actor.workspaceId]);
    const row = rows[0];
    if (!row) {
      throw new NotFoundException("迁移批次不存在或不可访问");
    }
    return row;
  }

  /** 记录迁移批次审计事件 */
  private async event(
    tx: Transaction,
    actor: Actor,
    row: any,
    action: string,
    detail: object = {},
  ) {
    const sql = `
      INSERT INTO migration_batch_events (id, batch_id, actor_id, revision, action, detail)
      VALUES ($1, $2, $3, $4, $5, $6)
    `;
    await tx.query(sql, [
      randomUUID(),
      row.id,
      actor.id,
      row.revision,
      action,
      { source: row.source, choices: row.choices, state: row.state, ...detail },
    ]);
  }

  /** 组织架构关系导入完成后，刷新批次的身份确认令牌并记录审计事件 */
  async organizationImported(tx: Transaction, actor: Actor, row: any, detail: object) {
    const review = await this.reviewIn(tx, actor, row);
    if (review.blockers.length) {
      throw new ConflictException(review.blockers.join("；"));
    }

    const sql = `
      UPDATE migration_batches
      SET confirmed_token = $2, revision = revision + 1, updated_at = now()
      WHERE id = $1
      RETURNING *
    `;
    const { rows } = await tx.query(sql, [row.id, review.token]);
    const updated = rows[0];
    await this.event(tx, actor, updated, "import_organization", detail);
    return toBatchDto(updated);
  }

  /** 为来源身份预留稳定的历史身份 UUID（跨同命名空间批次复用） */
  private async reserve(tx: Transaction, actor: Actor, source: MigrationIdentitySource) {
    const insertSql = `
      INSERT INTO migration_identity_keys (workspace_id, source_namespace, kind, source_id, historical_id)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT DO NOTHING
    `;
    for (const item of source.identities) {
      await tx.query(insertSql, [
        actor.workspaceId,
        source.namespace,
        item.kind,
        item.sourceId,
        randomUUID(),
      ]);
    }

    const selectSql = `
      SELECT kind, source_id, historical_id
      FROM migration_identity_keys
      WHERE workspace_id = $1 AND source_namespace = $2
    `;
    const { rows } = await tx.query(selectSql, [actor.workspaceId, source.namespace]);
    return rows;
  }

  /** 校验并规范化每个来源身份的映射选择（unresolved / existing / historical） */
  private async choices(
    tx: Transaction,
    actor: Actor,
    source: MigrationIdentitySource,
    raw: unknown,
  ): Promise<MigrationIdentityChoice[]> {
    if (!Array.isArray(raw) || raw.length !== source.identities.length) {
      throw new BadRequestException("请为每个来源身份保留一项对应决定");
    }

    const reserved = await this.reserve(tx, actor, source);
    const seen = new Set<string>();

    const normalized = raw.map((item) => {
      object(item);
      const key = migrationIdentityKey(item as MigrationIdentityChoice);
      const existsInSource = source.identities.some(
        (identity) => migrationIdentityKey(identity) === key,
      );
      const isValidMode = ["unresolved", "existing", "historical"].includes(item.mode);

      if (!existsInSource || seen.has(key) || !isValidMode) {
        throw new BadRequestException("身份对应项重复、缺失或不属于本批次");
      }
      seen.add(key);

      if (item.mode === "existing") {
        uuid(item.targetId);
      }

      let targetId: string | undefined;
      if (item.mode === "historical") {
        const matched = reserved.find(
          (value) => value.kind === item.kind && value.source_id === item.sourceId,
        )!;
        targetId = matched.historical_id;
      } else if (item.mode === "existing") {
        targetId = item.targetId.toLowerCase();
      }

      return {
        kind: item.kind,
        sourceId: item.sourceId,
        mode: item.mode,
        ...(targetId ? { targetId } : {}),
      };
    });

    return normalized.sort((a, b) =>
      migrationIdentityKey(a).localeCompare(migrationIdentityKey(b)),
    );
  }

  /** 查询迁移批次列表 */
  async list(actor: Actor, namespace: string, applicationId?: string) {
    requireAdmin(actor);
    uuid(namespace);

    const sql = `
      SELECT *
      FROM migration_batches
      WHERE workspace_id = $1
        AND source_namespace = $2
        AND ($3::text IS NULL OR source_application_id = $3)
      ORDER BY updated_at DESC
    `;
    const { rows } = await this.db.query(sql, [
      actor.workspaceId,
      namespace,
      applicationId || null,
    ]);
    return rows.map(toBatchDto);
  }

  /** 获取单个迁移批次详情 */
  async get(actor: Actor, id: string) {
    requireAdmin(actor);
    const row = await this.row(this.db, actor, id);
    return toBatchDto(row);
  }

  /** 创建迁移批次并初始化全部身份为待决定（unresolved）状态 */
  async create(actor: Actor, body: unknown) {
    requireAdmin(actor);
    object(body);
    const source = parseSourceInput(body.source);

    return this.db.transaction(async (tx) => {
      const id = await once(tx, actor, body.requestId, { migrationCreate: source }, async () => {
        await this.lock(tx, actor, source.namespace);

        const checkSql = `
          SELECT 1
          FROM migration_batches
          WHERE workspace_id = $1 AND source_namespace = $2 AND source_application_id = $3
        `;
        const existing = await tx.query(checkSql, [
          actor.workspaceId,
          source.namespace,
          source.applicationId,
        ]);
        if (existing.rowCount) {
          throw new ConflictException("此来源应用已有迁移批次，请重新读取已有对应草稿");
        }

        const initialChoices = source.identities.map((item) => ({
          kind: item.kind,
          sourceId: item.sourceId,
          mode: "unresolved",
        }));
        const choices = await this.choices(tx, actor, source, initialChoices);

        const insertSql = `
          INSERT INTO migration_batches (
            id, workspace_id, source_namespace, source_application_id, source, choices, created_by
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7)
          RETURNING *
        `;
        const { rows } = await tx.query(insertSql, [
          randomUUID(),
          actor.workspaceId,
          source.namespace,
          source.applicationId,
          source,
          JSON.stringify(choices),
          actor.id,
        ]);
        const row = rows[0];
        await this.event(tx, actor, row, "create");
        return row.id;
      });

      return toBatchDto(await this.row(tx, actor, id));
    });
  }

  /** 保存身份映射草稿，或刷新来源身份清单并合并已有映射选择 */
  async save(actor: Actor, id: string, body: unknown, refresh = false) {
    requireAdmin(actor);
    object(body);

    return this.db.transaction(async (tx) => {
      const result = await once(
        tx,
        actor,
        body.requestId,
        { migrationSave: id, refresh, body },
        async () => {
          const meta = await this.row(tx, actor, id);
          await this.lock(tx, actor, meta.source_namespace);

          const row = await this.row(tx, actor, id, true);
          if (body.expectedRevision !== row.revision) {
            throw new ConflictException("身份对应已被修改，输入已保留；请重新读取后合并");
          }
          if (row.state === "identities_confirmed") {
            throw new ConflictException("先撤销本批次身份确认，再修改来源或对应关系");
          }

          const source = refresh
            ? parseSourceInput(body.source)
            : (row.source as MigrationIdentitySource);
          if (
            source.namespace !== row.source_namespace ||
            source.applicationId !== row.source_application_id
          ) {
            throw new BadRequestException("迁移批次的来源不能替换");
          }
          if (!refresh && body.sourceFingerprint !== source.fingerprint) {
            throw new ConflictException("来源快照已变化，请重新核对当前应用");
          }

          const rawChoices = refresh
            ? source.identities.map(
                (item) =>
                  row.choices.find(
                    (choice: MigrationIdentityChoice) =>
                      migrationIdentityKey(choice) === migrationIdentityKey(item),
                  ) || { kind: item.kind, sourceId: item.sourceId, mode: "unresolved" },
              )
            : body.choices;
          const choices = await this.choices(tx, actor, source, rawChoices);

          const updateSql = `
            UPDATE migration_batches
            SET source = $2,
                choices = $3,
                revision = revision + 1,
                confirmed_token = NULL,
                confirmed_at = NULL,
                updated_at = now()
            WHERE id = $1
            RETURNING *
          `;
          const { rows } = await tx.query(updateSql, [id, source, JSON.stringify(choices)]);
          const updated = rows[0];
          await this.event(tx, actor, updated, refresh ? "refresh_source" : "save");
          return id;
        },
      );

      return toBatchDto(await this.row(tx, actor, result));
    });
  }

  /**
   * 全面检查当前批次的身份映射：
   * 核对通讯录账号绑定、已接入组织身份、同命名空间其他已确认批次的一致性，并生成防篡改签名 token。
   */
  private async inspect(
    tx: Transaction,
    actor: Actor,
    row: any,
    organization: ServerOrganization,
  ): Promise<MigrationIdentityReview> {
    const source = row.source as MigrationIdentitySource;
    const choices = row.choices as MigrationIdentityChoice[];
    const counts = { existing: 0, historical: 0, unresolved: 0 };
    const blockers: string[] = [];

    // 1. 加载同来源命名空间下其他已确认批次、通讯录账号绑定及组织目录身份映射
    const otherSql = `
      SELECT id, source, choices
      FROM migration_batches
      WHERE workspace_id = $1 AND source_namespace = $2 AND id <> $3 AND state = 'identities_confirmed'
    `;
    const { rows: other } = await tx.query(otherSql, [actor.workspaceId, source.namespace, row.id]);

    const memberAccountSql = `
      SELECT member_id, account_id, revision
      FROM member_accounts
      WHERE workspace_id = $1 AND source_namespace = $2
      ORDER BY member_id
    `;
    const { rows: allMemberAccounts } = await tx.query(memberAccountSql, [
      actor.workspaceId,
      source.namespace,
    ]);
    const memberAccounts = allMemberAccounts.filter(
      (link) =>
        source.identities.some(
          (identity) => identity.kind === "member" && identity.sourceId === link.member_id,
        ) ||
        choices.some(
          (choice) =>
            choice.kind === "member" &&
            choice.mode === "existing" &&
            choice.targetId === link.account_id,
        ),
    );

    const directorySql = `
      SELECT identities
      FROM organization_directories
      WHERE workspace_id = $1 AND source_namespace = $2
    `;
    const { rows: dirRows } = await tx.query(directorySql, [actor.workspaceId, source.namespace]);
    const allDirectoryKeys: DirectoryIdentity[] = dirRows[0]?.identities || [];
    const directoryKeys: DirectoryIdentity[] = allDirectoryKeys.filter(
      (key: DirectoryIdentity) =>
        source.identities.some(
          (identity) => identity.kind === key.kind && identity.sourceId === key.id,
        ) ||
        choices.some((choice) => choice.kind === key.kind && choice.targetId === key.targetId),
    );

    // 2. 逐项核对每个来源身份的映射合法性与冲突
    const targets = new Map<string, string>();
    const items = source.identities.map((identity) => {
      const choice = choices.find(
        (item) => migrationIdentityKey(item) === migrationIdentityKey(identity),
      )!;

      // 核对通讯录已绑定的登录账号
      if (identity.kind === "member") {
        for (const link of memberAccounts) {
          const isMismatch =
            (link.member_id === identity.sourceId &&
              (choice.mode !== "existing" || choice.targetId !== link.account_id)) ||
            (link.member_id !== identity.sourceId && choice.targetId === link.account_id);
          if (isMismatch) {
            blockers.push(`「${identity.name}」与通讯录已关联的登录账号不一致`);
          }
        }
      }

      // 核对通讯录已接入的组织身份
      for (const key of directoryKeys) {
        if (key.kind !== identity.kind) continue;
        const isMismatch =
          (key.id === identity.sourceId &&
            (choice.mode !== "existing" || choice.targetId !== key.targetId)) ||
          (key.id !== identity.sourceId && choice.targetId === key.targetId);
        if (isMismatch) {
          blockers.push(`「${identity.name}」与通讯录已接入的组织身份不一致`);
        }
      }

      counts[choice.mode]++;

      // 查找目标组织中的实际对象（成员 / 部门 / 角色）
      let target: { id: string; name: string; active?: boolean; archived?: boolean } | undefined;
      if (choice.mode === "existing") {
        const pool =
          identity.kind === "member"
            ? organization.users
            : identity.kind === "department"
              ? organization.spec.departments
              : organization.spec.roles;
        target = pool.find((item) => item.id === choice.targetId);
      }

      const targetActive = target
        ? "active" in target
          ? Boolean(target.active)
          : !target.archived
        : false;
      const warnings: string[] = [];

      if (choice.mode === "unresolved") {
        blockers.push(`「${identity.name}」尚未决定如何保留或对应`);
      }
      if (choice.mode === "existing" && !target) {
        blockers.push(`「${identity.name}」选择的目标不存在或不属于当前组织`);
      }
      if (choice.mode === "existing" && target && !targetActive) {
        warnings.push("目标已停用或归档，后续导入不能将它用于有效授权或新任务。");
      }
      if (choice.mode === "historical") {
        warnings.push("保留独立历史身份；不创建登录账号，不参与当前授权或待办。");
      }
      if (!identity.found) {
        warnings.push("原目录已缺少此身份，请结合原始记录核对，不能仅凭名称判断。");
      }

      // 核对本批次内是否出现多个来源身份指向同一目标，以及与其他已确认批次是否冲突
      if (choice.targetId) {
        const key = `${choice.kind}/${choice.targetId}`;
        const previous = targets.get(key);
        if (previous) {
          blockers.push(`「${identity.name}」与「${previous}」指向同一目标，不能合并不同来源身份`);
        }
        targets.set(key, identity.name);

        for (const batch of other) {
          for (const saved of batch.choices as MigrationIdentityChoice[]) {
            if (saved.kind !== choice.kind || !saved.targetId) continue;
            if (
              saved.sourceId === choice.sourceId &&
              (saved.targetId !== choice.targetId || saved.mode !== choice.mode)
            ) {
              blockers.push(
                `「${identity.name}」与「${batch.source.applicationName}」已确认的对应不同，请先核对并撤销相关确认`,
              );
            }
            if (saved.sourceId !== choice.sourceId && saved.targetId === choice.targetId) {
              blockers.push(
                `「${identity.name}」的目标已被「${batch.source.applicationName}」中的另一来源身份使用`,
              );
            }
          }
        }
      }

      let targetMeta: { targetName?: string; targetActive?: boolean } = {};
      if (target) {
        targetMeta = { targetName: target.name, targetActive };
      } else if (choice.mode === "historical") {
        targetMeta = { targetName: identity.name, targetActive: false };
      }

      return {
        source: identity,
        choice,
        ...targetMeta,
        warnings,
      };
    });

    // 3. 计算身份核对结果签名令牌
    const tokenPayload = {
      batchId: row.id,
      source,
      choices,
      organizationRevision: organization.revision,
      ...(memberAccounts.length ? { memberAccounts } : {}),
      ...(directoryKeys.length ? { directoryKeys } : {}),
      items,
      blockers,
    };
    const token = createHash("sha256").update(JSON.stringify(tokenPayload)).digest("hex");

    return {
      token,
      batchId: row.id,
      revision: row.revision,
      organizationRevision: organization.revision,
      confirmationCurrent: row.state === "identities_confirmed" && row.confirmed_token === token,
      counts,
      items,
      blockers: [...new Set(blockers)],
    };
  }

  /** 对指定迁移批次执行身份映射检查 */
  async review(actor: Actor, id: string, body: unknown) {
    requireAdmin(actor);
    object(body);

    return this.db.transaction(async (tx) => {
      const meta = await this.row(tx, actor, id);
      await this.lock(tx, actor, meta.source_namespace);

      const row = await this.row(tx, actor, id);
      if (
        row.revision !== body.expectedRevision ||
        row.source.fingerprint !== body.sourceFingerprint
      ) {
        throw new ConflictException("来源或身份草稿已变化，请重新读取后检查");
      }

      const organization = await this.organizations.snapshot(tx, actor);
      return this.inspect(tx, actor, row, organization);
    });
  }

  /** 确认身份映射（或撤销确认重回草稿状态） */
  async confirm(actor: Actor, id: string, body: unknown, reopen = false) {
    requireAdmin(actor);
    object(body);

    return this.db.transaction(async (tx) => {
      const result = await once(
        tx,
        actor,
        body.requestId,
        { migrationConfirm: id, reopen, body },
        async () => {
          const meta = await this.row(tx, actor, id);
          await this.lock(tx, actor, meta.source_namespace);

          const row = await this.row(tx, actor, id, true);
          if (row.revision !== body.expectedRevision) {
            throw new ConflictException("迁移批次已更新，请重新读取");
          }

          let token: string | null = null;
          if (!reopen) {
            if (row.source.fingerprint !== body.sourceFingerprint) {
              throw new ConflictException("来源快照已变化，请重新检查");
            }
            const organization = await this.organizations.snapshot(tx, actor);
            const review = await this.inspect(tx, actor, row, organization);
            if (review.blockers.length) {
              throw new ConflictException(review.blockers.join("；"));
            }
            if (body.token !== review.token) {
              throw new ConflictException(
                "组织、对应对象或其他迁移批次已变化，请重新检查身份对应",
              );
            }
            await retainHistoricalIdentities(tx, actor, row);
            token = review.token;
          } else if (row.state !== "identities_confirmed") {
            throw new ConflictException("此批次尚未确认身份，无需撤销");
          }

          const updateSql = `
            UPDATE migration_batches
            SET state = $2,
                confirmed_token = $3,
                confirmed_at = CASE WHEN $3::text IS NULL THEN NULL ELSE now() END,
                revision = revision + 1,
                updated_at = now()
            WHERE id = $1
            RETURNING *
          `;
          const { rows } = await tx.query(updateSql, [
            id,
            reopen ? "draft" : "identities_confirmed",
            token,
          ]);
          const updated = rows[0];
          await this.event(tx, actor, updated, reopen ? "reopen" : "confirm_identities");
          return id;
        },
      );

      return toBatchDto(await this.row(tx, actor, result));
    });
  }

  /** 查询迁移批次的审计事件历史 */
  async events(actor: Actor, id: string) {
    requireAdmin(actor);
    await this.row(this.db, actor, id);

    const sql = `
      SELECT
        e.id,
        e.revision,
        e.action,
        u.name AS "actorName",
        e.created_at AS "createdAt"
      FROM migration_batch_events e
      JOIN users u ON u.id = e.actor_id
      WHERE e.batch_id = $1
      ORDER BY e.revision DESC
      LIMIT 100
    `;
    const { rows } = await this.db.query(sql, [id]);
    return rows;
  }
}
