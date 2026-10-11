import { conditionValues } from "./condition-values";
import type {
  ConditionalVisibilityRule,
  FormField,
  FormSchema,
  FormValues,
  FieldOption,
  VisibilityCondition,
  VisibilityRule,
} from "./form";

export const visibilityConditions = (
  rule: VisibilityRule,
): VisibilityCondition[] => ("conditions" in rule ? rule.conditions : [rule]);

/** Dynamic conditions become literals in this draft. An Other selection cannot
 * become a text predicate; published rules retain their original definition. */
export function textVisibilityRules(
  rules: VisibilityRule[],
  field: FormField,
  options: FieldOption[],
): VisibilityRule[] {
  const next = JSON.parse(JSON.stringify(rules)) as VisibilityRule[];
  for (const condition of next.flatMap(visibilityConditions)) {
    if (
      condition.sourceId !== field.id ||
      condition.operator === "empty" ||
      (condition.valueType || field.choiceConversion?.initialType) === "text"
    )
      continue;
    const option =
      options.find((option) => option.id === condition.value) ||
      field.choiceConversion?.options.find(
        (option) => option.id === condition.value,
      );
    if (option?.other)
      throw Error(
        `「${field.label}」的显隐规则使用了“其他”选项，请先调整这条规则再切换为文本`,
      );
    if (field.choiceSource.mode !== "form") continue;
    if (!option)
      throw Error(`「${field.label}」的显隐条件选项已不可用，请先调整该条件`);
    condition.value = option.label;
    condition.valueType = "text";
  }
  return next;
}

/** Tabs share their owner's value scope; subform columns belong to one row. */
export function visibilityScopes(fields: FormField[]) {
  const scopes: { id: string; label: string; fields: FormField[] }[] = [
    { id: "", label: "表单", fields: [] },
  ];
  function visit(items: FormField[], scope: (typeof scopes)[number]) {
    for (const field of items) {
      scope.fields.push(field);
      if (field.type === "subform") {
        const child = {
          id: field.id,
          label: field.label,
          fields: [] as FormField[],
        };
        scopes.push(child);
        visit(field.children, child);
      } else visit(field.children, scope);
    }
  }
  visit(fields, scopes[0]!);
  return scopes;
}

function matches(
  condition: VisibilityCondition,
  values: FormValues,
  fields: FormField[],
) {
  const field = fields.find((field) => field.id === condition.sourceId);
  const pair = conditionValues(
    field,
    field,
    values[condition.sourceId],
    condition.value,
    condition.valueType,
  );
  if (!pair && condition.operator !== "empty") return false;
  const value = pair?.actual ?? values[condition.sourceId];
  const expected = String(pair?.expected ?? condition.value);
  const text = String(value ?? "");
  return condition.operator === "empty"
    ? value == null || text === "" || (Array.isArray(value) && !value.length)
    : condition.operator === "equals"
      ? text === expected
      : condition.operator === "notEquals"
        ? text !== expected
        : condition.operator === "greater"
          ? Number(value) > Number(expected)
          : Array.isArray(value)
            ? value.includes(expected)
            : text.includes(expected);
}

export function visibleByRules(
  id: string,
  rules: VisibilityRule[],
  values: FormValues,
  path = new Set<string>(),
  fields: FormField[] = [],
): boolean {
  if (path.has(id)) return false;
  const applicable = rules.filter((rule) => rule.targetIds.includes(id));
  if (!applicable.length) return true;
  const next = new Set(path).add(id);
  const legacy = applicable.filter((rule) => !("conditions" in rule));
  if (
    legacy.length &&
    legacy.every((rule) => matches(rule as VisibilityCondition, values, fields))
  )
    return true;
  return applicable.some((rule) => {
    if (!("conditions" in rule) || !rule.conditions.length) return false;
    const test = (condition: VisibilityCondition) =>
      matches(condition, values, fields) &&
      (rule.cascade === false ||
        visibleByRules(condition.sourceId, rules, values, next, fields));
    return rule.match === "any"
      ? rule.conditions.some(test)
      : rule.conditions.every(test);
  });
}

