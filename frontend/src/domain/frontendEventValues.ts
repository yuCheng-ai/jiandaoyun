import { subformRowCountIssue } from "@platform/contracts";
import {
  isMultipleChoice,
  hasFieldValue,
  normalizeDateValue,
  toggleChoice,
  validDateValue,
  isFileValue,
  fileValueIssue,
  isLocationValue,
  isAddressValue,
} from "@platform/contracts";
import {
  copy,
  findField,
  isFieldVisibleInSchema,
  type FormField,
  type FormSchema,
  type FormValues,
} from "./form";
import {
  applyFieldChange,
  choiceTypes,
  resolveChoices,
  runtimeDefaults,
  relationCandidates,
  fieldInputDependencies,
} from "./relations";
import { allowedDepartments, allowedEmployees } from "./organization";
import { sanitizeRichText } from "./richText";
import type { WorkspaceData } from "./workspace";

export function coerceFrontendValue(
  field: FormField,
  value: unknown,
  data: WorkspaceData,
  values: FormValues,
  inputFields: FormField[] = [],
): unknown {
  if (!hasFieldValue(field)) throw Error("操作入口不能作为回填字段");
  const arrayType =
    isMultipleChoice(field.type) ||
    ["members", "departments", "file", "image", "relationTable"].includes(
      field.type,
    );
  if (value === null) return arrayType ? [] : "";
  if (["file", "image"].includes(field.type)) {
    if (!Array.isArray(value) || value.some((item) => !isFileValue(item)))
      throw Error("返回值需要有效附件列表");
    const issue = fileValueIssue(field, value);
    if (issue) throw Error(issue);
    return copy(value);
  }
  if (
    [
      "member",
      "members",
      "department",
      "departments",
      "relation",
      "relationTable",
    ].includes(field.type)
  ) {
    if (
      arrayType !== Array.isArray(value) ||
      (Array.isArray(value) ? value : [value]).some(
        (item) => typeof item !== "string",
      )
    )
      throw Error("返回值的选择类型不兼容");
    const allowed = field.type.startsWith("department")
      ? allowedDepartments(data.organization, field.organization.scope, values)
      : field.type.startsWith("member")
        ? allowedEmployees(data.organization, field.organization.scope, values)
        : relationCandidates(field, data, values, "", inputFields);
    if (
      (Array.isArray(value) ? value : [value]).some(
        (id) => !allowed.some((item) => item.id === id),
      )
    )
      throw Error("返回值不在当前可选范围内");
    return copy(value);
  }
  if (field.type === "richtext") {
    if (typeof value !== "string") throw Error("返回值需要富文本");
    return sanitizeRichText(value);
  }
  if (field.type === "number") {
    if (
      (typeof value !== "number" && typeof value !== "string") ||
      (typeof value === "string" && !value.trim()) ||
      !Number.isFinite(Number(value))
    )
      throw Error("返回值需要有效数字");
    return Number(value);
  }
  if (field.type === "datetime") {
    if (typeof value !== "string") throw Error("返回值需要日期文本");
    let date = value.replace(" ", "T");
    if (/Z$|[+-]\d\d:\d\d$/.test(date)) {
      if (
        !validDateValue(
          "datetime-second",
          date.replace(/(?:Z|[+-]\d\d:\d\d)$/, "").replace(/\.\d+$/, ""),
        )
      )
        throw Error("返回日期无效");
      const d = new Date(date);
      if (!Number.isFinite(d.getTime())) throw Error("返回日期无效");
      const pad = (n: number) => String(n).padStart(2, "0");
      date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    }
    if (
      !["month", "date", "datetime-second"].some((format) =>
        validDateValue(format, date),
      )
    )
      throw Error("返回日期无效");
    date = date.slice(
      0,
      field.format === "month"
        ? 7
        : field.format === "date"
          ? 10
          : field.format === "datetime-local"
            ? 16
            : 19,
    );
    if (!validDateValue(field.format, date)) throw Error("返回日期无效");
    return normalizeDateValue(field.format, date);
  }
  if (field.type === "location") {
    if (!field.location && typeof value === "string") return value;
    if (!isLocationValue(value)) throw Error("返回值需要有效的定位对象");
    return copy(value);
  }
  if (field.type === "address") {
    if (!isAddressValue(value)) throw Error("返回值需要有效的地址对象");
    return copy(value);
  }
  if (choiceTypes.includes(field.type)) {
    const multi = isMultipleChoice(field.type);
    if (multi !== Array.isArray(value))
      throw Error(multi ? "返回值需要选项文本数组" : "返回值需要单个选项文本");
    const choices = resolveChoices(field, data, values, inputFields);
    const ids = (multi ? (value as unknown[]) : [value]).map((item) => {
      const options = choices.filter(
        (option) =>
          !option.other && (option.id === item || option.label === item),
      );
      if (options.length !== 1) throw Error("返回选项不存在或名称重复");
      return options[0]!.id;
    });
    return multi
      ? ids.reduce<string[]>(
          (values, id) => toggleChoice(field, values, id, true, choices),
          [],
        )
      : ids[0];
  }
  if (typeof value === "object" || value === undefined)
    throw Error("返回值需要文本");
  return String(value);
}

