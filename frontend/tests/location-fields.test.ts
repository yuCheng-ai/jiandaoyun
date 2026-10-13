// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApp, h, nextTick, reactive } from "vue";
import { createPinia } from "pinia";
import {
  emptyLocationSettings,
  isLocationValue,
  locationDistance,
  locationText,
  locationValueIssue,
  locationAdjustmentIssue,
  separateFormSchema,
  composeFormSchema,
  type LocationValue,
  type FormField,
} from "@platform/contracts";
import {
  createField,
  defaultValues,
  duplicateFields,
  emptySchema,
  parseSchema,
  validateValues,
} from "../src/domain/form";
import {
  evaluateFieldFormula,
  formulaExpressionErrors,
} from "@platform/contracts";
import {
  applyFieldChange,
  displayValue,
  linkedDefault,
  matchesFilters,
} from "../src/domain/relations";
import { validateFieldConfiguration } from "../src/domain/fieldValidation";
import { seedWorkspace, newForm } from "../src/domain/workspace";
import LocationFieldControl from "../src/features/forms/components/LocationFieldControl.vue";
import LocationPickerDialog from "../src/features/forms/components/LocationPickerDialog.vue";
import { deviceLocation, loadLocationMap } from "../src/services/locationMap";
import { useWorkspaceStore } from "../src/stores/workspace";
import { coerceFrontendValue } from "../src/domain/frontendEventValues";

const point: LocationValue = {
  lng: 120,
  lat: 30,
  coordinateSystem: "WGS84",
  address: "SYN-验收仓库",
  province: "浙江省",
  city: "杭州市",
  district: "余杭区",
  detail: "验收仓库",
};
const location = (id = "position", patch: Partial<FormField> = {}) =>
  createField("location", {
    id,
    location: { ...emptyLocationSettings(), mobileOnly: false },
    ...patch,
  });
let app: ReturnType<typeof createApp> | undefined;
let success: PositionCallback;
let failure: PositionErrorCallback | null;
const getCurrentPosition = vi.fn(
  (onSuccess: PositionCallback, onError?: PositionErrorCallback | null) => {
    success = onSuccess;
    failure = onError || null;
  },
);
const settled = async () => {
  for (let i = 0; i < 10; i++) await nextTick();
};
function mount(component: any, props: any) {
  document.body.innerHTML = '<div id="mount"></div>';
  app = createApp(component, props);
  app.use(createPinia());
  app.mount("#mount");
}
const action = () =>
  document.querySelector<HTMLButtonElement>(".location-action")!;
const fix = () =>
  success({
    coords: { longitude: point.lng, latitude: point.lat, accuracy: 7 },
    timestamp: Date.now(),
  } as GeolocationPosition);
beforeEach(() => {
  vi.stubEnv("VITE_AMAP_JS_KEY", "");
  vi.stubEnv("VITE_AMAP_SERVICE_HOST", "");
  getCurrentPosition.mockClear();
  vi.stubGlobal(
    "navigator",
    Object.assign(Object.create(navigator), {
      geolocation: { getCurrentPosition },
    }),
  );
});
afterEach(() => {
  app?.unmount();
  app = undefined;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  localStorage.clear();
});

it("preserves historical text and independently saved structured defaults, settings and copied centre references", () => {
  const old = location("old", { defaultValue: "旧记录位置" });
  delete old.location;
  const center = location("center", { defaultValue: point });
  const target = location("target", {
    location: {
      ...emptyLocationSettings(),
      rangeEnabled: true,
      rangeMode: "field",
      centerFieldId: center.id,
    },
  });
  const schema = parseSchema({
    ...emptySchema(),
    fields: [old, center, target],
  });
  const separated = separateFormSchema(schema);
  const restored = composeFormSchema(separated.model, separated.page);
  expect(restored.fields[0]!.location).toBeUndefined();
  expect(defaultValues(restored.fields)).toEqual({
    old: "旧记录位置",
    center: point,
    target: "",
  });
  const clone = duplicateFields([center, target]).fields;
  expect(clone[1]!.location!.centerFieldId).toBe(clone[0]!.id);
  clone[0]!.defaultValue = "";
  expect(center.defaultValue).toEqual(point);
  expect(validateValues(schema, { old: "旧记录位置", center: point })).toEqual(
    [],
  );
});