/** Compile historical overlapping targets into explicit AND groups only in an editor buffer. */
export function editableVisibilityRules(
  rules: VisibilityRule[],
): ConditionalVisibilityRule[] {
  const result = JSON.parse(
    JSON.stringify(rules.filter((rule) => "conditions" in rule)),
  ) as ConditionalVisibilityRule[];
  const legacy = rules.filter((rule) => !("conditions" in rule));
  const signatures = new Map<string, ConditionalVisibilityRule>();
  for (const target of new Set(legacy.flatMap((rule) => rule.targetIds))) {
    const controlling = legacy.filter((rule) =>
      rule.targetIds.includes(target),
    );
    const key = JSON.stringify(controlling.map((rule) => rule.id));
    const existing = signatures.get(key);
    if (existing) existing.targetIds.push(target);
    else {
      const first = controlling[0]!;
      let id =
        controlling.length === 1 ? first.id : `legacy_${first.id}_${target}`;
      while (result.some((rule) => rule.id === id)) id += "_";
      const group: ConditionalVisibilityRule = {
        id,
        conditions: controlling.map((rule) => {
          const { sourceId, operator, value, valueType } =
            rule as VisibilityCondition;
          return {
            sourceId,
            operator,
            value,
            ...(valueType ? { valueType } : {}),
          };
        }),
        match: "all",
        targetIds: [target],
        cascade: false,
      };
      signatures.set(key, group);
      result.push(group);
    }
  }
  return result;
}

export function visibilityRuleIssue(
  rule: ConditionalVisibilityRule,
  fields: FormField[],
): string {
  if (!rule.conditions.length || !rule.targetIds.length)
    return "请选择条件和显示字段";
  const scopes = visibilityScopes(fields);
  const ids = new Set(
    scopes.flatMap((scope) => scope.fields.map((field) => field.id)),
  );
  if (
    rule.conditions.some((condition) => !ids.has(condition.sourceId)) ||
    rule.targetIds.some((id) => !ids.has(id))
  )
    return "显隐规则引用的字段已不存在";
  if (
    rule.targetIds.some((id) =>
      rule.conditions.some((condition) => condition.sourceId === id),
    )
  )
    return "条件字段不能同时作为显示字段";
  if (rule.cascade !== false) {
    const scope = scopes.find((scope) =>
      scope.fields.some((field) => field.id === rule.conditions[0]!.sourceId),
    )!;
    const scopedIds = new Set(scope.fields.map((field) => field.id));
    if (
      rule.conditions.some((condition) => !scopedIds.has(condition.sourceId)) ||
      rule.targetIds.some((id) => !scopedIds.has(id))
    )
      return "条件和显示字段须属于同一表单或同一子表单";
  }
  return "";
}

export function parseVisibilityRules(
  raw: unknown,
  fields: FormField[],
  checkFieldReferences = true,
): VisibilityRule[] {
  if (!Array.isArray(raw)) return [];
  const ids = new Set(
    visibilityScopes(fields).flatMap((scope) =>
      scope.fields.map((field) => field.id),
    ),
  );
  const operators = ["equals", "notEquals", "contains", "greater", "empty"];
  const result: VisibilityRule[] = [];
  for (const rule of raw) {
    if (
      rule?.valueType !== undefined &&
      !["text", "choice"].includes(rule.valueType)
    )
      throw Error("显隐条件值类型无效");
    if (rule && typeof rule === "object" && "conditions" in rule) {
      if (
        typeof rule.id !== "string" ||
        !Array.isArray(rule.conditions) ||
        !["all", "any"].includes(rule.match) ||
        !Array.isArray(rule.targetIds) ||
        rule.targetIds.some((id: unknown) => typeof id !== "string") ||
        (rule.cascade !== undefined && rule.cascade !== false) ||
        rule.conditions.some(
          (condition: any) =>
            !condition ||
            typeof condition.sourceId !== "string" ||
            !operators.includes(condition.operator) ||
            typeof condition.value !== "string" ||
            (condition.valueType !== undefined &&
              !["text", "choice"].includes(condition.valueType)),
        )
      )
        throw Error("显隐规则结构不合法，请保留原配置后重试");
      const group = rule as ConditionalVisibilityRule;
      const issue = checkFieldReferences
        ? visibilityRuleIssue(group, fields)
        : undefined;
      if (issue) throw Error(issue);
      if (result.some((item) => item.id === rule.id))
        throw Error("显隐规则身份重复");
      result.push(JSON.parse(JSON.stringify(group)));
    } else if (
      typeof rule?.id === "string" &&
      typeof rule.sourceId === "string" &&
      (!checkFieldReferences || ids.has(rule.sourceId)) &&
      operators.includes(rule.operator) &&
      Array.isArray(rule.targetIds)
    ) {
      // Keep the historical parser's single-condition behavior and shape.
      result.push({
        ...rule,
        value: String(rule.value ?? ""),
        targetIds: rule.targetIds.filter(
          (id: string) =>
            typeof id === "string" && (!checkFieldReferences || ids.has(id)),
        ),
      });
    }
  }
  return result;
}

