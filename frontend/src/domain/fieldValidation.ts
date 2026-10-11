import {
  flattenFields,
  isFieldVisible,
  type FormSchema,
  type FormValues,
  type FieldError,
  type FormField,
} from "./form";
import type { WorkspaceData } from "./workspace";
import { formValidationErrors } from "./formValidation";
import { frontendEventsIssues } from "./frontendEvents";
import {
  fileSettingsErrors,
  subformRowCountIssue,
  isDateFormat,
  validDateValue,
  locationSettingsErrors,
  dateRangeErrors,
  dateScopeFields,
  maxChoiceOptions,
  maxChoiceLabelLength,
  choiceSettingsErrors,
  tabAppearanceErrors,
  dividerAppearanceErrors,
  hasFieldValue,
  subformWidthErrors,
  subformFixedColumnErrors,
  subformMobileErrors,
  subformPermissionSettingErrors,
  choiceValueIssue,
  externalStyleErrors,
  addressTypes,
  textFormatSettingsErrors,
  fieldTextPropertiesErrors,
} from "@platform/contracts";
import {
  choiceTypes,
  organizationTypes,
  relationTypes,
  sourceFields,
  scopeFields,
  resolveChoices,
  relationCandidates,
  idsOf,
  defaultLinkLocalFields,
  defaultLinkSourceFields,
} from "./relations";
import { lookupIssues } from "./lookup";
import { ocrConfigurationErrors } from "./ocr";
import { addressValueIssue } from "./address";
import { serialConfigurationErrors } from "./serial";
import { selectionSourceFields } from "./frontendSelections";
import { defaultLinkTypes, linkTypesMatch } from "./fieldConfig";
import { richTextValueIssue } from "./richText";
import { allowedEmployees, allowedDepartments } from "./organization";
import {
  formulaConfigurationErrors,
  formulaReferences,
  formulaValue,
  usesFormula,
} from "./formula";
export function defaultLinkErrors(
  field: FormField,
  fields: FormField[],
  data: WorkspaceData,
): string[] {
  if (!field.defaultLink?.enabled) return [];
  const errors: string[] = [],
    config = field.defaultLink;
  const remote = defaultLinkSourceFields(data, config.formId);
  const local = defaultLinkLocalFields(fields, field.id);
  if (!defaultLinkTypes.includes(field.type))
    errors.push("此字段默认值联动尚未接入");
  if (!data.forms.some((f) => f.id === config.formId && !f.archived))
    errors.push("请选择有效的联动表单");
  const source = remote.find((f) => f.id === config.fieldId);
  if (!source || !linkTypesMatch(field, source))
    errors.push("请选择同类型的联动字段");
  if (field.type === "subform") {
    const mappings = config.mappings || [];
    if (!mappings.length) errors.push("请添加需要联动的子字段");
    const targets = new Set<string>();
    for (const mapping of mappings) {
      const target = field.children.find((f) => f.id === mapping.targetFieldId);
      const from = source?.children.find((f) => f.id === mapping.sourceFieldId);
      if (
        !target ||
        !from ||
        !linkTypesMatch(target, from) ||
        targets.has(mapping.targetFieldId)
      )
        errors.push("子字段联动对应已失效、重复或类型不匹配");
      targets.add(mapping.targetFieldId);
    }
  }
  for (const filter of config.filters) {
    const remoteField = remote.find((f) => f.id === filter.sourceFieldId);
    if (
      !remoteField ||
      ["subform", "tabs", "divider", "button", "file", "image"].includes(
        remoteField.type,
      )
    )
      errors.push("联动条件的来源字段已失效");
    if (remoteField?.type === "address") {
      if (!["equals", "notEquals", "notEmpty"].includes(filter.operator))
        errors.push("联动条件的比较方式不适用于地址字段");
      if (filter.operator !== "notEmpty" && filter.source !== "field")
        errors.push("地址条件请使用当前表单字段");
    }
    if (filter.operator !== "notEmpty" && filter.source === "field") {
      const localField = local.find((f) => f.id === filter.value);
      if (
        !localField ||
        !remoteField ||
        !linkTypesMatch(remoteField, localField)
      )
        errors.push("联动条件的引用字段已失效或类型不匹配");
    }
  }
  return [...new Set(errors)];
}
export function richTextDefaultErrors(
  fields: FormField[],
  previous: FormField[] = [],
): string[] {
  const originals = new Map(
    flattenFields(previous).map((field) => [field.id, field]),
  );
  return flattenFields(fields).flatMap((field) => {
    if (field.type !== "richtext" || field.defaultLink?.enabled) return [];
    const original = originals.get(field.id);
    const issue = richTextValueIssue(
      field.defaultValue,
      original?.type === "richtext" ? original.defaultValue : undefined,
    );
    return issue ? [`「${field.label}」默认值${issue}`] : [];
  });
}
export function validateFieldConfiguration(
  schema: FormSchema,
  data: WorkspaceData,
  previousFields: FormField[] = [],
): string[] {
  const errors: string[] = [
      ...externalStyleErrors(schema.settings),
      ...frontendEventsIssues(schema, data),
      ...richTextDefaultErrors(schema.fields, previousFields),
    ],
    fields = flattenFields(schema.fields),
    ids = new Set(fields.map((f) => f.id));
  const graph = new Map<string, string[]>();
  const subfieldIds = new Set(
    fields
      .filter((field) => field.type === "subform")
      .flatMap((field) =>
        flattenFields(field.children).map((child) => child.id),
      ),
  );
  for (const field of fields) {
    const fail = (message: string) =>
      errors.push(`「${field.label || "未命名字段"}」${message}`);
    fieldTextPropertiesErrors(field, subfieldIds.has(field.id)).forEach(fail);
    const dependencies: string[] = [];
    if (field.type === "subform" && field.defaultRows) {
      const issue = subformRowCountIssue(field, field.defaultRows.length);
      if (issue) errors.push(issue);
    }
    if (usesFormula(field))
      dependencies.push(...formulaReferences(field.expression));
    if (field.defaultFormula || field.calculationVersion === 1)
      formulaConfigurationErrors(field, schema.fields).forEach(fail);
    choiceSettingsErrors(field).forEach(fail);
    textFormatSettingsErrors(field).forEach(fail);
    tabAppearanceErrors(field).forEach(fail);
    dividerAppearanceErrors(field).forEach(fail);
    subformWidthErrors(field).forEach(fail);
    subformFixedColumnErrors(field).forEach(fail);
    subformMobileErrors(field, true).forEach(fail);
    subformPermissionSettingErrors(field).forEach(fail);
    fileSettingsErrors(field).forEach(fail);
    serialConfigurationErrors(field, schema).forEach(fail);
    if (field.serial)
      dependencies.push(
        ...field.serial.rules.flatMap((r) =>
          r.type === "field" ? [r.fieldId] : [],
        ),
      );
    if (field.defaultLink?.enabled) {
      defaultLinkErrors(field, schema.fields, data).forEach(fail);
      dependencies.push(
        ...field.defaultLink.filters
          .filter((f) => f.source === "field" && f.operator !== "notEmpty")
          .map((f) => f.value),
      );
    }
    locationSettingsErrors(field, [
      ...scopeFields(schema.fields),
      ...dateScopeFields(schema.fields, field.id),
    ]).forEach(fail);
    ocrConfigurationErrors(field, schema).forEach(fail);
    dateRangeErrors(field, dateScopeFields(schema.fields, field.id)).forEach(
      fail,
    );
    if (field.type === "datetime") {
      if (!isDateFormat(field.format)) fail("请选择有效的日期类型");
      else if (
        !field.defaultLink?.enabled &&
        !field.defaultFormula &&
        field.dateDefault !== "now" &&
        field.defaultValue !== "" &&
        !validDateValue(field.format, field.defaultValue)
      )
        fail("默认日期或时间不合法");
    }
    if (field.type === "address") {
      if (
        field.format !== "none" &&
        !addressTypes.some((type) => type.value === field.format)
      )
        fail("请选择有效的地址类型");
      if (!field.defaultLink?.enabled) {
        const issue = addressValueIssue(
          { ...field, addressComplete: false },
          field.defaultValue,
        );
        if (issue) fail(`默认${issue}`);
      }
    }
    if (field.type === "number") {
      if (
        field.limitRange !== false &&
        field.min !== undefined &&
        field.max !== undefined &&
        field.min > field.max
      )
        fail("最小值不能大于最大值");
    }
    const filters = choiceTypes.includes(field.type)
      ? field.choiceSource.filters
      : relationTypes.includes(field.type)
        ? field.reference.filters
        : [];
    if (
      choiceTypes.includes(field.type) &&
      field.choiceSource.mode === "manual"
    ) {
      const optionIds = new Set<string>();
      if (!field.options.length || field.options.length > maxChoiceOptions)
        fail(`应包含 1–${maxChoiceOptions} 个选项`);
      for (const option of field.options) {
        if (!option.label.trim()) fail("存在空白选项");
        if (option.label.length > maxChoiceLabelLength)
          fail(`选项名称不能超过${maxChoiceLabelLength}个字`);
        if (optionIds.has(option.id)) fail("选项标识重复");
        optionIds.add(option.id);
      }
    }
    if (
      (choiceTypes.includes(field.type) &&
        field.choiceSource.mode === "form") ||
      relationTypes.includes(field.type)
    ) {
      const formId = choiceTypes.includes(field.type)
        ? field.choiceSource.formId
        : field.referenceFormId;
      const form = data.forms.find((f) => f.id === formId && !f.archived);
      const remote =
        field.type === "lookup"
          ? selectionSourceFields(data, formId, "lookup")
          : sourceFields(data, formId);
      if (field.type === "lookup")
        lookupIssues(field, schema, data).forEach(fail);
      const remoteIds = new Set(remote.map((f) => f.id));
      const localIds = new Set(
        defaultLinkLocalFields(schema.fields, field.id).map((f) => f.id),
      );
      if (!form) fail("请选择有效的数据来源表单");
      if (choiceTypes.includes(field.type)) {
        if (!remoteIds.has(field.choiceSource.labelFieldId))
          fail("请选择有效的显示字段");
        if (
          field.choiceSource.valueFieldId &&
          !remoteIds.has(field.choiceSource.valueFieldId)
        )
          fail("保存值字段已失效");
      } else {
        if (field.referenceFieldId && !remoteIds.has(field.referenceFieldId))
          fail("关联显示字段已失效");
        if (field.reference.columns.some((id) => !remoteIds.has(id)))
          fail("展示列含已失效字段");
        if (field.reference.mode === "reverse") {
          const reverse = remote.find(
            (f) => f.id === field.reference.reverseFieldId,
          );
          if (
            !reverse ||
            !relationTypes.includes(reverse.type) ||
            reverse.reference.mode === "reverse"
          )
            fail("请选择有效的反向关联字段");
        }
        const mapped = new Set<string>();
        for (const m of field.reference.mappings) {
          if (
            !remoteIds.has(m.sourceFieldId) ||
            !fields.some((f) => f.id === m.targetFieldId && hasFieldValue(f))
          )
            fail("字段映射不完整或引用已失效");
          if (mapped.has(m.targetFieldId)) fail("同一目标字段不能重复回填");
          mapped.add(m.targetFieldId);
          const deps = graph.get(m.targetFieldId) || [];
          graph.set(m.targetFieldId, [...deps, field.id]);
        }
      }
      for (const filter of filters) {
        if (!remoteIds.has(filter.sourceFieldId))
          fail("筛选条件的来源字段已失效");
        if (filter.source === "field" && filter.operator !== "notEmpty") {
          if (!localIds.has(filter.value))
            fail("筛选条件的引用字段不在当前可用范围内");
          dependencies.push(filter.value);
        }
      }
    }
    if (
      organizationTypes.includes(field.type) &&
      field.organization.scope.mode === "fieldDepartment"
    ) {
      const dependency = defaultLinkLocalFields(schema.fields, field.id).find(
        (f) => f.id === field.organization.scope.fieldId,
      );
      if (
        !dependency ||
        !["department", "departments"].includes(dependency.type)
      )
        fail("请选择有效的部门依赖字段");
      dependencies.push(field.organization.scope.fieldId);
    }
    graph.set(field.id, [...(graph.get(field.id) || []), ...dependencies]);
  }
  const done = new Set<string>(),
    active = new Set<string>();
  let cyclic = false;
  function visit(id: string) {
    if (active.has(id)) {
      cyclic = true;
      return;
    }
    if (done.has(id)) return;
    active.add(id);
    for (const dependency of graph.get(id) || []) visit(dependency);
    active.delete(id);
    done.add(id);
  }
  for (const id of graph.keys()) visit(id);
  if (cyclic)
    errors.push("字段联动存在循环引用，请调整筛选条件、部门依赖或回填映射");
  (schema.settings.validations || []).forEach((rule, index) =>
    formValidationErrors(rule, schema.fields).forEach((message) =>
      errors.push(`数据校验 ${index + 1}：${message}`),
    ),
  );
  for (const id of Object.keys(schema.settings.hiddenValueRules || {}))
    if (!ids.has(id))
      errors.push("特殊字段赋值规则引用了已删除字段，请恢复字段或移除该规则");
  return [...new Set(errors)];
}
export function validateDynamicValues(
  schema: FormSchema,
  values: FormValues,
  data: WorkspaceData,
  editableOnly = false,
): FieldError[] {
  const errors: FieldError[] = [];
  function visit(fields: typeof schema.fields, row: FormValues, prefix = "") {
    for (const field of fields) {
      const context = { ...values, ...row };
      if (!isFieldVisible(field, schema, context)) continue;
      if (editableOnly && !field.editable) continue;
      if (field.type === "tabs") {
        visit(field.children, row, prefix);
        continue;
      }
      if (field.type === "subform") {
        if (Array.isArray(row[field.id]))
          (row[field.id] as unknown[]).forEach((r, index) => {
            // Shape errors are reported by validateValues with the original row index.
            if (r && typeof r === "object" && !Array.isArray(r))
              visit(
                field.children,
                r as FormValues,
                `${prefix}${field.id}.${index}.`,
              );
          });
        continue;
      }
      if (field.defaultFormula || field.calculationVersion === 1) {
        const issue = formulaValue(field, schema.fields, context, (f) =>
          resolveChoices(f, data, context, schema.fields),
        ).error;
        if (issue)
          errors.push({
            fieldId: field.id,
            path: prefix + field.id,
            message: issue,
          });
      }
      if (choiceTypes.includes(field.type)) {
        const issue = choiceValueIssue(
          field,
          row[field.id],
          resolveChoices(field, data, context, schema.fields),
        );
        if (issue)
          errors.push({
            fieldId: field.id,
            path: prefix + field.id,
            message: issue,
          });
        continue;
      }
      const selected = idsOf(row[field.id]);
      if (!selected.length) continue;
      let allowed: string[] | undefined;
      let message = "选项已失效，请重新选择";
      if (
        relationTypes.includes(field.type) &&
        field.reference.mode === "forward"
      ) {
        allowed = relationCandidates(
          field,
          data,
          context,
          "",
          schema.fields,
        ).map((e) => e.id);
        message = "关联记录不在当前条件范围内，请重新选择";
      }
      if (organizationTypes.includes(field.type)) {
        allowed = (
          field.type.startsWith("department")
            ? allowedDepartments(
                data.organization,
                field.organization.scope,
                context,
              )
            : allowedEmployees(
                data.organization,
                field.organization.scope,
                context,
              )
        ).map((i) => i.id);
        message = "成员或部门已失效，或不在当前选择范围内";
      }
      if (allowed && selected.some((id) => !allowed!.includes(id)))
        errors.push({ fieldId: field.id, path: prefix + field.id, message });
    }
  }
  visit(schema.fields, values);
  return errors;
}
