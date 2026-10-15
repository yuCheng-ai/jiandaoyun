import { BadRequestException } from "@nestjs/common";
import {
  addressTypes,
  choiceValueIssue,
  emptyFieldValue,
  fileSettingsErrors,
  fileValueIssue,
  isChoiceField,
  isDateFormat,
  isMultipleChoice,
  isMultipleOrganization,
  isOrganizationField,
  maxChoiceLabelLength,
  maxChoiceOptions,
  normalizeDateValue,
  numberValueIssue,
  richTextValueIssue,
  textFormatSettingsErrors,
  textFormatValueIssue,
  validDateValue,
  type ChoiceValue,
  type FieldValidationIssue,
  type FileValue,
  type FormField,
} from "@platform/contracts";
import { validateOrganizationRule } from "./organization-fields";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PHONE_REGEX = /^1[3-9]\d{9}$/;
const STRUCTURED_FIELD_TYPES = [
  "location",
  "address",
  "signature",
  "relationTable",
  "relation",
  "lookup",
  "query",
];

/**
 * 校验表单字段的格式、数字精度、日期默认值、组织范围及选项列表配置
 */
export function validateFieldRules(
  field: FormField,
  allowIncomplete: boolean,
  identifier: (value: unknown) => void,
) {
  const fileError = fileSettingsErrors(field, true)[0];
  if (fileError) throw new BadRequestException(`「${field.label}」${fileError}`);
  // 1. 校验数值字段开关配置
  for (const key of ["retainPrecision", "numberGrouping", "limitRange"] as const) {
    if (field[key] !== undefined && typeof field[key] !== "boolean") {
      throw new BadRequestException(`「${field.label}」的数字配置不合法`);
    }
  }
  if (field.type === "number" && field.format !== undefined && !["none", "number", "percent"].includes(field.format)) {
    throw new BadRequestException(`「${field.label}」请选择有效的数字格式`);
  }

  // 2. 校验日期字段格式与默认值规则
  if (field.dateDefault !== undefined && (field.type !== "datetime" || !["now", "custom"].includes(field.dateDefault))) {
    throw new BadRequestException(`「${field.label}」的日期默认值方式不合法`);
  }
  if (field.type === "datetime" && !isDateFormat(field.format)) {
    throw new BadRequestException(`「${field.label}」请选择有效的日期格式`);
  }
  if (
    field.type === "datetime" &&
    field.dateDefault === "now" &&
    field.defaultValue !== undefined &&
    (typeof field.defaultValue !== "string" || field.defaultValue.length > (field.maxLength || 10000))
  ) {
    throw new BadRequestException(`「${field.label}」的日期默认值格式不合法`);
  }

  // 3. 校验文本格式与通用格式支持范围
  const textErrors = textFormatSettingsErrors(field);
  if (textErrors.length) {
    throw new BadRequestException(`「${field.label}」${textErrors[0]}`);
  }
  if (field.type === "textarea" && field.format !== undefined && !["none", "email"].includes(field.format)) {
    throw new BadRequestException(`「${field.label}」的文本格式暂不支持`);
  }
  // 地址格式是省市区层级，沿用控件已有枚举，不能按普通文本格式拒绝。
  if (
    field.type === "address" &&
    field.format !== undefined &&
    field.format !== "none" &&
    !addressTypes.some((item) => item.value === field.format)
  ) {
    throw new BadRequestException(`「${field.label}」的地址层级格式无效`);
  }
  if (!["text", "textarea", "datetime", "number", "address"].includes(field.type) && field.format !== undefined && field.format !== "none") {
    throw new BadRequestException(`「${field.label}」的格式规则暂不支持`);
  }

  // 4. 校验组织成员/部门字段规则
  validateOrganizationRule(field);

  // 5. 校验单选/多选字段的数据来源、选项列表与默认值
  if (!isChoiceField(field.type)) return;

  if (!field.choiceSource || field.choiceSource.mode !== "manual") {
    throw new BadRequestException(`「${field.label}」的数据来源尚未接入服务端，请保留原配置`);
  }
  if (
    !Array.isArray(field.options) ||
    field.options.length > maxChoiceOptions ||
    (!allowIncomplete && !field.options.length)
  ) {
    throw new BadRequestException(`「${field.label}」应包含 1–${maxChoiceOptions} 个选项`);
  }

  const ids = new Set<string>();
  for (const option of field.options) {
    const isInvalidOption =
      !option ||
      typeof option !== "object" ||
      typeof option.label !== "string" ||
      !option.label.trim() ||
      option.label.length > maxChoiceLabelLength;
    if (isInvalidOption) {
      throw new BadRequestException(`「${field.label}」存在无效选项`);
    }
    identifier(option.id);
    if (ids.has(option.id)) {
      throw new BadRequestException(`「${field.label}」的选项身份重复`);
    }
    ids.add(option.id);
  }

  if (!emptyFieldValue(field.defaultValue)) {
    const isInvalidDefault = isMultipleChoice(field.type)
      ? !Array.isArray(field.defaultValue) || field.defaultValue.some((val) => typeof val !== "string")
      : typeof field.defaultValue !== "string";
    if (isInvalidDefault) {
      throw new BadRequestException(`「${field.label}」默认值应从预设选项中选择`);
    }
  }
}