it("rejects invalid positions and unsafe range settings before they become usable definitions or values", () => {
  for (const invalid of [
    { ...point, lng: Infinity },
    { ...point, lat: 91 },
    { ...point, lng: "120" },
    { ...point, coordinateSystem: "BD09" },
    { ...point, origin: { ...point, coordinateSystem: "GCJ02" } },
    { ...point, accuracy: -1 },
  ]) {
    expect(isLocationValue(invalid)).toBe(false);
    expect(locationValueIssue(location(), invalid)).toMatch(/有效位置/);
  }
  expect(isLocationValue({ lng: 0, lat: 0, coordinateSystem: "WGS84" })).toBe(
    true,
  );
  const field = location();
  field.location!.rangeRadius = NaN;
  expect(() => parseSchema({ ...emptySchema(), fields: [field] })).toThrow(
    "定位设置无效",
  );
  expect(
    validateValues(
      { ...emptySchema(), fields: [location("required", { required: true })] },
      { required: "" },
    )[0]?.message,
  ).toBe("请填写定位");
});

it("uses any fixed centre, checks metre boundaries and refuses mixed coordinate systems", () => {
  const field = location();
  field.location!.rangeEnabled = true;
  const far = { ...point, lat: 31 };
  field.location!.centers = [
    { id: "far", position: far, radius: 100 },
    { id: "near", position: point, radius: 100 },
  ];
  const edge = {
    ...point,
    lat: point.lat + ((100 / 6371008.8) * 180) / Math.PI,
  };
  expect(locationValueIssue(field, edge)).toBeUndefined();
  expect(
    locationValueIssue(field, { ...edge, lat: edge.lat + 0.0001 }),
  ).toMatch(/不在允许/);
  expect(
    locationValueIssue(field, { ...point, coordinateSystem: "GCJ02" }),
  ).toMatch(/坐标系不同/);
  expect(locationDistance(point, point)).toBe(0);
  expect(
    locationDistance(
      { ...point, lat: 0, lng: 179.999 },
      { ...point, lat: 0, lng: -179.999 },
    ),
  ).toBeCloseTo(222.39, 1);
  expect(locationAdjustmentIssue(far, point, 500)).toMatch(/500米/);
});

it("validates each row against its own centre, retains values on centre changes and flags a removed reference", () => {
  const center = location("center"),
    target = location("target");
  target.location = {
    ...emptyLocationSettings(),
    rangeEnabled: true,
    rangeMode: "field",
    centerFieldId: center.id,
    rangeRadius: 100,
  };
  const rows = createField("subform", {
    id: "rows",
    children: [center, target],
  });
  const schema = { ...emptySchema(), fields: [rows] };
  const far = { ...point, lat: 31 };
  expect(
    validateValues(schema, {
      rows: [
        { center: point, target: point },
        { center: far, target: point },
      ],
    }).map((e) => e.path),
  ).toEqual(["rows.1.target"]);
  expect(locationValueIssue(target, point, {})).toMatch(/定位中心不可用/);
  const changed = applyFieldChange(
    [center, target],
    { center: point, target: point },
    "center",
    far,
    seedWorkspace(),
  );
  expect(changed.target).toEqual(point);
  const errors = validateFieldConfiguration(
    { ...emptySchema(), fields: [target] },
    seedWorkspace(),
  );
  expect(JSON.stringify(errors)).toContain("其他定位字段");
});

it("extracts actual location parts and metre distances through the formula engine while preserving address formulas", () => {
  const a = location("a"),
    b = location("b"),
    formula = createField("calculated", {
      id: "distance",
      expression: "DISTANCE({{a}},{{b}})",
    });
  const values = { a: point, b: { ...point, lat: 30.001 } };
  expect(
    formulaExpressionErrors(formula.expression, [a, b, formula], {
      targetId: formula.id,
      returns: "number",
    }),
  ).toEqual([]);
  expect(
    evaluateFieldFormula(formula.expression, [a, b], values).value,
  ).toBeCloseTo(111.195, 2);
  expect(
    evaluateFieldFormula('TEXTLOCATION({{a}},"lng")', [a, b], values).value,
  ).toBe("120");
  expect(
    evaluateFieldFormula('TEXTLOCATION({{a}},"detail")', [a, b], values).value,
  ).toBe("验收仓库");
  expect(
    evaluateFieldFormula('TEXTLOCATION({{a}},"address")', [a, b], values).value,
  ).toBe("SYN-验收仓库");
  expect(
    evaluateFieldFormula(
      'TEXTLOCATION({{address}},"city")',
      [createField("address", { id: "address", format: "city" })],
      { address: { city: "杭州市" } },
    ).value,
  ).toBe("杭州市");
  expect(
    evaluateFieldFormula(formula.expression, [a, b], { a: "旧位置", b: point })
      .error,
  ).toMatch(/有效定位/);
});

