import {
  BadRequestException,
  ConflictException,
  Injectable,
} from "@nestjs/common";
import { createHash } from "node:crypto";
import {
  migrationIdentityKey,
  type MigrationIdentityChoice,
  type MigrationIdentitySource,
  type MigrationOrganizationReview,
  type MigrationOrganizationSource,
  type ServerOrganization,
} from "@platform/contracts";
import { Actor, requireAdmin } from "../../core/auth/auth.service";
import { Database, Transaction } from "../../core/database/database";
import { object } from "../../core/database/schema";
import { OrganizationService } from "../directory/organization.service";
import { once } from "../processes/commands";
import { MigrationIdentityService } from "./migration-identities.service";

// ============================================================================
// 1. 来源组织架构数据解析与格式化辅助函数
// ============================================================================

/** 校验非空且长度合法的来源组织身份 ID */
function validateSourceId(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 200) {
    throw new BadRequestException("来源组织身份不合法");
  }
  return value;
}

/** 校验长度不超过 1000 的数组 */
function validateList(value: unknown): any[] {
  if (!Array.isArray(value) || value.length > 1000) {
    throw new BadRequestException("组织关系超过1000项或格式不合法");
  }
  return value;
}

/** 校验不重复的来源组织身份 ID 列表 */
function validateUniqueIds(value: unknown): string[] {
  const result = validateList(value).map(validateSourceId);
  if (new Set(result).size !== result.length) {
    throw new BadRequestException("来源组织引用重复");
  }
  return result;
}

/** 解析并校验来源组织架构数据（部门树、角色分组与成员部门分配） */
function parseSource(raw: unknown): MigrationOrganizationSource {
  object(raw);
  if (typeof raw.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(raw.fingerprint)) {
    throw new BadRequestException("组织来源标识不合法");
  }

  const departments = validateList(raw.departments).map((item) => {
    object(item);
    return {
      id: validateSourceId(item.id),
      parentId: item.parentId === null ? null : validateSourceId(item.parentId),
      managerIds: validateUniqueIds(item.managerIds),
    };
  });

  const roles = validateList(raw.roles).map((item) => {
    object(item);
    if (typeof item.includeChildren !== "boolean") {
      throw new BadRequestException("角色部门范围不合法");
    }
    return {
      id: validateSourceId(item.id),
      memberIds: validateUniqueIds(item.memberIds),
      departmentIds: validateUniqueIds(item.departmentIds),
      includeChildren: item.includeChildren,
    };
  });

  const assignments = validateList(raw.assignments).map((item) => {
    object(item);
    return {
      userId: validateSourceId(item.userId),
      departmentIds: validateUniqueIds(item.departmentIds),
      primaryDepartmentId:
        item.primaryDepartmentId === null ? null : validateSourceId(item.primaryDepartmentId),
    };
  });

  return {
    fingerprint: raw.fingerprint,
    departments,
    roles,
    assignments,
  };
}

/** 生成目标组织中成员或部门的可读标签（部门展示完整上级路径） */
function formatOrganizationLabel(
  organization: ServerOrganization,
  kind: "member" | "department",
  id: string | null,
): string {
  if (!id) return "无";

  if (kind === "member") {
    const user = organization.users.find((item) => item.id === id);
    return user ? `${user.name}（${user.username}）` : "不存在";
  }

  const parts: string[] = [];
  const seen = new Set<string>();
  let currentId: string | null = id;
  while (currentId && !seen.has(currentId)) {
    seen.add(currentId);
    const department = organization.spec.departments.find((item) => item.id === currentId);
    if (!department) return "不存在";
    parts.unshift(department.name);
    currentId = department.parentId;
  }
  return parts.join(" / ");
}

// ============================================================================
// 2. 组织架构关系迁移预览与执行服务
// ============================================================================

@Injectable()
export class MigrationOrganizationService {
  constructor(
    private readonly db: Database,
    private readonly organizations: OrganizationService,
    private readonly identities: MigrationIdentityService,
  ) {}

