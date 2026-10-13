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
  copy,
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
import {
  defaultAccess,
  memberSchema,
  newAccessGroup,
} from "../src/domain/access";
import { newForm, seedWorkspace } from "../src/domain/workspace";
import { useFormDesigner } from "../src/features/forms/useFormDesigner";
import { useWorkspaceStore } from "../src/stores/workspace";
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
it("shows realtime errors only for referenced changes, clears them on repair and blocks invalid persistence", async () => {
  const schema = fixture(),
    persist = vi.fn().mockResolvedValue(true),
    host = await mount(FormRuntime, {
      schema,
      formId: "purchase",
      preview: false,
      persistValues: persist,
    });
  expect(host.querySelector(".form-validation-issues")).toBeNull();
  await edit(host, '[data-field-id="note"] input', "无关备注");
  expect(host.querySelector(".form-validation-issues")).toBeNull();
  await edit(host, '[data-field-id="quantity"] input', "12");
  expect(host.querySelector(".form-validation-issues")?.textContent).toContain(
    "不能超过预算",
  );
  await click(host, "提交");
  expect(persist).not.toHaveBeenCalled();
  await edit(host, '[data-field-id="quantity"] input', "3");
  expect(host.querySelector(".form-validation-issues")).toBeNull();
  await click(host, "提交");
  await nextTick();
  expect(persist).toHaveBeenCalledWith(
    expect.objectContaining({ quantity: 3, price: 10 }),
    false,
  );
});
it("allows incomplete drafts and requires a deliberate warning confirmation before submission", async () => {
  const schema = fixture();
  schema.settings.validations = [
    rule({
      expression: "{{quantity}} <= 10",
      message: "请确认大批采购数量",
      mode: "warn",
      realtime: false,
    }),
  ];
  const persist = vi.fn().mockResolvedValue(true),
    host = await mount(FormRuntime, {
      schema,
      formId: "purchase",
      preview: false,
      persistValues: persist,
    });
  await edit(host, '[data-field-id="quantity"] input', "12");
  expect(host.querySelector(".form-validation-issues")).toBeNull();
  await click(host, "保存草稿");
  expect(persist).toHaveBeenCalledWith(
    expect.objectContaining({ quantity: 12 }),
    true,
  );
  persist.mockClear();
  await click(host, "提交");
  expect(persist).not.toHaveBeenCalled();
  let dialog = document.querySelector('dialog[aria-label="提交提示"]')!;
  expect(dialog.textContent).toContain("请确认大批采购数量");
  await click(dialog, "返回修改");
  expect(persist).not.toHaveBeenCalled();
  await click(host, "提交");
  dialog = document.querySelector('dialog[aria-label="提交提示"]')!;
  await click(dialog, "忽略并继续提交");
  await nextTick();
  expect(persist).toHaveBeenCalledTimes(1);
  expect(persist).toHaveBeenCalledWith(
    expect.objectContaining({ quantity: 12 }),
    false,
  );
});
it("rechecks current values and blocking rules when an earlier warning is confirmed", async () => {
  const schema = reactive(fixture());
  schema.settings.validations!.push(
    rule({
      id: "warning",
      expression: "{{quantity}}<=10",
      message: "大批采购",
      mode: "warn",
      realtime: false,
    }),
  );
  const persist = vi.fn().mockResolvedValue(true),
    host = await mount(FormRuntime, {
      schema,
      formId: "purchase",
      preview: false,
      initialValues: { quantity: 12, price: 5, budget: 100 },
      persistValues: persist,
    });
  await click(host, "提交");
  const dialog = document.querySelector('dialog[aria-label="提交提示"]')!;
  schema.settings.validations![0]!.expression =
    "{{quantity}} * {{price}} <= {{budget}}/2";
  await click(dialog, "忽略并继续提交");
  expect(persist).not.toHaveBeenCalled();
  expect(host.querySelector(".form-validation-issues")?.textContent).toContain(
    "采购金额不能超过预算",
  );
});
it("keeps immutable published checks and old-record editing while blocking direct invalid writes atomically", async () => {
  const store = useWorkspaceStore(),
    created = (await store.createForm("oa", "校验验收", "form"))!,
    form = store.openForm(created.id)!;
  form.schema = fixture();
  expect(await store.publishForm(form.id)).toBe(true);
  const before = copy(store.data.entries),
    logs = copy(store.data.extensionRuns || []);
  expect(
    await store.submitEntry(form.id, { quantity: 12, price: 10, budget: 100 }),
  ).toBeUndefined();
  expect(store.data.entries).toEqual(before);
  expect(store.data.extensionRuns || []).toEqual(logs);
  const record = (await store.submitEntry(form.id, {
    quantity: 3,
    price: 20,
    budget: 100,
  }))!;
  expect(record.definitionVersion).toBe(1);
  form.schema.settings.validations![0]!.expression =
    "{{quantity}} * {{price}} <= {{budget}}/2";
  expect(await store.publishForm(form.id)).toBe(true);
  expect(
    store.data.forms.find((item) => item.id === form.id)!.versions[0]!.schema
      .settings.validations![0]!.expression,
  ).toBe(rule().expression);
  expect(
    await store.submitEntry(form.id, { quantity: 3, price: 20, budget: 100 }),
  ).toBeUndefined();
  expect(
    await store.updateEntry(record.id, { quantity: 3, price: 25, budget: 100 }),
  ).toBe(true);
  const saved = copy(
    store.data.entries.find((entry) => entry.id === record.id)!,
  );
  expect(saved.definitionVersion).toBe(1);
  expect(saved.values.price).toBe(25);
  expect(
    await store.updateEntry(record.id, { quantity: 6, price: 25, budget: 100 }),
  ).toBe(false);
  expect(store.data.entries.find((entry) => entry.id === record.id)).toEqual(
    saved,
  );
  const reloaded = parseSchema(JSON.parse(JSON.stringify(form.schema)));
  expect(reloaded.settings.validations![0]!.expression).toContain("/2");
});
it("retains an invalid fill draft and applies its pinned rules again on final submission", async () => {
  const store = useWorkspaceStore(),
    created = (await store.createForm("oa", "填写草稿", "form"))!,
    form = store.openForm(created.id)!;
  form.schema = fixture();
  await store.publishForm(form.id);
  const draft = (await store.submitEntry(
    form.id,
    { quantity: 12, price: 10, budget: 100 },
    "draft",
  ))!;
  expect(draft.status).toBe("draft");
  const before = copy(
    store.data.entries.find((entry) => entry.id === draft.id),
  );
  expect(
    await store.submitEntry(form.id, draft.values, "submitted", draft.id),
  ).toBeUndefined();
  expect(store.data.entries.find((entry) => entry.id === draft.id)).toEqual(
    before,
  );
});
it("rechecks member edits against protected stored values without revealing them or persisting a failed edit", async () => {
  const store = useWorkspaceStore();
  const created = (await store.createForm("oa", "受限采购校验", "form"))!;
  const form = store.openForm(created.id)!;
  form.schema = fixture();
  expect(await store.publishForm(form.id)).toBe(true);
  const entry = (await store.submitEntry(form.id, {
    quantity: 3,
    price: 20,
    budget: 100,
  }))!;
  const group = newAccessGroup(form.schema, "manage");
  group.identities = ["zhang"];
  group.fields.price = "read";
  group.fields.budget = "hidden";
  expect(
    await store.saveFormAccess(form.id, {
      ...defaultAccess(),
      membersEnabled: true,
      groups: [group],
    }),
  ).toBe(true);
  const before = copy(store.data.entries.find((item) => item.id === entry.id)!);
  expect(
    await store.memberUpdate(
      entry.id,
      "zhang",
      group.id,
      { quantity: 9, price: 0, budget: 999 },
      before.values,
    ),
  ).toBe(false);
  expect(store.data.entries.find((item) => item.id === entry.id)).toEqual(
    before,
  );
  expect(store.notices.at(-1)?.message).toBe("采购金额不能超过预算：—");
  expect(
    await store.memberUpdate(
      entry.id,
      "zhang",
      group.id,
      { quantity: 4, price: 0, budget: 999 },
      before.values,
    ),
  ).toBe(true);
  expect(
    store.data.entries.find((item) => item.id === entry.id)?.values,
  ).toMatchObject({ quantity: 4, price: 20, budget: 100 });
});