/** Convert one value scope in dependency order; callers retain their own write checks. */
export function mapFrontendScopeValues(
  items: { field: FormField; value: unknown }[],
  initial: FormValues,
  scope: FormField[],
  data: WorkspaceData,
  root: FormValues = {},
  allFields: FormField[] = scope,
) {
  const pending = new Map(items.map((item) => [item.field.id, item]));
  const done = new Set<string>(),
    resolving = new Set<string>();
  const mapped: FormValues = {};
  let current = copy(initial);
  function resolve(id: string) {
    if (done.has(id)) return;
    if (resolving.has(id)) throw Error("回填字段存在循环依赖，请检查字段联动");
    const field = findField(allFields, id);
    if (!field) return;
    resolving.add(id);
    fieldInputDependencies(field).forEach(resolve);
    const item = pending.get(id);
    if (item) {
      try {
        const value = coerceFrontendValue(field, item.value, data, {
          ...root,
          ...current,
        }, allFields);
        current = applyFieldChange(
          scope,
          current,
          id,
          value,
          data,
          root,
          allFields,
        );
        mapped[id] = value;
      } catch (e) {
        throw Error(`${field.label}：${(e as Error).message}`);
      }
    }
    resolving.delete(id);
    done.add(id);
  }
  items.forEach(({ field }) => resolve(field.id));
  for (const { field } of items) {
    try {
      coerceFrontendValue(
        field,
        pending.get(field.id)!.value === null ? null : mapped[field.id],
        data,
        { ...root, ...current },
        allFields,
      );
    } catch (e) {
      throw Error(`${field.label}：${(e as Error).message}`);
    }
  }
  return { mapped, current };
}

