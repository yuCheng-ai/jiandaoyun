import {
  BadRequestException,
  ConflictException,
  Injectable,
} from "@nestjs/common";
import { createHash } from "node:crypto";
import {
  migrationIdentityKey,
  type MigrationOrganizationReview,
  type MigrationOrganizationSource,
  type MigrationIdentityChoice,
  type MigrationIdentitySource,
} from "@platform/contracts";
import { Actor, requireAdmin } from "./auth";
import { Database, Transaction } from "./database";
import { OrganizationService } from "./organization";
import { MigrationIdentityService } from "./migration-identities";
import { once } from "./commands";
import { object } from "./schema";

function parseSource(raw: unknown): MigrationOrganizationSource {
  object(raw);
  if (
    typeof raw.fingerprint !== "string" ||
    !/^[a-f0-9]{64}$/.test(raw.fingerprint)
  )
    throw new BadRequestException("组织来源标识不合法");
  const id = (value: unknown): string => {
    if (typeof value !== "string" || !value || value.length > 200)
      throw new BadRequestException("来源组织身份不合法");
    return value;
  };
  const list = (value: unknown): any[] => {
    if (!Array.isArray(value) || value.length > 1000)
      throw new BadRequestException("组织关系超过1000项或格式不合法");
    return value;
  };
  const ids = (value: unknown) => {
    const result = list(value).map(id);
    if (new Set(result).size !== result.length)
      throw new BadRequestException("来源组织引用重复");
    return result;
  };
  return {
    fingerprint: raw.fingerprint,
    departments: list(raw.departments).map((item) => {
      object(item);
      return {
        id: id(item.id),
        parentId: item.parentId === null ? null : id(item.parentId),
        managerIds: ids(item.managerIds),
      };
    }),
    roles: list(raw.roles).map((item) => {
      object(item);
      if (typeof item.includeChildren !== "boolean")
        throw new BadRequestException("角色部门范围不合法");
      return {
        id: id(item.id),
        memberIds: ids(item.memberIds),
        departmentIds: ids(item.departmentIds),
        includeChildren: item.includeChildren,
      };
    }),
    assignments: list(raw.assignments).map((item) => {
      object(item);
      return {
        userId: id(item.userId),
        departmentIds: ids(item.departmentIds),
        primaryDepartmentId:
          item.primaryDepartmentId === null
            ? null
            : id(item.primaryDepartmentId),
      };
    }),
  };
}

