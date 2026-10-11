import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { maxSubformRows } from "@platform/contracts";
import type {
  AccessGrant,
  AccessPolicy,
  SubjectGrant,
  CellChange,
  FormField,
  FormSchema,
  FormValues,
  RecordDetail,
  ServerDefinition,
  ServerRecord,
} from "@platform/contracts";
import { Database, Transaction } from "./database";
import { Actor, requireAdmin } from "./auth";
import { once } from "./commands";
import { storeModelDraft, storeModelVersion } from "./data-projection";
import { dataKind, separateFormSchema, isOrganizationField, isDepartmentField, equalFieldValues, fieldDefaultValue } from "@platform/contracts";
import { dataModelImpact } from "./model-impact";
import { pageAccess, validatePageSubmission, type RecordPageScope } from "./page-runtime";
import { assertPageActive } from "./page-lifecycle";
import { pageBindings } from "./page-schema";
import { applicationId } from "./applications";
import { referencedRelationFields } from "./relation-rules";
import { latestRowEvents } from "./record-rows";
import { AccessService, AccessContext } from "./access";
import { OrganizationService, parseSubject, requireSubject } from "./organization";
import { CollectionService } from "./collection";
import { draftSchema, validateSubmittedRecord } from "./record-state";
import { historicalLabels, recordCreator } from "./historical-identities";
import { organizationCandidates, organizationDefault, organizationDefaultResolver, organizationLabels, validateOrganizationDefinition, validateOrganizationValues } from "./organization-fields";
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
  title,
  uuid,
} from "./schema";

type Queryable = Pick<Database, "query">;
export const definitionDto = (row: any): ServerDefinition => ({
  id: row.definition_id,
  title: row.title,
  version: row.version,
  schema: row.schema,
  createdAt: new Date(row.created_at).toISOString(),
});
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