it("links the original structured location rather than stringifying or treating all positions as the same filter value", () => {
  const data = seedWorkspace(),
    source = newForm("oa", "SYN-定位来源");
  source.schema.fields = [location("source")];
  source.published = {
    version: 1,
    schema: source.schema,
    publishedAt: new Date().toISOString(),
  } as any;
  source.versions = [source.published!];
  data.forms.push(source);
  data.entries.push({
    id: "entry",
    formId: source.id,
    definitionVersion: 1,
    state: "submitted",
    createdAt: new Date().toISOString(),
    values: { source: point },
  } as any);
  const field = location("linked", {
    defaultLink: {
      enabled: true,
      formId: source.id,
      fieldId: "source",
      filters: [],
      match: "all",
    },
  });
  expect(linkedDefault(field, data, {})).toEqual(point);
  expect(displayValue(field, point, data)).toBe("SYN-验收仓库");
  expect(locationText(point, true)).toBe(
    "SYN-验收仓库（120.000000, 30.000000）",
  );
  const filter = {
    id: "f",
    sourceFieldId: "source",
    operator: "equals",
    source: "field",
    value: "other",
  } as const;
  expect(
    matchesFilters(
      [filter],
      { source: point },
      { other: { ...point, lat: 31 } },
      data,
    ),
  ).toBe(false);
  expect(
    matchesFilters([filter], { source: point }, { other: { ...point } }, data),
  ).toBe(true);
  expect(coerceFrontendValue(field, point, data, {})).toEqual(point);
  const legacy = { ...field };
  delete legacy.location;
  expect(coerceFrontendValue(legacy, "SYN-旧位置", data, {})).toBe(
    "SYN-旧位置",
  );
  expect(() => coerceFrontendValue(field, "伪造地址", data, {})).toThrow(
    "有效的定位对象",
  );
});

it("saves and submits structured positions through the real repository while retaining a published text-only V1", async () => {
  localStorage.clear();
  const store = useWorkspaceStore(createPinia());
  const created = (await store.createForm("oa", "SYN-定位保存验收", "form"))!;
  const form = store.openForm(created.id)!;
  const old = location();
  delete old.location;
  form.schema.fields = [old];
  expect(await store.publishForm(form.id)).toBeTruthy();
  const original = (await store.submitEntry(form.id, {
    position: "SYN-历史位置",
  }))!;
  expect(original.definitionVersion).toBe(1);
  const draftForm = store.openForm(form.id)!;
  draftForm.schema.fields = [location()];
  expect(await store.publishForm(form.id)).toBeTruthy();
  const draft = (await store.submitEntry(
    form.id,
    { position: point },
    "draft",
  ))!;
  expect(draft.definitionVersion).toBe(2);
  const submitted = (await store.submitEntry(
    form.id,
    { position: point },
    "submitted",
    draft.id,
  ))!;
  expect(submitted.id).toBe(draft.id);
  const cold = useWorkspaceStore(createPinia());
  await cold.refreshForRead();
  const records = cold.data.entries.filter((entry) => entry.formId === form.id);
  expect(records).toHaveLength(2);
  expect(
    records.find((entry) => entry.id === original.id)?.values.position,
  ).toBe("SYN-历史位置");
  expect(
    records.find((entry) => entry.id === draft.id)?.values.position,
  ).toEqual(point);
  expect(
    cold.data.forms.find((item) => item.id === form.id)!.versions[0]!.schema
      .fields[0]!.location,
  ).toBeUndefined();
});

