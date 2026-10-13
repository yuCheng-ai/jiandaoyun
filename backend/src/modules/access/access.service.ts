import { ForbiddenException, Injectable } from "@nestjs/common";
import {
  type AccessGrant,
  type FormSchema,
  type RecordGroupConfiguration,
  type ServerOrganization,
} from "@platform/contracts";
import type { Actor } from "../../core/auth/auth.service";
import { Database } from "../../core/database/database";
import { allFields } from "../../core/database/schema";
import { OrganizationService } from "../directory/organization.service";
import {
  directGroupConfiguration,
  eligibleRecordGroups,
  groupedRecordAccess,
  groupRecordSql,
  selectRecordGroups,
  type GroupRecordContext,
} from "./group-access";

/**
 * ============================================================================
 * 【表单与记录权限服务（统一简道云“权限组”模式）】
 *
 * 所有表单统一通过 `record_permission_groups` 表中的“权限组”控制访问权限。
 * 本文件对外提供 5 个核心方法：
 * 1. `context()`      ：从数据库加载当前组织架构与表单的权限组配置；
 * 2. `effective()`    ：计算打开表单或单条记录时的按钮权限（增删改查/导出/打印）与字段掩码（可改/只读/隐藏）；
 * 3. `readers()`      ：计算查看“正式记录列表”时的 SQL 过滤条件；
 * 4. `draftReaders()` ：计算查看“草稿箱列表”时的过滤条件（仅本人草稿）；
 * 5. `definitions()`  ：计算应用首页左侧菜单树中当前用户有权看到的表单 ID 列表。
 * ============================================================================
 */

type Queryable = Pick<Database, "query">;

/** 权限计算上下文：包含组织架构、目标表单 ID 与权限组配置 */
export interface PolicyContext {
  organization: ServerOrganization;
  definitionId: string;
  config: RecordGroupConfiguration;
}

export interface AccessContext extends GroupRecordContext {}

/** 记录列表的可见范围（用于生成 SQL 过滤条件，creators 为 null 表示不限制创建人） */
export interface ReadScope {
  creators: string[] | null;
  createdDepartments: string[];
  sql?: (alias: string, parameters: unknown[]) => string;
}

/**
 * 计算单条记录或单个表单的最终权限：
 * - 系统管理员直接拥有全部权限（所有字段可编辑）；
 * - 普通成员统一按简道云“权限组”计算操作权限与字段级读写掩码。
 */
export function effectiveAccess(
  actor: Actor,
  schema: FormSchema,
  context: PolicyContext,
  target: AccessContext = {},
): AccessGrant {
  if (actor.role === "admin") {
    const fields = Object.fromEntries(allFields(schema).map((f) => [f.id, "edit" as const]));
    return {
      userId: actor.id,
      read: true,
      create: true,
      edit: true,
      remove: true,
      export: true,
      print: true,
      scope: "all",
      fields,
    };
  }

  return groupedRecordAccess(
    actor,
    context.definitionId,
    schema,
    context.organization,
    context.config,
    target,
  );
}

@Injectable()
export class AccessService {
  constructor(
    private readonly db: Database,
    private readonly organizations: OrganizationService,
  ) {}

  /** 方法 1：加载指定表单的组织架构与权限组配置 */
  async context(tx: Queryable, actor: Actor, definitionId: string): Promise<PolicyContext> {
    const organization = await this.organizations.snapshot(tx, actor);
    if (actor.role === "admin") {
      return { organization, definitionId, config: directGroupConfiguration() };
    }

    const { rows } = await tx.query(
      "SELECT config, revision FROM record_permission_groups WHERE definition_id = $1",
      [definitionId],
    );
    const row = rows[0];
    const config = row
      ? { ...row.config, mode: "groups" as const, revision: row.revision }
      : directGroupConfiguration();

    return { organization, definitionId, config };
  }

  /** 方法 2：计算用户在指定表单或单条记录上的最终操作权限与字段掩码 */
  async effective(
    tx: Queryable,
    actor: Actor,
    definitionId: string,
    schema: FormSchema,
    target?: AccessContext,
  ): Promise<AccessGrant> {
    const ctx = await this.context(tx, actor, definitionId);
    return effectiveAccess(actor, schema, ctx, target);
  }

  /** 方法 3：计算“正式记录列表”的可见范围（生成权限组对应的 SQL WHERE 条件） */
  async readers(
    tx: Queryable,
    actor: Actor,
    definitionId: string,
    policyContext?: PolicyContext,
  ): Promise<ReadScope> {
    const ctx = policyContext ?? (await this.context(tx, actor, definitionId));
    if (actor.role === "admin") {
      return { creators: null, createdDepartments: [] };
    }

    const groups = selectRecordGroups(actor, definitionId, ctx.organization, ctx.config);
    if (!groups.some((g) => g.actions.includes("view"))) {
      throw new ForbiddenException("当前权限组不能查看正式记录");
    }

    return {
      creators: null,
      createdDepartments: [],
      sql: (alias, params) => groupRecordSql(groups, actor, ctx.organization, alias, params),
    };
  }

  /** 方法 4：计算“草稿箱列表”的可见范围（有填报权限即可查看本人保存的草稿） */
  async draftReaders(
    tx: Queryable,
    actor: Actor,
    definitionId: string,
    policyContext?: PolicyContext,
  ): Promise<ReadScope> {
    const ctx = policyContext ?? (await this.context(tx, actor, definitionId));
    if (actor.role === "admin") {
      return { creators: null, createdDepartments: [] };
    }

    const groups = selectRecordGroups(actor, definitionId, ctx.organization, ctx.config);
    if (!groups.some((g) => g.actions.includes("create"))) {
      throw new ForbiddenException("当前权限组没有填写草稿的权限");
    }

    return { creators: [actor.id], createdDepartments: [] };
  }

  /** 方法 5：获取当前用户在工作空间下有权看到的全部表单 ID（用于应用首页左侧表单树） */
  async definitions(tx: Queryable, actor: Actor): Promise<string[] | null> {
    const organization = await this.organizations.snapshot(tx, actor);
    if (actor.role === "admin") return null;

    const sql = `
      SELECT g.definition_id, g.config, g.revision
      FROM record_permission_groups g
      JOIN definitions d ON d.id = g.definition_id
      WHERE d.workspace_id = $1
    `;
    const { rows } = await tx.query(sql, [actor.workspaceId]);

    return rows
      .filter(
        (r) =>
          eligibleRecordGroups(actor, organization, {
            ...r.config,
            mode: "groups",
            revision: r.revision,
          }).length > 0,
      )
      .map((r) => r.definition_id);
  }
}




