import { BadRequestException } from "@nestjs/common";
import { isChoiceField, isMultipleChoice, choiceValueIssue, maxChoiceOptions, maxChoiceLabelLength, isOrganizationField, isMultipleOrganization, emptyFieldValue, textFormatSettingsErrors, textFormatValueIssue, numberValueIssue, isDateFormat, validDateValue, normalizeDateValue, type FormField, type ChoiceValue } from "@platform/contracts";

import { validateOrganizationRule } from "../directory/organization-fields";

export function validateFieldRules(field: FormField, allowIncomplete: boolean, identifier: (value: unknown) => void) {
  for (const key of ["retainPrecision", "numberGrouping", "limitRange"] as const) {
    if (field[key] !== undefined && typeof field[key] !== "boolean") throw new BadRequestException(`「${field.label}」的数字配置不合法`);
  }
  if (field.type === "number" && field.format !== undefined && !["none", "number", "percent"].includes(field.format)) throw new BadRequestException(`「${field.label}」请选择有效的数字格式`);
  if (field.dateDefault !== undefined && (field.type !== "datetime" || !["now", "custom"].includes(field.dateDefault))) throw new BadRequestException(`「${field.label}」的日期默认值方式不合法`);
  if (field.type === "datetime" && !isDateFormat(field.format)) throw new BadRequestException(`「${field.label}」请选择有效的日期格式`);
  if (field.type === "datetime" && field.dateDefault === "now" && field.defaultValue !== undefined && (typeof field.defaultValue !== "string" || field.defaultValue.length > (field.maxLength || 10000))) throw new BadRequestException(`「${field.label}」的日期默认值格式不合法`);
  const textErrors = textFormatSettingsErrors(field);
  if (textErrors.length) throw new BadRequestException(`「${field.label}」${textErrors[0]}`);
  if (field.type === "textarea" && field.format !== undefined && !["none", "email"].includes(field.format)) throw new BadRequestException(`「${field.label}」的文本格式暂不支持`);
  if (!["text", "textarea", "datetime", "number"].includes(field.type) && field.format !== undefined && field.format !== "none") throw new BadRequestException(`「${field.label}」的格式规则暂不支持`);
  validateOrganizationRule(field);
  if (!isChoiceField(field.type)) return;
  if (!field.choiceSource || field.choiceSource.mode !== "manual") throw new BadRequestException(`「${field.label}」的数据来源尚未接入服务端，请保留原配置`);
  if (!Array.isArray(field.options) || field.options.length > maxChoiceOptions || (!allowIncomplete && !field.options.length)) throw new BadRequestException(`「${field.label}」应包含 1–${maxChoiceOptions} 个选项`);
  const ids = new Set<string>();
  for (const option of field.options) {
    if (!option || typeof option !== "object" || typeof option.label !== "string" || !option.label.trim() || option.label.length > maxChoiceLabelLength) throw new BadRequestException(`「${field.label}」存在无效选项`);
    identifier(option.id);
    if (ids.has(option.id)) throw new BadRequestException(`「${field.label}」的选项身份重复`);
    ids.add(option.id);
  }
  if (!emptyFieldValue(field.defaultValue) && (isMultipleChoice(field.type) ? !Array.isArray(field.defaultValue) || field.defaultValue.some(value => typeof value !== "string") : typeof field.defaultValue !== "string")) throw new BadRequestException(`「${field.label}」默认值应从预设选项中选择`);
}

export function scalar(field: FormField, value: unknown, required = true): number | ChoiceValue | ChoiceValue[] {
  const multiple = isMultipleChoice(field.type) || isMultipleOrganization(field.type);
  if (emptyFieldValue(value)) {
    if (required && field.required) throw new BadRequestException(`「${field.label}」不能为空`);
    if (Array.isArray(value) && !multiple) throw new BadRequestException(`「${field.label}」的值格式不合法`);
    return multiple ? [] : "";
  }
  if (isOrganizationField(field.type)) {
    if (multiple ? !Array.isArray(value) : typeof value !== "string") throw new BadRequestException(`「${field.label}」的组织身份格式不合法`);
    const selected = (multiple ? value : [value]) as unknown[];
    if (selected.length > 1000 || new Set(selected).size !== selected.length || selected.some(id => typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))) throw new BadRequestException(`「${field.label}」包含无效或重复的组织身份`);
    return multiple ? [...selected] as string[] : selected[0] as string;
  }
  if (isChoiceField(field.type)) {
    const issue = choiceValueIssue(field, value);
    if (issue) throw new BadRequestException(`「${field.label}」${issue}`);
    return structuredClone(value) as ChoiceValue | ChoiceValue[];
  }
  if (field.type === "number") {
    const issue = numberValueIssue(field, value);
    if (issue) {
      const message = issue === "invalid" ? "请输入有效数字" : issue === "range" ? "超出允许范围" : `最多输入 ${field.precision ?? 2} 位小数`;
      throw new BadRequestException(`「${field.label}」${message}`);
    }
    return value as number;
  }
  if (typeof value !== "string" || value.length > (field.maxLength || 10000)) throw new BadRequestException(`「${field.label}」的文本格式或长度不符合要求`);
  if (required && field.required && !value.trim()) throw new BadRequestException(`「${field.label}」不能为空`);
  if (field.type === "datetime") {
    if (!validDateValue(field.format, value)) throw new BadRequestException(`「${field.label}」的日期或时间不合法`);
    return normalizeDateValue(field.format, value);
  }
  if (field.type === "phone" && !/^1[3-9]\d{9}$/.test(value)) throw new BadRequestException(`「${field.label}」应为有效的 11 位手机号`);
  const formatIssue = textFormatValueIssue(field, value);
  if (formatIssue) throw new BadRequestException(`「${field.label}」${formatIssue}`);
  return value;
}
