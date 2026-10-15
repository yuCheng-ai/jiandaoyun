import { seedWorkspace } from "./fixtures/workspace";
// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { createApp, h, nextTick, reactive } from "vue";
import { createPinia } from "pinia";
import {
  addressTypes,
  addressText,
  isAddressValue,
  separateFormSchema,
  composeFormSchema,
  type AddressValue,
} from "@platform/contracts";
import {
  createField,
  emptySchema,
  parseSchema,
  defaultValues,
  validateValues,
} from "../src/domain/form";
import {
  addressRegions,
  addressSelection,
  addressValueIssue,
} from "../src/domain/address";
import { displayValue } from "../src/domain/relations";
import { validateFieldConfiguration } from "../src/domain/fieldValidation";
import {
  formulaExpressionErrors,
  evaluateFieldFormula,
} from "@platform/contracts";

import AddressFieldControl from "../src/features/forms/components/AddressFieldControl.vue";
import FieldControl from "../src/features/forms/components/FieldControl.vue";

import BaseDialog from "../src/components/BaseDialog.vue";

let app: ReturnType<typeof createApp> | undefined;
const inertDescriptor = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "inert",
);
afterEach(() => {
  app?.unmount();
  document.body.innerHTML = "";
  localStorage.clear();
  vi.restoreAllMocks();
  if (inertDescriptor)
    Object.defineProperty(HTMLElement.prototype, "inert", inertDescriptor);
  else delete (HTMLElement.prototype as Partial<HTMLElement>).inert;
});
const settle = async () => {
  for (let i = 0; i < 5; i++) await nextTick();
};
const address: AddressValue = {
  province: "浙江省",
  city: "杭州市",
  district: "余杭区",
  detail: "演示仓库2号",
};
function mount(component: any, props: any) {
  document.body.innerHTML = '<div id="mount"></div>';
  app = createApp(component, props);
  app.use(createPinia());
  app.mount("#mount");
}
const button = (text: string) =>
  Array.from(
    document.querySelectorAll<HTMLButtonElement>(".address-panel button"),
  ).find((el) => el.textContent?.trim() === text)!;

it("accepts only address objects, excluding dates, collections and unrelated properties", () => {
  expect(isAddressValue({})).toBe(true);
  expect(isAddressValue(address)).toBe(true);
  for (const value of [
    new Date(),
    new Map(),
    new Set(),
    [],
    { latitude: 30 },
    { province: 12 },
  ])
    expect(isAddressValue(value)).toBe(false);
});

it("all four address types survive schema save, version projection and independent runtime defaults", () => {
  const fields = addressTypes.map((type) =>
    createField("address", {
      id: type.value,
      format: type.value,
      defaultValue: { ...address },
    }),
  );
  const schema = parseSchema({ ...emptySchema(), fields });
  const parts = separateFormSchema(schema),
    restored = composeFormSchema(parts.model, parts.page);
  expect(restored.fields.map((f) => [f.format, f.addressComplete])).toEqual(
    addressTypes.map((t) => [t.value, true]),
  );
  expect(defaultValues(restored.fields)).toEqual({
    province: { province: "浙江省" },
    city: { province: "浙江省", city: "杭州市" },
    district: { province: "浙江省", city: "杭州市", district: "余杭区" },
    detail: address,
  });
  const values = defaultValues(restored.fields);
  (values.detail as AddressValue).detail = "另一条记录";
  expect(schema.fields[3]!.defaultValue).toEqual(address);
  expect(defaultValues(restored.fields).detail).toEqual(address);
  expect(validateFieldConfiguration(restored, seedWorkspace())).toEqual([]);
});

it("empty optional addresses bypass completeness, while required, incomplete, malformed and cross-province values fail in their own rows", () => {
  const field = createField("address", { id: "a", label: "收货地址" });
  const schema = { ...emptySchema(), fields: [field] };
  expect(
    validateValues(schema, {
      a: { province: "", city: "", district: "", detail: "" },
    }),
  ).toEqual([]);
  expect(validateValues(schema, { a: address })).toEqual([]);
  expect(
    validateValues(schema, { a: { province: "浙江省" } })[0]!.message,
  ).toContain("完整填写");
  expect(
    validateValues(schema, { a: { ...address, city: "南京市" } })[0]!.message,
  ).toContain("重新选择市");
  expect(
    validateValues(schema, { a: { ...address, district: 12 } })[0]!.message,
  ).toContain("格式无效");
  field.required = true;
  expect(validateValues(schema, { a: {} })[0]!.message).toBe("请填写收货地址");
  field.format = "province";
  expect(
    validateValues(schema, {
      a: { province: "", city: "杭州市", detail: "已隐藏的旧内容" },
    })[0]!.message,
  ).toBe("请填写收货地址");
  field.format = "detail";
  field.required = false;
  field.addressComplete = false;
  expect(validateValues(schema, { a: { province: "浙江省" } })).toEqual([]);
  expect(
    validateValues(schema, {
      a: { province: "浙江省", city: "不存在的市" },
    })[0]!.message,
  ).toContain("重新选择市");
  const lines = {
    ...emptySchema(),
    fields: [
      createField("subform", {
        id: "lines",
        children: [{ ...field, addressComplete: true }],
      }),
    ],
  };
  expect(
    validateValues(lines, {
      lines: [{ a: address }, { a: { province: "浙江省" } }],
    })[0]!.path,
  ).toBe("lines.1.a");
});