  /**
   * 核对来源组织关系与本批次已确认身份映射的匹配情况，计算导入前后的组织架构变更差异
   */
  private async inspect(
    tx: Transaction,
    actor: Actor,
    batch: any,
    source: MigrationOrganizationSource,
    expectedRevision: unknown,
  ): Promise<MigrationOrganizationReview> {
    if (
      batch.revision !== expectedRevision ||
      batch.source.fingerprint !== source.fingerprint
    ) {
      throw new ConflictException("来源或身份对应已变化，请重新读取后检查");
    }

    const identityReview = await this.identities.reviewIn(tx, actor, batch);
    const organization = await this.organizations.snapshot(tx, actor);
    requireAdmin(organization.users.find((user) => user.id === actor.id)!);

    const blockers = [...identityReview.blockers];
    if (!identityReview.confirmationCurrent) {
      blockers.push("请先重新检查并确认当前身份对应");
    }

    // 1. 校验组织关系中的成员、部门、角色列表是否与批次身份清单完全一致
    const identities = (batch.source as MigrationIdentitySource).identities;
    const choices = new Map(
      (batch.choices as MigrationIdentityChoice[]).map((item) => [
        migrationIdentityKey(item),
        item,
      ]),
    );

    const lists = {
      member: source.assignments.map((item) => item.userId),
      department: source.departments.map((item) => item.id),
      role: source.roles.map((item) => item.id),
    };

    for (const kind of ["member", "department", "role"] as const) {
      const expected = identities
        .filter((item) => item.kind === kind && item.found)
        .map((item) => item.sourceId)
        .sort();
      const actual = [...lists[kind]].sort();
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new BadRequestException(
          "组织关系与本批次身份清单不一致，不能遗漏、重复或添加其他身份",
        );
      }
    }

    // 2. 构造身份映射查找与变更描述辅助函数
    const getSourceName = (kind: string, id: string) =>
      identities.find((item) => item.kind === kind && item.sourceId === id)?.name || id;

    const mapToTargetId = (
      kind: "member" | "department" | "role",
      id: string,
    ): string | undefined => {
      const choice = choices.get(`${kind}/${id}`);
      if (!choice) {
        blockers.push(`「${getSourceName(kind, id)}」未包含在身份对应中`);
        return undefined;
      }
      if (choice.mode !== "existing") {
        blockers.push(`「${getSourceName(kind, id)}」未关联当前身份，不能用于有效组织关系`);
        return undefined;
      }
      return choice.targetId;
    };

    const mapTargetIdList = (kind: "member" | "department", ids: string[]) =>
      ids.map((id) => mapToTargetId(kind, id)).filter((id): id is string => !!id);

    const spec = structuredClone(organization.spec);
    const changes: MigrationOrganizationReview["changes"] = [];

    const label = (kind: "member" | "department", id: string | null) =>
      formatOrganizationLabel(organization, kind, id);

    const names = (kind: "member" | "department", ids: string[]) =>
      ids.map((id) => label(kind, id)).join("、") || "无";

    const describeDepartment = (item: (typeof spec.departments)[number]) =>
      `上级：${label("department", item.parentId)}；负责人：${names("member", item.managerIds || [])}`;

    const describeRole = (item: (typeof spec.roles)[number]) =>
      `成员：${names("member", item.memberIds)}；部门：${names("department", item.departmentIds)}${item.includeChildren ? "（含下级）" : "（不含下级）"}`;

    const describeMember = (item: (typeof spec.assignments)[number]) =>
      `部门：${names("department", item.departmentIds)}；主部门：${label("department", item.primaryDepartmentId)}`;

    const addChange = (
      kind: MigrationOrganizationReview["changes"][number]["kind"],
      title: string,
      before: string,
      after: string,
      changed: boolean,
    ) => {
      if (changed) {
        changes.push({ kind, name: title, before, after });
      }
    };

    // 3. 校验已映射身份的启用状态是否与来源一致
    for (const item of identityReview.items) {
      if (item.choice.mode === "existing" && item.targetActive !== item.source.active) {
        blockers.push(`「${item.source.name}」与目标的启用状态不同，请先核对账号或组织状态`);
      }
    }

    // 4. 演练部门层级与负责人变更
    for (const item of source.departments) {
      if (choices.get(`department/${item.id}`)?.mode === "historical") continue;
      const targetId = mapToTargetId("department", item.id);
      const target = spec.departments.find((value) => value.id === targetId);
      if (!target) continue;

      const before = describeDepartment(target);
      const original = JSON.stringify(target);
      target.parentId = item.parentId ? mapToTargetId("department", item.parentId) || null : null;
      target.managerIds = mapTargetIdList("member", item.managerIds);

      addChange(
        "department",
        target.name,
        before,
        describeDepartment(target),
        original !== JSON.stringify(target),
      );
    }

