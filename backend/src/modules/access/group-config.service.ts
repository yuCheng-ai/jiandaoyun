import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import {
  groupActionNames,
  groupScopeNames,
  isOrganizationField,
  type FormField,
  type FormSchema,
  type RecordGroupConfiguration,
  type RecordGroupOptions,
  type RecordPermissionGroup,
} from "@platform/contracts";
import { Actor, requireAdmin } from "../../core/auth/auth.service";
import { Database, Transaction } from "../../core/database/database";
import { OrganizationService } from "../directory/organization.service";
import { identifier, object, title, uuid } from "../../core/database/schema";
import { directGroupConfiguration, eligibleRecordGroups } from "./group-access";

/** 校验配置对象是否仅包含受支持的属性键 */
const assertAllowedKeys = (raw: Record<string, unknown>, allowed: string[]) => {
  if (Object.keys(raw).some((key) => !allowed.includes(key))) {
    throw new BadRequestException("权限组包含未支持的配置，请保留原配置后核对");
  }
};

/** 校验字段或关联关系权限映射表（`hidden` | `read` | `edit`） */
function parsePermissionLevels(
  input: unknown,
  exists: (key: string) => boolean,
): Record<string, "hidden" | "read" | "edit"> {
  object(input);
  const result: Record<string, "hidden" | "read" | "edit"> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!exists(key) || !["hidden", "read", "edit"].includes(value)) {
      throw new BadRequestException("字段或关系权限不合法");
    }
    result[key] = value;
  }
  return result;
}

@Injectable()
export class GroupConfigurationService {
  constructor(
    private readonly db: Database,
    private readonly organizations: OrganizationService,
  ) {}

  /** 锁定组织架构并校验目标表单定义存在且归属于当前工作空间 */
  private async definition(tx: Transaction, actor: Actor, id: string, write = false) {
    uuid(id);
    await this.organizations.lock(tx, actor.workspaceId);

    const lockMode = write ? "UPDATE" : "SHARE";
    const { rows } = await tx.query(
      `SELECT id FROM definitions WHERE id = $1 AND workspace_id = $2 FOR ${lockMode}`,
      [id, actor.workspaceId],
    );
    if (!rows[0]) {
      throw new NotFoundException("数据对象不存在或不可访问");
    }
  }

  /** 读取指定表单的权限组配置；若尚未配置则初始化为空权限组配置 */
  private async read(tx: Transaction, id: string): Promise<RecordGroupConfiguration> {
    const { rows } = await tx.query(
      "SELECT revision, config FROM record_permission_groups WHERE definition_id = $1",
      [id],
    );
    const row = rows[0];
    return row ? { ...row.config, mode: "groups", revision: row.revision } : directGroupConfiguration();
  }

  /** 获取表单的权限组完整配置（仅管理员可访问） */
  async get(actor: Actor, id: string) {
    requireAdmin(actor);
    return this.db.transaction(async (tx) => {
      await this.definition(tx, actor, id);
      return this.read(tx, id);
    });
  }

  /** 获取当前用户在指定表单下可用的权限组摘要选项 */
  async options(actor: Actor, id: string): Promise<RecordGroupOptions> {
    return this.db.transaction(async (tx) => {
      await this.definition(tx, actor, id);
      const config = await this.read(tx, id);

      if (actor.role === "admin") {
        return {
          mode: "direct",
          revision: config.revision,
          allowMerged: false,
          groups: [],
        };
      }

      const org = await this.organizations.snapshot(tx, actor);
      const groups = eligibleRecordGroups(actor, org, config);
      if (!groups.length) {
        throw new ForbiddenException("没有此数据对象的权限组");
      }

      return {
        mode: "groups",
        revision: config.revision,
        allowMerged: config.allowMerged,
        groups: groups.map(({ id: groupId, name, actions }) => ({ id: groupId, name, actions })),
      };
    });
  }

  /** 在独立事务中校验并保存表单的权限组配置 */
  async save(actor: Actor, id: string, body: unknown) {
    return this.db.transaction((tx) => this.saveIn(tx, actor, id, body));
  }

