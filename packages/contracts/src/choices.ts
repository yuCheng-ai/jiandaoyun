import type { ChoiceValue, FormField } from "./form";
import { emptyFieldValue, isChoiceField, isMultipleChoice, maxChoiceOptions, choiceValueKey, choiceConditionValue } from "./field-runtime";

// Sampled from the official option palette. Colors follow option identities, not row positions.
export const choicePalette = [
  "#eb5050", "#f0a800", "#46c26f", "#a2c204", "#00aed1", "#5865f5", "#c643e0", "#f0437d",
  "#fa8118", "#d6c504", "#00b899", "#6ac73c", "#2f7deb", "#7e47eb", "#d941c0", "#485970",
  "#f9cbcb", "#fbe5b3", "#c8edd4", "#e3edb4", "#b3e7f1", "#cdd1fc", "#eec7f6", "#fbc7d8",
  "#fed9ba", "#f3eeb4", "#b3eae0", "#d2eec5", "#c1d8f9", "#d8c8f9", "#f4c6ec", "#c8cdd4",
] as const;
export function optionColor(field: FormField, id: string, index = 0) {
  const stored = field.optionColors?.[id];
  return stored && /^#[0-9a-f]{6}$/i.test(stored) ? stored : choicePalette[index % choicePalette.length]!;
}
export function choiceSettingsErrors(field: FormField, incomplete = false): string[] {
  const errors: string[] = [];
  if (field.allowCustomChoices !== undefined && (!isMultipleChoice(field.type) || typeof field.allowCustomChoices !== "boolean")) errors.push("填写时添加选项设置不合法");
  const options = Array.isArray(field.options) ? field.options : [];
  if (options.some(option => option?.other !== undefined && typeof option.other !== "boolean") || (options.some(option => option?.other) && (!isChoiceField(field.type) || isMultipleChoice(field.type) || field.choiceSource?.mode !== "manual" || options.filter(option => option?.other).length > 1))) errors.push("其他选项设置不合法");
  if (field.coloredOptions !== undefined && (!isChoiceField(field.type) || typeof field.coloredOptions !== "boolean")) errors.push("选项颜色设置不合法");
  if (field.optionColors !== undefined) {
    const colors = field.optionColors;
    if (!isChoiceField(field.type) || !colors || typeof colors !== "object" || Array.isArray(colors) || Object.keys(colors).length > maxChoiceOptions || Object.entries(colors).some(([id, color]) => (!id.length || id.length > 100) || ["__proto__", "constructor", "prototype"].includes(id) || typeof color !== "string" || !/^#[0-9a-f]{6}$/i.test(color))) errors.push("选项颜色设置不合法");
  }
  // Keep the group layout when switching to a dropdown and back; dropdowns ignore it.
  if (field.choiceLayout !== undefined && (!isChoiceField(field.type) || !["vertical", "horizontal"].includes(field.choiceLayout))) errors.push("请选择有效的分布方式");
  if (field.selectionLimit !== undefined) {
    const limit = field.selectionLimit;
    if (!isMultipleChoice(field.type) || !limit || typeof limit !== "object" || Array.isArray(limit) || typeof limit.enabled !== "boolean" || [limit.min, limit.max].some(value => value !== undefined && (!Number.isSafeInteger(value) || value < 0))) errors.push("可选项数应为非负整数");
    else if (limit.enabled && !incomplete) {
      if (limit.min === undefined && limit.max === undefined) errors.push("请填写可选项数范围");
      else if (limit.min !== undefined && limit.max !== undefined && limit.min > limit.max) errors.push("最少可选项数不能大于最多可选项数");
    }
  }
  return errors;
}
export function selectionCountMessage(field: FormField, value: unknown): string | undefined {
  const limit = field.selectionLimit;
  if (!isMultipleChoice(field.type) || !limit?.enabled || (!Array.isArray(value) && !emptyFieldValue(value))) return;
  const count = Array.isArray(value) ? value.length : 0;
  if (count >= (limit.min ?? 0) && count <= (limit.max ?? Infinity)) return;
  return limit.min !== undefined && limit.max !== undefined ? `需选择${limit.min}~${limit.max}项` : limit.min !== undefined ? `至少选择${limit.min}项` : `最多选择${limit.max}项`;
}
/** Checkbox groups save definition order; dropdown multiple choices retain selection order. */
export function toggleChoice<T extends ChoiceValue>(field: FormField, ids: T[], id: T, checked: boolean, choices = field.options): T[] {
  const remaining = ids.filter(value => choiceValueKey(value) !== choiceValueKey(id));
  const next = checked ? [...remaining, id] : remaining;
  const rank = (value: T) => { const index = choices.findIndex(option => option.id === choiceConditionValue(value)); return index < 0 ? Infinity : index; };
  return field.type === "checkbox" ? [...next].sort((a, b) => rank(a) - rank(b)) : next;
}
