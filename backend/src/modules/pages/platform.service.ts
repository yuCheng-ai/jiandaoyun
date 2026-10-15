import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { parseFragment, type DefaultTreeAdapterMap } from "parse5";
import {
  compareRecordSortValues,
  displayPlainFieldValue,
  organizationIdentityLabel,
  isNumericField,
  hasFieldValue,
  maxSubformRows,
  dataKind,
  separateFormSchema,
  isOrganizationField,
  isDepartmentField,
  equalFieldValues,
  fieldDefaultValue,
  resolveCalculations,
  type RecordViewSettings,
  type OrganizationIdentity,
  type AccessGrant,
  type AccessPolicy,
  type SubjectGrant,
  type CellChange,
  type FormField,
  type FormSchema,
  type FormValues,
  type RecordDetail,
  type PageRecordSummary,
  type ServerDefinition,
  type ServerRecord,
} from "@platform/contracts";
import { Database, Transaction } from "../../core/database/database";
import { Actor, requireAdmin } from "../../core/auth/auth.service";
import {
  allFields,
  cellKey,
  masked,
  newValues,
  object,
  parseSchema,
  permission,
  scalar,
  rowActions,
  rowPolicy,
  title,
  uuid,
} from "../../core/database/schema";
import {
  AccessService,
  AccessContext,
  effectiveAccess,
} from "../access/access.service";
import { applicationId } from "../applications/applications.service";
import {
  historicalLabels,
  organizationCandidates,
  organizationDefault,
  organizationDefaultResolver,
  organizationLabels,
  recordCreator,
  validateOrganizationDefinition,
  validateOrganizationValues,
} from "../directory/organization-fields";
import {
  OrganizationService,
  parseSubject,
  requireSubject,
} from "../directory/organization.service";
import { once } from "../processes/commands";
import { CollectionService } from "../records/collection.service";
import { storeModelDraft, storeModelVersion } from "../records/data-projection";
import { latestRowEvents } from "../records/record-rows";
import { draftSchema, validateSubmittedRecord } from "../records/record-state";
import { dataModelImpact } from "./model-impact";
import { assertPageActive } from "./page-lifecycle";
import {
  pageAccess,
  pageAcceptsVersion,
  validatePageSubmission,
  type RecordPageScope,
} from "./page-runtime";
import { FileService, recordFileValues } from "./files.service";

type Queryable = Pick<Database, "query">;

// ============================================================================
// 1. DTO 映射辅助函数
// ============================================================================

/** 将数据库 definition_versions 行转换为服务端表单定义 DTO */
export const definitionDto = (row: any): ServerDefinition => ({
  id: row.definition_id,
  title: row.title,
  version: row.version,
  schema: row.schema,
  createdAt: new Date(row.created_at).toISOString(),
});

/** 将数据库 records 行转换为服务端记录 DTO */
export const recordDto = (row: any): ServerRecord => ({
  createdDepartmentIds: row.created_department_ids ?? null,
  id: row.id,
  definitionId: row.definition_id,
  definitionVersion: row.definition_version,
  revision: row.revision,
  values: row.values,
  cellRevisions: row.cell_revisions,
  state: row.state,
  createdBy: row.created_by,
  createdAt: new Date(row.created_at).toISOString(),
  updatedAt: new Date(row.updated_at).toISOString(),
});

// ============================================================================
// 2. 表单定义与通用记录核心平台服务
// ============================================================================

@Injectable()
export class PlatformService {
  constructor(
    private readonly db: Database,
    private readonly authorization: AccessService,
    private readonly organizations: OrganizationService,
    private readonly collection: CollectionService,
    private readonly files: FileService,
  ) {}

  // --------------------------------------------------------------------------
  // 2.1 组织架构校验、身份标签与默认值计算
  // --------------------------------------------------------------------------

  /** 查询表单的数据收集开关与配额状态 */
  async collectionStatus(tx: Transaction, actor: Actor, id: string) {
    return this.collection.statusIn(tx, actor, id);
  }

  /** 校验表单定义中的组织字段配置在当前工作空间组织架构下是否有效 */
  async validateOrganizationModel(
    tx: Queryable,
    actor: Actor,
    schema: FormSchema,
  ) {
    if (allFields(schema).some((field) => isOrganizationField(field.type))) {
      const snapshot = await this.organizations.snapshot(tx, actor);
      validateOrganizationDefinition(schema, snapshot);
    }
  }

  /** 校验记录中的组织字段值是否符合组织范围与权限约束 */
  async validateRecordOrganizations(
    tx: Queryable,
    actor: Actor,
    schema: FormSchema,
    values: FormValues,
    before?: FormValues,
  ) {
    if (allFields(schema).some((field) => isOrganizationField(field.type))) {
      const snapshot = await this.organizations.snapshot(tx, actor);
      validateOrganizationValues(schema, values, snapshot, actor.id, before);
    }
  }

  /** 解析记录中涉及的组织成员、部门与角色历史身份显示名称 */
  async identityLabels(
    tx: Queryable,
    actor: Actor,
    schema: FormSchema,
    values: FormValues,
  ) {
    if (!allFields(schema).some((field) => isOrganizationField(field.type))) {
      return [];
    }
    const snapshot = await this.organizations.snapshot(tx, actor);
    return historicalLabels(
      tx,
      actor,
      organizationLabels(schema, values, snapshot),
    );
  }

  /**
   * 构造字段默认值解析器：
   * - 支持静态默认值、日期当时值、动态组织默认值（当前成员/主部门/部门负责人）以及默认值公式计算。
   */
  async defaultResolver(
    tx: Queryable,
    actor: Actor,
    schema: FormSchema,
    values: FormValues = {},
    base: FormValues = {},
    fullSchema = schema,
    access?: AccessGrant,
    strict = false,
  ) {
    const hasOrgField = allFields(schema).some((field) =>
      isOrganizationField(field.type),
    );
    const resolveOrg = hasOrgField
      ? organizationDefaultResolver(
          fullSchema,
          await this.organizations.snapshot(tx, actor),
          actor.id,
          values,
          base,
        )
      : (field: FormField) => field.defaultValue;

    const now = new Date();
    const basic = (field: FormField, row?: FormValues) =>
      isOrganizationField(field.type)
        ? resolveOrg(field, row)
        : fieldDefaultValue(field, now);

    const formulas = allFields(schema).filter((field) => field.defaultFormula);
    if (!formulas.length) return basic;

    const supplied = (
      field: FormField,
      input: FormValues,
      parent?: FormField,
    ) =>
      (!access || permission(access, field, parent) === "edit") &&
      input[field.id] != null;

    const seed = (
      fields: FormField[],
      input: FormValues,
      parent?: FormField,
    ): FormValues =>
      Object.fromEntries(
        fields.map((field) => {
          if (field.type === "subform") {
            const rawRows = Array.isArray(input[field.id])
              ? (input[field.id] as FormValues[])
              : [];
            const seededRows = rawRows.map((row) =>
              row && typeof row === "object" && !Array.isArray(row)
                ? seed(field.children, row, field)
                : {},
            );
            return [field.id, seededRows];
          }
          if (supplied(field, input, parent)) {
            return [field.id, input[field.id]];
          }
          const fallback = field.defaultFormula
            ? undefined
            : basic(field, parent ? input : undefined);
          return [field.id, fallback];
        }),
      );

    const failures = new Set<string>();
    const calculated = resolveCalculations(
      schema.fields,
      seed(schema.fields, values),
      base,
      {
        fields: fullSchema.fields,
        now,
        defaults: formulas.map((field) => field.id),
        enabled: (field, input) => input[field.id] === undefined,
        onError: (field) => failures.add(field.id),
      },
    );

    if (strict && failures.size) {
      throw new BadRequestException(
        "默认值计算未完成，请检查相关填写内容或联系表单管理员。",
      );
    }

    return (field: FormField, row?: FormValues) => {
      const parent = schema.fields.find((item) =>
        item.children.some((child) => child.id === field.id),
      );
      if (!parent) return calculated[field.id];

      const index = Array.isArray(values[parent.id])
        ? (values[parent.id] as FormValues[]).findIndex(
            (item) =>
              item === row || (!!row?._rowId && item._rowId === row._rowId),
          )
        : -1;
      const target = (calculated[parent.id] as FormValues[])?.[index];
      return target && Object.hasOwn(target, field.id)
        ? target[field.id]
        : basic(field, row);
    };
  }

