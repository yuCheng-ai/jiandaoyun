import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  defaultCollectionRules,
  type CollectionConfiguration,
  type CollectionRules,
  type CollectionStatus,
} from "@platform/contracts";
import { randomUUID } from "node:crypto";
import { Actor, requireAdmin } from "../../core/auth/auth.service";
import { Database, Transaction } from "../../core/database/database";
import { object, uuid } from "../../core/validation";
import { AccessService } from "../access/access.service";
import { OrganizationService } from "../directory/organization.service";


type Queryable = Pick<Database, "query">;

// ============================================================================
// 1. 收集规则时间与配置解析辅助函数
// ============================================================================

const ISO_INSTANT_REGEX =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/;

/** 校验并规范化带明确时区的 ISO 日期时间字符串（空字符串表示不限制） */
function instant(raw: unknown): string {
  if (raw === "") return "";
  if (typeof raw !== "string") {
    throw new BadRequestException("填写时间格式不合法");
  }

  const parts = ISO_INSTANT_REGEX.exec(raw);
  const time = Date.parse(raw);
  if (!parts || !Number.isFinite(time)) {
    throw new BadRequestException("填写时间需要明确的时区");
  }

  const [year, month, day, hour, minute, second] = parts
    .slice(1, 7)
    .map((value) => Number(value || 0));
  const date = new Date(0);
  date.setUTCFullYear(year!, month! - 1, day!);
  const zone = parts[8]!;

  const invalidDate =
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() + 1 !== month ||
    date.getUTCDate() !== day;
  const invalidTime = hour! > 23 || minute! > 59 || second! > 59;
  const invalidZone =
    zone !== "Z" && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4)) > 59);

  if (invalidDate || invalidTime || invalidZone) {
    throw new BadRequestException("填写时间不是有效的日期时间");
  }
  return new Date(time).toISOString();
}

const ALLOWED_RULE_KEYS = new Set(["enabled", "startsAt", "endsAt", "limit", "allowRepeat"]);

/** 解析并校验表单收集规则配置（开关、起止时间、总数量上限、是否允许重复提交） */
export function parseCollectionRules(raw: unknown): CollectionRules {
  object(raw);
  if (Object.keys(raw).some((key) => !ALLOWED_RULE_KEYS.has(key))) {
    throw new BadRequestException("收集规则包含未支持的配置，请核对原设置");
  }

  if (
    typeof raw.enabled !== "boolean" ||
    typeof raw.allowRepeat !== "boolean" ||
    !Number.isSafeInteger(raw.limit) ||
    raw.limit < 0
  ) {
    throw new BadRequestException("请设置收集开关及非负整数上限，0 表示不限");
  }

  const startsAt = instant(raw.startsAt);
  const endsAt = instant(raw.endsAt);
  if (startsAt && endsAt && Date.parse(startsAt) >= Date.parse(endsAt)) {
    throw new BadRequestException("结束时间必须晚于开始时间");
  }

  return {
    enabled: raw.enabled,
    startsAt,
    endsAt,
    limit: raw.limit,
    allowRepeat: raw.allowRepeat,
  };
}

// ============================================================================
// 2. 表单收集规则服务（负责收集配额、时段控制与防并发超交校验）
// ============================================================================

@Injectable()
export class CollectionService {
  constructor(
    private readonly db: Database,
    private readonly organizations: OrganizationService,
    private readonly authorization: AccessService,
  ) {}

  /** 按固定加锁顺序（organization -> definition）锁定目标表单定义 */
  private async definition(tx: Transaction, actor: Actor, id: string, write = false) {
    uuid(id);
    await this.organizations.lock(tx, actor.workspaceId);

    const lockMode = write ? "UPDATE" : "SHARE";
    const { rows } = await tx.query(
      `SELECT * FROM definitions WHERE id=$1 AND workspace_id=$2 FOR ${lockMode}`,
      [id, actor.workspaceId],
    );
    const row = rows[0];
    if (!row) throw new NotFoundException("数据对象不存在或不可访问");
    return row;
  }

  /** 读取表单当前的收集规则配置（未配置时返回默认开放规则） */
  private async read(tx: Queryable, id: string) {
    const { rows } = await tx.query(
      "SELECT revision,rules FROM collection_rules WHERE definition_id=$1",
      [id],
    );
    const row = rows[0];
    return row
      ? { revision: row.revision as number, rules: row.rules as CollectionRules }
      : { revision: 0, rules: defaultCollectionRules() };
  }

  /** 读取表单收集配置及当前已提交的有效记录总数 */
  private async configuration(tx: Transaction, id: string): Promise<CollectionConfiguration> {
    const saved = await this.read(tx, id);
    const { rows } = await tx.query(
      "SELECT count(*)::int AS count FROM records WHERE definition_id=$1 AND state='active' AND archived_at IS NULL",
      [id],
    );
    return { ...saved, submittedRecords: rows[0].count };
  }

