import { BadRequestException, ForbiddenException } from "@nestjs/common";
import type { AccessGrant, FormField, FormSchema, FormValues, RelationSpec } from "@platform/contracts";
import { dataKind, valueMappingCompatible, equalFieldValues, choiceConditionValue } from "@platform/contracts";
import { identifier, object, permission, title, uuid } from "../../core/database/schema";

export function parseRelation(input: unknown): RelationSpec {
  object(input); title(input.title); uuid(input.sourceDefinitionId); uuid(input.targetDefinitionId);
  if (input.sourceSubformId) identifier(input.sourceSubformId);
  identifier(input.labelFieldId);
  if (!["one", "many"].includes(input.cardinality) || !["one", "many"].includes(input.inverseCardinality) || !["live", "snapshot"].includes(input.valueMode)) throw new BadRequestException("关系数量或取值方式不合法");
  if (!Array.isArray(input.columns) || input.columns.length > 12 || new Set(input.columns).size !== input.columns.length || !Array.isArray(input.filters) || input.filters.length > 10 || !Array.isArray(input.mappings) || input.mappings.length > 20) throw new BadRequestException("展示列、筛选或回填配置不合法");
  input.columns.forEach(identifier);
  const filters = input.filters.map((filter: unknown) => {
    object(filter); identifier(filter.id); identifier(filter.sourceFieldId);
    if (!["equals", "notEquals", "contains", "greater", "less", "notEmpty"].includes(filter.operator) || !["constant", "field"].includes(filter.source) || typeof filter.value !== "string" || filter.value.length > 1000) throw new BadRequestException("关联筛选只支持常量或本表字段");
    if (filter.source === "field") identifier(filter.value);
    return { id: filter.id, sourceFieldId: filter.sourceFieldId, operator: filter.operator, source: filter.source, value: filter.value };
  });
  if (new Set(filters.map((f: any) => f.id)).size !== filters.length) throw new BadRequestException("筛选标识重复");
  const mappings = input.mappings.map((mapping: unknown) => {
    object(mapping); identifier(mapping.fromTargetFieldId); identifier(mapping.toSourceFieldId);
    return { fromTargetFieldId: mapping.fromTargetFieldId, toSourceFieldId: mapping.toSourceFieldId };
  });
  if (new Set(mappings.map((m: any) => m.toSourceFieldId)).size !== mappings.length || (mappings.length && input.cardinality !== "one")) throw new BadRequestException("回填目标不能重复，且单值回填需要将可关联数量设为一条");
  return { title: input.title.trim(), sourceDefinitionId: input.sourceDefinitionId, targetDefinitionId: input.targetDefinitionId,
    ...(input.sourceSubformId ? { sourceSubformId: input.sourceSubformId } : {}), cardinality: input.cardinality, inverseCardinality: input.inverseCardinality,
    labelFieldId: input.labelFieldId, columns: [...input.columns], filters, mappings, valueMode: input.valueMode };
}
export function relationFields(spec: RelationSpec, source: FormSchema, target: FormSchema) {
  const parent = spec.sourceSubformId ? source.fields.find(f => f.id === spec.sourceSubformId && f.type === "subform") : undefined;
  if (spec.sourceSubformId && !parent) throw new BadRequestException("关系引用的来源明细已失效或不适用于此记录版本");
  const sourceFields = (parent ? parent.children : source.fields).filter(f => f.type !== "subform");
  const targetFields = target.fields.filter(f => f.type !== "subform");
  const src = (id: string) => sourceFields.find(f => f.id === id);
  const dst = (id: string) => targetFields.find(f => f.id === id);
  if ([spec.labelFieldId, ...spec.columns, ...spec.filters.map(f => f.sourceFieldId), ...spec.mappings.map(m => m.fromTargetFieldId)].some(id => !dst(id)) || spec.filters.some(f => f.source === "field" && !src(f.value)) || spec.mappings.some(m => !src(m.toSourceFieldId))) throw new BadRequestException("关系引用的字段已失效或不适用于此记录版本");
  for (const mapping of spec.mappings) {
    const from = dst(mapping.fromTargetFieldId)!, to = src(mapping.toSourceFieldId)!;
    if (!valueMappingCompatible({kind: dataKind(from.type)!, settings: from}, {kind: dataKind(to.type)!, settings: to})) throw new BadRequestException("回填字段类型不兼容");
  }
  return { parent, sourceFields, targetFields, src, dst };
}
export function relationScope(spec: RelationSpec, values: FormValues, rowId?: string): FormValues {
  if (!spec.sourceSubformId) { if (rowId) throw new BadRequestException("此关系不属于明细行"); return values; }
  uuid(rowId);
  const rows = values[spec.sourceSubformId];
  const row = Array.isArray(rows) ? rows.find(r => r._rowId === rowId) : undefined;
  if (!row) throw new BadRequestException("来源明细行不存在");
  return row;
}
export function requireRelationFields(spec: RelationSpec, source: FormSchema, target: FormSchema, sourceAccess: AccessGrant, targetAccess: AccessGrant) {
  const fields = relationFields(spec, source, target);
  const visible = (field: FormField, access: AccessGrant, parent?: FormField) => permission(access, field, parent) !== "hidden";
  for (const id of [spec.labelFieldId, ...spec.filters.map(f => f.sourceFieldId), ...spec.mappings.map(m => m.fromTargetFieldId)])
    if (!visible(fields.dst(id)!, targetAccess)) throw new ForbiddenException("没有关联所需字段的访问权限");
  for (const filter of spec.filters) if (filter.source === "field" && !visible(fields.src(filter.value)!, sourceAccess, fields.parent)) throw new ForbiddenException("没有关联所需字段的访问权限");
  return fields;
}
export function matchesRelation(spec: RelationSpec, source: FormValues, target: FormValues) {
  return spec.filters.every(filter => {
    const actual = choiceConditionValue(target[filter.sourceFieldId]);
    const expected = choiceConditionValue(filter.source === "field" ? source[filter.value] : filter.value);
    const a = actual == null ? "" : String(actual), b = expected == null ? "" : String(expected);
    if (filter.operator === "notEmpty") return a !== "";
    if (filter.source === "field" && b === "") return false;
    if (Array.isArray(actual)) {
      const desired = Array.isArray(expected) ? expected : [expected];
      if (filter.operator === "contains") return desired.every(value => actual.includes(value));
      if (filter.operator === "equals") return equalFieldValues(actual, desired);
      if (filter.operator === "notEquals") return !equalFieldValues(actual, desired);
      return false;
    }
    if (filter.operator === "equals") return a === b;
    if (filter.operator === "notEquals") return a !== b;
    if (filter.operator === "contains") return a.includes(b);
    if (!a || !b || !Number.isFinite(Number(a)) || !Number.isFinite(Number(b))) return false;
    return filter.operator === "greater" ? Number(a) > Number(b) : Number(a) < Number(b);
  });
}
export function referencedRelationFields(spec: RelationSpec, definitionId: string) {
  return new Set([
    ...(definitionId === spec.sourceDefinitionId ? [spec.sourceSubformId || "", ...spec.filters.filter(f => f.source === "field").map(f => f.value), ...spec.mappings.map(m => m.toSourceFieldId)] : []),
    ...(definitionId === spec.targetDefinitionId ? [spec.labelFieldId, ...spec.columns, ...spec.filters.map(f => f.sourceFieldId), ...spec.mappings.map(m => m.fromTargetFieldId)] : []),
  ].filter(Boolean));
}
