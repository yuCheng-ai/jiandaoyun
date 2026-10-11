import type { AddressValue, FormField } from "./form";

export const addressTypes = [
  { value: "province", label: "省" },
  { value: "city", label: "省-市" },
  { value: "district", label: "省-市-区" },
  { value: "detail", label: "省-市-区-详细地址" },
] as const;
export const addressKeys = ["province", "city", "district", "detail"] as const;
export const addressType = (field: Pick<FormField, "format">) =>
  addressTypes.find(item => item.value === field.format)?.value ?? "detail";
export const addressParts = (field: Pick<FormField, "format">) =>
  addressKeys.slice(0, addressKeys.indexOf(addressType(field)) + 1);
export function isAddressValue(value: unknown): value is AddressValue {
  return !!value && typeof value === "object" && Object.prototype.toString.call(value) === "[object Object]" &&
    Object.entries(value).every(([key, part]) => addressKeys.includes(key as typeof addressKeys[number]) && typeof part === "string");
}
/** Explicit order also keeps display/export stable for old objects with different key order. */
export function addressText(value: unknown, separator = "", parts: readonly (typeof addressKeys[number])[] = addressKeys): string {
  if (!isAddressValue(value)) return "";
  return parts.map((key, index) => {
    const part = value[key]?.trim();
    return !separator && key !== "detail" && index > 0 && part === value[parts[index - 1]!] ? "" : part;
  }).filter(Boolean).join(separator);
}
export function addressDefault(field: Pick<FormField, "format" | "defaultValue">): AddressValue | "" {
  const value = field.defaultValue;
  return isAddressValue(value) ? Object.fromEntries(addressParts(field).map(key => [key, value[key] || ""])) : "";
}
