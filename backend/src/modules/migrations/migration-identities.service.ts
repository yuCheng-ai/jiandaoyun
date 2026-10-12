import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { createHash, randomUUID } from "node:crypto";
import { migrationIdentityKey, type DirectoryIdentity, type MigrationBatch, type MigrationIdentityChoice, type MigrationIdentityReview, type MigrationIdentitySource, type MigrationSourceIdentity, type ServerOrganization } from "@platform/contracts";
import { Actor, requireAdmin } from "../../core/auth/auth.service";
import { Database, Transaction } from "../../core/database/database";
import { OrganizationService } from "../directory/organization.service";
import { object, uuid } from "../../core/database/schema";
import { once } from "../processes/commands";
import { retainHistoricalIdentities } from "../directory/historical-identities";

const kinds = ["member", "department", "role"];
const text = (value: unknown, limit = 200): string => {
  if (typeof value !== "string" || !value.trim() || value.length > limit || /[\u0000-\u001f]/.test(value)) throw new BadRequestException("来源身份名称或标识格式不合法");
  return value;
};
function sourceInput(raw: unknown): MigrationIdentitySource {
  object(raw); uuid(raw.namespace); object(raw.counts);
  if (typeof raw.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(raw.fingerprint)) throw new BadRequestException("需要完整的来源快照标识");
  if (!Array.isArray(raw.identities) || raw.identities.length > 1000) throw new BadRequestException("单次最多核对 1000 个组织身份");
  const counts = Object.fromEntries(["forms", "versions", "records", "rows", "issues"].map(key => {
    const count = raw.counts[key]; if (!Number.isSafeInteger(count) || count < 0 || count > 1e9) throw new BadRequestException("来源资源统计不合法");
    return [key, count];
  })) as MigrationIdentitySource["counts"];
  const identities: MigrationSourceIdentity[] = raw.identities.map((item: unknown) => {
    object(item);
    if (!kinds.includes(item.kind) || typeof item.found !== "boolean" || typeof item.active !== "boolean" || (!item.found && item.active)) throw new BadRequestException("来源组织身份状态不合法");
    return { kind: item.kind, sourceId: text(item.sourceId), name: text(item.name), found: item.found, active: item.active };
  });
  if (new Set(identities.map(migrationIdentityKey)).size !== identities.length) throw new BadRequestException("来源身份重复，请重新检查应用");
  identities.sort((a, b) => migrationIdentityKey(a).localeCompare(migrationIdentityKey(b)));
  return { namespace: raw.namespace.toLowerCase(), applicationId: text(raw.applicationId), applicationName: text(raw.applicationName), fingerprint: raw.fingerprint, identities, counts };
}
const dto = (row: any): MigrationBatch => ({ id: row.id, revision: row.revision, state: row.state, source: row.source, choices: row.choices, confirmedAt: row.confirmed_at?.toISOString() || null, updatedAt: row.updated_at.toISOString() });