@Injectable()
export class PlatformService {
  constructor(private readonly db: Database, private readonly authorization: AccessService, private readonly organizations: OrganizationService, private readonly collection: CollectionService) {}
  async collectionStatus(tx: Transaction, actor: Actor, id: string) { return this.collection.statusIn(tx, actor, id); }
  async validateOrganizationModel(tx: Queryable, actor: Actor, schema: FormSchema) {
    if (allFields(schema).some(field => isOrganizationField(field.type))) validateOrganizationDefinition(schema, await this.organizations.snapshot(tx, actor));
  }
  async validateRecordOrganizations(tx: Queryable, actor: Actor, schema: FormSchema, values: FormValues, before?: FormValues) {
    if (allFields(schema).some(field => isOrganizationField(field.type))) validateOrganizationValues(schema, values, await this.organizations.snapshot(tx, actor), actor.id, before);
  }
  async identityLabels(tx: Queryable, actor: Actor, schema: FormSchema, values: FormValues) {
    return allFields(schema).some(field => isOrganizationField(field.type)) ? historicalLabels(tx, actor, organizationLabels(schema, values, await this.organizations.snapshot(tx, actor))) : [];
  }
  async defaultResolver(tx: Queryable, actor: Actor, schema: FormSchema, values: FormValues = {}, base: FormValues = {}, fullSchema = schema) {
    const resolve = allFields(schema).some(field => isOrganizationField(field.type)) ? organizationDefaultResolver(fullSchema, await this.organizations.snapshot(tx, actor), actor.id, values, base) : (field: FormField) => field.defaultValue;
    const now = new Date();
    return (field: FormField, row?: FormValues) => field.type === "datetime" ? fieldDefaultValue(field, now) : resolve(field, row);
  }
  async recordDefaults(tx: Queryable, actor: Actor, schema: FormSchema) {
    const resolve = await this.defaultResolver(tx, actor, schema);
    return Object.fromEntries(schema.fields.map(field => [field.id, field.type === "subform" ? [] : resolve(field)]));
  }
  async createValues(tx: Queryable, actor: Actor, schema: FormSchema, input: unknown, access: AccessGrant, base: FormValues = {}, fullSchema = schema) {
    object(input);
    const resolve = await this.defaultResolver(tx, actor, schema, input, base, fullSchema);
    return newValues(schema, input, access, resolve);
  }
  async organizationOptions(actor: Actor, id: string, body: unknown, page?: RecordPageScope, transaction?: Transaction) {
    object(body); object(body.context || {});
    const read = async (tx: Transaction) => {
      await this.definition(tx, actor, id, "FOR SHARE");
      if (page && !page.taskId) await assertPageActive(tx, actor, page.id);
      const source = body.recordId ? await this.loadRecord(tx, actor, body.recordId) : undefined;
      if (source && source.row.definition_id !== id) throw new BadRequestException("记录不属于此数据对象");
      const versionNumber = source?.row.definition_version || page?.definitionVersion || body.version;
      if (!Number.isInteger(versionNumber) || versionNumber < 1) throw new BadRequestException("请选择明确的数据版本");
      const version = source?.version || (await tx.query("SELECT * FROM definition_versions WHERE definition_id=$1 AND version=$2", [id, versionNumber])).rows[0];
      if (!version) throw new BadRequestException("数据版本不存在");
      const schema = version.schema as FormSchema;
      const access = pageAccess(page, id, versionNumber, source?.access || await this.access(tx, actor, id, schema, { operation: "create" }), schema);
      const parent = body.subformId ? schema.fields.find(field => field.id === body.subformId && field.type === "subform") : undefined;
      const field = (parent?.children || schema.fields).find(field => field.id === body.fieldId && isOrganizationField(field.type));
      if (!field || (body.subformId && !parent) || permission(access, field, parent) !== "edit" || !(source ? access.edit : access.create)) throw new ForbiddenException("没有此组织字段的填写权限");
      if (page?.row && (body.subformId !== page.row.subformId || body.rowId !== page.row.rowId)) throw new ForbiddenException("只能选择当前任务明细中的组织字段");
      if (body.rowId && (!source || !parent)) throw new BadRequestException("明细行身份不适用");
      const currentRow = body.rowId ? (source!.row.values[parent!.id] as FormValues[]).find(row => row._rowId === body.rowId) : undefined;
      if (body.rowId && !currentRow) throw new BadRequestException("明细行不存在");
      const organization = await this.organizations.snapshot(tx, actor);
      const values = source?.row.values || await this.recordDefaults(tx, actor, schema);
      const context: FormValues = { ...values, ...currentRow };
      const allowedFields = [...schema.fields.filter(item => isDepartmentField(item.type)).map(field => ({ field, parent: undefined as FormField | undefined })), ...(parent?.children.filter(item => isDepartmentField(item.type)).map(field => ({ field, parent })) || [])];
      for (const [key, value] of Object.entries(body.context || {})) {
        const dependency = allowedFields.find(item => item.field.id === key);
        if (!dependency || permission(access, dependency.field, dependency.parent) !== "edit") throw new ForbiddenException("不能修改不可编辑的部门条件");
        context[key] = scalar(dependency.field, value, false);
      }
      const resolve = organizationDefaultResolver(schema, organization, actor.id, context);
      for (const dependency of allowedFields) if (context[dependency.field.id] === undefined) context[dependency.field.id] = resolve(dependency.field, parent ? context : undefined);
      for (const dependency of allowedFields) if (Object.hasOwn(body.context || {}, dependency.field.id)) {
        const before = dependency.parent ? currentRow?.[dependency.field.id] : values[dependency.field.id];
        if (equalFieldValues(before, context[dependency.field.id])) continue;
        const selected = context[dependency.field.id], ids = Array.isArray(selected) ? selected : selected ? [selected] : [];
        const eligible = new Set(organizationCandidates(organization, actor.id, dependency.field, context).map(item => item.id));
        if (ids.some(id => !eligible.has(String(id)))) throw new BadRequestException("部门条件不在当前允许范围内");
      }
      return { options: organizationCandidates(organization, actor.id, field, context), defaultValue: organizationDefault(organization, actor.id, field, context), organizationRevision: organization.revision };
    };
    return transaction ? read(transaction) : this.db.transaction(read);
  }
  async users(actor: Actor) {
    requireAdmin(actor);
    return (
      await this.db.query(
        "SELECT id,name,username,role FROM users WHERE workspace_id=$1 AND active ORDER BY username",
        [actor.workspaceId],
      )
    ).rows;
  }
  async definition(tx: Queryable, actor: Actor, id: string, lock = "") {
    uuid(id);
    if (lock) await this.organizations.lock(tx, actor.workspaceId);
    const row = (
      await tx.query(
        `SELECT * FROM definitions WHERE id=$1 AND workspace_id=$2 ${lock}`,
        [id, actor.workspaceId],
      )
    ).rows[0];
    if (!row) throw new NotFoundException("表单不存在或不可访问");
    return row;
  }
  async access(tx: Queryable, actor: Actor, id: string, schema: FormSchema, context?: AccessContext): Promise<AccessGrant> {
    return this.authorization.effective(tx, actor, id, schema, context);
  }
  async readableScope(tx: Queryable, actor: Actor, id: string) { return this.authorization.readers(tx, actor, id); }
  async accessibleDefinitions(tx: Queryable, actor: Actor) { return this.authorization.definitions(tx, actor); }
  async definitions(actor: Actor, appId?: string) {
    if (appId) await applicationId(this.db, actor, appId);
    return this.db.transaction(async tx => {
      const ids = await this.accessibleDefinitions(tx, actor);
      return (await tx.query(`SELECT d.id,d.title,d.revision,d.latest_version AS "latestVersion" FROM definitions d
        WHERE d.workspace_id=$1 AND ($2::uuid[] IS NULL OR d.id=ANY($2)) AND ($3::uuid IS NULL OR d.application_id=$3) ORDER BY d.created_at DESC`, [actor.workspaceId, ids, appId || null])).rows;
    });
  }
  async saveDefinition(actor: Actor, body: unknown, id?: string, managePage = true) {
    requireAdmin(actor);
    object(body);
    title(body.title);
    const schema = parseSchema(body.schema, !managePage);
    return this.db.transaction(async (tx) => {
      if (!id) {
        id = randomUUID();
        await tx.query(
          "INSERT INTO definitions(id,workspace_id,title,draft,application_id) VALUES($1,$2,$3,$4,$5)",
          [id, actor.workspaceId, body.title.trim(), schema, await applicationId(tx, actor, body.applicationId)],
        );
        await storeModelDraft(tx, { id, workspace_id: actor.workspaceId, title: body.title.trim() }, schema, managePage);
        return { id, revision: 1 };
      }
      const def = await this.definition(tx, actor, id, "FOR UPDATE");
      if (body.expectedRevision !== def.revision)
        throw new ConflictException("表单配置已更新，请重新读取");
      await this.validateStableFields(tx, id, schema);
      if (managePage) await this.checkRelations(tx, id, schema, true);
      await tx.query(
        "UPDATE definitions SET title=$2,draft=$3,revision=revision+1 WHERE id=$1",
        [id, body.title.trim(), schema],
      );
      await storeModelDraft(tx, { ...def, title: body.title.trim() }, schema, managePage);
      return { id, revision: def.revision + 1 };
    });
  }
  async publish(actor: Actor, id: string, body: unknown, managePage = true) {
    requireAdmin(actor);
    object(body);
    return this.db.transaction(async (tx) => {
      const def = await this.definition(tx, actor, id, "FOR UPDATE");
      if (body.expectedRevision !== def.revision)
        throw new ConflictException("表单配置已更新，请重新读取");
      const version = def.latest_version + 1;
      const schema = parseSchema(def.draft);
      await this.validateOrganizationModel(tx, actor, schema);
      await this.validateStableFields(tx, id, schema);
      const impact = await dataModelImpact(tx, def, separateFormSchema(schema).model, managePage, { organization: await this.organizations.snapshot(tx, actor), actorId: actor.id });
      if (impact.blockers.length) throw new ConflictException(impact.blockers.join("；"));
      if ((impact.changes.removed.length || impact.changes.changed.length) && !body.impactToken) throw new ConflictException("移除字段或修改数据约束前，请先检查发布影响");
      if (body.impactToken !== undefined && body.impactToken !== impact.token) throw new ConflictException("字段或使用情况已变化，请重新检查发布影响；草稿已保留");
      const row = (
        await tx.query(
          "INSERT INTO definition_versions(definition_id,version,title,schema) VALUES($1,$2,$3,$4) RETURNING *",
          [id, version, def.title, schema],
        )
      ).rows[0];
      await storeModelVersion(tx, id, version, row.schema, managePage);
      await tx.query(
        "UPDATE definitions SET latest_version=$2,revision=revision+1 WHERE id=$1",
        [id, version],
      );
      await tx.query("INSERT INTO configuration_events(id,workspace_id,actor_id,resource_kind,resource_id,action,revision,detail) VALUES($1,$2,$3,'data_object',$4,'publish',$5,$6)", [randomUUID(), actor.workspaceId, actor.id, id, def.revision + 1, { fromVersion: def.latest_version, toVersion: version, reviewedToken: body.impactToken || null, changes: impact.changes }]);
      return definitionDto(row);
    });
  }
  async modelImpact(actor: Actor, id: string, body: unknown, managePage = false) {
    requireAdmin(actor); object(body);
    return this.db.transaction(async tx => {
      // Record writers take a shared definition lock. Hold the exclusive lock while
      // counting and validating batches so concurrent inserts cannot skew totals.
      const definition = await this.definition(tx, actor, id, "FOR UPDATE");
      if (definition.revision !== body.expectedRevision) throw new ConflictException("数据草稿已修改，请重新读取后检查");
      const schema = parseSchema(definition.draft);
      await this.validateOrganizationModel(tx, actor, schema);
      await this.validateStableFields(tx, id, schema);
      return dataModelImpact(tx, definition, separateFormSchema(schema).model, managePage, { organization: await this.organizations.snapshot(tx, actor), actorId: actor.id });
    });
  }
  async validateStableFields(tx: Queryable, id: string, schema: FormSchema) {
    const versions = (await tx.query("SELECT schema FROM definition_versions WHERE definition_id=$1", [id])).rows;
    const paths = (value: FormSchema) => new Map(value.fields.flatMap(field => [[field.id, `${dataKind(field.type)}:root`], ...field.children.map(child => [child.id, `${dataKind(child.type)}:${field.id}`])] as [string, string][]));
    const next = paths(schema);
    for (const version of versions) for (const [key, type] of paths(version.schema)) if (next.has(key) && next.get(key) !== type) throw new BadRequestException("已发布字段不能变更类型或所属子表，请新建字段");
  }
  private async checkRelations(tx: Queryable, id: string, schema: FormSchema, managePage = false) {
    const relations = (await tx.query(`SELECT v.spec FROM relation_definitions d JOIN relation_versions v ON v.relation_id=d.id AND v.version=d.latest_version
      WHERE d.source_definition_id=$1 OR d.target_definition_id=$1`, [id])).rows;
    const available = new Set(allFields(schema).map(f => f.id));
    for (const relation of relations)
      if ([...referencedRelationFields(relation.spec, id)].some(fieldId => !available.has(fieldId)))
        throw new ConflictException(`字段仍被已发布关系「${relation.spec.title}」引用，请先调整并发布关系配置`);
    const pages = (await tx.query("SELECT p.title,v.schema FROM pages p JOIN page_versions v ON v.page_id=p.id AND v.version=p.latest_version WHERE p.definition_id=$1 AND p.archived_at IS NULL AND (NOT $2::boolean OR NOT p.managed)", [id, managePage])).rows;
    for (const page of pages) if ([...pageBindings(page.schema)].some(fieldId => !available.has(fieldId))) throw new ConflictException(`字段仍被页面「${page.title}」使用，请先调整并发布页面`);
  }
  async published(actor: Actor, id: string) {
    return this.db.transaction(async (tx) => {
      const def = await this.definition(tx, actor, id, "FOR SHARE");
      const row = (
        await tx.query(
          "SELECT * FROM definition_versions WHERE definition_id=$1 AND version=$2",
          [id, def.latest_version],
        )
      ).rows[0];
      if (!row) throw new NotFoundException("表单尚未发布");
      const access = await this.access(tx, actor, id, row.schema, { operation: "create" });
      const fields = row.schema.fields
        .filter((f: FormField) => permission(access, f) !== "hidden")
        .map((f: FormField) => ({
          ...f,
          children: f.children.filter(
            (c) => permission(access, c, f) !== "hidden",
          ),
        }));
      const defaults = await this.recordDefaults(tx, actor, row.schema);
      const defaultValues = Object.fromEntries(fields.map((field: FormField) => [field.id, defaults[field.id]]));
      return {
        defaultValues, identities: await this.identityLabels(tx, actor, { ...row.schema, fields }, defaultValues),
        ...(access.create ? { collection: await this.collection.statusIn(tx, actor, id) } : {}),
        definition: {
          ...definitionDto(row),
          schema: { ...row.schema, fields },
        },
        access,
      };
    });
  }
  async grants(actor: Actor, id: string) {
    requireAdmin(actor);
    await this.definition(this.db, actor, id);
    return (
      await this.db.query("SELECT policy FROM grants WHERE definition_id=$1", [
        id,
      ])
    ).rows.map((r) => r.policy);
  }
  async subjectGrants(actor: Actor, id: string) {
    requireAdmin(actor); await this.definition(this.db, actor, id);
    return (await this.db.query("SELECT * FROM subject_grants WHERE definition_id=$1 ORDER BY subject_kind,subject_id", [id])).rows.map(row => ({ subject: { kind: row.subject_kind, id: row.subject_id, ...(row.subject_kind === "department" ? { includeChildren: row.include_children } : {}) }, policy: row.policy, revision: row.revision }));
  }
  async grant(actor: Actor, id: string, body: unknown, subjectMode = false) {
    requireAdmin(actor);
    object(body);
    const subject = subjectMode ? parseSubject(body.subject) : undefined;
    if (!subject) uuid(body.userId);
    object(body.fields);
    if (body.relations !== undefined) object(body.relations);
    if (body.remove !== undefined && typeof body.remove !== "boolean") throw new BadRequestException("归档权限不合法");
    if (body.departmentBasis !== undefined && !["creator-current", "record-created"].includes(body.departmentBasis)) throw new BadRequestException("部门范围依据不合法");
    if (
      ![body.read, body.create, body.edit].every(
        (v) => typeof v === "boolean",
      ) ||
      !["all", "self", "department"].includes(body.scope) ||
      (!body.read && (body.create || body.edit))
    )
      throw new BadRequestException("授权配置不合法");
    return this.db.transaction(async (tx) => {
      await this.definition(tx, actor, id, "FOR UPDATE");
      if ((await tx.query("SELECT 1 FROM record_permission_groups WHERE definition_id=$1 AND config->>'mode'='groups'", [id])).rowCount) throw new ConflictException('此数据对象按权限组授权，请在权限组中修改');
      if (subject) requireSubject((await this.organizations.snapshot(tx, actor)).spec, subject);
      const user = subject || (
        await tx.query(
          "SELECT id FROM users WHERE id=$1 AND workspace_id=$2 AND active",
          [body.userId, actor.workspaceId],
        )
      ).rows[0];
      if (!user) throw new BadRequestException("成员不存在");
      const versions = (
        await tx.query(
          "SELECT schema FROM definition_versions WHERE definition_id=$1",
          [id],
        )
      ).rows;
      const ids = new Set(
        versions.flatMap((r) => allFields(r.schema).map((f) => f.id)),
      );
      for (const [key, value] of Object.entries(body.fields))
        if (
          !ids.has(key) ||
          !["hidden", "read", "edit"].includes(String(value))
        )
          throw new BadRequestException("字段授权不合法");
      const relationIds = new Set((await tx.query("SELECT id FROM relation_definitions WHERE source_definition_id=$1 OR target_definition_id=$1", [id])).rows.map(row => row.id));
      for (const [key, value] of Object.entries(body.relations || {}))
        if (!relationIds.has(key) || !["hidden", "read", "edit"].includes(String(value))) throw new BadRequestException("关系授权不合法");
      const policy: AccessPolicy = {
        read: body.read,
        create: body.create,
        edit: body.edit,
        scope: body.scope,
        ...(body.departmentBasis ? { departmentBasis: body.departmentBasis } : {}),
        fields: body.fields,
        relations: body.relations || {},
        remove: body.remove === true,
      };
      if (subject) {
        const old = (await tx.query("SELECT revision FROM subject_grants WHERE definition_id=$1 AND subject_kind=$2 AND subject_id=$3", [id, subject.kind, subject.id])).rows[0];
        if (body.expectedRevision !== (old?.revision || 0)) throw new ConflictException("部门或角色权限已被修改，请重新读取后合并");
        const revision = (old?.revision || 0) + 1;
        await tx.query("INSERT INTO subject_grants(definition_id,subject_kind,subject_id,include_children,policy,revision) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(definition_id,subject_kind,subject_id) DO UPDATE SET include_children=$4,policy=$5,revision=$6", [id, subject.kind, subject.id, !!subject.includeChildren, policy, revision]);
        return { subject, policy, revision } satisfies SubjectGrant;
      }
      const direct: AccessGrant = { ...policy, userId: body.userId };
      await tx.query("INSERT INTO grants VALUES($1,$2,$3) ON CONFLICT(definition_id,user_id) DO UPDATE SET policy=EXCLUDED.policy", [id, body.userId, direct]);
      return direct;
    });
  }
  async loadRecord(tx: Queryable, actor: Actor, id: string, lock = false, operation?: "export" | "print") {
    uuid(id);
    const row = (
      await tx.query(
        `SELECT * FROM records WHERE id=$1 AND workspace_id=$2 AND archived_at IS NULL ${lock ? "FOR UPDATE" : ""}`,
        [id, actor.workspaceId],
      )
    ).rows[0];
    if (!row) throw new NotFoundException("记录不存在或不可访问");
    if (row.state === "draft" && operation) throw new ForbiddenException("尚未提交的草稿不能导出或打印");
    if (row.state === "draft" && actor.role !== "admin" && row.created_by !== actor.id) throw new ForbiddenException("不能查看其他成员尚未提交的草稿");
    const version = (
      await tx.query(
        "SELECT * FROM definition_versions WHERE definition_id=$1 AND version=$2",
        [row.definition_id, row.definition_version],
      )
    ).rows[0];
    const access = await this.access(
      tx,
      actor,
      row.definition_id,
      version.schema,
      { createdBy: row.created_by, createdDepartmentIds: row.created_department_ids, values: row.values, ...(operation ? { operation } : {}), ...(row.state === "draft" ? { operation: "create" as const } : {}) },
    );
    return { row, version, access: row.state === "draft" ? { ...access, edit: access.create } : access };
  }
  async detail(actor: Actor, id: string): Promise<RecordDetail> {
    return this.db.transaction(async (tx) => this.detailIn(tx, actor, id));
  }
  async detailIn(
    tx: Queryable,
    actor: Actor,
    id: string,
    page?: RecordPageScope,
    operation?: "export" | "print",
  ): Promise<RecordDetail> {
    const { row, version, access: sourceAccess } = await this.loadRecord(tx, actor, id, false, operation);
    const access = pageAccess(page, row.definition_id, row.definition_version, sourceAccess, version.schema);
    const visible = masked(
      page?.schema || version.schema,
      row.values,
      row.cell_revisions,
      access,
    );
    return {
      ...(page ? { page: { id: page.id, version: page.version, title: page.title } } : {}),
      ...(actor.role === "admin" && (await tx.query("SELECT 1 FROM record_origins WHERE record_id=$1 AND workspace_id=$2", [id, actor.workspaceId])).rowCount ? { canReadOrigin: true } : {}),
      creator: await recordCreator(tx, actor, row.created_by),
      identities: await this.identityLabels(tx, actor, visible.schema, visible.values),
      definition: { ...definitionDto(version), schema: visible.schema },
      access,
      rowActions: rowActions(version.schema, access),
      ...(row.state === 'draft' && access.create ? { collection: await this.collection.statusIn(tx, actor, row.definition_id, row.created_by) } : {}),
      record: {
        ...recordDto(row),
        values: visible.values,
        cellRevisions: visible.cells,
        rowRevisions: visible.rows,
      },
    };
  }
  async output(actor: Actor, id: string, action: string) {
    if (action !== 'export' && action !== 'print') throw new BadRequestException('输出操作不合法');
    return this.db.transaction(tx => this.detailIn(tx, actor, id, undefined, action));
  }
  private commandScope(actor: Actor, definitionId: string) {
    const selection = actor.accessGroups?.[definitionId];
    return selection ? { accessGroup: selection } : {};
  }
  private async writeDetailIn(tx: Transaction, actor: Actor, id: string, page?: RecordPageScope, allowReceipt = true): Promise<RecordDetail> {
    // Only invoked after executing this actor's command or finding its prior committed result.
    // Retried commands never repeat the write or reuse a cached permission mask.
    const meta = (await tx.query("SELECT definition_id FROM records WHERE id=$1 AND workspace_id=$2 AND archived_at IS NULL", [id, actor.workspaceId])).rows[0];
    if (!meta) throw new NotFoundException("记录不存在或不可访问");
    await this.definition(tx, actor, meta.definition_id, "FOR SHARE");
    const row = (await tx.query("SELECT * FROM records WHERE id=$1 AND workspace_id=$2 AND archived_at IS NULL FOR SHARE", [id, actor.workspaceId])).rows[0];
    if (!row) throw new NotFoundException("记录不存在或不可访问");
    try { return await this.detailIn(tx, actor, id, page); }
    catch (cause) {
      if (!(cause instanceof ForbiddenException) || !allowReceipt) throw cause;
      const version = (await tx.query("SELECT * FROM definition_versions WHERE definition_id=$1 AND version=$2", [row.definition_id, row.definition_version])).rows[0];
      return {
        accessLost: true,
        ...(page ? { page: { id: page.id, title: page.title, version: page.version } } : {}),
        definition: { ...definitionDto(version), schema: { version: 1, fields: [], settings: { description: '', layout: 1, labelPosition: 'top', labelWidth: 100, cacheDraft: false, hiddenValues: 'retain', submitLabel: '保存', allowDraft: false, successMessage: '', successMode: 'inline', allowAnotherSubmission: false, rules: [] } } },
        record: { ...recordDto(row), values: {}, cellRevisions: {}, rowRevisions: {} },
        access: { userId: actor.id, read: false, create: false, edit: false, remove: false, scope: 'all', fields: {}, relations: {} },
        rowActions: {},
      };
    }
  }
  async records(actor: Actor, id: string, state = "active") {
    if (!["active", "draft"].includes(state)) throw new BadRequestException("请选择正式记录或草稿");
    return this.db.transaction(async (tx) => {
      const def = await this.definition(tx, actor, id, "FOR SHARE");
      const scope = state === "draft" ? await this.authorization.draftReaders(tx, actor, id) : await this.readableScope(tx, actor, id);
      // Filter before LIMIT so disallowed rows cannot hide accessible records or disclose metadata.
      const parameters: unknown[] = [id, actor.workspaceId, scope.creators, state, actor.role === "admin", actor.id, scope.createdDepartments];
      const groupScope = scope.sql?.('r', parameters) || 'true';
      return (await tx.query(`SELECT id,definition_version AS "definitionVersion",revision,state,created_at AS "createdAt",updated_at AS "updatedAt" FROM records r WHERE definition_id=$1 AND workspace_id=$2 AND archived_at IS NULL AND state=$4 AND ($3::uuid[] IS NULL OR created_by=ANY($3) OR created_department_ids && $7::uuid[]) AND (state<>'draft' OR $5::boolean OR created_by=$6) AND (${groupScope}) ORDER BY created_at DESC LIMIT 100`, parameters)).rows;
    });
  }
  async createRecord(actor: Actor, id: string, body: unknown, page?: RecordPageScope, transaction?: Transaction) {
    object(body);
    if (body.state !== undefined && !["active", "draft"].includes(body.state)) throw new BadRequestException("记录状态不合法");
    const draft = body.state === "draft";
    if (!Number.isInteger(body.version) || body.version < 1)
      throw new BadRequestException("需要发布版本");
    const write = async (tx: Transaction) => {
      const recordId = await once(
        tx,
        actor,
        body.requestId,
        { create: id, ...this.commandScope(actor, id), version: body.version, values: body.values, ...(draft ? { state: "draft" } : {}), ...(page ? { page: { id: page.id, version: page.version } } : {}) },
        async () => {
          await this.definition(tx, actor, id, "FOR SHARE");
          if (page && !page.taskId) await assertPageActive(tx, actor, page.id);
          const version = (
            await tx.query(
              "SELECT * FROM definition_versions WHERE definition_id=$1 AND version=$2",
              [id, body.version],
            )
          ).rows[0];
          if (!version) throw new BadRequestException("发布版本不存在");
          const access = pageAccess(page, id, version.version, await this.access(tx, actor, id, version.schema, { operation: "create" }));
          if (!access.create) throw new ForbiddenException("没有新增权限");
          const { values, revisions } = await this.createValues(
            tx, actor, draft ? draftSchema(version.schema) : version.schema,
            body.values,
            access,
          );
          await this.validateRecordOrganizations(tx, actor, version.schema, values);
          if (!draft) {
            validatePageSubmission(page, values, access);
            await this.collection.requireSubmission(tx, actor, id);
          }
          const rid = randomUUID();
          const createdDepartments = (await this.organizations.snapshot(tx, actor)).spec.assignments.find(item => item.userId === actor.id)?.departmentIds || [];
          await tx.query(
            "INSERT INTO records(id,workspace_id,definition_id,definition_version,values,cell_revisions,created_by,state,created_department_ids) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
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
            "INSERT INTO record_events(id,record_id,actor_id,revision,changes) VALUES($1,$2,$3,1,$4)",
            [randomUUID(), rid, actor.id, { action: draft ? "draft-create" : "create" }],
          );
          return rid;
        },
      );
      return this.writeDetailIn(tx, actor, recordId, page);
    };
    return transaction ? write(transaction) : this.db.transaction(write);
  }
  async submitRecord(actor: Actor, id: string, body: unknown, page?: RecordPageScope, transaction?: Transaction) {
    uuid(id); object(body);
    if ((body.changes !== undefined && !Array.isArray(body.changes)) || (body.rows !== undefined && !Array.isArray(body.rows))) throw new BadRequestException("草稿修改格式不合法");
    const write = async (tx: Transaction) => {
      const meta = (await tx.query("SELECT definition_id FROM records WHERE id=$1 AND workspace_id=$2", [id, actor.workspaceId])).rows[0];
      if (!meta) throw new NotFoundException("记录不存在或不可访问");
      const recordId = await once(tx, actor, body.requestId, { submit: id, ...this.commandScope(actor, meta.definition_id), body, ...(page ? { pageId: page.id, pageVersion: page.version } : {}) }, async () => {
        await this.definition(tx, actor, meta.definition_id, "FOR SHARE");
        if (page) await assertPageActive(tx, actor, page.id);
        const source = await this.loadRecord(tx, actor, id, true);
        if (source.row.state !== "draft") throw new ConflictException("此记录已提交，请重新读取当前记录");
        if (source.row.revision !== body.expectedRevision) throw new ConflictException("草稿已被修改，请重新读取后再提交；当前输入保留");
        const access = pageAccess(page, source.row.definition_id, source.row.definition_version, source.access, source.version.schema);
        if (!access.create) throw new ForbiddenException("当前没有提交此草稿的权限");
        if ((body.changes?.length || 0) + (body.rows?.length || 0)) await this.patchRecord(actor, id, { requestId: randomUUID(), changes: body.changes || [], rows: body.rows || [] }, page, tx);
        const current = await this.loadRecord(tx, actor, id);
        validateSubmittedRecord(current.version.schema, current.row.values);
        await this.validateRecordOrganizations(tx, actor, current.version.schema, current.row.values, current.row.values);
        validatePageSubmission(page, current.row.values, access);
        await this.collection.requireSubmission(tx, actor, source.row.definition_id, source.row.created_by);
        await tx.query("UPDATE records SET state='active',revision=revision+1,updated_at=now() WHERE id=$1", [id]);
        await tx.query("INSERT INTO record_events(id,record_id,actor_id,revision,changes) VALUES($1,$2,$3,$4,$5)", [randomUUID(), id, actor.id, current.row.revision + 1, { action: "submit-draft" }]);
        return id;
      });
      return this.writeDetailIn(tx, actor, recordId, page);
    };
    return transaction ? write(transaction) : this.db.transaction(write);
  }
  async patchRecord(actor: Actor, id: string, body: unknown, page?: RecordPageScope, transaction?: Transaction, guard?: () => void) {
    uuid(id);
    object(body);
    if (body.changes === undefined) body.changes = [];
    if (body.rows === undefined) body.rows = [];
    if (!Array.isArray(body.changes) || !Array.isArray(body.rows) || !(body.changes.length + body.rows.length) || body.changes.length > 200 || body.rows.length > 100)
      throw new BadRequestException("需要字段或明细修改，单次最多 200 个字段、100 个明细动作");
    const write = async (tx: Transaction) => {
      const meta = (await tx.query("SELECT definition_id FROM records WHERE id=$1 AND workspace_id=$2", [id, actor.workspaceId])).rows[0];
      if (!meta) throw new NotFoundException("记录不存在或不可访问");
      return once(
        tx,
        actor,
        body.requestId,
        { patch: id, ...this.commandScope(actor, meta.definition_id), changes: body.changes, ...(body.rows.length ? { rows: body.rows } : {}), ...(page ? { page: { id: page.id, version: page.version, taskId: page.taskId, row: page.row } } : {}) },
        async () => {
          guard?.();
          // Every writer locks definition before record; policy changes take the exclusive definition lock.
          await this.definition(tx, actor, meta.definition_id, "FOR SHARE");
          if (page && !page.taskId) await assertPageActive(tx, actor, page.id);
          const { row, version, access: recordAccess } = await this.loadRecord(
            tx,
            actor,
            id,
            true,
          );
          const access = pageAccess(page, row.definition_id, row.definition_version, recordAccess, version.schema);
          if (!access.edit) throw new ForbiddenException("没有修改权限");
          const schema = row.state === "draft" ? draftSchema(version.schema) : version.schema as FormSchema,
            keys = new Set<string>();
          const beforeValues = structuredClone(row.values);
          const changed: Record<string, unknown>[] = [];
          body.changes.forEach(object);
          if (page?.row && (body.rows.length || body.changes.some((change: any) => change.subformId !== page.row!.subformId || change.rowId !== page.row!.rowId))) throw new ForbiddenException("此任务仅允许修改所绑定的明细行");
          await this.patchRows(tx, actor, row, schema, access, body.rows, changed);
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
            )
              throw new ForbiddenException("字段不存在或没有修改权限");
            const target = parent
              ? (row.values[parent.id] as FormValues[]).find(
                  (r) => r._rowId === change.rowId,
                )
              : row.values;
            if (!target)
              throw new BadRequestException("明细行不存在，请重新读取");
            const key = cellKey(change);
            if (
              keys.has(key) ||
              !Number.isInteger(change.expectedRevision) ||
              change.expectedRevision < 1
            )
              throw new BadRequestException("字段修改版本无效或重复");
            keys.add(key);
            if (row.cell_revisions[key] !== change.expectedRevision)
              throw new ConflictException(
                "该字段已被其他成员修改，输入已保留，请重新读取后合并",
              );
            const value = scalar(field, change.value);
            changed.push({ ...change, before: target[field.id], value });
            target[field.id] = value;
            row.cell_revisions[key]++;
          }
          await this.validateRecordOrganizations(tx, actor, schema, row.values, beforeValues);
          if (row.state !== "draft") validatePageSubmission(page, row.values, access);
          await tx.query(
            "UPDATE records SET values=$2,cell_revisions=$3,revision=revision+1,updated_at=now() WHERE id=$1",
            [id, row.values, row.cell_revisions],
          );
          await tx.query(
            "INSERT INTO record_events(id,record_id,actor_id,revision,changes) VALUES($1,$2,$3,$4,$5)",
            [
              randomUUID(),
              id,
              actor.id,
              row.revision + 1,
              JSON.stringify(changed),
            ],
          );
          return id;
        },
      );
    };
    const result = async (tx: Transaction) => this.writeDetailIn(tx, actor, await write(tx), page, !page?.taskId);
    return transaction ? result(transaction) : this.db.transaction(result);
  }
  private async patchRows(tx: Transaction, actor: Actor, record: any, schema: FormSchema, access: AccessGrant, commands: unknown[], audit: Record<string, unknown>[]) {
    const touched = new Set<string>(), removed = new Set<string>();
    for (const raw of commands) {
      object(raw);
      const parent = schema.fields.find(f => f.id === raw.subformId && f.type === "subform");
      if (!parent || permission(access, parent) !== "edit") throw new ForbiddenException("没有此明细的结构修改权限");
      const key = `@rows/${parent.id}`;
      if (!Number.isInteger(raw.expectedRevision) || raw.expectedRevision !== (record.cell_revisions[key] || 1)) throw new ConflictException("明细行结构已变更，请读取最新记录后重试");
      const rows = record.values[parent.id] as FormValues[];
      if (raw.action === "add") {
        const created = await this.createValues(tx, actor, { ...schema, fields: [parent] }, { [parent.id]: [raw.values] }, access, record.values, schema);
        const value = (created.values[parent.id] as FormValues[])[0]!;
        rows.push(value);
        for (const [cell, revision] of Object.entries(created.revisions)) if (cell !== key) record.cell_revisions[cell] = revision;
        audit.push({ action: "row-add", subformId: parent.id, rowId: value._rowId, values: value });
      } else if (raw.action === "remove") {
        uuid(raw.rowId); object(raw.expectedCells);
        if (parent.children.some(child => permission(access, child, parent) !== "edit")) throw new ForbiddenException("删除明细需要能够修改该行所有列");
        const index = rows.findIndex(r => r._rowId === raw.rowId);
        if (index < 0 || removed.has(raw.rowId)) throw new ConflictException("明细行已不存在或重复删除");
        for (const child of parent.children) {
          const cell = cellKey({ subformId: parent.id, rowId: raw.rowId, fieldId: child.id });
          if (raw.expectedCells[cell] !== record.cell_revisions[cell]) throw new ConflictException("明细内容已被其他成员修改，不能删除旧快照");
        }
        const references = (await tx.query(`SELECT
          EXISTS(SELECT 1 FROM record_links WHERE source_record_id=$1 AND source_row_id=$2) OR
          EXISTS(SELECT 1 FROM tasks WHERE record_id=$1 AND row_id=$2) AS referenced`, [record.id, raw.rowId])).rows[0];
        if (references.referenced) throw new ConflictException("明细行已被关系或任务引用，请先处理引用影响");
        audit.push({ action: "row-remove", subformId: parent.id, rowId: raw.rowId, definitionVersion: record.definition_version, before: rows[index] });
        rows.splice(index, 1); removed.add(raw.rowId);
        for (const child of parent.children) delete record.cell_revisions[cellKey({ subformId: parent.id, rowId: raw.rowId, fieldId: child.id })];
      } else if (raw.action === "restore") {
        uuid(raw.rowId); uuid(raw.eventId);
        if (parent.children.some(child => permission(access, child, parent) !== "edit")) throw new ForbiddenException("恢复明细需要能够修改该行所有列");
        if (rows.some(row => row._rowId === raw.rowId)) throw new ConflictException("此明细行已存在，请刷新查看");
        const deleted = (await latestRowEvents(tx, record.id)).find(event => event.change.subformId === parent.id && event.change.rowId === raw.rowId);
        if (!deleted || deleted.id !== raw.eventId || deleted.change.action !== "row-remove") throw new ConflictException("删除记录已变化，请选择最近一次删除的明细");
        const { _rowId, ...before } = deleted.change.before;
        const restored = await this.createValues(tx, actor, { ...schema, fields: [parent] }, { [parent.id]: [before] }, access, record.values, schema);
        const value = (restored.values[parent.id] as FormValues[])[0]!; value._rowId = raw.rowId;
        rows.push(value);
        // Cell versions must never become equal to an old pre-deletion edit snapshot.
        for (const child of parent.children) record.cell_revisions[cellKey({ subformId: parent.id, rowId: raw.rowId, fieldId: child.id })] = record.revision + 1;
        audit.push({ action: "row-restore", subformId: parent.id, rowId: raw.rowId, sourceEventId: deleted.id });
      } else throw new BadRequestException("明细动作不合法");
      touched.add(parent.id);
    }
    for (const id of touched) {
      const parent = schema.fields.find(f => f.id === id)!;
      if (record.values[id].length > maxSubformRows || (parent.required && !record.values[id].length)) throw new BadRequestException("明细数量不符合要求");
      record.cell_revisions[`@rows/${id}`] = (record.cell_revisions[`@rows/${id}`] || 1) + 1;
    }
  }
  async archiveRecord(actor: Actor, id: string, body: unknown) {
    uuid(id); object(body);
    const recordId = await this.db.transaction(tx => once(tx, actor, body.requestId, { archive: id, expectedRevision: body.expectedRevision }, async () => {
      const meta = (await tx.query("SELECT definition_id FROM records WHERE id=$1 AND workspace_id=$2", [id, actor.workspaceId])).rows[0];
      if (!meta) throw new NotFoundException("记录不存在");
      await this.definition(tx, actor, meta.definition_id, "FOR SHARE");
      const record = await this.loadRecord(tx, actor, id, true);
      if (!record.access.remove) throw new ForbiddenException("没有归档权限");
      if (record.row.revision !== body.expectedRevision) throw new ConflictException("记录已被修改，请刷新后再归档");
      const dependency = (await tx.query("SELECT EXISTS(SELECT 1 FROM record_links WHERE source_record_id=$1 OR target_record_id=$1) OR EXISTS(SELECT 1 FROM tasks WHERE record_id=$1) OR EXISTS(SELECT 1 FROM processes p CROSS JOIN LATERAL jsonb_each_text(p.bindings) b WHERE b.value=$1::text) AS referenced", [id])).rows[0];
      if (dependency.referenced) throw new ConflictException("记录已被关系或任务引用，不能归档");
      await tx.query("UPDATE records SET archived_at=now(),updated_at=now(),revision=revision+1 WHERE id=$1", [id]);
      await tx.query("INSERT INTO record_events(id,record_id,actor_id,revision,changes) VALUES($1,$2,$3,$4,$5)", [randomUUID(), id, actor.id, record.row.revision + 1, { action: "archive" }]);
      return id;
    }));
    return { id: recordId, archived: true };
  }
  async removedRows(actor: Actor, id: string, page?: RecordPageScope) {
    return this.db.transaction(async tx => {
      const record = await this.loadRecord(tx, actor, id);
      const access = pageAccess(page, record.row.definition_id, record.row.definition_version, record.access, record.version.schema);
      const allowed = rowActions(record.version.schema, access);
      return Promise.all((await latestRowEvents(tx, id)).filter(event => event.change.action === "row-remove" && allowed[event.change.subformId]?.remove && !(record.row.values[event.change.subformId] || []).some((row: FormValues) => row._rowId === event.change.rowId)).map(async event => {
        const parent = (record.version.schema as FormSchema).fields.find(field => field.id === event.change.subformId)!;
        const { _rowId, ...before } = event.change.before;
        let restorable = true, reason: string | undefined;
        try {
          const restoreSchema = record.row.state === "draft" ? draftSchema(record.version.schema) : record.version.schema;
          const restored = await this.createValues(tx, actor, { ...restoreSchema, fields: [restoreSchema.fields.find((field: FormField) => field.id === parent.id)!] }, { [parent.id]: [before] }, access, record.row.values, record.version.schema);
          await this.validateRecordOrganizations(tx, actor, record.version.schema, { ...record.row.values, [parent.id]: [...record.row.values[parent.id], ...(restored.values[parent.id] as FormValues[])] }, record.row.values);
        }
        catch (cause) { restorable = false; reason = (cause as Error).message; }
        return { eventId: event.id, subformId: parent.id, rowId: event.change.rowId, values: Object.fromEntries(parent.children.map(child => [child.id, before[child.id]])), removedAt: new Date(event.created_at).toISOString(), restorable, reason };
      }));
    });
  }
  async events(actor: Actor, id: string) {
    requireAdmin(actor);
    await this.loadRecord(this.db, actor, id);
    return (
      await this.db.query(
        'SELECT actor_id AS "actorId",revision,changes,created_at AS "createdAt" FROM record_events WHERE record_id=$1 ORDER BY revision',
        [id],
      )
    ).rows;
  }
}