export function mapFrontendValues(
  schema: FormSchema,
  values: FormValues,
  data: WorkspaceData,
  fields: (FormField & { parentId: string })[],
  mappings: { fieldId: string; value: unknown }[],
  fill: "merge" | "replace",
  row?: { subformId: string; index: number },
  clearUnmapped = false,
): FormValues {
  const scalar: { field: FormField; value: unknown }[] = [];
  const groups = new Map<string, { field: FormField; items: unknown[] }[]>();
  for (const mapping of mappings) {
    const field = fields.find((f) => f.id === mapping.fieldId);
    if (
      !field ||
      !hasFieldValue(field) ||
      !field.visible ||
      !field.editable ||
      (row && field.parentId !== row.subformId)
    )
      throw Error("当前回填字段不可编辑，未回填任何字段");
    if (field.parentId && !row) {
      if (!Array.isArray(mapping.value))
        throw Error(`${field.label}：明细列需要数组返回值`);
      const group = groups.get(field.parentId) || [];
      group.push({ field, items: mapping.value });
      groups.set(field.parentId, group);
    } else {
      scalar.push({ field, value: mapping.value });
    }
  }

  // Convert dependencies first; a customer and its category share one fill.
  // Reuse normal field changes for formulas and clearing dependent values.
  function mapScope(
    items: typeof scalar,
    initial: FormValues,
    scope: FormField[],
    root: FormValues = {},
    originalRoot: FormValues = {},
  ) {
    for (const { field } of items)
      if (
        !isFieldVisibleInSchema(field, schema, { ...originalRoot, ...initial })
      )
        throw Error(`${field.label}：当前回填字段不可编辑`);
    const result = mapFrontendScopeValues(
      items,
      initial,
      scope,
      data,
      root,
      schema.fields,
    );
    for (const { field } of items) {
      const context = { ...root, ...result.current };
      if (!isFieldVisibleInSchema(field, schema, context))
        throw Error(`${field.label}：当前回填字段不可编辑`);
    }
    return result;
  }

  const result = mapScope(
    scalar,
    values,
    row ? findField(schema.fields, row.subformId)!.children : schema.fields,
    row ? values : {},
  );
  const mappedValues = result.mapped;
  for (const [id, mappings] of groups) {
    const parent = findField(schema.fields, id)!;
    const old = Array.isArray(values[id]) ? (values[id] as FormValues[]) : [];
    if (
      clearUnmapped &&
      old.some((row) =>
        fields.some(
          (field) =>
            field.parentId === id &&
            (!field.editable ||
              !isFieldVisibleInSchema(field, schema, { ...values, ...row })),
        ),
      )
    )
      throw Error(`${parent.label}：含不可编辑列，不能清空已有明细`);
    const count = Math.max(
      0,
      ...mappings.map((mapping) => mapping.items.length),
    );
    const rowIssue = subformRowCountIssue(
      parent,
      fill === "merge" ? Math.max(old.length, count) : count,
      old.length,
    );
    if (rowIssue) throw Error(rowIssue);
    if (
      fill === "replace" &&
      count < old.length &&
      old.slice(count).some((row) =>
        fields.some(
          (field) =>
            field.parentId === id &&
            (!field.editable ||
              !isFieldVisibleInSchema(field, schema, {
                ...values,
                ...row,
              })),
        ),
      )
    )
      throw Error(`${parent.label}：含不可编辑列，不能缩减已有明细行`);
    const currentRows = Array.isArray(result.current[id])
      ? (result.current[id] as FormValues[])
      : [];
    const rows = Array.from(
      {
        length: fill === "merge" ? Math.max(old.length, count) : count,
      },
      (_, index) =>
        copy(
          (!clearUnmapped && currentRows[index]) ||
            runtimeDefaults(
              parent.children,
              data,
              result.current,
              schema.fields,
            ),
        ),
    );
    for (let index = 0; index < rows.length; index++) {
      rows[index] = mapScope(
        mappings
          .filter((mapping) => fill !== "merge" || index < mapping.items.length)
          .map((mapping) => ({
            field: mapping.field,
            value: index < mapping.items.length ? mapping.items[index] : null,
          })),
        rows[index]!,
        parent.children,
        result.current,
        values,
      ).current;
    }
    mappedValues[id] = rows;
    result.current = applyFieldChange(
      schema.fields,
      result.current,
      id,
      rows,
      data,
    );
  }
  for (const { field } of scalar)
    if (!isFieldVisibleInSchema(field, schema, result.current))
      throw Error(`${field.label}：当前回填字段不可编辑`);
  return mappedValues;
}

export function frontendValueFields(
  schema: Pick<FormSchema, "fields">,
  includeActions = false,
): (FormField & { parentId: string; pathLabel: string })[] {
  const visit = (
    fields: FormField[],
    parentId = "",
    prefix = "",
    visible = true,
    editable = true,
  ): ReturnType<typeof frontendValueFields> =>
    fields.flatMap((field) => {
      const item = {
        ...field,
        visible: visible && field.visible,
        editable: editable && field.editable,
        parentId,
        pathLabel: prefix + field.label,
      };
      return field.type === "tabs"
        ? visit(field.children, parentId, prefix, item.visible, item.editable)
        : field.type === "subform"
          ? [
              item,
              ...visit(
                field.children,
                field.id,
                prefix + field.label + " · ",
                item.visible,
                item.editable,
              ),
            ]
          : [item];
    });
  return visit(schema.fields).filter(
    (field) =>
      !["tabs", "divider", "subform"].includes(field.type) &&
      (includeActions || hasFieldValue(field)),
  );
}
