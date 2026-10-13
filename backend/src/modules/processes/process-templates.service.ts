import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import {
  fieldValueLabel,
  validConditionValue,
  dataModelChanges,
  separateFormSchema,
  processTemplateConnectionError,
  type FormSchema,
  type FormValues,
  type ProcessBindingSpec,
  type ProcessSpec,
  type ProcessStartPreview,
  type ProcessTemplateDraft,
  type ProcessTemplateSpec,
  type PublishedProcessTemplate,
  type TaskSpec,
  type RecordDetail,
} from "@platform/contracts";
import { Actor, requireAdmin, tokenHash } from "../../core/auth/auth.service";
import {
  OrganizationService,
  parseSubject,
} from "../directory/organization.service";
import { Database, Transaction } from "../../core/database/database";
import { PlatformService } from "../pages/platform.service";
import { ProcessService, checkTaskGraph } from "./processes.service";
import { TaskContextService } from "./task-context.service";
import { PageService } from "../pages/pages.service";
import { applicationId } from "../applications/applications.service";
import { once } from "./commands";
import {
  scalar,
  allFields,
  identifier,
  object,
  title,
  uuid,
} from "../../core/database/schema";
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
    if (["start", "end"].includes(task.id)) {
      throw new BadRequestException("任务标识不能占用流程起止节点");
    }
    title(task.title);
    if (task.position !== undefined) {
      object(task.position);
      if (
        ![task.position.x, task.position.y].every(
          (value) => Number.isFinite(value) && Math.abs(value) <= 100000,
        )
      ) {
        throw new BadRequestException("节点位置不合法");
      }
    }
    if (task.kind !== undefined && !["approval", "copy"].includes(task.kind)) {
      throw new BadRequestException("流程节点类型不合法");
    }
    const fieldPermissions: Record<string, "edit" | "read" | "hidden"> = {};
    if (task.fieldPermissions !== undefined) {
      object(task.fieldPermissions);
      if (Object.keys(task.fieldPermissions).length > 1000) {
        throw new BadRequestException("节点字段配置过多");
      }
      for (const [id, permission] of Object.entries(task.fieldPermissions)) {
        identifier(id);
        if (!["edit", "read", "hidden"].includes(permission as string)) {
          throw new BadRequestException("节点字段权限不合法");
        }
        fieldPermissions[id] = permission as "edit" | "read" | "hidden";
      }
    }
    if (task.recordBinding || !draft) {
      identifier(task.recordBinding);
    }

    let assigneeSelector;
    if (task.assigneeSelector) {
      object(task.assigneeSelector);
      if (task.assigneeId) {
        throw new BadRequestException(
          "请选择指定成员或部门/角色中的一种取人方式",
        );
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
        ...(task.waitFor.subformId
          ? { subformId: task.waitFor.subformId }
          : {}),
      };
    }

    return {
      id: task.id,
      title: task.title.trim(),
      kind: task.kind || "approval",
      fieldPermissions,
      ...(task.position
        ? { position: { x: task.position.x, y: task.position.y } }
        : {}),
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

  // 草稿可断线保存，但起止连线本身必须引用有效节点。
  const terminalTasks = (value: unknown): string[] => {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > 30) {
      throw new BadRequestException("起止连线不合法");
    }
    value.forEach(identifier);
    if (
      new Set(value).size !== value.length ||
      value.some((id) => !tasks.some((task) => task.id === id))
    ) {
      throw new BadRequestException("起止连线重复或引用了不存在的节点");
    }
    return [...value];
  };
  const startTaskIds = terminalTasks(input.startTaskIds);
  const endTaskIds = terminalTasks(input.endTaskIds);

  const layout: ProcessTemplateSpec["layout"] = {};
  if (input.layout !== undefined) {
    object(input.layout);
    for (const key of ["start", "end"] as const) {
      const point = input.layout[key];
      if (point === undefined) continue;
      object(point);
      if (
        ![point.x, point.y].every(
          (value) => Number.isFinite(value) && Math.abs(value) <= 100000,
        )
      ) {
        throw new BadRequestException("起止节点位置不合法");
      }
      layout[key] = { x: point.x, y: point.y };
    }
  }
  return {
    title: input.title.trim(),
    bindings,
    tasks,
    startTaskIds,
    endTaskIds,
    ...(input.layout ? { layout } : {}),
  };
}

