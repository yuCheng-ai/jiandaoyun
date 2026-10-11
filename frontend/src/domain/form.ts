import { resolveCalculations } from "@platform/contracts";
export { resolveCalculations } from "@platform/contracts";
import {
  evaluateFormula,
  formulaReferences,
  replaceFormulaReferences,
  usesFormula,
} from "./formula";
import { visibleByRules, parseVisibilityRules } from "./visibility";
import { choiceConversion, parseChoiceConversion } from "./conditionValues";
import { addressValueIssue } from "./address";
import { hasRichTextContent, richTextValueIssue } from "./richText";
import {
  emptyChoiceSource,
  emptyReference,
  emptyOrganizationConfig,
  parseChoiceSource,
  parseReference,
  parseOrganizationConfig,
  parseDefaultLink,
  type ChoiceSource,
  type ReferenceConfig,
} from "./fieldConfig";
import type {
  FieldType,
  FieldOption,
  FormField,
  VisibilityRule,
  FormSchema,
  FormValues,
  HiddenValueMode,
} from "@platform/contracts";
import {
  emptyOcrSettings,
  textFormatValueIssue,
  hasFieldValue,
  parseOcrSettings,
  emptyLocationSettings,
  parseLocationSettings,
  isLocationValue,
  locationValueIssue,
  fileValueIssue,
  fileSettingsErrors,
  numberValueIssue,
  fieldDefaultValue,
  validDateValue,
  dateRangeErrors,
  choiceSettingsErrors,
  selectionCountMessage,
  choiceConditionValue,
  formLayoutErrors,
  tabAppearanceErrors,
  dividerAppearanceErrors,
  subformWidthErrors,
  subformFixedColumnErrors,
  subformMobileErrors,
  subformRowLimitErrors,
  subformRowIdentityErrors,
  previousSubformRow,
  newSubformPermissions,
  parseSubformPermissions,
  externalStyleErrors,
  frontendEventSettingsErrors,
  defaultSerialSettings,
  parseSerialSettings,
  addressDefault,
  isAddressValue,
  addressText,
  addressParts,
} from "@platform/contracts";
export type {
  FieldType,
  FieldOption,
  FormField,
  VisibilityRule,
  FormSchema,
  FormValues,
} from "@platform/contracts";
export interface FieldDefinition {
  type: FieldType;
  label: string;
  icon: string;
  group: "常用" | "高级" | "关联";
  container?: boolean;
  options?: boolean;
  subform?: boolean;
  subformUnique?: boolean;
}
/** The source editor's finite conversion families; stable field IDs do not change. */
export function fieldTypeAlternatives(type: FieldType): FieldType[] {
  const family: FieldType[] = ["text", "select", "radio"].includes(type)
    ? ["text", "select", "radio"]
    : ["checkbox", "multiselect"].includes(type)
      ? ["checkbox", "multiselect"]
      : [];
  return family.filter((item) => item !== type);
}

/** Do not silently remove a computed default while changing a text widget. */
export function fieldTypeChangeIssue(
  field: FormField,
  type: FieldType,
): string {
  if (!fieldTypeAlternatives(field.type).includes(type))
    return "不支持切换到此字段类型";
  if (field.type === "text" && usesFormula(field))
    return "请先将默认值改为自定义，再切换字段类型";
  if (type === "radio" && field.defaultLink?.enabled)
    return "请先取消默认值的数据联动，再切换为单选按钮组";
  return "";
}

export function fieldTypePatch(
  field: FormField,
  type: FieldType,
): Partial<FormField> | undefined {
  if (fieldTypeChangeIssue(field, type)) return;
  if (field.type !== "text" && type !== "text") {
    return {
      type,
      // Old groups without a setting were horizontal; preserve their appearance on return.
      choiceLayout:
        field.choiceLayout ??
        (["radio", "checkbox"].includes(field.type)
          ? "horizontal"
          : "vertical"),
    };
  }
  const target = createField(type);
  // Only widget-specific settings reset. Layout, required/visibility/edit access,
  // identity, title, description and container ownership remain on the same field.
  return {
    type,
    choiceConversion: choiceConversion(field),
    placeholder: target.placeholder,
    defaultValue: target.defaultValue,
    defaultLink: undefined,
    defaultFormula: undefined,
    expression: "",
    formulaRemark: undefined,
    format: target.format,
    maxLength: target.maxLength,
    masked: false,
    unique: false,
    uniqueInRecord: undefined,
    duplicateMessage: undefined,
    options: target.options,
    choiceSource: target.choiceSource,
    choiceLayout: target.choiceLayout,
    coloredOptions: undefined,
    optionColors: undefined,
    selectionLimit: undefined,
    allowCustomChoices: undefined,
  };
}
export const fieldRegistry: FieldDefinition[] = [
  {
    type: "text",
    label: "单行文本",
    icon: "text",
    group: "常用",
    subform: true,
    subformUnique: true,
  },
  {
    type: "textarea",
    label: "多行文本",
    icon: "paragraph",
    group: "常用",
    subform: true,
  },
  {
    type: "number",
    label: "数字",
    icon: "number",
    group: "常用",
    subform: true,
  },
  {
    type: "datetime",
    label: "日期时间",
    icon: "calendar",
    group: "常用",
    subform: true,
  },
  {
    type: "radio",
    label: "单选按钮组",
    icon: "radio",
    group: "常用",
    options: true,
    subform: true,
  },
  {
    type: "checkbox",
    label: "复选框组",
    icon: "checkbox",
    group: "常用",
    options: true,
    subform: true,
  },
  {
    type: "select",
    label: "下拉框",
    icon: "downbox",
    group: "常用",
    options: true,
    subform: true,
    subformUnique: true,
  },
  {
    type: "multiselect",
    label: "下拉复选框",
    icon: "listbox",
    group: "常用",
    options: true,
    subform: true,
  },
  {
    type: "member",
    label: "成员单选",
    icon: "approval",
    group: "常用",
    subform: true,
    subformUnique: true,
  },
  {
    type: "members",
    label: "成员多选",
    icon: "people",
    group: "常用",
    subform: true,
  },
  {
    type: "department",
    label: "部门单选",
    icon: "department",
    group: "常用",
    subform: true,
    subformUnique: true,
  },
  {
    type: "departments",
    label: "部门多选",
    icon: "department",
    group: "常用",
    subform: true,
  },
  { type: "divider", label: "分割线", icon: "divider", group: "常用" },
  {
    type: "tabs",
    label: "多标签页",
    icon: "tabs",
    group: "常用",
    container: true,
  },
  { type: "image", label: "图片", icon: "image", group: "高级", subform: true },
  { type: "file", label: "附件", icon: "attach", group: "高级", subform: true },
  {
    type: "address",
    label: "地址",
    icon: "location",
    group: "高级",
    subform: true,
  },
  {
    type: "location",
    label: "定位",
    icon: "locate",
    group: "高级",
    subform: true,
  },
  {
    type: "subform",
    label: "子表单",
    icon: "table",
    group: "高级",
    container: true,
  },
  {
    type: "query",
    label: "查询",
    icon: "search",
    group: "高级",
    subform: true,
  },
  {
    type: "lookup",
    label: "选择数据",
    icon: "database",
    group: "高级",
    subform: true,
    subformUnique: true,
  },
  {
    type: "signature",
    label: "手写签名",
    icon: "pen",
    group: "高级",
    subform: true,
  },
  { type: "serial", label: "流水号", icon: "serial", group: "高级" },
  { type: "phone", label: "手机", icon: "phone", group: "高级" },
  { type: "ocr", label: "文字识别", icon: "scan", group: "高级" },
  { type: "button", label: "按钮", icon: "button", group: "高级" },
  { type: "calculated", label: "计算", icon: "calculator", group: "高级" },
  { type: "richtext", label: "富文本", icon: "richtext", group: "高级" },
  { type: "relation", label: "关联数据", icon: "link", group: "关联" },
  { type: "relationTable", label: "关联子表", icon: "link", group: "关联" },
];
export const fieldDefinition = (type: FieldType) =>
  fieldRegistry.find((item) => item.type === type)!;