  /** 生成新建记录时的主表初始默认值映射 */
  async recordDefaults(tx: Queryable, actor: Actor, schema: FormSchema) {
    const resolve = await this.defaultResolver(tx, actor, schema);
    return Object.fromEntries(
      schema.fields.map((field) => [
        field.id,
        field.type === "subform" ? [] : resolve(field),
      ]),
    );
  }

  /** 根据用户输入与默认值规则构造新记录的值与初始单元格版本 */
  async createValues(
    tx: Queryable,
    actor: Actor,
    schema: FormSchema,
    input: unknown,
    access: AccessGrant,
    base: FormValues = {},
    fullSchema = schema,
    strictDefaults = true,
  ) {
    object(input);
    const resolve = await this.defaultResolver(
      tx,
      actor,
      schema,
      input,
      base,
      fullSchema,
      access,
      strictDefaults,
    );
    return newValues(schema, input, access, resolve);
  }

  /** 动态计算表单中指定组织字段的候选成员/部门列表与默认值（支持由部门字段联动的候选范围） */
  async organizationOptions(
    actor: Actor,
    id: string,
    body: unknown,
    page?: RecordPageScope,
    transaction?: Transaction,
  ) {
    object(body);
    object(body.context || {});

    const read = async (tx: Transaction) => {
      await this.definition(tx, actor, id, "FOR SHARE");
      if (page && !page.taskId) {
        await assertPageActive(tx, actor, page.id);
      }

      const source = body.recordId
        ? await this.loadRecord(tx, actor, body.recordId)
        : undefined;
      if (source && source.row.definition_id !== id) {
        throw new BadRequestException("记录不属于此数据对象");
      }

      const versionNumber =
        source?.row.definition_version ||
        page?.definitionVersion ||
        body.version;
      if (!Number.isInteger(versionNumber) || versionNumber < 1) {
        throw new BadRequestException("请选择明确的数据版本");
      }

      const version =
        source?.version ||
        (
          await tx.query(
            "SELECT * FROM definition_versions WHERE definition_id = $1 AND version = $2",
            [id, versionNumber],
          )
        ).rows[0];
      if (!version) {
        throw new BadRequestException("数据版本不存在");
      }

      const schema = version.schema as FormSchema;
      const baseAccess =
        source?.access ||
        (await this.access(tx, actor, id, schema, { operation: "create" }));
      const access = pageAccess(page, id, versionNumber, baseAccess, schema);

      const parent = body.subformId
        ? schema.fields.find(
            (field) => field.id === body.subformId && field.type === "subform",
          )
        : undefined;
      const field = (parent?.children || schema.fields).find(
        (f) => f.id === body.fieldId && isOrganizationField(f.type),
      );

      const canWriteField =
        field &&
        (!body.subformId || parent) &&
        permission(access, field, parent) === "edit" &&
        (source ? access.edit : access.create);
      if (!canWriteField) {
        throw new ForbiddenException("没有此组织字段的填写权限");
      }

      if (
        page?.row &&
        (body.subformId !== page.row.subformId || body.rowId !== page.row.rowId)
      ) {
        throw new ForbiddenException("只能选择当前任务明细中的组织字段");
      }
      if (body.rowId && (!source || !parent)) {
        throw new BadRequestException("明细行身份不适用");
      }

      const currentRow = body.rowId
        ? (source!.row.values[parent!.id] as FormValues[]).find(
            (row) => row._rowId === body.rowId,
          )
        : undefined;
      if (body.rowId && !currentRow) {
        throw new BadRequestException("明细行不存在");
      }

      if (parent) {
        const policy = rowPolicy(
          parent,
          page?.schema.fields.find((item) => item.id === parent.id),
        );
        const rowEditable = currentRow
          ? policy.editExisting
          : policy.add || policy.insert;
        if (!rowEditable) {
          throw new ForbiddenException("此明细行不可填写组织字段");
        }
      }

      const organization = await this.organizations.snapshot(tx, actor);
      const values =
        source?.row.values || (await this.recordDefaults(tx, actor, schema));
      const context: FormValues = { ...values, ...currentRow };

      const allowedFields = [
        ...schema.fields
          .filter((item) => isDepartmentField(item.type))
          .map((f) => ({
            field: f,
            parent: undefined as FormField | undefined,
          })),
        ...(parent?.children
          .filter((item) => isDepartmentField(item.type))
          .map((f) => ({ field: f, parent })) || []),
      ];

      for (const [key, value] of Object.entries(body.context || {})) {
        const dependency = allowedFields.find((item) => item.field.id === key);
        if (
          !dependency ||
          permission(access, dependency.field, dependency.parent) !== "edit"
        ) {
          throw new ForbiddenException("不能修改不可编辑的部门条件");
        }
        context[key] = scalar(dependency.field, value, false);
      }

      const resolve = organizationDefaultResolver(
        schema,
        organization,
        actor.id,
        context,
      );
      for (const dependency of allowedFields) {
        if (context[dependency.field.id] === undefined) {
          context[dependency.field.id] = resolve(
            dependency.field,
            parent ? context : undefined,
          );
        }
      }

      for (const dependency of allowedFields) {
        if (Object.hasOwn(body.context || {}, dependency.field.id)) {
          const before = dependency.parent
            ? currentRow?.[dependency.field.id]
            : values[dependency.field.id];
          if (equalFieldValues(before, context[dependency.field.id])) continue;

          const selected = context[dependency.field.id];
          const ids = Array.isArray(selected)
            ? selected
            : selected
              ? [selected]
              : [];
          const eligible = new Set(
            organizationCandidates(
              organization,
              actor.id,
              dependency.field,
              context,
            ).map((item) => item.id),
          );
          if (ids.some((deptId) => !eligible.has(String(deptId)))) {
            throw new BadRequestException("部门条件不在当前允许范围内");
          }
        }
      }

      return {
        options: organizationCandidates(organization, actor.id, field, context),
        defaultValue: organizationDefault(
          organization,
          actor.id,
          field,
          context,
        ),
        organizationRevision: organization.revision,
      };
    };

    return transaction ? read(transaction) : this.db.transaction(read);
  }

  /** 获取当前工作空间下的有效成员列表（仅管理员） */
  async users(actor: Actor) {
    requireAdmin(actor);
    const { rows } = await this.db.query(
      "SELECT id, name, username, role FROM users WHERE workspace_id = $1 AND active ORDER BY username",
      [actor.workspaceId],
    );
    return rows;
  }

  // --------------------------------------------------------------------------
  // 2.2 表单定义（Definition）管理与发布
  // --------------------------------------------------------------------------

  /** 加载并校验表单定义（若请求加锁，先按固定顺序锁定工作空间组织架构防死锁） */
  async definition(tx: Queryable, actor: Actor, id: string, lock = "") {
    uuid(id);
    if (lock) {
      await this.organizations.lock(tx, actor.workspaceId);
    }
    const { rows } = await tx.query(
      `SELECT * FROM definitions WHERE id = $1 AND workspace_id = $2 ${lock}`,
      [id, actor.workspaceId],
    );
    const row = rows[0];
    if (!row) {
      throw new NotFoundException("表单不存在或不可访问");
    }
    return row;
  }

  /** 计算用户在指定表单定义及上下文下的有效权限 */
  async access(
    tx: Queryable,
    actor: Actor,
    id: string,
    schema: FormSchema,
    context?: AccessContext,
  ): Promise<AccessGrant> {
    return this.authorization.effective(tx, actor, id, schema, context);
  }

  /** 计算用户在指定表单定义下的正式记录可见范围 */
  async readableScope(tx: Queryable, actor: Actor, id: string) {
    return this.authorization.readers(tx, actor, id);
  }

  /** 获取当前用户在工作空间下可访问的所有表单定义 ID */
  async accessibleDefinitions(tx: Queryable, actor: Actor) {
    return this.authorization.definitions(tx, actor);
  }

  /** 查询当前用户可访问的表单定义列表（支持按应用过滤） */
  async definitions(actor: Actor, appId?: string) {
    if (appId) await applicationId(this.db, actor, appId);
    return this.db.transaction(async (tx) => {
      const ids = await this.accessibleDefinitions(tx, actor);
      const sql = `
        SELECT d.id, d.title, d.revision, d.latest_version AS "latestVersion"
        FROM definitions d
        WHERE d.workspace_id = $1
          AND ($2::uuid[] IS NULL OR d.id = ANY($2))
          AND ($3::uuid IS NULL OR d.application_id = $3)
        ORDER BY d.created_at DESC
      `;
      const { rows } = await tx.query(sql, [
        actor.workspaceId,
        ids,
        appId || null,
      ]);
      return rows;
    });
  }