    // 5. 演练角色成员与部门范围变更
    for (const item of source.roles) {
      if (choices.get(`role/${item.id}`)?.mode === "historical") continue;
      const targetId = mapToTargetId("role", item.id);
      const target = spec.roles.find((value) => value.id === targetId);
      if (!target) continue;

      const before = describeRole(target);
      const original = JSON.stringify(target);
      target.memberIds = mapTargetIdList("member", item.memberIds);
      target.departmentIds = mapTargetIdList("department", item.departmentIds);
      target.includeChildren = item.includeChildren;

      addChange(
        "role",
        target.name,
        before,
        describeRole(target),
        original !== JSON.stringify(target),
      );
    }

    // 6. 演练成员部门分配与主部门变更
    for (const item of source.assignments) {
      if (choices.get(`member/${item.userId}`)?.mode === "historical") continue;
      const userId = mapToTargetId("member", item.userId);
      if (!userId) continue;

      const index = spec.assignments.findIndex((value) => value.userId === userId);
      const before = spec.assignments[index] || {
        userId,
        departmentIds: [],
        primaryDepartmentId: null,
      };
      const next = {
        userId,
        departmentIds: mapTargetIdList("department", item.departmentIds),
        primaryDepartmentId: item.primaryDepartmentId
          ? mapToTargetId("department", item.primaryDepartmentId) || null
          : null,
      };

      if (index < 0) {
        spec.assignments.push(next);
      } else {
        spec.assignments[index] = next;
      }

      addChange(
        "member",
        label("member", userId),
        describeMember(before),
        describeMember(next),
        JSON.stringify(before) !== JSON.stringify(next),
      );
    }

    // 7. 校验合并后的组织架构规范（如部门环路检测等）
    try {
      this.organizations.validateSpec(spec, organization);
    } catch (cause) {
      blockers.push((cause as Error).message);
    }

    const result = {
      batchRevision: batch.revision,
      organizationRevision: organization.revision,
      blockers: [...new Set(blockers)],
      changes,
      historical: identityReview.counts.historical,
      spec,
    };

    const token = createHash("sha256")
      .update(
        JSON.stringify({
          id: batch.id,
          source,
          identity: identityReview.token,
          result,
        }),
      )
      .digest("hex");

    return { token, ...result };
  }

  /** 预览组织架构关系导入的变更与阻塞项 */
  async review(actor: Actor, id: string, body: unknown) {
    requireAdmin(actor);
    object(body);
    const source = parseSource(body.source);

    return this.db.transaction(async (tx) => {
      const batch = await this.identities.lockedBatch(tx, actor, id);
      return this.inspect(tx, actor, batch, source, body.expectedRevision);
    });
  }

  /** 执行组织架构关系导入并更新迁移批次的确认令牌 */
  async apply(actor: Actor, id: string, body: unknown) {
    requireAdmin(actor);
    object(body);
    const source = parseSource(body.source);

    return this.db.transaction(async (tx) => {
      await this.organizations.lock(tx, actor.workspaceId, true);
      const current = await this.organizations.snapshot(tx, actor);
      requireAdmin(current.users.find((user) => user.id === actor.id)!);

      const batchId = await once(
        tx,
        actor,
        body.requestId,
        {
          organizationImport: id,
          source,
          expectedRevision: body.expectedRevision,
          token: body.token,
        },
        async () => {
          const batch = await this.identities.lockedBatch(tx, actor, id);
          const review = await this.inspect(tx, actor, batch, source, body.expectedRevision);

          if (review.blockers.length) {
            throw new ConflictException(review.blockers.join("；"));
          }
          if (body.token !== review.token) {
            throw new ConflictException(
              "组织、身份或导入内容已变化，请重新检查变化后再导入",
            );
          }
          if (!review.changes.length) {
            throw new BadRequestException("组织关系已一致，无需导入");
          }

          const saved = await this.organizations.saveIn(tx, actor, {
            expectedRevision: review.organizationRevision,
            spec: review.spec,
          });
          await this.identities.organizationImported(tx, actor, batch, {
            organizationSource: source,
            organizationRevision: saved.revision,
          });
          return batch.id as string;
        },
      );

      return { batchId, applied: true };
    });
  }
}