it("keeps the existing position on permission failure, then retries with a structured device fix", async () => {
  const state = reactive({ value: "SYN-原位置" as unknown });
  mount(
    {
      setup: () => () =>
        h(LocationFieldControl, {
          field: location(),
          modelValue: state.value,
          "onUpdate:modelValue": (value: unknown) => (state.value = value),
        }),
    },
    {},
  );
  action().click();
  await settled();
  expect(action().textContent).toContain("正在定位");
  failure!({ code: 1 } as GeolocationPositionError);
  await settled();
  expect(document.body.textContent).toContain("未获得定位权限");
  expect(state.value).toBe("SYN-原位置");
  action().click();
  await settled();
  fix();
  await settled();
  expect(state.value).toMatchObject({
    lng: 120,
    lat: 30,
    coordinateSystem: "WGS84",
    accuracy: 7,
    origin: { lng: 120, lat: 30 },
  });
  expect(
    validateValues(
      { ...emptySchema(), fields: [location()] },
      { position: state.value },
    ),
  ).toEqual([]);
  expect(
    document.querySelector('input[placeholder="输入位置名称或坐标"]'),
  ).toBeNull();
});

it("ignores a pending device callback after permission/visibility changes or an external value update", async () => {
  const state = reactive({ disabled: false, value: point as unknown });
  const update = vi.fn();
  mount(
    {
      setup: () => () =>
        h(LocationFieldControl, {
          field: location(),
          disabled: state.disabled,
          modelValue: state.value,
          "onUpdate:modelValue": update,
        }),
    },
    {},
  );
  action().click();
  await settled();
  state.disabled = true;
  await settled();
  fix();
  await settled();
  expect(update).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain("SYN-验收仓库");
  state.disabled = false;
  await settled();
  action().click();
  await settled();
  state.value = "SYN-另页恢复的位置";
  await settled();
  fix();
  await settled();
  expect(update).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain("SYN-另页恢复的位置");
});

it("does not request location from design, read-only, mobile-only desktop or linked-default controls", async () => {
  for (const props of [
    { design: true },
    { readonly: true },
    { field: location("position", { location: emptyLocationSettings() }) },
    {
      field: location("position", {
        defaultLink: {
          enabled: true,
          formId: "source",
          fieldId: "f",
          filters: [],
          match: "all",
        },
      }),
    },
  ]) {
    mount(LocationFieldControl, {
      field: location(),
      modelValue: point,
      ...props,
    });
    action()?.click();
    await settled();
    expect(getCurrentPosition).not.toHaveBeenCalled();
    app!.unmount();
    app = undefined;
  }
});

it("runs an opted-in automatic default once and ignores its callback after unmount", async () => {
  const update = vi.fn(),
    field = location();
  field.location!.autoLocate = true;
  mount(LocationFieldControl, { field, "onUpdate:modelValue": update });
  await settled();
  expect(getCurrentPosition).toHaveBeenCalledOnce();
  app!.unmount();
  app = undefined;
  fix();
  await settled();
  expect(update).not.toHaveBeenCalled();
});

it("reports unsupported devices and timeout without inventing a usable address", async () => {
  const promise = deviceLocation();
  failure!({ code: 3 } as GeolocationPositionError);
  await expect(promise).rejects.toThrow("定位超时");
  vi.stubGlobal("navigator", { userAgent: "desktop", maxTouchPoints: 0 });
  await expect(deviceLocation()).rejects.toThrow("不支持定位");
});

it("keeps cancel available when the map is not enabled and cannot confirm an invented selection", async () => {
  const close = vi.fn(),
    select = vi.fn();
  await expect(loadLocationMap()).rejects.toThrow("地图服务尚未启用");
  mount(LocationPickerDialog, { open: true, onClose: close, onSelect: select });
  await settled();
  expect(document.querySelector('[role="alert"]')?.textContent).toContain(
    "地图服务尚未启用",
  );
  const buttons = Array.from(
    document.querySelectorAll<HTMLButtonElement>(".dialog-footer button"),
  );
  expect(
    buttons.find((button) => button.textContent?.trim() === "确定")?.disabled,
  ).toBe(true);
  buttons.find((button) => button.textContent?.trim() === "取消")!.click();
  await settled();
  expect(close).toHaveBeenCalledOnce();
  expect(select).not.toHaveBeenCalled();
});