  /** 新建或保存数据对象草稿，页面由页面设计器独立保存与发布 */
  async saveDefinition(actor: Actor, body: unknown, id?: string) {
    requireAdmin(actor);
    object(body);
    title(body.title);
    const schema = parseSchema(body.schema, true);

    return this.db.transaction(async (tx) => {
      if (!id) {
        const newId = randomUUID();
        const appId = await applicationId(tx, actor, body.applicationId);
        await tx.query(
          "INSERT INTO definitions(id, workspace_id, title, draft, application_id) VALUES($1, $2, $3, $4, $5)",
          [newId, actor.workspaceId, body.title.trim(), schema, appId],
        );
        await storeModelDraft(
          tx,
          {
            id: newId,
            workspace_id: actor.workspaceId,
            title: body.title.trim(),
          },
          schema,
          false,
        );
        return { id: newId, revision: 1 };
      }

      const def = await this.definition(tx, actor, id, "FOR UPDATE");
      if (body.expectedRevision !== def.revision) {
        throw new ConflictException("表单配置已更新，请重新读取");
      }

      await this.validateStableFields(tx, id, schema);

      await tx.query(
        "UPDATE definitions SET title = $2, draft = $3, revision = revision + 1 WHERE id = $1",
        [id, body.title.trim(), schema],
      );
      await storeModelDraft(
        tx,
        { ...def, title: body.title.trim() },
        schema,
        false,
      );
      return { id, revision: def.revision + 1 };
    });
  }

  /** 发布表单定义新版本，校验发布影响令牌并写入配置审计事件 */
  async publish(actor: Actor, id: string, body: unknown) {
    requireAdmin(actor);
    object(body);
    return this.db.transaction(async (tx) => {
      const def = await this.definition(tx, actor, id, "FOR UPDATE");
      if (body.expectedRevision !== def.revision) {
        throw new ConflictException("表单配置已更新，请重新读取");
      }

      const version = def.latest_version + 1;
      const schema = parseSchema(def.draft);
      await this.validateOrganizationModel(tx, actor, schema);
      await this.validateStableFields(tx, id, schema);

      const impact = await dataModelImpact(
        tx,
        def,
        separateFormSchema(schema).model,
        {
          organization: await this.organizations.snapshot(tx, actor),
          actorId: actor.id,
        },
      );
      if (impact.blockers.length) {
        throw new ConflictException(impact.blockers.join("；"));
      }
      if (
        (impact.changes.removed.length || impact.changes.changed.length) &&
        !body.impactToken
      ) {
        throw new ConflictException(
          "移除字段或修改数据约束前，请先检查发布影响",
        );
      }
      if (body.impactToken !== undefined && body.impactToken !== impact.token) {
        throw new ConflictException(
          "字段或使用情况已变化，请重新检查发布影响；草稿已保留",
        );
      }

      const { rows } = await tx.query(
        "INSERT INTO definition_versions(definition_id, version, title, schema) VALUES($1, $2, $3, $4) RETURNING *",
        [id, version, def.title, schema],
      );
      const row = rows[0];

      await storeModelVersion(tx, id, version, row.schema, false);
      await tx.query(
        "UPDATE definitions SET latest_version = $2, revision = revision + 1 WHERE id = $1",
        [id, version],
      );
      await tx.query(
        "INSERT INTO configuration_events(id, workspace_id, actor_id, resource_kind, resource_id, action, revision, detail) VALUES($1, $2, $3, 'data_object', $4, 'publish', $5, $6)",
        [
          randomUUID(),
          actor.workspaceId,
          actor.id,
          id,
          def.revision + 1,
          {
            fromVersion: def.latest_version,
            toVersion: version,
            reviewedToken: body.impactToken || null,
            changes: impact.changes,
          },
        ],
      );

      return definitionDto(row);
    });
  }

  /** 预览数据模型发布对关联配置与存量记录的影响 */
  async modelImpact(actor: Actor, id: string, body: unknown) {
    requireAdmin(actor);
    object(body);
    return this.db.transaction(async (tx) => {
      // 持有排他锁执行存量记录统计与批次校验，防止并发写入导致计数漂移
      const definition = await this.definition(tx, actor, id, "FOR UPDATE");
      if (definition.revision !== body.expectedRevision) {
        throw new ConflictException("数据草稿已修改，请重新读取后检查");
      }

      const schema = parseSchema(definition.draft);
      await this.validateOrganizationModel(tx, actor, schema);
      await this.validateStableFields(tx, id, schema);

      return dataModelImpact(tx, definition, separateFormSchema(schema).model, {
        organization: await this.organizations.snapshot(tx, actor),
        actorId: actor.id,
      });
    });
  }

  /** 校验已发布过的字段是否保持相同的数据类型与子表归属路径 */
  async validateStableFields(tx: Queryable, id: string, schema: FormSchema) {
    const { rows: versions } = await tx.query(
      "SELECT schema FROM definition_versions WHERE definition_id = $1",
      [id],
    );
    const paths = (value: FormSchema) =>
      new Map(
        value.fields.flatMap(
          (field) =>
            [
              [field.id, `${dataKind(field.type)}:root`],
              ...field.children.map((child) => [
                child.id,
                `${dataKind(child.type)}:${field.id}`,
              ]),
            ] as [string, string][],
        ),
      );

    const next = paths(schema);
    for (const version of versions) {
      for (const [key, type] of paths(version.schema)) {
        if (next.has(key) && next.get(key) !== type) {
          throw new BadRequestException(
            "已发布字段不能变更类型或所属子表，请新建字段",
          );
        }
      }
    }
  }

  /** 获取表单最新已发布版本的定义、默认值与当前用户权限 */
  async published(actor: Actor, id: string) {
    return this.db.transaction(async (tx) => {
      const def = await this.definition(tx, actor, id, "FOR SHARE");
      const { rows } = await tx.query(
        "SELECT * FROM definition_versions WHERE definition_id = $1 AND version = $2",
        [id, def.latest_version],
      );
      const row = rows[0];
      if (!row) {
        throw new NotFoundException("表单尚未发布");
      }

      const access = await this.access(tx, actor, id, row.schema, {
        operation: "create",
      });
      const fields = row.schema.fields
        .filter((f: FormField) => permission(access, f) !== "hidden")
        .map((f: FormField) => ({
          ...f,
          children: f.children.filter(
            (c) => permission(access, c, f) !== "hidden",
          ),
        }));

      const defaults = await this.recordDefaults(tx, actor, row.schema);
      const defaultValues = Object.fromEntries(
        fields.map((field: FormField) => [field.id, defaults[field.id]]),
      );

      return {
        defaultValues,
        identities: await this.identityLabels(
          tx,
          actor,
          { ...row.schema, fields },
          defaultValues,
        ),
        rowActions: rowActions(row.schema, { ...access, edit: access.create }),
        ...(access.create
          ? { collection: await this.collection.statusIn(tx, actor, id) }
          : {}),
        definition: {
          ...definitionDto(row),
          schema: { ...row.schema, fields },
        },
        access,
      };
    });
  }

  // --------------------------------------------------------------------------
  // 2.3 记录加载、列表查询、增删改查与审计
  // --------------------------------------------------------------------------

  /** 加载单条未归档记录及其绑定的表单版本与用户访问权限 */
  async loadRecord(
    tx: Queryable,
    actor: Actor,
    id: string,
    lock = false,
    operation?: "export" | "print",
  ) {
    uuid(id);
    const { rows } = await tx.query(
      `SELECT * FROM records WHERE id = $1 AND workspace_id = $2 AND archived_at IS NULL ${lock ? "FOR UPDATE" : ""}`,
      [id, actor.workspaceId],
    );
    const row = rows[0];
    if (!row) {
      throw new NotFoundException("记录不存在或不可访问");
    }
    if (row.state === "draft" && operation) {
      throw new ForbiddenException("尚未提交的草稿不能导出或打印");
    }
    if (
      row.state === "draft" &&
      actor.role !== "admin" &&
      row.created_by !== actor.id
    ) {
      throw new ForbiddenException("不能查看其他成员尚未提交的草稿");
    }

    const version = (
      await tx.query(
        "SELECT * FROM definition_versions WHERE definition_id = $1 AND version = $2",
        [row.definition_id, row.definition_version],
      )
    ).rows[0];

    const access = await this.access(
      tx,
      actor,
      row.definition_id,
      version.schema,
      {
        createdBy: row.created_by,
        createdDepartmentIds: row.created_department_ids,
        values: row.values,
        ...(operation ? { operation } : {}),
        ...(row.state === "draft" ? { operation: "create" as const } : {}),
      },
    );

    return {
      row,
      version,
      access:
        row.state === "draft" ? { ...access, edit: access.create } : access,
    };
  }