  /** 获取表单收集设置及已提交记录统计（仅管理员） */
  async get(actor: Actor, id: string) {
    requireAdmin(actor);
    return this.db.transaction(async (tx) => {
      await this.definition(tx, actor, id);
      return this.configuration(tx, id);
    });
  }

  /** 保存更新表单收集设置（外部事务入口） */
  async save(actor: Actor, id: string, body: unknown) {
    return this.db.transaction((tx) => this.saveIn(tx, actor, id, body));
  }

  /** 在已有事务内保存更新表单收集设置并记录配置变更审计事件 */
  async saveIn(tx: Transaction, actor: Actor, id: string, body: unknown) {
    requireAdmin(actor);
    object(body);

    const hasUnknownKey = Object.keys(body).some(
      (key) => !["expectedRevision", "rules"].includes(key),
    );
    if (hasUnknownKey || !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0) {
      throw new BadRequestException("收集设置需要当前配置版本");
    }

    const rules = parseCollectionRules(body.rules);

    // 保持与记录提交一致的加锁顺序：organization -> definition -> collection
    await this.definition(tx, actor, id, true);
    await this.lock(tx, id);

    const current = await this.read(tx, id);
    if (body.expectedRevision !== current.revision) {
      throw new ConflictException(
        "收集设置已被其他人修改，请对照最新设置后合并；当前输入保留",
      );
    }

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
  }

  /** 查询表单收集规则的历史修改轨迹（仅管理员） */
  async events(actor: Actor, id: string) {
    requireAdmin(actor);
    return this.db.transaction(async (tx) => {
      await this.definition(tx, actor, id);
      const { rows } = await tx.query(
        'SELECT revision,rules,created_at AS "createdAt" FROM collection_rule_events WHERE definition_id=$1 ORDER BY revision',
        [id],
      );
      return rows;
    });
  }

  /** 校验当前用户新增权限并检查表单当前是否开放收集 */
  async status(actor: Actor, id: string) {
    return this.db.transaction(async (tx) => {
      const def = await this.definition(tx, actor, id);
      const { rows } = await tx.query(
        "SELECT schema FROM definition_versions WHERE definition_id=$1 AND version=$2",
        [id, def.latest_version],
      );
      const version = rows[0];
      if (!version) throw new NotFoundException("数据对象尚未发布");

      const access = await this.authorization.effective(tx, actor, id, version.schema, {
        operation: "create",
      });
      if (!access.create) throw new ForbiddenException("当前没有新增权限");

      return this.statusIn(tx, actor, id);
    });
  }

  /**
   * 在已持有表单锁并完成新增鉴权的前提下，评估当前收集状态（不向普通填写人暴露总提交数）：
   * - 使用 clock_timestamp() 获取等待锁之后的真实墙钟时间，而非事务启动时的快照时间。
   */
  async statusIn(
    tx: Queryable,
    actor: Actor,
    id: string,
    creatorId = actor.id,
  ): Promise<CollectionStatus> {
    const { rules } = await this.read(tx, id);
    const { rows: timeRows } = await tx.query("SELECT clock_timestamp() AS now");
    const now = timeRows[0].now as Date;
    const checkedAt = now.toISOString();

    const closed = (code: CollectionStatus["code"], reason: string): CollectionStatus => ({
      accepting: false,
      code,
      reason,
      checkedAt,
    });

    if (!rules.enabled) return closed("paused", "当前已暂停收集");
    if (rules.startsAt && now.getTime() < Date.parse(rules.startsAt)) {
      return closed("not-started", "尚未到填写开始时间");
    }
    if (rules.endsAt && now.getTime() >= Date.parse(rules.endsAt)) {
      return closed("ended", "已超过填写截止时间");
    }

    if (rules.limit || !rules.allowRepeat) {
      const { rows } = await tx.query(
        "SELECT count(*)::int AS count, count(*) FILTER (WHERE created_by=$2)::int AS own FROM records WHERE definition_id=$1 AND state='active' AND archived_at IS NULL",
        [id, creatorId],
      );
      const result = rows[0];
      if (rules.limit && result.count >= rules.limit) {
        return closed("full", "已达到收集数量上限");
      }
      if (!rules.allowRepeat && result.own) {
        return closed("repeated", "当前填写成员已提交过记录，不允许重复提交");
      }
    }

    return { accepting: true, code: "open", checkedAt };
  }

  /** 获取表单收集级别的事务咨询锁，防止并发提交突破上限或重复提交限制 */
  private async lock(tx: Transaction, id: string) {
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`collection/${id}`]);
  }

  /** 在正式提交记录前加锁并强制校验表单当前处于可收集状态 */
  async requireSubmission(tx: Transaction, actor: Actor, id: string, creatorId = actor.id) {
    await this.lock(tx, id);
    const collection = await this.statusIn(tx, actor, id, creatorId);
    if (!collection.accepting) {
      throw new ConflictException({
        message: `${collection.reason}，当前输入保留，可先保存草稿。`,
        collection,
      });
    }
  }
}
