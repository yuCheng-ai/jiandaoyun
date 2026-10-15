import { seedWorkspace } from "./fixtures/workspace";
// @vitest-environment jsdom
// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApp, h, nextTick, reactive, shallowRef } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { createMemoryHistory, createRouter } from "vue-router";
import {
  separateFormSchema,
  composeFormSchema,
  type FormValidationRule,
} from "@platform/contracts";
import {
  createField,
  emptySchema,
  parseSchema,
  resolveCalculations,
} from "../src/domain/form";
import {
  formValidationErrors,
  formValidationResults,
  blockingFormValidation,
  changedValidationRules,
  validationReferences,
  formulaLabel,
} from "../src/domain/formValidation";
import { validateFieldConfiguration } from "../src/domain/fieldValidation";
import { runtimeDefaults } from "../src/domain/relations";
import { memberSchema } from "../src/domain/access";
import { newForm } from "../src/domain/workspace";
import { useFormDesigner } from "../src/features/forms/useFormDesigner";

import FormRuntime from "../src/features/forms/components/FormRuntime.vue";

let pinia = createPinia();
const cleanup: (() => void)[] = [];
const inertDescriptor = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "inert",
);
beforeEach(() => {
  // jsdom lacks the native boolean property; model its attribute semantics for focus restoration.
  if (!inertDescriptor)
    Object.defineProperty(HTMLElement.prototype, "inert", {
      configurable: true,
      get() {
        return this.hasAttribute("inert");
      },
      set(value: boolean) {
        this.toggleAttribute("inert", value);
      },
    });
  localStorage.clear();
  sessionStorage.clear();
  pinia = createPinia();
  setActivePinia(pinia);
});
afterEach(() => {
  cleanup.splice(0).forEach((fn) => fn());
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  if (!inertDescriptor)
    delete (HTMLElement.prototype as { inert?: boolean }).inert;
});
const rule = (patch: Partial<FormValidationRule> = {}): FormValidationRule => ({
  id: "budget-check",
  expression: "{{quantity}} * {{price}} <= {{budget}}",
  message: "采购金额不能超过预算：{{budget}}",
  realtime: true,
  mode: "block",
  ...patch,
});
function fixture() {
  const schema = emptySchema();
  schema.fields = [
    createField("number", { id: "quantity", label: "数量", defaultValue: 2 }),
    createField("number", { id: "price", label: "单价", defaultValue: 10 }),
    createField("number", { id: "budget", label: "预算", defaultValue: 100 }),
    createField("text", { id: "note", label: "说明" }),
  ];
  schema.settings.validations = [rule()];
  return schema;
}
async function mount(component: any, props: Record<string, unknown>) {
  const host = document.createElement("div");
  document.body.append(host);
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: "/", component: { render: () => null } }],
  });
  await router.push("/");
  await router.isReady();
  const app = createApp({ render: () => h(component, props) });
  app.use(pinia);
  app.use(router);
  app.mount(host);
  cleanup.push(() => app.unmount());
  await nextTick();
  return host;
}
const button = (root: ParentNode, label: string) =>
  Array.from(root.querySelectorAll<HTMLButtonElement>("button")).find(
    (el) =>
      el.getAttribute("aria-label") === label ||
      el.textContent?.trim() === label,
  )!;
async function edit(root: ParentNode, selector: string, text: string) {
  const el = root.querySelector<HTMLElement>(selector)!;
  if (el instanceof HTMLInputElement) el.value = text;
  else el.textContent = text;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  await nextTick();
}
async function click(root: ParentNode, label: string) {
  button(root, label).click();
  await nextTick();
}

