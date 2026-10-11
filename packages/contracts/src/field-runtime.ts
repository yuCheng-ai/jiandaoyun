import { locationText } from "./location";
import { organizationIdentityLabel } from "./organization";
import type { ChoiceTextValue, ChoiceValue, FieldOption, FieldType, FormField } from "./form";
import type { DataField, DataKind } from "./data-view";
import { formatNumberValue, type NumberSettings } from "./numbers";

/** Types with server-side definition, value and permission enforcement. */
export const serverFieldTypes: readonly FieldType[] = ["text", "textarea", "number", "datetime", "radio", "select", "checkbox", "multiselect", "phone", "member", "members", "department", "departments", "subform"];
export const serverDataKinds: readonly DataKind[] = ["text", "number", "datetime", "choice", "choices", "phone", "member", "members", "department", "departments", "subform"];
export const serverDataKindLabels: Partial<Record<DataKind, string>> = { text: "文本", number: "数字", datetime: "日期时间", choice: "单选", choices: "多选", phone: "手机号", member: "成员", members: "多成员", department: "部门", departments: "多部门", subform: "明细" };
export const isChoiceField = (type: string) => ["radio", "select", "checkbox", "multiselect"].includes(type);
export const isMultipleChoice = (type: string) => type === "checkbox" || type === "multiselect";
export const maxFieldLabelLength = 1000;
export const maxFieldPlaceholderLength = 100;
export const supportsFieldPlaceholder = (type: FieldType, inSubform = false) =>
  ["text", "textarea", "number", "datetime", "select", "multiselect"].includes(type) || (type === "phone" && !inSubform);