  /** 获取单条记录详情 */
  async detail(actor: Actor, id: string): Promise<RecordDetail> {
    return this.db.transaction(async (tx) => this.detailIn(tx, actor, id));
  }

  /** 文件没有公开地址；每次下载重新检查当前记录与字段权限。 */
  async downloadFile(actor: Actor, id: string) {
    return this.db.transaction(async (tx) => {
      const file = await this.files.metadata(tx, actor, id);
      const { rows: links } = await tx.query<{ record_id: string }>(
        "SELECT record_id FROM record_files WHERE file_id = $1",
        [id],
      );
      // 未提交的附件仅上传者可预览。绑定后不能再靠上传者身份绕过字段权限。
      let allowed = !links.length && file.uploaded_by === actor.id;
      for (const link of links) {
        if (allowed) break;
        try {
          const detail = await this.detailIn(tx, actor, link.record_id);
          const canRead =
            detail.access.read ||
            (detail.record.state === "draft" && detail.access.create);
          if (!canRead) continue;
          const visibleFiles = recordFileValues(
            detail.definition.schema,
            detail.record.values,
          );
          allowed = visibleFiles.some((value) => value.id === id);
        } catch (cause) {
          if (
            !(cause instanceof ForbiddenException) &&
            !(cause instanceof NotFoundException)
          ) {
            throw cause;
          }
        }
      }
      if (!allowed) throw new NotFoundException("文件不存在或不可访问");
      const { rows } = await tx.query<{ content: Buffer }>(
        "SELECT content FROM uploaded_files WHERE id = $1",
        [id],
      );
      return {
        name: file.name,
        type: file.media_type,
        content: rows[0].content,
      };
    });
  }

  /** 在事务中加载单条记录详情，并执行字段级与子表级权限脱敏 */
  async detailIn(
    tx: Queryable,
    actor: Actor,
    id: string,
    page?: RecordPageScope,
    operation?: "export" | "print",
  ): Promise<RecordDetail> {
    const {
      row,
      version,
      access: sourceAccess,
    } = await this.loadRecord(tx, actor, id, false, operation);
    const access = pageAccess(
      page,
      row.definition_id,
      row.definition_version,
      sourceAccess,
      version.schema,
    );
    const workflow = await tx.query(
      "SELECT id,status FROM processes WHERE submission_record_id=$1",
      [id],
    );
    const process = workflow.rows[0];
    if (
      process?.status === "running" &&
      actor.role !== "admin" &&
      !page?.taskId
    ) {
      access.edit = false;
    }
    const visible = masked(
      page?.schema || version.schema,
      row.values,
      row.cell_revisions,
      access,
    );

    return {
      ...(process ? { processId: process.id } : {}),
      ...(page
        ? { page: { id: page.id, version: page.version, title: page.title } }
        : {}),
      creator: await recordCreator(tx, actor, row.created_by),
      identities: await this.identityLabels(
        tx,
        actor,
        visible.schema,
        visible.values,
      ),
      definition: { ...definitionDto(version), schema: visible.schema },
      access,
      rowActions: rowActions(version.schema, access, page?.schema),
      ...(row.state === "draft" && access.create
        ? {
            collection: await this.collection.statusIn(
              tx,
              actor,
              row.definition_id,
              row.created_by,
            ),
          }
        : {}),
      record: {
        ...recordDto(row),
        values: visible.values,
        cellRevisions: visible.cells,
        rowRevisions: visible.rows,
      },
    };
  }

  /** 校验并生成记录导出或打印数据 */
  async output(actor: Actor, id: string, action: string) {
    if (action !== "export" && action !== "print") {
      throw new BadRequestException("输出操作不合法");
    }
    return this.db.transaction((tx) =>
      this.detailIn(tx, actor, id, undefined, action),
    );
  }

  /** 提取幂等命令中与当前权限组选择相关的作用域标识 */
  private commandScope(actor: Actor, definitionId: string) {
    const selection = actor.accessGroups?.[definitionId];
    return selection ? { accessGroup: selection } : {};
  }

  /**
   * 仅用于已通过写入鉴权的成功事务及其幂等回读，不可替代普通查询鉴权。
   * - 若写入后因自定义条件变更导致当前用户失去记录读取权限，在允许回执时返回 `accessLost: true` 空脱敏回执。
   */
  async writeDetailIn(
    tx: Transaction,
    actor: Actor,
    id: string,
    page?: RecordPageScope,
    allowReceipt = true,
  ): Promise<RecordDetail> {
    const meta = (
      await tx.query(
        "SELECT definition_id FROM records WHERE id = $1 AND workspace_id = $2 AND archived_at IS NULL",
        [id, actor.workspaceId],
      )
    ).rows[0];
    if (!meta) {
      throw new NotFoundException("记录不存在或不可访问");
    }

    await this.definition(tx, actor, meta.definition_id, "FOR SHARE");
    const row = (
      await tx.query(
        "SELECT * FROM records WHERE id = $1 AND workspace_id = $2 AND archived_at IS NULL FOR SHARE",
        [id, actor.workspaceId],
      )
    ).rows[0];
    if (!row) {
      throw new NotFoundException("记录不存在或不可访问");
    }

    try {
      return await this.detailIn(tx, actor, id, page);
    } catch (cause) {
      if (!(cause instanceof ForbiddenException) || !allowReceipt) throw cause;

      const version = (
        await tx.query(
          "SELECT * FROM definition_versions WHERE definition_id = $1 AND version = $2",
          [row.definition_id, row.definition_version],
        )
      ).rows[0];

      return {
        accessLost: true,
        ...(page
          ? { page: { id: page.id, title: page.title, version: page.version } }
          : {}),
        definition: {
          ...definitionDto(version),
          schema: {
            version: 1,
            fields: [],
            settings: {
              description: "",
              layout: 1,
              labelPosition: "top",
              labelWidth: 100,
              cacheDraft: false,
              hiddenValues: "retain",
              submitLabel: "保存",
              allowDraft: false,
              successMessage: "",
              allowAnotherSubmission: false,
              rules: [],
            },
          },
        },
        record: {
          ...recordDto(row),
          values: {},
          cellRevisions: {},
          rowRevisions: {},
        },
        access: {
          userId: actor.id,
          read: false,
          create: false,
          edit: false,
          remove: false,
          scope: "all",
          fields: {},
          relations: {},
        },
        rowActions: {},
      };
    }
  }

  /** 获取表单或页面下的记录摘要列表 */
  async records(
    actor: Actor,
    id: string,
    state = "active",
    page?: RecordPageScope,
    transaction?: Transaction,
  ): Promise<PageRecordSummary[]> {
    return (await this.recordList(actor, id, state, page, transaction)).records;
  }

