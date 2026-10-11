import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import {
  defaultCollectionRules,
  type CollectionConfiguration,
  type CollectionRules,
  type CollectionStatus,
} from "@platform/contracts";
import { Actor, requireAdmin } from "./auth";
import { AccessService } from "./access";
import { Database, Transaction } from "./database";
import { OrganizationService } from "./organization";
import { object, uuid } from "./schema";
type Queryable = Pick<Database, "query">;

function instant(raw: unknown): string {
  if (raw === "") return "";
  if (typeof raw !== "string")
    throw new BadRequestException("填写时间格式不合法");
  const parts =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/.exec(
      raw,
    );
  const time = Date.parse(raw);
  if (!parts || !Number.isFinite(time))
    throw new BadRequestException("填写时间需要明确的时区");
  const [year, month, day, hour, minute, second] = parts
    .slice(1, 7)
    .map((value) => Number(value || 0));
  const date = new Date(0);
  date.setUTCFullYear(year!, month! - 1, day!);
  const zone = parts[8]!;
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() + 1 !== month ||
    date.getUTCDate() !== day ||
    hour! > 23 ||
    minute! > 59 ||
    second! > 59 ||
    (zone !== "Z" &&
      (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4)) > 59))
  )
    throw new BadRequestException("填写时间不是有效的日期时间");
  return new Date(time).toISOString();
}
export function parseCollectionRules(raw: unknown): CollectionRules {
  object(raw);
  if (
    Object.keys(raw).some(
      (key) =>
        !["enabled", "startsAt", "endsAt", "limit", "allowRepeat"].includes(
          key,
        ),
    )
  )
    throw new BadRequestException("收集规则包含未支持的配置，请核对原设置");
  if (
    typeof raw.enabled !== "boolean" ||
    typeof raw.allowRepeat !== "boolean" ||
    !Number.isSafeInteger(raw.limit) ||
    raw.limit < 0
  )
    throw new BadRequestException("请设置收集开关及非负整数上限，0 表示不限");
  const startsAt = instant(raw.startsAt),
    endsAt = instant(raw.endsAt);
  if (startsAt && endsAt && Date.parse(startsAt) >= Date.parse(endsAt))
    throw new BadRequestException("结束时间必须晚于开始时间");
  return {
    enabled: raw.enabled,
    startsAt,
    endsAt,
    limit: raw.limit,
    allowRepeat: raw.allowRepeat,
  };
}