it("checks a purchase against its budget and preserves stable references through rename and page projection", () => {
  const schema = fixture(),
    values = runtimeDefaults(schema.fields, seedWorkspace());
  expect(formValidationResults(schema, values)).toEqual([]);
  expect(
    blockingFormValidation(
      schema,
      { ...values, quantity: 12 },
      { data: seedWorkspace() },
    ),
  ).toEqual(["采购金额不能超过预算：100"]);
  schema.fields[2]!.label = "部门预算";
  const restored = parseSchema(JSON.parse(JSON.stringify(schema)));
  expect(formulaLabel(rule().expression, restored.fields)).toBe(
    "数量 * 单价 <= 部门预算",
  );
  expect(restored.settings.validations).toEqual(schema.settings.validations);
  const split = separateFormSchema(restored);
  expect(
    composeFormSchema(split.model, split.page).settings.validations,
  ).toEqual(schema.settings.validations);
});
it("rejects invalid numeric/date inputs and failed conditions even when the rule allows warnings", () => {
  const schema = fixture();
  schema.settings.validations![0]!.mode = "warn";
  expect(
    formValidationResults(schema, {
      quantity: "bad",
      price: 10,
      budget: 100,
    })[0]?.mode,
  ).toBe("block");
  schema.settings.validations![0]!.expression = "{{quantity}} / {{price}} > 0";
  expect(
    formValidationResults(schema, { quantity: 2, price: 0 })[0]?.message,
  ).toContain("校验未完成");
  schema.fields.push(
    createField("datetime", { id: "arrival", format: "date" }),
  );
  schema.settings.validations![0]!.expression =
    "DAYS({{arrival}},DATE(2026,10,9)) >= 3";
  expect(
    formValidationResults(schema, { arrival: "2026-02-30" })[0]?.mode,
  ).toBe("block");
  expect(formValidationResults(schema, { arrival: "2026-10-12" })).toEqual([]);
});
it("uses option labels and detail arrays in whole-form conditions without introducing helper fields", () => {
  const schema = fixture();
  const choices = createField("select", {
    id: "kind",
    options: [{ id: "a", label: "无需预算" }],
  });
  const rows = createField("subform", {
    id: "lines",
    children: [
      createField("number", { id: "amount", label: "金额" }),
      createField("text", { id: "item", label: "物料" }),
    ],
  });
  schema.fields.push(choices, rows);
  schema.settings.validations = [
    rule({
      expression:
        'IF({{kind}} == "无需预算",TRUE(),SUM({{amount}}) <= {{budget}})',
    }),
  ];
  expect(
    formValidationResults(schema, {
      kind: "a",
      budget: 0,
      lines: [{ amount: 100 }],
    }),
  ).toEqual([]);
  expect(
    blockingFormValidation(schema, {
      kind: "",
      budget: 50,
      lines: [{ amount: 30 }, { amount: 30 }],
    }),
  ).toHaveLength(1);
  expect(
    formValidationResults(schema, {
      budget: 50,
      lines: [{ amount: 20 }, { amount: 30 }],
    }),
  ).toEqual([]);
  const before = { budget: 50, lines: [{ item: "A", amount: 30 }] };
  expect(
    changedValidationRules(schema, before, {
      ...before,
      lines: [{ item: "B", amount: 30 }],
    }),
  ).toEqual([]);
  expect(
    changedValidationRules(schema, before, {
      ...before,
      lines: [{ item: "A", amount: 60 }],
    }),
  ).toEqual(["budget-check"]);
});
it("does not turn a failed calculation into a passing zero; unused IF branches remain lazy", () => {
  const schema = fixture();
  schema.fields.push(
    createField("calculated", {
      id: "ratio",
      expression: "{{quantity}} / {{price}}",
    }),
  );
  schema.settings.validations = [
    rule({ expression: "{{ratio}} == 0", mode: "warn" }),
  ];
  const values = resolveCalculations(schema.fields, {
    quantity: 2,
    price: 0,
    budget: 100,
  });
  expect(values.ratio).toBeNull();
  expect(formValidationResults(schema, values)[0]?.mode).toBe("block");
  schema.settings.validations[0]!.expression =
    "IF({{price}} == 0,TRUE(),{{ratio}} > 0)";
  expect(formValidationResults(schema, values)).toEqual([]);
});
it("retains deleted references for correction and restoration instead of silently removing validation", async () => {
  const form = newForm("oa", "采购"),
    schema = fixture();
  form.schema = schema;
  let designer!: ReturnType<typeof useFormDesigner>;
  await mount(
    {
      setup() {
        designer = useFormDesigner(shallowRef(form));
        return () => null;
      },
    },
    {},
  );
  designer.remove(["budget"]);
  expect(form.schema.settings.validations).toEqual([rule()]);
  expect(
    validateFieldConfiguration(form.schema, seedWorkspace()).some(
      (message) => message.includes("数据校验") && message.includes("失效"),
    ),
  ).toBe(true);
  expect(validationReferences(rule())).toContain("budget");
  expect(
    formValidationResults(form.schema, { quantity: 2, price: 10 })[0]?.mode,
  ).toBe("block");
  expect(designer.restore(0)).toBe(true);
  expect(formValidationErrors(rule(), form.schema.fields)).toEqual([]);
});
it("requires boolean conditions, meaningful messages and valid message references", () => {
  const schema = fixture();
  for (const invalid of [
    "invalid",
    [rule(), rule()],
    [{ ...rule(), id: "" }],
    [{ ...rule(), realtime: "yes" }],
    [{ ...rule(), message: {} }],
  ]) {
    expect(() =>
      parseSchema({
        ...schema,
        settings: { ...schema.settings, validations: invalid },
      }),
    ).toThrow("数据校验设置不合法");
  }
  expect(
    formValidationErrors(
      rule({ message: "预算说明".repeat(300) }),
      schema.fields,
    ),
  ).toEqual([]);
  expect(
    formValidationErrors(
      rule({ expression: "{{quantity}} * {{price}}" }),
      schema.fields,
    )[0],
  ).toContain("真或假");
  expect(
    formValidationErrors(
      rule({ expression: 'IF({{quantity}}>0,TRUE(),"false")' }),
      schema.fields,
    )[0],
  ).toContain("真或假");
  expect(formValidationErrors(rule({ message: " " }), schema.fields)).toContain(
    "请填写不满足校验条件时的提示文字",
  );
  expect(
    formValidationErrors(rule({ message: "{{missing}}" }), schema.fields),
  ).toContain("提示文字引用的字段已失效");
  expect(
    formValidationErrors(rule({ expression: "alert(1)" }), schema.fields)[0],
  ).toContain("不支持的函数");
});
it("masks a protected value in the failure message while checking the full merged record", () => {
  const schema = fixture(),
    protectedSchema = memberSchema(
      schema,
      [
        {
          id: "g",
          enabled: true,
          archived: false,
          name: "填写人",
          identities: [],
          actions: ["edit"],
          scope: "all",
          filters: [],
          fields: {
            quantity: "edit",
            price: "read",
            budget: "hidden",
            note: "edit",
          },
        },
      ],
      true,
    );
  expect(protectedSchema.settings.validations).toEqual([]);
  expect(
    blockingFormValidation(
      schema,
      { quantity: 12, price: 10, budget: 100 },
      { data: seedWorkspace(), displaySchema: protectedSchema },
    ),
  ).toEqual(["采购金额不能超过预算：—"]);
});
it("shows realtime preview errors only for referenced changes and clears them on repair", async () => {
  const schema = fixture(),
    host = await mount(FormRuntime, {
      schema,
      formId: "purchase",
    });
  expect(host.querySelector(".form-validation-issues")).toBeNull();
  await edit(host, '[data-field-id="note"] input', "无关备注");
  expect(host.querySelector(".form-validation-issues")).toBeNull();
  await edit(host, '[data-field-id="quantity"] input', "12");
  expect(host.querySelector(".form-validation-issues")?.textContent).toContain(
    "不能超过预算",
  );
  await click(host, "提交");

  await edit(host, '[data-field-id="quantity"] input', "3");
  expect(host.querySelector(".form-validation-issues")).toBeNull();
  await click(host, "提交");
  await nextTick();
});
it("requires a deliberate warning confirmation during preview validation", async () => {
  const schema = fixture();
  schema.settings.validations = [
    rule({
      expression: "{{quantity}} <= 10",
      message: "请确认大批采购数量",
      mode: "warn",
      realtime: false,
    }),
  ];
  const host = await mount(FormRuntime, {
    schema,
    formId: "purchase",
  });
  await edit(host, '[data-field-id="quantity"] input', "12");
  expect(host.querySelector(".form-validation-issues")).toBeNull();

  await click(host, "提交");

  let dialog = document.querySelector('dialog[aria-label="提交提示"]')!;
  expect(dialog.textContent).toContain("请确认大批采购数量");
  await click(dialog, "返回修改");

  await click(host, "提交");
  dialog = document.querySelector('dialog[aria-label="提交提示"]')!;
  await click(dialog, "忽略并继续提交");
  await nextTick();
});
it("rechecks current values and blocking rules when an earlier warning is confirmed", async () => {
  const schema = reactive(fixture());
  schema.fields[0]!.defaultValue = 12;
  schema.fields[1]!.defaultValue = 5;
  schema.settings.validations!.push(
    rule({
      id: "warning",
      expression: "{{quantity}}<=10",
      message: "大批采购",
      mode: "warn",
      realtime: false,
    }),
  );
  const host = await mount(FormRuntime, {
    schema,
    formId: "purchase",
  });
  await click(host, "提交");
  const dialog = document.querySelector('dialog[aria-label="提交提示"]')!;
  schema.settings.validations![0]!.expression =
    "{{quantity}} * {{price}} <= {{budget}}/2";
  await click(dialog, "忽略并继续提交");

  expect(host.querySelector(".form-validation-issues")?.textContent).toContain(
    "采购金额不能超过预算",
  );
});
