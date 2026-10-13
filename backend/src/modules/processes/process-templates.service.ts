import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import {
  fieldValueLabel,
  validConditionValue,
  dataModelChanges,
  separateFormSchema,
  type FormSchema,
  type FormValues,
  type ProcessBindingSpec,
  type ProcessSpec,
  type ProcessStartPreview,
  type ProcessTemplateDraft,
  type ProcessTemplateSpec,
  type PublishedProcessTemplate,
  type TaskSpec,
} from "@platform/contracts";
import { Actor, requireAdmin, tokenHash } from "../../core/auth/auth.service";
import { OrganizationService, parseSubject } from "../directory/organization.service";
import { Database, Transaction } from "../../core/database/database";
import { PlatformService } from "../pages/platform.service";
import { ProcessService, checkTaskGraph } from "./processes.service";
import { TaskContextService } from "./task-context.service";
import { PageService } from "../pages/pages.service";
import { applicationId } from "../applications/applications.service";
import { once } from "./commands";
import { scalar, allFields, identifier, object, title, uuid } from "../../core/database/schema";
import { assertPageActive } from "../pages/page-lifecycle";

// ============================================================================
// 1. 模板结构校验与 DTO 转换辅助函数
// ============================================================================

/** 解析并校验任务模板配置（draft 为 true 时允许部分未完成的草稿状态） */
function parseTemplate(input: unknown, draft = false): ProcessTemplateSpec {
  object(input);
  title(input.title);

  if (
    !Array.isArray(input.bindings) ||
    input.bindings.length > 20 ||
    !Array.isArray(input.tasks) ||
    input.tasks.length > 30 ||
    (!draft && (!input.bindings.length || !input.tasks.length))
  ) {
    throw new BadRequestException("需要 1–20 份业务数据与 1–30 个任务节点");
  }

  const assertVersion = (value: unknown) => {
    if (!Number.isInteger(value) || (value as number) < 1) {
      throw new BadRequestException("请选择已发布版本");
    }
  };

  // 1. 校验业务数据绑定列表
  const bindings = input.bindings.map((binding: unknown) => {
    object(binding);
    identifier(binding.id);
    title(binding.title);
    if (binding.definitionId || !draft) {
      uuid(binding.definitionId);
      assertVersion(binding.definitionVersion);
    }
    return {
      id: binding.id,
      title: binding.title.trim(),
      definitionId: binding.definitionId || "",
      definitionVersion: binding.definitionVersion || 0,
    };
  });

  if (new Set(bindings.map((b) => b.id)).size !== bindings.length) {
    throw new BadRequestException("业务数据标识重复");
  }

  // 2. 校验任务节点列表
  const tasks = input.tasks.map((task: unknown) => {
    object(task);
    identifier(task.id);
    title(task.title);
    if (task.recordBinding || !draft) {
      identifier(task.recordBinding);
    }

    let assigneeSelector;
    if (task.assigneeSelector) {
      object(task.assigneeSelector);
      if (task.assigneeId) {
        throw new BadRequestException("请选择指定成员或部门/角色中的一种取人方式");
      }
      if (draft && !task.assigneeSelector.id) {
        if (!["department", "role"].includes(task.assigneeSelector.kind)) {
          throw new BadRequestException("取人方式不合法");
        }
        assigneeSelector = {
          kind: task.assigneeSelector.kind,
          id: "",
          includeChildren: task.assigneeSelector.includeChildren === true,
        };
      } else {
        assigneeSelector = parseSubject(task.assigneeSelector);
      }
    } else if (task.assigneeId || !draft) {
      uuid(task.assigneeId);
    }

    if (task.pageId || !draft) {
      uuid(task.pageId);
      assertVersion(task.pageVersion);
    }
    if (task.subformId) {
      identifier(task.subformId);
    }

    if (
      !Array.isArray(task.dependsOn) ||
      task.dependsOn.length > 30 ||
      !Array.isArray(task.requiredFields) ||
      task.requiredFields.length > 120
    ) {
      throw new BadRequestException("依赖或必填字段不合法");
    }
    task.dependsOn.forEach(identifier);
    task.requiredFields.forEach(identifier);

    if (
      new Set(task.dependsOn).size !== task.dependsOn.length ||
      new Set(task.requiredFields).size !== task.requiredFields.length
    ) {
      throw new BadRequestException("依赖或必填字段不能重复");
    }
    if (!draft && !bindings.some((b) => b.id === task.recordBinding)) {
      throw new BadRequestException("任务未选择业务数据");
    }

    let waitFor;
    if (task.waitFor) {
      object(task.waitFor);
      identifier(task.waitFor.recordBinding);
      if (task.waitFor.fieldId || !draft) {
        identifier(task.waitFor.fieldId);
      }
      if (task.waitFor.subformId) {
        identifier(task.waitFor.subformId);
      }
      if (!validConditionValue(task.waitFor.equals)) {
        throw new BadRequestException("等待值不合法");
      }
      waitFor = {
        recordBinding: task.waitFor.recordBinding,
        fieldId: task.waitFor.fieldId || "",
        equals: task.waitFor.equals,
        ...(task.waitFor.subformId ? { subformId: task.waitFor.subformId } : {}),
      };
    }

    return {
      id: task.id,
      title: task.title.trim(),
      recordBinding: task.recordBinding || "",
      assigneeId: task.assigneeId || "",
      ...(assigneeSelector ? { assigneeSelector } : {}),
      pageId: task.pageId || "",
      pageVersion: task.pageVersion || 0,
      ...(task.subformId ? { subformId: task.subformId } : {}),
      dependsOn: [...task.dependsOn],
      requiredFields: [...task.requiredFields],
      ...(waitFor ? { waitFor } : {}),
    };
  });

  if (new Set(tasks.map((t) => t.id)).size !== tasks.length) {
    throw new BadRequestException("任务标识重复");
  }
  if (!draft) {
    checkTaskGraph(tasks);
  }

  return { title: input.title.trim(), bindings, tasks };
}