@Injectable()
export class MigrationIdentityService {
  constructor(private readonly db: Database, private readonly organizations: OrganizationService) {}
  async lockedBatch(tx: Transaction, actor: Actor, id: string) {
    requireAdmin(actor);
    const meta = await this.row(tx, actor, id); await this.lock(tx, actor, meta.source_namespace);
    return this.row(tx, actor, id, true);
  }
  async reviewIn(tx: Transaction, actor: Actor, row: any) {
    requireAdmin(actor);
    return this.inspect(tx, actor, row, await this.organizations.snapshot(tx, actor));
  }
  private async lock(tx: Transaction, actor: Actor, namespace: string) {
    await this.organizations.lock(tx, actor.workspaceId);
    // Serialize overlapping applications before their batch rows; no target data is mutated.
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`migration-source:${actor.workspaceId}:${namespace}`]);
  }
  private async row(tx: Pick<Database, "query">, actor: Actor, id: string, lock = false) {
    uuid(id);
    const row = (await tx.query(`SELECT * FROM migration_batches WHERE id=$1 AND workspace_id=$2 ${lock ? "FOR UPDATE" : ""}`, [id, actor.workspaceId])).rows[0];
    if (!row) throw new NotFoundException("迁移批次不存在或不可访问");
    return row;
  }
  private async event(tx: Transaction, actor: Actor, row: any, action: string, detail: object = {}) {
    await tx.query("INSERT INTO migration_batch_events(id,batch_id,actor_id,revision,action,detail) VALUES($1,$2,$3,$4,$5,$6)", [randomUUID(), row.id, actor.id, row.revision, action, { source: row.source, choices: row.choices, state: row.state, ...detail }]);
  }
  async organizationImported(tx: Transaction, actor: Actor, row: any, detail: object) {
    const review = await this.reviewIn(tx, actor, row);
    if (review.blockers.length) throw new ConflictException(review.blockers.join("；"));
    const updated = (await tx.query("UPDATE migration_batches SET confirmed_token=$2,revision=revision+1,updated_at=now() WHERE id=$1 RETURNING *", [row.id, review.token])).rows[0];
    await this.event(tx, actor, updated, "import_organization", detail);
    return dto(updated);
  }
  private async reserve(tx: Transaction, actor: Actor, source: MigrationIdentitySource) {
    for (const item of source.identities) await tx.query("INSERT INTO migration_identity_keys(workspace_id,source_namespace,kind,source_id,historical_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING", [actor.workspaceId, source.namespace, item.kind, item.sourceId, randomUUID()]);
    return (await tx.query("SELECT kind,source_id,historical_id FROM migration_identity_keys WHERE workspace_id=$1 AND source_namespace=$2", [actor.workspaceId, source.namespace])).rows;
  }
  private async choices(tx: Transaction, actor: Actor, source: MigrationIdentitySource, raw: unknown): Promise<MigrationIdentityChoice[]> {
    if (!Array.isArray(raw) || raw.length !== source.identities.length) throw new BadRequestException("请为每个来源身份保留一项对应决定");
    const reserved = await this.reserve(tx, actor, source), seen = new Set<string>();
    return raw.map(item => {
      object(item); const key = migrationIdentityKey(item as MigrationIdentityChoice);
      if (!source.identities.some(identity => migrationIdentityKey(identity) === key) || seen.has(key) || !["unresolved", "existing", "historical"].includes(item.mode)) throw new BadRequestException("身份对应项重复、缺失或不属于本批次");
      seen.add(key);
      if (item.mode === "existing") uuid(item.targetId);
      const targetId = item.mode === "historical" ? reserved.find(value => value.kind === item.kind && value.source_id === item.sourceId)!.historical_id : item.mode === "existing" ? item.targetId.toLowerCase() : undefined;
      return { kind: item.kind, sourceId: item.sourceId, mode: item.mode, ...(targetId ? { targetId } : {}) };
    }).sort((a, b) => migrationIdentityKey(a).localeCompare(migrationIdentityKey(b)));
  }
  async list(actor: Actor, namespace: string, applicationId?: string) {
    requireAdmin(actor); uuid(namespace);
    return (await this.db.query("SELECT * FROM migration_batches WHERE workspace_id=$1 AND source_namespace=$2 AND ($3::text IS NULL OR source_application_id=$3) ORDER BY updated_at DESC", [actor.workspaceId, namespace, applicationId || null])).rows.map(dto);
  }
  async get(actor: Actor, id: string) { requireAdmin(actor); return dto(await this.row(this.db, actor, id)); }
  async create(actor: Actor, body: unknown) {
    requireAdmin(actor); object(body); const source = sourceInput(body.source);
    return this.db.transaction(async tx => {
      const id = await once(tx, actor, body.requestId, { migrationCreate: source }, async () => {
        await this.lock(tx, actor, source.namespace);
        if ((await tx.query("SELECT 1 FROM migration_batches WHERE workspace_id=$1 AND source_namespace=$2 AND source_application_id=$3", [actor.workspaceId, source.namespace, source.applicationId])).rowCount) throw new ConflictException("此来源应用已有迁移批次，请重新读取已有对应草稿");
        const choices = await this.choices(tx, actor, source, source.identities.map(item => ({ kind: item.kind, sourceId: item.sourceId, mode: "unresolved" })));
        const row = (await tx.query("INSERT INTO migration_batches(id,workspace_id,source_namespace,source_application_id,source,choices,created_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *", [randomUUID(), actor.workspaceId, source.namespace, source.applicationId, source, JSON.stringify(choices), actor.id])).rows[0];
        await this.event(tx, actor, row, "create"); return row.id;
      });
      return dto(await this.row(tx, actor, id));
    });
  }
  async save(actor: Actor, id: string, body: unknown, refresh = false) {
    requireAdmin(actor); object(body);
    return this.db.transaction(async tx => {
      const result = await once(tx, actor, body.requestId, { migrationSave: id, refresh, body }, async () => {
        const meta = await this.row(tx, actor, id); await this.lock(tx, actor, meta.source_namespace);
        const row = await this.row(tx, actor, id, true);
        if (body.expectedRevision !== row.revision) throw new ConflictException("身份对应已被修改，输入已保留；请重新读取后合并");
        if (row.state === "identities_confirmed") throw new ConflictException("先撤销本批次身份确认，再修改来源或对应关系");
        const source = refresh ? sourceInput(body.source) : row.source as MigrationIdentitySource;
        if (source.namespace !== row.source_namespace || source.applicationId !== row.source_application_id) throw new BadRequestException("迁移批次的来源不能替换");
        if (!refresh && body.sourceFingerprint !== source.fingerprint) throw new ConflictException("来源快照已变化，请重新核对当前应用");
        const choices = await this.choices(tx, actor, source, refresh ? source.identities.map(item => row.choices.find((choice: MigrationIdentityChoice) => migrationIdentityKey(choice) === migrationIdentityKey(item)) || { kind: item.kind, sourceId: item.sourceId, mode: "unresolved" }) : body.choices);
        const updated = (await tx.query("UPDATE migration_batches SET source=$2,choices=$3,revision=revision+1,confirmed_token=NULL,confirmed_at=NULL,updated_at=now() WHERE id=$1 RETURNING *", [id, source, JSON.stringify(choices)])).rows[0];
        await this.event(tx, actor, updated, refresh ? "refresh_source" : "save"); return id;
      });
      return dto(await this.row(tx, actor, result));
    });
  }
  private async inspect(tx: Transaction, actor: Actor, row: any, organization: ServerOrganization): Promise<MigrationIdentityReview> {
    const source = row.source as MigrationIdentitySource, choices = row.choices as MigrationIdentityChoice[], counts = { existing: 0, historical: 0, unresolved: 0 }, blockers: string[] = [];
    const other = (await tx.query("SELECT id,source,choices FROM migration_batches WHERE workspace_id=$1 AND source_namespace=$2 AND id<>$3 AND state='identities_confirmed'", [actor.workspaceId, source.namespace, row.id])).rows;
    const memberAccounts = (await tx.query("SELECT member_id,account_id,revision FROM member_accounts WHERE workspace_id=$1 AND source_namespace=$2 ORDER BY member_id", [actor.workspaceId, source.namespace])).rows.filter(link => source.identities.some(identity => identity.kind === 'member' && identity.sourceId === link.member_id) || choices.some(choice => choice.kind === 'member' && choice.mode === 'existing' && choice.targetId === link.account_id));
    const directoryKeys: DirectoryIdentity[] = ((await tx.query("SELECT identities FROM organization_directories WHERE workspace_id=$1 AND source_namespace=$2", [actor.workspaceId, source.namespace])).rows[0]?.identities || []).filter((key: DirectoryIdentity) => source.identities.some(identity => identity.kind === key.kind && identity.sourceId === key.id) || choices.some(choice => choice.kind === key.kind && choice.targetId === key.targetId));
    const targets = new Map<string, string>();
    const items = source.identities.map(identity => {
      const choice = choices.find(item => migrationIdentityKey(item) === migrationIdentityKey(identity))!;
      if (identity.kind === "member") for (const link of memberAccounts) {
        if ((link.member_id === identity.sourceId && (choice.mode !== "existing" || choice.targetId !== link.account_id)) || (link.member_id !== identity.sourceId && choice.targetId === link.account_id))
          blockers.push(`「${identity.name}」与通讯录已关联的登录账号不一致`);
      }
      for (const key of directoryKeys) if (key.kind === identity.kind && ((key.id === identity.sourceId && (choice.mode !== 'existing' || choice.targetId !== key.targetId)) || (key.id !== identity.sourceId && choice.targetId === key.targetId))) blockers.push(`「${identity.name}」与通讯录已接入的组织身份不一致`);
      counts[choice.mode]++;
      const target = choice.mode === "existing" ? (identity.kind === "member" ? organization.users : identity.kind === "department" ? organization.spec.departments : organization.spec.roles).find(item => item.id === choice.targetId) : undefined;
      const targetActive = target ? ("active" in target ? target.active : !target.archived) : false, warnings: string[] = [];
      if (choice.mode === "unresolved") blockers.push(`「${identity.name}」尚未决定如何保留或对应`);
      if (choice.mode === "existing" && !target) blockers.push(`「${identity.name}」选择的目标不存在或不属于当前组织`);
      if (choice.mode === "existing" && target && !targetActive) warnings.push("目标已停用或归档，后续导入不能将它用于有效授权或新任务。");
      if (choice.mode === "historical") warnings.push("保留独立历史身份；不创建登录账号，不参与当前授权或待办。");
      if (!identity.found) warnings.push("原目录已缺少此身份，请结合原始记录核对，不能仅凭名称判断。");
      if (choice.targetId) {
        const key = `${choice.kind}/${choice.targetId}`, previous = targets.get(key);
        if (previous) blockers.push(`「${identity.name}」与「${previous}」指向同一目标，不能合并不同来源身份`);
        targets.set(key, identity.name);
        for (const batch of other) for (const saved of batch.choices as MigrationIdentityChoice[]) {
          if (saved.kind !== choice.kind || !saved.targetId) continue;
          if (saved.sourceId === choice.sourceId && (saved.targetId !== choice.targetId || saved.mode !== choice.mode)) blockers.push(`「${identity.name}」与「${batch.source.applicationName}」已确认的对应不同，请先核对并撤销相关确认`);
          if (saved.sourceId !== choice.sourceId && saved.targetId === choice.targetId) blockers.push(`「${identity.name}」的目标已被「${batch.source.applicationName}」中的另一来源身份使用`);
        }
      }
      return { source: identity, choice, ...(target ? { targetName: target.name, targetActive } : choice.mode === "historical" ? { targetName: identity.name, targetActive: false } : {}), warnings };
    });
    const token = createHash("sha256").update(JSON.stringify({ batchId: row.id, source, choices, organizationRevision: organization.revision, ...(memberAccounts.length ? { memberAccounts } : {}), ...(directoryKeys.length ? { directoryKeys } : {}), items, blockers })).digest("hex");
    return { token, batchId: row.id, revision: row.revision, organizationRevision: organization.revision, confirmationCurrent: row.state === "identities_confirmed" && row.confirmed_token === token, counts, items, blockers: [...new Set(blockers)] };
  }
  async review(actor: Actor, id: string, body: unknown) {
    requireAdmin(actor); object(body);
    return this.db.transaction(async tx => {
      const meta = await this.row(tx, actor, id); await this.lock(tx, actor, meta.source_namespace);
      const row = await this.row(tx, actor, id);
      if (row.revision !== body.expectedRevision || row.source.fingerprint !== body.sourceFingerprint) throw new ConflictException("来源或身份草稿已变化，请重新读取后检查");
      return this.inspect(tx, actor, row, await this.organizations.snapshot(tx, actor));
    });
  }
  async confirm(actor: Actor, id: string, body: unknown, reopen = false) {
    requireAdmin(actor); object(body);
    return this.db.transaction(async tx => {
      const result = await once(tx, actor, body.requestId, { migrationConfirm: id, reopen, body }, async () => {
        const meta = await this.row(tx, actor, id); await this.lock(tx, actor, meta.source_namespace);
        const row = await this.row(tx, actor, id, true);
        if (row.revision !== body.expectedRevision) throw new ConflictException("迁移批次已更新，请重新读取");
        let token: string | null = null;
        if (!reopen) {
          if (row.source.fingerprint !== body.sourceFingerprint) throw new ConflictException("来源快照已变化，请重新检查");
          const review = await this.inspect(tx, actor, row, await this.organizations.snapshot(tx, actor));
          if (review.blockers.length) throw new ConflictException(review.blockers.join("；"));
          if (body.token !== review.token) throw new ConflictException("组织、对应对象或其他迁移批次已变化，请重新检查身份对应");
          await retainHistoricalIdentities(tx, actor, row);
          token = review.token;
        } else if (row.state !== "identities_confirmed") throw new ConflictException("此批次尚未确认身份，无需撤销");
        const updated = (await tx.query("UPDATE migration_batches SET state=$2,confirmed_token=$3,confirmed_at=CASE WHEN $3::text IS NULL THEN NULL ELSE now() END,revision=revision+1,updated_at=now() WHERE id=$1 RETURNING *", [id, reopen ? "draft" : "identities_confirmed", token])).rows[0];
        await this.event(tx, actor, updated, reopen ? "reopen" : "confirm_identities"); return id;
      });
      return dto(await this.row(tx, actor, result));
    });
  }
  async events(actor: Actor, id: string) {
    requireAdmin(actor); await this.row(this.db, actor, id);
    return (await this.db.query("SELECT e.id,e.revision,e.action,u.name AS \"actorName\",e.created_at AS \"createdAt\" FROM migration_batch_events e JOIN users u ON u.id=e.actor_id WHERE e.batch_id=$1 ORDER BY e.revision DESC LIMIT 100", [id])).rows;
  }
}
