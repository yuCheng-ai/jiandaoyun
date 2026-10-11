import type { FormField, FormValues, AddressValue } from "./form";

export interface LocationPoint {
  lng: number;
  lat: number;
  coordinateSystem: "WGS84" | "GCJ02";
}
export interface LocationValue extends LocationPoint, AddressValue {
  address?: string;
  accuracy?: number;
  /** Original device fix; moving the pin never moves its adjustment boundary. */
  origin?: LocationPoint;
}
export interface LocationSettings {
  autoLocate: boolean;
  mobileOnly: boolean;
  showCoordinates: boolean;
  adjustEnabled: boolean;
  adjustRadius: number;
  rangeEnabled: boolean;
  rangeMode: "fixed" | "field";
  centers: { id: string; position: LocationValue; radius: number }[];
  centerFieldId: string;
  rangeRadius: number;
}
export const emptyLocationSettings = (): LocationSettings => ({
  autoLocate: false,
  mobileOnly: true,
  showCoordinates: false,
  adjustEnabled: false,
  adjustRadius: 500,
  rangeEnabled: false,
  rangeMode: "fixed",
  centers: [],
  centerFieldId: "",
  rangeRadius: 500,
});
const object = (value: unknown): value is Record<string, unknown> =>
  !!value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const radius = (value: unknown): value is number => finite(value) && value > 0;
export function isLocationPoint(value: unknown): value is LocationPoint {
  return (
    object(value) &&
    finite(value.lng) &&
    Math.abs(value.lng) <= 180 &&
    finite(value.lat) &&
    Math.abs(value.lat) <= 90 &&
    (value.coordinateSystem === "WGS84" || value.coordinateSystem === "GCJ02")
  );
}
export function isLocationValue(value: unknown): value is LocationValue {
  if (!isLocationPoint(value) || !object(value)) return false;
  const keys = [
    "lng",
    "lat",
    "coordinateSystem",
    "address",
    "accuracy",
    "origin",
    "province",
    "city",
    "district",
    "detail",
  ];
  return (
    Object.keys(value).every((key) => keys.includes(key)) &&
    ["address", "province", "city", "district", "detail"].every(
      (key) =>
        !Object.hasOwn(value, key) ||
        (typeof value[key] === "string" && value[key].length <= 2000),
    ) &&
    (!Object.hasOwn(value, "accuracy") ||
      (finite(value.accuracy) && value.accuracy >= 0)) &&
    (!Object.hasOwn(value, "origin") ||
      (isLocationPoint(value.origin) &&
        value.origin.coordinateSystem === value.coordinateSystem))
  );
}
export function locationText(value: unknown, coordinates = false): string {
  if (typeof value === "string") return value; // Historical text remains readable.
  if (!isLocationValue(value)) return "";
  const address =
    value.address ||
    [value.province, value.city, value.district, value.detail]
      .filter(Boolean)
      .join("");
  const point = `${value.lng.toFixed(6)}, ${value.lat.toFixed(6)}`;
  return address ? address + (coordinates ? `（${point}）` : "") : point;
}
/** Metres on one coordinate system; never silently compare GPS with AMap coordinates. */
export function locationDistance(a: LocationPoint, b: LocationPoint): number {
  if (!isLocationPoint(a) || !isLocationPoint(b))
    throw Error("需要有效的定位参数");
  if (a.coordinateSystem !== b.coordinateSystem)
    throw Error("定位坐标系不同，请重新获取位置");
  const radians = Math.PI / 180;
  const h =
    Math.sin(((b.lat - a.lat) * radians) / 2) ** 2 +
    Math.cos(a.lat * radians) *
      Math.cos(b.lat * radians) *
      Math.sin(((b.lng - a.lng) * radians) / 2) ** 2;
  return 6371008.8 * 2 * Math.asin(Math.sqrt(Math.max(0, Math.min(1, h))));
}
export function parseLocationSettings(
  raw: unknown,
): LocationSettings | undefined {
  if (raw === undefined) return;
  if (
    !object(raw) ||
    [
      "autoLocate",
      "mobileOnly",
      "showCoordinates",
      "adjustEnabled",
      "rangeEnabled",
    ].some((key) => typeof raw[key] !== "boolean") ||
    !radius(raw.adjustRadius) ||
    !radius(raw.rangeRadius) ||
    !["fixed", "field"].includes(String(raw.rangeMode)) ||
    typeof raw.centerFieldId !== "string" ||
    !Array.isArray(raw.centers) ||
    raw.centers.length > 100 ||
    raw.centers.some(
      (center) =>
        !object(center) ||
        typeof center.id !== "string" ||
        !center.id ||
        !isLocationValue(center.position) ||
        !radius(center.radius),
    ) ||
    new Set(raw.centers.map((center) => center.id)).size !== raw.centers.length
  )
    throw Error("定位设置无效");
  return JSON.parse(JSON.stringify(raw)) as LocationSettings;
}
export function locationSettingsErrors(
  field: FormField,
  scope: FormField[],
): string[] {
  const settings = field.location;
  if (field.type !== "location" || !settings) return [];
  try {
    parseLocationSettings(settings);
  } catch (error) {
    return [(error as Error).message];
  }
  if (!settings.rangeEnabled) return [];
  if (settings.rangeMode === "fixed")
    return settings.centers.length ? [] : ["请添加定位中心"];
  return scope.some(
    (item) =>
      item.id === settings.centerFieldId &&
      item.id !== field.id &&
      item.type === "location",
  )
    ? []
    : ["请选择当前范围内的其他定位字段"];
}
export function locationValueIssue(
  field: FormField,
  value: unknown,
  values: FormValues = {},
): string | undefined {
  if (value == null || value === "") return;
  if (!field.location && typeof value === "string") return;
  if (!isLocationValue(value)) return "请重新获取有效位置";
  const settings = field.location;
  if (!settings?.rangeEnabled) return;
  const centers =
    settings.rangeMode === "fixed"
      ? settings.centers
      : [
          {
            position: values[settings.centerFieldId],
            radius: settings.rangeRadius,
          },
        ];
  if (
    !centers.length ||
    centers.some(
      (center) => !isLocationValue(center.position) || !radius(center.radius),
    )
  )
    return "定位中心不可用，请先填写定位中心或检查范围设置";
  try {
    return centers.some(
      (center) =>
        locationDistance(value, center.position as LocationValue) <=
        center.radius + 0.001,
    )
      ? undefined
      : "当前位置不在允许的定位范围内";
  } catch (error) {
    return (error as Error).message;
  }
}
export function locationAdjustmentIssue(
  value: LocationValue,
  origin: LocationPoint,
  metres: number,
): string | undefined {
  try {
    return !radius(metres) || locationDistance(value, origin) > metres + 0.001
      ? `只能在当前位置${metres}米内微调`
      : undefined;
  } catch (error) {
    return (error as Error).message;
  }
}
