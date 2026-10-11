import { requireActiveRecord } from "./record-state";
import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { scalar } from "./field-values";
import { equalFieldValues, validConditionValue, choiceConditionValue } from "@platform/contracts";
import { randomUUID } from "node:crypto";
import type { FormSchema, FormValues, ProcessRuntimeSource, ProcessSpec, ProcessView, TaskSpec } from "@platform/contracts";
import { Actor, requireAdmin, tokenHash } from "./auth";
import { Database, Transaction } from "./database";
import { PlatformService } from "./platform";
import { TaskContextService } from "./task-context";
import { identifier, object, uuid, title } from "./schema";

export function checkTaskGraph(tasks: { id: string; dependsOn: string[] }[]) {
  const nodes = new Map(tasks.map(task => [task.id, task]));
  if (nodes.size !== tasks.length) throw new BadRequestException("任务标识不能重复");
  const visiting = new Set<string>(), visited = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) throw new BadRequestException("任务依赖不能成环");
    if (visited.has(id)) return;
    const task = nodes.get(id);
    if (!task) throw new BadRequestException("依赖任务不存在");
    visiting.add(id);
    for (const next of task.dependsOn) visit(next);
    visiting.delete(id); visited.add(id);
  };
  for (const task of tasks) visit(task.id);
}

