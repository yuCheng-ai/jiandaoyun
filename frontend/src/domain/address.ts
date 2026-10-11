import regions from "@province-city-china/level";
import {
  addressParts,
  addressText,
  isAddressValue,
  type AddressValue,
  type FormField,
} from "@platform/contracts";

export interface AddressRegion {
  name: string;
  children?: AddressRegion[];
}
/** Municipalities and directly administered counties still share province/city/district values. */
export const addressRegions: AddressRegion[] = regions.map((province) => ({
  name: province.name,
  children: ["北京市", "天津市", "上海市", "重庆市"].includes(province.name)
    ? [{ name: province.name, children: province.children }]
    : province.children?.map((city) => ({
        name: city.name,
        children: city.children || [{ name: city.name }],
      })),
}));
const shortName = (name: string) =>
  name.replace(
    /(特别行政区|维吾尔自治区|壮族自治区|回族自治区|自治区|省|市|区|县)$/,
    "",
  );
export function addressRegion(
  items: AddressRegion[],
  value: string | undefined,
) {
  const exact = items.find((item) => item.name === value);
  if (exact || !value) return exact;
  const matches = items.filter((item) => shortName(item.name) === value);
  return matches.length === 1 ? matches[0] : undefined;
}
export function addressValueIssue(
  field: FormField,
  value: unknown,
): string | undefined {
  if (value == null || value === "") return;
  if (!isAddressValue(value)) return "地址格式无效，请重新选择";
  const parts = addressParts(field);
  if (!addressText(value, "", parts)) return;
  if (field.addressComplete && parts.some((key) => !value[key]?.trim()))
    return "请按类型完整填写地址";
  // Historical free-text values remain editable; new selections always use the shared hierarchy.
  if (field.format !== "none") {
    let items = addressRegions;
    for (const key of parts.filter((key) => key !== "detail")) {
      if (!value[key]?.trim()) {
        items = [];
        continue;
      }
      const region = addressRegion(items, value[key]);
      if (!region)
        return `请重新选择${{ province: "省", city: "市", district: "区" }[key]}`;
      items = region.children || [];
    }
  }
}
export function addressSelection(
  field: FormField,
  value: unknown,
  key: keyof AddressValue,
  name: string,
): AddressValue {
  const current = isAddressValue(value) ? value : {};
  const parts = addressParts(field),
    index = parts.indexOf(key);
  const changed = current[key] !== name;
  return Object.fromEntries(
    parts.map((part, i) => [
      part,
      part === key
        ? name
        : changed && i > index && part !== "detail"
          ? ""
          : current[part] || "",
    ]),
  );
}
