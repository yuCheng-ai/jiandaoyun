import { BadRequestException, ConflictException, Injectable } from "@nestjs/common";
import { createHash, randomUUID } from "node:crypto";
import { dataModelChanges, separateFormSchema, isOrganizationField, fieldValueLabel, type FormField, type FormSchema, type FormValues, type RecordUpgradePlan } from "@platform/contracts";
import { Actor, requireAdmin } from "../../core/auth/auth.service";
import { Database, Transaction } from "../../core/database/database";
import { PlatformService } from "./platform.service";
import { once } from "../processes/commands";
import { cellKey, object, scalar } from "../../core/database/schema";

function valuesForUpgrade(row: any, before: FormSchema, after: FormSchema, resolveDefault: (field: FormField, row?: FormValues) => any) {
  const changes = dataModelChanges(separateFormSchema(before).model, separateFormSchema(after).model);
  if (changes.removed.length || changes.changed.length) throw new ConflictException("新版本移除或改变了原有字段约束，需要单独制定数据迁移，不能直接更新这条记录");
  const values = structuredClone(row.values) as FormValues, revisions = { ...row.cell_revisions } as Record<string, number>;
  for (const field of after.fields) {
    const previous = before.fields.find(item => item.id === field.id);
    if (field.type !== "subform") {
      if (!previous) { values[field.id] = scalar(field, resolveDefault(field)); revisions[field.id] = 1; }
      continue;
    }
    if (!previous) {
      if (field.required) throw new ConflictException(`新增明细「${field.label}」要求必填，请先定义历史记录的补全方式`);
      values[field.id] = []; revisions[`@rows/${field.id}`] = 1;
    }
    for (const child of field.children) if (!previous?.children.some(item => item.id === child.id)) {
      for (const entry of values[field.id] as FormValues[]) {
        entry[child.id] = scalar(child, resolveDefault(child, entry));
        revisions[cellKey({ subformId: field.id, rowId: String(entry._rowId), fieldId: child.id })] = 1;
      }
    }
  }
  return { values, revisions, changes };
}
@Injectable()
export class RecordEvolutionService {
  constructor(private readonly db: Database, private readonly platform: PlatformService) {}
  private async proposed(tx: Transaction, actor: Actor, source: any) {
    const resolve = await this.platform.defaultResolver(tx, actor, source.target.schema, source.row.values, {}, source.target.schema, undefined, true);
    const updated = valuesForUpgrade(source.row, source.version.schema, source.target.schema, resolve);
    await this.platform.validateRecordOrganizations(tx, actor, source.target.schema, updated.values, source.row.values);
    // Time advances independently of organization defaults; it must not invalidate confirmation.
    const tokenValues = structuredClone(updated.values);
    for (const item of updated.changes.added.filter(item => item.field.kind === "datetime" && item.field.settings.dateDefault === "now")) {
      if (item.parentId) for (const row of (tokenValues[item.parentId] || []) as FormValues[]) row[item.field.id] = "@current-time";
      else tokenValues[item.field.id] = "@current-time";
    }
    return { ...updated, token: createHash("sha256").update(JSON.stringify(tokenValues)).digest("hex") };
  }
  private async context(tx: Transaction, actor: Actor, id: string, target: number, definitionId?: string, lock = false) {
    if (!Number.isInteger(target) || target < 1) throw new BadRequestException("请选择有效的数据版本");
    const meta = await this.platform.loadRecord(tx, actor, id);
    if (meta.row.state === "draft") throw new ConflictException("请先按原版本补全并提交草稿，再检查数据版本更新");
    await this.platform.definition(tx, actor, meta.row.definition_id, "FOR SHARE");
    const source = await this.platform.loadRecord(tx, actor, id, lock);
    if (definitionId && source.row.definition_id !== definitionId) throw new BadRequestException("记录不属于此页面的数据对象");
    if (target <= source.row.definition_version) throw new BadRequestException("只能更新到更高的数据版本");
    const version = (await tx.query("SELECT * FROM definition_versions WHERE definition_id=$1 AND version=$2", [source.row.definition_id, target])).rows[0];
    if (!version) throw new BadRequestException("目标数据版本尚未发布");
    return { ...source, target: version };
  }
  async preview(actor: Actor, id: string, target: number, definitionId?: string, transaction?: Transaction): Promise<RecordUpgradePlan> {
    requireAdmin(actor);
    const read = async (tx: Transaction) => {
      const source = await this.context(tx, actor, id, target, definitionId);
      const changes = dataModelChanges(separateFormSchema(source.version.schema).model, separateFormSchema(source.target.schema).model);
      const plan: RecordUpgradePlan = {
        recordId: id, revision: source.row.revision, fromVersion: source.row.definition_version, toVersion: target, allowed: true,
        additions: changes.added.map(item => ({ fieldId: item.field.id, name: item.field.name, parentName: item.parentId ? source.target.schema.fields.find((field: any) => field.id === item.parentId)?.label : undefined, defaultValue: item.field.kind === "subform" ? [] : item.field.settings.defaultValue })),
      };
      try {
        const updated = await this.proposed(tx, actor, source); plan.defaultsToken = updated.token;
        const labels = await this.platform.identityLabels(tx, actor, source.target.schema, updated.values);
        for (const addition of plan.additions) {
          const item = changes.added.find(item => item.field.id === addition.fieldId)!;
          const parent = item.parentId ? source.target.schema.fields.find((field: FormField) => field.id === item.parentId) : undefined;
          const field = (parent?.children || source.target.schema.fields).find((field: FormField) => field.id === addition.fieldId)!;
          const values = parent ? (updated.values[parent.id] as FormValues[]).map(row => row[field.id]) : [updated.values[field.id]];
          const text = (value: unknown) => isOrganizationField(field.type) ? (Array.isArray(value) ? value : value ? [value] : []).map(id => labels.find(label => label.id === id)?.name || "已不可用身份").join("、") : fieldValueLabel(field, value);
          addition.defaultDisplay = field.type === "subform" || (parent && !values.length) ? "暂无明细" : [...new Set(values.map(value => text(value) || "待填写"))].join("；");
        }
      }
      catch (cause) { plan.allowed = false; plan.reason = (cause as Error).message; }
      return plan;
    };
    return transaction ? read(transaction) : this.db.transaction(read);
  }
  async upgrade(actor: Actor, id: string, body: unknown, definitionId?: string, transaction?: Transaction) {
    requireAdmin(actor); object(body);
    const write = async (tx: Transaction) => {
    const recordId = await once(tx, actor, body.requestId, { upgrade: id, targetVersion: body.targetVersion, expectedRevision: body.expectedRevision, defaultsToken: body.defaultsToken, definitionId }, async () => {
      const source = await this.context(tx, actor, id, body.targetVersion, definitionId, true);
      if (body.expectedRevision !== source.row.revision) throw new ConflictException("记录已被修改，请重新查看更新预览");
      const updated = await this.proposed(tx, actor, source);
      if (updated.changes.added.some(item => isOrganizationField(item.field.kind)) && body.defaultsToken !== updated.token) throw new ConflictException("组织默认值需要重新确认，请重新检查记录更新预览");
      await tx.query("UPDATE records SET definition_version=$2,values=$3,cell_revisions=$4,revision=revision+1,updated_at=now() WHERE id=$1", [id, body.targetVersion, updated.values, updated.revisions]);
      await tx.query("INSERT INTO record_events(id,record_id,actor_id,revision,changes) VALUES($1,$2,$3,$4,$5)", [randomUUID(), id, actor.id, source.row.revision + 1, {
        action: "upgrade", fromVersion: source.row.definition_version, toVersion: body.targetVersion,
        addedFieldIds: updated.changes.added.map(item => item.field.id), before: { values: source.row.values, cellRevisions: source.row.cell_revisions },
      }]);
      return id;
    });
    return this.platform.detailIn(tx, actor, recordId);
    };
    return transaction ? write(transaction) : this.db.transaction(write);
  }
}