  /** 先按权限裁剪记录，再按可见字段搜索、排序和分页。 */
  async recordList(
    actor: Actor,
    id: string,
    state = "active",
    page?: RecordPageScope,
    transaction?: Transaction,
    options?: { settings: RecordViewSettings; page: number; keyword?: string },
  ) {
    if (!["active", "draft"].includes(state)) {
      throw new BadRequestException("请选择正式记录或草稿");
    }

    const read = async (tx: Transaction) => {
      await this.definition(tx, actor, id, "FOR SHARE");
      const context = await this.authorization.context(tx, actor, id);
      const scope =
        state === "draft"
          ? await this.authorization.draftReaders(tx, actor, id, context)
          : await this.authorization.readers(tx, actor, id, context);

      const parameters: unknown[] = [
        id,
        actor.workspaceId,
        scope.creators,
        state,
        actor.role === "admin",
        actor.id,
        scope.createdDepartments,
      ];
      const groupScope = scope.sql?.("r", parameters) || "true";
      const where = `
        r.definition_id = $1
        AND r.workspace_id = $2
        AND r.archived_at IS NULL
        AND r.state = $4
        AND ($3::uuid[] IS NULL OR r.created_by = ANY($3) OR r.created_department_ids && $7::uuid[])
        AND (r.state <> 'draft' OR $5::boolean OR r.created_by = $6)
        AND (${groupScope})
      `;

      const settings = options?.settings;
      const fieldSort = !!settings && settings.sortField !== "$createdAt";
      const keyword = options?.keyword || "";
      const needsVisibleValues = fieldSort || !!keyword;

      // 未搜索时保留数据库分页；搜索必须在脱敏后筛选，不能拿隐藏值推断记录是否命中。
      let total = 0;
      if (!keyword) {
        const countRes = await tx.query(
          `SELECT count(*) AS count FROM records r WHERE ${where}`,
          parameters,
        );
        total = Number(countRes.rows[0].count);
      }

      const pageSize = settings?.pageSize || 100;
      let pageNumber = Math.min(
        options?.page || 1,
        Math.max(1, Math.ceil(total / pageSize)),
      );
      let offset = (pageNumber - 1) * pageSize;
      const order = settings?.descending === false ? "ASC" : "DESC";
      const limitClause = needsVisibleValues
        ? ""
        : `LIMIT ${pageSize} OFFSET ${offset}`;

      const listSql = `
        SELECT r.*, v.schema
        FROM records r
        JOIN definition_versions v ON v.definition_id = r.definition_id AND v.version = r.definition_version
        WHERE ${where}
        ORDER BY r.created_at ${order}, r.id
        ${limitClause}
      `;
      const { rows } = await tx.query(listSql, parameters);

      // 同一成员可能出现在许多记录中，历史标签按本次可见结果去重后一次读取。
      const populateIdentities = async (records: PageRecordSummary[]) => {
        const labels = new Map<string, OrganizationIdentity>();
        for (const record of records) {
          const preview = record.preview;
          if (!preview) continue;
          preview.identities = organizationLabels(
            { version: 1, fields: preview.fields } as FormSchema,
            preview.values,
            context.organization,
          );
          for (const identity of preview.identities) {
            labels.set(`${identity.kind}:${identity.id}`, identity);
          }
        }
        const resolved = await historicalLabels(tx, actor, [...labels.values()]);
        const identities = new Map(
          resolved.map((identity) => [`${identity.kind}:${identity.id}`, identity]),
        );
        for (const record of records) {
          if (!record.preview) continue;
          record.preview.identities = record.preview.identities.map(
            (identity) => identities.get(`${identity.kind}:${identity.id}`)!,
          );
        }
      };

      let result: PageRecordSummary[] = [];
      for (const row of rows) {
        const record: PageRecordSummary = {
          id: row.id,
          definitionVersion: row.definition_version,
          revision: row.revision,
          state: row.state,
          createdAt: new Date(row.created_at).toISOString(),
          updatedAt: new Date(row.updated_at).toISOString(),
        };

        if (
          page &&
          pageAcceptsVersion(page, row.schema, row.definition_version)
        ) {
          const source = effectiveAccess(actor, row.schema, context, {
            createdBy: row.created_by,
            createdDepartmentIds: row.created_department_ids,
            values: row.values,
            ...(row.state === "draft" ? { operation: "create" as const } : {}),
          });
          const access = pageAccess(
            page,
            id,
            row.definition_version,
            source,
            row.schema,
          );
          const visible = masked(page.schema, row.values, {}, access);
          record.preview = {
            fields: visible.schema.fields,
            values: visible.values,
            identities: [],
          };
        }
        result.push(record);
      }

      // 搜索或按组织字段排序先补齐所有可见名称；普通列表只补当前页。
      const sortByIdentity = page?.schema.fields.some(
        (field) =>
          field.id === settings?.sortField && isOrganizationField(field.type),
      );
      const identitiesBeforePagination =
        !!keyword || (fieldSort && sortByIdentity);
      if (identitiesBeforePagination) await populateIdentities(result);

      if (keyword) {
        result = result.filter((record) =>
          this.recordMatchesKeyword(record, keyword),
        );
        total = result.length;
        pageNumber = Math.min(
          options?.page || 1,
          Math.max(1, Math.ceil(total / pageSize)),
        );
        offset = (pageNumber - 1) * pageSize;
      }

      if (fieldSort) {
        const sortKey = (record: PageRecordSummary) => {
          const preview = record.preview;
          const field = preview?.fields.find(
            (f) => f.id === settings!.sortField,
          );
          if (!field || !preview) return "";
          const value = preview.values[field.id];
          if (isNumericField(field)) return Number(value);
          return displayPlainFieldValue(field, value, {
            identity: (orgId) =>
              preview.identities.find((identity) => identity.id === orgId)
                ?.name || "无法识别的成员或部门",
          }).toLocaleLowerCase();
        };

        const keys = new Map(
          result.map((record) => [record.id, sortKey(record)]),
        );
        result.sort(
          (a, b) =>
            compareRecordSortValues(
              keys.get(a.id)!,
              keys.get(b.id)!,
              settings!.descending,
            ) || a.id.localeCompare(b.id),
        );
      }

      const records = needsVisibleValues
        ? result.slice(offset, offset + pageSize)
        : result;
      if (!identitiesBeforePagination) await populateIdentities(records);

      const fields =
        actor.role === "admin" && page
          ? page.schema.fields.filter(hasFieldValue)
          : [
              ...new Map(
                records.flatMap((record) =>
                  (record.preview?.fields || []).map(
                    (field) => [field.id, field] as const,
                  ),
                ),
              ).values(),
            ];

      return { records, total, page: pageNumber, pageSize, fields };
    };

    return transaction ? read(transaction) : this.db.transaction(read);
  }

  /** 仅检索已脱敏的展示内容，子表逐列读取，排除行标识和富文本属性等内部值。 */
  private recordMatchesKeyword(
    record: PageRecordSummary,
    keyword: string,
  ): boolean {
    if (record.id.toLowerCase().includes(keyword)) return true;
    if (record.createdAt.includes(keyword)) return true;
    if (new Date(record.createdAt).toLocaleString("zh-CN").includes(keyword))
      return true;
    const preview = record.preview;
    if (!preview) return false;

    const labels = {
      identity: (id: string) => {
        const identity = preview.identities.find((item) => item.id === id);
        return identity
          ? organizationIdentityLabel(identity)
          : "无法识别的成员或部门";
      },
    };
    const fieldMatches = (field: FormField, value: unknown): boolean => {
      if (field.type === "richtext") {
        if (typeof value !== "string") return false;
        // HTML 用解析器取文本：链接、图片属性及脚本样式内容都不属于可见值。
        const text = (node: DefaultTreeAdapterMap["node"]): string => {
          if (node.nodeName === "#text")
            return (node as DefaultTreeAdapterMap["textNode"]).value;
          if (
            [
              "script",
              "style",
              "template",
              "head",
              "iframe",
              "object",
              "noscript",
              "svg",
              "math",
              "audio",
              "video",
              "title",
              "xmp",
              "noembed",
              "noframes",
            ].includes(node.nodeName)
          )
            return "";
          if (node.nodeName === "br") return "\n";
          if (!("childNodes" in node)) return "";
          const content = node.childNodes.map(text).join("");
          const block = [
            "p",
            "div",
            "li",
            "blockquote",
            "h1",
            "h2",
            "h3",
            "h4",
            "h5",
            "h6",
          ].includes(node.nodeName);
          return block ? `\n${content}\n` : content;
        };
        return text(parseFragment(value))
          .replace(/\s+/g, " ")
          .toLocaleLowerCase()
          .includes(keyword);
      }
      if (field.type === "subform" && Array.isArray(value)) {
        const matched = value.some((row) =>
          field.children.some((child) => fieldMatches(child, row[child.id])),
        );
        if (matched) return true;
      }
      return displayPlainFieldValue(field, value, labels)
        .toLocaleLowerCase()
        .includes(keyword);
    };
    return preview.fields.some(
      (field) =>
        hasFieldValue(field) && fieldMatches(field, preview.values[field.id]),
    );
  }

  /** 创建正式记录或草稿记录 */
  /** 已配置提交自动发起的表单必须走表单入口，不能通过底层记录接口绕开流程。 */
  private async requireWorkflowEntry(
    tx: Queryable,
    definitionId: string,
    page?: RecordPageScope,
  ) {
    const { rows } = await tx.query(
      `SELECT t.start_page_id FROM process_templates t
       JOIN pages p ON p.id=t.start_page_id
       WHERE p.definition_id=$1 AND t.enabled AND t.active_version IS NOT NULL`,
      [definitionId],
    );
    if (rows.length && !rows.some((row) => row.start_page_id === page?.id)) {
      throw new ConflictException("此表单已启用流程，请从填写表单入口提交");
    }
  }

