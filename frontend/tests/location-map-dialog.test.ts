// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { createApp, nextTick, reactive, h } from "vue";
import { type LocationValue } from "@platform/contracts";
import LocationPickerDialog from "../src/features/forms/components/LocationPickerDialog.vue";
import {
  addressLocation,
  searchLocations,
  type LocationMapSdk,
} from "../src/services/locationMap";

let app: ReturnType<typeof createApp> | undefined;
const settle = async () => {
  for (let i = 0; i < 14; i++) await nextTick();
};
afterEach(() => {
  app?.unmount();
  app = undefined;
  document.body.innerHTML = "";
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const point: LocationValue = { lng: 120, lat: 30, coordinateSystem: "WGS84" };
function adapter() {
  let click: (event: {
    lnglat: { getLng(): number; getLat(): number };
  }) => void = () => {};
  let search: ((status: string, result: any) => void) | undefined;
  let geocode: ((status: string, result: any) => void) | undefined;
  const destroyed = vi.fn(),
    centers: number[][] = [];
  const sdk = {
    Map: class {
      constructor(_element: HTMLElement, options: { center: number[] }) {
        centers.push(options.center);
      }
      setCenter(point: number[]) {
        centers.push(point);
      }
      on(_name: string, callback: typeof click) {
        click = callback;
      }
      destroy() {
        destroyed();
      }
    },
    Marker: class {
      setPosition() {}
    },
    Circle: class {},
    convertFrom(coordinates: number[], _kind: string, callback: any) {
      callback("complete", {
        locations: [
          {
            getLng: () => coordinates[0]! + 0.001,
            getLat: () => coordinates[1]! + 0.001,
          },
        ],
      });
    },
    PlaceSearch: class {
      search(_query: string, callback: any) {
        search = callback;
      }
    },
    Geocoder: class {
      getAddress(_coordinates: number[], callback: any) {
        geocode = callback;
      }
    },
  } as unknown as LocationMapSdk;
  vi.stubEnv("VITE_AMAP_JS_KEY", "unit-test-key");
  vi.stubEnv("VITE_AMAP_SERVICE_HOST", "/unit-test-proxy");
  vi.stubGlobal("AMap", sdk);
  return {
    sdk,
    centers,
    destroyed,
    mapClick(lng: number, lat: number) {
      click({ lnglat: { getLng: () => lng, getLat: () => lat } });
    },
    searchResult(status: string, result: any) {
      search!(status, result);
    },
    addressResult(status = "complete") {
      geocode!(status, {
        regeocode: {
          formattedAddress: "浙江省杭州市余杭区SYN-验收仓库",
          addressComponent: {
            province: "浙江省",
            city: "杭州市",
            district: "余杭区",
          },
        },
      });
    },
  };
}
function mount(props: any) {
  document.body.innerHTML = '<div id="app"></div>';
  app = createApp(LocationPickerDialog, props);
  app.mount("#app");
}
const confirm = () =>
  Array.from(
    document.querySelectorAll<HTMLButtonElement>(".dialog-footer button"),
  ).find((button) => button.textContent?.trim() === "确定")!;

it("normalizes GPS and its original fix before enforcing the adjustment boundary and confirming a position", async () => {
  const map = adapter(),
    select = vi.fn();
  mount({
    open: true,
    value: { ...point, origin: point },
    origin: point,
    radius: 100,
    onSelect: select,
  });
  await settle();
  expect(map.centers[0]).toEqual([120.001, 30.001]);
  map.mapClick(120.001, 30.002);
  await settle();
  map.addressResult();
  await settle();
  expect(document.body.textContent).toContain("100米内微调");
  expect(confirm().disabled).toBe(true);
  map.mapClick(120.001, 30.0012);
  await settle();
  map.addressResult();
  await settle();
  expect(confirm().disabled).toBe(false);
  confirm().click();
  expect(select).toHaveBeenCalledWith(
    expect.objectContaining({
      lng: 120.001,
      lat: 30.0012,
      coordinateSystem: "GCJ02",
      detail: "SYN-验收仓库",
      origin: { lng: 120.001, lat: 30.001, coordinateSystem: "GCJ02" },
    }),
  );
});

it("ignores a late place search after the dialog has closed and destroys its real map handle", async () => {
  const map = adapter(),
    state = reactive({ open: true }),
    select = vi.fn();
  document.body.innerHTML = '<div id="app"></div>';
  app = createApp({
    setup: () => () =>
      h(LocationPickerDialog, {
        open: state.open,
        onClose: () => (state.open = false),
        onSelect: select,
      }),
  });
  app.mount("#app");
  await settle();
  const input = document.querySelector<HTMLInputElement>(
    '[aria-label="搜索地点"]',
  )!;
  input.value = "SYN-仓库";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await settle();
  document
    .querySelector("form")!
    .dispatchEvent(new Event("submit", { cancelable: true }));
  await settle();
  Array.from(
    document.querySelectorAll<HTMLButtonElement>(".dialog-footer button"),
  )
    .find((button) => button.textContent?.trim() === "取消")!
    .click();
  await settle();
  map.searchResult("complete", {
    poiList: {
      pois: [
        {
          id: "p",
          name: "SYN-迟到结果",
          location: { getLng: () => 120, getLat: () => 30 },
        },
      ],
    },
  });
  await settle();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(select).not.toHaveBeenCalled();
  expect(map.destroyed).toHaveBeenCalled();
});

it("keeps read-only viewing from changing the pin or invoking geocoding", async () => {
  const map = adapter(),
    select = vi.fn();
  mount({
    open: true,
    value: { ...point, coordinateSystem: "GCJ02", address: "SYN-已保存" },
    readonly: true,
    onSelect: select,
  });
  await settle();
  map.mapClick(119, 29);
  await settle();
  expect(document.body.textContent).toContain("SYN-已保存");
  expect(document.querySelector('[aria-label="搜索地点"]')).toBeNull();
  expect(select).not.toHaveBeenCalled();
});

it("returns no search data distinctly and rejects failed address lookup instead of manufacturing an address", async () => {
  const map = adapter();
  const search = searchLocations(map.sdk, "SYN-无匹配");
  map.searchResult("no_data", {});
  await expect(search).resolves.toEqual([]);
  const address = addressLocation(map.sdk, {
    ...point,
    coordinateSystem: "GCJ02",
  });
  await settle();
  map.addressResult("error");
  await expect(address).rejects.toThrow("暂时不可用");
});