it("legacy partial free-text values remain usable; current hierarchy covers municipalities, new Hangzhou districts and real province sources", () => {
  const legacy = createField("address", { id: "old", format: "none" });
  delete legacy.addressComplete;
  const restored = parseSchema({ ...emptySchema(), fields: [legacy] })
    .fields[0]!;
  expect(restored.addressComplete).toBeUndefined();
  expect(
    addressValueIssue(restored, {
      province: "浙江",
      city: "杭州",
      detail: "历史记录",
    }),
  ).toBeUndefined();
  expect(addressRegions).toHaveLength(34);
  const current = createField("address", { format: "district" });
  expect(
    addressValueIssue(current, {
      province: "北京市",
      city: "北京市",
      district: "海淀区",
    }),
  ).toBeUndefined();
  expect(
    addressValueIssue(current, {
      province: "浙江省",
      city: "杭州市",
      district: "钱塘区",
    }),
  ).toBeUndefined();
  expect(
    addressValueIssue(current, {
      province: "浙江",
      city: "杭州",
      district: "余杭",
    }),
  ).toBeUndefined();
  expect(
    addressValueIssue(current, {
      province: "浙江省",
      city: "杭州市",
      district: "海淀区",
    }),
  ).toContain("重新选择区");
});

it("changing a parent clears only downstream regions and preserves detail; revisiting an unchanged parent preserves its selection", () => {
  const field = createField("address");
  expect(addressSelection(field, address, "province", "江苏省")).toEqual({
    province: "江苏省",
    city: "",
    district: "",
    detail: address.detail,
  });
  expect(addressSelection(field, address, "city", "宁波市")).toEqual({
    ...address,
    city: "宁波市",
    district: "",
  });
  expect(addressSelection(field, address, "province", "浙江省")).toEqual(
    address,
  );
});

it("rejects invalid address defaults and mismatched district selections", () => {
  const field = createField("address", { id: "a" });
  expect(() =>
    parseSchema({
      ...emptySchema(),
      fields: [{ ...field, defaultValue: { district: 12 } }],
    }),
  ).toThrow("默认地址格式无效");
  expect(
    validateFieldConfiguration(
      {
        ...emptySchema(),
        fields: [
          { ...field, defaultValue: { province: "浙江省", city: "南京市" } },
        ],
      },
      seedWorkspace(),
    ).join(),
  ).toContain("默认请重新选择市");
  // A partial preset is allowed; the person filling the form completes it later.
  expect(
    validateFieldConfiguration(
      {
        ...emptySchema(),
        fields: [{ ...field, defaultValue: { province: "浙江省" } }],
      },
      seedWorkspace(),
    ),
  ).toEqual([]);
});

it("record labels and TEXTLOCATION use ordered address parts and respect field granularity", () => {
  const a = createField("address", { id: "a" }),
    text = createField("text", { id: "city" });
  expect(
    addressText({
      detail: "2号",
      district: "余杭区",
      city: "杭州市",
      province: "浙江省",
    }),
  ).toBe("浙江省杭州市余杭区2号");
  expect(
    addressText({ province: "北京市", city: "北京市", district: "海淀区" }),
  ).toBe("北京市海淀区");
  expect(
    addressText(
      { province: "北京市", city: "北京市", district: "海淀区" },
      "/",
    ),
  ).toBe("北京市/北京市/海淀区");
  expect(displayValue({ ...a, format: "city" }, address, seedWorkspace())).toBe(
    "浙江省杭州市",
  );
  for (const key of ["province", "city", "district", "detail", "address"]) {
    const formula = `TEXTLOCATION({{a}},"${key}")`;
    expect(
      formulaExpressionErrors(formula, [a, text], { targetId: "city" }),
    ).toEqual([]);
    expect(
      evaluateFieldFormula(
        formula,
        [a, text],
        { a: address },
        { targetId: "city" },
      ).value,
    ).toBe(
      key === "address"
        ? addressText(address)
        : address[key as keyof AddressValue],
    );
  }
  expect(
    evaluateFieldFormula('TEXTLOCATION({{a}},"city")', [a], { a: "" }).value,
  ).toBe("");
  expect(
    evaluateFieldFormula(
      'TEXTLOCATION({{a}},"district")',
      [{ ...a, format: "city" }],
      { a: address },
    ).value,
  ).toBe("");
  expect(
    evaluateFieldFormula('TEXTLOCATION({{a}},"lng")', [a], { a: address })
      .error,
  ).toContain("地址格式");
});

