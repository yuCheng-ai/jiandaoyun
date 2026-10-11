import {
  choiceConditionValue,
  choiceValueLabel,
  isChoiceTextValue,
} from "@platform/contracts";
import type { FormField, FieldOption } from "@platform/contracts";

export const conditionValueType = (field: FormField) =>
  ["select", "radio", "multiselect", "checkbox"].includes(field.type)
    ? ("choice" as const)
    : ("text" as const);

export function parseChoiceConversion(raw: FormField["choiceConversion"]) {
  if (raw === undefined) return;
  if (
    !raw ||
    !["text", "choice"].includes(raw.initialType) ||
    !Array.isArray(raw.options)
  )
    throw Error("字段类型转换记录无效");
  const ids = new Set<string>();
  const options = raw.options.map((option) => {
    if (
      !option ||
      typeof option.id !== "string" ||
      !option.id ||
      ids.has(option.id) ||
      typeof option.label !== "string" ||
      (option.other !== undefined && typeof option.other !== "boolean")
    )
      throw Error("字段类型转换的选项记录无效");
    ids.add(option.id);
    return {
      id: option.id,
      label: option.label,
      ...(option.other ? { other: true } : {}),
    };
  });
  if (
    raw.sources !== undefined &&
    (!Array.isArray(raw.sources) ||
      raw.sources.some(
        (source) =>
          !source ||
          typeof source.formId !== "string" ||
          !source.formId ||
          typeof source.labelFieldId !== "string" ||
          !source.labelFieldId ||
          typeof source.valueFieldId !== "string",
      ))
  )
    throw Error("字段类型转换的选项来源无效");
  return {
    initialType: raw.initialType,
    options,
    ...(raw.sources
      ? {
          sources: raw.sources.map(
            ({ formId, labelFieldId, valueFieldId }) => ({
              formId,
              labelFieldId,
              valueFieldId,
            }),
          ),
        }
      : {}),
  };
}

export function choiceConversion(
  field: FormField,
): NonNullable<FormField["choiceConversion"]> {
  const previous = field.choiceConversion;
  const options = new Map(
    (previous?.options || []).map((option) => [option.id, { ...option }]),
  );
  // A schema must never snapshot business records from a dynamic option source.
  if (
    conditionValueType(field) === "choice" &&
    field.choiceSource.mode === "manual"
  )
    for (const option of field.options) options.set(option.id, { ...option });
  const sources = [...(previous?.sources || [])];
  if (
    conditionValueType(field) === "choice" &&
    field.choiceSource.mode === "form"
  ) {
    const { formId, labelFieldId, valueFieldId } = field.choiceSource;
    if (
      formId &&
      labelFieldId &&
      !sources.some(
        (source) =>
          source.formId === formId &&
          source.labelFieldId === labelFieldId &&
          source.valueFieldId === valueFieldId,
      )
    )
      sources.push({ formId, labelFieldId, valueFieldId });
  }
  return {
    initialType: previous?.initialType || conditionValueType(field),
    options: [...options.values()],
    ...(sources.length ? { sources } : {}),
  };
}

type ConditionOption = (
  field: FormField,
  id: unknown,
) => FieldOption | undefined;
const optionFor = (
  field: FormField | undefined,
  id: unknown,
  resolve?: ConditionOption,
): FieldOption | undefined =>
  (field &&
  conditionValueType(field) === "choice" &&
  field.choiceSource.mode === "manual"
    ? field.options.find((option) => option.id === id)
    : undefined) ||
  field?.choiceConversion?.options.find((option) => option.id === id) ||
  (field && resolve?.(field, id));

/** Different fields have independent option identities. Compare their business
 * values, using each side's own definition and the caller's permitted choices.
 * Missing identities remain unknown, even for a negative predicate.
 */
