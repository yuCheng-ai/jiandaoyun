import { BadRequestException, ForbiddenException } from "@nestjs/common";
import type {
  AccessGrant,
  FormField,
  FormSchema,
  FormValues,
  RelationSpec,
} from "@platform/contracts";
import {
  choiceConditionValue,
  dataKind,
  equalFieldValues,
  fieldPermission as permission,
  valueMappingCompatible,
} from "@platform/contracts";
import { identifier, object, title, uuid } from "../../core/validation";


/** 校验并解析关联关系配置（基数、取值方式、展示列、筛选条件与回填映射） */
export function parseRelation(input: unknown): RelationSpec {
  object(input);
  title(input.title);
  uuid(input.sourceDefinitionId);
  uuid(input.targetDefinitionId);
  if (input.sourceSubformId) {
    identifier(input.sourceSubformId);
  }
  identifier(input.labelFieldId);

  if (
    !["one", "many"].includes(input.cardinality) ||
    !["one", "many"].includes(input.inverseCardinality) ||
    !["live", "snapshot"].includes(input.valueMode)
  ) {
    throw new BadRequestException("关系数量或取值方式不合法");
  }

  if (
    !Array.isArray(input.columns) ||
    input.columns.length > 12 ||
    new Set(input.columns).size !== input.columns.length ||
    !Array.isArray(input.filters) ||
    input.filters.length > 10 ||
    !Array.isArray(input.mappings) ||
    input.mappings.length > 20
  ) {
    throw new BadRequestException("展示列、筛选或回填配置不合法");
  }

  input.columns.forEach(identifier);

  const filters = input.filters.map((filter: unknown) => {
    object(filter);
    identifier(filter.id);
    identifier(filter.sourceFieldId);
    if (
      !["equals", "notEquals", "contains", "greater", "less", "notEmpty"].includes(
        filter.operator,
      ) ||
      !["constant", "field"].includes(filter.source) ||
      typeof filter.value !== "string" ||
      filter.value.length > 1000
    ) {
      throw new BadRequestException("关联筛选只支持常量或本表字段");
    }
    if (filter.source === "field") {
      identifier(filter.value);
    }
    return {
      id: filter.id,
      sourceFieldId: filter.sourceFieldId,
      operator: filter.operator,
      source: filter.source,
      value: filter.value,
    };
  });

  if (new Set(filters.map((f: any) => f.id)).size !== filters.length) {
    throw new BadRequestException("筛选标识重复");
  }

  const mappings = input.mappings.map((mapping: unknown) => {
    object(mapping);
    identifier(mapping.fromTargetFieldId);
    identifier(mapping.toSourceFieldId);
    return {
      fromTargetFieldId: mapping.fromTargetFieldId,
      toSourceFieldId: mapping.toSourceFieldId,
    };
  });

  const duplicateMappingTarget =
    new Set(mappings.map((m: any) => m.toSourceFieldId)).size !== mappings.length;
  if (duplicateMappingTarget || (mappings.length && input.cardinality !== "one")) {
    throw new BadRequestException("回填目标不能重复，且单值回填需要将可关联数量设为一条");
  }

  return {
    title: input.title.trim(),
    sourceDefinitionId: input.sourceDefinitionId,
    targetDefinitionId: input.targetDefinitionId,
    ...(input.sourceSubformId ? { sourceSubformId: input.sourceSubformId } : {}),
    cardinality: input.cardinality,
    inverseCardinality: input.inverseCardinality,
    labelFieldId: input.labelFieldId,
    columns: [...input.columns],
    filters,
    mappings,
    valueMode: input.valueMode,
  };
}

/**
 * 解析并校验关联关系两端引用的表单字段：
 * - 校验来源明细表、目标展示列、筛选字段与回填字段是否存在；
 * - 校验回填源字段与回填目标字段的数据类型是否兼容。
 */
export function relationFields(spec: RelationSpec, source: FormSchema, target: FormSchema) {
  const parent = spec.sourceSubformId
    ? source.fields.find((f) => f.id === spec.sourceSubformId && f.type === "subform")
    : undefined;
  if (spec.sourceSubformId && !parent) {
    throw new BadRequestException("关系引用的来源明细已失效或不适用于此记录版本");
  }

  const sourceFields = (parent ? parent.children : source.fields).filter(
    (f) => f.type !== "subform",
  );
  const targetFields = target.fields.filter((f) => f.type !== "subform");

  const src = (id: string) => sourceFields.find((f) => f.id === id);
  const dst = (id: string) => targetFields.find((f) => f.id === id);

  const requiredTargetIds = [
    spec.labelFieldId,
    ...spec.columns,
    ...spec.filters.map((f) => f.sourceFieldId),
    ...spec.mappings.map((m) => m.fromTargetFieldId),
  ];
  const missingTarget = requiredTargetIds.some((id) => !dst(id));
  const missingFilterSource = spec.filters.some((f) => f.source === "field" && !src(f.value));
  const missingMappingTarget = spec.mappings.some((m) => !src(m.toSourceFieldId));

  if (missingTarget || missingFilterSource || missingMappingTarget) {
    throw new BadRequestException("关系引用的字段已失效或不适用于此记录版本");
  }

  for (const mapping of spec.mappings) {
    const from = dst(mapping.fromTargetFieldId)!;
    const to = src(mapping.toSourceFieldId)!;
    const compatible = valueMappingCompatible(
      { kind: dataKind(from.type)!, settings: from },
      { kind: dataKind(to.type)!, settings: to },
    );
    if (!compatible) {
      throw new BadRequestException("回填字段类型不兼容");
    }
  }

  return { parent, sourceFields, targetFields, src, dst };
}