/** 将数据库行转换为任务模板草稿 DTO */
const dto = (row: any): ProcessTemplateDraft => ({
  id: row.id,
  applicationId: row.application_id,
  revision: row.revision,
  latestVersion: row.latest_version,
  spec: row.draft,
  hasDraftChanges: !row.spec || JSON.stringify(row.draft) !== JSON.stringify(row.spec),
});

// ============================================================================
// 2. 任务模板服务（草稿保存、版本发布、任务展开预览与发起）
// ============================================================================

@Injectable()
export class ProcessTemplateService {
  constructor(
    private readonly db: Database,
    private readonly platform: PlatformService,
    private readonly processes: ProcessService,
    private readonly pages: PageService,
    private readonly context: TaskContextService,
    private readonly organizations: OrganizationService,
  ) {}

  /** 按 ID 查询工作空间下的任务模板，支持行级排他锁 */
  private async template(tx: Pick<Database, "query">, actor: Actor, id: string, lock = false) {
    uuid(id);
    const sql = `
      SELECT * FROM process_templates
      WHERE id = $1 AND workspace_id = $2
      ${lock ? "FOR UPDATE" : ""}
    `;
    const { rows } = await tx.query(sql, [id, actor.workspaceId]);
    const row = rows[0];
    if (!row) throw new NotFoundException("任务模板不存在");
    return row;
  }

  /** 获取应用下的任务模板列表及草稿变更状态 */
  async list(actor: Actor, appId: string) {
    requireAdmin(actor);
    await applicationId(this.db, actor, appId);

    const sql = `
      SELECT t.*, v.spec
      FROM process_templates t
      LEFT JOIN process_template_versions v
        ON v.template_id = t.id AND v.version = t.latest_version
      WHERE t.workspace_id = $1 AND t.application_id = $2
      ORDER BY t.created_at
    `;
    const { rows } = await this.db.query(sql, [actor.workspaceId, appId]);
    return rows.map(dto);
  }