  async createRecord(
    actor: Actor,
    id: string,
    body: unknown,
    page?: RecordPageScope,
    transaction?: Transaction,
  ) {
    object(body);
    if (body.state !== undefined && !["active", "draft"].includes(body.state)) {
      throw new BadRequestException("记录状态不合法");
    }
    const draft = body.state === "draft";
    if (!Number.isInteger(body.version) || body.version < 1) {
      throw new BadRequestException("需要发布版本");
    }

    const write = async (tx: Transaction) => {
      const commandPayload = {
        create: id,
        ...this.commandScope(actor, id),
        version: body.version,
        values: body.values,
        ...(draft ? { state: "draft" } : {}),
        ...(page ? { page: { id: page.id, version: page.version } } : {}),
      };

      const recordId = await once(
        tx,
        actor,
        body.requestId,
        commandPayload,
        async () => {
          await this.definition(tx, actor, id, "FOR SHARE");
          if (page && !page.taskId) {
            await assertPageActive(tx, actor, page.id);
          }

          const version = (
            await tx.query(
              "SELECT * FROM definition_versions WHERE definition_id = $1 AND version = $2",
              [id, body.version],
            )
          ).rows[0];
          if (!version) {
            throw new BadRequestException("发布版本不存在");
          }

          if (!draft) await this.requireWorkflowEntry(tx, id, page);
          const baseAccess = await this.access(tx, actor, id, version.schema, {
            operation: "create",
          });
          const access = pageAccess(page, id, version.version, baseAccess);
          if (!access.create) {
            throw new ForbiddenException("没有新增权限");
          }

          const { values, revisions } = await this.createValues(
            tx,
            actor,
            draft ? draftSchema(version.schema) : version.schema,
            body.values,
            access,
            {},
            version.schema,
            !draft,
          );

          const subforms = (version.schema as FormSchema).fields.filter(
            (field) => field.type === "subform",
          );
          for (const field of subforms) {
            const policy = rowPolicy(
              field,
              page?.schema.fields.find((item) => item.id === field.id),
            );
            if (
              (values[field.id] as FormValues[]).length &&
              !policy.add &&
              !policy.insert
            ) {
              throw new ForbiddenException(
                `「${field.label}」不可新增或插入记录`,
              );
            }
          }

          await this.validateRecordOrganizations(
            tx,
            actor,
            version.schema,
            values,
          );
          if (!draft) {
            validatePageSubmission(page, values, access);
            await this.collection.requireSubmission(tx, actor, id);
          }

          const rid = randomUUID();
          const orgSnapshot = await this.organizations.snapshot(tx, actor);
          const createdDepartments =
            orgSnapshot.spec.assignments.find(
              (item) => item.userId === actor.id,
            )?.departmentIds || [];

          await tx.query(
            "INSERT INTO records(id, workspace_id, definition_id, definition_version, values, cell_revisions, created_by, state, created_department_ids) VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9)",
            [
              rid,
              actor.workspaceId,
              id,
              body.version,
              values,
              revisions,
              actor.id,
              draft ? "draft" : "active",
              createdDepartments,
            ],
          );
          await tx.query(
            "INSERT INTO record_events(id, record_id, actor_id, revision, changes) VALUES($1, $2, $3, 1, $4)",
            [
              randomUUID(),
              rid,
              actor.id,
              { action: draft ? "draft-create" : "create" },
            ],
          );
          await this.files.bind(tx, actor, rid, version.schema, values);
          return rid;
        },
      );

      return this.writeDetailIn(tx, actor, recordId, page);
    };

    return transaction ? write(transaction) : this.db.transaction(write);
  }

  /** 将草稿记录正式提交为生效记录（支持在提交的同时携带最后一次增量字段与子表修改） */
  async submitRecord(
    actor: Actor,
    id: string,
    body: unknown,
    page?: RecordPageScope,
    transaction?: Transaction,
  ) {
    uuid(id);
    object(body);
    if (
      (body.changes !== undefined && !Array.isArray(body.changes)) ||
      (body.rows !== undefined && !Array.isArray(body.rows))
    ) {
      throw new BadRequestException("草稿修改格式不合法");
    }

    const write = async (tx: Transaction) => {
      const meta = (
        await tx.query(
          "SELECT definition_id FROM records WHERE id = $1 AND workspace_id = $2",
          [id, actor.workspaceId],
        )
      ).rows[0];
      if (!meta) {
        throw new NotFoundException("记录不存在或不可访问");
      }

      const commandPayload = {
        submit: id,
        ...this.commandScope(actor, meta.definition_id),
        body,
        ...(page ? { pageId: page.id, pageVersion: page.version } : {}),
      };

      const recordId = await once(
        tx,
        actor,
        body.requestId,
        commandPayload,
        async () => {
          await this.definition(tx, actor, meta.definition_id, "FOR SHARE");
          if (page) {
            await assertPageActive(tx, actor, page.id);
          }

          await this.requireWorkflowEntry(tx, meta.definition_id, page);
          const source = await this.loadRecord(tx, actor, id, true);
          if (source.row.state !== "draft") {
            throw new ConflictException("此记录已提交，请重新读取当前记录");
          }
          if (source.row.revision !== body.expectedRevision) {
            throw new ConflictException(
              "草稿已被修改，请重新读取后再提交；当前输入保留",
            );
          }

          const access = pageAccess(
            page,
            source.row.definition_id,
            source.row.definition_version,
            source.access,
            source.version.schema,
          );
          if (!access.create) {
            throw new ForbiddenException("当前没有提交此草稿的权限");
          }

          if ((body.changes?.length || 0) + (body.rows?.length || 0)) {
            await this.patchRecord(
              actor,
              id,
              {
                requestId: randomUUID(),
                changes: body.changes || [],
                rows: body.rows || [],
              },
              page,
              tx,
            );
          }

          const current = await this.loadRecord(tx, actor, id);
          validateSubmittedRecord(current.version.schema, current.row.values);
          await this.validateRecordOrganizations(
            tx,
            actor,
            current.version.schema,
            current.row.values,
            current.row.values,
          );
          validatePageSubmission(page, current.row.values, access);
          await this.collection.requireSubmission(
            tx,
            actor,
            source.row.definition_id,
            source.row.created_by,
          );

          await this.files.bind(
            tx,
            actor,
            id,
            current.version.schema,
            current.row.values,
            current.row.values,
          );

          await tx.query(
            "UPDATE records SET state = 'active', revision = revision + 1, updated_at = now() WHERE id = $1",
            [id],
          );
          await tx.query(
            "INSERT INTO record_events(id, record_id, actor_id, revision, changes) VALUES($1, $2, $3, $4, $5)",
            [
              randomUUID(),
              id,
              actor.id,
              current.row.revision + 1,
              { action: "submit-draft" },
            ],
          );
          return id;
        },
      );

      return this.writeDetailIn(tx, actor, recordId, page);
    };

    return transaction ? write(transaction) : this.db.transaction(write);
  }