/** Shared authoring rules. Omitted presentation properties belong to older definitions. */
export function fieldTextPropertiesErrors(
  field: { type: FieldType; label: unknown; description?: unknown; placeholder?: unknown },
  inSubform = false,
): string[] {
  const errors: string[] = [];
  if (typeof field.label !== "string" || !field.label.trim()) errors.push("字段标题不能为空");
  else if (field.label.length > maxFieldLabelLength) errors.push(`字段标题不能超过${maxFieldLabelLength}个字符`);
  // HTML markup and embedded images are not a count of description text.
  if (field.description !== undefined && typeof field.description !== "string") errors.push("描述信息格式不合法");
  if (field.placeholder !== undefined && typeof field.placeholder !== "string") errors.push("提示文字格式不合法");
  else if (supportsFieldPlaceholder(field.type, inSubform) && typeof field.placeholder === "string" && field.placeholder.length > maxFieldPlaceholderLength)
    errors.push(`提示文字不能超过${maxFieldPlaceholderLength}个字符`);
  return errors;
}
/** OCR without settings is historical text; configured OCR only operates on its output fields. */
export const hasFieldValue = (field: Pick<FormField, "type" | "ocr">) => !["tabs", "divider", "button"].includes(field.type) && !(field.type === "ocr" && field.ocr !== undefined);
export const maxChoiceOptions = 1000;
export const maxChoiceLabelLength = 100;
export const isOrganizationField = (type: string) => ["member", "members", "department", "departments"].includes(type);
export const isDepartmentField = (type: string) => type === "department" || type === "departments";
export const isMultipleOrganization = (type: string) => type === "members" || type === "departments";
export const emptyFieldValue = (value: unknown) => value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0);
export const textFormats = [
  { value: "none", label: "无" },
  { value: "mobile", label: "手机号码" },
  { value: "tel", label: "电话号码" },
  { value: "zip", label: "邮政编码" },
  { value: "id", label: "身份证号码" },
  { value: "email", label: "邮箱" },
] as const;
export function textFormatSettingsErrors(
  field: Pick<FormField, "type" | "format">,
): string[] {
  if (
    field.type !== "text" ||
    field.format === undefined ||
    field.format === ""
  )
    return [];
  return textFormats.some((item) => item.value === field.format)
    ? []
    : ["请选择有效的文本格式"];
}
/** The source accepts repeated 7/8-digit local-number groups. Check them in linear time. */
function validTelephone(value: string): boolean {
  const core = value.replace(/^0[0-9]{2,3}-/, "").replace(/-[0-9]{1,4}$/, "");
  if (!/^[0-9]+$/.test(core)) return false;
  const ends = new Uint8Array(core.length + 1);
  ends[0] = 1;
  for (let start = 0; start < core.length; start++) {
    if (!ends[start] || core[start]! < "2" || core[start]! > "9") continue;
    for (const size of [7, 8])
      if (start + size <= core.length) ends[start + size] = 1;
  }
  return ends[core.length] === 1;
}
/** Format validation never edits identifiers or derives phone-verification status. */
export function textFormatValueIssue(
  field: Pick<FormField, "type" | "format">,
  value: unknown,
): string | undefined {
  if (emptyFieldValue(value)) return;
  // Retain the existing email rule, including historical multiline email definitions.
  if (field.format === "email")
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value))
      ? undefined
      : "请输入有效邮箱";
  if (field.type !== "text") return;
  const text = typeof value === "string" ? value : "";
  switch (field.format) {
    case "mobile":
      return /^((\(\d{2,3}\))|(\d{3}-))?1\d{10}$/.test(text)
        ? undefined
        : "请输入有效的手机号码";
    case "tel":
      return validTelephone(text) ? undefined : "请输入有效的电话号码";
    case "zip":
      return /^\d{6}$/.test(text) ? undefined : "请输入有效的邮政编码";
    case "id":
      return /^(1[1-9]|8[0-2]|[2-7]\d)\d{4}[1-9]\d{3}(0[1-9]|1[0-2])(0[1-9]|[1-2][0-9]|3[0-1])\d{3}(\d|X)$/.test(
        text,
      )
        ? undefined
        : "请输入有效的身份证号码";
  }
}
export const equalFieldValues = (a: unknown, b: unknown): boolean => Array.isArray(a) && Array.isArray(b) ? a.length === b.length && a.every(value => b.some(other => equalFieldValues(value, other))) : isChoiceTextValue(a) && isChoiceTextValue(b) ? a.optionId === b.optionId && a.text === b.text : a === b;
export const maxChoiceTextLength = 10000;
export function isChoiceTextValue(value: unknown): value is ChoiceTextValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as ChoiceTextValue;
  return Object.hasOwn(value, "text") && Object.keys(value).every(key => key === "text" || key === "optionId") && typeof item.text === "string" && item.text.length <= maxChoiceTextLength && (!Object.hasOwn(value, "optionId") || (typeof item.optionId === "string" && !!item.optionId && item.optionId.length <= 100));
}
/** Conditions identify the chosen option; its supplementary text remains a record value. */
export function choiceConditionValue(value: unknown): unknown {
  return Array.isArray(value) ? value.map(choiceConditionValue) : isChoiceTextValue(value) ? value.optionId ?? value.text : value;
}
export function choiceValueKey(value: ChoiceValue): string {
  return typeof value === "string" ? `option:${value}` : value.optionId ? `option:${value.optionId}` : `custom:${value.text}`;
}
export function choiceValueLabel(options: FieldOption[], value: unknown): string {
  if (isChoiceTextValue(value)) return value.text || options.find(option => option.id === value.optionId)?.label || "其他";
  return options.find(option => option.id === value)?.label || String(value ?? "");
}
export function choiceValueIssue(field: FormField, value: unknown, options = field.options): string | undefined {
  const multiple = isMultipleChoice(field.type);
  if (Array.isArray(value) && !multiple) return "选项格式不合法";
  if (emptyFieldValue(value)) return;
  if (multiple ? !Array.isArray(value) : typeof value !== "string" && !isChoiceTextValue(value)) return "选项格式不合法";
  const selected = (multiple ? value : [value]) as unknown[];
  const keys = new Set<string>();
  for (const item of selected) {
    const valid = typeof item === "string" ? options.some(option => option.id === item) : isChoiceTextValue(item) && (item.optionId ? !multiple && options.some(option => option.id === item.optionId && option.other) : multiple && field.allowCustomChoices === true && field.choiceSource.mode === "manual" && !!item.text.trim() && item.text.length <= maxChoiceLabelLength);
    if (!valid) return "包含无效选项，请重新选择";
    const key = choiceValueKey(item as ChoiceValue);
    if (keys.has(key)) return "不能重复选择同一选项";
    keys.add(key);
  }
}
export const validConditionValue = (value: unknown) => Array.isArray(value) ? value.length <= 500 && value.every(item => typeof item === "string" && item.length <= 100) && new Set(value).size === value.length : ["string", "number", "boolean"].includes(typeof value) && String(value).length <= 1000 && (typeof value !== "number" || Number.isFinite(value));
export function valueMappingCompatible(from: Pick<DataField, "kind" | "settings">, to: Pick<DataField, "kind" | "settings">) {
  if (from.kind !== to.kind || (from.kind === "datetime" && from.settings.format !== to.settings.format)) return false;
  return !["choice", "choices"].includes(from.kind) || ((!from.settings.allowCustomChoices || to.settings.allowCustomChoices === true) && from.settings.options.every(option => to.settings.options.some(target => target.id === option.id && (!option.other || target.other))));
}
export function fieldValueLabel(field: Pick<FormField, "type" | "options"> & NumberSettings, value: unknown, identities: import("./organization").OrganizationIdentity[] = []): string {
  if (emptyFieldValue(value)) return "";
  if (field.type === "location") return locationText(value);
  if (field.type === "number" || field.type === "calculated") return formatNumberValue(field, value);
  if (isOrganizationField(field.type)) return (Array.isArray(value) ? value : [value]).map(id => { const identity = identities.find(item => item.id === id && item.kind === (isDepartmentField(field.type) ? "department" : "member")); return identity ? organizationIdentityLabel(identity) : "已不可用身份"; }).join("、");
  if (isChoiceField(field.type)) return (Array.isArray(value) ? value : [value]).map(item => choiceValueLabel(field.options, item)).join("、");
  return String(value);
}
