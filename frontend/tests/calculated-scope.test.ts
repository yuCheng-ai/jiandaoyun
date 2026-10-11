// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it } from "vitest";
import { createApp, h, nextTick, reactive } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { createMemoryHistory, createRouter } from "vue-router";
import {
  copy,
  createField,
  emptySchema,
  parseSchema,
  resolveCalculations,
} from "../src/domain/form";
import {
  formulaConfigurationErrors,
  formulaFields,
  formulaFunctionsFor,
  formulaReferences,
  formulaSyntaxError,
  formulaValue,
} from "../src/domain/formula";
import {
  validateFieldConfiguration,
  validateDynamicValues,
} from "../src/domain/fieldValidation";
import { newForm, seedWorkspace } from "../src/domain/workspace";
import {
  LocalWorkspaceRepository,
  WORKSPACE_KEY,
} from "../src/repositories/workspaceRepository";
import { useWorkspaceStore } from "../src/stores/workspace";
import FormulaEditor from "../src/features/forms/components/FormulaEditor.vue";

const calc = (expression: string, format = "number") =>
  createField("calculated", {
    id: "result",
    calculationVersion: 1,
    expression,
    format,
  });
let app: ReturnType<typeof createApp> | undefined;
beforeEach(() => {
  localStorage.clear();
  setActivePinia(createPinia());
});
afterEach(() => {
  app?.unmount();
  app = undefined;
  document.body.innerHTML = "";
  localStorage.clear();
});
const evaluate = (expression: string, format = "number") => {
  const field = calc(expression, format);
  return formulaValue(field, [field], {});
};
async function flush() {
  for (let i = 0; i < 6; i++) await nextTick();
}
function seed(form: ReturnType<typeof newForm>) {
  const data = seedWorkspace();
  data.forms = [form];
  data.entries = [];
  data.recentFormIds = [];
  localStorage.setItem(WORKSPACE_KEY, JSON.stringify(data));
  return useWorkspaceStore();
}
it("restricts calculated variables to supported main fields, including tab contents and organization arrays", () => {
  const schema = emptySchema();
  const supported = [
    "text",
    "textarea",
    "number",
    "radio",
    "checkbox",
    "select",
    "multiselect",
    "member",
    "members",
    "department",
    "departments",
    "address",
    "location",
    "serial",
    "phone",
    "calculated",
  ] as const;
  schema.fields = supported.map((type) => createField(type, { id: type }));
  schema.fields.push(
    createField("datetime", { id: "date" }),
    createField("subform", {
      id: "rows",
      children: [createField("number", { id: "rowNumber" })],
    }),
    createField("tabs", { children: [createField("text", { id: "tabText" })] }),
  );
  expect(
    formulaFields(schema.fields, "", true).map((item) => item.field.id),
  ).toEqual([...supported, "tabText"]);
  expect(formulaFields(schema.fields).map((item) => item.field.id)).toContain(
    "rowNumber",
  );
  for (const id of ["date", "rowNumber"])
    expect(
      formulaConfigurationErrors(calc(`{{${id}}}`), schema.fields)[0],
    ).toContain("当前范围");
  const multi = calc('JOIN({{members}},"/")', "text");
  expect(formulaConfigurationErrors(multi, [...schema.fields, multi])).toEqual(
    [],
  );
  expect(
    formulaValue(multi, [...schema.fields, multi], {
      members: ["member-a", "member-b"],
    }),
  ).toEqual({ value: "member-a/member-b", error: "" });
});
it("uses the same restricted catalogue for calculations while keeping date and aggregate functions for ordinary defaults", () => {
  const names = formulaFunctionsFor(calc("2")).map((item) => item.name);
  for (const name of [
    "DATE",
    "DATEDIF",
    "NOW",
    "TODAY",
    "SUM",
    "COUNT",
    "PRODUCT",
    "AVERAGE",
  ])
    expect(names).not.toContain(name);
  for (const name of [
    "IF",
    "AND",
    "CONCATENATE",
    "TEXT",
    "TEXTPHONE",
    "MIN",
    "MAX",
    "ROUND",
  ])
    expect(names).toContain(name);
  expect(
    formulaFunctionsFor(calc("2")).find((item) => item.name === "TEXT")?.usage,
  ).not.toContain("日期");
  expect(
    formulaFunctionsFor(createField("number")).map((item) => item.name),
  ).toContain("SUM");
  for (const expression of ["SUM(1,2)", "YEAR(TODAY())", "IF(true,2,SUM(1,2))"])
    expect(
      formulaConfigurationErrors(calc(expression), [calc(expression)])[0],
    ).toContain("不支持函数");
});
it("rejects implicit boolean, text and numeric function arguments and text arithmetic in configuration and execution", () => {
  const invalid = [
    "IF(1,2,3)",
    "AND(1,true)",
    "NOT(0)",
    "CONCATENATE(1,2)",
    'LEFT("321","2")',
    "LEN(123)",
    'TEXT("12","0")',
    'EXACT(1,"1")',
    '"甲"+"乙"',
    'ROUND("2",1)',
  ];
  for (const expression of invalid) {
    const field = calc(
      expression,
      ["CONCATENATE", "LEFT", "TEXT", '"甲"'].some((name) =>
        expression.startsWith(name),
      )
        ? "text"
        : "number",
    );
    expect(
      formulaConfigurationErrors(field, [field]).length,
      expression,
    ).toBeGreaterThan(0);
    expect(formulaValue(field, [field], {}).error, expression).not.toBe("");
  }
  expect(evaluate('IF(true,LEFT("321",2),"无")', "text")).toEqual({
    value: "32",
    error: "",
  });
  expect(evaluate('TEXT(12,"0.00")', "text")).toEqual({
    value: "12.00",
    error: "",
  });
  expect(evaluate("IF(1==TRUE(),1,2)")).toEqual({ value: 2, error: "" });
});
it("returns blank for invalid integer ranges without concealing argument type errors", () => {
  for (const expression of [
    'LEFT("abc",-1)',
    'RIGHT("abc",1.5)',
    'MID("abc",0,1)',
    'REPLACE("abc",1,1.5,"x")',
    'REPT("abc",-1)',
    'SEARCH("a","abc",0)',
  ])
    expect(
      evaluate(expression, expression.startsWith("SEARCH") ? "number" : "text"),
      expression,
    ).toEqual({ value: null, error: "" });
  expect(evaluate('LEFT("abc",0)', "text")).toEqual({ value: "", error: "" });
  expect(evaluate('LEFT("abc",2)', "text")).toEqual({ value: "ab", error: "" });
  expect(evaluate("ROUND(123.4,-1)")).toEqual({ value: 120, error: "" });
  expect(evaluate('REPT("abc","2")', "text").error).toContain("数字");
});
it("supports boolean literals and block comments without treating commented references as dependencies", () => {
  const expression = "IF(true, /* {{missing}} SUM(1,2) */ 2, 1/0)";
  expect(formulaReferences(expression)).toEqual([]);
  expect(evaluate(expression)).toEqual({ value: 2, error: "" });
  expect(evaluate('CONCATENATE("/* literal */","ok")', "text").value).toBe(
    "/* literal */ok",
  );
  expect(formulaSyntaxError("2 /* unfinished")).toContain("注释未结束");
  const long = calc("2+".repeat(4000) + "2 /* TEXTPHONE() */");
  expect(formulaConfigurationErrors(long, [long])).toEqual([]);
});
it("checks runtime array element types and failed calculated dependencies", () => {
  const choices = createField("members", { id: "members" });
  const joined = calc('JOIN({{members}},"/")', "text");
  expect(
    formulaValue(joined, [choices, joined], { members: ["a", "b"] }).value,
  ).toBe("a/b");
  expect(evaluate('JOIN([1,2],"/")', "text").error).toContain("文本数组");
  const invalid = createField("calculated", {
    id: "bad",
    calculationVersion: 1,
    format: "text",
    expression: "CONCATENATE(1,2)",
  });
  const dependent = calc("LEN({{bad}})");
  expect(resolveCalculations([dependent, invalid], {})).toMatchObject({
    result: null,
    bad: null,
  });
});
it("preserves the internal calculation version through parsing and rejects invalid versions without upgrading legacy schemas", () => {
  const schema = emptySchema();
  schema.fields = [
    calc("2"),
    createField("calculated", { id: "old", expression: "SUM(1,2)" }),
  ];
  const parsed = parseSchema(schema);
  expect(parsed.fields[0]?.calculationVersion).toBe(1);
  expect(parsed.fields[1]?.calculationVersion).toBeUndefined();
  expect(() =>
    parseSchema({
      ...schema,
      fields: [{ ...schema.fields[0], calculationVersion: 2 }],
    }),
  ).toThrow("版本无效");
  expect(() =>
    parseSchema({
      ...schema,
      fields: [createField("text", { calculationVersion: 1 })],
    }),
  ).toThrow("版本无效");
});
it("retains historical calculation and ordinary default semantics, including child sums and boolean coercion", () => {
  const old = createField("calculated", {
    id: "old",
    expression: "SUM({{qty}})",
  });
  const rows = createField("subform", {
    id: "rows",
    children: [createField("number", { id: "qty" })],
  });
  expect(
    formulaValue(old, [old, rows], { rows: [{ qty: 2 }, { qty: 3 }] }),
  ).toEqual({ value: 5, error: "" });
  const ordinary = createField("text", {
    id: "default",
    defaultFormula: true,
    expression: "CONCATENATE(1,2)",
  });
  expect(formulaConfigurationErrors(ordinary, [ordinary])).toEqual([]);
  expect(formulaValue(ordinary, [ordinary], {})).toEqual({
    value: "12",
    error: "",
  });
  expect(
    formulaValue({ ...old, expression: "IF(1,2,3)" }, [old], {}).value,
  ).toBe(2);
});
it("enforces calculated configuration and execution at publication and submission boundaries", () => {
  const schema = emptySchema();
  schema.fields = [calc("SUM(1,2)")];
  const data = seedWorkspace();
  expect(validateFieldConfiguration(schema, data).join(" ")).toContain(
    "不支持函数",
  );
  expect(
    validateDynamicValues(schema, { result: 3 }, data)[0]?.message,
  ).toContain("不支持函数");
  schema.fields = [calc('LEFT("abc",-1)', "text")];
  expect(validateDynamicValues(schema, {}, data)).toEqual([]);
});
it("normalizes new and changed calculations before save and publication while preserving an immutable legacy version", async () => {
  const form = newForm("oa", "历史计算");
  const old = createField("calculated", { id: "old", expression: "SUM(1,2)" });
  form.schema.fields = [old];
  form.published = {
    version: 1,
    title: form.title,
    schema: copy(form.schema),
    workflow: copy(form.workflow),
    publishedAt: "2026-10-10",
  };
  form.versions = [copy(form.published)];
  const store = seed(form),
    draft = store.openForm(form.id)!;
  const originalVersion = copy(store.data.forms[0]!.published!);
  draft.title = "只改标题";
  expect(await store.saveForm(form.id)).toBe(true);
  expect(draft.schema.fields[0]?.calculationVersion).toBeUndefined();
  draft.schema.fields[0]!.expression = "SUM(2,3)";
  expect(await store.saveForm(form.id)).toBe(false);
  expect(draft.schema.fields[0]!.expression).toBe("SUM(2,3)");
  expect(
    new LocalWorkspaceRepository().load()!.forms[0]!.schema.fields[0]!
      .expression,
  ).toBe("SUM(1,2)");
  draft.schema.fields[0]!.expression = "2+3";
  expect(await store.publishForm(form.id)).toBe(true);
  const persisted = new LocalWorkspaceRepository().load()!.forms[0]!;
  expect(persisted.schema.fields[0]?.calculationVersion).toBe(1);
  expect(persisted.published?.schema.fields[0]?.calculationVersion).toBe(1);
  expect(persisted.versions?.[0]).toEqual(originalVersion);
  expect(
    formulaValue(
      originalVersion.schema.fields[0]!,
      originalVersion.schema.fields,
      {},
    ).value,
  ).toBe(3);
});
it("rejects direct new-form bypasses and downgrades while allowing unfinished drafts to save", async () => {
  const form = newForm("oa", "新计算"),
    store = seed(form),
    draft = store.openForm(form.id)!;
  const field = createField("calculated", { expression: "SUM(1,2)" });
  draft.schema.fields = [field];
  expect(await store.saveForm(form.id)).toBe(false);
  expect(await store.publishForm(form.id)).toBe(false);
  expect(field.expression).toBe("SUM(1,2)");
  field.expression = "";
  expect(await store.saveForm(form.id)).toBe(true);
  expect(field.calculationVersion).toBe(1);
  expect(await store.publishForm(form.id)).toBe(false);
  delete field.calculationVersion;
  field.expression = "SUM(1,2)";
  expect(await store.saveForm(form.id)).toBe(false);
  field.expression = "2";
  expect(await store.publishForm(form.id)).toBe(true);
  expect(
    new LocalWorkspaceRepository().load()!.forms[0]?.published?.schema.fields[0]
      ?.calculationVersion,
  ).toBe(1);
});
it("filters actual editor common/search menus and retains invalid input until corrected", async () => {
  const schema = emptySchema(),
    field = reactive(calc("2"));
  schema.fields = [
    field,
    createField("text", { id: "name", label: "姓名" }),
    createField("datetime", { id: "date", label: "日期" }),
    createField("subform", {
      label: "明细",
      children: [createField("number", { id: "qty", label: "数量" })],
    }),
  ];
  const updates: unknown[] = [];
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: "/", component: { render: () => null } }],
  });
  await router.push("/");
  await router.isReady();
  const host = document.createElement("div");
  document.body.append(host);
  app = createApp({
    render: () =>
      h(FormulaEditor, {
        field,
        schema,
        onUpdate: (patch: object) => {
          updates.push(patch);
          Object.assign(field, patch);
        },
      }),
  });
  app.use(createPinia());
  app.use(router);
  app.mount(host);
  host.querySelector<HTMLButtonElement>("button")!.click();
  await flush();
  const dialog = document.querySelector<HTMLDialogElement>(
    'dialog[aria-label="公式编辑"]',
  )!;
  expect(
    [...dialog.querySelectorAll(".formula-field-list button")].map(
      (b) => b.textContent,
    ),
  ).toEqual(["姓名单行文本"]);
  expect(dialog.querySelector("details[open]")!.textContent).not.toContain(
    "SUM",
  );
  expect(
    dialog.querySelector(".formula-function-list")!.textContent,
  ).not.toContain("日期函数");
  const input = dialog.querySelector<HTMLElement>('[aria-label="公式内容"]')!;
  const button = (name: string) =>
    [...dialog.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.textContent?.trim() === name,
    )!;
  input.textContent = "SUM(1,2)";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await flush();
  button("确定").click();
  await flush();
  expect(dialog.textContent).toContain("不支持函数");
  expect(input.textContent).toBe("SUM(1,2)");
  expect(updates).toEqual([]);
  input.textContent = "IF(true,2,3)";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await flush();
  button("确定").click();
  await flush();
  expect(field.expression).toBe("IF(true,2,3)");
  expect(field.calculationVersion).toBe(1);
  expect(updates).toHaveLength(1);
  delete field.calculationVersion;
  field.expression = 'TEXT({{date}},"yyyy")';
  field.format = "text";
  host.querySelector<HTMLButtonElement>("button")!.click();
  await flush();
  const oldDialog = document.querySelector<HTMLDialogElement>(
    'dialog[aria-label="公式编辑"]',
  )!;
  expect(oldDialog.querySelector(".formula-input")!.textContent).toContain(
    "日期",
  );
  expect(oldDialog.querySelector(".formula-input")!.textContent).not.toContain(
    "已失效",
  );
  [...oldDialog.querySelectorAll<HTMLButtonElement>("button")]
    .find((b) => b.textContent?.trim() === "确定")!
    .click();
  await flush();
  expect(field.calculationVersion).toBeUndefined();
  expect(field.expression).toBe('TEXT({{date}},"yyyy")');
});