  /** 增量修改记录的单元格值与子表明细行（基于单元格级乐观锁并发控制） */
  async patchRecord(
    actor: Actor,
    id: string,
    body: unknown,
    page?: RecordPageScope,
    transaction?: Transaction,
    guard?: () => void,
  ) {
    uuid(id);
    object(body);
    if (body.changes === undefined) body.changes = [];
    if (body.rows === undefined) body.rows = [];

    const isInvalidPatchBatch =
      !Array.isArray(body.changes) ||
      !Array.isArray(body.rows) ||
      !(body.changes.length + body.rows.length) ||
      body.changes.length > 200 ||
      body.rows.length > 100;
    if (isInvalidPatchBatch) {
      throw new BadRequestException(
        "需要字段或明细修改，单次最多 200 个字段、100 个明细动作",
      );
    }

    const write = async (tx: Transaction) => {
      const meta = (
        await tx.query(
          "SELECT definition_id FROM records WHERE id = $1 AND workspace_id = $2",
          [id, actor.workspaceId],
        )
      ).rows[0];
      if (!meta) {
        throw new NotFoundException("记录不存在或不可访问");
      }

      const commandPayload = {
        patch: id,
        ...this.commandScope(actor, meta.definition_id),
        changes: body.changes,
        ...(body.rows.length ? { rows: body.rows } : {}),
        ...(page
          ? {
              page: {
                id: page.id,
                version: page.version,
                taskId: page.taskId,
                row: page.row,
              },
            }
          : {}),
      };

      return once(tx, actor, body.requestId, commandPayload, async () => {
        guard?.();
        // 所有写操作固定先锁 definition 再锁 record；策略变更则对 definition 加排他锁
        await this.definition(tx, actor, meta.definition_id, "FOR SHARE");
        if (page && !page.taskId) {
          await assertPageActive(tx, actor, page.id);
        }

        const {
          row,
          version,
          access: recordAccess,
        } = await this.loadRecord(tx, actor, id, true);
        if (actor.role !== "admin" && !page?.taskId) {
          const running = await tx.query(
            "SELECT 1 FROM processes WHERE submission_record_id=$1 AND status='running'",
            [id],
          );
          if (running.rowCount)
            throw new ForbiddenException("流程处理中，请从待办中办理此记录");
        }
        const access = pageAccess(
          page,
          row.definition_id,
          row.definition_version,
          recordAccess,
          version.schema,
        );
        if (!access.edit) {
          throw new ForbiddenException("没有修改权限");
        }

        const schema =
          row.state === "draft"
            ? draftSchema(version.schema)
            : (version.schema as FormSchema);
        const keys = new Set<string>();
        const beforeValues = structuredClone(row.values);
        const changed: Record<string, unknown>[] = [];

        body.changes.forEach(object);
        if (
          page?.row &&
          (body.rows.length ||
            body.changes.some(
              (change: any) =>
                change.subformId !== page.row!.subformId ||
                change.rowId !== page.row!.rowId,
            ))
        ) {
          throw new ForbiddenException("此任务仅允许修改所绑定的明细行");
        }

        await this.patchRows(
          tx,
          actor,
          row,
          schema,
          access,
          body.rows,
          changed,
          page?.schema,
        );

        // 恢复明细的附件来自服务端历史值，且 patchRows 已校验该行所有列的编辑权限。
        const fileSources = structuredClone(beforeValues);
        for (const change of changed) {
          if (change.action !== "row-restore") continue;
          const subformId = change.subformId as string;
          const restored = row.values[subformId].find(
            (item: FormValues) => item._rowId === change.rowId,
          );
          (fileSources[subformId] as FormValues[]).push(
            structuredClone(restored),
          );
        }

        for (const raw of body.changes) {
          object(raw);
          const change = raw as CellChange;
          const parent = change.subformId
            ? schema.fields.find(
                (f) => f.id === change.subformId && f.type === "subform",
              )
            : undefined;
          const field = parent
            ? parent.children.find((f) => f.id === change.fieldId)
            : schema.fields.find(
                (f) => f.id === change.fieldId && f.type !== "subform",
              );

          if (
            !field ||
            (change.subformId && !parent) ||
            (!parent && change.rowId) ||
            permission(access, field, parent) !== "edit"
          ) {
            throw new ForbiddenException("字段不存在或没有修改权限");
          }

          const target = parent
            ? (row.values[parent.id] as FormValues[]).find(
                (r) => r._rowId === change.rowId,
              )
            : row.values;
          if (!target) {
            throw new BadRequestException("明细行不存在，请重新读取");
          }

          if (
            parent &&
            !rowPolicy(
              parent,
              page?.schema.fields.find((item) => item.id === parent.id),
            ).editExisting
          ) {
            throw new ForbiddenException(`「${parent.label}」不可编辑已有记录`);
          }

          const key = cellKey(change);
          if (
            keys.has(key) ||
            !Number.isInteger(change.expectedRevision) ||
            change.expectedRevision < 1
          ) {
            throw new BadRequestException("字段修改版本无效或重复");
          }
          keys.add(key);

          if (row.cell_revisions[key] !== change.expectedRevision) {
            throw new ConflictException(
              "该字段已被其他成员修改，输入已保留，请重新读取后合并",
            );
          }

          const value = scalar(field, change.value);
          changed.push({ ...change, before: target[field.id], value });
          target[field.id] = value;
          row.cell_revisions[key]++;
        }

        await this.validateRecordOrganizations(
          tx,
          actor,
          schema,
          row.values,
          beforeValues,
        );
        await this.files.bind(tx, actor, id, schema, row.values, fileSources);
        if (row.state !== "draft") {
          validatePageSubmission(page, row.values, access);
        }

        await tx.query(
          "UPDATE records SET values = $2, cell_revisions = $3, revision = revision + 1, updated_at = now() WHERE id = $1",
          [id, row.values, row.cell_revisions],
        );
        await tx.query(
          "INSERT INTO record_events(id, record_id, actor_id, revision, changes) VALUES($1, $2, $3, $4, $5)",
          [
            randomUUID(),
            id,
            actor.id,
            row.revision + 1,
            JSON.stringify(changed),
          ],
        );
        return id;
      });
    };

    const result = async (tx: Transaction) =>
      this.writeDetailIn(tx, actor, await write(tx), page, !page?.taskId);
    return transaction ? result(transaction) : this.db.transaction(result);
  }