/** 将数据库行转换为任务模板草稿 DTO */
const dto = (row: any): ProcessTemplateDraft => ({
  id: row.id,
  applicationId: row.application_id,
  ...(row.start_page_id ? { startPageId: row.start_page_id } : {}),
  enabled: row.enabled,
  revision: row.revision,
  latestVersion: row.latest_version,
  spec: row.draft,
  hasDraftChanges:
    !row.spec || JSON.stringify(row.draft) !== JSON.stringify(row.spec),
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
  private async template(
    tx: Pick<Database, "query">,
    actor: Actor,
    id: string,
    lock = false,
  ) {
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
    if (actor.role === "admin") return rows.map(dto);
    const available: ProcessTemplateDraft[] = [];
    for (const row of rows) {
      if (!row.enabled || !row.latest_version || !row.spec) continue;
      try {
        await this.assertCanStart(this.db, actor, row.spec);
        // 普通成员只获取已发布配置，不能读到管理员的未发布草稿。
        available.push(dto({ ...row, draft: row.spec }));
      } catch (error) {
        if (!(error instanceof ForbiddenException)) throw error;
      }
    }
    return available;
  }

  /** 发起能力沿用表单新增权限；不提升成员的配置权限。 */
  private async assertCanStart(
    tx: Pick<Database, "query">,
    actor: Actor,
    spec: ProcessTemplateSpec,
  ) {
    if (actor.role === "admin") return;
    for (const binding of spec.bindings) {
      const { rows } = await tx.query(
        "SELECT schema FROM definition_versions WHERE definition_id=$1 AND version=$2",
        [binding.definitionId, binding.definitionVersion],
      );
      if (!rows[0]) throw new ForbiddenException("此流程暂不可发起");
      const access = await this.platform.access(
        tx,
        actor,
        binding.definitionId,
        rows[0].schema,
        { operation: "create" },
      );
      if (!access.create)
        throw new ForbiddenException("没有此流程表单的新增权限");
    }
  }

  /** 表单与流程的绑定只在配置事务中修改，防止并发创建第二条提交链路。 */
  private async bindPage(
    tx: Transaction,
    actor: Actor,
    pageId: string,
    appId: string,
    spec: ProcessTemplateSpec,
    templateId?: string,
  ) {
    uuid(pageId);
    const binding = spec.bindings[0];
    if (!binding) throw new BadRequestException("请选择发起表单的数据");
    await this.platform.definition(
      tx,
      actor,
      binding.definitionId,
      "FOR SHARE",
    );
    const { rows } = await tx.query(
      "SELECT p.definition_id, d.application_id FROM pages p JOIN definitions d ON d.id=p.definition_id WHERE p.id=$1 AND p.workspace_id=$2 FOR UPDATE OF p",
      [pageId, actor.workspaceId],
    );
    if (!rows[0] || rows[0].application_id !== appId)
      throw new BadRequestException("发起表单不属于当前应用");
    if (
      spec.bindings.length !== 1 ||
      spec.bindings[0]!.definitionId !== rows[0].definition_id
    ) {
      throw new BadRequestException("表单提交流程须使用本表单的业务数据");
    }
    const existing = await tx.query(
      "SELECT id FROM process_templates WHERE start_page_id=$1",
      [pageId],
    );
    if (existing.rows.some((row) => row.id !== templateId)) {
      throw new ConflictException("此表单已有流程，请重新打开流程设计");
    }
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
          {
            createTemplate: spec,
            applicationId: appId,
            startPageId: body.startPageId || null,
          },
          async () => {
            if (body.startPageId)
              await this.bindPage(tx, actor, body.startPageId, appId, spec);
            await this.draftPages(tx, actor, spec);
            const createdId = randomUUID();
            await tx.query(
              "INSERT INTO process_templates(id,workspace_id,application_id,draft,start_page_id) VALUES($1,$2,$3,$4,$5)",
              [
                createdId,
                actor.workspaceId,
                appId,
                spec,
                body.startPageId || null,
              ],
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
      const startPageId = current.start_page_id || body.startPageId;
      if (startPageId)
        await this.bindPage(
          tx,
          actor,
          startPageId,
          current.application_id,
          spec,
          id,
        );
      const { rows } = await tx.query(
        "UPDATE process_templates SET draft=$2,revision=revision+1,start_page_id=$3 WHERE id=$1 RETURNING *",
        [id, spec, startPageId || null],
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
    const ids = [
      ...new Set(allTasks.map((task) => task.pageId).filter(Boolean)),
    ];
    if (!ids.length) return;

    const { rows } = await tx.query(
      "SELECT id,definition_id FROM pages WHERE workspace_id=$1 AND id=ANY($2::uuid[])",
      [actor.workspaceId, ids],
    );
    if (rows.length !== ids.length) {
      throw new NotFoundException("任务页面不存在或不属于当前工作空间");
    }

    const definitionIds = [
      ...new Set(rows.map((row) => row.definition_id as string)),
    ].sort();
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
  private async schemas(
    tx: Transaction,
    actor: Actor,
    spec: ProcessTemplateSpec,
    appId: string,
  ) {
    const schemas = new Map<string, FormSchema>();
    const definitionIds = [
      ...new Set(spec.bindings.map((b) => b.definitionId)),
    ].sort();

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
    const result = await this.organizations.members(
      tx,
      actor,
      task.assigneeSelector,
    );
    if (!result.users.length) {
      throw new BadRequestException(
        `「${task.title}」所选部门或角色没有可用成员`,
      );
    }
    return result.users.map((user) => ({
      ...user,
      workspaceId: actor.workspaceId,
    }));
  }

  /** 全面校验模板的数据版本、处理人、页面字段可见性及等待条件配置 */
  private async validate(
    tx: Transaction,
    actor: Actor,
    spec: ProcessTemplateSpec,
    appId: string,
  ) {
    const schemas = await this.schemas(tx, actor, spec, appId);

    for (const task of spec.tasks) {
      const binding = spec.bindings.find((b) => b.id === task.recordBinding)!;
      await this.assignees(tx, actor, task);

      const scope = await this.pages.recordScope(
        actor,
        task.pageId,
        task.pageVersion,
        tx,
      );
      if (
        scope.definitionId !== binding.definitionId ||
        scope.definitionVersion !== binding.definitionVersion
      ) {
        throw new BadRequestException(
          `「${task.title}」处理页面与业务数据版本不匹配`,
        );
      }

      const fields = task.subformId
        ? scope.schema.fields.find(
            (f) => f.id === task.subformId && f.type === "subform" && f.visible,
          )?.children
        : allFields(scope.schema);
      if (!fields) {
        throw new BadRequestException(`「${task.title}」页面未展示指定明细`);
      }

      const pageFields = allFields(scope.schema);
      if (
        Object.keys(task.fieldPermissions || {}).some(
          (id) => !pageFields.some((field) => field.id === id),
        )
      ) {
        throw new BadRequestException(
          `「${task.title}」字段权限引用了不存在的字段`,
        );
      }
      const hasHiddenRequired = task.requiredFields.some((id) => {
        const parent = scope.schema.fields.find((field) =>
          field.children.some((child) => child.id === id),
        );
        const parentHidden =
          parent &&
          (!parent.visible || task.fieldPermissions?.[parent.id] === "hidden");
        const visible = fields.some(
          (field) =>
            field.id === id && field.visible && field.type !== "subform",
        );
        return (
          parentHidden || task.fieldPermissions?.[id] === "hidden" || !visible
        );
      });
      if (hasHiddenRequired) {
        throw new BadRequestException(
          `「${task.title}」必填字段必须在处理范围内可见`,
        );
      }

      if (task.waitFor) {
        const wait = task.waitFor;
        const schema = schemas.get(wait.recordBinding);
        if (!schema) {
          throw new BadRequestException("等待条件未选择业务数据");
        }
        if (
          wait.subformId &&
          (wait.recordBinding !== task.recordBinding ||
            wait.subformId !== task.subformId)
        ) {
          throw new BadRequestException(
            "明细等待条件只能使用本任务所绑定的明细行",
          );
        }
        const waitFields = wait.subformId
          ? schema.fields.find((f) => f.id === wait.subformId)?.children
          : schema.fields;
        const field = waitFields?.find(
          (f) => f.id === wait.fieldId && f.type !== "subform",
        );
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
      const connectionError = processTemplateConnectionError(spec);
      if (connectionError) throw new BadRequestException(connectionError);
      await this.validate(tx, actor, spec, row.application_id);

      const version = row.latest_version + 1;
      await tx.query(
        "INSERT INTO process_template_versions(template_id,version,spec) VALUES($1,$2,$3)",
        [id, version, spec],
      );
      await tx.query(
        "UPDATE process_templates SET latest_version=$2,revision=revision+1,enabled=true WHERE id=$1",
        [id, version],
      );
      return {
        id,
        applicationId: row.application_id,
        version,
        spec,
      } satisfies PublishedProcessTemplate;
    });
  }

  /** 读取已发布的任务模板指定版本 */
  async published(
    actor: Actor,
    id: string,
    version: number,
    tx: Pick<Database, "query"> = this.db,
  ): Promise<PublishedProcessTemplate> {
    const template = await this.template(tx, actor, id);
    if (!template.enabled)
      throw new ConflictException("流程已停用，不能发起新流程");
    if (actor.role !== "admin" && version !== template.latest_version) {
      throw new ConflictException("流程版本已更新，请重新打开后发起");
    }
    if (!Number.isInteger(version) || version < 1) {
      throw new BadRequestException("请选择已发布的任务模板版本");
    }

    const { rows } = await tx.query(
      "SELECT spec FROM process_template_versions WHERE template_id=$1 AND version=$2",
      [id, version],
    );
    const row = rows[0];
    if (!row) throw new NotFoundException("任务模板版本不存在");

    await this.assertCanStart(tx, actor, row.spec);
    return {
      id,
      applicationId: template.application_id,
      version,
      spec: row.spec,
    };
  }

  async setEnabled(actor: Actor, id: string, body: unknown) {
    requireAdmin(actor);
    object(body);
    if (typeof body.enabled !== "boolean")
      throw new BadRequestException("流程状态不合法");
    return this.db.transaction(async (tx) => {
      const current = await this.template(tx, actor, id, true);
      if (body.expectedRevision !== current.revision)
        throw new ConflictException("流程配置已变化，请重新读取");
      if (body.enabled && !current.latest_version)
        throw new BadRequestException("请先发布流程");
      await tx.query(
        "UPDATE process_templates SET enabled=$2,revision=revision+1 WHERE id=$1",
        [id, body.enabled],
      );
      return { enabled: body.enabled };
    });
  }

  /** 记录提交与生成待办同事务提交；流程配置错误时整次回滚，输入仍由页面保留。 */
  async submitPage(
    actor: Actor,
    pageId: string,
    body: unknown,
    recordId?: string,
  ): Promise<RecordDetail> {
    object(body);
    return this.db.transaction(async (tx) => {
      uuid(body.requestId);
      // 重试只重放原提交结果，不因后来发布或启用流程而补发一份新待办。
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `${actor.id}:${body.requestId}`,
      ]);
      const command = await tx.query(
        "SELECT 1 FROM commands WHERE actor_id=$1 AND request_id=$2",
        [actor.id, body.requestId],
      );
      const result = recordId
        ? await this.pages.submitRecord(actor, pageId, recordId, body, tx)
        : await this.pages.writeRecord(actor, pageId, body, undefined, tx);
      if (result.record.state === "draft") return result;

      const previous = await tx.query(
        "SELECT id FROM processes WHERE submission_record_id=$1 AND workspace_id=$2",
        [result.record.id, actor.workspaceId],
      );
      if (previous.rows[0])
        return { ...result, processId: previous.rows[0].id };
      if (command.rowCount) return result;

      const { rows } = await tx.query(
        "SELECT * FROM process_templates WHERE start_page_id=$1 AND workspace_id=$2 AND enabled AND latest_version>0 FOR SHARE",
        [pageId, actor.workspaceId],
      );
      const configured = rows[0];
      if (!configured) return result;
      const template = await this.published(
        actor,
        configured.id,
        configured.latest_version,
        tx,
      );
      const binding = template.spec.bindings[0];
      if (template.spec.bindings.length !== 1 || !binding)
        throw new ConflictException("表单流程配置不完整，请联系管理员");
      const bindings = { [binding.id]: result.record.id };
      const expanded = await this.expand(tx, actor, template, bindings);
      const process = await this.processes.createIn(
        tx,
        actor,
        expanded.runtime,
        bindings,
        body.requestId,
        {
          templateId: template.id,
          templateVersion: template.version,
          applicationId: template.applicationId,
        },
      );
      await tx.query(
        "UPDATE processes SET submission_record_id=$2 WHERE id=$1",
        [process.id, result.record.id],
      );
      return { ...result, processId: process.id };
    });
  }

  /** 判断业务记录的数据版本与模型结构是否兼容模板绑定要求 */
  private compatible(
    binding: ProcessBindingSpec,
    expected: FormSchema,
    record: any,
  ) {
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

  private async requireManualEntry(
    tx: Pick<Database, "query">,
    actor: Actor,
    id: string,
  ) {
    const template = await this.template(tx, actor, id);
    if (template.start_page_id)
      throw new ConflictException("此流程随表单提交自动发起，请打开填写表单");
  }

  /** 查询与指定模板版本中某个业务数据绑定相兼容的候选记录列表 */
  async records(actor: Actor, id: string, version: number, bindingId: string) {
    await this.requireManualEntry(this.db, actor, id);
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
        AND ($3 = 'admin' OR r.created_by = $4)
        AND r.archived_at IS NULL
        AND r.state = 'active'
      ORDER BY r.created_at DESC
      LIMIT 100
    `;
    const { rows } = await this.db.query(sql, [
      actor.workspaceId,
      binding.definitionId,
      actor.role,
      actor.id,
    ]);

    // 候选名称也按当前读取权限掩码，不能用流程选择器绕过字段隐藏。
    const visibleRows = [];
    for (const row of rows) {
      if (!this.compatible(binding, expected, row)) continue;
      try {
        const detail = await this.platform.detail(actor, row.id);
        visibleRows.push({ ...row, values: detail.record.values });
      } catch (error) {
        if (!(error instanceof ForbiddenException)) throw error;
      }
    }

    return visibleRows.map((row) => {
      const rawLabel = firstField
        ? fieldValueLabel(firstField, row.values[firstField.id])
        : "";
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
    const schemas = await this.validate(
      tx,
      actor,
      spec,
      template.applicationId,
    );

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
      if (actor.role !== "admin" && record.created_by !== actor.id) {
        throw new ForbiddenException("只能使用本人提交的记录发起流程");
      }
      const { rows } = await tx.query(
        "SELECT schema FROM definition_versions WHERE definition_id=$1 AND version=$2",
        [record.definition_id, record.definition_version],
      );
      record.schema = rows[0].schema;
      if (!this.compatible(binding, schemas.get(binding.id)!, record)) {
        throw new ConflictException(
          `「${binding.title}」记录与已发布的数据要求不兼容`,
        );
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
        throw new BadRequestException(
          `「${templateTask.title}」没有可展开的明细行，请先补充业务数据`,
        );
      }

      const keys: string[] = [];
      if (tasks.length + rows.length * members.length > 300) {
        throw new BadRequestException(
          "本次展开超过 300 个任务，请缩小部门、角色或明细范围",
        );
      }

      for (const [rowIndex, row] of rows.entries()) {
        for (const [memberIndex, member] of members.entries()) {
          const suffix = templateTask.assigneeSelector
            ? `_${memberIndex + 1}`
            : "";
          const key = `task_${index + 1}_${rowIndex + 1}${suffix}`;
          const rowId = row?._rowId as string | undefined;
          const { assigneeSelector: _selector, ...taskConfiguration } =
            templateTask;

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
      const templateTask = spec.tasks.find(
        (t) => t.id === task.templateTaskId,
      )!;
      task.dependsOn = templateTask.dependsOn.flatMap((key) =>
        expanded.get(key)!,
      );
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
    object(body);
    object(body.bindings);

    return this.db.transaction(async (tx) => {
      await this.requireManualEntry(tx, actor, id);
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
    object(body);
    object(body.bindings);
    object(body.recordRevisions);

    const payload = {
      templateId: id,
      version,
      bindings: body.bindings,
      recordRevisions: body.recordRevisions,
      ...(body.participantsToken !== undefined
        ? { participantsToken: body.participantsToken }
        : {}),
    };

    const processId = await this.db.transaction((tx) =>
      once(tx, actor, body.requestId, payload, async () => {
        await this.requireManualEntry(tx, actor, id);
        const template = await this.published(actor, id, version, tx);
        const expanded = await this.expand(tx, actor, template, body.bindings);

        const requiresTokenCheck =
          template.spec.tasks.some((task) => task.assigneeSelector) ||
          body.participantsToken !== undefined;
        if (
          requiresTokenCheck &&
          body.participantsToken !== expanded.participantsToken
        ) {
          throw new ConflictException(
            "组织或处理成员已变化，请重新预览任务；尚未发起流程",
          );
        }

        const revisionsMismatch =
          Object.keys(body.recordRevisions).length !==
            Object.keys(expanded.recordRevisions).length ||
          Object.entries(expanded.recordRevisions).some(
            ([key, revision]) => body.recordRevisions[key] !== revision,
          );
        if (revisionsMismatch) {
          throw new ConflictException(
            "业务记录已变化，请重新预览将要生成的任务",
          );
        }

        const process = await this.processes.createIn(
          tx,
          actor,
          expanded.runtime,
          body.bindings,
          body.requestId,
          {
            templateId: id,
            templateVersion: version,
            applicationId: template.applicationId,
          },
        );
        return process.id;
      }),
    );

    return this.processes.get(actor, processId);
  }
}
