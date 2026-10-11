import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { fieldValueLabel, validConditionValue, dataModelChanges, separateFormSchema, type FormSchema, type FormValues, type ProcessBindingSpec, type ProcessSpec, type ProcessStartPreview, type ProcessTemplateDraft, type ProcessTemplateSpec, type PublishedProcessTemplate, type TaskSpec } from "@platform/contracts";
import { Actor, requireAdmin, tokenHash } from "./auth";
import { OrganizationService, parseSubject } from "./organization";
import { Database, Transaction } from "./database";
import { PlatformService } from "./platform";
import { ProcessService, checkTaskGraph } from "./processes";
import { TaskContextService } from "./task-context";
import { PageService } from "./pages";
import { applicationId } from "./applications";
import { once } from "./commands";
import { scalar, allFields, identifier, object, title, uuid } from "./schema";
import { assertPageActive } from "./page-lifecycle";

function parseTemplate(input: unknown, draft = false): ProcessTemplateSpec {
  object(input); title(input.title);
  if (!Array.isArray(input.bindings) || input.bindings.length > 20 || !Array.isArray(input.tasks) || input.tasks.length > 30 || (!draft && (!input.bindings.length || !input.tasks.length))) throw new BadRequestException("需要 1–20 份业务数据与 1–30 个任务节点");
  const version = (value: unknown) => { if (!Number.isInteger(value) || (value as number) < 1) throw new BadRequestException("请选择已发布版本"); };
  const bindings = input.bindings.map((binding: unknown) => {
    object(binding); identifier(binding.id); title(binding.title);
    if (binding.definitionId || !draft) { uuid(binding.definitionId); version(binding.definitionVersion); }
    return { id: binding.id, title: binding.title.trim(), definitionId: binding.definitionId || "", definitionVersion: binding.definitionVersion || 0 };
  });
  if (new Set(bindings.map(b => b.id)).size !== bindings.length) throw new BadRequestException("业务数据标识重复");
  const tasks = input.tasks.map((task: unknown) => {
    object(task); identifier(task.id); title(task.title);
    if (task.recordBinding || !draft) identifier(task.recordBinding);
    let assigneeSelector;
    if (task.assigneeSelector) {
      object(task.assigneeSelector);
      if (task.assigneeId) throw new BadRequestException("请选择指定成员或部门/角色中的一种取人方式");
      if (draft && !task.assigneeSelector.id) {
        if (!["department", "role"].includes(task.assigneeSelector.kind)) throw new BadRequestException("取人方式不合法");
        assigneeSelector = { kind: task.assigneeSelector.kind, id: "", includeChildren: task.assigneeSelector.includeChildren === true };
      } else assigneeSelector = parseSubject(task.assigneeSelector);
    } else if (task.assigneeId || !draft) uuid(task.assigneeId);
    if (task.pageId || !draft) { uuid(task.pageId); version(task.pageVersion); }
    if (task.subformId) identifier(task.subformId);
    if (!Array.isArray(task.dependsOn) || task.dependsOn.length > 30 || !Array.isArray(task.requiredFields) || task.requiredFields.length > 120) throw new BadRequestException("依赖或必填字段不合法");
    task.dependsOn.forEach(identifier); task.requiredFields.forEach(identifier);
    if (new Set(task.dependsOn).size !== task.dependsOn.length || new Set(task.requiredFields).size !== task.requiredFields.length) throw new BadRequestException("依赖或必填字段不能重复");
    if (!draft && !bindings.some(b => b.id === task.recordBinding)) throw new BadRequestException("任务未选择业务数据");
    let waitFor;
    if (task.waitFor) {
      object(task.waitFor); identifier(task.waitFor.recordBinding);
      if (task.waitFor.fieldId || !draft) identifier(task.waitFor.fieldId);
      if (task.waitFor.subformId) identifier(task.waitFor.subformId);
      if (!validConditionValue(task.waitFor.equals)) throw new BadRequestException("等待值不合法");
      waitFor = { recordBinding: task.waitFor.recordBinding, fieldId: task.waitFor.fieldId || "", equals: task.waitFor.equals, ...(task.waitFor.subformId ? { subformId: task.waitFor.subformId } : {}) };
    }
    return { id: task.id, title: task.title.trim(), recordBinding: task.recordBinding || "", assigneeId: task.assigneeId || "", ...(assigneeSelector ? { assigneeSelector } : {}), pageId: task.pageId || "", pageVersion: task.pageVersion || 0, ...(task.subformId ? { subformId: task.subformId } : {}), dependsOn: [...task.dependsOn], requiredFields: [...task.requiredFields], ...(waitFor ? { waitFor } : {}) };
  });
  if (new Set(tasks.map(t => t.id)).size !== tasks.length) throw new BadRequestException("任务标识重复");
  if (!draft) checkTaskGraph(tasks);
  return { title: input.title.trim(), bindings, tasks };
}
const dto = (row: any): ProcessTemplateDraft => ({ id: row.id, applicationId: row.application_id, revision: row.revision, latestVersion: row.latest_version, spec: row.draft, hasDraftChanges: !row.spec || JSON.stringify(row.draft) !== JSON.stringify(row.spec) });

