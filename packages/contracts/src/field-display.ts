import {
  addressParts,
  addressText,
  choiceValueLabel,
  formatNumberValue,
  isChoiceField,
  isChoiceTextValue,
  isNumericField,
  isOrganizationField,
  locationText,
  type FieldOption,
  type FormField,
} from "./index";

export function valueText(value: unknown): string {
  if (isChoiceTextValue(value)) return value.text || "其他";
  return value == null
    ? ""
    : typeof value === "object"
      ? Array.isArray(value)
        ? value.map(valueText).join("、")
        : Object.values(value).map(valueText).filter(Boolean).join(" ")
      : String(value);
}

/** Formatting owns no directory or record store. Callers supply permitted labels. */
export function displayPlainFieldValue(
  field: FormField | undefined,
  value: unknown,
  labels: {
    identity?: (id: string) => string;
    choices?: FieldOption[];
    relation?: (id: string) => string;
  } = {},
): string {
  if (value == null || value === "") return "—";
  if (!field) return valueText(value);
  if (field.type === "location")
    return locationText(value, field.location?.showCoordinates) || "—";
  if (field.type === "address")
    return addressText(value, "", addressParts(field)) || "—";
  if (isNumericField(field)) return formatNumberValue(field, value);
  const values = Array.isArray(value) ? value : [value];
  if (isOrganizationField(field.type))
    return (
      values
        .filter((item) => typeof item === "string")
        .map((id) => labels.identity?.(id) || "无法识别的成员或部门")
        .join("、") || "—"
    );
  if (isChoiceField(field.type))
    return (
      values
        .map((item) => choiceValueLabel(labels.choices || field.options, item))
        .join("、") || "—"
    );
  if (labels.relation)
    return (
      values
        .filter((item) => typeof item === "string")
        .map(labels.relation)
        .join("、") || "—"
    );
  if (field.type === "signature") return value ? "已签名" : "—";
  if (field.type === "file" || field.type === "image")
    return Array.isArray(value)
      ? value.map((file) => file?.name || "文件").join("、")
      : "—";
  if (field.type === "subform")
    return Array.isArray(value) ? `${value.length} 行明细` : "—";
  return valueText(value) || "—";
}