export function fieldConditionValues(
  actualField: FormField | undefined,
  expectedField: FormField | undefined,
  actual: unknown,
  expected: unknown,
  choices: (field: FormField) => FieldOption[],
): { actual: unknown; expected: unknown } | undefined {
  const aChoice = actualField && conditionValueType(actualField) === "choice";
  const bChoice =
    expectedField && conditionValueType(expectedField) === "choice";
  if (
    (!aChoice && !bChoice) ||
    (aChoice && bChoice && actualField.id === expectedField.id)
  )
    return {
      actual: choiceConditionValue(actual),
      expected: choiceConditionValue(expected),
    };
  if (!actualField || !expectedField) return;
  // Existing formula defaults can return an option ID. Keep that contract for
  // unconverted fields; text created by a type conversion is always literal.
  if (
    !actualField.choiceConversion &&
    !expectedField.choiceConversion &&
    ((aChoice &&
      expectedField.defaultFormula &&
      choices(actualField).some((option) => option.id === expected)) ||
      (bChoice &&
        actualField.defaultFormula &&
        choices(expectedField).some((option) => option.id === actual)))
  )
    return {
      actual: choiceConditionValue(actual),
      expected: choiceConditionValue(expected),
    };
  function value(field: FormField, raw: unknown): unknown {
    if (conditionValueType(field) !== "choice") return raw;
    const options = choices(field);
    const label = (item: unknown) => {
      if (item === undefined || item === null || item === "") return item;
      if (isChoiceTextValue(item)) {
        if (
          item.optionId &&
          !options.some((option) => option.id === item.optionId && option.other)
        )
          return;
        return choiceValueLabel(options, item);
      }
      const option = options.find((option) => option.id === item);
      return option?.label;
    };
    if (!Array.isArray(raw)) return label(raw);
    const result = raw.map(label);
    return result.some((item) => item === undefined) ? undefined : result;
  }
  const a = value(actualField, actual),
    b = value(expectedField, expected);
  if (
    (a === undefined && actual !== undefined) ||
    (b === undefined && expected !== undefined)
  )
    return;
  return { actual: a, expected: b };
}

/** Literal strings and option identities must stay distinct after changing widgets.
 * Undefined means an identity cannot be resolved, including for negative predicates.
 * Configuration and record fields may come from different immutable versions.
 */
export function conditionValues(
  field: FormField | undefined,
  recordField: FormField | undefined,
  actual: unknown,
  expected: unknown,
  valueType?: "text" | "choice",
  resolve?: ConditionOption,
): { actual: unknown; expected: unknown } | undefined {
  const normal = {
    actual: choiceConditionValue(actual),
    expected: choiceConditionValue(expected),
  };
  const conversion = field?.choiceConversion || recordField?.choiceConversion;
  if (!conversion) return normal;
  if (!recordField) return;
  const kind = valueType || conversion.initialType;
  const actualChoice = conditionValueType(recordField) === "choice";
  if (
    kind === "choice" &&
    actualChoice &&
    (recordField.choiceSource.mode === "form" ||
      normal.actual === normal.expected ||
      recordField.options.some((option) => option.id === normal.expected))
  )
    return normal;
  const option =
    kind === "choice"
      ? optionFor(field, normal.expected, resolve) ||
        optionFor(recordField, normal.expected, resolve)
      : undefined;
  if (kind === "choice" && (!option || option.other)) return;
  let comparable = actual;
  if (actualChoice) {
    if (actual === undefined || actual === null || actual === "")
      comparable = actual;
    else if (isChoiceTextValue(actual)) {
      const selected = actual.optionId
        ? optionFor(recordField, actual.optionId, resolve)
        : undefined;
      if (actual.optionId && !selected?.other) return;
      comparable = choiceValueLabel(selected ? [selected] : [], actual);
    } else {
      const selected =
        optionFor(recordField, actual, resolve) ||
        optionFor(field, actual, resolve);
      if (!selected) return;
      comparable = selected.label;
    }
  }
  return { actual: comparable, expected: option ? option.label : expected };
}

/** The existing condition editor shows the business value while retaining its identity. */
export function conditionDisplayValue(
  field: FormField | undefined,
  value: string,
  valueType?: "text" | "choice",
  resolve?: ConditionOption,
) {
  if (
    !field?.choiceConversion ||
    conditionValueType(field) !== "text" ||
    (valueType || field.choiceConversion.initialType) !== "choice"
  )
    return value;
  return optionFor(field, value, resolve)?.label || value;
}
