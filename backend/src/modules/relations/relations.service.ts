import { requireActiveRecord } from "../records/record-state";
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { fieldValueLabel } from "@platform/contracts";
import { randomUUID } from "node:crypto";
import type { AccessGrant, FormField, FormSchema, FormValues, RelationCandidate, RelationCandidatesPage, RelationDefinition, RelationLinkView, RelationSpec, RecordRelationGroup } from "@platform/contracts";
import { Actor, requireAdmin } from "../../core/auth/auth.service";
import { Database, Transaction } from "../../core/database/database";
import { PlatformService } from "../pages/platform.service";
import { once } from "../processes/commands";
import { cellKey, object, permission, rowPolicy, scalar, uuid } from "../../core/database/schema";
import { matchesRelation, parseRelation, relationFields, relationScope, requireRelationFields } from "./relation-rules";
import { assertPageActive } from "../pages/page-lifecycle";
import { pageAccess, type RecordPageScope } from "../pages/page-runtime";

const dto = (row: any, published = false): RelationDefinition => ({ id: row.id, revision: row.revision, latestVersion: row.latest_version, spec: published ? row.spec : row.draft, ...(!published ? { hasDraftChanges: !row.spec || JSON.stringify(row.draft) !== JSON.stringify(row.spec) } : {}) });
const relationPermission = (actor: Actor, access: AccessGrant, id: string) => actor.role === "admin" ? "edit" : access.relations?.[id] || "hidden";
const fieldList = (spec: RelationSpec) => [...new Set([spec.labelFieldId, ...spec.columns])];