  /** 新建或更新任务模板草稿 */
  async save(actor: Actor, body: unknown, id?: string) {
    requireAdmin(actor);
    object(body);
    const spec = parseTemplate(body.spec, true);

    return this.db.transaction(async (tx) => {
      if (!id) {
        const appId = await applicationId(tx, actor, body.applicationId);
        const created = await once(
          tx,
          actor,
          body.requestId,
          { createTemplate: spec, applicationId: appId },
          async () => {
            await this.draftPages(tx, actor, spec);
            const createdId = randomUUID();
            await tx.query(
              "INSERT INTO process_templates(id,workspace_id,application_id,draft) VALUES($1,$2,$3,$4)",
              [createdId, actor.workspaceId, appId, spec],
            );
            return createdId;
          },
        );
        return dto(await this.template(tx, actor, created));
      }

      const current = await this.template(tx, actor, id, true);
      if (current.revision !== body.expectedRevision) {
        throw new ConflictException("任务模板已被修改，当前输入已保留");
      }

      await this.draftPages(tx, actor, spec, current.draft);
      const { rows } = await tx.query(
        "UPDATE process_templates SET draft=$2,revision=revision+1 WHERE id=$1 RETURNING *",
        [id, spec],
      );
      const row = rows[0];

      const { rows: pubRows } = await tx.query(
        "SELECT spec FROM process_template_versions WHERE template_id=$1 AND version=$2",
        [id, row.latest_version],
      );
      const published = pubRows[0];
      return dto({ ...row, spec: published?.spec });
    });
  }

  /** 校验草稿引用的任务处理页面是否存在且未归档 */
  private async draftPages(
    tx: Transaction,
    actor: Actor,
    spec: ProcessTemplateSpec,
    previous?: ProcessTemplateSpec,
  ) {
    const allTasks = [...spec.tasks, ...(previous?.tasks || [])];
    const ids = [...new Set(allTasks.map((task) => task.pageId).filter(Boolean))];
    if (!ids.length) return;

    const { rows } = await tx.query(
      "SELECT id,definition_id FROM pages WHERE workspace_id=$1 AND id=ANY($2::uuid[])",
      [actor.workspaceId, ids],
    );
    if (rows.length !== ids.length) {
      throw new NotFoundException("任务页面不存在或不属于当前工作空间");
    }

    const definitionIds = [...new Set(rows.map((row) => row.definition_id as string))].sort();
    for (const definitionId of definitionIds) {
      await this.platform.definition(tx, actor, definitionId, "FOR SHARE");
    }

    for (const task of spec.tasks) {
      const unchanged = previous?.tasks.some(
        (old) =>
          old.id === task.id &&
          old.pageId === task.pageId &&
          old.pageVersion === task.pageVersion,
      );
      if (task.pageId && !unchanged) {
        await assertPageActive(tx, actor, task.pageId);
      }
    }
  }

  /** 加载并校验模板绑定的所有数据对象版本 Schema */
  private async schemas(tx: Transaction, actor: Actor, spec: ProcessTemplateSpec, appId: string) {
    const schemas = new Map<string, FormSchema>();
    const definitionIds = [...new Set(spec.bindings.map((b) => b.definitionId))].sort();

    for (const id of definitionIds) {
      const def = await this.platform.definition(tx, actor, id, "FOR SHARE");
      if (def.application_id !== appId) {
        throw new BadRequestException("任务模板的数据对象应属于当前应用");
      }
    }

    for (const binding of spec.bindings) {
      const { rows } = await tx.query(
        "SELECT schema FROM definition_versions WHERE definition_id=$1 AND version=$2",
        [binding.definitionId, binding.definitionVersion],
      );
      const row = rows[0];
      if (!row) {
        throw new BadRequestException(`「${binding.title}」的数据版本不存在`);
      }
      schemas.set(binding.id, row.schema);
    }
    return schemas;
  }

  /** 解析任务节点的处理人列表（支持指定成员或按部门/角色动态取人） */
  private async assignees(
    tx: Transaction,
    actor: Actor,
    task: ProcessTemplateSpec["tasks"][number],
  ): Promise<Actor[]> {
    if (!task.assigneeSelector) {
      return [await this.processes.member(tx, actor, task.assigneeId)];
    }
    const result = await this.organizations.members(tx, actor, task.assigneeSelector);
    if (!result.users.length) {
      throw new BadRequestException(`「${task.title}」所选部门或角色没有可用成员`);
    }
    return result.users.map((user) => ({ ...user, workspaceId: actor.workspaceId }));
  }

