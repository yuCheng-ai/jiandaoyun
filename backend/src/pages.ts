import { RecordViewService } from "./record-views";
import { parseFieldTrash } from './field-recycle';
import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { composeFormSchema, dataFields, dataModelChanges, modelFormSchema, pageForModel, type DataFieldAddition, type DataModel, type DataObjectDraft, type PageDraft, type PageEditorData, type PendingPageFields, type PublishedPage } from "@platform/contracts";
import { Actor, requireAdmin } from "./auth";
import { Database, Transaction } from "./database";
import { definitionDto, PlatformService } from "./platform";
import { masked, object, rowActions, title, uuid } from "./schema";
import { pageAccess, pageAcceptsVersion, type RecordPageScope } from "./page-runtime";
import { RecordEvolutionService } from "./record-evolution";
import { modelWithAdditions, pageBindings, parseModel, parsePage } from "./page-schema";
import { storeModelVersion } from "./data-projection";
import { applicationId } from "./applications";
import { once } from "./commands";
import { pagePublishImpact } from "./page-impact";
import { assertPageActive, pageLifecycleImpact } from "./page-lifecycle";
import { dataModelImpact } from "./model-impact";
import { OrganizationService } from "./organization";

const draftDto = (row: any): PageDraft => ({ id: row.id, applicationId: row.application_id, title: row.title, definitionId: row.definition_id, definitionVersion: row.definition_version, revision: row.revision, latestVersion: row.latest_version, archivedAt: row.archived_at ? new Date(row.archived_at).toISOString() : null, schema: row.draft, additions: row.additions, baseDefinitionRevision: row.base_definition_revision, formModel: row.form_model || null, fieldTrash: row.field_trash || [] });
const publishedDto = (row: any): PublishedPage => ({ id: row.page_id, title: row.title, version: row.version, definitionId: row.definition_id, definitionVersion: row.definition_version, schema: row.schema });
@Injectable()
export class PageService {
  constructor(private readonly db: Database, private readonly platform: PlatformService, private readonly evolution: RecordEvolutionService, private readonly organizations: OrganizationService, private readonly recordViews: RecordViewService) {}
  async objectDraft(actor: Actor, id: string): Promise<DataObjectDraft> {
    requireAdmin(actor);
    const row = await this.platform.definition(this.db, actor, id);
    return this.objectDto(this.db, row);
  }
  private async objectDto(tx: Pick<Database, "query">, row: any): Promise<DataObjectDraft> {
    const published = (await tx.query("SELECT v.title,m.model FROM definition_versions v JOIN data_object_versions m USING(definition_id,version) WHERE v.definition_id=$1 AND v.version=$2", [row.id, row.latest_version])).rows[0];
    return { id: row.id, applicationId: row.application_id, title: row.title, revision: row.revision, latestVersion: row.latest_version, model: row.model_draft, hasDraftChanges: !published || published.title !== row.title || JSON.stringify(published.model) !== JSON.stringify(row.model_draft) };
  }
  async publishedModel(actor: Actor, id: string, version: number) { requireAdmin(actor); return this.model(this.db, actor, id, version); }
  async latestModel(actor: Actor, id: string) {
    requireAdmin(actor);
    return this.db.transaction(async tx => {
      const row = await this.platform.definition(tx, actor, id, "FOR SHARE");
      return { object: await this.objectDto(tx, row), model: await this.model(tx, actor, id, row.latest_version) };
    });
  }
  async pendingFields(actor: Actor, id: string): Promise<PendingPageFields> {
    requireAdmin(actor);
    return this.db.transaction(async tx => {
      // Page saves and model publication take the same definition lock exclusively.
      const definition = await this.platform.definition(tx, actor, id, "FOR SHARE");
      const object = await this.objectDto(tx, definition);
      const published = await this.model(tx, actor, id, definition.latest_version);
      const rows = (await tx.query(`SELECT p.id,p.title,p.revision,p.definition_version,p.base_definition_revision,p.additions,p.archived_at,p.initial_model,m.model
        FROM pages p LEFT JOIN data_object_versions m ON m.definition_id=p.definition_id AND m.version=p.definition_version
        WHERE p.definition_id=$1 AND p.workspace_id=$2 AND jsonb_array_length(p.additions)>0 ORDER BY p.created_at,p.id`, [id, actor.workspaceId])).rows;
      const pages: PendingPageFields["pages"] = rows.map(row => {
        const base: DataModel = row.model || row.initial_model || { version: 1, fields: [] };
        const fields = (row.additions as DataFieldAddition[]).flatMap(addition => [
          { id: addition.field.id, name: addition.field.name, kind: addition.field.kind, parentId: addition.parentId, parentName: base.fields.find(field => field.id === addition.parentId)?.name },
          ...addition.field.children.map(child => ({ id: child.id, name: child.name, kind: child.kind, parentId: addition.field.id, parentName: addition.field.name })),
        ]);
        const warnings: string[] = [];
        if (row.archived_at) warnings.push("来源页面已归档，新字段草稿保留；恢复页面后才能继续编辑或发布。");
        if (row.definition_version !== definition.latest_version || row.base_definition_revision !== definition.revision) warnings.push("数据结构已变化，请回到来源页面检查并更新数据字段。");
        if (object.hasDraftChanges && definition.latest_version > 0) warnings.push("数据对象另有未发布修改，请先处理数据草稿。");
        for (const field of fields) if (dataFields(published).some(item => item.parentId === field.parentId && item.field.name.trim() === field.name.trim())) warnings.push(`「${field.name}」已存在于当前数据，请检查复用或更名。`);
        return { id: row.id, title: row.title, revision: row.revision, definitionVersion: row.definition_version, archivedAt: row.archived_at ? new Date(row.archived_at).toISOString() : null, fields, warnings };
      });
      for (const page of pages) for (const field of page.fields) {
        const others = pages.filter(other => other.id !== page.id && other.fields.some(item => item.parentId === field.parentId && item.name.trim() === field.name.trim()));
        if (others.length) page.warnings.push(`「${field.name}」也在 ${others.map(other => `「${other.title}」`).join("、")} 中待发布，请确认是否需要复用。`);
      }
      return { definitionId: id, pages };
    });
  }
  async saveObject(actor: Actor, body: unknown, id?: string) {
    requireAdmin(actor); object(body);
    const model = parseModel(body.model, true);
    const result = await this.platform.saveDefinition(actor, { title: body.title, schema: modelFormSchema(model), expectedRevision: body.expectedRevision, applicationId: body.applicationId }, id, false);
    return this.objectDraft(actor, result.id);
  }
  async publishObject(actor: Actor, id: string, body: unknown) {
    await this.platform.publish(actor, id, body, false);
    return this.objectDraft(actor, id);
  }
  async discardObjectDraft(actor: Actor, id: string, body: unknown): Promise<DataObjectDraft> {
    requireAdmin(actor); object(body);
    return this.db.transaction(async tx => {
      const row = await this.platform.definition(tx, actor, id, "FOR UPDATE");
      if (row.revision !== body.expectedRevision) throw new ConflictException("数据草稿已被修改，请重新读取后决定是否放弃");
      if (!row.latest_version) throw new BadRequestException("此数据对象尚未发布，没有可恢复的发布版本");
      const previous = (await tx.query("SELECT v.title,v.schema,m.model FROM definition_versions v JOIN data_object_versions m USING(definition_id,version) WHERE v.definition_id=$1 AND v.version=$2", [id, row.latest_version])).rows[0];
      await tx.query("UPDATE definitions SET title=$2,draft=$3,model_draft=$4,revision=revision+1 WHERE id=$1", [id, previous.title, previous.schema, previous.model]);
      await tx.query("INSERT INTO configuration_events(id,workspace_id,actor_id,resource_kind,resource_id,action,revision,detail) VALUES($1,$2,$3,'data_object',$4,'discard_draft',$5,$6)", [randomUUID(), actor.workspaceId, actor.id, id, row.revision + 1, { restoredVersion: row.latest_version }]);
      return { id, applicationId: row.application_id, title: previous.title, revision: row.revision + 1, latestVersion: row.latest_version, model: previous.model, hasDraftChanges: false };
    });
  }
  async model(tx: Pick<Database, "query">, actor: Actor, id: string, version: number): Promise<DataModel> {
    const definition = await this.platform.definition(tx, actor, id);
    if (version === 0 && definition.latest_version === 0) return definition.model_draft;
    if (!Number.isInteger(version) || version < 1) throw new BadRequestException("请选择已发布的数据版本");
    const row = (await tx.query("SELECT model FROM data_object_versions WHERE definition_id=$1 AND version=$2", [id, version])).rows[0];
    if (!row) throw new NotFoundException("数据版本不存在");
    return row.model;
  }
  async list(actor: Actor, definitionId?: string, appId?: string, state = "active") {
    if (!["active", "archived"].includes(state)) throw new BadRequestException("页面列表状态不合法");
    if (state === "archived") requireAdmin(actor);
    if (definitionId) uuid(definitionId);
    if (appId) await applicationId(this.db, actor, appId);
    return this.db.transaction(async tx => {
    const ids = await this.platform.accessibleDefinitions(tx, actor);
    const rows = (await tx.query(`SELECT p.*,d.application_id,v.title AS public_title,v.definition_version AS public_definition_version,
      ARRAY(SELECT pv.version FROM page_versions pv WHERE pv.page_id=p.id ORDER BY pv.version) AS versions FROM pages p
      JOIN definitions d ON d.id=p.definition_id
      LEFT JOIN page_versions v ON v.page_id=p.id AND v.version=p.latest_version
      WHERE p.workspace_id=$1 AND ($2::uuid IS NULL OR p.definition_id=$2) AND ($5::uuid IS NULL OR d.application_id=$5)
      AND ((p.archived_at IS NOT NULL)=$6) AND ($3='admin' OR (p.latest_version>0 AND p.definition_id=ANY($4::uuid[]))) ORDER BY p.created_at,p.id`, [actor.workspaceId, definitionId || null, actor.role, ids, appId || null, state === "archived"])).rows;
    if (actor.role !== "admin") for (const row of rows) { row.title = row.public_title; row.definition_version = row.public_definition_version; }
    return rows.map(row => { const { schema, additions, baseDefinitionRevision, formModel, fieldTrash, ...summary } = draftDto(row); return { ...summary, folder: row.folder, versions: row.versions }; });
    });
  }
  private async page(tx: Pick<Database, "query">, actor: Actor, id: string, lock = false) {
    uuid(id);
    const row = (await tx.query(`SELECT p.*,d.application_id FROM pages p JOIN definitions d ON d.id=p.definition_id WHERE p.id=$1 AND p.workspace_id=$2 ${lock ? "FOR UPDATE OF p" : ""}`, [id, actor.workspaceId])).rows[0];
    if (!row) throw new NotFoundException("页面不存在或不可访问");
    return row;
  }
  async draft(actor: Actor, id: string) { requireAdmin(actor); return draftDto(await this.page(this.db, actor, id)); }
  async editor(actor: Actor, id: string) {
    requireAdmin(actor);
    return this.db.transaction(async tx => {
      const meta = await this.page(tx, actor, id);
      const definition = await this.platform.definition(tx, actor, meta.definition_id, "FOR SHARE");
      const page = await this.page(tx, actor, id);
      return this.editorData(tx, actor, definition, page);
    });
  }
  private async editorData(tx: Transaction, actor: Actor, definition: any, page: any): Promise<PageEditorData> {
    return { draft: draftDto(page), object: await this.objectDto(tx, definition), model: await this.pageModel(tx, actor, page), canEditFields: await this.canEditFields(tx, actor, page) };
  }
  private async canEditFields(tx: Transaction, actor: Actor, page: any) {
    // Legacy pages may share a model or deliberately omit fields. Never take ownership
    // of those fields just because the old modelling UI is no longer a product entry.
    const sibling = (await tx.query("SELECT 1 FROM pages WHERE definition_id=$1 AND id<>$2 LIMIT 1", [page.definition_id, page.id])).rowCount;
    if (sibling) return false;
    const model = page.form_model || await this.pageModel(tx, actor, page), bindings = pageBindings(page.draft);
    return dataFields(model).every(item => bindings.has(item.field.id));
  }
  private async pageModel(tx: Pick<Database, "query">, actor: Actor, page: any): Promise<DataModel> {
    if (page.definition_version !== 0) return this.model(tx, actor, page.definition_id, page.definition_version);
    if (!page.initial_model) throw new ConflictException("页面初始数据基线缺失，原草稿仍保留；需要恢复原始数据结构后继续编辑");
    return page.initial_model;
  }
  async discardDraft(actor: Actor, id: string, body: unknown): Promise<PageEditorData> {
    requireAdmin(actor); object(body);
    return this.db.transaction(async tx => {
      const meta = await this.page(tx, actor, id);
      const definition = await this.platform.definition(tx, actor, meta.definition_id, "FOR UPDATE");
      const page = await this.page(tx, actor, id, true);
      await assertPageActive(tx, actor, id);
      if (page.revision !== body.expectedRevision) throw new ConflictException("页面草稿已被修改，请重新读取后决定是否放弃；当前输入已保留");
      if (!page.latest_version) throw new BadRequestException("此页面尚未发布，没有可恢复的发布版本");
      const previous = (await tx.query("SELECT * FROM page_versions WHERE page_id=$1 AND version=$2", [id, page.latest_version])).rows[0];
      await tx.query("UPDATE pages SET title=$2,draft=$3,definition_version=$4,additions='[]',form_model=NULL,base_definition_revision=NULL,managed=false,revision=revision+1 WHERE id=$1", [id, previous.title, previous.schema, previous.definition_version]);
      const restoredIds = pageBindings(previous.schema);
      const fieldTrash = (page.field_trash || []).filter((item: any) => ![item.field.id, ...item.field.children.map((field: any) => field.id)].some((id: string) => restoredIds.has(id)));
      await tx.query("UPDATE pages SET field_trash=$2 WHERE id=$1", [id, JSON.stringify(fieldTrash)]);
      await tx.query("INSERT INTO configuration_events(id,workspace_id,actor_id,resource_kind,resource_id,action,revision,detail) VALUES($1,$2,$3,'page',$4,'discard_draft',$5,$6)", [randomUUID(), actor.workspaceId, actor.id, id, page.revision + 1, { restoredVersion: page.latest_version, cancelledFieldIds: (page.additions as DataFieldAddition[]).flatMap(addition => [addition.field.id, ...addition.field.children.map(field => field.id)]) }]);
      return this.editorData(tx, actor, definition, await this.page(tx, actor, id));
    });
  }
  async lifecyclePreview(actor: Actor, id: string, body: unknown) {
    requireAdmin(actor); object(body);
    if (body.action !== "archive" && body.action !== "restore") throw new BadRequestException("请选择归档或恢复");
    return this.db.transaction(async tx => {
      const meta = await this.page(tx, actor, id), definition = await this.platform.definition(tx, actor, meta.definition_id, "FOR UPDATE");
      const page = await this.page(tx, actor, id);
      if (page.revision !== body.expectedRevision) throw new ConflictException("页面已变化，请刷新列表后重新检查");
      if (!!page.archived_at !== (body.action === "restore")) throw new ConflictException("页面状态已变化，请刷新列表");
      return pageLifecycleImpact(tx, definition, page, body.action);
    });
  }
  async lifecycle(actor: Actor, id: string, body: unknown, action: "archive" | "restore") {
    requireAdmin(actor); object(body);
    return this.db.transaction(async tx => {
      const meta = await this.page(tx, actor, id), definition = await this.platform.definition(tx, actor, meta.definition_id, "FOR UPDATE");
      const page = await this.page(tx, actor, id, true);
      if (page.revision !== body.expectedRevision || !!page.archived_at !== (action === "restore")) throw new ConflictException("页面已变化，请重新检查归档或恢复影响");
      const impact = await pageLifecycleImpact(tx, definition, page, action);
      if (body.impactToken !== impact.token) throw new ConflictException("使用情况已变化，请重新检查归档或恢复影响");
      await tx.query("UPDATE pages SET archived_at=CASE WHEN $2 THEN now() ELSE NULL END,archived_by=CASE WHEN $2 THEN $3::uuid ELSE NULL END,revision=revision+1 WHERE id=$1", [id, action === "archive", actor.id]);
      await tx.query("INSERT INTO configuration_events(id,workspace_id,actor_id,resource_kind,resource_id,action,revision,detail) VALUES($1,$2,$3,'page',$4,$5,$6,$7)", [randomUUID(), actor.workspaceId, actor.id, id, action, page.revision + 1, { publishedVersion: page.latest_version, pendingFieldCount: impact.pendingFieldCount, references: impact.references, tasks: impact.tasks }]);
      return draftDto(await this.page(tx, actor, id));
    });
  }
  async createWithObject(actor: Actor, body: unknown) {
    requireAdmin(actor); object(body); title(body.title);
    const id = await this.db.transaction(tx => once(tx, actor, body.requestId, { pageAndObject: body.title.trim(), applicationId: body.applicationId }, async () => {
      const appId = await applicationId(tx, actor, body.applicationId), definitionId = randomUUID(), id = randomUUID();
      const model: DataModel = { version: 1, fields: [] }, schema = pageForModel(model);
      await tx.query("INSERT INTO definitions(id,workspace_id,application_id,title,draft,model_draft) VALUES($1,$2,$3,$4,$5,$6)", [definitionId, actor.workspaceId, appId, body.title.trim(), modelFormSchema(model), model]);
      await tx.query("INSERT INTO pages(id,workspace_id,definition_id,definition_version,title,draft,initial_model,initial_model_revision) VALUES($1,$2,$3,0,$4,$5,$6,1)", [id, actor.workspaceId, definitionId, body.title.trim(), schema, model]);
      return id;
    }));
    return this.editor(actor, id);
  }
  private async pendingModel(tx: Transaction, actor: Actor, definition: any, version: number, additions: unknown, baseRevision: unknown, allowIncomplete = false, page?: any) {
    const initial = version === 0 && page?.definition_version === 0;
    const model = initial ? await this.pageModel(tx, actor, page) : await this.model(tx, actor, definition.id, version);
    const merged = page?.form_model
      ? { model: parseModel(page.form_model, allowIncomplete), additions: [] as DataFieldAddition[] }
      : modelWithAdditions(model, additions, allowIncomplete);
    if (page?.form_model) {
      if (!allowIncomplete && !(await this.canEditFields(tx, actor, page))) throw new ConflictException("此表单的字段已被其他表单共用，当前草稿已保留，请先处理共用配置");
      const known = new Set(dataFields(model).map(item => item.field.id));
      for (const field of merged.model.fields) {
        if (!known.has(field.id)) merged.additions.push({ field });
        else for (const child of field.children) if (!known.has(child.id)) merged.additions.push({ parentId: field.id, field: child });
      }
    }
    const changes = dataModelChanges(model, merged.model);
    const publishesModel = version === 0 || Object.values(changes).some(items => items.length > 0);
    if (!allowIncomplete && (page?.form_model || merged.additions.length || version === 0)) {
      const expectedRevision = initial ? page.initial_model_revision : baseRevision;
      if (expectedRevision !== definition.revision || version !== definition.latest_version) throw new ConflictException("表单字段已在其他编辑中更新，当前草稿已保留，请重新读取后核对修改");
      // Do not overwrite a separately edited unpublished model draft.
      if (JSON.stringify(parseModel(definition.model_draft, true)) !== JSON.stringify(parseModel(model, true))) throw new ConflictException("数据对象另有未发布修改，请先处理数据草稿");
    }
    return { ...merged, baseModel: model, publishesModel };
  }
  async save(actor: Actor, body: unknown, id?: string) {
    requireAdmin(actor); object(body); title(body.title); uuid(body.definitionId);
    return this.db.transaction(async tx => {
      const definition = await this.platform.definition(tx, actor, body.definitionId, "FOR UPDATE");
      const old = id ? await this.page(tx, actor, id, true) : undefined;
      if (id) await assertPageActive(tx, actor, id);
      if (old && old.revision !== body.expectedRevision) throw new ConflictException("页面已被修改，当前编辑内容已保留");
      if (old && old.definition_id !== body.definitionId) throw new BadRequestException("页面所属数据对象不能直接变更");
      const formModel = body.formModel == null ? null : parseModel(body.formModel, true);
      if (formModel && (!old || !(await this.canEditFields(tx, actor, old)))) throw new ConflictException("共用字段不能由当前表单单独修改，当前输入已保留");
      if (formModel && body.definitionVersion !== old.definition_version) throw new ConflictException("表单版本已变化，请重新读取后核对修改");
      if (old?.form_model && !formModel) throw new ConflictException("当前草稿包含字段修改，请重新读取后继续编辑");
      const merged = await this.pendingModel(tx, actor, definition, body.definitionVersion, body.additions || [], body.baseDefinitionRevision, true, old && { ...old, form_model: formModel });
      if (formModel) await this.platform.validateStableFields(tx, definition.id, modelFormSchema(formModel));
      if (merged.additions.length && (!Number.isInteger(body.baseDefinitionRevision) || body.baseDefinitionRevision < 1)) throw new BadRequestException("新增字段缺少有效的数据基线，请重新读取数据字段");
      if (formModel && (!Number.isInteger(body.baseDefinitionRevision) || body.baseDefinitionRevision < 1)) throw new BadRequestException("缺少表单字段版本，请重新读取后重试");
      if (old?.form_model && body.baseDefinitionRevision !== old.base_definition_revision) throw new ConflictException("当前草稿的字段版本不能静默变更，请重新读取后核对");
      const schema = parsePage(body.schema, merged.model, true);
      const bindings = pageBindings(schema);
      if (formModel && dataFields(formModel).some(item => !bindings.has(item.field.id))) throw new BadRequestException("表单字段与画布不一致，请重新读取后核对");
      for (const addition of merged.additions) if (!bindings.has(addition.field.id)) throw new BadRequestException("新增字段已不在页面中，请同步移除该草稿字段");
      const pageId = id || randomUUID(), base = formModel || merged.additions.length ? body.baseDefinitionRevision : null;
      const initialModel = body.definitionVersion === 0 ? merged.baseModel : null;
      const initialRevision = initialModel ? old?.initial_model_revision ?? definition.revision : null;
      if (!old) await tx.query("INSERT INTO pages(id,workspace_id,definition_id,definition_version,title,draft,additions,base_definition_revision,initial_model,initial_model_revision) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)", [pageId, actor.workspaceId, body.definitionId, body.definitionVersion, body.title.trim(), schema, JSON.stringify(merged.additions), base, initialModel, initialRevision]);
      else await tx.query("UPDATE pages SET definition_version=$2,title=$3,draft=$4,additions=$5,base_definition_revision=$6,initial_model=$7,initial_model_revision=$8,managed=false,revision=revision+1 WHERE id=$1", [pageId, body.definitionVersion, body.title.trim(), schema, JSON.stringify(merged.additions), base, initialModel, initialRevision]);
      if (formModel) await tx.query("UPDATE pages SET form_model=$2 WHERE id=$1", [pageId, formModel]);
      const fieldTrash = parseFieldTrash(body.fieldTrash ?? old?.field_trash ?? [], bindings.keys());
      await tx.query("UPDATE pages SET field_trash=$2 WHERE id=$1", [pageId, JSON.stringify(fieldTrash)]);
      return draftDto(await this.page(tx, actor, pageId));
    });
  }
  async publishPreview(actor: Actor, id: string, body: unknown) {
    requireAdmin(actor); object(body);
    return this.db.transaction(async tx => {
      const meta = await this.page(tx, actor, id);
      const definition = await this.platform.definition(tx, actor, meta.definition_id, "FOR UPDATE");
      const page = await this.page(tx, actor, id);
      await assertPageActive(tx, actor, id);
      if (page.revision !== body.expectedRevision) throw new ConflictException("页面已被修改，请重新读取草稿后检查");
      const merged = await this.pendingModel(tx, actor, definition, page.definition_version, page.additions, page.base_definition_revision, false, page);
      const schema = parsePage(page.draft, merged.model);
      if (!schema.controls.some(control => control.properties.visible)) throw new BadRequestException("发布页面至少需要一个可见字段");
      await this.platform.validateOrganizationModel(tx, actor, modelFormSchema(merged.model));
      await this.platform.validateStableFields(tx, definition.id, modelFormSchema(merged.model));
      return this.publicationImpact(tx, actor, definition, page, merged.model, schema, merged.publishesModel);
    });
  }
  async publish(actor: Actor, id: string, body: unknown) {
    requireAdmin(actor); object(body);
    return this.db.transaction(async tx => {
      const meta = await this.page(tx, actor, id);
      const definition = await this.platform.definition(tx, actor, meta.definition_id, "FOR UPDATE");
      const page = await this.page(tx, actor, id, true);
      await assertPageActive(tx, actor, id);
      if (page.revision !== body.expectedRevision) throw new ConflictException("页面已被修改，请读取最新草稿");
      const merged = await this.pendingModel(tx, actor, definition, page.definition_version, page.additions, page.base_definition_revision, false, page);
      const schema = parsePage(page.draft, merged.model);
      if (!schema.controls.length || !schema.controls.some(control => control.properties.visible)) throw new BadRequestException("发布页面至少需要一个可见字段");
      const impact = await this.publicationImpact(tx, actor, definition, page, merged.model, schema, merged.publishesModel);
      if ((page.form_model || body.impactToken !== undefined) && body.impactToken !== impact.token) throw new ConflictException("发布预览已变化，请重新检查使用情况后发布；当前草稿已保留");
      await this.platform.validateOrganizationModel(tx, actor, modelFormSchema(merged.model));
      let dataVersion = page.definition_version;
      if (merged.publishesModel) {
        dataVersion = definition.latest_version + 1;
        const runtime = modelFormSchema(merged.model);
        await this.platform.validateStableFields(tx, definition.id, runtime);
        await tx.query("INSERT INTO definition_versions(definition_id,version,title,schema) VALUES($1,$2,$3,$4)", [definition.id, dataVersion, definition.title, runtime]);
        await storeModelVersion(tx, definition.id, dataVersion, runtime, false);
        await tx.query("UPDATE definitions SET draft=$2,model_draft=$3,latest_version=$4,revision=revision+1 WHERE id=$1", [definition.id, runtime, merged.model, dataVersion]);
        await tx.query("INSERT INTO configuration_events(id,workspace_id,actor_id,resource_kind,resource_id,action,revision,detail) VALUES($1,$2,$3,'data_object',$4,'publish',$5,$6)", [randomUUID(), actor.workspaceId, actor.id, definition.id, definition.revision + 1, { version: dataVersion, pageId: id }]);
      }
      const version = page.latest_version + 1;
      const row = (await tx.query("INSERT INTO page_versions(page_id,version,title,definition_id,definition_version,schema) VALUES($1,$2,$3,$4,$5,$6) RETURNING *", [id, version, page.title, page.definition_id, dataVersion, schema])).rows[0];
      await tx.query("UPDATE pages SET definition_version=$2,latest_version=$3,revision=revision+1,additions='[]',form_model=NULL,base_definition_revision=NULL,initial_model=NULL,initial_model_revision=NULL,managed=false WHERE id=$1", [id, dataVersion, version]);
      await tx.query("INSERT INTO configuration_events(id,workspace_id,actor_id,resource_kind,resource_id,action,revision,detail) VALUES($1,$2,$3,'page',$4,'publish',$5,$6)", [randomUUID(), actor.workspaceId, actor.id, id, page.revision + 1, { version, dataVersion }]);
      return publishedDto(row);
    });
  }
  private async publicationImpact(tx: Transaction, actor: Actor, definition: any, page: any, model: DataModel, schema: PageDraft["schema"], publishesModel: boolean) {
    const fields = page.form_model ? await dataModelImpact(tx, definition, model, false, {
      organization: await this.organizations.snapshot(tx, actor), actorId: actor.id, publishingPageId: page.id,
    }) : undefined;
    if (fields?.blockers.length) throw new ConflictException(fields.blockers.join("；"));
    return pagePublishImpact(tx, definition, page, model, schema, publishesModel, fields);
  }
  async published(actor: Actor, id: string, version?: number) {
    requireAdmin(actor);
    return this.publishedIn(this.db, actor, id, version);
  }
  private async publishedIn(tx: Pick<Database, "query">, actor: Actor, id: string, version?: number) {
    if (version !== undefined && (!Number.isInteger(version) || version < 1)) throw new BadRequestException("页面版本不合法");
    const page = await this.page(tx, actor, id);
    const row = (await tx.query("SELECT * FROM page_versions WHERE page_id=$1 AND version=$2", [id, version || page.latest_version])).rows[0];
    if (!row) throw new NotFoundException("页面尚未发布或版本不存在");
    return { page: publishedDto(row), model: await this.model(tx, actor, row.definition_id, row.definition_version) };
  }
  private async scope(tx: Transaction, actor: Actor, id: string, version?: number, allowArchived = false) {
    const meta = await this.page(tx, actor, id);
    await this.platform.definition(tx, actor, meta.definition_id, "FOR SHARE");
    if (!allowArchived) await assertPageActive(tx, actor, id);
    const published = await this.publishedIn(tx, actor, id, version);
    const scope: RecordPageScope = { ...published.page, model: published.model, schema: composeFormSchema(published.model, published.page.schema) };
    return { ...published, scope };
  }
  async recordScope(actor: Actor, id: string, version: number, transaction?: Transaction, allowArchived = false) {
    if (!Number.isInteger(version) || version < 1) throw new BadRequestException("请选择明确的页面版本");
    const read = async (tx: Transaction) => (await this.scope(tx, actor, id, version, allowArchived)).scope;
    return transaction ? read(transaction) : this.db.transaction(read);
  }
  async record(actor: Actor, id: string, recordId: string, version?: number) {
    return this.db.transaction(tx => this.recordIn(tx, actor, id, recordId, version));
  }
  async records(actor: Actor, id: string, version?: number, state = 'active') {
    return this.db.transaction(async tx => {
      const { scope } = await this.scope(tx, actor, id, version);
      return this.platform.records(actor, scope.definitionId, state, scope, tx);
    });
  }
  async recordList(actor: Actor, id: string, version?: number, state='active', pageNumber=1) {
    if (!Number.isSafeInteger(pageNumber) || pageNumber<1) throw new BadRequestException('页码无效');
    return this.db.transaction(async tx=>{
      const {scope}=await this.scope(tx,actor,id,version);
      const view=await this.recordViews.read(tx,scope.definitionId,scope.schema);
      const result=await this.platform.recordList(actor,scope.definitionId,state,scope,tx,{settings:view.settings,page:pageNumber});
      // Member responses expose only columns present in already-masked data.
      const visible=new Set(result.fields.map(field=>field.id));
      return {...result,view:actor.role==='admin' ? view : {...view,settings:{...view.settings,fieldIds:view.settings.fieldIds.filter(id=>visible.has(id)),sortField:visible.has(view.settings.sortField) ? view.settings.sortField : '$createdAt'}}};
    });
  }
  private async recordIn(tx: Transaction, actor: Actor, id: string, recordId: string, version?: number) {
    const { scope } = await this.scope(tx, actor, id, version);
    return this.platform.detailIn(tx, actor, recordId, scope);
  }
  async organizationOptions(actor: Actor, id: string, body: unknown) {
    object(body);
    if (!Number.isInteger(body.pageVersion) || body.pageVersion < 1) throw new BadRequestException("请选择明确的页面版本");
    return this.db.transaction(async tx => {
      const { scope } = await this.scope(tx, actor, id, body.pageVersion);
      return this.platform.organizationOptions(actor, scope.definitionId, body, scope, tx);
    });
  }
  async form(actor: Actor, id: string, version?: number) {
    return this.db.transaction(async tx => {
      const { page, model, scope } = await this.scope(tx, actor, id, version);
      const access = pageAccess(scope, page.definitionId, page.definitionVersion, await this.platform.access(tx, actor, page.definitionId, modelFormSchema(model), { operation: "create" }));
      const defaults = await this.platform.recordDefaults(tx, actor, modelFormSchema(model));
      const visible = masked(scope.schema, defaults, {}, access);
      const definition = (await tx.query("SELECT * FROM definition_versions WHERE definition_id=$1 AND version=$2", [page.definitionId, page.definitionVersion])).rows[0];
      const versions = (await tx.query("SELECT version,schema FROM definition_versions WHERE definition_id=$1 AND version>=$2", [page.definitionId, page.definitionVersion])).rows;
      return { ...(access.create ? { collection: await this.platform.collectionStatus(tx, actor, page.definitionId) } : {}), rowActions: rowActions(definition.schema, { ...access, edit: access.create }, scope.schema), defaultValues: visible.values, identities: await this.platform.identityLabels(tx, actor, visible.schema, visible.values), page: { id: page.id, title: page.title, version: page.version }, access, definition: { ...definitionDto(definition), title: page.title, schema: visible.schema }, compatibleVersions: versions.filter(row => pageAcceptsVersion(scope, row.schema, row.version)).map(row => row.version) };
    });
  }
  async recordUpgrade(actor: Actor, id: string, recordId: string, body: unknown, preview = false) {
    requireAdmin(actor); object(body);
    if (!Number.isInteger(body.pageVersion) || body.pageVersion < 1) throw new BadRequestException("请选择明确的页面版本");
    return this.db.transaction(async tx => {
      const { page } = await this.scope(tx, actor, id, body.pageVersion);
      if (preview) return this.evolution.preview(actor, recordId, page.definitionVersion, page.definitionId, tx);
      await this.evolution.upgrade(actor, recordId, { ...body, targetVersion: page.definitionVersion }, page.definitionId, tx);
      return this.recordIn(tx, actor, id, recordId, page.version);
    });
  }
  async removedRows(actor: Actor, id: string, recordId: string, version?: number) {
    const scope = await this.recordScope(actor, id, version || (await this.page(this.db, actor, id)).latest_version);
    return this.platform.removedRows(actor, recordId, scope);
  }
  async submitRecord(actor: Actor, id: string, recordId: string, body: unknown) {
    object(body);
    if (!Number.isInteger(body.pageVersion) || body.pageVersion < 1) throw new BadRequestException("提交时需要明确的页面版本");
    return this.db.transaction(async tx => {
      const { scope } = await this.scope(tx, actor, id, body.pageVersion);
      const result = await this.platform.submitRecord(actor, recordId, body, scope, tx);
      return result;
    });
  }
  async writeRecord(actor: Actor, id: string, body: unknown, recordId?: string) {
    object(body);
    if (!Number.isInteger(body.pageVersion) || body.pageVersion < 1) throw new BadRequestException("提交时需要明确的页面版本");
    return this.db.transaction(async tx => {
      const { scope } = await this.scope(tx, actor, id, body.pageVersion);
      const result = recordId
        ? await this.platform.patchRecord(actor, recordId, body, scope, tx)
        : await this.platform.createRecord(actor, scope.definitionId, { ...body, version: scope.definitionVersion }, scope, tx);
      if (result.accessLost) return result;
      return this.recordIn(tx, actor, id, result.record.id, body.pageVersion);
    });
  }
}