@Injectable()
export class CollectionService {
  constructor(
    private readonly db: Database,
    private readonly organizations: OrganizationService,
    private readonly authorization: AccessService,
  ) {}
  private async definition(
    tx: Transaction,
    actor: Actor,
    id: string,
    write = false,
  ) {
    uuid(id);
    await this.organizations.lock(tx, actor.workspaceId);
    const row = (
      await tx.query(
        `SELECT * FROM definitions WHERE id=$1 AND workspace_id=$2 FOR ${write ? "UPDATE" : "SHARE"}`,
        [id, actor.workspaceId],
      )
    ).rows[0];
    if (!row) throw new NotFoundException("数据对象不存在或不可访问");
    return row;
  }
  private async read(tx: Queryable, id: string) {
    const row = (
      await tx.query(
        "SELECT revision,rules FROM collection_rules WHERE definition_id=$1",
        [id],
      )
    ).rows[0];
    return row
      ? {
          revision: row.revision as number,
          rules: row.rules as CollectionRules,
        }
      : { revision: 0, rules: defaultCollectionRules() };
  }
  private async configuration(
    tx: Transaction,
    id: string,
  ): Promise<CollectionConfiguration> {
    const saved = await this.read(tx, id);
    const count = (
      await tx.query(
        "SELECT count(*)::int AS count FROM records WHERE definition_id=$1 AND state='active' AND archived_at IS NULL",
        [id],
      )
    ).rows[0].count;
    return { ...saved, submittedRecords: count };
  }
  async get(actor: Actor, id: string) {
    requireAdmin(actor);
    return this.db.transaction(async (tx) => {
      await this.definition(tx, actor, id);
      return this.configuration(tx, id);
    });
  }
  async save(actor: Actor, id: string, body: unknown) {
    requireAdmin(actor);
    object(body);
    if (
      Object.keys(body).some(
        (key) => !["expectedRevision", "rules"].includes(key),
      ) ||
      !Number.isSafeInteger(body.expectedRevision) ||
      body.expectedRevision < 0
    )
      throw new BadRequestException("收集设置需要当前配置版本");
    const rules = parseCollectionRules(body.rules);
    return this.db.transaction(async (tx) => {
      // Same organization -> definition -> collection order as submissions.
      await this.definition(tx, actor, id, true);
      await this.lock(tx, id);
      const current = await this.read(tx, id);
      if (body.expectedRevision !== current.revision)
        throw new ConflictException(
          "收集设置已被其他人修改，请对照最新设置后合并；当前输入保留",
        );
      const revision = current.revision + 1;
      await tx.query(
        "INSERT INTO collection_rules(definition_id,revision,rules) VALUES($1,$2,$3) ON CONFLICT(definition_id) DO UPDATE SET revision=$2,rules=$3,updated_at=now()",
        [id, revision, rules],
      );
      await tx.query(
        "INSERT INTO collection_rule_events(id,definition_id,actor_id,revision,rules) VALUES($1,$2,$3,$4,$5)",
        [randomUUID(), id, actor.id, revision, rules],
      );
      return this.configuration(tx, id);
    });
  }
  async events(actor: Actor, id: string) {
    requireAdmin(actor);
    return this.db.transaction(async (tx) => {
      await this.definition(tx, actor, id);
      return (
        await tx.query(
          'SELECT revision,rules,created_at AS "createdAt" FROM collection_rule_events WHERE definition_id=$1 ORDER BY revision',
          [id],
        )
      ).rows;
    });
  }
  async status(actor: Actor, id: string) {
    return this.db.transaction(async (tx) => {
      const def = await this.definition(tx, actor, id);
      const version = (
        await tx.query(
          "SELECT schema FROM definition_versions WHERE definition_id=$1 AND version=$2",
          [id, def.latest_version],
        )
      ).rows[0];
      if (!version) throw new NotFoundException("数据对象尚未发布");
      const access = await this.authorization.effective(
        tx,
        actor,
        id,
        version.schema,
        { operation: "create" },
      );
      if (!access.create) throw new ForbiddenException("当前没有新增权限");
      return this.statusIn(tx, actor, id);
    });
  }
  /** Internal callers already hold the definition lock and have authorized creation. No totals are disclosed. */
  async statusIn(
    tx: Queryable,
    actor: Actor,
    id: string,
    creatorId = actor.id,
  ): Promise<CollectionStatus> {
    const { rules } = await this.read(tx, id);
    // Wall-clock time after waiting for locks, not the transaction's older start time.
    const now = (await tx.query("SELECT clock_timestamp() AS now")).rows[0]
      .now as Date;
    const checkedAt = now.toISOString();
    const closed = (
      code: CollectionStatus["code"],
      reason: string,
    ): CollectionStatus => ({ accepting: false, code, reason, checkedAt });
    if (!rules.enabled) return closed("paused", "当前已暂停收集");
    if (rules.startsAt && now.getTime() < Date.parse(rules.startsAt))
      return closed("not-started", "尚未到填写开始时间");
    if (rules.endsAt && now.getTime() >= Date.parse(rules.endsAt))
      return closed("ended", "已超过填写截止时间");
    if (rules.limit || !rules.allowRepeat) {
      const result = (
        await tx.query(
          "SELECT count(*)::int AS count, count(*) FILTER (WHERE created_by=$2)::int AS own FROM records WHERE definition_id=$1 AND state='active' AND archived_at IS NULL",
          [id, creatorId],
        )
      ).rows[0];
      if (rules.limit && result.count >= rules.limit)
        return closed("full", "已达到收集数量上限");
      if (!rules.allowRepeat && result.own)
        return closed("repeated", "当前填写成员已提交过记录，不允许重复提交");
    }
    return { accepting: true, code: "open", checkedAt };
  }
  private async lock(tx: Transaction, id: string) {
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `collection/${id}`,
    ]);
  }
  async requireSubmission(
    tx: Transaction,
    actor: Actor,
    id: string,
    creatorId = actor.id,
  ) {
    await this.lock(tx, id);
    const collection = await this.statusIn(tx, actor, id, creatorId);
    if (!collection.accepting)
      throw new ConflictException({
        message: `${collection.reason}，当前输入保留，可先保存草稿。`,
        collection,
      });
  }
}