  /** 执行子表明细行的增（add）、插（insert）、删（remove）、恢复（restore）结构动作 */
  private async patchRows(
    tx: Transaction,
    actor: Actor,
    record: any,
    schema: FormSchema,
    access: AccessGrant,
    commands: unknown[],
    audit: Record<string, unknown>[],
    page?: FormSchema,
  ) {
    const touched = new Set<string>();
    const removed = new Set<string>();

    for (const raw of commands) {
      object(raw);
      const parent = schema.fields.find(
        (f) => f.id === raw.subformId && f.type === "subform",
      );
      if (!parent || permission(access, parent) !== "edit") {
        throw new ForbiddenException("没有此明细的结构修改权限");
      }

      const policy = rowPolicy(
        parent,
        page?.fields.find((item) => item.id === parent.id),
      );
      const key = `@rows/${parent.id}`;
      if (
        !Number.isInteger(raw.expectedRevision) ||
        raw.expectedRevision !== (record.cell_revisions[key] || 1)
      ) {
        throw new ConflictException("明细行结构已变更，请读取最新记录后重试");
      }

      const rows = record.values[parent.id] as FormValues[];

      if (raw.action === "add" || raw.action === "insert") {
        if (raw.action === "add" ? !policy.add : !policy.insert) {
          throw new ForbiddenException(
            raw.action === "add" ? "不可新增记录" : "不可插入记录",
          );
        }
        let index = rows.length;
        if (raw.action === "insert" && raw.beforeRowId !== null) {
          uuid(raw.beforeRowId);
          index = rows.findIndex((item) => item._rowId === raw.beforeRowId);
          if (index < 0) {
            throw new ConflictException("插入位置已变化，请读取最新记录后重试");
          }
        }

        const created = await this.createValues(
          tx,
          actor,
          { ...schema, fields: [parent] },
          { [parent.id]: [raw.values] },
          access,
          record.values,
          schema,
          record.state !== "draft",
        );
        const value = (created.values[parent.id] as FormValues[])[0]!;
        rows.splice(index, 0, value);

        for (const [cell, revision] of Object.entries(created.revisions)) {
          if (cell !== key) {
            record.cell_revisions[cell] = revision;
          }
        }
        audit.push({
          action: "row-add",
          subformId: parent.id,
          rowId: value._rowId,
          values: value,
          ...(raw.action === "insert" ? { beforeRowId: raw.beforeRowId } : {}),
        });
      } else if (raw.action === "remove") {
        if (!policy.deleteExisting) {
          throw new ForbiddenException("不可删除已有记录");
        }
        uuid(raw.rowId);
        object(raw.expectedCells);

        if (
          parent.children.some(
            (child) => permission(access, child, parent) !== "edit",
          )
        ) {
          throw new ForbiddenException("删除明细需要能够修改该行所有列");
        }

        const index = rows.findIndex((r) => r._rowId === raw.rowId);
        if (index < 0 || removed.has(raw.rowId)) {
          throw new ConflictException("明细行已不存在或重复删除");
        }

        for (const child of parent.children) {
          const cell = cellKey({
            subformId: parent.id,
            rowId: raw.rowId,
            fieldId: child.id,
          });
          if (raw.expectedCells[cell] !== record.cell_revisions[cell]) {
            throw new ConflictException(
              "明细内容已被其他成员修改，不能删除旧快照",
            );
          }
        }

        const refSql = `
          SELECT
            EXISTS(SELECT 1 FROM record_links WHERE source_record_id = $1 AND source_row_id = $2)
            OR EXISTS(SELECT 1 FROM tasks WHERE record_id = $1 AND row_id = $2) AS referenced
        `;
        const references = (await tx.query(refSql, [record.id, raw.rowId]))
          .rows[0];
        if (references.referenced) {
          throw new ConflictException(
            "明细行已被关系或任务引用，请先处理引用影响",
          );
        }

        audit.push({
          action: "row-remove",
          subformId: parent.id,
          rowId: raw.rowId,
          definitionVersion: record.definition_version,
          before: rows[index],
        });
        rows.splice(index, 1);
        removed.add(raw.rowId);

        for (const child of parent.children) {
          delete record.cell_revisions[
            cellKey({
              subformId: parent.id,
              rowId: raw.rowId,
              fieldId: child.id,
            })
          ];
        }
      } else if (raw.action === "restore") {
        if (!policy.add) {
          throw new ForbiddenException("不可新增记录，无法恢复明细");
        }
        uuid(raw.rowId);
        uuid(raw.eventId);

        if (
          parent.children.some(
            (child) => permission(access, child, parent) !== "edit",
          )
        ) {
          throw new ForbiddenException("恢复明细需要能够修改该行所有列");
        }
        if (rows.some((row) => row._rowId === raw.rowId)) {
          throw new ConflictException("此明细行已存在，请刷新查看");
        }

        const deleted = (await latestRowEvents(tx, record.id)).find(
          (event) =>
            event.change.subformId === parent.id &&
            event.change.rowId === raw.rowId,
        );
        if (
          !deleted ||
          deleted.id !== raw.eventId ||
          deleted.change.action !== "row-remove"
        ) {
          throw new ConflictException(
            "删除记录已变化，请选择最近一次删除的明细",
          );
        }

        const { _rowId, ...before } = deleted.change.before;
        const restored = await this.createValues(
          tx,
          actor,
          { ...schema, fields: [parent] },
          { [parent.id]: [before] },
          access,
          record.values,
          schema,
          record.state !== "draft",
        );
        const value = (restored.values[parent.id] as FormValues[])[0]!;
        value._rowId = raw.rowId;
        rows.push(value);

        // 恢复后的单元格版本号递增至 record.revision + 1，防止与删除前的历史快照版本号重叠
        for (const child of parent.children) {
          const cell = cellKey({
            subformId: parent.id,
            rowId: raw.rowId,
            fieldId: child.id,
          });
          record.cell_revisions[cell] = record.revision + 1;
        }
        audit.push({
          action: "row-restore",
          subformId: parent.id,
          rowId: raw.rowId,
          sourceEventId: deleted.id,
        });
      } else {
        throw new BadRequestException("明细动作不合法");
      }

      touched.add(parent.id);
    }

    for (const subformId of touched) {
      const parent = schema.fields.find((f) => f.id === subformId)!;
      if (
        record.values[subformId].length > maxSubformRows ||
        (parent.required && !record.values[subformId].length)
      ) {
        throw new BadRequestException("明细数量不符合要求");
      }
      record.cell_revisions[`@rows/${subformId}`] =
        (record.cell_revisions[`@rows/${subformId}`] || 1) + 1;
    }
  }

  /** 归档指定记录（已被关联关系、流程实例或任务引用的记录不允许归档） */
  async archiveRecord(actor: Actor, id: string, body: unknown) {
    uuid(id);
    object(body);

    const recordId = await this.db.transaction((tx) =>
      once(
        tx,
        actor,
        body.requestId,
        { archive: id, expectedRevision: body.expectedRevision },
        async () => {
          const meta = (
            await tx.query(
              "SELECT definition_id FROM records WHERE id = $1 AND workspace_id = $2",
              [id, actor.workspaceId],
            )
          ).rows[0];
          if (!meta) {
            throw new NotFoundException("记录不存在");
          }

          await this.definition(tx, actor, meta.definition_id, "FOR SHARE");
          const record = await this.loadRecord(tx, actor, id, true);
          if (!record.access.remove) {
            throw new ForbiddenException("没有归档权限");
          }
          if (record.row.revision !== body.expectedRevision) {
            throw new ConflictException("记录已被修改，请刷新后再归档");
          }

          const depSql = `
            SELECT
              EXISTS(SELECT 1 FROM record_links WHERE source_record_id = $1 OR target_record_id = $1)
              OR EXISTS(SELECT 1 FROM tasks WHERE record_id = $1)
              OR EXISTS(
                SELECT 1 FROM processes p
                CROSS JOIN LATERAL jsonb_each_text(p.bindings) b
                WHERE b.value = $1::text
              ) AS referenced
          `;
          const dependency = (await tx.query(depSql, [id])).rows[0];
          if (dependency.referenced) {
            throw new ConflictException("记录已被关系或任务引用，不能归档");
          }

          await tx.query(
            "UPDATE records SET archived_at = now(), updated_at = now(), revision = revision + 1 WHERE id = $1",
            [id],
          );
          await tx.query(
            "INSERT INTO record_events(id, record_id, actor_id, revision, changes) VALUES($1, $2, $3, $4, $5)",
            [
              randomUUID(),
              id,
              actor.id,
              record.row.revision + 1,
              { action: "archive" },
            ],
          );
          return id;
        },
      ),
    );
    return { id: recordId, archived: true };
  }

  /** 查询记录下已删除的子表明细行列表，并预检当前用户及模型下是否可恢复 */
  async removedRows(actor: Actor, id: string, page?: RecordPageScope) {
    return this.db.transaction(async (tx) => {
      const record = await this.loadRecord(tx, actor, id);
      const access = pageAccess(
        page,
        record.row.definition_id,
        record.row.definition_version,
        record.access,
        record.version.schema,
      );
      const allowed = rowActions(record.version.schema, access, page?.schema);
      const events = await latestRowEvents(tx, id);

      const candidateEvents = events.filter(
        (event) =>
          event.change.action === "row-remove" &&
          allowed[event.change.subformId]?.remove &&
          !(record.row.values[event.change.subformId] || []).some(
            (row: FormValues) => row._rowId === event.change.rowId,
          ),
      );

      return Promise.all(
        candidateEvents.map(async (event) => {
          const parent = (record.version.schema as FormSchema).fields.find(
            (field) => field.id === event.change.subformId,
          )!;
          const { _rowId, ...before } = event.change.before;

          let restorable = true;
          let reason: string | undefined;
          try {
            if (!allowed[parent.id]?.add) {
              throw new ForbiddenException("不可新增记录，无法恢复明细");
            }
            const restoreSchema =
              record.row.state === "draft"
                ? draftSchema(record.version.schema)
                : record.version.schema;
            const targetSubform = restoreSchema.fields.find(
              (field: FormField) => field.id === parent.id,
            )!;
            const restored = await this.createValues(
              tx,
              actor,
              { ...restoreSchema, fields: [targetSubform] },
              { [parent.id]: [before] },
              access,
              record.row.values,
              record.version.schema,
              record.row.state !== "draft",
            );
            await this.validateRecordOrganizations(
              tx,
              actor,
              record.version.schema,
              {
                ...record.row.values,
                [parent.id]: [
                  ...record.row.values[parent.id],
                  ...(restored.values[parent.id] as FormValues[]),
                ],
              },
              record.row.values,
            );
          } catch (cause) {
            restorable = false;
            reason = (cause as Error).message;
          }

          return {
            eventId: event.id,
            subformId: parent.id,
            rowId: event.change.rowId,
            values: Object.fromEntries(
              parent.children.map((child) => [child.id, before[child.id]]),
            ),
            removedAt: new Date(event.created_at).toISOString(),
            restorable,
            reason,
          };
        }),
      );
    });
  }

  /** 获取单条记录的历史变更审计事件列表（仅管理员） */
  async events(actor: Actor, id: string) {
    requireAdmin(actor);
    await this.loadRecord(this.db, actor, id);
    const { rows } = await this.db.query(
      'SELECT actor_id AS "actorId", revision, changes, created_at AS "createdAt" FROM record_events WHERE record_id = $1 ORDER BY revision',
      [id],
    );
    return rows;
  }
}
