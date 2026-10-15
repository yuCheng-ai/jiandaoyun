import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import type {
  FormSchema,
  FormValues,
  ProcessRuntimeSource,
  ProcessSpec,
  ProcessSummary,
  ProcessView,
  RecordDetail,
  TaskSpec,
} from "@platform/contracts";
import { choiceConditionValue, equalFieldValues, validConditionValue } from "@platform/contracts";
import { randomUUID } from "node:crypto";
import { Actor, requireAdmin, tokenHash } from "../../core/auth/auth.service";
import { Database, Transaction } from "../../core/database/database";
import { safeFailure } from "../../core/logging/request-logging";
import { identifier, object, title, uuid } from "../../core/validation";
import { PageService } from "../pages/pages.service";
import { scalar } from "../records/field-values";
import { requireActiveRecord } from "../records/record-state";
import { RecordService } from "../records/records.service";
import { TaskContextService } from "./task-context.service";


/** 后台异常不经过 HTTP 过滤器，沿用相同的安全摘要记录，不能输出表单或异常原文。 */
function logRefreshFailure(error: unknown, context?: { id: string; workspace_id: string }) {
  const entry = {
    timestamp: new Date().toISOString(),
    level: "error",
    event: "process.refresh.failed",
    ...(context ? { processId: context.id, workspaceId: context.workspace_id } : {}),
    failure: safeFailure(error),
  };
  process.stdout.write(JSON.stringify(entry) + "\n");
}