it("the shared control cascades, searches and preserves detail; changing field type or disabling closes its popup", async () => {
  Element.prototype.scrollIntoView = vi.fn();
  const state = reactive({
    field: createField("address"),
    value: {} as AddressValue,
    disabled: false,
  });
  mount(
    {
      render: () =>
        h(AddressFieldControl, {
          field: state.field,
          modelValue: state.value,
          label: "收货地址",
          disabled: state.disabled,
          "onUpdate:modelValue": (v: AddressValue) => (state.value = v),
        }),
    },
    {},
  );
  await settle();
  document.querySelector<HTMLButtonElement>(".address-trigger")!.click();
  await settle();
  button("浙江省").click();
  await settle();
  button("杭州市").click();
  await settle();
  button("余杭区").click();
  await settle();
  expect(state.value).toMatchObject({
    province: "浙江省",
    city: "杭州市",
    district: "余杭区",
  });
  expect(document.querySelector(".address-panel")).toBeNull();
  const detail =
    document.querySelector<HTMLTextAreaElement>(".address-detail")!;
  detail.value = "演示2号";
  detail.dispatchEvent(new Event("input"));
  await settle();
  document.querySelector<HTMLButtonElement>(".address-trigger")!.click();
  await settle();
  const search = document.querySelector<HTMLInputElement>(
    ".address-search input",
  )!;
  for (const text of ["江苏省无锡市锡山区", "江苏省/无锡市/锡山区"]) {
    search.value = text;
    search.dispatchEvent(new Event("input"));
    await settle();
    expect(button("江苏省/无锡市/锡山区")).toBeTruthy();
  }
  search.value = "江苏 无锡 锡山";
  search.dispatchEvent(new Event("input"));
  await settle();
  button("江苏省/无锡市/锡山区").click();
  await settle();
  expect(state.value).toEqual({
    province: "江苏省",
    city: "无锡市",
    district: "锡山区",
    detail: "演示2号",
  });
  document.querySelector<HTMLButtonElement>(".address-trigger")!.click();
  await settle();
  state.field.format = "province";
  await settle();
  expect(document.querySelector(".address-panel")).toBeNull();
  expect(document.querySelector(".address-detail")).toBeNull();
  document.querySelector<HTMLButtonElement>(".address-trigger")!.click();
  await settle();
  state.disabled = true;
  await settle();
  expect(document.querySelector(".address-panel")).toBeNull();
  expect(
    document.querySelector<HTMLButtonElement>(".address-trigger")!.disabled,
  ).toBe(true);
});

it("Escape closes only the address popup inside a shared dialog and restores focus to its trigger", async () => {
  Element.prototype.scrollIntoView = vi.fn();
  // jsdom lacks native inert reflection and layout; model the visible dialog controls.
  Object.defineProperty(HTMLElement.prototype, "inert", {
    configurable: true,
    get() {
      return this.hasAttribute("inert");
    },
    set(value) {
      this.toggleAttribute("inert", !!value);
    },
  });
  vi.spyOn(Element.prototype, "getClientRects").mockReturnValue([
    {},
  ] as unknown as DOMRectList);
  const parent = reactive({ open: true });
  mount(
    {
      render: () =>
        h(
          BaseDialog,
          {
            open: parent.open,
            title: "填报",
            onClose: () => (parent.open = false),
          },
          {
            default: () =>
              h(FieldControl, {
                field: createField("address"),
                modelValue: address,
                label: "收货地址",
              }),
          },
        ),
    },
    {},
  );
  await settle();
  const trigger =
    document.querySelector<HTMLButtonElement>(".address-trigger")!;
  trigger.focus();
  trigger.click();
  await settle();
  document.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
  );
  await settle();
  expect(document.querySelector(".address-panel")).toBeNull();
  expect(parent.open).toBe(true);
  expect(document.activeElement).toBe(trigger);
});