@Injectable()
export class ProcessService implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private refreshJob?: Promise<void>;
  private readonly logger = new Logger(ProcessService.name);
  constructor(private readonly db: Database, private readonly platform: PlatformService, private readonly context: TaskContextService) {}
  onModuleInit() { this.timer = setInterval(() => { if (!this.refreshJob) { this.refreshJob = this.refreshPending().catch(() => this.logger.warn("任务条件检查暂时失败，将在下一轮重试")).finally(() => { this.refreshJob = undefined; }); } }, 5000); this.timer.unref(); }
  async onModuleDestroy() { if (this.timer) clearInterval(this.timer); await this.refreshJob; }
  async member(tx: Transaction, actor: Actor, id: string): Promise<Actor> {
    const row = (await tx.query("SELECT id,workspace_id,name,username,role FROM users WHERE id=$1 AND workspace_id=$2 AND active", [id, actor.workspaceId])).rows[0];
    if (!row) throw new BadRequestException("任务处理成员已不可用");
    return { id: row.id, workspaceId: row.workspace_id, name: row.name, username: row.username, role: row.role };
  }
  async create(actor: Actor, body: unknown) {
    requireAdmin(actor); object(body); object(body.spec); object(body.bindings); uuid(body.requestId);
    return this.db.transaction(tx => this.createIn(tx, actor, body.spec as ProcessSpec, body.bindings, body.requestId));
  }
  async createIn(tx: Transaction, actor: Actor, spec: ProcessSpec, bindings: Record<string, string>, requestId: string, source?: ProcessRuntimeSource) {
    title(spec.title);
    if (!Array.isArray(spec.tasks) || !spec.tasks.length || spec.tasks.length > (source ? 300 : 30) || !Object.keys(bindings).length || Object.keys(bindings).length > 30) throw new BadRequestException("任务或记录绑定数量不合法");
    for (const [key, value] of Object.entries(bindings)) { identifier(key); uuid(value); }
    for (const task of spec.tasks) {
      object(task); identifier(task.id); title(task.title); uuid(task.assigneeId); identifier(task.recordBinding);
      if (!Array.isArray(task.dependsOn) || task.dependsOn.length > 300 || !bindings[task.recordBinding]) throw new BadRequestException("任务依赖或绑定不合法");
      task.dependsOn.forEach(identifier);
      if (task.pageId) { uuid(task.pageId); if (!Number.isInteger(task.pageVersion) || task.pageVersion! < 1) throw new BadRequestException("处理页面版本不合法"); }
      if (task.subformId || task.rowId) { identifier(task.subformId); uuid(task.rowId); if (!task.pageId) throw new BadRequestException("明细任务需要指定处理页面"); }
      if (task.requiredFields && (!Array.isArray(task.requiredFields) || task.requiredFields.length > 120)) throw new BadRequestException("任务必填字段配置不合法");
      task.requiredFields?.forEach(identifier);
      if (task.waitFor) {
        object(task.waitFor); identifier(task.waitFor.fieldId);
        if (!bindings[task.waitFor.recordBinding] || !validConditionValue(task.waitFor.equals)) throw new BadRequestException("等待条件不合法");
        if (task.waitFor.subformId || task.waitFor.rowId) { identifier(task.waitFor.subformId); uuid(task.waitFor.rowId); }
      }
    }
    checkTaskGraph(spec.tasks);
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`process:${actor.workspaceId}:${requestId}`]);
    const hash = tokenHash(JSON.stringify({ spec, bindings, ...(source ? { source } : {}) }));
    const prior = (await tx.query("SELECT * FROM processes WHERE workspace_id=$1 AND request_id=$2", [actor.workspaceId, requestId])).rows[0];
    if (prior) { if (prior.request_hash !== hash) throw new ConflictException("同一发起标识不能用于不同流程"); return this.viewIn(tx, actor, prior.id); }
    const records = await this.lockBindings(tx, actor, bindings);
    for (const task of spec.tasks) {
      const member = await this.member(tx, actor, task.assigneeId);
      await this.context.load(tx, member, bindings[task.recordBinding]!, task, false);
      if (task.waitFor) {
        const record = records.get(bindings[task.waitFor.recordBinding]!)!;
        const schema = (await tx.query("SELECT schema FROM definition_versions WHERE definition_id=$1 AND version=$2", [record.definition_id, record.definition_version])).rows[0].schema as FormSchema;
        const fields = task.waitFor.subformId ? schema.fields.find(f => f.id === task.waitFor!.subformId)?.children : schema.fields;
        const waitField = fields?.find(f => f.id === task.waitFor!.fieldId && f.type !== "subform");
        if (!waitField) throw new BadRequestException("等待条件引用的字段不适用于已绑定记录");
        scalar(waitField, task.waitFor.equals, false);
        if (task.waitFor.subformId && !(record.values[task.waitFor.subformId] as FormValues[])?.some(row => row._rowId === task.waitFor!.rowId)) throw new BadRequestException("等待条件的明细行不存在");
      }
    }
    const id = randomUUID();
    await tx.query("INSERT INTO processes(id,workspace_id,request_id,request_hash,spec,bindings,status,created_by,template_id,template_version,application_id) VALUES($1,$2,$3,$4,$5,$6,'running',$7,$8,$9,$10)", [id, actor.workspaceId, requestId, hash, spec, bindings, actor.id, source?.templateId || null, source?.templateVersion || null, source?.applicationId || null]);
    for (const task of spec.tasks) await tx.query("INSERT INTO tasks(id,process_id,task_key,assignee_id,record_id,spec,status,subform_id,row_id) VALUES($1,$2,$3,$4,$5,$6,'waiting',$7,$8)", [randomUUID(), id, task.id, task.assigneeId, bindings[task.recordBinding], task, task.subformId || null, task.rowId || null]);
    await this.event(tx, id, null, actor.id, "started", "流程已发起");
    await this.reconcile(tx, actor, id, records, bindings);
    return this.viewIn(tx, actor, id);
  }
  async lockBindings(tx: Transaction, actor: Actor, bindings: Record<string, string>, write = false) {
    const ids = [...new Set(Object.values(bindings))].sort();
    const rows = (await tx.query("SELECT * FROM records WHERE id=ANY($1::uuid[]) AND workspace_id=$2 ORDER BY id", [ids, actor.workspaceId])).rows;
    if (rows.length !== ids.length) throw new NotFoundException("绑定记录不存在或不可访问");
    for (const id of [...new Set(rows.map(row => row.definition_id as string))].sort()) await this.platform.definition(tx, actor, id, "FOR SHARE");
    const locked = (await tx.query(`SELECT * FROM records WHERE id=ANY($1::uuid[]) ORDER BY id FOR ${write ? 'UPDATE' : 'SHARE'}`, [ids])).rows;
    for (const row of locked) requireActiveRecord({ state: row.state });
    return new Map<string, any>(locked.map(row => [row.id, row]));
  }
  private async event(tx: Transaction, processId: string, taskId: string | null, actorId: string | null, action: string, detail: string) {
    await tx.query("INSERT INTO process_events(id,process_id,task_id,actor_id,action,detail) VALUES($1,$2,$3,$4,$5,$6)", [randomUUID(), processId, taskId, actorId, action, detail]);
  }
  private async reconcile(tx: Transaction, actor: Actor, id: string, records: Map<string, any>, bindings: Record<string, string>) {
    const tasks = (await tx.query("SELECT * FROM tasks WHERE process_id=$1 ORDER BY task_key", [id])).rows;
    const done = new Set(tasks.filter(t => t.status === "completed").map(t => t.task_key));
    for (const task of tasks) {
      if (task.status === "completed") continue;
      const spec = task.spec as TaskSpec;
      let status = "ready", reason = "";
      try {
        await this.context.load(tx, await this.member(tx, actor, task.assignee_id), task.record_id, spec);
        const dependencies = spec.dependsOn.filter(key => !done.has(key));
        if (dependencies.length) { status = "waiting"; reason = `等待 ${dependencies.length} 项前置任务完成`; }
        if (spec.waitFor) {
          const record = records.get(bindings[spec.waitFor.recordBinding]!);
          if (!record || record.archived_at || record.state === "draft") throw new BadRequestException("等待的业务记录已不可用");
          const values = spec.waitFor.subformId ? (record.values[spec.waitFor.subformId] as FormValues[])?.find(row => row._rowId === spec.waitFor!.rowId) : record.values;
          if (!values || !Object.hasOwn(values, spec.waitFor.fieldId)) throw new BadRequestException("等待条件引用的数据已不可用");
          if (!equalFieldValues(choiceConditionValue(values[spec.waitFor.fieldId]), spec.waitFor.equals)) { status = "waiting"; reason = reason ? `${reason}，并等待业务条件满足` : "等待业务条件满足"; }
        }
      } catch (error) {
        if (!(error instanceof ForbiddenException) && !(error instanceof NotFoundException) && !(error instanceof BadRequestException) && !(error instanceof ConflictException)) throw error;
        status = "blocked"; reason = (error as Error).message;
      }
      if (task.status !== status || (task.reason || "") !== reason) {
        await tx.query("UPDATE tasks SET status=$2,reason=$3 WHERE id=$1", [task.id, status, reason || null]);
        await this.event(tx, id, task.id, null, status, reason || "任务已可处理");
      }
    }
    await tx.query("UPDATE processes SET status=$2,checked_at=now(),refresh_error=NULL WHERE id=$1", [id, tasks.every(t => t.status === "completed") ? "completed" : "running"]);
  }
  private async process(tx: Transaction, actor: Actor, id: string) {
    uuid(id);
    const row = (await tx.query("SELECT * FROM processes WHERE id=$1 AND workspace_id=$2", [id, actor.workspaceId])).rows[0];
    if (!row) throw new NotFoundException("流程不存在");
    if (actor.role !== "admin" && !(await tx.query("SELECT 1 FROM tasks WHERE process_id=$1 AND assignee_id=$2 LIMIT 1", [id, actor.id])).rowCount) throw new ForbiddenException("没有此流程的任务权限");
    return row;
  }
  private async task(tx: Transaction, actor: Actor, processId: string, taskId: string) {
    uuid(taskId);
    const task = (await tx.query("SELECT * FROM tasks WHERE id=$1 AND process_id=$2", [taskId, processId])).rows[0];
    if (!task || (actor.role !== "admin" && task.assignee_id !== actor.id)) throw new ForbiddenException("不是此任务的处理人");
    return task;
  }
  async viewIn(tx: Transaction, actor: Actor, id: string): Promise<ProcessView> {
    const process = await this.process(tx, actor, id);
    const tasks = (await tx.query("SELECT t.*,u.name AS assignee_name FROM tasks t JOIN users u ON u.id=t.assignee_id WHERE t.process_id=$1 ORDER BY t.task_key", [id])).rows;
    const position = new Map<string, number>((process.spec.tasks as TaskSpec[]).map((task, index) => [task.id, index]));
    tasks.sort((a, b) => (position.get(a.task_key) ?? 0) - (position.get(b.task_key) ?? 0));
    const visible = tasks.filter(t => actor.role === "admin" || t.assignee_id === actor.id), visibleIds = visible.map(t => t.id);
    const events = (await tx.query("SELECT e.*,t.spec->>'title' AS task_title,u.name AS actor_name FROM process_events e LEFT JOIN tasks t ON t.id=e.task_id LEFT JOIN users u ON u.id=e.actor_id WHERE e.process_id=$1 AND (e.task_id IS NULL OR e.task_id=ANY($2::uuid[])) ORDER BY e.sequence DESC LIMIT 100", [id, visibleIds])).rows.reverse();
    return { id, title: process.spec.title, status: process.status, createdAt: process.created_at.toISOString(), checkedAt: process.checked_at?.toISOString(), ...(process.refresh_error ? { refreshError: process.refresh_error } : {}), ...(process.template_id ? { templateId: process.template_id, templateVersion: process.template_version, applicationId: process.application_id } : {}),
      summary: { total: tasks.length, completed: tasks.filter(t => t.status === "completed").length, ready: tasks.filter(t => t.status === "ready").length, waiting: tasks.filter(t => t.status === "waiting").length, blocked: tasks.filter(t => t.status === "blocked").length },
      tasks: visible.map(t => ({ id: t.id, key: t.task_key, title: t.spec.title, recordId: t.record_id, status: t.status, ...(t.reason ? { reason: t.reason } : {}), assigneeName: t.assignee_name, ...(t.spec.pageId ? { pageId: t.spec.pageId, pageVersion: t.spec.pageVersion } : {}), ...(t.row_id ? { rowId: t.row_id, subformId: t.subform_id } : {}), ...(t.completed_at ? { completedAt: t.completed_at.toISOString() } : {}) })),
      events: events.map(e => ({ id: e.id, action: e.action, taskTitle: e.task_title, actorName: e.actor_name, detail: e.detail, createdAt: e.created_at.toISOString() })),
    };
  }
  async get(actor: Actor, id: string, completeTaskId?: string) {
    return this.db.transaction(async tx => {
      const process = await this.process(tx, actor, id);
      const records = await this.lockBindings(tx, actor, process.bindings);
      await tx.query("SELECT id FROM processes WHERE id=$1 FOR UPDATE", [id]);
      await this.reconcile(tx, actor, id, records, process.bindings);
      if (completeTaskId) {
        const task = await this.task(tx, actor, id, completeTaskId);
        if (task.status !== "completed") {
          if (task.status !== "ready") throw new ConflictException(task.reason || "依赖任务或业务条件尚未满足");
          await this.context.validateCompletion(tx, actor, task.record_id, task.spec);
          await tx.query("UPDATE tasks SET status='completed',reason=NULL,completed_at=now() WHERE id=$1", [task.id]);
          await this.event(tx, id, task.id, actor.id, "completed", "任务已完成");
          await this.reconcile(tx, actor, id, records, process.bindings);
        }
      }
      return this.viewIn(tx, actor, id);
    });
  }
  async taskOrganizationOptions(actor: Actor, id: string, taskId: string, body: unknown) {
    object(body);
    return this.db.transaction(async tx => {
      const process = await this.process(tx, actor, id);
      const records = await this.lockBindings(tx, actor, process.bindings);
      await tx.query("SELECT id FROM processes WHERE id=$1 FOR UPDATE", [id]);
      await this.reconcile(tx, actor, id, records, process.bindings);
      const task = await this.task(tx, actor, id, taskId);
      if (task.status !== "ready") throw new ForbiddenException("此任务当前不能修改业务数据");
      const scope = await this.context.scope(actor, task.spec, tx);
      const record = records.get(task.record_id);
      return this.platform.organizationOptions(actor, record.definition_id, { ...body, recordId: task.record_id }, scope, tx);
    });
  }
  async taskRecord(actor: Actor, id: string, taskId: string, body?: unknown) {
    return this.db.transaction(async tx => {
      // Match ordinary command lock order before taking record locks.
      if (body !== undefined) {
        object(body); uuid(body.requestId);
        await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`${actor.id}:${body.requestId}`]);
      }
      const process = await this.process(tx, actor, id);
      const records = await this.lockBindings(tx, actor, process.bindings, body !== undefined);
      await tx.query("SELECT id FROM processes WHERE id=$1 FOR UPDATE", [id]);
      await this.reconcile(tx, actor, id, records, process.bindings);
      const task = await this.task(tx, actor, id, taskId);
      if (body !== undefined) {
        const scope = await this.context.scope(actor, task.spec, tx);
        if (scope) { scope.taskId = task.id; scope.deferRequired = true; }
        const revision = records.get(task.record_id).revision;
        await this.platform.patchRecord(actor, task.record_id, body, scope, tx, () => {
          if (task.status !== "ready") throw new ConflictException(task.reason || "此任务当前不能修改业务数据");
        });
        const updated = (await this.platform.loadRecord(tx, actor, task.record_id)).row;
        if (updated.revision !== revision) await this.event(tx, id, task.id, actor.id, "record-saved", "任务业务数据已保存");
        records.set(task.record_id, updated);
        await this.reconcile(tx, actor, id, records, process.bindings);
      }
      return this.context.record(tx, actor, id, await this.task(tx, actor, id, taskId));
    });
  }
  async list(actor: Actor, applicationId?: string) {
    if (applicationId) uuid(applicationId);
    return (await this.db.query("SELECT p.id,p.spec->>'title' AS title,p.status,p.template_version AS \"templateVersion\" FROM processes p WHERE p.workspace_id=$1 AND ($4::uuid IS NULL OR p.application_id=$4) AND ($2='admin' OR EXISTS(SELECT 1 FROM tasks t WHERE t.process_id=p.id AND t.assignee_id=$3)) ORDER BY p.created_at DESC LIMIT 100", [actor.workspaceId, actor.role, actor.id, applicationId || null])).rows;
  }
  async refreshPending() {
    const pending = (await this.db.query("SELECT p.id,p.workspace_id,u.id AS actor_id,u.name,u.username FROM processes p JOIN LATERAL (SELECT id,name,username FROM users WHERE workspace_id=p.workspace_id AND role='admin' AND active ORDER BY id LIMIT 1) u ON true WHERE p.status='running' ORDER BY p.checked_at NULLS FIRST,p.created_at LIMIT 20")).rows;
    for (const process of pending) {
      try { await this.get({ id: process.actor_id, name: process.name, username: process.username, role: "admin", workspaceId: process.workspace_id }, process.id); }
      catch { await this.db.query("UPDATE processes SET checked_at=now(),refresh_error='条件检查暂时失败，请重试检查' WHERE id=$1", [process.id]); }
    }
  }
}