@Injectable()
export class ProcessTemplateService {
  constructor(private readonly db: Database, private readonly platform: PlatformService, private readonly processes: ProcessService, private readonly pages: PageService, private readonly context: TaskContextService, private readonly organizations: OrganizationService) {}
  private async template(tx: Pick<Database, "query">, actor: Actor, id: string, lock = false) {
    uuid(id);
    const row = (await tx.query(`SELECT * FROM process_templates WHERE id=$1 AND workspace_id=$2 ${lock ? 'FOR UPDATE' : ''}`, [id, actor.workspaceId])).rows[0];
    if (!row) throw new NotFoundException("任务模板不存在");
    return row;
  }
  async list(actor: Actor, appId: string) {
    requireAdmin(actor); await applicationId(this.db, actor, appId);
    return (await this.db.query("SELECT t.*,v.spec FROM process_templates t LEFT JOIN process_template_versions v ON v.template_id=t.id AND v.version=t.latest_version WHERE t.workspace_id=$1 AND t.application_id=$2 ORDER BY t.created_at", [actor.workspaceId, appId])).rows.map(dto);
  }
  async save(actor: Actor, body: unknown, id?: string) {
    requireAdmin(actor); object(body); const spec = parseTemplate(body.spec, true);
    return this.db.transaction(async tx => {
      if (!id) {
        const appId = await applicationId(tx, actor, body.applicationId);
        const created = await once(tx, actor, body.requestId, { createTemplate: spec, applicationId: appId }, async () => {
          await this.draftPages(tx, actor, spec);
          const created = randomUUID(); await tx.query("INSERT INTO process_templates(id,workspace_id,application_id,draft) VALUES($1,$2,$3,$4)", [created, actor.workspaceId, appId, spec]); return created;
        });
        return dto(await this.template(tx, actor, created));
      }
      const current = await this.template(tx, actor, id, true);
      if (current.revision !== body.expectedRevision) throw new ConflictException("任务模板已被修改，当前输入已保留");
      await this.draftPages(tx, actor, spec, current.draft);
      const row = (await tx.query("UPDATE process_templates SET draft=$2,revision=revision+1 WHERE id=$1 RETURNING *", [id, spec])).rows[0];
      const published = (await tx.query("SELECT spec FROM process_template_versions WHERE template_id=$1 AND version=$2", [id, row.latest_version])).rows[0];
      return dto({ ...row, spec: published?.spec });
    });
  }
  private async draftPages(tx: Transaction, actor: Actor, spec: ProcessTemplateSpec, previous?: ProcessTemplateSpec) {
    const ids = [...new Set([...spec.tasks, ...(previous?.tasks || [])].map(task => task.pageId).filter(Boolean))];
    if (!ids.length) return;
    const rows = (await tx.query("SELECT id,definition_id FROM pages WHERE workspace_id=$1 AND id=ANY($2::uuid[])", [actor.workspaceId, ids])).rows;
    if (rows.length !== ids.length) throw new NotFoundException("任务页面不存在或不属于当前工作空间");
    for (const definitionId of [...new Set(rows.map(row => row.definition_id as string))].sort()) await this.platform.definition(tx, actor, definitionId, "FOR SHARE");
    for (const task of spec.tasks) if (task.pageId && !previous?.tasks.some(old => old.id === task.id && old.pageId === task.pageId && old.pageVersion === task.pageVersion)) await assertPageActive(tx, actor, task.pageId);
  }
  private async schemas(tx: Transaction, actor: Actor, spec: ProcessTemplateSpec, appId: string) {
    const schemas = new Map<string, FormSchema>();
    for (const id of [...new Set(spec.bindings.map(b => b.definitionId))].sort()) {
      const object = await this.platform.definition(tx, actor, id, "FOR SHARE");
      if (object.application_id !== appId) throw new BadRequestException("任务模板的数据对象应属于当前应用");
    }
    for (const binding of spec.bindings) {
      const row = (await tx.query("SELECT schema FROM definition_versions WHERE definition_id=$1 AND version=$2", [binding.definitionId, binding.definitionVersion])).rows[0];
      if (!row) throw new BadRequestException(`「${binding.title}」的数据版本不存在`);
      schemas.set(binding.id, row.schema);
    }
    return schemas;
  }
  private async assignees(tx: Transaction, actor: Actor, task: ProcessTemplateSpec["tasks"][number]): Promise<Actor[]> {
    if (!task.assigneeSelector) return [await this.processes.member(tx, actor, task.assigneeId)];
    const result = await this.organizations.members(tx, actor, task.assigneeSelector);
    if (!result.users.length) throw new BadRequestException(`「${task.title}」所选部门或角色没有可用成员`);
    return result.users.map(user => ({ ...user, workspaceId: actor.workspaceId }));
  }
  private async validate(tx: Transaction, actor: Actor, spec: ProcessTemplateSpec, appId: string) {
    const schemas = await this.schemas(tx, actor, spec, appId);
    for (const task of spec.tasks) {
      const binding = spec.bindings.find(b => b.id === task.recordBinding)!;
      await this.assignees(tx, actor, task);
      const scope = await this.pages.recordScope(actor, task.pageId, task.pageVersion, tx);
      if (scope.definitionId !== binding.definitionId || scope.definitionVersion !== binding.definitionVersion) throw new BadRequestException(`「${task.title}」处理页面与业务数据版本不匹配`);
      const fields = task.subformId ? scope.schema.fields.find(f => f.id === task.subformId && f.type === "subform" && f.visible)?.children : allFields(scope.schema);
      if (!fields) throw new BadRequestException(`「${task.title}」页面未展示指定明细`);
      if (task.requiredFields.some(id => !fields.some(f => f.id === id && f.visible && f.type !== "subform"))) throw new BadRequestException(`「${task.title}」必填字段必须在处理范围内可见`);
      if (task.waitFor) {
        const wait = task.waitFor, schema = schemas.get(wait.recordBinding);
        if (!schema) throw new BadRequestException("等待条件未选择业务数据");
        if (wait.subformId && (wait.recordBinding !== task.recordBinding || wait.subformId !== task.subformId)) throw new BadRequestException("明细等待条件只能使用本任务所绑定的明细行");
        const fields = wait.subformId ? schema.fields.find(f => f.id === wait.subformId)?.children : schema.fields;
        const field = fields?.find(f => f.id === wait.fieldId && f.type !== "subform");
        if (!field) throw new BadRequestException("等待字段或比较值类型不匹配");
        scalar(field, wait.equals, false);
      }
    }
    return schemas;
  }
  async publish(actor: Actor, id: string, body: unknown) {
    requireAdmin(actor); object(body);
    return this.db.transaction(async tx => {
      const row = await this.template(tx, actor, id, true);
      if (row.revision !== body.expectedRevision) throw new ConflictException("任务模板已被修改，请重新检查草稿");
      const spec = parseTemplate(row.draft); await this.validate(tx, actor, spec, row.application_id);
      const version = row.latest_version + 1;
      await tx.query("INSERT INTO process_template_versions(template_id,version,spec) VALUES($1,$2,$3)", [id, version, spec]);
      await tx.query("UPDATE process_templates SET latest_version=$2,revision=revision+1 WHERE id=$1", [id, version]);
      return { id, applicationId: row.application_id, version, spec } satisfies PublishedProcessTemplate;
    });
  }
  async published(actor: Actor, id: string, version: number, tx: Pick<Database, "query"> = this.db): Promise<PublishedProcessTemplate> {
    requireAdmin(actor);
    const template = await this.template(tx, actor, id);
    if (!Number.isInteger(version) || version < 1) throw new BadRequestException("请选择已发布的任务模板版本");
    const row = (await tx.query("SELECT spec FROM process_template_versions WHERE template_id=$1 AND version=$2", [id, version])).rows[0];
    if (!row) throw new NotFoundException("任务模板版本不存在");
    return { id, applicationId: template.application_id, version, spec: row.spec };
  }
  private compatible(binding: ProcessBindingSpec, expected: FormSchema, record: any) {
    if (record.definition_id !== binding.definitionId || record.definition_version < binding.definitionVersion || record.archived_at || record.state === "draft") return false;
    if (record.definition_version === binding.definitionVersion) return true;
    const changes = dataModelChanges(separateFormSchema(expected).model, separateFormSchema(record.schema).model);
    return !changes.removed.length && !changes.changed.length;
  }
  async records(actor: Actor, id: string, version: number, bindingId: string) {
    const template = await this.published(actor, id, version), binding = template.spec.bindings.find(b => b.id === bindingId);
    if (!binding) throw new BadRequestException("业务数据绑定不存在");
    const expected = (await this.db.query("SELECT schema FROM definition_versions WHERE definition_id=$1 AND version=$2", [binding.definitionId, binding.definitionVersion])).rows[0].schema as FormSchema;
    const firstField = expected.fields.find(f => f.type !== "subform");
    const rows = (await this.db.query("SELECT r.*,v.schema FROM records r JOIN definition_versions v ON v.definition_id=r.definition_id AND v.version=r.definition_version WHERE r.workspace_id=$1 AND r.definition_id=$2 AND r.archived_at IS NULL AND r.state='active' ORDER BY r.created_at DESC LIMIT 100", [actor.workspaceId, binding.definitionId])).rows;
    return rows.filter(row => this.compatible(binding, expected, row)).map(row => ({ id: row.id, label: (firstField ? fieldValueLabel(firstField, row.values[firstField.id]) : "") || "未命名记录", definitionVersion: row.definition_version, revision: row.revision, createdAt: row.created_at.toISOString() }));
  }
  private async expand(tx: Transaction, actor: Actor, template: PublishedProcessTemplate, bindings: Record<string, string>) {
    const organization = await this.organizations.snapshot(tx, actor);
    const spec = parseTemplate(template.spec), schemas = await this.validate(tx, actor, spec, template.applicationId);
    if (Object.keys(bindings).length !== spec.bindings.length || spec.bindings.some(b => !bindings[b.id])) throw new BadRequestException("请选择每份业务数据对应的记录");
    for (const id of Object.values(bindings)) uuid(id);
    const records = await this.processes.lockBindings(tx, actor, bindings), recordRevisions: Record<string, number> = {};
    for (const binding of spec.bindings) {
      const record = records.get(bindings[binding.id]!)!;
      record.schema = (await tx.query("SELECT schema FROM definition_versions WHERE definition_id=$1 AND version=$2", [record.definition_id, record.definition_version])).rows[0].schema;
      if (!this.compatible(binding, schemas.get(binding.id)!, record)) throw new ConflictException(`「${binding.title}」记录与已发布的数据要求不兼容`);
      recordRevisions[binding.id] = record.revision;
    }
    const tasks: TaskSpec[] = [], preview: ProcessStartPreview["tasks"] = [], expanded = new Map<string, string[]>();
    for (const [index, templateTask] of spec.tasks.entries()) {
      const record = records.get(bindings[templateTask.recordBinding]!)!, members = await this.assignees(tx, actor, templateTask);
      const scope = await this.pages.recordScope(actor, templateTask.pageId, templateTask.pageVersion, tx);
      const rows: (FormValues | undefined)[] = templateTask.subformId ? record.values[templateTask.subformId] || [] : [undefined];
      if (!rows.length) throw new BadRequestException(`「${templateTask.title}」没有可展开的明细行，请先补充业务数据`);
      const keys: string[] = [];
      if (tasks.length + rows.length * members.length > 300) throw new BadRequestException("本次展开超过 300 个任务，请缩小部门、角色或明细范围");
      for (const [rowIndex, row] of rows.entries()) for (const [memberIndex, member] of members.entries()) {
        const key = `task_${index + 1}_${rowIndex + 1}${templateTask.assigneeSelector ? `_${memberIndex + 1}` : ''}`, rowId = row?._rowId as string | undefined;
        const { assigneeSelector: _selector, ...taskConfiguration } = templateTask;
        const task: TaskSpec = { ...taskConfiguration, assigneeId: member.id, id: key, templateTaskId: templateTask.id, title: row ? `${templateTask.title.slice(0, 85)} · 第 ${rowIndex + 1} 行` : templateTask.title, dependsOn: [], ...(rowId ? { rowId } : {}), ...(templateTask.waitFor ? { waitFor: { ...templateTask.waitFor, ...(templateTask.waitFor.subformId ? { rowId } : {}) } } : {}) };
        await this.context.load(tx, member, record.id, task, false);
        keys.push(key); tasks.push(task); preview.push({ key, title: task.title, assigneeName: member.name, assigneeId: member.id, recordId: record.id, pageTitle: (scope as any).title, ...(rowId ? { rowId, subformId: templateTask.subformId } : {}), dependsOn: [] });
      }
      expanded.set(templateTask.id, keys);
    }
    if (tasks.length > 300) throw new BadRequestException("本次展开超过 300 个任务，请缩小业务范围");
    for (const [index, task] of tasks.entries()) {
      const templateTask = spec.tasks.find(t => t.id === task.templateTaskId)!;
      task.dependsOn = templateTask.dependsOn.flatMap(key => expanded.get(key)!);
      preview[index]!.dependsOn = [...task.dependsOn];
    }
    return { recordRevisions, runtime: { title: spec.title, tasks } satisfies ProcessSpec, preview, participantsToken: tokenHash(JSON.stringify({ revision: organization.revision, members: tasks.map(task => [task.id, task.assigneeId]) })) };
  }
  async preview(actor: Actor, id: string, version: number, body: unknown) {
    requireAdmin(actor); object(body); object(body.bindings);
    return this.db.transaction(async tx => {
      const template = await this.published(actor, id, version, tx), expanded = await this.expand(tx, actor, template, body.bindings);
      return { template, bindings: body.bindings, recordRevisions: expanded.recordRevisions, participantsToken: expanded.participantsToken, tasks: expanded.preview } satisfies ProcessStartPreview;
    });
  }
  async start(actor: Actor, id: string, version: number, body: unknown) {
    requireAdmin(actor); object(body); object(body.bindings); object(body.recordRevisions);
    const processId = await this.db.transaction(tx => once(tx, actor, body.requestId, { templateId: id, version, bindings: body.bindings, recordRevisions: body.recordRevisions, ...(body.participantsToken !== undefined ? { participantsToken: body.participantsToken } : {}) }, async () => {
      const template = await this.published(actor, id, version, tx), expanded = await this.expand(tx, actor, template, body.bindings);
      if ((template.spec.tasks.some(task => task.assigneeSelector) || body.participantsToken !== undefined) && body.participantsToken !== expanded.participantsToken) throw new ConflictException("组织或处理成员已变化，请重新预览任务；尚未发起流程");
      if (Object.keys(body.recordRevisions).length !== Object.keys(expanded.recordRevisions).length || Object.entries(expanded.recordRevisions).some(([key, revision]) => body.recordRevisions[key] !== revision)) throw new ConflictException("业务记录已变化，请重新预览将要生成的任务");
      const process = await this.processes.createIn(tx, actor, expanded.runtime, body.bindings, body.requestId, { templateId: id, templateVersion: version, applicationId: template.applicationId });
      return process.id;
    }));
    return this.processes.get(actor, processId);
  }
}
