// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { createApp, h, nextTick, reactive } from "vue";
import { createPinia } from "pinia";
import {
  copy,
  createField,
  emptySchema,
  parseSchema,
  resolveCalculations,
} from "../src/domain/form";
import {
  evaluateFieldFormula,
  formulaConfigurationErrors,
  formulaExpressionErrors,
  formulaFunctions,
  formulaValue,
} from "../src/domain/formula";
import { applyFieldChange, runtimeDefaults } from "../src/domain/relations";
import { validateFieldConfiguration } from "../src/domain/fieldValidation";
import { seedWorkspace } from "../src/domain/workspace";
import { useWorkspaceStore } from "../src/stores/workspace";
import FormulaEditor from "../src/features/forms/components/FormulaEditor.vue";

const phone = createField("phone", { id: "contact", label: "联系电话" });
const number = createField("text", {
  id: "phoneText",
  label: "号码文本",
  defaultFormula: true,
  expression: 'TEXTPHONE({{contact}},"phone")',
});
const status = createField("number", {
  id: "verified",
  label: "验证状态",
  defaultFormula: true,
  expression: 'TEXTPHONE({{contact}},"verified")',
});
const fields = [phone, number, status];
let app: ReturnType<typeof createApp> | undefined;
afterEach(() => {
  app?.unmount();
  app = undefined;
  document.body.innerHTML = "";
  localStorage.clear();
});

it("exposes phone extraction in the advanced catalogue and keeps the number as text", () => {
  expect(formulaFunctions.find((f) => f.name === "TEXTPHONE")?.group).toBe(
    "高级函数",
  );
  expect(formulaConfigurationErrors(number, fields)).toEqual([]);
  expect(formulaValue(number, fields, { contact: "13800000002" })).toEqual({
    value: "13800000002",
    error: "",
  });
  expect(formulaValue(number, fields, {})).toEqual({ value: "", error: "" });
  expect(
    formulaValue(
      { ...number, expression: 'RIGHT(TEXTPHONE({{contact}},"phone"),4)' },
      fields,
      { contact: "13800000002" },
    ).value,
  ).toBe("0002");
});

it("returns an unverified numeric status without claiming format validity is SMS verification", () => {
  expect(formulaConfigurationErrors(status, fields)).toEqual([]);
  for (const contact of [undefined, "", "13800000002", "not-a-phone"])
    expect(formulaValue(status, fields, { contact })).toEqual({
      value: 0,
      error: "",
    });
  expect(
    evaluateFieldFormula('TEXTPHONE({{contact}},"verified")==0', fields, {
      contact: "13800000002",
    }),
  ).toEqual({ value: true, error: "" });
  expect(
    formulaConfigurationErrors(
      { ...status, expression: number.expression },
      fields,
    ),
  ).toContain("公式需要返回数字");
});

it("rejects wrong arguments and text lookalikes in configuration and actual evaluation", () => {
  const text = createField("text", { id: "lookalike" });
  for (const expression of [
    'TEXTPHONE({{contact}},"unknown")',
    "TEXTPHONE({{contact}})",
    'TEXTPHONE({{contact}},"phone",1)',
    'TEXTPHONE({{lookalike}},"phone")',
    'CONCATENATE("结果：",TEXTPHONE({{lookalike}},"phone"))',
    'TEXTPHONE("13800000002","phone")',
    'TEXTPHONE({{missing}},"phone")',
  ]) {
    expect(
      formulaExpressionErrors(expression, [...fields, text]).length,
    ).toBeGreaterThan(0);
    expect(
      evaluateFieldFormula(expression, [...fields, text], {
        contact: "13800000002",
        lookalike: "13800000002",
      }).error,
    ).not.toBe("");
  }
  for (const contact of [
    { phone: "13800000002", verified: true },
    13800000002,
    ["13800000002"],
  ])
    expect(formulaValue(status, fields, { contact }).error).not.toBe("");
});

it("accepts conditional phone sources and dynamic selectors while retaining legacy direct phone text", () => {
  const second = createField("phone", { id: "second" });
  const selector = createField("text", { id: "selector" });
  const expression =
    'TEXTPHONE(IF({{selector}}=="primary",{{contact}},{{second}}),"phone")';
  const available = [...fields, second, selector];
  expect(formulaExpressionErrors(expression, available)).toEqual([]);
  expect(
    evaluateFieldFormula(expression, available, {
      selector: "backup",
      contact: "13800000002",
      second: "13900000003",
    }),
  ).toEqual({ value: "13900000003", error: "" });
  expect(
    evaluateFieldFormula("TEXTPHONE({{contact}},{{selector}})", available, {
      selector: "verified",
      contact: "13800000002",
    }),
  ).toEqual({ value: 0, error: "" });
  expect(
    evaluateFieldFormula('CONCATENATE({{contact}},"-旧公式")', available, {
      contact: "13800000002",
    }),
  ).toEqual({ value: "13800000002-旧公式", error: "" });
});

it("does not add recursive phone checks to unrelated long numeric formulas", () => {
  const expression = Array.from(
    { length: 1000 },
    () => "1+1+1+1+1+1+1+1+1",
  ).join("+\n");
  expect(
    formulaExpressionErrors(expression, [], { returns: "number" }),
  ).toEqual([]);
});