/** 定位关联关系在来源记录中的作用域数据（主表记录值或指定的子表明细行） */
export function relationScope(
  spec: RelationSpec,
  values: FormValues,
  rowId?: string,
): FormValues {
  if (!spec.sourceSubformId) {
    if (rowId) {
      throw new BadRequestException("此关系不属于明细行");
    }
    return values;
  }

  uuid(rowId);
  const rows = values[spec.sourceSubformId];
  const row = Array.isArray(rows) ? rows.find((r) => r._rowId === rowId) : undefined;
  if (!row) {
    throw new BadRequestException("来源明细行不存在");
  }
  return row;
}

/** 校验当前用户对关联关系所需的展示标题、筛选字段及回填字段是否均具备可见权限 */
export function requireRelationFields(
  spec: RelationSpec,
  source: FormSchema,
  target: FormSchema,
  sourceAccess: AccessGrant,
  targetAccess: AccessGrant,
) {
  const fields = relationFields(spec, source, target);
  const isVisible = (field: FormField, access: AccessGrant, parent?: FormField) =>
    permission(access, field, parent) !== "hidden";

  const requiredTargetFieldIds = [
    spec.labelFieldId,
    ...spec.filters.map((f) => f.sourceFieldId),
    ...spec.mappings.map((m) => m.fromTargetFieldId),
  ];
  for (const id of requiredTargetFieldIds) {
    if (!isVisible(fields.dst(id)!, targetAccess)) {
      throw new ForbiddenException("没有关联所需字段的访问权限");
    }
  }

  for (const filter of spec.filters) {
    if (filter.source === "field" && !isVisible(fields.src(filter.value)!, sourceAccess, fields.parent)) {
      throw new ForbiddenException("没有关联所需字段的访问权限");
    }
  }

  return fields;
}

/** 判断目标记录的值是否满足关联关系配置的全部筛选条件 */
export function matchesRelation(spec: RelationSpec, source: FormValues, target: FormValues) {
  return spec.filters.every((filter) => {
    const actual = choiceConditionValue(target[filter.sourceFieldId]);
    const expected = choiceConditionValue(
      filter.source === "field" ? source[filter.value] : filter.value,
    );
    const a = actual == null ? "" : String(actual);
    const b = expected == null ? "" : String(expected);

    if (filter.operator === "notEmpty") return a !== "";
    if (filter.source === "field" && b === "") return false;

    if (Array.isArray(actual)) {
      const desired = Array.isArray(expected) ? expected : [expected];
      if (filter.operator === "contains") {
        return desired.every((value) => actual.includes(value));
      }
      if (filter.operator === "equals") {
        return equalFieldValues(actual, desired);
      }
      if (filter.operator === "notEquals") {
        return !equalFieldValues(actual, desired);
      }
      return false;
    }

    if (filter.operator === "equals") return a === b;
    if (filter.operator === "notEquals") return a !== b;
    if (filter.operator === "contains") return a.includes(b);

    if (!a || !b || !Number.isFinite(Number(a)) || !Number.isFinite(Number(b))) {
      return false;
    }
    return filter.operator === "greater" ? Number(a) > Number(b) : Number(a) < Number(b);
  });
}

/** 收集关联关系在指定表单定义（来源端或目标端）中引用的所有字段 ID 集合 */
export function referencedRelationFields(spec: RelationSpec, definitionId: string) {
  const sourceRefs =
    definitionId === spec.sourceDefinitionId
      ? [
          spec.sourceSubformId || "",
          ...spec.filters.filter((f) => f.source === "field").map((f) => f.value),
          ...spec.mappings.map((m) => m.toSourceFieldId),
        ]
      : [];

  const targetRefs =
    definitionId === spec.targetDefinitionId
      ? [
          spec.labelFieldId,
          ...spec.columns,
          ...spec.filters.map((f) => f.sourceFieldId),
          ...spec.mappings.map((m) => m.fromTargetFieldId),
        ]
      : [];

  return new Set([...sourceRefs, ...targetRefs].filter(Boolean));
}
