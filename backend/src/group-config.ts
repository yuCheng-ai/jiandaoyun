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
import { Actor, requireAdmin } from "./auth";
import { Database, Transaction } from "./database";
import { OrganizationService } from "./organization";
import { identifier, object, title, uuid } from "./schema";
import { directGroupConfiguration, eligibleRecordGroups } from "./group-access";
const keys = (raw: Record<string, unknown>, allowed: string[]) => {
  if (Object.keys(raw).some((key) => !allowed.includes(key)))
    throw new BadRequestException("权限组包含未支持的配置，请保留原配置后核对");
};
@Injectable()
export class GroupConfigurationService {
  constructor(
    private readonly db: Database,
    private readonly organizations: OrganizationService,
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
        `SELECT id FROM definitions WHERE id=$1 AND workspace_id=$2 FOR ${write ? "UPDATE" : "SHARE"}`,
        [id, actor.workspaceId],
      )
    ).rows[0];
    if (!row) throw new NotFoundException("数据对象不存在或不可访问");
  }
  private async read(
    tx: Transaction,
    id: string,
  ): Promise<RecordGroupConfiguration> {
    const row = (
      await tx.query(
        "SELECT revision,config FROM record_permission_groups WHERE definition_id=$1",
        [id],
      )
    ).rows[0];
    return row
      ? { ...row.config, revision: row.revision }
      : directGroupConfiguration();
  }
  async get(actor: Actor, id: string) {
    requireAdmin(actor);
    return this.db.transaction(async (tx) => {
      await this.definition(tx, actor, id);
      return this.read(tx, id);
    });
  }
  async options(actor: Actor, id: string): Promise<RecordGroupOptions> {
    return this.db.transaction(async (tx) => {
      await this.definition(tx, actor, id);
      const config = await this.read(tx, id);
      if (actor.role === "admin" || config.mode === "direct")
        return {
          mode: "direct",
          revision: config.revision,
          allowMerged: false,
          groups: [],
        };
      const groups = eligibleRecordGroups(
        actor,
        await this.organizations.snapshot(tx, actor),
        config,
      );
      if (!groups.length)
        throw new ForbiddenException("没有此数据对象的权限组");
      return {
        mode: "groups",
        revision: config.revision,
        allowMerged: config.allowMerged,
        groups: groups.map(({ id, name, actions }) => ({ id, name, actions })),
      };
    });
  }
  async save(actor: Actor, id: string, body: unknown) {
    return this.db.transaction(tx => this.saveIn(tx, actor, id, body));
  }
  async saveIn(tx: Transaction, actor: Actor, id: string, body: unknown) {
    requireAdmin(actor);
    object(body);
    keys(body, ["expectedRevision", "mode", "allowMerged", "groups"]);
    if (
      !["direct", "groups"].includes(body.mode) ||
      typeof body.allowMerged !== "boolean" ||
      !Array.isArray(body.groups) ||
      body.groups.length > 100
    )
      throw new BadRequestException("权限模式或权限组列表不合法");
    await this.definition(tx, actor, id, true);
    const current = await this.read(tx, id);
    if (body.expectedRevision !== current.revision)
      throw new ConflictException(
        "权限组已被其他人修改，请重新读取后合并，当前输入保留",
      );
    const org = await this.organizations.snapshot(tx, actor);
    const versions = (
      await tx.query(
        "SELECT schema FROM definition_versions WHERE definition_id=$1 ORDER BY version DESC",
        [id],
      )
    ).rows;
    if (!versions.length && body.groups.length) throw new BadRequestException("请先发布数据对象");
    const variants = new Map<
      string,
      { field: FormField; child: boolean }[]
    >();
    for (const { schema } of versions as { schema: FormSchema }[])
      for (const parent of schema.fields)
        for (const field of [parent, ...parent.children]) {
          const list = variants.get(field.id) || [];
          list.push({ field, child: field !== parent });
          variants.set(field.id, list);
        }
    const relationIds = new Set(
      (
        await tx.query(
          "SELECT id FROM relation_definitions WHERE source_definition_id=$1 OR target_definition_id=$1",
          [id],
        )
      ).rows.map((row) => row.id),
    );
    const groups: RecordPermissionGroup[] = [],
      seen = new Set<string>();
    for (const raw of body.groups) {
      object(raw);
      keys(raw, [
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
      if (seen.has(raw.id)) throw new BadRequestException("权限组标识重复");
      seen.add(raw.id);
      if (
        typeof raw.enabled !== "boolean" ||
        typeof raw.archived !== "boolean" ||
        typeof raw.scope !== "string" ||
        !Object.hasOwn(groupScopeNames, raw.scope)
      )
        throw new BadRequestException("权限组状态或记录范围不合法");
      if (
        !Array.isArray(raw.actions) ||
        !raw.actions.length ||
        new Set(raw.actions).size !== raw.actions.length ||
        raw.actions.some(
          (a: unknown) =>
            typeof a !== "string" || !Object.hasOwn(groupActionNames, a),
        )
      )
        throw new BadRequestException("操作权限不合法");
      if (raw.actions.some((action: string) => !["create", "view"].includes(action)) && !raw.actions.includes("view"))
        throw new BadRequestException("已有记录的操作需要查看权限");
      if (
        !Array.isArray(raw.subjects) ||
        !raw.subjects.length ||
        raw.subjects.length > 1000
      )
        throw new BadRequestException("请选择权限对象");
      const subjects: RecordPermissionGroup["subjects"] = [],
        seenSubjects = new Set<string>();
      for (const subject of raw.subjects) {
        object(subject);
        keys(subject, ["kind", "id", "includeChildren"]);
        uuid(subject.id);
        const source =
          subject.kind === "member"
            ? org.users
            : subject.kind === "department"
              ? org.spec.departments
              : subject.kind === "role"
                ? org.spec.roles
                : [];
        if (
          !source.some((item) => item.id === subject.id) ||
          seenSubjects.has(`${subject.kind}/${subject.id}`)
        )
          throw new BadRequestException(
            "权限对象不存在、重复或不属于当前组织",
          );
        if (
          subject.includeChildren !== undefined &&
          (subject.kind !== "department" ||
            typeof subject.includeChildren !== "boolean")
        )
          throw new BadRequestException("下级部门配置不合法");
        subjects.push({
          kind: subject.kind,
          id: subject.id,
          ...(subject.kind === "department"
            ? { includeChildren: subject.includeChildren === true }
            : {}),
        });
        seenSubjects.add(`${subject.kind}/${subject.id}`);
      }
      const levels = (input: unknown, exists: (key: string) => boolean) => {
        object(input);
        const result: Record<string, "hidden" | "read" | "edit"> = {};
        for (const [key, value] of Object.entries(input)) {
          if (!exists(key) || !["hidden", "read", "edit"].includes(value))
            throw new BadRequestException("字段或关系权限不合法");
          result[key] = value;
        }
        return result;
      };
      const fields = levels(raw.fields, (key) => variants.has(key)),
        relations = levels(raw.relations || {}, (key) =>
          relationIds.has(key),
        );
      if (
        !Array.isArray(raw.filters) ||
        raw.filters.length > 100 ||
        (raw.actions.includes("view") && raw.scope === "custom" && !raw.filters.length)
      )
        throw new BadRequestException("自定义范围需要有效筛选条件");
      const filterIds = new Set<string>(),
        filters: RecordPermissionGroup["filters"] = [];
      for (const filter of raw.filters) {
        object(filter);
        keys(filter, ["id", "sourceFieldId", "operator", "source", "value"]);
        identifier(filter.id);
        identifier(filter.sourceFieldId);
        const fields = variants.get(filter.sourceFieldId);
        if (
          filterIds.has(filter.id) ||
          !fields?.length ||
          fields.some((item) => item.child || item.field.type === "subform")
        )
          throw new BadRequestException("筛选标识重复或字段不属于主记录");
        filterIds.add(filter.id);
        if (
          ![
            "equals",
            "notEquals",
            "contains",
            "greater",
            "less",
            "notEmpty",
          ].includes(filter.operator) ||
          !["constant", "currentUser", "currentDepartment"].includes(
            filter.source,
          ) ||
          typeof filter.value !== "string" ||
          filter.value.length > 10000
        )
          throw new BadRequestException("筛选规则不合法");
        if (
          filter.operator !== "notEmpty" &&
          filter.source === "constant" &&
          !filter.value.trim()
        )
          throw new BadRequestException("请填写筛选常量");
        if (
          ["greater", "less"].includes(filter.operator) &&
          (filter.source !== "constant" ||
            !Number.isFinite(Number(filter.value)) ||
            !fields.every((item) => item.field.type === "number"))
        )
          throw new BadRequestException("数值比较需要数字字段与有效数字常量");
        if (
          filter.source !== "constant" &&
          filter.operator !== "notEmpty" &&
          !fields.every(
            ({ field }) =>
              isOrganizationField(field.type) &&
              (field.type.startsWith("department")
                ? "currentDepartment"
                : "currentUser") === filter.source,
          )
        )
          throw new BadRequestException("当前身份来源与筛选字段类型不一致");
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
            !versions[0].schema.fields.some(
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
    const config = { mode: body.mode, allowMerged: body.allowMerged, groups },
      revision = current.revision + 1;
    await tx.query(
      "INSERT INTO record_permission_groups(definition_id,revision,config) VALUES($1,$2,$3) ON CONFLICT(definition_id) DO UPDATE SET revision=$2,config=$3,updated_at=now()",
      [id, revision, config],
    );
    await tx.query(
      "INSERT INTO record_permission_group_events(id,definition_id,actor_id,revision,config) VALUES($1,$2,$3,$4,$5)",
      [randomUUID(), id, actor.id, revision, config],
    );
    return { ...config, revision } as RecordGroupConfiguration;
  }
}
