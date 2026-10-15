import {
  BadRequestException,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from "@nestjs/common";
import {
  effectiveRecordAccess,
  eligibleRecordGroups,
  emptyRecordGroupConfiguration,
  filterExpected,
  RecordAccessDeniedError,
  recordDepartmentIds,
  selectRecordGroups,
  type AccessGrant,
  type DataFilter,
  type FormSchema,
  type RecordAccessContext,
  type RecordAccessPolicy,
  type RecordPermissionGroup,
  type ServerOrganization,
} from "@platform/contracts";
import {
  AuthGuard,
  AuthService,
  type Actor,
  type AuthenticatedRequest,
} from "../../core/auth/auth.service";
import type { Database } from "../../core/database/database";
import { OrganizationService } from "../directory/organization.service";

type Queryable = Pick<Database, "query">;

/** 表单运行时选择仅属于访问权限模块，不进入基础认证身份。 */
export interface AccessActor extends Actor {
  accessGroups?: Record<string, string>;
}

export interface RecordAccessRequest extends AuthenticatedRequest {
  actor: AccessActor;
}

/** 先复用基础会话认证，再解析表单权限组选取；真实授权由规则重新计算。 */
@Injectable()
export class RecordAccessGuard extends AuthGuard {
  constructor(auth: AuthService) {
    super(auth);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    await super.canActivate(context);
    const request = context.switchToHttp().getRequest<RecordAccessRequest>();
    const header = request.headers["x-platform-access-groups"];
    if (header === undefined) return true;

    try {
      if (typeof header !== "string" || header.length > 12000) {
        throw new Error();
      }
      const choices = JSON.parse(header);
      if (
        !choices ||
        typeof choices !== "object" ||
        Array.isArray(choices) ||
        Object.keys(choices).length > 50
      ) {
        throw new Error();
      }
      for (const [key, value] of Object.entries(choices)) {
        const isValidKey = /^[0-9a-f-]{36}$/i.test(key);
        const isValidValue = typeof value === "string" && value.length > 0 && value.length <= 200;
        if (!isValidKey || !isValidValue) {
          throw new Error();
        }
      }
      request.actor.accessGroups = choices;
    } catch {
      throw new BadRequestException("权限组选择格式不合法");
    }
    return true;
  }
}

export type AccessContext = RecordAccessContext;
export type PolicyContext = Omit<RecordAccessPolicy, "organization"> & {
  organization: ServerOrganization;
};

/** 记录列表的可见范围；SQL 编译保留在服务端存储边界。 */
export interface ReadScope {
  creators: string[] | null;
  createdDepartments: string[];
  sql?: (alias: string, parameters: unknown[]) => string;
}

/** 将纯权限规则的拒绝转换为 HTTP 授权错误，不把框架依赖带入 contracts。 */
export function effectiveAccess(
  actor: AccessActor,
  schema: FormSchema,
  context: PolicyContext,
  target: AccessContext = {},
): AccessGrant {
  try {
    return effectiveRecordAccess(actor, schema, {
      ...context,
      selection: actor.accessGroups?.[context.definitionId],
    }, target);
  } catch (error) {
    if (error instanceof RecordAccessDeniedError) {
      throw new ForbiddenException(error.message);
    }
    throw error;
  }
}

/** 请求头只表达选择，是否命中该权限组仍由共享规则重新计算。 */
function requireRecordGroups(actor: AccessActor, context: PolicyContext): RecordPermissionGroup[] {
  try {
    return selectRecordGroups(
      actor,
      context.organization,
      context.config,
      actor.accessGroups?.[context.definitionId],
    );
  } catch (error) {
    if (error instanceof RecordAccessDeniedError) {
      throw new ForbiddenException(error.message);
    }
    throw error;
  }
}

/** 将生效权限组的数据范围编译为数据库 SQL WHERE 条件片段 */
export function groupRecordSql(
  groups: RecordPermissionGroup[],
  actor: Actor,
  org: ServerOrganization,
  alias: string,
  parameters: unknown[],
): string {
  if (!/^[a-z][a-z_]*$/.test(alias)) {
    throw new Error("Invalid record alias");
  }

  const bind = (value: unknown) => {
    parameters.push(value);
    return `$${parameters.length}`;
  };

  const filterSql = (filter: DataFilter) => {
    const expected = filterExpected(filter, actor, org);
    if (filter.operator !== "notEmpty" && filter.source !== "constant" && !expected) {
      return "false";
    }

    const field = `${alias}.values -> ${bind(filter.sourceFieldId)}::text`;
    const list = `CASE WHEN jsonb_typeof(${field})='array' THEN ${field} ELSE jsonb_build_array(${field}) END`;

    // 与 choiceConditionValue 的选项对象识别一致，其他 JSON 对象保留原形。
    const normalized = `CASE WHEN jsonb_typeof(item.value)='object' THEN
      CASE WHEN jsonb_typeof(item.value->'text')='string'
        AND length(item.value->>'text') <= 10000
        AND (item.value - 'text' - 'optionId')='{}'::jsonb
        AND (NOT (item.value ? 'optionId') OR (
          jsonb_typeof(item.value->'optionId')='string'
          AND length(item.value->>'optionId') BETWEEN 1 AND 100
        ))
      THEN COALESCE(item.value->'optionId',item.value->'text')
      ELSE item.value END
      ELSE item.value END`;
    const elements = `(SELECT ${normalized} AS value FROM jsonb_array_elements(${list}) item(value)) v`;
    const nonempty = `(v.value IS NOT NULL AND v.value NOT IN ('null'::jsonb,'""'::jsonb,'[]'::jsonb,'{}'::jsonb))`;

    if (filter.operator === "notEmpty") {
      return `EXISTS(SELECT 1 FROM ${elements} WHERE ${nonempty})`;
    }

    // 旧配置即便曾允许对象比较，也不能靠“不等于”将不支持的值放行。
    const comparable = `NOT EXISTS(SELECT 1 FROM ${elements} WHERE jsonb_typeof(v.value) IN ('object','array'))`;
    const value = bind(expected);
    const same = `EXISTS(SELECT 1 FROM ${elements} WHERE ${nonempty} AND v.value #>> '{}'=${value}::text)`;
    if (filter.operator === "equals") return `(${comparable} AND ${same})`;
    if (filter.operator === "notEquals") return `(${comparable} AND NOT (${same}))`;

    if (filter.operator === "contains") {
      const contains = `EXISTS(SELECT 1 FROM ${elements} WHERE position(${value}::text in COALESCE(v.value #>> '{}',''))>0)`;
      return `(${comparable} AND CASE WHEN jsonb_typeof(${field})='array' THEN ${same} ELSE ${contains} END)`;
    }

    const op = filter.operator === "greater" ? ">" : "<";
    return `(CASE WHEN jsonb_typeof(${field})='number' THEN (${field} #>> '{}')::numeric ${op} ${value}::numeric ELSE false END)`;
  };

  const clauses = groups
    .filter((group) => group.actions.includes("view"))
    .map((group) => {
      if (group.scope === "all") return "true";
      if (group.scope === "self") return `${alias}.created_by=${bind(actor.id)}::uuid`;
      if (group.scope === "department") {
        return `${alias}.created_department_ids && ${bind(recordDepartmentIds(org, actor.id))}::uuid[]`;
      }
      return group.filters.length ? `(${group.filters.map(filterSql).join(" AND ")})` : "false";
    })
    .map((sql) => `(${sql})`);

  return clauses.join(" OR ") || "false";
}

@Injectable()
export class AccessService {
  constructor(private readonly organizations: OrganizationService) {}

  /** 方法 1：加载指定表单的组织架构与权限组配置 */
  async context(tx: Queryable, actor: Actor, definitionId: string): Promise<PolicyContext> {
    const organization = await this.organizations.snapshot(tx, actor);
    if (actor.role === "admin") {
      return { organization, definitionId, config: emptyRecordGroupConfiguration() };
    }

    const { rows } = await tx.query(
      "SELECT config, revision FROM record_permission_groups WHERE definition_id = $1",
      [definitionId],
    );
    const row = rows[0];
    const config = row
      ? { groups: row.config.groups, mode: "groups" as const, allowMerged: true, revision: row.revision }
      : emptyRecordGroupConfiguration();

    return { organization, definitionId, config };
  }

  /** 方法 2：计算用户在指定表单或单条记录上的最终操作权限与字段掩码 */
  async effective(
    tx: Queryable,
    actor: AccessActor,
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
    actor: AccessActor,
    definitionId: string,
    policyContext?: PolicyContext,
  ): Promise<ReadScope> {
    const ctx = policyContext ?? (await this.context(tx, actor, definitionId));
    if (actor.role === "admin") {
      return { creators: null, createdDepartments: [] };
    }

    const groups = requireRecordGroups(actor, ctx);
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
    actor: AccessActor,
    definitionId: string,
    policyContext?: PolicyContext,
  ): Promise<ReadScope> {
    const ctx = policyContext ?? (await this.context(tx, actor, definitionId));
    if (actor.role === "admin") {
      return { creators: null, createdDepartments: [] };
    }

    const groups = requireRecordGroups(actor, ctx);
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
          eligibleRecordGroups(actor, organization, r.config).length > 0,
      )
      .map((r) => r.definition_id);
  }
}