/** 校验任务依赖有向无环图（DAG）：确保任务标识唯一、前置依赖存在且无环 */
export function checkTaskGraph(tasks: { id: string; dependsOn: string[] }[]) {
  const nodes = new Map(tasks.map((task) => [task.id, task]));
  if (nodes.size !== tasks.length) {
    throw new BadRequestException("任务标识不能重复");
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (id: string) => {
    if (visiting.has(id)) {
      throw new BadRequestException("任务依赖不能成环");
    }
    if (visited.has(id)) return;

    const task = nodes.get(id);
    if (!task) {
      throw new BadRequestException("依赖任务不存在");
    }

    visiting.add(id);
    for (const next of task.dependsOn) {
      visit(next);
    }
    visiting.delete(id);
    visited.add(id);
  };

  for (const task of tasks) {
    visit(task.id);
  }
}

@Injectable()
export class ProcessService implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private refreshJob?: Promise<void>;

  constructor(
    private readonly db: Database,
    private readonly recordService: RecordService,
    private readonly context: TaskContextService,
    private readonly pages: PageService,
  ) {}

  /** 启动后台定时轮询：每 5 秒检查一次运行中流程的等待条件变化 */
  onModuleInit() {
    this.timer = setInterval(() => {
      if (!this.refreshJob) {
        this.refreshJob = this.refreshPending()
          .catch((error) => logRefreshFailure(error))
          .finally(() => {
            this.refreshJob = undefined;
          });
      }
    }, 5000);
    this.timer.unref();
  }

  /** 模块销毁时停止定时轮询并等待在途刷新任务结束 */
  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    await this.refreshJob;
  }

  /** 校验并加载工作空间下的有效活跃成员 */
  async member(tx: Transaction, actor: Actor, id: string): Promise<Actor> {
    const { rows } = await tx.query(
      "SELECT id,workspace_id,name,username,role FROM users WHERE id=$1 AND workspace_id=$2 AND active",
      [id, actor.workspaceId],
    );
    const row = rows[0];
    if (!row) {
      throw new BadRequestException("任务处理成员已不可用");
    }
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      name: row.name,
      username: row.username,
      role: row.role,
    };
  }

  /** 创建流程实例（外部入口，仅管理员可用） */
  async create(actor: Actor, body: unknown) {
    requireAdmin(actor);
    object(body);
    object(body.spec);
    object(body.bindings);
    uuid(body.requestId);

    return this.db.transaction((tx) =>
      this.createIn(
        tx,
        actor,
        body.spec as ProcessSpec,
        body.bindings,
        body.requestId,
      ),
    );
  }

  /** 在事务内校验并创建流程实例、生成任务节点并执行首次状态调谐 */
  async createIn(
    tx: Transaction,
    actor: Actor,
    spec: ProcessSpec,
    bindings: Record<string, string>,
    requestId: string,
    source?: ProcessRuntimeSource,
  ) {
    title(spec.title);

    const maxTasks = source ? 300 : 30;
    const bindingCount = Object.keys(bindings).length;
    if (
      !Array.isArray(spec.tasks) ||
      !spec.tasks.length ||
      spec.tasks.length > maxTasks ||
      !bindingCount ||
      bindingCount > 30
    ) {
      throw new BadRequestException("任务或记录绑定数量不合法");
    }

    for (const [key, value] of Object.entries(bindings)) {
      identifier(key);
      uuid(value);
    }

    // 1. 校验每个任务节点的结构与配置合法性
    for (const task of spec.tasks) {
      object(task);
      identifier(task.id);
      title(task.title);
      uuid(task.assigneeId);
      identifier(task.recordBinding);

      if (
        !Array.isArray(task.dependsOn) ||
        task.dependsOn.length > 300 ||
        !bindings[task.recordBinding]
      ) {
        throw new BadRequestException("任务依赖或绑定不合法");
      }
      task.dependsOn.forEach(identifier);

      if (task.pageId) {
        uuid(task.pageId);
        if (!Number.isInteger(task.pageVersion) || task.pageVersion! < 1) {
          throw new BadRequestException("处理页面版本不合法");
        }
      }

      if (task.subformId || task.rowId) {
        identifier(task.subformId);
        uuid(task.rowId);
        if (!task.pageId) {
          throw new BadRequestException("明细任务需要指定处理页面");
        }
      }

      if (
        task.requiredFields &&
        (!Array.isArray(task.requiredFields) ||
          task.requiredFields.length > 120)
      ) {
        throw new BadRequestException("任务必填字段配置不合法");
      }
      task.requiredFields?.forEach(identifier);

      if (task.waitFor) {
        object(task.waitFor);
        identifier(task.waitFor.fieldId);
        if (
          !bindings[task.waitFor.recordBinding] ||
          !validConditionValue(task.waitFor.equals)
        ) {
          throw new BadRequestException("等待条件不合法");
        }
        if (task.waitFor.subformId || task.waitFor.rowId) {
          identifier(task.waitFor.subformId);
          uuid(task.waitFor.rowId);
        }
      }
    }

    checkTaskGraph(spec.tasks);

    // 2. 幂等锁与重复提交检查
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `process:${actor.workspaceId}:${requestId}`,
    ]);
    const hash = tokenHash(
      JSON.stringify({ spec, bindings, ...(source ? { source } : {}) }),
    );
    const { rows: priorRows } = await tx.query(
      "SELECT * FROM processes WHERE workspace_id=$1 AND request_id=$2",
      [actor.workspaceId, requestId],
    );
    const prior = priorRows[0];
    if (prior) {
      if (prior.request_hash !== hash) {
        throw new ConflictException("同一发起标识不能用于不同流程");
      }
      return this.viewIn(tx, actor, prior.id);
    }

    // 3. 锁定绑定记录并校验各任务处理人与等待条件字段
    const records = await this.lockBindings(tx, actor, bindings);
    for (const task of spec.tasks) {
      const member = await this.member(tx, actor, task.assigneeId);
      await this.context.load(
        tx,
        member,
        bindings[task.recordBinding]!,
        task,
        false,
      );

      if (task.waitFor) {
        const record = records.get(bindings[task.waitFor.recordBinding]!)!;
        const { rows: schemaRows } = await tx.query(
          "SELECT schema FROM definition_versions WHERE definition_id=$1 AND version=$2",
          [record.definition_id, record.definition_version],
        );
        const schema = schemaRows[0].schema as FormSchema;
        const fields = task.waitFor.subformId
          ? schema.fields.find((f) => f.id === task.waitFor!.subformId)
              ?.children
          : schema.fields;
        const waitField = fields?.find(
          (f) => f.id === task.waitFor!.fieldId && f.type !== "subform",
        );
        if (!waitField) {
          throw new BadRequestException("等待条件引用的字段不适用于已绑定记录");
        }
        scalar(waitField, task.waitFor.equals, false);

        if (task.waitFor.subformId) {
          const subformRows = record.values[task.waitFor.subformId] as
            FormValues[] | undefined;
          if (!subformRows?.some((row) => row._rowId === task.waitFor!.rowId)) {
            throw new BadRequestException("等待条件的明细行不存在");
          }
        }
      }
    }

    // 4. 写入流程主记录、任务明细与启动事件，并执行首次调谐
    const id = randomUUID();
    await tx.query(
      "INSERT INTO processes(id,workspace_id,request_id,request_hash,spec,bindings,status,created_by,template_id,template_version,application_id) VALUES($1,$2,$3,$4,$5,$6,'running',$7,$8,$9,$10)",
      [
        id,
        actor.workspaceId,
        requestId,
        hash,
        spec,
        bindings,
        actor.id,
        source?.templateId || null,
        source?.templateVersion || null,
        source?.applicationId || null,
      ],
    );

    for (const task of spec.tasks) {
      await tx.query(
        "INSERT INTO tasks(id,process_id,task_key,assignee_id,record_id,spec,status,subform_id,row_id) VALUES($1,$2,$3,$4,$5,$6,'waiting',$7,$8)",
        [
          randomUUID(),
          id,
          task.id,
          task.assigneeId,
          bindings[task.recordBinding],
          task,
          task.subformId || null,
          task.rowId || null,
        ],
      );
    }

    await this.event(tx, id, null, actor.id, "started", "流程已发起");
    await this.reconcile(tx, actor, id, records, bindings);
    return this.viewIn(tx, actor, id);
  }

  /** 按固定顺序加锁流程绑定的表单定义与业务记录，并校验记录处于有效非草稿状态 */
  async lockBindings(
    tx: Transaction,
    actor: Actor,
    bindings: Record<string, string>,
    write = false,
  ) {
    const ids = [...new Set(Object.values(bindings))].sort();
    const { rows } = await tx.query(
      "SELECT * FROM records WHERE id=ANY($1::uuid[]) AND workspace_id=$2 ORDER BY id",
      [ids, actor.workspaceId],
    );
    if (rows.length !== ids.length) {
      throw new NotFoundException("绑定记录不存在或不可访问");
    }

    const definitionIds = [
      ...new Set(rows.map((row) => row.definition_id as string)),
    ].sort();
    for (const id of definitionIds) {
      await this.recordService.definition(tx, actor, id, "FOR SHARE");
    }

    const lockMode = write ? "UPDATE" : "SHARE";
    const { rows: locked } = await tx.query(
      `SELECT * FROM records WHERE id=ANY($1::uuid[]) ORDER BY id FOR ${lockMode}`,
      [ids],
    );
    for (const row of locked) {
      requireActiveRecord({ state: row.state });
    }
    return new Map<string, any>(locked.map((row) => [row.id, row]));
  }

  /** 记录流程与任务状态变更事件 */
  private async event(
    tx: Transaction,
    processId: string,
    taskId: string | null,
    actorId: string | null,
    action: string,
    detail: string,
  ) {
    await tx.query(
      "INSERT INTO process_events(id,process_id,task_id,actor_id,action,detail) VALUES($1,$2,$3,$4,$5,$6)",
      [randomUUID(), processId, taskId, actorId, action, detail],
    );
  }

  /** 重新评估并同步流程下所有未完成任务的状态（ready / waiting / blocked）及流程整体状态 */
  private async reconcile(
    tx: Transaction,
    actor: Actor,
    id: string,
    records: Map<string, any>,
    bindings: Record<string, string>,
  ) {
    const { rows: tasks } = await tx.query(
      "SELECT * FROM tasks WHERE process_id=$1 ORDER BY task_key",
      [id],
    );
    const done = new Set(
      tasks.filter((t) => t.status === "completed").map((t) => t.task_key),
    );
    // 按依赖顺序处理自动抄送，使连续抄送与后续办理在本次事务内一起推进。
    const ordered: typeof tasks = [];
    const visited = new Set<string>();
    const visit = (task: any) => {
      if (visited.has(task.task_key)) return;
      visited.add(task.task_key);
      for (const key of task.spec.dependsOn) {
        const prior = tasks.find((item) => item.task_key === key);
        if (prior) visit(prior);
      }
      ordered.push(task);
    };
    tasks.forEach(visit);

    for (const task of ordered) {
      if (task.status === "completed") continue;

      const spec = task.spec as TaskSpec;
      let status = "ready";
      let reason = "";

      try {
        const assignee = await this.member(tx, actor, task.assignee_id);
        await this.context.load(tx, assignee, task.record_id, spec);

        const dependencies = spec.dependsOn.filter((key) => !done.has(key));
        if (dependencies.length) {
          status = "waiting";
          reason = `等待 ${dependencies.length} 项前置任务完成`;
        }

        if (spec.waitFor) {
          const record = records.get(bindings[spec.waitFor.recordBinding]!);
          if (!record || record.archived_at || record.state === "draft") {
            throw new BadRequestException("等待的业务记录已不可用");
          }

          const values = spec.waitFor.subformId
            ? (record.values[spec.waitFor.subformId] as FormValues[])?.find(
                (row) => row._rowId === spec.waitFor!.rowId,
              )
            : record.values;
          if (!values || !Object.hasOwn(values, spec.waitFor.fieldId)) {
            throw new BadRequestException("等待条件引用的数据已不可用");
          }

          const currentVal = choiceConditionValue(values[spec.waitFor.fieldId]);
          if (!equalFieldValues(currentVal, spec.waitFor.equals)) {
            status = "waiting";
            reason = reason
              ? `${reason}，并等待业务条件满足`
              : "等待业务条件满足";
          }
        }
      } catch (error) {
        if (
          !(error instanceof ForbiddenException) &&
          !(error instanceof NotFoundException) &&
          !(error instanceof BadRequestException) &&
          !(error instanceof ConflictException)
        ) {
          throw error;
        }
        status = "blocked";
        reason = (error as Error).message;
      }

      if (status === "ready" && spec.kind === "copy") {
        await tx.query(
          "UPDATE tasks SET status='completed',reason=NULL,completed_at=now() WHERE id=$1",
          [task.id],
        );
        await this.event(tx, id, task.id, null, "copied", "已抄送");
        task.status = "completed";
        done.add(task.task_key);
        continue;
      }

      if (task.status !== status || (task.reason || "") !== reason) {
        await tx.query("UPDATE tasks SET status=$2,reason=$3 WHERE id=$1", [
          task.id,
          status,
          reason || null,
        ]);
        await this.event(
          tx,
          id,
          task.id,
          null,
          status,
          reason || "任务已可处理",
        );
      }
    }

    const nextProcessStatus = tasks.every((t) => t.status === "completed")
      ? "completed"
      : "running";
    await tx.query(
      "UPDATE processes SET status=$2,checked_at=now(),refresh_error=NULL WHERE id=$1",
      [id, nextProcessStatus],
    );
  }

  /** 查询流程并校验当前用户是否有权访问该流程（管理员或至少是其中一个任务的处理人） */
  private async process(tx: Transaction, actor: Actor, id: string) {
    uuid(id);
    const { rows } = await tx.query(
      "SELECT * FROM processes WHERE id=$1 AND workspace_id=$2",
      [id, actor.workspaceId],
    );
    const row = rows[0];
    if (!row) throw new NotFoundException("流程不存在");

    if (actor.role !== "admin" && row.created_by !== actor.id) {
      const assigned = await tx.query(
        `SELECT 1 FROM tasks WHERE process_id=$1 AND assignee_id=$2
          AND (COALESCE(spec->>'kind','approval') <> 'copy' OR status='completed')
        UNION ALL SELECT 1 FROM process_events WHERE process_id=$1 AND actor_id=$2 AND action='delegated' LIMIT 1`,
        [id, actor.id],
      );
      if (!assigned.rowCount) {
        throw new ForbiddenException("没有此流程的任务权限");
      }
    }
    return row;
  }

  /** 办理限于当前处理人或管理员；读取时允许曾委托该任务的成员查看。 */
  private async task(
    tx: Transaction,
    actor: Actor,
    processId: string,
    taskId: string,
    allowDelegatedRead = false,
  ) {
    uuid(taskId);
    const { rows } = await tx.query(
      "SELECT * FROM tasks WHERE id=$1 AND process_id=$2",
      [taskId, processId],
    );
    const task = rows[0];
    if (!task) {
      throw new ForbiddenException("不是此任务的处理人");
    }
    if (actor.role !== "admin" && task.assignee_id !== actor.id) {
      const delegated = allowDelegatedRead
        ? await tx.query(
            "SELECT 1 FROM process_events WHERE process_id=$1 AND task_id=$2 AND actor_id=$3 AND action='delegated' LIMIT 1",
            [processId, taskId, actor.id],
          )
        : undefined;
      if (!delegated?.rowCount) {
        throw new ForbiddenException("不是此任务的处理人");
      }
    }
    if (
      actor.role !== "admin" &&
      task.spec.kind === "copy" &&
      task.status !== "completed"
    ) {
      throw new ForbiddenException("此记录尚未抄送给你");
    }
    return task;
  }

  /** 构造流程详情视图（按当前用户角色过滤可见任务与关联事件） */
  async viewIn(
    tx: Transaction,
    actor: Actor,
    id: string,
  ): Promise<ProcessView> {
    const process = await this.process(tx, actor, id);

    const { rows: tasks } = await tx.query(
      "SELECT t.*,u.name AS assignee_name FROM tasks t JOIN users u ON u.id=t.assignee_id WHERE t.process_id=$1 ORDER BY t.task_key",
      [id],
    );
    const position = new Map<string, number>(
      (process.spec.tasks as TaskSpec[]).map((task, index) => [task.id, index]),
    );
    tasks.sort(
      (a, b) =>
        (position.get(a.task_key) ?? 0) - (position.get(b.task_key) ?? 0),
    );

    const delegated = await tx.query(
      "SELECT DISTINCT task_id FROM process_events WHERE process_id=$1 AND actor_id=$2 AND action='delegated'",
      [id, actor.id],
    );
    const delegatedIds = new Set(delegated.rows.map((row) => row.task_id));
    const visible = tasks.filter((t) => {
      if (
        actor.role === "admin" ||
        process.created_by === actor.id ||
        delegatedIds.has(t.id)
      )
        return true;
      return (
        t.assignee_id === actor.id &&
        (t.spec.kind !== "copy" || t.status === "completed")
      );
    });
    const visibleIds = visible.map((t) => t.id);

    const eventsSql = `
      SELECT e.*, t.spec->>'title' AS task_title, u.name AS actor_name
      FROM process_events e
      LEFT JOIN tasks t ON t.id = e.task_id
      LEFT JOIN users u ON u.id = e.actor_id
      WHERE e.process_id = $1
        AND (e.task_id IS NULL OR e.task_id = ANY($2::uuid[]))
      ORDER BY e.sequence DESC
      LIMIT 100
    `;
    const { rows: eventRows } = await tx.query(eventsSql, [id, visibleIds]);
    const events = eventRows.reverse();

    return {
      id,
      title: process.spec.title,
      status: process.status,
      createdAt: process.created_at.toISOString(),
      checkedAt: process.checked_at?.toISOString(),
      ...(process.refresh_error ? { refreshError: process.refresh_error } : {}),
      ...(process.template_id
        ? {
            templateId: process.template_id,
            templateVersion: process.template_version,
            applicationId: process.application_id,
          }
        : {}),
      summary: {
        total: tasks.length,
        completed: tasks.filter((t) => t.status === "completed").length,
        ready: tasks.filter((t) => t.status === "ready").length,
        waiting: tasks.filter((t) => t.status === "waiting").length,
        blocked: tasks.filter((t) => t.status === "blocked").length,
      },
      tasks: visible.map((t) => ({
        id: t.id,
        key: t.task_key,
        title: t.spec.title,
        kind: t.spec.kind || "approval",
        canOpen:
          actor.role === "admin" ||
          delegatedIds.has(t.id) ||
          (t.assignee_id === actor.id &&
            (t.spec.kind !== "copy" || t.status === "completed")),
        canHandle:
          t.status === "ready" &&
          t.spec.kind !== "copy" &&
          (actor.role === "admin" || t.assignee_id === actor.id),
        recordId: t.record_id,
        status: t.status,
        ...(t.reason ? { reason: t.reason } : {}),
        assigneeName: t.assignee_name,
        ...(t.spec.pageId
          ? { pageId: t.spec.pageId, pageVersion: t.spec.pageVersion }
          : {}),
        ...(t.row_id ? { rowId: t.row_id, subformId: t.subform_id } : {}),
        ...(t.completed_at
          ? { completedAt: t.completed_at.toISOString() }
          : {}),
      })),
      events: events.map((e) => ({
        id: e.id,
        action: e.action,
        taskTitle: e.task_title,
        actorName: e.actor_name,
        detail: e.detail,
        createdAt: e.created_at.toISOString(),
      })),
    };
  }

  /** 正文优先采用本人待办；申请人查看原申请单，其他参与人沿用自己的节点视野。 */
  async record(actor: Actor, id: string): Promise<RecordDetail> {
    return this.db.transaction(async (tx) => {
      const process = await this.process(tx, actor, id);
      const records = await this.lockBindings(tx, actor, process.bindings);
      await tx.query("SELECT id FROM processes WHERE id=$1 FOR UPDATE", [id]);
      await this.reconcile(tx, actor, id, records, process.bindings);
      const { rows: tasks } = await tx.query(
        `SELECT t.*, EXISTS (
           SELECT 1 FROM process_events e WHERE e.process_id=t.process_id
             AND e.task_id=t.id AND e.actor_id=$2 AND e.action='delegated'
         ) AS delegated
         FROM tasks t WHERE t.process_id=$1`,
        [id, actor.id],
      );
      const position = new Map<string, number>(
        (process.spec.tasks as TaskSpec[]).map((task, index) => [task.id, index]),
      );
      tasks.sort((a, b) => position.get(a.task_key)! - position.get(b.task_key)!);
      const current = tasks.find(
        (task) =>
          task.assignee_id === actor.id &&
          task.status === "ready" &&
          task.spec.kind !== "copy",
      );
      if (current) return this.context.record(tx, actor, id, current);

      if (
        process.submission_record_id &&
        (process.created_by === actor.id || actor.role === "admin")
      ) {
        let origin = process.spec.origin as
          | { pageId: string; pageVersion: number }
          | undefined;
        if (!origin) {
          // 旧实例仅在记录数据版本唯一对应一个原页面版本时恢复；否则使用记录自身结构。
          const versions = await tx.query(
            `SELECT v.page_id, v.version FROM process_templates t
             JOIN page_versions v ON v.page_id=t.start_page_id
             JOIN records r ON r.id=$1 AND r.definition_id=v.definition_id
               AND r.definition_version=v.definition_version
             WHERE t.id=$2 AND v.created_at<=$3 ORDER BY v.version DESC LIMIT 2`,
            [process.submission_record_id, process.template_id, process.created_at],
          );
          if (versions.rows.length === 1) {
            origin = {
              pageId: versions.rows[0].page_id,
              pageVersion: versions.rows[0].version,
            };
          }
        }
        const scope = origin
          ? await this.pages.recordScope(
              actor,
              origin.pageId,
              origin.pageVersion,
              tx,
              true,
            )
          : undefined;
        const detail = await this.recordService.detailIn(
          tx,
          actor,
          process.submission_record_id,
          scope,
        );
        if (!detail.access.read) {
          throw new ForbiddenException("当前没有申请记录的查看权限");
        }
        // 流程正文的申请视图始终只读；编辑只从当前待办的节点入口执行。
        detail.access.edit = false;
        for (const fieldId of Object.keys(detail.access.fields)) {
          if (detail.access.fields[fieldId] === "edit") {
            detail.access.fields[fieldId] = "read";
          }
        }
        for (const actions of Object.values(detail.rowActions || {})) {
          actions.add = false;
          actions.insert = false;
          actions.remove = false;
          actions.editExisting = false;
        }
        return detail;
      }

      const available = tasks.filter(
        (task) =>
          (actor.role === "admin" || task.assignee_id === actor.id) &&
          (task.spec.kind !== "copy" || task.status === "completed"),
      );
      const selected =
        available.find((task) => task.status === "ready") ||
        available.filter((task) => task.status === "completed").at(-1) ||
        available[0] ||
        tasks.find((task) => task.delegated);
      if (!selected) {
        throw new ForbiddenException("当前没有流程正文的查看权限");
      }
      return this.context.record(
        tx,
        actor,
        id,
        selected,
        actor.role !== "admin" && selected.assignee_id !== actor.id,
      );
    });
  }

  /** 获取流程详情，若传入 completeTaskId 则同时校验并完成该任务节点 */
  async get(actor: Actor, id: string, completeTaskId?: string) {
    return this.db.transaction(async (tx) => {
      const process = await this.process(tx, actor, id);
      const records = await this.lockBindings(tx, actor, process.bindings);
      await tx.query("SELECT id FROM processes WHERE id=$1 FOR UPDATE", [id]);
      await this.reconcile(tx, actor, id, records, process.bindings);

      if (completeTaskId) {
        const task = await this.task(tx, actor, id, completeTaskId);
        if (task.spec.kind === "copy")
          throw new ForbiddenException("抄送节点不需要办理");
        if (task.status !== "completed") {
          if (task.status !== "ready") {
            throw new ConflictException(
              task.reason || "依赖任务或业务条件尚未满足",
            );
          }
          await this.context.validateCompletion(
            tx,
            actor,
            task.record_id,
            task.spec,
          );
          await tx.query(
            "UPDATE tasks SET status='completed',reason=NULL,completed_at=now() WHERE id=$1",
            [task.id],
          );
          await this.event(
            tx,
            id,
            task.id,
            actor.id,
            "completed",
            "任务已完成",
          );
          await this.reconcile(tx, actor, id, records, process.bindings);
        }
      }
      return this.viewIn(tx, actor, id);
    });
  }

  /** 在任务节点上下文中获取组织成员/部门选项 */
  async taskOrganizationOptions(
    actor: Actor,
    id: string,
    taskId: string,
    body: unknown,
  ) {
    object(body);
    return this.db.transaction(async (tx) => {
      const process = await this.process(tx, actor, id);
      const records = await this.lockBindings(tx, actor, process.bindings);
      await tx.query("SELECT id FROM processes WHERE id=$1 FOR UPDATE", [id]);
      await this.reconcile(tx, actor, id, records, process.bindings);

      const task = await this.task(tx, actor, id, taskId);
      if (task.status !== "ready" || task.spec.kind === "copy") {
        throw new ForbiddenException("此任务当前不能修改业务数据");
      }

      const scope = await this.context.scope(actor, task.spec, tx);
      const record = records.get(task.record_id);
      return this.recordService.organizationOptions(
        actor,
        record.definition_id,
        { ...body, recordId: task.record_id },
        scope,
        tx,
      );
    });
  }

  /** 读取或修改任务节点绑定的业务记录 */
  async taskRecord(actor: Actor, id: string, taskId: string, body?: unknown) {
    return this.db.transaction(async (tx) => {
      // 保持与常规幂等命令一致的加锁顺序：先获取用户请求级咨询锁，再锁定业务记录
      if (body !== undefined) {
        object(body);
        uuid(body.requestId);
        await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          `${actor.id}:${body.requestId}`,
        ]);
      }

      const process = await this.process(tx, actor, id);
      const records = await this.lockBindings(
        tx,
        actor,
        process.bindings,
        body !== undefined,
      );
      await tx.query("SELECT id FROM processes WHERE id=$1 FOR UPDATE", [id]);
      await this.reconcile(tx, actor, id, records, process.bindings);

      const task = await this.task(tx, actor, id, taskId, body === undefined);
      if (body !== undefined) {
        const scope = await this.context.scope(actor, task.spec, tx);
        if (scope) {
          scope.taskId = task.id;
          scope.deferRequired = true;
        }

        const revision = records.get(task.record_id).revision;
        await this.recordService.patchRecord(
          actor,
          task.record_id,
          body,
          scope,
          tx,
          () => {
            if (task.status !== "ready" || task.spec.kind === "copy") {
              throw new ConflictException(
                task.reason || "此任务当前不能修改业务数据",
              );
            }
          },
        );

        const updated = (
          await this.recordService.loadRecord(tx, actor, task.record_id)
        ).row;
        if (updated.revision !== revision) {
          await this.event(
            tx,
            id,
            task.id,
            actor.id,
            "record-saved",
            "任务业务数据已保存",
          );
        }
        records.set(task.record_id, updated);
        await this.reconcile(tx, actor, id, records, process.bindings);
      }

      const latestTask = await this.task(tx, actor, id, taskId, body === undefined);
      return this.context.record(
        tx,
        actor,
        id,
        latestTask,
        actor.role !== "admin" && latestTask.assignee_id !== actor.id,
      );
    });
  }

  /** 仅返回可接手本任务的成员，不向普通成员开放完整组织管理接口。 */
  async delegateOptions(actor: Actor, id: string, taskId: string) {
    return this.db.transaction(async (tx) => {
      await this.process(tx, actor, id);
      const task = await this.task(tx, actor, id, taskId);
      if (task.status !== "ready" || task.spec.kind === "copy") {
        throw new ConflictException("只能委托当前可办理的任务");
      }
      const { rows } = await tx.query(
        "SELECT id,name,username,role FROM users WHERE workspace_id=$1 AND active AND id<>$2 ORDER BY name,id",
        [actor.workspaceId, task.assignee_id],
      );
      const candidates: { id: string; name: string }[] = [];
      for (const user of rows) {
        try {
          const recipient: Actor = { ...user, workspaceId: actor.workspaceId };
          await this.context.assertDelegateRecipient(
            tx,
            recipient,
            task.record_id,
            task.spec,
          );
          candidates.push({ id: user.id, name: user.name });
        } catch (error) {
          if (
            !(error instanceof ForbiddenException) &&
            !(error instanceof BadRequestException) &&
            !(error instanceof NotFoundException) &&
            !(error instanceof ConflictException)
          )
            throw error;
        }
      }
      return candidates;
    });
  }

  /** 仅委托当前待办；接收人须已有对应记录和字段权限，不因委托获得额外授权。 */
  async delegate(actor: Actor, id: string, taskId: string, body: unknown) {
    object(body);
    uuid(body.assigneeId);
    return this.db.transaction(async (tx) => {
      const process = await this.process(tx, actor, id);
      const records = await this.lockBindings(tx, actor, process.bindings);
      const locked = await tx.query(
        "SELECT spec FROM processes WHERE id=$1 FOR UPDATE",
        [id],
      );
      const currentSpec = locked.rows[0].spec;

      await this.reconcile(tx, actor, id, records, process.bindings);
      const task = await this.task(tx, actor, id, taskId);
      if (task.status !== "ready" || task.spec.kind === "copy")
        throw new ConflictException("只能委托当前可办理的任务");
      if (task.assignee_id === body.assigneeId)
        throw new BadRequestException("请选择其他处理人");
      const recipient = await this.member(tx, actor, body.assigneeId);
      const spec = { ...task.spec, assigneeId: recipient.id };
      await this.context.assertDelegateRecipient(
        tx,
        recipient,
        task.record_id,
        spec,
      );
      await tx.query("UPDATE tasks SET assignee_id=$2,spec=$3 WHERE id=$1", [
        task.id,
        recipient.id,
        spec,
      ]);
      const nextSpec = {
        ...currentSpec,
        tasks: currentSpec.tasks.map((item: TaskSpec) =>
          item.id === task.task_key ? spec : item,
        ),
      };
      await tx.query("UPDATE processes SET spec=$2 WHERE id=$1", [
        id,
        nextSpec,
      ]);
      await this.event(
        tx,
        id,
        task.id,
        actor.id,
        "delegated",
        `已委托给${recipient.name}`,
      );
      return this.viewIn(tx, actor, id);
    });
  }

  /** 按工作空间、应用与任务范围（待办 / 我发起的 / 我处理的）查询流程列表 */
  async list(
    actor: Actor,
    applicationId?: string,
    scope?: string,
  ): Promise<ProcessSummary[]> {
    if (applicationId) uuid(applicationId);
    if (
      scope &&
      !["todo", "started", "handled", "copied", "delegation"].includes(scope)
    ) {
      throw new BadRequestException("流程范围无效");
    }

    // 先限定可见流程，再批量补充人员元数据；列表不读取业务正文。
    const sql = `
      WITH visible_processes AS (
        SELECT
          p.id,
          p.spec->>'title' AS title,
          p.status,
          p.template_version,
          p.created_at,
          p.created_by
        FROM processes p
        WHERE p.workspace_id = $1
          AND ($4::uuid IS NULL OR p.application_id = $4)
          AND (
            $2 = 'admin'
            OR p.created_by = $3
            OR EXISTS (
              SELECT 1 FROM tasks t
              WHERE t.process_id = p.id AND t.assignee_id = $3
                AND (COALESCE(t.spec->>'kind','approval') <> 'copy' OR t.status='completed')
            )
            OR EXISTS (SELECT 1 FROM process_events e WHERE e.process_id=p.id AND e.actor_id=$3 AND e.action='delegated')
          )
          AND (
            $5::text IS NULL
            OR (
              $5 = 'todo'
              AND EXISTS (
                SELECT 1 FROM tasks t
                WHERE t.process_id = p.id
                  AND t.assignee_id = $3
                  AND t.status IN ('ready', 'blocked')
                  AND COALESCE(t.spec->>'kind','approval') <> 'copy'
              )
            )
            OR ($5 = 'started' AND p.created_by = $3)
            OR ($5 = 'copied' AND EXISTS (
              SELECT 1 FROM tasks t WHERE t.process_id=p.id AND t.assignee_id=$3 AND t.spec->>'kind'='copy' AND t.status='completed'
            ))
            OR ($5 = 'delegation' AND (
              EXISTS (SELECT 1 FROM tasks t WHERE t.process_id=p.id AND t.assignee_id=$3 AND t.status='ready' AND COALESCE(t.spec->>'kind','approval')<>'copy')
              OR EXISTS (SELECT 1 FROM process_events e WHERE e.process_id=p.id AND e.actor_id=$3 AND e.action='delegated')
            ))
            OR (
              $5 = 'handled'
              AND EXISTS (
                SELECT 1 FROM process_events e
                WHERE e.process_id = p.id
                  AND e.actor_id = $3
                  AND e.action = 'completed'
              )
            )
          )
        ORDER BY p.created_at DESC, p.id DESC
        LIMIT 100
      )
      SELECT
        p.id,
        p.title,
        p.status,
        p.template_version AS "templateVersion",
        p.created_at AS "createdAt",
        creator.name AS "createdByName",
        COALESCE(
          array_agg(DISTINCT assignee.name ORDER BY assignee.name)
            FILTER (WHERE assignee.id IS NOT NULL),
          ARRAY[]::text[]
        ) AS "currentAssigneeNames"
      FROM visible_processes p
      LEFT JOIN users creator ON creator.id = p.created_by
      LEFT JOIN tasks t ON t.process_id = p.id
        AND t.status IN ('ready', 'blocked')
        AND COALESCE(t.spec->>'kind', 'approval') <> 'copy'
        AND (
          $2 = 'admin'
          OR p.created_by = $3
          OR t.assignee_id = $3
          OR EXISTS (
            SELECT 1 FROM process_events e
            WHERE e.process_id = p.id AND e.task_id = t.id
              AND e.actor_id = $3 AND e.action = 'delegated'
          )
        )
      LEFT JOIN users assignee ON assignee.id = t.assignee_id
      GROUP BY p.id, p.title, p.status, p.template_version, p.created_at, creator.name
      ORDER BY p.created_at DESC, p.id DESC
    `;
    const { rows } = await this.db.query(sql, [
      actor.workspaceId,
      actor.role,
      actor.id,
      applicationId || null,
      scope || null,
    ]);
    return rows.map((row) => ({
      ...row,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  /** 后台定时扫描运行中的流程并刷新等待条件与任务状态 */
  async refreshPending() {
    const sql = `
      SELECT
        p.id,
        p.workspace_id,
        u.id AS actor_id,
        u.name,
        u.username
      FROM processes p
      JOIN LATERAL (
        SELECT id, name, username
        FROM users
        WHERE workspace_id = p.workspace_id AND role = 'admin' AND active
        ORDER BY id
        LIMIT 1
      ) u ON true
      WHERE p.status = 'running'
      ORDER BY p.checked_at NULLS FIRST, p.created_at
      LIMIT 20
    `;
    const { rows: pending } = await this.db.query(sql);

    for (const process of pending) {
      try {
        await this.get(
          {
            id: process.actor_id,
            name: process.name,
            username: process.username,
            role: "admin",
            workspaceId: process.workspace_id,
          },
          process.id,
        );
      } catch (error) {
        logRefreshFailure(error, process);
        await this.db.query(
          "UPDATE processes SET checked_at=now(),refresh_error='条件检查暂时失败，请重试检查' WHERE id=$1",
          [process.id],
        );
      }
    }
  }
}