export function uid(prefix = "field") {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
}
export function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}
export function createField(
  type: FieldType,
  overrides: Partial<FormField> = {},
): FormField {
  const definition = fieldDefinition(type);
  return {
    id: uid(),
    type,
    label: definition.label,
    showLabel: true,
    description: "",
    placeholder: "",
    defaultValue: "",
    ...(type === "address" ? { addressComplete: true } : {}),
    ...(type === "location" ? { location: emptyLocationSettings() } : {}),
    ...(type === "ocr" ? { ocr: emptyOcrSettings() } : {}),
    ...(type === "datetime"
      ? {
          dateDefault:
            overrides.defaultValue === undefined
              ? ("now" as const)
              : ("custom" as const),
        }
      : {}),
    ...(["radio", "checkbox"].includes(type)
      ? { choiceLayout: "vertical" as const }
      : {}),
    required: false,
    unique: false,
    visible: true,
    editable: true,
    width: 12,
    options: definition.options
      ? ["选项一", "选项二", "选项三"].map((label) => ({
          id: uid("option"),
          label,
        }))
      : [],
    children: [],
    ...(type === "subform"
      ? { subformPermissions: newSubformPermissions() }
      : {}),
    ...(type === "tabs" ? { tabStyle: "card" as const } : {}),
    ...(type === "divider"
      ? {
          dividerStyle: "style1" as const,
          dividerColor: "#00b899",
          dividerTitleColor: "#141e31",
        }
      : {}),
    tabs:
      type === "tabs"
        ? [
            { id: uid("tab"), label: "标签一" },
            { id: uid("tab"), label: "标签二" },
          ]
        : [],
    format:
      type === "datetime"
        ? "date"
        : ["number", "calculated"].includes(type)
          ? "number"
          : type === "address"
            ? "detail"
            : "none",
    precision: 2,
    ...(["number", "calculated"].includes(type)
      ? { retainPrecision: false, numberGrouping: false }
      : {}),
    maxLength: type === "textarea" ? 0 : 200,
    rows: 3,
    expression: "",
    accept: type === "image" ? ".jpg,.jpeg,.png,.gif" : "",
    multiple: true,
    choiceSource: emptyChoiceSource(),
    organization: emptyOrganizationConfig(),
    reference: emptyReference(),
    referenceFormId: "",
    referenceFieldId: "",
    buttonText: type === "lookup" ? "选择数据" : "按钮",
    masked: false,
    ...(type === "serial"
      ? { serial: defaultSerialSettings(uid("rule")), editable: false }
      : {}),
    ...overrides,
  };
}
export function emptySchema(): FormSchema {
  return {
    version: 1,
    fields: [],
    settings: {
      description: "",
      layout: 1,
      labelPosition: "top",
      labelWidth: 100,
      cacheDraft: false,
      hiddenValues: "retain",
      submitLabel: "提交",
      allowSubmit: true,
      allowDraft: true,
      draftLabel: "保存草稿",
      successMessage: "提交成功",
      successMode: "inline",
      allowAnotherSubmission: true,
      rules: [],
      validations: [],
    },
  };
}
export function flattenFields(fields: FormField[]): FormField[] {
  return fields.flatMap((field) => [field, ...flattenFields(field.children)]);
}
/** Layout tabs and dividers do not consume the form's 300-field allowance. */
export function countFormFields(fields: FormField[]): number {
  return flattenFields(fields).filter(
    (field) => !["tabs", "divider"].includes(field.type),
  ).length;
}
export function countCalculatedFields(fields: FormField[]): number {
  return flattenFields(fields).filter((field) => field.type === "calculated")
    .length;
}
/** Keep old definitions readable while preventing further growth beyond the current limit. */
export function fieldCountLimitError(
  fields: FormField[],
  previous: FormField[] = [],
): string {
  const next = flattenFields(fields),
    old = flattenFields(previous);
  for (const [type, label, limit] of [
    ["calculated", "计算", 100],
    ["richtext", "富文本", 10],
  ] as const) {
    const count = next.filter((field) => field.type === type).length;
    if (
      count > limit &&
      count > old.filter((field) => field.type === type).length
    )
      return `单个表单最多 ${limit} 个${label}字段`;
  }
  return "";
}
export function findField(
  fields: FormField[],
  id: string,
): FormField | undefined {
  return flattenFields(fields).find((f) => f.id === id);
}
export function findFieldContainer(
  fields: FormField[],
  id: string,
): FormField[] | undefined {
  if (fields.some((f) => f.id === id)) return fields;
  for (const field of fields) {
    const found = findFieldContainer(field.children, id);
    if (found) return found;
  }
}
export function duplicateField(field: FormField): FormField {
  const result = duplicateFields([field]).fields[0]!;
  result.label = `${result.label} 副本`;
  return result;
}
/** Copy a group together so dependencies between its fields remain internal. */
export function duplicateFields(fields: FormField[]) {
  const result = copy(fields);
  const idMap = new Map<string, string>();
  for (const item of flattenFields(result)) {
    const old = item.id;
    item.id = uid();
    idMap.set(old, item.id);
    item.tabs = item.tabs.map((tab) => {
      const newId = uid("tab");
      item.children.forEach((c) => {
        if (c.tabId === tab.id) c.tabId = newId;
      });
      return { ...tab, id: newId };
    });
  }
  for (const item of flattenFields(result))
    item.expression = replaceFormulaReferences(item.expression, idMap);
  for (const item of flattenFields(result)) {
    const remap = (id: string) => idMap.get(id) || id;
    if (item.subformMobile)
      item.subformMobile.fieldIds = item.subformMobile.fieldIds.map(remap);
    if (item.serial)
      item.serial.rules = item.serial.rules.map((rule) =>
        rule.type === "field"
          ? { ...rule, fieldId: remap(rule.fieldId) }
          : rule,
      );
    item.organization.scope.fieldId = remap(item.organization.scope.fieldId);
    if (item.location)
      item.location.centerFieldId = remap(item.location.centerFieldId);
    if (item.ocr)
      item.ocr.mappings = item.ocr.mappings.map((mapping) => ({
        ...mapping,
        fieldId: remap(mapping.fieldId),
      }));
    if (item.dateRange) {
      item.dateRange.earliest.fieldId = remap(item.dateRange.earliest.fieldId);
      item.dateRange.latest.fieldId = remap(item.dateRange.latest.fieldId);
    }
    for (const filter of [
      ...item.choiceSource.filters,
      ...item.reference.filters,
      ...(item.defaultLink?.filters || []),
    ])
      if (filter.source === "field") filter.value = remap(filter.value);
    item.reference.mappings = item.reference.mappings.map((m) => ({
      ...m,
      targetFieldId: remap(m.targetFieldId),
    }));
    if (item.defaultRows)
      item.defaultRows = item.defaultRows.map((row) =>
        Object.fromEntries(
          Object.entries(row).map(([id, value]) => [remap(id), value]),
        ),
      );
    if (item.defaultLink?.mappings)
      item.defaultLink.mappings = item.defaultLink.mappings.map((m) => ({
        ...m,
        targetFieldId: remap(m.targetFieldId),
      }));
  }
  return { fields: result, idMap };
}
export function fieldDepth(fields: FormField[], id: string, depth = 0): number {
  for (const field of fields) {
    if (field.id === id) return depth;
    const found = fieldDepth(field.children, id, depth + 1);
    if (found >= 0) return found;
  }
  return -1;
}
function fieldHeight(field: FormField): number {
  return field.children.length
    ? 1 + Math.max(...field.children.map(fieldHeight))
    : 0;
}
export function moveField(
  fields: FormField[],
  id: string,
  parentId: string | null,
  index: number,
  tabId?: string,
): boolean {
  const field = findField(fields, id);
  if (!field) return false;
  if (parentId && flattenFields([field]).some((f) => f.id === parentId))
    return false;
  const parent = parentId ? findField(fields, parentId) : undefined;
  if (parentId && (!parent || !fieldDefinition(parent.type).container))
    return false;
  if (parentId && flattenFields([field]).some((f) => f.type === "tabs"))
    return false;
  // New columns follow the source allowlist; old columns may still be reordered.
  if (
    parent?.type === "subform" &&
    !fieldDefinition(field.type).subform &&
    findFieldContainer(fields, id) !== parent.children
  )
    return false;
  if (
    (parentId ? fieldDepth(fields, parentId) + 1 : 0) + fieldHeight(field) >
    4
  )
    return false;
  const source = findFieldContainer(fields, id)!;
  const target = parent ? parent.children : fields;
  const oldIndex = source.findIndex((f) => f.id === id);
  source.splice(oldIndex, 1);
  const adjusted = source === target && oldIndex < index ? index - 1 : index;
  field.tabId = tabId;
  target.splice(Math.max(0, Math.min(adjusted, target.length)), 0, field);
  return true;
}
export function defaultValues(
  fields: FormField[],
  now = new Date(),
): FormValues {
  const values: FormValues = {};
  for (const field of fields) {
    if (field.type === "tabs")
      Object.assign(values, defaultValues(field.children, now));
    else if (!hasFieldValue(field)) continue;
    else if (field.type === "subform")
      values[field.id] = field.defaultLink?.enabled
        ? []
        : (field.defaultRows || []).map((row) => ({
            ...defaultValues(field.children, now),
            ...Object.fromEntries(
              field.children
                .filter((child) => Object.hasOwn(row, child.id))
                .map((child) => [child.id, copy(row[child.id])]),
            ),
          }));
    else if (
      [
        "checkbox",
        "multiselect",
        "members",
        "departments",
        "file",
        "image",
        "relationTable",
      ].includes(field.type)
    )
      values[field.id] = Array.isArray(field.defaultValue)
        ? copy(field.defaultValue)
        : [];
    else
      values[field.id] = copy(
        field.type === "address"
          ? addressDefault(field)
          : fieldDefaultValue(field, now),
      );
  }
  return values;
}
export function isFieldVisible(
  field: FormField,
  schema: FormSchema,
  values: FormValues,
): boolean {
  if (!field.visible) return false;
  return visibleByRules(
    field.id,
    schema.settings.rules,
    values,
    new Set(),
    flattenFields(schema.fields),
  );
}
/** A control is visible only while its containers are visible in the same value snapshot. */
export function isFieldVisibleInSchema(
  field: FormField,
  schema: FormSchema,
  values: FormValues,
): boolean {
  const visit = (
    fields: FormField[],
    parentsVisible = true,
  ): boolean | undefined => {
    for (const current of fields) {
      const visible = parentsVisible && isFieldVisible(current, schema, values);
      if (current.id === field.id) return visible;
      const child = visit(current.children, visible);
      if (child !== undefined) return child;
    }
  };
  return field.visible && visit(schema.fields) === true;
}
export interface FieldError {
  fieldId: string;
  path: string;
  message: string;
}
export function validateValues(
  schema: FormSchema,
  values: FormValues,
  existing: FormValues[] = [],
  previous: FormValues = {},
): FieldError[] {
  const errors: FieldError[] = [
    ...subformRowLimitErrors(schema.fields, values, previous),
    ...subformRowIdentityErrors(schema.fields, values),
  ];
  const isRow = (row: unknown): row is FormValues =>
    row !== null && typeof row === "object" && !Array.isArray(row);
  function populatedRow(fields: FormField[], row: unknown): boolean {
    // Invalid rows must reach validation rather than being mistaken for blanks.
    if (!isRow(row)) return true;
    return fields.some((field) =>
      field.type === "tabs"
        ? populatedRow(field.children, row)
        : hasFieldValue(field) && !emptyValue(field, row[field.id]),
    );
  }
  function emptyValue(field: FormField, value: unknown): boolean {
    return (
      value == null ||
      value === "" ||
      (Array.isArray(value) && value.length === 0) ||
      (field.type === "subform" &&
        Array.isArray(value) &&
        !value.some((row) => populatedRow(field.children, row))) ||
      (field.type === "address" &&
        isAddressValue(value) &&
        !addressText(value, "", addressParts(field))) ||
      (typeof value === "object" &&
        !Array.isArray(value) &&
        value !== null &&
        !Object.values(value).some((v) => String(v ?? "").trim())) ||
      (typeof value === "string" &&
        (field.type === "richtext"
          ? !hasRichTextContent(value)
          : !value.trim()))
    );
  }
  function visit(
    fields: FormField[],
    data: FormValues,
    prefix = "",
    peers: FormValues[] = existing,
    sameRecord: FormValues[] = [],
    baseline: FormValues = previous,
  ) {
    for (const field of fields) {
      if (!isFieldVisible(field, schema, { ...values, ...data })) continue;
      const path = prefix + field.id;
      const value = data[field.id];
      const empty = emptyValue(field, value);
      if (field.type === "tabs") {
        visit(field.children, data, prefix, peers, sameRecord, baseline);
        continue;
      }
      if (
        !hasFieldValue(field) ||
        (field.type === "relationTable" && field.reference.mode === "reverse")
      )
        continue;
      if (
        field.type === "subform" &&
        value != null &&
        value !== "" &&
        !Array.isArray(value)
      ) {
        errors.push({
          fieldId: field.id,
          path,
          message: `${field.label}的明细格式无效`,
        });
        continue;
      }
      if (field.required && empty)
        errors.push({
          fieldId: field.id,
          path,
          message: `请填写${field.label}`,
        });
      const choiceIssue = selectionCountMessage(field, value);
      if (choiceIssue && !(field.required && empty))
        errors.push({ fieldId: field.id, path, message: choiceIssue });
      if (field.type === "richtext") {
        const issue = richTextValueIssue(value, baseline[field.id]);
        if (issue) errors.push({ fieldId: field.id, path, message: issue });
      }
      if (empty) continue;
      if (field.type === "address") {
        const issue = addressValueIssue(field, value);
        if (issue) errors.push({ fieldId: field.id, path, message: issue });
      }
      if (field.type === "location") {
        const issue = locationValueIssue(field, value, { ...values, ...data });
        if (issue) errors.push({ fieldId: field.id, path, message: issue });
      }
      const fileIssue = fileValueIssue(
        field,
        value,
        !field.defaultLink?.enabled,
      );
      if (fileIssue)
        errors.push({ fieldId: field.id, path, message: fileIssue });
      if (field.type === "subform" && Array.isArray(value)) {
        const otherRows = peers.flatMap((record) =>
          Array.isArray(record[field.id])
            ? (record[field.id] as unknown[]).filter(isRow)
            : [],
        );
        const sameRecordRows = sameRecord.flatMap((record) =>
          Array.isArray(record[field.id])
            ? (record[field.id] as unknown[]).filter(isRow)
            : [],
        );
        value.forEach((row, i) => {
          if (!isRow(row)) {
            errors.push({
              fieldId: field.id,
              path: `${path}.${i}`,
              message: `${field.label}第 ${i + 1} 行格式无效`,
            });
          } else if (populatedRow(field.children, row)) {
            visit(
              field.children,
              row,
              `${path}.${i}.`,
              otherRows,
              [
                ...sameRecordRows,
                ...value.filter((peer, index) => index !== i && isRow(peer)),
              ],
              previousSubformRow(
                field.id,
                Array.isArray(baseline[field.id])
                  ? (baseline[field.id] as FormValues[])
                  : [],
                row,
                i,
              ) || {},
            );
          }
        });
        continue;
      }
      if (field.type === "number") {
        const issue = numberValueIssue(field, value);
        if (issue === "invalid")
          errors.push({ fieldId: field.id, path, message: "请输入有效数字" });
        else if (issue === "range")
          errors.push({
            fieldId: field.id,
            path,
            message: `${field.label}超出允许范围`,
          });
        else if (issue === "precision")
          errors.push({
            fieldId: field.id,
            path,
            message: `最多输入 ${field.precision} 位小数`,
          });
      }
      if (
        ["text", "textarea", "phone"].includes(field.type) &&
        field.maxLength > 0 &&
        String(value).length > field.maxLength
      )
        errors.push({
          fieldId: field.id,
          path,
          message: `最多输入 ${field.maxLength} 个字符`,
        });
      if (field.type === "datetime" && !validDateValue(field.format, value))
        errors.push({
          fieldId: field.id,
          path,
          message: "请输入有效的日期或时间",
        });
      if (field.type === "phone" && !/^1[3-9]\d{9}$/.test(String(value)))
        errors.push({
          fieldId: field.id,
          path,
          message: "请输入有效的 11 位手机号",
        });
      const textIssue = textFormatValueIssue(field, value);
      if (textIssue)
        errors.push({ fieldId: field.id, path, message: textIssue });
      const duplicatePeers = field.unique
        ? [...peers, ...sameRecord]
        : field.uniqueInRecord && fieldDefinition(field.type).subformUnique
          ? sameRecord
          : [];
      if (
        duplicatePeers.some(
          (row) => JSON.stringify(row[field.id]) === JSON.stringify(value),
        )
      )
        errors.push({
          fieldId: field.id,
          path,
          message: field.duplicateMessage?.trim() || `${field.label}不能重复`,
        });
    }
  }
  visit(schema.fields, values);
  return errors;
}
/** Safe expression parser shared with field defaults; numeric legacy references stay compatible. */
export function calculate(
  expression: string,
  values: FormValues,
): number | null {
  const refs = Object.fromEntries(
    formulaReferences(expression).map((id) => [id, Number(values[id] || 0)]),
  );
  const result = evaluateFormula(expression, refs);
  return !result.error && typeof result.value === "number"
    ? result.value
    : null;
}
export function hiddenValueMode(
  schema: FormSchema,
  id: string,
): HiddenValueMode {
  return schema.settings.hiddenValueRules?.[id] || schema.settings.hiddenValues;
}
/** Hidden generated values follow the same policy as stored values, before dependent formulas run. */
export function resolveFormValues(
  schema: FormSchema,
  values: FormValues,
  original: FormValues = {},
  options: {
    choices?: (field: FormField, values: FormValues) => FieldOption[];
    defaultValue?: (field: FormField, values: FormValues) => unknown;
  } = {},
): FormValues {
  if (
    schema.settings.hiddenValueRules === undefined &&
    schema.settings.hiddenValues !== "recalculate"
  )
    return resolveCalculations(schema.fields, values);
  const ancestors = new Map<string, FormField[]>();
  const changed = new Set<string>();
  function index(fields: FormField[], parents: FormField[] = []) {
    for (const field of fields) {
      ancestors.set(field.id, parents);
      index(field.children, [...parents, field]);
    }
  }
  index(schema.fields);
  const visible = (field: FormField, context: FormValues) =>
    [...(ancestors.get(field.id) || []), field].every((item) =>
      isFieldVisible(item, schema, context),
    );
  function assign(
    fields: FormField[],
    data: FormValues,
    before: FormValues,
    root: FormValues = {},
  ): FormValues {
    const result = copy(data);
    for (const field of fields) {
      const context = { ...root, ...result },
        shown = visible(field, context),
        mode = hiddenValueMode(schema, field.id);
      if (field.type === "tabs") {
        Object.assign(result, assign(field.children, result, before, root));
      } else if (
        shown &&
        data[field.id] === undefined &&
        hasFieldValue(field) &&
        !["serial", "query"].includes(field.type)
      ) {
        if (usesFormula(field)) changed.add(field.id);
        else
          result[field.id] = options.defaultValue
            ? options.defaultValue(field, context)
            : defaultValues([field])[field.id];
      } else if (
        hasFieldValue(field) &&
        !["serial", "query"].includes(field.type) &&
        !shown
      ) {
        if (mode === "retain") {
          if (Object.hasOwn(before, field.id))
            result[field.id] = copy(before[field.id]);
          else delete result[field.id];
        } else if (mode === "clear") delete result[field.id];
        else if (!usesFormula(field) && field.type !== "subform") {
          // Dynamic defaults are supplied by the existing relation/organization resolver.
          if (options.defaultValue)
            result[field.id] = options.defaultValue(field, context);
          else if (
            !field.defaultLink?.enabled &&
            !["member", "members", "department", "departments"].includes(
              field.type,
            )
          )
            result[field.id] = defaultValues([field])[field.id];
        }
      }
      if (field.type === "subform" && Array.isArray(result[field.id])) {
        const oldRows = Array.isArray(before[field.id])
          ? (before[field.id] as FormValues[])
          : [];
        result[field.id] = (result[field.id] as FormValues[]).map(
          (row, index) =>
            assign(
              field.children,
              row,
              previousSubformRow(field.id, oldRows, row, index) || {},
              {
                ...root,
                ...result,
              },
            ),
        );
      }
      if (JSON.stringify(result[field.id]) !== JSON.stringify(data[field.id]))
        changed.add(field.id);
    }
    return result;
  }
  const assigned = assign(schema.fields, values, original);
  const generated = flattenFields(schema.fields).filter(usesFormula);
  function dependencies() {
    for (let pass = 0; pass < generated.length; pass++) {
      const size = changed.size;
      for (const field of generated)
        if (formulaReferences(field.expression).some((id) => changed.has(id)))
          changed.add(field.id);
      if (changed.size === size) break;
    }
  }
  dependencies();
  const calculationOptions = {
    defaults: flattenFields(schema.fields)
      .filter((field) => field.defaultFormula)
      .map((field) => field.id),
    choices: options.choices,
    enabled: (field: FormField, context: FormValues) =>
      visible(field, context)
        ? field.type === "calculated" || changed.has(field.id)
        : hiddenValueMode(schema, field.id) === "recalculate",
  };
  const resolved = resolveCalculations(
    schema.fields,
    assigned,
    {},
    calculationOptions,
  );
  function changes(fields: FormField[], before: FormValues, after: FormValues) {
    for (const field of fields) {
      if (
        usesFormula(field) &&
        JSON.stringify(before[field.id]) !== JSON.stringify(after[field.id])
      )
        changed.add(field.id);
      if (field.type === "tabs") changes(field.children, before, after);
      if (field.type === "subform" && Array.isArray(after[field.id])) {
        const rows = before[field.id] as FormValues[] | undefined;
        (after[field.id] as FormValues[]).forEach((row, i) =>
          changes(
            field.children,
            previousSubformRow(field.id, rows || [], row, i) || {},
            row,
          ),
        );
      }
    }
  }
  const size = changed.size;
  changes(schema.fields, assigned, resolved);
  if (changed.size === size) return resolved;
  dependencies();
  return resolveCalculations(schema.fields, resolved, {}, calculationOptions);
}
/** Prepare schema-owned values and row identity, applying visibility recursively. */
export function prepareSubmission(
  schema: FormSchema,
  values: FormValues,
  original?: FormValues,
  alreadyResolved = false,
): FormValues {
  const resolved = alreadyResolved
    ? values
    : resolveFormValues(schema, values, original);
  function visit(
    fields: FormField[],
    data: FormValues,
    context: FormValues,
    before?: FormValues,
  ): FormValues {
    const result: FormValues = {};
    for (const field of fields) {
      if (
        (schema.settings.hiddenValueRules === undefined ||
          !["serial", "query"].includes(field.type)) &&
        hiddenValueMode(schema, field.id) === "clear" &&
        !isFieldVisible(field, schema, context)
      )
        continue;
      if (
        (field.type !== "tabs" && !hasFieldValue(field)) ||
        (field.type === "relationTable" && field.reference.mode === "reverse")
      )
        continue;
      if (field.type === "tabs")
        Object.assign(result, visit(field.children, data, context, before));
      else if (field.type === "subform")
        result[field.id] = Array.isArray(data[field.id])
          ? (data[field.id] as FormValues[]).map((row, index) => ({
              ...visit(
                field.children,
                row,
                { ...context, ...row },
                previousSubformRow(
                  field.id,
                  (before?.[field.id] as FormValues[] | undefined) || [],
                  row,
                  index,
                ),
              ),
              ...(row._rowId !== undefined ? { _rowId: row._rowId } : {}),
            }))
          : [];
      else if (field.type === "serial")
        result[field.id] =
          field.serial || (before && Object.hasOwn(before, field.id))
            ? (data[field.id] ?? before?.[field.id] ?? "")
            : data[field.id] || `SN${Date.now()}${uid().slice(-4)}`;
      else if (data[field.id] !== undefined)
        result[field.id] = copy(data[field.id]);
    }
    return result;
  }
  return visit(schema.fields, resolved, resolved, original);
}
export function parseSchema(raw: unknown): FormSchema {
  if (
    !raw ||
    typeof raw !== "object" ||
    (raw as FormSchema).version !== 1 ||
    !Array.isArray((raw as FormSchema).fields)
  )
    throw Error("无效的表单配置");
  const source = raw as FormSchema;
  const ids = new Set<string>();
  let count = 0;
  function parseFields(fields: FormField[], depth = 0): FormField[] {
    if (fields.length && depth > 4) throw Error("字段嵌套不能超过四层");
    return fields.map((field) => {
      if (
        !field ||
        !fieldRegistry.some((r) => r.type === field.type) ||
        (!["tabs", "divider"].includes(field.type) && ++count > 300) ||
        typeof field.id !== "string" ||
        !field.id ||
        ["__proto__", "constructor", "prototype"].includes(field.id) ||
        ids.has(field.id) ||
        typeof field.label !== "string"
      )
        throw Error("字段数据无效、重复或数量超限");
      ids.add(field.id);
      const base = createField(field.type, { id: field.id });
      // Loading an old definition must not silently opt it into a new counter.
      delete base.serial;
      delete base.addressComplete;
      delete base.location;
      delete base.ocr;
      delete base.tabStyle;
      delete base.subformPermissions;
      // Old schemas without this setting used the previous 200-character default.
      if (field.type === "textarea" && field.maxLength === undefined)
        base.maxLength = 200;
      for (const key of Object.keys(base) as (keyof FormField)[]) {
        const val = field[key];
        if (
          typeof val === typeof base[key] &&
          !Array.isArray(val) &&
          val !== null
        )
          (base as any)[key] = val;
      }
      const conversion = parseChoiceConversion(field.choiceConversion);
      if (conversion) {
        if (!["text", "radio", "select"].includes(field.type))
          throw Error("此字段不支持文本类型转换记录");
        base.choiceConversion = conversion;
      }
      base.choiceSource = parseChoiceSource(field.choiceSource);
      base.reference = parseReference(field.reference);
      base.organization = parseOrganizationConfig(field.organization);
      if (field.uniqueInRecord !== undefined) {
        if (typeof field.uniqueInRecord !== "boolean")
          throw Error("单条数据重复校验配置无效");
        base.uniqueInRecord = field.uniqueInRecord;
      }
      if (field.duplicateMessage !== undefined) {
        if (typeof field.duplicateMessage !== "string")
          throw Error("重复校验提示配置无效");
        base.duplicateMessage = field.duplicateMessage;
      }
      if (field.location !== undefined)
        base.location = parseLocationSettings(field.location);
      if (field.ocr !== undefined) base.ocr = parseOcrSettings(field.ocr);
      if (
        field.type === "location" &&
        field.defaultValue &&
        typeof field.defaultValue === "object"
      ) {
        if (!isLocationValue(field.defaultValue))
          throw Error("默认定位格式无效");
        base.defaultValue = copy(field.defaultValue);
      }
      if (field.addressComplete !== undefined) {
        if (typeof field.addressComplete !== "boolean")
          throw Error("地址校验配置无效");
        base.addressComplete = field.addressComplete;
      }
      if (
        field.type === "address" &&
        field.defaultValue &&
        typeof field.defaultValue === "object" &&
        !Array.isArray(field.defaultValue)
      ) {
        if (!isAddressValue(field.defaultValue))
          throw Error("默认地址格式无效");
        base.defaultValue = copy(field.defaultValue);
      }
      if (field.serial !== undefined)
        base.serial = parseSerialSettings(field.serial);
      const defaultLink = parseDefaultLink(field.defaultLink);
      if (defaultLink) base.defaultLink = defaultLink;
      if (field.subformPermissions !== undefined) {
        if (field.type !== "subform") throw Error("子表单操作权限仅用于子表单");
        base.subformPermissions = parseSubformPermissions(
          field.subformPermissions,
        );
      }
      if (field.subformQuickFill !== undefined) {
        if (
          field.type !== "subform" ||
          typeof field.subformQuickFill !== "boolean"
        )
          throw Error("快速填报配置无效");
        base.subformQuickFill = field.subformQuickFill;
      }
      const fixedErrors = subformFixedColumnErrors(field);
      if (fixedErrors.length)
        throw Error(`「${field.label}」${fixedErrors[0]}`);
      if (field.subformFixedColumns !== undefined)
        base.subformFixedColumns = copy(field.subformFixedColumns);
      const mobileErrors = subformMobileErrors(field);
      if (mobileErrors.length)
        throw Error(`「${field.label}」${mobileErrors[0]}`);
      if (field.subformMobile !== undefined)
        base.subformMobile = copy(field.subformMobile);
      if (field.defaultRows !== undefined) {
        if (
          field.type !== "subform" ||
          !Array.isArray(field.defaultRows) ||
          field.defaultRows.some(
            (row) => !row || typeof row !== "object" || Array.isArray(row),
          )
        )
          throw Error("子表默认明细格式无效");
        base.defaultRows = copy(field.defaultRows);
      }
      if (field.defaultFormula !== undefined) {
        if (typeof field.defaultFormula !== "boolean")
          throw Error("公式默认值配置无效");
        base.defaultFormula = field.defaultFormula;
      }
      if (field.formulaRemark !== undefined) {
        if (
          typeof field.formulaRemark !== "string" ||
          field.formulaRemark.length > 1000
        )
          throw Error("公式备注配置无效");
        base.formulaRemark = field.formulaRemark;
      }
      if (field.calculationVersion !== undefined) {
        if (field.type !== "calculated" || field.calculationVersion !== 1)
          throw Error("计算公式版本无效");
        base.calculationVersion = 1;
      }
      base.width = [3, 4, 6, 8, 9, 12].includes(field.width) ? field.width : 12;
      const widthErrors = subformWidthErrors(field);
      if (widthErrors.length)
        throw Error(`「${field.label}」${widthErrors[0]}`);
      if (field.subformWidth !== undefined)
        base.subformWidth = field.subformWidth;
      base.options = Array.isArray(field.options)
        ? field.options
            .filter(
              (o) => typeof o?.id === "string" && typeof o?.label === "string",
            )
            .map((o) => ({
              id: o.id,
              label: o.label,
              ...(o.other !== undefined ? { other: o.other } : {}),
            }))
        : base.options;
      const tabErrors = tabAppearanceErrors(field);
      if (tabErrors.length) throw Error(`「${field.label}」${tabErrors[0]}`);
      for (const key of ["tabStyle", "tabCustomColor", "tabColor"] as const) {
        if (field[key] !== undefined) (base as any)[key] = field[key];
      }
      const dividerErrors = dividerAppearanceErrors(field);
      if (dividerErrors.length)
        throw Error(`「${field.label}」${dividerErrors[0]}`);
      for (const key of ["dividerColor", "dividerTitleColor"] as const) {
        delete base[key];
        if (field[key] !== undefined) base[key] = field[key];
      }
      delete base.dividerStyle;
      if (field.dividerStyle !== undefined)
        base.dividerStyle = field.dividerStyle;
      base.tabs = Array.isArray(field.tabs)
        ? field.tabs
            .filter(
              (o) => typeof o?.id === "string" && typeof o?.label === "string",
            )
            .map((o) => ({ id: o.id, label: o.label }))
        : base.tabs;
      if (!fieldDefinition(field.type).container && field.children?.length)
        throw Error("普通字段不能包含子字段");
      if (
        field.type === "subform" &&
        field.children?.some((f) => f.type === "subform" || f.type === "tabs")
      )
        throw Error("子表单内不支持再次嵌套容器字段");
      base.children = Array.isArray(field.children)
        ? parseFields(field.children, depth + 1)
        : [];
      if (typeof field.tabId === "string") base.tabId = field.tabId;
      // Preserve unfinished numeric settings in design recovery. Configuration
      // validation rejects them before publishing a usable definition.
      for (const key of ["min", "max"] as const)
        if (
          (typeof field[key] === "number" && Number.isFinite(field[key])) ||
          (field.type === "number" && typeof field[key] === "string")
        )
          base[key] = field[key];
      if (
        typeof field.defaultValue === "number" &&
        Number.isFinite(field.defaultValue)
      )
        base.defaultValue = field.defaultValue;
      base.precision = Math.max(0, Math.min(8, Math.round(base.precision)));
      for (const key of [
        "retainPrecision",
        "numberGrouping",
        "limitRange",
      ] as const) {
        if (typeof field[key] === "boolean") base[key] = field[key];
        else delete base[key];
      }
      if (
        ["number", "calculated"].includes(base.type) &&
        ![
          "none",
          "number",
          "percent",
          ...(base.type === "calculated" ? ["text"] : []),
        ].includes(base.format)
      )
        base.format = "number";
      if (
        field.type === "datetime" &&
        ["now", "custom"].includes(field.dateDefault || "")
      )
        base.dateDefault = field.dateDefault;
      else delete base.dateDefault;
      if (field.dateRange !== undefined) {
        const errors = dateRangeErrors(field, undefined, true);
        if (errors.length) throw Error(`「${field.label}」${errors[0]}`);
        base.dateRange = copy(field.dateRange);
      }
      const fileErrors = fileSettingsErrors(field, true);
      if (fileErrors.length) throw Error(`「${field.label}」${fileErrors[0]}`);
      for (const key of [
        "limitFileTypes",
        "maxFileSize",
        "uploadStyle",
      ] as const) {
        if (field[key] !== undefined) (base as any)[key] = copy(field[key]);
      }
      const choiceErrors = choiceSettingsErrors(field, true);
      if (choiceErrors.length)
        throw Error(`「${field.label}」${choiceErrors[0]}`);
      for (const key of [
        "coloredOptions",
        "optionColors",
        "choiceLayout",
        "selectionLimit",
        "allowCustomChoices",
      ] as const) {
        if (field[key] !== undefined) (base as any)[key] = copy(field[key]);
        else delete base[key];
      }
      base.maxLength = Math.max(
        base.type === "textarea" ? 0 : 1,
        Math.min(100000, base.maxLength),
      );
      base.rows = Math.max(1, Math.min(20, base.rows));
      if (Array.isArray(field.defaultValue))
        base.defaultValue = field.defaultValue.filter(
          (v) => typeof v === "string",
        );
      return base;
    });
  }
  const fields = parseFields(source.fields);
  const settings = emptySchema().settings;
  for (const key of Object.keys(settings) as (keyof FormSchema["settings"])[]) {
    const val = source.settings?.[key];
    if (
      typeof val === typeof settings[key] &&
      !Array.isArray(val) &&
      val !== null
    )
      (settings as any)[key] = val;
  }
  settings.layout = [1, 2, 3, 4].includes(settings.layout)
    ? settings.layout
    : 1;
  settings.labelPosition = settings.labelPosition === "left" ? "left" : "top";
  for (const key of [
    "labelAlignment",
    "descriptionMode",
    "inputWidth",
    "mobileLayout",
    "externalStyle",
    "frontendEvents",
  ] as const) {
    if (source.settings?.[key] !== undefined)
      (settings as any)[key] = copy(source.settings[key]);
  }
  const layoutErrors = [
    ...formLayoutErrors(settings),
    ...externalStyleErrors(settings),
    ...frontendEventSettingsErrors(settings),
  ];
  if (layoutErrors.length) throw Error(layoutErrors[0]);
  if (
    source.settings?.hiddenValues !== undefined &&
    !["retain", "clear", "recalculate"].includes(source.settings.hiddenValues)
  )
    throw Error("不可见字段赋值设置不合法");
  const hiddenRules = source.settings?.hiddenValueRules;
  if (hiddenRules !== undefined) {
    if (
      !hiddenRules ||
      typeof hiddenRules !== "object" ||
      Array.isArray(hiddenRules) ||
      Object.entries(hiddenRules).some(
        ([id, mode]) =>
          !id || !["retain", "clear", "recalculate"].includes(mode),
      )
    )
      throw Error("特殊字段赋值规则不合法，请保留原配置并检查字段");
    settings.hiddenValueRules = copy(hiddenRules);
  }
  settings.successMode = settings.successMode === "page" ? "page" : "inline";
  settings.successMessage = settings.successMessage.slice(0, 100);
  settings.submitLabel = settings.submitLabel.slice(0, 12);
  settings.draftLabel = (settings.draftLabel ?? "保存草稿").slice(0, 12);
  settings.labelWidth = Math.max(50, Math.min(500, settings.labelWidth));
  settings.rules = parseVisibilityRules(source.settings?.rules, fields);
  const validationIds = new Set<string>();
  const validations = source.settings?.validations;
  if (validations !== undefined && !Array.isArray(validations))
    throw new Error("数据校验设置不合法，请保留原配置并检查校验条件");
  settings.validations = (validations || []).map((rule: any) => {
    if (
      !rule ||
      typeof rule.id !== "string" ||
      !rule.id.trim() ||
      validationIds.has(rule.id) ||
      typeof rule.expression !== "string" ||
      typeof rule.message !== "string" ||
      typeof rule.realtime !== "boolean" ||
      !["warn", "block"].includes(rule.mode) ||
      (rule.remark !== undefined && typeof rule.remark !== "string")
    )
      throw new Error("数据校验设置不合法，请保留原配置并检查校验条件");
    validationIds.add(rule.id);
    return {
      id: rule.id,
      expression: rule.expression,
      message: rule.message,
      realtime: rule.realtime,
      mode: rule.mode,
      ...(typeof rule.remark === "string" ? { remark: rule.remark } : {}),
    };
  });
  return { version: 1, fields, settings };
}