  /** 全面校验模板的数据版本、处理人、页面字段可见性及等待条件配置 */
  private async validate(tx: Transaction, actor: Actor, spec: ProcessTemplateSpec, appId: string) {
    const schemas = await this.schemas(tx, actor, spec, appId);

    for (const task of spec.tasks) {
      const binding = spec.bindings.find((b) => b.id === task.recordBinding)!;
      await this.assignees(tx, actor, task);

      const scope = await this.pages.recordScope(actor, task.pageId, task.pageVersion, tx);
      if (
        scope.definitionId !== binding.definitionId ||
        scope.definitionVersion !== binding.definitionVersion
      ) {
        throw new BadRequestException(`「${task.title}」处理页面与业务数据版本不匹配`);
      }

      const fields = task.subformId
        ? scope.schema.fields.find((f) => f.id === task.subformId && f.type === "subform" && f.visible)?.children
        : allFields(scope.schema);
      if (!fields) {
        throw new BadRequestException(`「${task.title}」页面未展示指定明细`);
      }

      const hasHiddenRequired = task.requiredFields.some(
        (id) => !fields.some((f) => f.id === id && f.visible && f.type !== "subform"),
      );
      if (hasHiddenRequired) {
        throw new BadRequestException(`「${task.title}」必填字段必须在处理范围内可见`);
      }

      if (task.waitFor) {
        const wait = task.waitFor;
        const schema = schemas.get(wait.recordBinding);
        if (!schema) {
          throw new BadRequestException("等待条件未选择业务数据");
        }
        if (
          wait.subformId &&
          (wait.recordBinding !== task.recordBinding || wait.subformId !== task.subformId)
        ) {
          throw new BadRequestException("明细等待条件只能使用本任务所绑定的明细行");
        }
        const waitFields = wait.subformId
          ? schema.fields.find((f) => f.id === wait.subformId)?.children
          : schema.fields;
        const field = waitFields?.find((f) => f.id === wait.fieldId && f.type !== "subform");
        if (!field) {
          throw new BadRequestException("等待字段或比较值类型不匹配");
        }
        scalar(field, wait.equals, false);
      }
    }
    return schemas;
  }

  /** 发布任务模板为新版本 */
  async publish(actor: Actor, id: string, body: unknown) {
    requireAdmin(actor);
    object(body);

    return this.db.transaction(async (tx) => {
      const row = await this.template(tx, actor, id, true);
      if (row.revision !== body.expectedRevision) {
        throw new ConflictException("任务模板已被修改，请重新检查草稿");
      }

      const spec = parseTemplate(row.draft);
      await this.validate(tx, actor, spec, row.application_id);

      const version = row.latest_version + 1;
      await tx.query(
        "INSERT INTO process_template_versions(template_id,version,spec) VALUES($1,$2,$3)",
        [id, version, spec],
      );
      await tx.query(
        "UPDATE process_templates SET latest_version=$2,revision=revision+1 WHERE id=$1",
        [id, version],
      );
      return { id, applicationId: row.application_id, version, spec } satisfies PublishedProcessTemplate;
    });
  }

  /** 读取已发布的任务模板指定版本 */
  async published(
    actor: Actor,
    id: string,
    version: number,
    tx: Pick<Database, "query"> = this.db,
  ): Promise<PublishedProcessTemplate> {
    requireAdmin(actor);
    const template = await this.template(tx, actor, id);
    if (!Number.isInteger(version) || version < 1) {
      throw new BadRequestException("请选择已发布的任务模板版本");
    }

    const { rows } = await tx.query(
      "SELECT spec FROM process_template_versions WHERE template_id=$1 AND version=$2",
      [id, version],
    );
    const row = rows[0];
    if (!row) throw new NotFoundException("任务模板版本不存在");

    return { id, applicationId: template.application_id, version, spec: row.spec };
  }

  /** 判断业务记录的数据版本与模型结构是否兼容模板绑定要求 */
  private compatible(binding: ProcessBindingSpec, expected: FormSchema, record: any) {
    if (
      record.definition_id !== binding.definitionId ||
      record.definition_version < binding.definitionVersion ||
      record.archived_at ||
      record.state === "draft"
    ) {
      return false;
    }
    if (record.definition_version === binding.definitionVersion) return true;

    const changes = dataModelChanges(
      separateFormSchema(expected).model,
      separateFormSchema(record.schema).model,
    );
    return !changes.removed.length && !changes.changed.length;
  }