@Injectable()
export class RelationService {
  constructor(private readonly db: Database, private readonly platform: PlatformService) {}
  private async definition(tx: Transaction, actor: Actor, id: string, published = false) {
    uuid(id);
    const row = (await tx.query(`SELECT d.*,v.spec FROM relation_definitions d LEFT JOIN relation_versions v ON v.relation_id=d.id AND v.version=d.latest_version WHERE d.id=$1 AND d.workspace_id=$2`, [id, actor.workspaceId])).rows[0];
    if (!row || (published && !row.spec)) throw new NotFoundException("关系不存在或尚未发布");
    return row;
  }
  private async lockRelation(tx: Transaction, id: string) {
    uuid(id); await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`relation:${id}`]);
  }
  private async schemas(tx: Transaction, actor: Actor, spec: RelationSpec, lock = true) {
    const result = new Map<string, FormSchema>();
    for (const id of [...new Set([spec.sourceDefinitionId, spec.targetDefinitionId])].sort()) {
      const def = await this.platform.definition(tx, actor, id, lock ? "FOR SHARE" : "");
      const version = (await tx.query("SELECT schema FROM definition_versions WHERE definition_id=$1 AND version=$2", [id, def.latest_version])).rows[0];
      if (!version) throw new BadRequestException("请先发布关系两端的表单");
      result.set(id, version.schema);
    }
    const source = result.get(spec.sourceDefinitionId)!, target = result.get(spec.targetDefinitionId)!;
    relationFields(spec, source, target);
    return { source, target };
  }
  async list(actor: Actor, sourceId?: string) {
    requireAdmin(actor); if (sourceId) uuid(sourceId);
    return (await this.db.query("SELECT d.*,v.spec FROM relation_definitions d LEFT JOIN relation_versions v ON v.relation_id=d.id AND v.version=d.latest_version WHERE d.workspace_id=$1 AND ($2::uuid IS NULL OR d.source_definition_id=$2 OR d.target_definition_id=$2) ORDER BY d.created_at", [actor.workspaceId, sourceId || null])).rows.map(r => dto(r));
  }
  async save(actor: Actor, body: unknown, id?: string) {
    requireAdmin(actor); object(body); const spec = parseRelation(body.spec);
    return this.db.transaction(async tx => {
      if (id) await this.lockRelation(tx, id);
      await this.schemas(tx, actor, spec);
      if (!id) {
        const create = async () => {
          const relationId = randomUUID();
          await tx.query("INSERT INTO relation_definitions(id,workspace_id,source_definition_id,target_definition_id,draft) VALUES($1,$2,$3,$4,$5)", [relationId, actor.workspaceId, spec.sourceDefinitionId, spec.targetDefinitionId, spec]);
          return relationId;
        };
        const relationId = body.requestId ? await once(tx, actor, body.requestId, { createRelation: spec }, create) : await create();
        return dto(await this.definition(tx, actor, relationId));
      }
      const existing = await this.definition(tx, actor, id);
      if (existing.revision !== body.expectedRevision) throw new ConflictException("关系配置已被修改，请重新读取");
      if (existing.source_definition_id !== spec.sourceDefinitionId || existing.target_definition_id !== spec.targetDefinitionId || existing.draft.sourceSubformId !== spec.sourceSubformId) throw new BadRequestException("关系两端与明细范围不能变更，请新建关系");
      const row = (await tx.query("UPDATE relation_definitions SET draft=$2,revision=revision+1 WHERE id=$1 RETURNING *", [id, spec])).rows[0];
      return dto({ ...row, spec: existing.spec });
    });
  }
  async publish(actor: Actor, id: string, body: unknown) {
    requireAdmin(actor); object(body);
    return this.db.transaction(async tx => {
      await this.lockRelation(tx, id);
      const existing = await this.definition(tx, actor, id);
      if (existing.revision !== body.expectedRevision) throw new ConflictException("关系配置已被修改，请重新读取");
      const spec = parseRelation(existing.draft);
      await this.schemas(tx, actor, spec);
      if (spec.cardinality === "one" && (await tx.query("SELECT 1 FROM record_links WHERE relation_id=$1 GROUP BY source_record_id,source_row_id HAVING count(*)>1 LIMIT 1", [id])).rowCount) throw new ConflictException("已有记录关联了多条数据，不能直接改为单条关系");
      if (spec.inverseCardinality === "one" && (await tx.query("SELECT 1 FROM record_links WHERE relation_id=$1 GROUP BY target_record_id HAVING count(*)>1 LIMIT 1", [id])).rowCount) throw new ConflictException("已有目标被多条来源关联，不能直接限制为唯一归属");
      const version = existing.latest_version + 1;
      await tx.query("INSERT INTO relation_versions(relation_id,version,spec) VALUES($1,$2,$3)", [id, version, spec]);
      const row = (await tx.query("UPDATE relation_definitions SET latest_version=$2,revision=revision+1 WHERE id=$1 RETURNING *", [id, version])).rows[0];
      return dto({ ...row, spec: row.draft });
    });
  }
  private async source(tx: Transaction, actor: Actor, recordId: string, relation: any, rowId?: string, write = false, page?: RecordPageScope) {
    if (page && !page.taskId) await assertPageActive(tx, actor, page.id);
    const source = await this.platform.loadRecord(tx, actor, recordId);
    requireActiveRecord(source.row);
    source.access = pageAccess(page, source.row.definition_id, source.row.definition_version, source.access, source.version.schema);
    const spec = relation.spec as RelationSpec;
    if (source.row.definition_id !== spec.sourceDefinitionId) throw new BadRequestException("记录不属于此关系的来源表单");
    const access = relationPermission(actor, source.access, relation.id);
    if (access === "hidden" || (write && (access !== "edit" || !source.access.edit))) throw new ForbiddenException("没有此关系的操作权限");
    if (spec.sourceSubformId) {
      const parent = source.version.schema.fields.find((f: FormField) => f.id === spec.sourceSubformId);
      if (!parent || permission(source.access, parent) === "hidden" || (write && permission(source.access, parent) !== "edit")) throw new ForbiddenException("没有来源明细的操作权限");
    }
    return { ...source, scope: relationScope(spec, source.row.values, rowId), relationAccess: access };
  }
  async candidates(actor: Actor, recordId: string, relationId: string, rowId?: string, cursor?: string, query = "", page?: RecordPageScope): Promise<RelationCandidatesPage> {
    if (rowId) uuid(rowId); if (cursor) uuid(cursor);
    if (typeof query !== "string" || query.length > 100) throw new BadRequestException("搜索内容过长");
    return this.db.transaction(async tx => {
      const relation = await this.definition(tx, actor, relationId, true), spec = relation.spec as RelationSpec;
      const source = await this.source(tx, actor, recordId, relation, rowId, true, page);
      const schemas = await this.schemas(tx, actor, spec);
      const access = await this.platform.access(tx, actor, spec.targetDefinitionId, schemas.target);
      const readScope = await this.platform.readableScope(tx, actor, spec.targetDefinitionId);
      const fields = requireRelationFields(spec, source.version.schema, schemas.target, source.access, access);
      if (fields.parent && spec.mappings.length && !rowPolicy(fields.parent, page?.schema.fields.find(field => field.id === fields.parent!.id)).editExisting) throw new ForbiddenException('不可回填不可编辑的已有明细行');
      for (const mapping of spec.mappings) if (permission(source.access, fields.src(mapping.toSourceFieldId)!, fields.parent) !== "edit") throw new ForbiddenException("当前页面或成员没有回填字段的修改权限");
      const columnLabels = Object.fromEntries(fields.targetFields.filter(f => fieldList(spec).includes(f.id) && permission(access, f) !== "hidden").map(f => [f.id, f.label]));
      const parameters: unknown[] = [actor.workspaceId, spec.targetDefinitionId, readScope.creators, cursor || null, recordId, readScope.createdDepartments];
      const groupScope = readScope.sql?.('r', parameters) || 'true';
      const rows = (await tx.query(`SELECT r.*,v.schema FROM records r JOIN definition_versions v ON v.definition_id=r.definition_id AND v.version=r.definition_version
        WHERE r.workspace_id=$1 AND r.definition_id=$2 AND r.archived_at IS NULL AND r.state='active' AND ($3::uuid[] IS NULL OR r.created_by=ANY($3) OR r.created_department_ids && $6::uuid[]) AND ($4::uuid IS NULL OR r.id>$4) AND r.id<>$5 AND (${groupScope})
        ORDER BY r.id LIMIT 61`, parameters)).rows;
      const scanned = rows.slice(0, 60), items: RelationCandidate[] = [];
      for (const row of scanned) {
        let rowAccess: AccessGrant;
        try { rowAccess = await this.platform.access(tx, actor, spec.targetDefinitionId, row.schema, { createdBy: row.created_by, createdDepartmentIds: row.created_department_ids, values: row.values }); requireRelationFields(spec, source.version.schema, row.schema, source.access, rowAccess); } catch (error) { if (error instanceof BadRequestException || error instanceof ForbiddenException) continue; throw error; }
        if (!matchesRelation(spec, source.scope, row.values)) continue;
        const shown = (row.schema as FormSchema).fields.filter(field => [spec.labelFieldId, ...fieldList(spec), ...spec.mappings.map(item => item.fromTargetFieldId)].includes(field.id) && permission(rowAccess, field) !== "hidden");
        const identities = await this.platform.identityLabels(tx, actor, { ...row.schema, fields: shown }, row.values);
        const sourceIdentities = await this.platform.identityLabels(tx, actor, { ...source.version.schema, fields: spec.mappings.map(item => fields.src(item.toSourceFieldId)!) }, source.scope);
        const label = fieldValueLabel(row.schema.fields.find((f: FormField) => f.id === spec.labelFieldId), row.values[spec.labelFieldId], identities);
        if (query && !label.toLocaleLowerCase().includes(query.toLocaleLowerCase())) continue;
        const values = Object.fromEntries(fieldList(spec).filter(id => row.schema.fields.some((f: FormField) => f.id === id && permission(rowAccess, f) !== "hidden")).map(id => [id, row.values[id]]));
        items.push({ recordId: row.id, definitionVersion: row.definition_version, revision: row.revision, label: label || "未命名记录", values, displayValues: Object.fromEntries(Object.keys(values).map(id => [id, fieldValueLabel(row.schema.fields.find((f: FormField) => f.id === id), values[id], identities)])), mappings: spec.mappings.map(m => ({ fieldId: m.toSourceFieldId, label: fields.src(m.toSourceFieldId)!.label, before: source.scope[m.toSourceFieldId], value: row.values[m.fromTargetFieldId], beforeLabel: fieldValueLabel(fields.src(m.toSourceFieldId)!, source.scope[m.toSourceFieldId], sourceIdentities), valueLabel: fieldValueLabel(row.schema.fields.find((f: FormField) => f.id === m.fromTargetFieldId), row.values[m.fromTargetFieldId], identities) })) });
      }
      return { items, nextCursor: rows.length > 60 ? scanned.at(-1)!.id : null, columnLabels, relationVersion: relation.latest_version };
    });
  }
  private async lockRecords(tx: Transaction, actor: Actor, spec: RelationSpec, sourceId: string, targetId: string) {
    uuid(sourceId); uuid(targetId);
    if (sourceId === targetId) throw new BadRequestException("不能关联记录自身");
    await this.schemas(tx, actor, spec);
    const rows = (await tx.query("SELECT id FROM records WHERE workspace_id=$1 AND id=ANY($2::uuid[]) AND archived_at IS NULL AND state='active' ORDER BY id FOR UPDATE", [actor.workspaceId, [sourceId, targetId]])).rows;
    if (rows.length !== 2) throw new NotFoundException("关联记录不存在或已归档");
  }
  async link(actor: Actor, recordId: string, relationId: string, body: unknown, page?: RecordPageScope) {
    object(body); uuid(body.targetRecordId); if (body.sourceRowId) uuid(body.sourceRowId);
    return this.db.transaction(async tx => {
    const linkId = await once(tx, actor, body.requestId, { link: relationId, source: recordId, target: body.targetRecordId, sourceRowId: body.sourceRowId, expectedCells: body.expectedCells, expectedTargetRevision: body.expectedTargetRevision, expectedRelationVersion: body.expectedRelationVersion, page: page ? [page.id, page.version] : undefined }, async () => {
      await this.lockRelation(tx, relationId);
      const relation = await this.definition(tx, actor, relationId, true), spec = relation.spec as RelationSpec;
      if (body.expectedRelationVersion !== undefined && body.expectedRelationVersion !== relation.latest_version) throw new ConflictException("关系配置已经更新，请重新选择关联记录");
      await this.lockRecords(tx, actor, spec, recordId, body.targetRecordId);
      const source = await this.source(tx, actor, recordId, relation, body.sourceRowId, true, page);
      const target = await this.platform.loadRecord(tx, actor, body.targetRecordId);
      if (body.expectedTargetRevision !== undefined && body.expectedTargetRevision !== target.row.revision) throw new ConflictException("目标记录已经更新，请重新查看并确认关联");
      if (target.row.definition_id !== spec.targetDefinitionId) throw new BadRequestException("记录不属于关系的目标表单");
      const fields = requireRelationFields(spec, source.version.schema, target.version.schema, source.access, target.access);
      if (fields.parent && spec.mappings.length && !rowPolicy(fields.parent, page?.schema.fields.find(field => field.id === fields.parent!.id)).editExisting) throw new ForbiddenException('不可回填不可编辑的已有明细行');
      if (!matchesRelation(spec, source.scope, target.row.values)) throw new ConflictException("目标记录已不符合当前筛选条件，请重新选择");
      if ((await tx.query("SELECT 1 FROM record_links WHERE relation_id=$1 AND source_record_id=$2 AND source_row_id IS NOT DISTINCT FROM $3::uuid AND target_record_id=$4", [relationId, recordId, body.sourceRowId || null, body.targetRecordId])).rowCount) throw new ConflictException("这条记录已经关联，请刷新查看");
      if (spec.cardinality === "one" && (await tx.query("SELECT 1 FROM record_links WHERE relation_id=$1 AND source_record_id=$2 AND source_row_id IS NOT DISTINCT FROM $3::uuid", [relationId, recordId, body.sourceRowId || null])).rowCount) throw new ConflictException("此处只允许关联一条记录，请先解除已有关系");
      if (spec.inverseCardinality === "one" && (await tx.query("SELECT 1 FROM record_links WHERE relation_id=$1 AND target_record_id=$2", [relationId, body.targetRecordId])).rowCount) throw new ConflictException("目标记录已归属其他来源，不能重复关联");
      const beforeValues = structuredClone(source.row.values);
      const changes: Record<string, unknown>[] = [];
      for (const mapping of spec.mappings) {
        const field = fields.src(mapping.toSourceFieldId)!;
        if (permission(source.access, field, fields.parent) !== "edit") throw new ForbiddenException("没有回填目标字段的修改权限");
        const cell = { fieldId: field.id, ...(spec.sourceSubformId ? { subformId: spec.sourceSubformId, rowId: body.sourceRowId } : {}) }, key = cellKey(cell);
        if (body.expectedCells?.[key] !== source.row.cell_revisions[key]) throw new ConflictException("回填目标已被修改，请先读取最新记录");
        const value = scalar(field, target.row.values[mapping.fromTargetFieldId]);
        changes.push({ ...cell, before: source.scope[field.id], value, action: "relation-fill", relationId });
        source.scope[field.id] = value; source.row.cell_revisions[key]++;
      }
      await this.platform.validateRecordOrganizations(tx, actor, source.version.schema, source.row.values, beforeValues);
      const id = randomUUID();
      const snapshot = Object.fromEntries(fieldList(spec).map(key => [key, target.row.values[key]]));
      await tx.query("INSERT INTO record_links(id,relation_id,relation_version,source_record_id,target_record_id,source_row_id,target_definition_version,snapshot,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)", [id, relationId, relation.latest_version, recordId, body.targetRecordId, body.sourceRowId || null, target.row.definition_version, snapshot, actor.id]);
      await tx.query("UPDATE records SET values=$2,cell_revisions=$3,revision=revision+1,updated_at=now() WHERE id=$1", [recordId, source.row.values, source.row.cell_revisions]);
      await tx.query("INSERT INTO record_events(id,record_id,actor_id,revision,changes) VALUES($1,$2,$3,$4,$5)", [randomUUID(), recordId, actor.id, source.row.revision + 1, JSON.stringify([{ action: "link", relationId, linkId: id }, ...changes])]);
      await tx.query("INSERT INTO relation_events(id,relation_id,source_record_id,target_record_id,source_row_id,actor_id,action) VALUES($1,$2,$3,$4,$5,$6,'link')", [randomUUID(), relationId, recordId, body.targetRecordId, body.sourceRowId || null, actor.id]);
      return id;
    });
    // Re-authorize every response, including idempotent retries after a policy change.
    const groups = await this.forRecordIn(tx, actor, recordId, page);
    const link = groups.flatMap(group => group.links).find(item => item.id === linkId) || null;
    return { link, record: await this.platform.detailIn(tx, actor, recordId, page) };
    });
  }
  async unlink(actor: Actor, recordId: string, relationId: string, linkId: string, body: unknown, page?: RecordPageScope) {
    uuid(linkId); object(body);
    return this.db.transaction(async tx => {
    await once(tx, actor, body.requestId, { unlink: relationId, source: recordId, linkId, page: page ? [page.id, page.version] : undefined }, async () => {
      await this.lockRelation(tx, relationId);
      const relation = await this.definition(tx, actor, relationId, true);
      const link = (await tx.query("SELECT * FROM record_links WHERE id=$1 AND relation_id=$2 AND source_record_id=$3", [linkId, relationId, recordId])).rows[0];
      if (!link) throw new NotFoundException("关联已不存在，请刷新查看");
      await this.lockRecords(tx, actor, relation.spec, recordId, link.target_record_id);
      const source = await this.source(tx, actor, recordId, relation, link.source_row_id || undefined, true, page);
      await tx.query("DELETE FROM record_links WHERE id=$1", [linkId]);
      await tx.query("UPDATE records SET revision=revision+1,updated_at=now() WHERE id=$1", [recordId]);
      await tx.query("INSERT INTO record_events(id,record_id,actor_id,revision,changes) VALUES($1,$2,$3,$4,$5)", [randomUUID(), recordId, actor.id, source.row.revision + 1, { action: "unlink", relationId, linkId }]);
      await tx.query("INSERT INTO relation_events(id,relation_id,source_record_id,target_record_id,source_row_id,actor_id,action) VALUES($1,$2,$3,$4,$5,$6,'unlink')", [randomUUID(), relationId, recordId, link.target_record_id, link.source_row_id, actor.id]);
      return recordId;
    });
    return { record: await this.platform.detailIn(tx, actor, recordId, page), groups: await this.forRecordIn(tx, actor, recordId, page) };
    });
  }
  async forRecord(actor: Actor, recordId: string, page?: RecordPageScope): Promise<RecordRelationGroup[]> {
    return this.db.transaction(tx => this.forRecordIn(tx, actor, recordId, page));
  }
  private async forRecordIn(tx: Transaction, actor: Actor, recordId: string, page?: RecordPageScope): Promise<RecordRelationGroup[]> {
      if (page && !page.taskId) await assertPageActive(tx, actor, page.id);
    const source = await this.platform.loadRecord(tx, actor, recordId);
    requireActiveRecord(source.row);
      source.access = pageAccess(page, source.row.definition_id, source.row.definition_version, source.access, source.version.schema);
      const definitions = (await tx.query("SELECT d.*,v.spec FROM relation_definitions d JOIN relation_versions v ON v.relation_id=d.id AND v.version=d.latest_version WHERE d.workspace_id=$1 AND d.source_definition_id=$2 ORDER BY d.created_at", [actor.workspaceId, source.row.definition_id])).rows;
      const groups: RecordRelationGroup[] = [];
      for (const relation of definitions) {
        const access = relationPermission(actor, source.access, relation.id), spec = relation.spec as RelationSpec;
        if (access === "hidden") continue;
        if (spec.sourceSubformId && !source.version.schema.fields.some((f: FormField) => f.id === spec.sourceSubformId && permission(source.access, f) !== "hidden")) continue;
        const columnLabels: Record<string, string> = {}, links: RelationLinkView[] = [];
        let canLink = access === "edit" && source.access.edit, unavailableReason = "";
        try {
          // Rendering uses immutable versions; do not acquire additional definition
          // locks after a link writer has already locked its source/target records.
          const schemas = await this.schemas(tx, actor, spec, false);
          const targetAccess = await this.platform.access(tx, actor, spec.targetDefinitionId, schemas.target);
          const fields = requireRelationFields(spec, source.version.schema, schemas.target, source.access, targetAccess);
          for (const field of fields.targetFields) if (fieldList(spec).includes(field.id) && permission(targetAccess, field) !== "hidden") columnLabels[field.id] = field.label;
          if ((fields.parent && permission(source.access, fields.parent) !== "edit") || spec.mappings.some(m => permission(source.access, fields.src(m.toSourceFieldId)!, fields.parent) !== "edit")) {
            canLink = false; unavailableReason = "当前页面或成员没有关联及回填所需的修改权限";
          }
        } catch (error) {
          if (!(error instanceof ForbiddenException) && !(error instanceof BadRequestException) && !(error instanceof NotFoundException)) throw error;
          canLink = false; unavailableReason = "当前权限或记录版本不满足关联条件";
        }
        const rows = (await tx.query("SELECT l.*,v.spec FROM record_links l JOIN relation_versions v ON v.relation_id=l.relation_id AND v.version=l.relation_version WHERE l.source_record_id=$1 AND l.relation_id=$2 ORDER BY l.created_at,l.id", [recordId, relation.id])).rows;
        for (const link of rows) {
          const rule = link.spec as RelationSpec;
          let values: FormValues = {}, displayValues: Record<string, string> = {}, label = "无权查看关联记录", restricted = false;
          try {
            const target = await this.platform.loadRecord(tx, actor, link.target_record_id);
            const available = (target.version.schema as FormSchema).fields.filter(f => fieldList(rule).includes(f.id) && permission(target.access, f) !== "hidden");
            const raw = rule.valueMode === "snapshot" ? link.snapshot : target.row.values;
            values = Object.fromEntries(available.map(field => [field.id, raw[field.id]]));
            const identities = await this.platform.identityLabels(tx, actor, { ...target.version.schema, fields: available }, values);
            displayValues = Object.fromEntries(available.map(field => [field.id, fieldValueLabel(field, raw[field.id], identities)]));
            for (const field of available) columnLabels[field.id] = field.label;
            label = Object.hasOwn(values, rule.labelFieldId) ? displayValues[rule.labelFieldId] || "未命名记录" : "关联记录（标题不可见）";
          } catch (error) { if (!(error instanceof ForbiddenException) && !(error instanceof NotFoundException)) throw error; restricted = true; }
          links.push({ id: link.id, relationId: relation.id, relationVersion: link.relation_version, targetRecordId: link.target_record_id, ...(link.source_row_id ? { sourceRowId: link.source_row_id } : {}), label, values, displayValues, restricted, valueMode: rule.valueMode, createdAt: new Date(link.created_at).toISOString() });
        }
        // Configuration constants and hidden-field names are not exposed to members.
        const visible = actor.role === "admin" ? spec : { ...spec, filters: [], mappings: [], columns: spec.columns.filter(id => Object.hasOwn(columnLabels, id)), labelFieldId: Object.hasOwn(columnLabels, spec.labelFieldId) ? spec.labelFieldId : "" };
        groups.push({ relation: { ...dto(relation, true), spec: visible }, permission: source.access.edit ? access : "read", columnLabels, links, direction: "outgoing", canLink, ...(unavailableReason ? { unavailableReason } : {}) });
      }
      // Incoming links are disclosed only when both records and the source relation are readable.
      const incoming = (await tx.query("SELECT l.*,d.revision,d.latest_version,v.spec FROM record_links l JOIN relation_definitions d ON d.id=l.relation_id JOIN relation_versions v ON v.relation_id=l.relation_id AND v.version=l.relation_version WHERE l.target_record_id=$1 AND d.workspace_id=$2 ORDER BY l.created_at,l.id", [recordId, actor.workspaceId])).rows;
      const incomingGroups = new Map<string, RecordRelationGroup>();
      for (const link of incoming) {
        const spec = link.spec as RelationSpec;
        try {
          const origin = await this.platform.loadRecord(tx, actor, link.source_record_id);
          if (relationPermission(actor, origin.access, link.relation_id) === "hidden") continue;
          const parent = spec.sourceSubformId ? origin.version.schema.fields.find((f: FormField) => f.id === spec.sourceSubformId) : undefined;
          if (spec.sourceSubformId && (!parent || permission(origin.access, parent) === "hidden")) continue;
          const fields = ((parent ? parent.children : origin.version.schema.fields) as FormField[]).filter(f => f.type !== "subform" && permission(origin.access, f, parent) !== "hidden").slice(0, 3);
          const scope = relationScope(spec, origin.row.values, link.source_row_id || undefined);
          const values = Object.fromEntries(fields.map(f => [f.id, scope[f.id]]));
          const identities = await this.platform.identityLabels(tx, actor, { ...origin.version.schema, fields }, values);
          let group = incomingGroups.get(link.relation_id);
          if (!group) {
            group = { relation: { id: link.relation_id, revision: link.revision, latestVersion: link.latest_version, spec: { ...spec, filters: [], mappings: [], columns: [], labelFieldId: "" } }, direction: "incoming", permission: "read", canLink: false, columnLabels: {}, links: [] };
            incomingGroups.set(link.relation_id, group);
          }
          for (const field of fields) group.columnLabels[field.id] = field.label;
          group.links.push({ id: link.id, relationId: link.relation_id, relationVersion: link.relation_version, sourceRecordId: link.source_record_id, targetRecordId: recordId, ...(link.source_row_id ? { sourceRowId: link.source_row_id } : {}), label: fields.length ? fieldValueLabel(fields[0]!, scope[fields[0]!.id], identities) || "未命名记录" : "关联来源（标题不可见）", values, displayValues: Object.fromEntries(fields.map(field => [field.id, fieldValueLabel(field, scope[field.id], identities)])), restricted: false, valueMode: "live", createdAt: new Date(link.created_at).toISOString() });
        } catch (error) {
          if (!(error instanceof ForbiddenException) && !(error instanceof NotFoundException) && !(error instanceof BadRequestException)) throw error;
        }
      }
      groups.push(...incomingGroups.values());
      return groups;
  }
}
