import { isLocationValue, type LocationValue } from "@platform/contracts";

type LngLat = { getLng(): number; getLat(): number };
type Poi = {
  id: string;
  name: string;
  address?: string;
  pname?: string;
  cityname?: string;
  adname?: string;
  location: LngLat;
};
type Callback<T> = (status: string, result: T) => void;
export interface LocationMap {
  setCenter(point: number[]): void;
  on(name: "click", callback: (event: { lnglat: LngLat }) => void): void;
  destroy(): void;
}
export interface LocationMapSdk {
  Map: new (
    container: HTMLElement,
    options: { center: number[]; zoom: number; resizeEnable: boolean },
  ) => LocationMap;
  Marker: new (options: { position: number[]; map: LocationMap }) => {
    setPosition(point: number[]): void;
  };
  Circle: new (options: {
    center: number[];
    radius: number;
    map: LocationMap;
    strokeColor: string;
    fillColor: string;
    fillOpacity: number;
  }) => unknown;
  PlaceSearch: new (options: { pageSize: number }) => {
    search(
      query: string,
      callback: Callback<{ poiList?: { pois: Poi[] } }>,
    ): void;
  };
  Geocoder: new () => {
    getAddress(
      point: number[],
      callback: Callback<{
        regeocode?: {
          formattedAddress: string;
          addressComponent?: {
            province?: string;
            city?: string | string[];
            district?: string;
            township?: string;
          };
        };
      }>,
    ): void;
  };
  convertFrom(
    point: number[],
    kind: "gps",
    callback: Callback<{ locations?: LngLat[] }>,
  ): void;
}
type MapWindow = Window & {
  AMap?: LocationMapSdk;
  _AMapSecurityConfig?: { serviceHost: string };
};
let loading: Promise<LocationMapSdk> | undefined;
/** Deployment credentials belong to the map operator; never solicit them in field settings. */
export function loadLocationMap(): Promise<LocationMapSdk> {
  const key = import.meta.env.VITE_AMAP_JS_KEY;
  const serviceHost = import.meta.env.VITE_AMAP_SERVICE_HOST;
  if (!key || !serviceHost)
    return Promise.reject(
      Error("地图服务尚未启用，请联系管理员。已保存的位置仍可查看。"),
    );
  const target = window as MapWindow;
  if (target.AMap) return Promise.resolve(target.AMap);
  if (loading) return loading;
  loading = new Promise<LocationMapSdk>((resolve, reject) => {
    target._AMapSecurityConfig = { serviceHost };
    const script = document.createElement("script");
    script.src = `https://webapi.amap.com/maps?v=2.0&key=${encodeURIComponent(key)}&plugin=AMap.PlaceSearch,AMap.Geocoder`;
    script.async = true;
    const fail = () => {
      clearTimeout(timer);
      script.remove();
      loading = undefined;
      reject(Error("地图加载失败，请重试"));
    };
    const timer = window.setTimeout(fail, 20000);
    script.onerror = fail;
    script.onload = () => {
      clearTimeout(timer);
      if (!target.AMap) {
        fail();
        return;
      }
      resolve(target.AMap);
    };
    document.head.append(script);
  });
  return loading;
}
function request<T>(
  start: (callback: Callback<T>) => void,
): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(
      () => reject(Error("地图服务响应超时，请重试")),
      15000,
    );
    try {
      start((status, result) => {
        clearTimeout(timer);
        if (status === "complete") resolve(result);
        else if (status === "no_data") resolve(undefined);
        else reject(Error("地图服务暂时不可用，请重试"));
      });
    } catch {
      clearTimeout(timer);
      reject(Error("地图服务暂时不可用，请重试"));
    }
  });
}
export async function searchLocations(
  sdk: LocationMapSdk,
  query: string,
): Promise<LocationValue[]> {
  const result = await request<{ poiList?: { pois: Poi[] } }>((callback) =>
    new sdk.PlaceSearch({ pageSize: 20 }).search(query, callback),
  );
  return (result?.poiList?.pois || []).flatMap((poi) => {
    if (!poi.location) return [];
    const value: LocationValue = {
      lng: poi.location.getLng(),
      lat: poi.location.getLat(),
      coordinateSystem: "GCJ02",
      address: [
        poi.pname,
        poi.cityname !== poi.pname ? poi.cityname : "",
        poi.adname,
        poi.address,
        poi.name,
      ]
        .filter(Boolean)
        .join(""),
      province: poi.pname || "",
      city: poi.cityname || "",
      district: poi.adname || "",
      detail: [poi.address, poi.name].filter(Boolean).join(""),
    };
    return isLocationValue(value) ? [value] : [];
  });
}
export async function mapCoordinates(
  sdk: LocationMapSdk,
  value: LocationValue,
): Promise<LocationValue> {
  if (value.coordinateSystem === "GCJ02") return { ...value };
  const result = await request<{ locations?: LngLat[] }>((callback) =>
    sdk.convertFrom([value.lng, value.lat], "gps", callback),
  );
  const point = result?.locations?.[0];
  if (!point) throw Error("坐标转换失败，请重新获取位置");
  const converted: LocationValue = {
    ...value,
    lng: point.getLng(),
    lat: point.getLat(),
    coordinateSystem: "GCJ02",
  };
  if (value.origin) {
    const origin = await mapCoordinates(sdk, value.origin);
    converted.origin = {
      lng: origin.lng,
      lat: origin.lat,
      coordinateSystem: origin.coordinateSystem,
    };
  }
  if (!isLocationValue(converted)) throw Error("坐标转换失败，请重新获取位置");
  return converted;
}
export async function addressLocation(
  sdk: LocationMapSdk,
  value: LocationValue,
): Promise<LocationValue> {
  const point = await mapCoordinates(sdk, value);
  const result = await request<{
    regeocode?: {
      formattedAddress: string;
      addressComponent?: {
        province?: string;
        city?: string | string[];
        district?: string;
        township?: string;
      };
    };
  }>((callback) =>
    new sdk.Geocoder().getAddress([point.lng, point.lat], callback),
  );
  const address = result?.regeocode;
  if (!address) throw Error("未找到此位置的地址，请重新选点");
  let detail = address.formattedAddress;
  for (const part of [
    address.addressComponent?.province,
    typeof address.addressComponent?.city === "string"
      ? address.addressComponent.city
      : "",
    address.addressComponent?.district,
  ])
    if (part && detail.startsWith(part)) detail = detail.slice(part.length);
  return {
    ...point,
    address: address.formattedAddress,
    province: address.addressComponent?.province || "",
    city:
      typeof address.addressComponent?.city === "string"
        ? address.addressComponent.city
        : "",
    district: address.addressComponent?.district || "",
    detail,
  };
}
export const locationMobileDevice = () =>
  /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent) ||
  (/Mac/i.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
export function deviceLocation(): Promise<LocationValue> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(Error("当前浏览器不支持定位，请使用支持定位的浏览器"));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const value: LocationValue = {
          lng: position.coords.longitude,
          lat: position.coords.latitude,
          coordinateSystem: "WGS84",
          accuracy: position.coords.accuracy,
        };
        if (!isLocationValue(value)) {
          reject(Error("未获取到有效位置，请重试"));
          return;
        }
        value.origin = {
          lng: value.lng,
          lat: value.lat,
          coordinateSystem: value.coordinateSystem,
        };
        resolve(value);
      },
      (error) =>
        reject(
          Error(
            error.code === 1
              ? "未获得定位权限，请在浏览器中允许定位后重试"
              : error.code === 3
                ? "定位超时，请检查设备定位设置后重试"
                : "无法获取位置，请检查设备定位设置后重试",
          ),
        ),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 },
    );
  });
}