  /** 查询与指定模板版本中某个业务数据绑定相兼容的候选记录列表 */
  async records(actor: Actor, id: string, version: number, bindingId: string) {
    const template = await this.published(actor, id, version);
    const binding = template.spec.bindings.find((b) => b.id === bindingId);
    if (!binding) throw new BadRequestException("业务数据绑定不存在");

    const { rows: versionRows } = await this.db.query(
      "SELECT schema FROM definition_versions WHERE definition_id=$1 AND version=$2",
      [binding.definitionId, binding.definitionVersion],
    );
    const expected = versionRows[0].schema as FormSchema;
    const firstField = expected.fields.find((f) => f.type !== "subform");

    const sql = `
      SELECT r.*, v.schema
      FROM records r
      JOIN definition_versions v
        ON v.definition_id = r.definition_id AND v.version = r.definition_version
      WHERE r.workspace_id = $1
        AND r.definition_id = $2
        AND r.archived_at IS NULL
        AND r.state = 'active'
      ORDER BY r.created_at DESC
      LIMIT 100
    `;
    const { rows } = await this.db.query(sql, [actor.workspaceId, binding.definitionId]);

    return rows
      .filter((row) => this.compatible(binding, expected, row))
      .map((row) => {
        const rawLabel = firstField ? fieldValueLabel(firstField, row.values[firstField.id]) : "";
        return {
          id: row.id,
          label: rawLabel || "未命名记录",
          definitionVersion: row.definition_version,
          revision: row.revision,
          createdAt: row.created_at.toISOString(),
        };
      });
  }

  /** 根据绑定记录与组织成员将模板节点展开为具体的运行时任务图 */
  private async expand(
    tx: Transaction,
    actor: Actor,
    template: PublishedProcessTemplate,
    bindings: Record<string, string>,
  ) {
    const organization = await this.organizations.snapshot(tx, actor);
    const spec = parseTemplate(template.spec);
    const schemas = await this.validate(tx, actor, spec, template.applicationId);

    if (
      Object.keys(bindings).length !== spec.bindings.length ||
      spec.bindings.some((b) => !bindings[b.id])
    ) {
      throw new BadRequestException("请选择每份业务数据对应的记录");
    }
    for (const id of Object.values(bindings)) uuid(id);

    const records = await this.processes.lockBindings(tx, actor, bindings);
    const recordRevisions: Record<string, number> = {};

    for (const binding of spec.bindings) {
      const record = records.get(bindings[binding.id]!)!;
      const { rows } = await tx.query(
        "SELECT schema FROM definition_versions WHERE definition_id=$1 AND version=$2",
        [record.definition_id, record.definition_version],
      );
      record.schema = rows[0].schema;
      if (!this.compatible(binding, schemas.get(binding.id)!, record)) {
        throw new ConflictException(`「${binding.title}」记录与已发布的数据要求不兼容`);
      }
      recordRevisions[binding.id] = record.revision;
    }

    const tasks: TaskSpec[] = [];
    const preview: ProcessStartPreview["tasks"] = [];
    const expanded = new Map<string, string[]>();

    for (const [index, templateTask] of spec.tasks.entries()) {
      const record = records.get(bindings[templateTask.recordBinding]!)!;
      const members = await this.assignees(tx, actor, templateTask);
      const scope = await this.pages.recordScope(
        actor,
        templateTask.pageId,
        templateTask.pageVersion,
        tx,
      );

      const rows: (FormValues | undefined)[] = templateTask.subformId
        ? record.values[templateTask.subformId] || []
        : [undefined];
      if (!rows.length) {
        throw new BadRequestException(`「${templateTask.title}」没有可展开的明细行，请先补充业务数据`);
      }

      const keys: string[] = [];
      if (tasks.length + rows.length * members.length > 300) {
        throw new BadRequestException("本次展开超过 300 个任务，请缩小部门、角色或明细范围");
      }

      for (const [rowIndex, row] of rows.entries()) {
        for (const [memberIndex, member] of members.entries()) {
          const suffix = templateTask.assigneeSelector ? `_${memberIndex + 1}` : "";
          const key = `task_${index + 1}_${rowIndex + 1}${suffix}`;
          const rowId = row?._rowId as string | undefined;
          const { assigneeSelector: _selector, ...taskConfiguration } = templateTask;

          const taskTitle = row
            ? `${templateTask.title.slice(0, 85)} · 第 ${rowIndex + 1} 行`
            : templateTask.title;
          const waitFor = templateTask.waitFor
            ? {
                ...templateTask.waitFor,
                ...(templateTask.waitFor.subformId ? { rowId } : {}),
              }
            : undefined;

          const task: TaskSpec = {
            ...taskConfiguration,
            assigneeId: member.id,
            id: key,
            templateTaskId: templateTask.id,
            title: taskTitle,
            dependsOn: [],
            ...(rowId ? { rowId } : {}),
            ...(waitFor ? { waitFor } : {}),
          };

          await this.context.load(tx, member, record.id, task, false);
          keys.push(key);
          tasks.push(task);
          preview.push({
            key,
            title: task.title,
            assigneeName: member.name,
            assigneeId: member.id,
            recordId: record.id,
            pageTitle: (scope as any).title,
            ...(rowId ? { rowId, subformId: templateTask.subformId } : {}),
            dependsOn: [],
          });
        }
      }
      expanded.set(templateTask.id, keys);
    }

    if (tasks.length > 300) {
      throw new BadRequestException("本次展开超过 300 个任务，请缩小业务范围");
    }

    for (const [index, task] of tasks.entries()) {
      const templateTask = spec.tasks.find((t) => t.id === task.templateTaskId)!;
      task.dependsOn = templateTask.dependsOn.flatMap((key) => expanded.get(key)!);
      preview[index]!.dependsOn = [...task.dependsOn];
    }

    const participantsToken = tokenHash(
      JSON.stringify({
        revision: organization.revision,
        members: tasks.map((task) => [task.id, task.assigneeId]),
      }),
    );

    return {
      recordRevisions,
      runtime: { title: spec.title, tasks } satisfies ProcessSpec,
      preview,
      participantsToken,
    };
  }

