import { displayPlainFieldValue, type FormField } from "@platform/contracts";
import { richTextPlainText } from "./richText";
export { valueText } from "@platform/contracts";
export function displayFieldValue(
  field: FormField | undefined,
  value: unknown,
  labels: Parameters<typeof displayPlainFieldValue>[2] = {},
): string {
  return field?.type === "richtext"
    ? typeof value === "string"
      ? richTextPlainText(value)
      : ""
    : displayPlainFieldValue(field, value, labels);
}