/** 只有可定位的填写错误才参与批量收集；权限、冲突及其他异常必须直接中止。 */
export class FieldValidationException extends BadRequestException {
  constructor(readonly issues: FieldValidationIssue[]) {
    super({ message: issues[0]?.message || "填写内容不符合要求", issues });
  }
}

export function collectFieldIssues<T>(
  issues: FieldValidationIssue[],
  validate: () => T,
): T | undefined {
  try {
    return validate();
  } catch (error) {
    if (!(error instanceof FieldValidationException)) throw error;
    issues.push(...error.issues);
  }
}

/** 校验并标准化单个字段；配置检查不传 location，填写检查才提供当前可见字段的定位。 */
export function scalar(
  field: FormField,
  value: unknown,
  required = true,
  location?: Omit<FieldValidationIssue, "fieldId" | "message">,
): any {
  const fail: (message: string) => never = (message) => {
    if (location) {
      throw new FieldValidationException([{ fieldId: field.id, ...location, message }]);
    }
    throw new BadRequestException(message);
  };
  const multiple = isMultipleChoice(field.type) || isMultipleOrganization(field.type);

  // 附件必须是文件列表；空列表遵守必填规则，非空列表还会在保存事务中核验真实内容。
  if (field.type === "file" || field.type === "image") {
    const files = value == null || value === "" ? [] : value;
    const issue = fileValueIssue(field, files);
    if (issue) fail(`「${field.label}」${issue}`);
    if (required && field.required && Array.isArray(files) && !files.length) {
      fail(`「${field.label}」不能为空`);
    }
    return (files as FileValue[]).map(file => ({
      id: file.id,
      name: file.name,
      size: file.size,
      type: file.type,
    }));
  }

  // 1. 空值处理与必填校验
  if (emptyFieldValue(value)) {
    if (required && field.required) {
      fail(`「${field.label}」不能为空`);
    }
    if (Array.isArray(value) && !multiple) {
      fail(`「${field.label}」的值格式不合法`);
    }
    return multiple ? [] : "";
  }

  // 2. 组织架构字段（成员/部门）UUID 校验
  if (isOrganizationField(field.type)) {
    const hasInvalidContainer = multiple ? !Array.isArray(value) : typeof value !== "string";
    if (hasInvalidContainer) {
      fail(`「${field.label}」的组织身份格式不合法`);
    }

    const selected = (multiple ? value : [value]) as unknown[];
    const hasInvalidId =
      selected.length > 1000 ||
      new Set(selected).size !== selected.length ||
      selected.some((id) => typeof id !== "string" || !UUID_REGEX.test(id));
    if (hasInvalidId) {
      fail(`「${field.label}」包含无效或重复的组织身份`);
    }
    return multiple ? ([...selected] as string[]) : (selected[0] as string);
  }

  // 3. 选项类字段校验
  if (isChoiceField(field.type)) {
    const issue = choiceValueIssue(field, value);
    if (issue) fail(`「${field.label}」${issue}`);
    return structuredClone(value) as ChoiceValue | ChoiceValue[];
  }

  // 4. 数字字段校验
  if (field.type === "number") {
    const issue = numberValueIssue(field, value);
    if (issue) {
      let message = `最多输入 ${field.precision ?? 2} 位小数`;
      if (issue === "invalid") message = "请输入有效数字";
      else if (issue === "range") message = "超出允许范围";
      fail(`「${field.label}」${message}`);
    }
    return value as number;
  }

  // 5. 附件、定位、签名及关联查询等复合结构字段深拷贝返回
  if (STRUCTURED_FIELD_TYPES.includes(field.type)) {
    return structuredClone(value);
  }

  // 6. 文本、日期时间与手机号校验
  if (field.type === "richtext") {
    const issue = richTextValueIssue(value);
    if (issue) fail(`「${field.label}」${issue}`);
    if (required && field.required && !(value as string).trim()) {
      fail(`「${field.label}」不能为空`);
    }
    return value as string;
  }
  if (typeof value !== "string" || value.length > (field.maxLength || 10000)) {
    fail(`「${field.label}」的文本格式或长度不符合要求`);
  }
  if (required && field.required && !value.trim()) {
    fail(`「${field.label}」不能为空`);
  }
  if (field.type === "datetime") {
    if (!validDateValue(field.format, value)) {
      fail(`「${field.label}」的日期或时间不合法`);
    }
    return normalizeDateValue(field.format, value);
  }
  if (field.type === "phone" && !PHONE_REGEX.test(value)) {
    fail(`「${field.label}」应为有效的 11 位手机号`);
  }

  const formatIssue = textFormatValueIssue(field, value);
  if (formatIssue) {
    fail(`「${field.label}」${formatIssue}`);
  }

  return value;
}