  /** 预览流程发起前将生成的任务节点与参与人快照 */
  async preview(actor: Actor, id: string, version: number, body: unknown) {
    requireAdmin(actor);
    object(body);
    object(body.bindings);

    return this.db.transaction(async (tx) => {
      const template = await this.published(actor, id, version, tx);
      const expanded = await this.expand(tx, actor, template, body.bindings);
      return {
        template,
        bindings: body.bindings,
        recordRevisions: expanded.recordRevisions,
        participantsToken: expanded.participantsToken,
        tasks: expanded.preview,
      } satisfies ProcessStartPreview;
    });
  }

  /** 校验预览快照一致性并正式发起流程实例 */
  async start(actor: Actor, id: string, version: number, body: unknown) {
    requireAdmin(actor);
    object(body);
    object(body.bindings);
    object(body.recordRevisions);

    const payload = {
      templateId: id,
      version,
      bindings: body.bindings,
      recordRevisions: body.recordRevisions,
      ...(body.participantsToken !== undefined ? { participantsToken: body.participantsToken } : {}),
    };

    const processId = await this.db.transaction((tx) =>
      once(tx, actor, body.requestId, payload, async () => {
        const template = await this.published(actor, id, version, tx);
        const expanded = await this.expand(tx, actor, template, body.bindings);

        const requiresTokenCheck =
          template.spec.tasks.some((task) => task.assigneeSelector) ||
          body.participantsToken !== undefined;
        if (requiresTokenCheck && body.participantsToken !== expanded.participantsToken) {
          throw new ConflictException("组织或处理成员已变化，请重新预览任务；尚未发起流程");
        }

        const revisionsMismatch =
          Object.keys(body.recordRevisions).length !== Object.keys(expanded.recordRevisions).length ||
          Object.entries(expanded.recordRevisions).some(
            ([key, revision]) => body.recordRevisions[key] !== revision,
          );
        if (revisionsMismatch) {
          throw new ConflictException("业务记录已变化，请重新预览将要生成的任务");
        }

        const process = await this.processes.createIn(
          tx,
          actor,
          expanded.runtime,
          body.bindings,
          body.requestId,
          { templateId: id, templateVersion: version, applicationId: template.applicationId },
        );
        return process.id;
      }),
    );

    return this.processes.get(actor, processId);
  }
}