@Injectable()
export class MigrationOrganizationService {
  constructor(
    private readonly db: Database,
    private readonly organizations: OrganizationService,
    private readonly identities: MigrationIdentityService,
  ) {}
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
    )
      throw new ConflictException("来源或身份对应已变化，请重新读取后检查");
    const identityReview = await this.identities.reviewIn(tx, actor, batch);
    const organization = await this.organizations.snapshot(tx, actor);
    requireAdmin(organization.users.find((user) => user.id === actor.id)!);
    const blockers = [...identityReview.blockers];
    if (!identityReview.confirmationCurrent)
      blockers.push("请先重新检查并确认当前身份对应");
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
      if (JSON.stringify([...lists[kind]].sort()) !== JSON.stringify(expected))
        throw new BadRequestException(
          "组织关系与本批次身份清单不一致，不能遗漏、重复或添加其他身份",
        );
    }
    const name = (kind: string, id: string) =>
      identities.find((item) => item.kind === kind && item.sourceId === id)
        ?.name || id;
    const map = (
      kind: "member" | "department" | "role",
      id: string,
    ): string | undefined => {
      const choice = choices.get(`${kind}/${id}`);
      if (!choice) {
        blockers.push(`「${name(kind, id)}」未包含在身份对应中`);
        return;
      }
      if (choice.mode !== "existing") {
        blockers.push(
          `「${name(kind, id)}」未关联当前身份，不能用于有效组织关系`,
        );
        return;
      }
      return choice.targetId;
    };
    const refs = (kind: "member" | "department", ids: string[]) =>
      ids.map((id) => map(kind, id)).filter((id): id is string => !!id);
    const spec = structuredClone(organization.spec),
      changes: MigrationOrganizationReview["changes"] = [];
    const label = (
      kind: "member" | "department",
      id: string | null,
    ): string => {
      if (!id) return "无";
      if (kind === "member") {
        const user = organization.users.find((item) => item.id === id);
        return user ? `${user.name}（${user.username}）` : "不存在";
      }
      const parts: string[] = [],
        seen = new Set<string>();
      while (id && !seen.has(id)) {
        seen.add(id);
        const department = organization.spec.departments.find(
          (item) => item.id === id,
        );
        if (!department) return "不存在";
        parts.unshift(department.name);
        id = department.parentId;
      }
      return parts.join(" / ");
    };
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
      if (changed) changes.push({ kind, name: title, before, after });
    };
    for (const item of identityReview.items)
      if (
        item.choice.mode === "existing" &&
        item.targetActive !== item.source.active
      )
        blockers.push(
          `「${item.source.name}」与目标的启用状态不同，请先核对账号或组织状态`,
        );
    for (const item of source.departments) {
      if (choices.get(`department/${item.id}`)?.mode === "historical") continue;
      const target = spec.departments.find(
        (value) => value.id === map("department", item.id),
      );
      if (!target) continue;
      const before = describeDepartment(target),
        original = JSON.stringify(target);
      target.parentId = item.parentId
        ? map("department", item.parentId) || null
        : null;
      target.managerIds = refs("member", item.managerIds);
      addChange(
        "department",
        target.name,
        before,
        describeDepartment(target),
        original !== JSON.stringify(target),
      );
    }
    for (const item of source.roles) {
      if (choices.get(`role/${item.id}`)?.mode === "historical") continue;
      const target = spec.roles.find(
        (value) => value.id === map("role", item.id),
      );
      if (!target) continue;
      const before = describeRole(target),
        original = JSON.stringify(target);
      target.memberIds = refs("member", item.memberIds);
      target.departmentIds = refs("department", item.departmentIds);
      target.includeChildren = item.includeChildren;
      addChange(
        "role",
        target.name,
        before,
        describeRole(target),
        original !== JSON.stringify(target),
      );
    }
    for (const item of source.assignments) {
      if (choices.get(`member/${item.userId}`)?.mode === "historical") continue;
      const userId = map("member", item.userId);
      if (!userId) continue;
      const index = spec.assignments.findIndex(
        (value) => value.userId === userId,
      );
      const before = spec.assignments[index] || {
        userId,
        departmentIds: [],
        primaryDepartmentId: null,
      };
      const next = {
        userId,
        departmentIds: refs("department", item.departmentIds),
        primaryDepartmentId: item.primaryDepartmentId
          ? map("department", item.primaryDepartmentId) || null
          : null,
      };
      if (index < 0) spec.assignments.push(next);
      else spec.assignments[index] = next;
      addChange(
        "member",
        label("member", userId),
        describeMember(before),
        describeMember(next),
        JSON.stringify(before) !== JSON.stringify(next),
      );
    }
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
  async review(actor: Actor, id: string, body: unknown) {
    requireAdmin(actor);
    object(body);
    const source = parseSource(body.source);
    return this.db.transaction(async (tx) =>
      this.inspect(
        tx,
        actor,
        await this.identities.lockedBatch(tx, actor, id),
        source,
        body.expectedRevision,
      ),
    );
  }
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
          const batch = await this.identities.lockedBatch(tx, actor, id),
            review = await this.inspect(
              tx,
              actor,
              batch,
              source,
              body.expectedRevision,
            );
          if (review.blockers.length)
            throw new ConflictException(review.blockers.join("；"));
          if (body.token !== review.token)
            throw new ConflictException(
              "组织、身份或导入内容已变化，请重新检查变化后再导入",
            );
          if (!review.changes.length)
            throw new BadRequestException("组织关系已一致，无需导入");
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