it("recomputes phone defaults and their dependencies through the shared initialization and edit paths", () => {
  const label = createField("text", {
    id: "tag",
    defaultFormula: true,
    expression:
      'CONCATENATE({{phoneText}},"/",IF({{verified}}==0,"未验证","已验证"))',
  });
  const available = [label, status, number, phone];
  const start = resolveCalculations(
    available,
    {
      contact: "13800000002",
      phoneText: "伪造号码",
      verified: 1,
    },
    {},
    { defaults: ["phoneText", "verified", "tag"] },
  );
  expect(start.phoneText).toBe("13800000002");
  expect(start.verified).toBe(0);
  expect(start.tag).toBe("13800000002/未验证");
  const edited = applyFieldChange(
    available,
    start,
    "contact",
    "13900000003",
    seedWorkspace(),
  );
  expect(edited.phoneText).toBe("13900000003");
  expect(edited.tag).toBe("13900000003/未验证");
  expect(
    parseSchema({ ...emptySchema(), fields: copy(available) }).fields,
  ).toEqual(available);
});

it("finds the function in the existing editor and debugs the actual phone sample", async () => {
  const field = reactive(copy(number));
  const schema = reactive({
    ...emptySchema(),
    fields: [copy(phone), field, copy(status)],
  });
  const updates: unknown[] = [];
  document.body.innerHTML = '<div id="mount"></div>';
  app = createApp(() =>
    h(FormulaEditor, {
      field,
      schema,
      onUpdate: (patch) => {
        updates.push(patch);
        Object.assign(field, patch);
      },
    }),
  );
  app.use(createPinia());
  app.mount("#mount");
  const button = (name: string) =>
    Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
      (b) => b.textContent?.trim() === name,
    )!;
  button("编辑公式").click();
  await nextTick();
  const search = document.querySelector<HTMLInputElement>(
    '[aria-label="搜索函数"]',
  )!;
  search.value = "TEXTPHONE";
  search.dispatchEvent(new Event("input", { bubbles: true }));
  await nextTick();
  expect(
    Array.from(document.querySelectorAll("summary")).map((s) => s.textContent),
  ).toEqual(["高级函数"]);
  button("调试").click();
  await nextTick();
  const sample = document.querySelector<HTMLInputElement>(
    '[aria-label="调试 联系电话"]',
  )!;
  sample.value = "13800000002";
  sample.dispatchEvent(new Event("input", { bubbles: true }));
  await nextTick();
  expect(
    document.querySelector(".formula-trial")?.textContent ||
      document.body.textContent,
  ).toContain("13800000002");
  button("确定").click();
  await nextTick();
  expect(updates).toContainEqual(
    expect.objectContaining({ expression: number.expression }),
  );
});

it("preserves old publications and recomputes new same-ID submissions and edits through the real workspace repository", async () => {
  localStorage.clear();
  const store = useWorkspaceStore(createPinia());
  const created = (await store.createForm("oa", "SYN-手机公式验收", "form"))!;
  const form = store.openForm(created.id)!;
  form.schema.fields = [copy(phone)];
  expect(await store.publishForm(form.id)).toBeTruthy();
  const old = (await store.submitEntry(form.id, { contact: "13800000001" }))!;
  expect(old.definitionVersion).toBe(1);
  const original = copy(
    store.data.forms.find((f) => f.id === form.id)!.published!,
  );
  const design = store.openForm(form.id)!;
  design.schema.fields = copy(fields);
  expect(validateFieldConfiguration(design.schema, store.data)).toEqual([]);
  expect(await store.saveForm(form.id)).toBeTruthy();
  expect(await store.publishForm(form.id)).toBeTruthy();
  const input = applyFieldChange(
    fields,
    runtimeDefaults(fields, store.data),
    "contact",
    "13800000002",
    store.data,
  );
  const draft = (await store.submitEntry(form.id, input, "draft"))!;
  const submitted = (await store.submitEntry(
    form.id,
    draft.values,
    "submitted",
    draft.id,
  ))!;
  expect(submitted.id).toBe(draft.id);
  expect(submitted.values).toMatchObject({
    contact: "13800000002",
    phoneText: "13800000002",
    verified: 0,
  });
  const edit = applyFieldChange(
    fields,
    submitted.values,
    "contact",
    "13900000003",
    store.data,
  );
  expect(await store.updateEntry(submitted.id, edit)).toBe(true);
  const edited = store.data.entries.find((e) => e.id === submitted.id)!;
  expect(edited.id).toBe(submitted.id);
  expect(edited.values).toMatchObject({
    phoneText: "13900000003",
    verified: 0,
  });
  const reloaded = useWorkspaceStore(createPinia());
  await reloaded.refreshForRead();
  expect(
    reloaded.data.forms.find((f) => f.id === form.id)!.versions[0],
  ).toEqual(original);
  const records = reloaded.data.entries.filter((e) => e.formId === form.id);
  expect(records).toHaveLength(2);
  expect(records.find((e) => e.id === old.id)!.values).toEqual({
    contact: "13800000001",
  });
  expect(records.find((e) => e.id === submitted.id)!.values).toMatchObject({
    contact: "13900000003",
    phoneText: "13900000003",
    verified: 0,
  });
});