/** Server writes must reject malformed rules rather than silently filtering them. */
export function validateVisibilityRules(
  raw: unknown,
  fields: FormField[],
  checkReferences = true,
): VisibilityRule[] {
  if (!Array.isArray(raw) || raw.length > 200)
    throw Error("显隐规则应为列表且不能超过200条");
  const ids = new Set<string>();
  const fieldIds = new Set(
    visibilityScopes(fields).flatMap((scope) =>
      scope.fields.map((field) => field.id),
    ),
  );
  for (const rule of raw) {
    if (
      !rule ||
      typeof rule !== "object" ||
      typeof rule.id !== "string" ||
      !rule.id ||
      rule.id.length > 200 ||
      ids.has(rule.id)
    )
      throw Error("显隐规则身份无效或重复");
    ids.add(rule.id);
    const grouped = "conditions" in rule;
    const keys = grouped
      ? ["id", "conditions", "match", "targetIds", "cascade"]
      : ["id", "sourceId", "operator", "value", "valueType", "targetIds"];
    if (
      Object.keys(rule).some((key) => !keys.includes(key)) ||
      !Array.isArray(rule.targetIds) ||
      !rule.targetIds.length ||
      rule.targetIds.some(
        (id: unknown) =>
          typeof id !== "string" ||
          !id ||
          (checkReferences && !fieldIds.has(id)),
      ) ||
      new Set(rule.targetIds).size !== rule.targetIds.length
    )
      throw Error("显隐规则的显示字段无效");
    const conditions = grouped ? rule.conditions : [rule];
    if (
      !Array.isArray(conditions) ||
      !conditions.length ||
      conditions.length > 200 ||
      (grouped && !["all", "any"].includes(rule.match)) ||
      (rule.cascade !== undefined && rule.cascade !== false)
    )
      throw Error("显隐规则条件无效");
    for (const condition of conditions) {
      if (
        !condition ||
        typeof condition !== "object" ||
        (grouped &&
          Object.keys(condition).some(
            (key) =>
              !["sourceId", "operator", "value", "valueType"].includes(key),
          )) ||
        typeof condition.sourceId !== "string" ||
        !condition.sourceId ||
        (checkReferences && !fieldIds.has(condition.sourceId)) ||
        !["equals", "notEquals", "contains", "greater", "empty"].includes(
          condition.operator,
        ) ||
        typeof condition.value !== "string" ||
        condition.value.length > 10000 ||
        (condition.valueType !== undefined &&
          !["text", "choice"].includes(condition.valueType))
      )
        throw Error("显隐规则引用或条件值无效");
    }
  }
  return parseVisibilityRules(raw, fields, checkReferences);
}

/** Conditional visibility is presentation, never an extra permission grant.
 * Mask unavailable conditions as false without exposing their identifiers or constants. */
export function readableVisibilityRules(
  rules: VisibilityRule[],
  ids: Set<string>,
): VisibilityRule[] {
  return editableVisibilityRules(rules).flatMap((rule) => {
    const targetIds = rule.targetIds.filter((id) => ids.has(id));
    if (!targetIds.length) return [];
    const available = rule.conditions.filter((condition) =>
      ids.has(condition.sourceId),
    );
    return [
      {
        ...rule,
        targetIds,
        conditions:
          rule.match === "any" || available.length === rule.conditions.length
            ? available
            : [],
      },
    ];
  });
}

export function ruleFieldVisible(
  field: FormField,
  schema: FormSchema,
  values: FormValues,
): boolean {
  return (
    field.visible &&
    visibleByRules(
      field.id,
      schema.settings.rules,
      values,
      new Set(),
      visibilityScopes(schema.fields).flatMap((scope) => scope.fields),
    )
  );
}