  /**
   * 在现有事务中校验并持久化表单权限组配置：
   * 1. 校验乐观锁版本号 `expectedRevision`；
   * 2. 收集所有历史发布版本的字段与关联关系集合，校验各权限组的受众、操作、字段掩码与自定义筛选器；
   * 3. 更新 `record_permission_groups` 并写入审计事件表 `record_permission_group_events`。
   */
  async saveIn(tx: Transaction, actor: Actor, id: string, body: unknown) {
    requireAdmin(actor);
    object(body);
    assertAllowedKeys(body, ["expectedRevision", "mode", "allowMerged", "groups"]);

    if (
      (body.mode !== undefined && body.mode !== "groups") ||
      typeof body.allowMerged !== "boolean" ||
      !Array.isArray(body.groups) ||
      body.groups.length > 100
    ) {
      throw new BadRequestException("权限模式或权限组列表不合法");
    }

    await this.definition(tx, actor, id, true);
    const current = await this.read(tx, id);
    if (body.expectedRevision !== current.revision) {
      throw new ConflictException("权限组已被其他人修改，请重新读取后合并，当前输入保留");
    }

    const org = await this.organizations.snapshot(tx, actor);
    const { rows: versions } = await tx.query<{ schema: FormSchema }>(
      "SELECT schema FROM definition_versions WHERE definition_id = $1 ORDER BY version DESC",
      [id],
    );
    if (!versions.length && body.groups.length) {
      throw new BadRequestException("请先发布数据对象");
    }

    // 汇总各历史版本的字段信息，支持对存量字段配置权限与筛选
    const variants = new Map<string, { field: FormField; child: boolean }[]>();
    for (const { schema } of versions) {
      for (const parent of schema.fields) {
        for (const field of [parent, ...parent.children]) {
          const list = variants.get(field.id) || [];
          list.push({ field, child: field !== parent });
          variants.set(field.id, list);
        }
      }
    }

    const { rows: relationRows } = await tx.query(
      "SELECT id FROM relation_definitions WHERE source_definition_id = $1 OR target_definition_id = $1",
      [id],
    );
    const relationIds = new Set(relationRows.map((row) => row.id));

    const groups: RecordPermissionGroup[] = [];
    const seenGroupIds = new Set<string>();

    for (const raw of body.groups) {
      object(raw);
      assertAllowedKeys(raw, [
        "id",
        "name",
        "enabled",
        "archived",
        "subjects",
        "actions",
        "scope",
        "filters",
        "fields",
        "relations",
      ]);
      identifier(raw.id);
      title(raw.name);

      if (seenGroupIds.has(raw.id)) {
        throw new BadRequestException("权限组标识重复");
      }
      seenGroupIds.add(raw.id);

      if (
        typeof raw.enabled !== "boolean" ||
        typeof raw.archived !== "boolean" ||
        typeof raw.scope !== "string" ||
        !Object.hasOwn(groupScopeNames, raw.scope)
      ) {
        throw new BadRequestException("权限组状态或记录范围不合法");
      }

      if (
        !Array.isArray(raw.actions) ||
        !raw.actions.length ||
        new Set(raw.actions).size !== raw.actions.length ||
        raw.actions.some(
          (a: unknown) => typeof a !== "string" || !Object.hasOwn(groupActionNames, a),
        )
      ) {
        throw new BadRequestException("操作权限不合法");
      }

      const hasRecordMutationOrOutput = raw.actions.some(
        (action: string) => !["create", "view"].includes(action),
      );
      if (hasRecordMutationOrOutput && !raw.actions.includes("view")) {
        throw new BadRequestException("已有记录的操作需要查看权限");
      }

      if (!Array.isArray(raw.subjects) || !raw.subjects.length || raw.subjects.length > 1000) {
        throw new BadRequestException("请选择权限对象");
      }

      // 校验授权受众（成员 / 部门 / 角色）
      const subjects: RecordPermissionGroup["subjects"] = [];
      const seenSubjects = new Set<string>();

      for (const subject of raw.subjects) {
        object(subject);
        assertAllowedKeys(subject, ["kind", "id", "includeChildren"]);
        uuid(subject.id);

        let source: { id: string }[] = [];
        if (subject.kind === "member") {
          source = org.users;
        } else if (subject.kind === "department") {
          source = org.spec.departments;
        } else if (subject.kind === "role") {
          source = org.spec.roles;
        }

        const subjectKey = `${subject.kind}/${subject.id}`;
        if (!source.some((item) => item.id === subject.id) || seenSubjects.has(subjectKey)) {
          throw new BadRequestException("权限对象不存在、重复或不属于当前组织");
        }

        if (
          subject.includeChildren !== undefined &&
          (subject.kind !== "department" || typeof subject.includeChildren !== "boolean")
        ) {
          throw new BadRequestException("下级部门配置不合法");
        }

        subjects.push({
          kind: subject.kind,
          id: subject.id,
          ...(subject.kind === "department"
            ? { includeChildren: subject.includeChildren === true }
            : {}),
        });
        seenSubjects.add(subjectKey);
      }

      // 校验字段权限与关联关系权限
      const fields = parsePermissionLevels(raw.fields, (key) => variants.has(key));
      const relations = parsePermissionLevels(raw.relations || {}, (key) => relationIds.has(key));

      // 校验自定义数据范围筛选条件
      if (
        !Array.isArray(raw.filters) ||
        raw.filters.length > 100 ||
        (raw.actions.includes("view") && raw.scope === "custom" && !raw.filters.length)
      ) {
        throw new BadRequestException("自定义范围需要有效筛选条件");
      }

      const filterIds = new Set<string>();
      const filters: RecordPermissionGroup["filters"] = [];

      for (const filter of raw.filters) {
        object(filter);
        assertAllowedKeys(filter, ["id", "sourceFieldId", "operator", "source", "value"]);
        identifier(filter.id);
        identifier(filter.sourceFieldId);

        const fieldVariants = variants.get(filter.sourceFieldId);
        if (
          filterIds.has(filter.id) ||
          !fieldVariants?.length ||
          fieldVariants.some((item) => item.child || item.field.type === "subform")
        ) {
          throw new BadRequestException("筛选标识重复或字段不属于主记录");
        }
        filterIds.add(filter.id);

        const validOperators = ["equals", "notEquals", "contains", "greater", "less", "notEmpty"];
        const validSources = ["constant", "currentUser", "currentDepartment"];
        if (
          !validOperators.includes(filter.operator) ||
          !validSources.includes(filter.source) ||
          typeof filter.value !== "string" ||
          filter.value.length > 10000
        ) {
          throw new BadRequestException("筛选规则不合法");
        }

        if (
          filter.operator !== "notEmpty" &&
          filter.source === "constant" &&
          !filter.value.trim()
        ) {
          throw new BadRequestException("请填写筛选常量");
        }

        if (
          ["greater", "less"].includes(filter.operator) &&
          (filter.source !== "constant" ||
            !Number.isFinite(Number(filter.value)) ||
            !fieldVariants.every((item) => item.field.type === "number"))
        ) {
          throw new BadRequestException("数值比较需要数字字段与有效数字常量");
        }

        const matchesDynamicSource = fieldVariants.every(({ field }) => {
          if (!isOrganizationField(field.type)) return false;
          const expectedSource = field.type.startsWith("department")
            ? "currentDepartment"
            : "currentUser";
          return expectedSource === filter.source;
        });

        if (filter.source !== "constant" && filter.operator !== "notEmpty" && !matchesDynamicSource) {
          throw new BadRequestException("当前身份来源与筛选字段类型不一致");
        }

        filters.push({
          id: filter.id,
          sourceFieldId: filter.sourceFieldId,
          operator: filter.operator,
          source: filter.source,
          value: filter.value,
        });
      }

      if (
        body.mode === "groups" &&
        raw.enabled &&
        !raw.archived &&
        raw.actions.includes("view") &&
        raw.scope === "custom" &&
        filters.some(
          (filter) =>
            !versions[0]!.schema.fields.some(
              (field: FormField) => field.id === filter.sourceFieldId,
            ),
        )
      ) {
        throw new BadRequestException(
          "使用中的范围字段已经从当前数据版本移除，请调整条件后再启用权限组",
        );
      }

      groups.push({
        id: raw.id,
        name: raw.name.trim(),
        enabled: raw.enabled,
        archived: raw.archived,
        subjects,
        actions: [...raw.actions],
        scope: raw.scope as RecordPermissionGroup["scope"],
        fields,
        relations,
        filters,
      });
    }

    const config = { mode: body.mode, allowMerged: body.allowMerged, groups };
    const revision = current.revision + 1;

    const upsertSql = `
      INSERT INTO record_permission_groups (definition_id, revision, config)
      VALUES ($1, $2, $3)
      ON CONFLICT (definition_id)
      DO UPDATE SET revision = $2, config = $3, updated_at = now()
    `;
    await tx.query(upsertSql, [id, revision, config]);

    const eventSql = `
      INSERT INTO record_permission_group_events (id, definition_id, actor_id, revision, config)
      VALUES ($1, $2, $3, $4, $5)
    `;
    await tx.query(eventSql, [randomUUID(), id, actor.id, revision, config]);

    return { ...config, revision } as RecordGroupConfiguration;
  }
}
