// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApp, h, nextTick, reactive } from "vue";
import { createPinia } from "pinia";
import { createMemoryHistory, createRouter } from "vue-router";
import {
  composeFormSchema,
  separateFormSchema,
  type FormField,
  type FormValues,
} from "@platform/contracts";
import {
  calculate,
  copy,
  createField,
  duplicateField,
  emptySchema,
  parseSchema,
  resolveCalculations,
} from "../src/domain/form";
import {
  evaluateFormula,
  formulaConfigurationErrors,
  formulaFields,
  formulaReferences,
  formulaSyntaxError,
  formulaValue,
  replaceFormulaReferences,
} from "@platform/contracts";
import { applyFieldChange, runtimeDefaults } from "../src/domain/relations";
import {
  validateDynamicValues,
  validateFieldConfiguration,
} from "../src/domain/fieldValidation";
import { newForm, seedWorkspace } from "../src/domain/workspace";
import { useWorkspaceStore } from "../src/stores/workspace";
import FieldInspector from "../src/features/forms/components/FieldInspector.vue";
import FormulaEditor from "../src/features/forms/components/FormulaEditor.vue";
import FormRuntime from "../src/features/forms/components/FormRuntime.vue";

vi.mock("../src/stores/workspace", () => ({ useWorkspaceStore: vi.fn() }));
const cleanup: (() => void)[] = [];
const data = () => seedWorkspace();
function fixture() {
  const schema = emptySchema();
  const quantity = createField("number", {
      id: "quantity",
      label: "数量",
      defaultValue: 2,
    }),
    price = createField("number", {
      id: "price",
      label: "单价",
      defaultValue: 3.25,
    }),
    total = createField("number", {
      id: "total",
      label: "总价",
      defaultValue: 999,
      defaultFormula: true,
      expression: "ROUND({{quantity}} * {{price}}, 2)",
    }),
    name = createField("text", {
      id: "name",
      label: "等级",
      defaultFormula: true,
      expression: 'IF({{total}}>10,"大额","普通")',
    }),
    note = createField("textarea", {
      id: "note",
      label: "说明",
      defaultFormula: true,
      expression:
        'CONCATENATE({{name}},CHAR(10),"金额：",TEXT({{total}},"0.00"))',
    }),
    date = createField("datetime", {
      id: "date",
      label: "到期日",
      format: "date",
      defaultFormula: true,
      expression: "DATEDELTA(DATE(2026,10,9), {{quantity}})",
    });
  schema.fields = [note, name, total, quantity, price, date];
  return { schema, quantity, price, total, name, note, date };
}
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  const workspace = data();
  vi.mocked(useWorkspaceStore).mockReturnValue({
    data: workspace,
    activeForms: workspace.forms,
  } as any);
});
afterEach(() => {
  cleanup.splice(0).forEach((fn) => fn());
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});
async function mount(
  component: any,
  props: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) {
  const host = document.createElement("div");
  document.body.append(host);
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: "/", component: { render: () => null } }],
  });
  await router.push("/");
  await router.isReady();
  const app = createApp({ render: () => h(component, { ...props, ...extra }) });
  app.use(createPinia());
  app.use(router);
  app.mount(host);
  cleanup.push(() => app.unmount());
  await nextTick();
  return host;
}
const button = (root: ParentNode, label: string) =>
  Array.from(root.querySelectorAll<HTMLButtonElement>("button")).find(
    (b) => b.textContent?.trim() === label,
  )!;
async function fill(
  element: HTMLInputElement | HTMLSelectElement,
  value: string,
  event = "input",
) {
  element.value = value;
  element.dispatchEvent(new Event(event, { bubbles: true }));
  await nextTick();
}
it("keeps numeric legacy arithmetic safe and shares parsing with typed functions", () => {
  expect(calculate("{{quantity}} * .5 + 1e-8", { quantity: 2 })).toBe(
    1.00000001,
  );
  expect(calculate("{{empty}} + 1", {})).toBe(1);
  expect(calculate("{{quantity}} / 0", { quantity: 2 })).toBeNull();
  for (const value of [
    "globalThis.alert(1)",
    'constructor.constructor("return 1")()',
    "{{x}};alert(1)",
    "1 + (2",
    "1 + 2 trailing",
  ])
    expect(evaluateFormula(value, {}).error).not.toBe("");
  expect(
    evaluateFormula('CONCATENATE({{x}},"安全")', {
      x: '<img onerror="alert(1)">',
    }).value,
  ).toBe('<img onerror="alert(1)">安全');
});
it("runs the same typed references for calculated fields and preserves legacy numeric strings", () => {
  const text = createField("text", { id: "input" });
  const date = createField("datetime", { id: "date", format: "date" });
  const amount = createField("number", { id: "amount" });
  const factor = createField("calculated", {
    id: "factor",
    expression: "VALUE({{input}})",
  });
  const rowTotal = createField("calculated", {
    id: "rowTotal",
    expression: "{{factor}} * {{amount}}",
  });
  const rows = createField("subform", {
    id: "rows",
    children: [amount, rowTotal],
  });
  const total = createField("calculated", {
    id: "total",
    expression: "SUM({{amount}}) + VALUE({{input}})",
  });
  const day = createField("calculated", {
    id: "day",
    expression: "DAY({{date}})",
  });
  const grandTotal = createField("calculated", {
    id: "grandTotal",
    expression: "SUM({{rowTotal}})",
  });
  rows.children.push(
    createField("calculated", {
      id: "after",
      expression: "{{grandTotal}} + {{amount}}",
    }),
  );
  const fields = [text, date, rows, total, day, grandTotal, factor];
  const result = resolveCalculations(fields, {
    input: "3.5",
    date: "2026-10-09",
    rows: [{ amount: "10" }, { amount: 20 }],
  });
  expect(result.total).toBe(33.5);
  expect(result.day).toBe(9);
  expect(result.grandTotal).toBe(105);
  expect(result.rows).toEqual([
    { amount: "10", rowTotal: 35, after: 115 },
    { amount: 20, rowTotal: 70, after: 125 },
  ]);
  expect(
    applyFieldChange(
      rows.children,
      { amount: 10 },
      "amount",
      15,
      data(),
      { input: "3.5", factor: 3.5 },
      fields,
    ).rowTotal,
  ).toBe(52.5);
  expect(
    applyFieldChange(fields, result, "input", "5", data()).grandTotal,
  ).toBe(150);
});
it("evaluates comparisons and lazy IF branches without hiding malformed functions", () => {
  expect(evaluateFormula("IF({{n}}==0,0,10/{{n}})", { n: 0 })).toEqual({
    value: 0,
    error: "",
  });
  expect(
    evaluateFormula('IF(AND(2>=2,NOT(3<2)), "通过", "失败")', {}).value,
  ).toBe("通过");
  expect(evaluateFormula('OR(FALSE(),ISEMPTY(""),1>2)', {}).value).toBe(true);
  expect(evaluateFormula("ISEMPTY(0)==FALSE()", {}).value).toBe(true);
  expect(formulaSyntaxError("IF(TRUE(),1,UNKNOWN())")).toContain("不支持");
  expect(formulaSyntaxError("DATEDELTA(1)")).toContain("参数个数");
  expect(formulaSyntaxError("1=1")).toContain("字符");
});
it("uses business text, multiline characters, arrays and explicit numeric conversion", () => {
  const examples: Record<string, unknown> = {
    'CONCATENATE("姓名：",UPPER("a"),CHAR(10),TRIM("  一  二  "))':
      "姓名：A\n一 二",
    'JOIN(SPLIT("销售,仓库",","),"-")': "销售-仓库",
    'LEFT("ABCDE",2)': "AB",
    'RIGHT("ABCDE",0)': "",
    'MID("ABCDE",2,3)': "BCD",
    'LEN("中 文")': 3,
    'LOWER("ABC")': "abc",
    'EXACT("A","a")': false,
    'VALUE("1.25e2")': 125,
    'TEXT(23.1578,"000.00")': "023.16",
    'TEXT(23000.1,"0,000.00")': "23,000.10",
    'TEXT(0.25,"0%")': "25%",
    'TEXT(23.1,"#.##")': "23.1",
    "SUM([1,2],3)": 6,
    "PRODUCT(2,3,4)": 24,
    "AVERAGE(1,3,5)": 3,
    "MIN(3,1,2)": 1,
    "MAX(3,1,2)": 3,
    'COUNT(["张三","李四"])': 2,
    "ABS(-12)": 12,
    "ROUND(-1.005,2)": -1.01,
    "INT(-1.5)": -2,
    "MOD(-3,2)": 1,
    "POWER(2,3)": 8,
    "SQRT(9)": 3,
  };
  for (const [formula, result] of Object.entries(examples))
    expect(evaluateFormula(formula, {}), formula).toEqual({
      value: result,
      error: "",
    });
  for (const formula of [
    'VALUE("一")',
    "LEFT([1,2],1)",
    'JOIN(1,"-")',
    "CHAR(65)",
    "SQRT(-1)",
  ])
    expect(evaluateFormula(formula, {}).error, formula).not.toBe("");
});
it("replaces, repeats and searches text and combines distinct values in first-occurrence order", () => {
  const examples: Record<string, unknown> = {
    'REPLACE("Jabcd1mark",2,4,"验收")': "J验收1mark",
    'REPLACE("abc",2,0,"X")': "aXbc",
    'REPLACE("abc",20,1,"X")': "abcX",
    'REPLACE("abc",2,20,"X")': "aX",
    'REPT("验收",3)': "验收验收验收",
    'REPT("x",0)': "",
    'REPT("x",2.9)': "xx",
    'SEARCH("BC","AbCabc")': 2,
    'SEARCH("BC","AbCabc",3)': 5,
    'SEARCH("z","AbCabc")': 0,
    'SEARCH("a","abc",20)': 0,
    'JOIN(UNION("销售","仓库","销售","财务")," / ")': "销售 / 仓库 / 财务",
    'JOIN(UNION(SPLIT("销售,仓库,销售",","))," / ")': "销售 / 仓库",
    'UNION(["a","A","a"],"A","")': ["a", "A", ""],
  };
  for (const [formula, result] of Object.entries(examples))
    expect(evaluateFormula(formula, {}), formula).toEqual({
      value: result,
      error: "",
    });
  expect(evaluateFormula('REPT("x",100000)', {}).value).toHaveLength(100000);
  for (const formula of [
    'REPLACE("abc",0,1,"X")',
    'REPLACE("abc",1,-1,"X")',
    'REPLACE("abc",1.5,1,"X")',
    'REPT("x",-1)',
    'REPT("xx",100000)',
    'REPT("x","2")',
    'SEARCH("a","abc",0)',
    'SEARCH(["a"],"abc")',
  ])
    expect(evaluateFormula(formula, {}).error, formula).not.toBe("");
});
it("matches public currency examples including truncation, zero gaps and the original fraction suffix", () => {
  const examples: Record<string, string> = {
    "0": "人民币零元整",
    "1001.019": "人民币壹仟零壹元零壹分",
    "10000.1": "人民币壹万元壹角整",
    "10.1": "人民币壹拾元壹角整",
    "-10.109": "人民币负壹拾元壹角",
    "0.01": "人民币壹分",
    "-0.01": "人民币负壹分",
    "0.009": "人民币",
    "1.0001": "人民币壹元",
    "0.101": "人民币壹角",
    "1.01": "人民币壹元零壹分",
    "1.13": "人民币壹元壹角叁分",
    "100010001": "人民币壹亿零壹万零壹元整",
    "1e12": "人民币壹万亿元整",
    "1e-7": "人民币",
  };
  for (const [amount, result] of Object.entries(examples))
    expect(evaluateFormula(`RMBCAP(${amount})`, {}), amount).toEqual({
      value: result,
      error: "",
    });
  expect(evaluateFormula('RMBCAP("12")', {}).error).toContain("数字");
  expect(evaluateFormula("RMBCAP(1e20)", {}).error).toContain("范围");
});
it("uses currency and text functions in real default chains, row arrays and stable copies", () => {
  const amount = createField("number", {
    id: "amount",
    defaultValue: 1001.019,
  });
  const capital = createField("text", {
    id: "capital",
    defaultFormula: true,
    expression: "RMBCAP({{amount}})",
  });
  const raw = createField("text", { id: "raw", defaultValue: "Jabcd1mark" });
  const processed = createField("textarea", {
    id: "processed",
    defaultFormula: true,
    expression:
      'CONCATENATE(REPLACE({{raw}},2,4,REPT("*",4))," / ",IF(SEARCH("MARK",{{raw}})>0,{{capital}},"待核对"))',
  });
  const tag = createField("text", { id: "tag" });
  const rows = createField("subform", { id: "rows", children: [tag] });
  const tags = createField("text", {
    id: "tags",
    defaultFormula: true,
    expression: 'JOIN(UNION({{tag}})," / ")',
  });
  const schema = emptySchema();
  schema.fields = [processed, capital, tags, rows, raw, amount];
  const workspace = data();
  const values = applyFieldChange(
    schema.fields,
    runtimeDefaults(schema.fields, workspace),
    "rows",
    [{ tag: "销售" }, { tag: "仓库" }, { tag: "销售" }],
    workspace,
  );
  expect(values.processed).toBe("J****1mark / 人民币壹仟零壹元零壹分");
  expect(values.tags).toBe("销售 / 仓库");
  const updated = applyFieldChange(
    schema.fields,
    values,
    "amount",
    1.13,
    workspace,
  );
  expect(updated.processed).toBe("J****1mark / 人民币壹元壹角叁分");
  expect(validateDynamicValues(schema, updated, workspace)).toEqual([]);
  const invalid = applyFieldChange(
    schema.fields,
    updated,
    "amount",
    "错误",
    workspace,
  );
  expect(invalid.capital).toBe("");
  expect(invalid.processed).toBe("");
  expect(
    validateDynamicValues(schema, invalid, workspace).some(
      (e) => e.fieldId === "capital",
    ),
  ).toBe(true);
  const fallback = applyFieldChange(
    schema.fields,
    invalid,
    "raw",
    "abc",
    workspace,
  );
  expect(fallback.processed).toBe("a**** / 待核对");
  capital.expression = 'IF({{amount}}>0,"有金额","无金额")';
  expect(formulaValue(capital, schema.fields, invalid).error).toContain("数字");
  capital.expression = 'IF(FALSE(),RMBCAP({{amount}}),"待核对")';
  expect(formulaValue(capital, schema.fields, invalid)).toEqual({
    value: "待核对",
    error: "",
  });
  capital.expression = "RMBCAP({{amount}})";
  const { model, page } = separateFormSchema(schema);
  const restored = parseSchema(composeFormSchema(model, page));
  expect(restored.fields[1]!.expression).toBe(capital.expression);
  const direct = createField("text", {
    id: "direct",
    defaultFormula: true,
    expression: "UNION({{tag}})",
  });
  expect(
    formulaConfigurationErrors(direct, [...schema.fields, direct]),
  ).toEqual([]);
  expect(formulaValue(direct, [...schema.fields, direct], values)).toEqual({
    value: "销售;仓库",
    error: "",
  });
  expect(
    formulaValue(direct, [...schema.fields, direct], { ...values, rows: [] }),
  ).toEqual({ value: "", error: "" });
  expect(
    formulaConfigurationErrors({ ...direct, type: "number" }, [
      ...schema.fields,
      direct,
    ]),
  ).toContain("公式需要返回数字");
});
it("formats dates and current time consistently in Beijing without accepting text as timestamps", () => {
  const now = new Date("2026-10-08T18:03:04Z");
  const field = createField("datetime", {
    id: "target",
    defaultFormula: true,
    format: "datetime-second",
    expression: "NOW()",
  });
  expect(formulaValue(field, [field], {}, undefined, now).value).toBe(
    "2026-10-09T02:03:04",
  );
  field.expression = "TODAY()";
  expect(formulaValue(field, [field], {}, undefined, now).value).toBe(
    "2026-10-09T00:00:00",
  );
  const examples: Record<string, unknown> = {
    'TEXT(DATE(2024,2,29,13,2,3),"yyyy-MM-dd HH:mm:ss")': "2024-02-29 13:02:03",
    "YEAR(DATE(2024,2,29))": 2024,
    "MONTH(DATE(2024,2,29))": 2,
    "DAY(DATE(2024,2,29))": 29,
    "HOUR(DATE(2024,2,29,13,2,3))": 13,
    "MINUTE(DATE(2024,2,29,13,2,3))": 2,
    "SECOND(DATE(2024,2,29,13,2,3))": 3,
    "DAYS(DATE(2024,3,1),DATE(2024,2,29))": 1,
  };
  for (const [formula, result] of Object.entries(examples))
    expect(evaluateFormula(formula, {}, now), formula).toEqual({
      value: result,
      error: "",
    });
  expect(
    evaluateFormula('DAYS("2024-03-01","2024-02-29")', {}).error,
  ).toContain("日期");
  expect(evaluateFormula("DATE(2023,2,29)", {}).error).toContain("不合法");
  field.expression = "0";
  expect(formulaValue(field, [field], {}).value).toBe("1970-01-01T08:00:00");
});
it("distinguishes numeric prefixes from date tokens and shares Chinese numeral formatting", () => {
  const examples: Record<string, string> = {
    'TEXT(123.7895,"Amount: 0.00")': "Amount: 123.79",
    'TEXT(-23.1,"USD #,##0.00")': "USD -23.10",
    'TEXT(123.7895,"金额 [Num0]")': "金额 123.7895",
    'TEXT(123,"[Num1]")': "一百二十三",
    'TEXT(123,"$ [Num2]")': "$ 壹佰贰拾叁",
    'TEXT(0,"[Num2]")': "零",
    'TEXT(10,"[Num1]")': "十",
    'TEXT(12,"[Num2]")': "壹拾贰",
    'TEXT(100100001,"[Num1]")': "一亿零一十万零一",
    'TEXT(100010000,"[Num2]")': "壹亿零壹万",
    'TEXT(-1001.019,"[Num2]")': "负壹仟零壹点零壹玖",
    'TEXT(1e-7,"[Num1]")': "零点零零零零零零一",
    'TEXT(1e12,"[Num2]")': "壹兆",
    'TEXT(DATE(2024,2,29,13,2,3),"yyyy年MMMdd日 HH:mm:ss EEE")':
      "2024年二月29日 13:02:03 星期四",
  };
  for (const [formula, result] of Object.entries(examples))
    expect(evaluateFormula(formula, {}), formula).toEqual({
      value: result,
      error: "",
    });
  expect(evaluateFormula('TEXT(1e20,"[Num2]")', {}).error).toContain("范围");
  expect(evaluateFormula('TEXT(123,"[Num3]")', {}).error).not.toBe("");
});
it("calculates fractional calendar months, unit-sensitive durations and time fractions", () => {
  const examples: Record<string, number> = {
    'DATEDIF(DATE(2024,1,31),DATE(2024,2,29),"M")': 1,
    'DATEDIF(DATE(2024,1,31),DATE(2024,2,15),"M")': 15 / 29,
    'DATEDIF(DATE(2024,1,31),DATE(2024,2,29),"y")': 1 / 12,
    'DATEDIF(DATE(2024,2,29),DATE(2025,2,28),"y")': 1,
    'DATEDIF(DATE(2024,1,1),DATE(2024,1,15),"M")': 14 / 31,
    "DATEDIF(DATE(2024,2,29,0,0,0),DATE(2024,3,1,12,0,0))": 1.5,
    'DATEDIF(DATE(2024,2,29),DATE(2024,3,1),"h")': 24,
    'DATEDIF(DATE(2024,2,29),DATE(2024,3,1),"m")': 1440,
    'DATEDIF(DATE(2024,2,29),DATE(2024,3,1),"s")': 86400,
    'DATEDIF(DATE(2024,2,29),DATE(2024,2,29),"M")': 0,
    "TIMESTAMP(DATE(1970,1,1,8,0,0))": 0,
    "DAY(DATE(TIMESTAMP(DATE(2024,2,29))))": 29,
    "TIME(27,0,0)": 1.125,
    "TIME(0,750,0)": 750 / 1440,
    "TIME(0,0,2000)": 2000 / 86400,
  };
  for (const [formula, result] of Object.entries(examples)) {
    const actual = evaluateFormula(formula, {});
    expect(actual.error, formula).toBe("");
    expect(actual.value, formula).toBeCloseTo(result, 12);
  }
  expect(
    evaluateFormula("DATEDIF(DATE(2024,3,1),DATE(2024,2,29))", {}).error,
  ).toContain("结束日期");
  expect(evaluateFormula('DATEDIF(0,0,"D")', {}).error).toContain("单位");
  expect(evaluateFormula('TIMESTAMP("2024-02-29")', {}).error).toContain(
    "日期",
  );
  expect(formulaSyntaxError("TIME(3,0)")).toContain("参数个数");
});
it("propagates date duration and formatted amount through the original defaults and submission validation", () => {
  const start = createField("datetime", {
    id: "start",
    format: "date",
    dateDefault: "custom",
    defaultValue: "2024-01-31",
  });
  const end = createField("datetime", {
    id: "end",
    format: "date",
    dateDefault: "custom",
    defaultValue: "2024-02-29",
  });
  const duration = createField("number", {
    id: "duration",
    defaultFormula: true,
    expression: 'DATEDIF({{start}},{{end}},"M")',
  });
  const amount = createField("number", {
    id: "amount",
    defaultFormula: true,
    expression: "ROUND({{duration}}*123,2)",
  });
  const display = createField("text", {
    id: "display",
    defaultFormula: true,
    expression:
      'CONCATENATE(TEXT({{amount}},"Amount: 0.00")," / ",TEXT({{amount}},"[Num2]"))',
  });
  const schema = emptySchema();
  schema.fields = [display, amount, duration, start, end];
  const workspace = data();
  let values = runtimeDefaults(schema.fields, workspace);
  expect(values.duration).toBe(1);
  expect(values.display).toBe("Amount: 123.00 / 壹佰贰拾叁");
  values = applyFieldChange(
    schema.fields,
    values,
    "end",
    "2024-02-15",
    workspace,
  );
  expect(values.duration).toBeCloseTo(15 / 29, 12);
  expect(values.amount).toBe(63.62);
  expect(values.display).toBe("Amount: 63.62 / 陆拾叁点陆贰");
  expect(validateDynamicValues(schema, values, workspace)).toEqual([]);
  values = applyFieldChange(
    schema.fields,
    values,
    "end",
    "2024-01-30",
    workspace,
  );
  expect(values.display).toBe("");
  expect(
    validateDynamicValues(schema, values, workspace).some(
      (e) => e.fieldId === "duration" && e.message.includes("结束日期"),
    ),
  ).toBe(true);
});
it("propagates failed formula reads without treating them as zero or failing unused IF branches and sibling rows", () => {
  const quantity = createField("number", { id: "q" });
  const total = createField("calculated", {
    id: "total",
    expression: "10/{{q}}",
  });
  const display = createField("text", {
    id: "display",
    defaultFormula: true,
    expression: 'TEXT({{total}},"Amount: 0.00")',
  });
  const safe = createField("number", {
    id: "safe",
    defaultFormula: true,
    expression: "IF({{q}}==0,0,{{total}})",
  });
  const rowQuantity = createField("number", { id: "rowQuantity" });
  const line = createField("calculated", {
    id: "line",
    expression: "10/{{rowQuantity}}",
  });
  const rowDisplay = createField("text", {
    id: "rowDisplay",
    defaultFormula: true,
    expression: 'TEXT({{line}},"0.00")',
  });
  const rows = createField("subform", {
    id: "rows",
    children: [rowDisplay, line, rowQuantity],
  });
  const sum = createField("calculated", {
    id: "sum",
    expression: "SUM({{line}})",
  });
  const fields = [display, safe, sum, total, quantity, rows];
  const run = (values: FormValues) =>
    resolveCalculations(
      fields,
      values,
      {},
      { defaults: ["display", "safe", "rowDisplay"] },
    );
  const invalid = run({ q: 0, rows: [{ rowQuantity: 0 }, { rowQuantity: 2 }] });
  expect(invalid.total).toBeNull();
  expect(invalid.display).toBe("");
  expect(invalid.safe).toBe(0);
  expect(invalid.sum).toBeNull();
  expect((invalid.rows as FormValues[]).map((r) => r.rowDisplay)).toEqual([
    "",
    "5.00",
  ]);
  const valid = run({ q: 2, rows: [{ rowQuantity: 1 }, { rowQuantity: 2 }] });
  expect(valid.display).toBe("Amount: 5.00");
  expect(valid.safe).toBe(5);
  expect(valid.sum).toBe(15);
});
it("preserves stable references and remarks through parsing, projection and duplication", () => {
  const f = fixture();
  f.total.formulaRemark = "数量乘单价";
  const parsed = parseSchema(f.schema);
  expect(parsed.fields.find((v) => v.id === "total")!.defaultFormula).toBe(
    true,
  );
  const separated = separateFormSchema(parsed),
    recomposed = composeFormSchema(separated.model, separated.page);
  expect(recomposed.fields.find((v) => v.id === "total")!.formulaRemark).toBe(
    "数量乘单价",
  );
  const row = createField("subform", { children: [f.quantity, f.total] });
  const duplicated = duplicateField(row);
  expect(duplicated.children[1]!.expression).toContain(
    "{{" + duplicated.children[0]!.id + "}}",
  );
  expect(duplicated.children[1]!.expression).toContain("{{price}}");
  expect(formulaReferences('CONCATENATE("{{price}}",{{quantity}})')).toEqual([
    "quantity",
  ]);
  expect(
    replaceFormulaReferences(
      'CONCATENATE("{{quantity}}",{{quantity}})',
      new Map([["quantity", "new"]]),
    ),
  ).toBe('CONCATENATE("{{quantity}}",{{new}})');
  expect(() =>
    parseSchema({
      ...f.schema,
      fields: [{ ...f.quantity, defaultFormula: "yes" }] as any,
    }),
  ).toThrow("公式");
});
it("rejects self, sibling-row, missing, conflicting and wrong-result configurations", () => {
  const f = fixture();
  expect(validateFieldConfiguration(f.schema, data())).toEqual([]);
  f.total.expression = "TODAY()";
  expect(formulaConfigurationErrors(f.total, f.schema.fields)).toContain(
    "公式需要返回数字",
  );
  f.total.expression = 'IF(TRUE(),1,"2")';
  expect(formulaConfigurationErrors(f.total, f.schema.fields)).toContain(
    "公式需要返回数字",
  );
  f.date.expression = '"2026-10-09"';
  expect(formulaConfigurationErrors(f.date, f.schema.fields)).toContain(
    "公式需要返回日期或时间戳",
  );
  f.total.expression = "{{total}}";
  expect(formulaConfigurationErrors(f.total, f.schema.fields)[0]).toContain(
    "当前字段",
  );
  f.total.expression = "{{removed}}";
  expect(formulaConfigurationErrors(f.total, f.schema.fields)[0]).toContain(
    "失效",
  );
  f.total.expression = "1";
  f.total.defaultLink = {
    enabled: true,
    formId: "x",
    fieldId: "x",
    match: "all",
    filters: [],
  };
  expect(formulaConfigurationErrors(f.total, f.schema.fields)[0]).toContain(
    "同时",
  );
  const left = createField("subform", { children: [f.total] }),
    right = createField("subform", { children: [f.quantity] });
  f.total.defaultLink.enabled = false;
  f.total.expression = "{{quantity}}";
  expect(formulaConfigurationErrors(f.total, [left, right])[0]).toContain(
    "范围",
  );
});
it("initializes reverse-ordered formula chains and updates only their dependencies", () => {
  const f = fixture(),
    workspace = data();
  const values = runtimeDefaults(f.schema.fields, workspace);
  expect(values).toMatchObject({
    quantity: 2,
    price: 3.25,
    total: 6.5,
    name: "普通",
    note: "普通\n金额：6.50",
    date: "2026-10-11",
  });
  const next = applyFieldChange(
    f.schema.fields,
    values,
    "quantity",
    4,
    workspace,
  );
  expect(next).toMatchObject({
    total: 13,
    name: "大额",
    note: "大额\n金额：13.00",
    date: "2026-10-13",
  });
  const manual = applyFieldChange(
    f.schema.fields,
    next,
    "total",
    18,
    workspace,
  );
  expect(manual.note).toBe("大额\n金额：18.00");
  const unchanged = applyFieldChange(
    f.schema.fields,
    manual,
    "date",
    "2026-10-15",
    workspace,
  );
  expect(unchanged.total).toBe(18);
  expect(
    resolveCalculations(f.schema.fields, {
      ...values,
      total: 0,
      note: "原说明",
    }),
  ).toMatchObject({ total: 0, note: "原说明" });
  f.total.defaultFormula = false;
  expect(runtimeDefaults(f.schema.fields, workspace).total).toBe(999);
});
it("keeps row formulas isolated and recomputes main aggregates after row and main changes", () => {
  const workspace = data(),
    factor = createField("number", { id: "factor", defaultValue: 2 }),
    quantity = createField("number", { id: "q", defaultValue: 3 }),
    line = createField("number", {
      id: "line",
      defaultFormula: true,
      expression: "{{q}} * {{factor}}",
    }),
    details = createField("subform", {
      id: "rows",
      children: [quantity, line],
    }),
    sum = createField("number", {
      id: "sum",
      defaultFormula: true,
      expression: "SUM({{line}})",
    });
  const fields = [sum, factor, details];
  expect(
    runtimeDefaults(details.children, workspace, { factor: 4 }, fields),
  ).toMatchObject({ q: 3, line: 12 });
  const first = runtimeDefaults(
      details.children,
      workspace,
      { factor: 2 },
      fields,
    ),
    second = runtimeDefaults(
      details.children,
      workspace,
      { factor: 2 },
      fields,
    );
  let values = applyFieldChange(
    fields,
    { factor: 2 },
    "rows",
    [first, second],
    workspace,
  );
  expect(values.sum).toBe(12);
  const row = applyFieldChange(
    details.children,
    first,
    "q",
    5,
    workspace,
    values,
    fields,
  );
  values = applyFieldChange(fields, values, "rows", [row, second], workspace);
  expect(values.sum).toBe(16);
  expect((values.rows as any[])[1].line).toBe(6);
  values = applyFieldChange(fields, values, "factor", 3, workspace);
  expect((values.rows as any[]).map((r) => r.line)).toEqual([15, 9]);
  expect(values.sum).toBe(24);
  values = applyFieldChange(
    fields,
    values,
    "rows",
    [(values.rows as any[])[1]],
    workspace,
  );
  expect(values.sum).toBe(9);
  expect(formulaFields(fields, "line").some((f) => f.column)).toBe(false);
});
it("uses option display names and civil date timestamps instead of internal IDs or raw strings", () => {
  const choice = createField("radio", {
      id: "choice",
      options: [{ id: "internal", label: "销售" }],
    }),
    date = createField("datetime", { id: "date", format: "month" }),
    target = createField("textarea", {
      id: "target",
      defaultFormula: true,
      expression: 'CONCATENATE({{choice}},":",TEXT(DATE({{date}}),"yyyyMM"))',
    });
  expect(
    formulaValue(target, [choice, date, target], {
      choice: "internal",
      date: "2026-10",
    }).value,
  ).toBe("销售:202610");
  expect(
    formulaValue(
      target,
      [choice, date, target],
      { choice: "internal", date: "2026-10" },
      () => [{ id: "internal", label: "新名称" }],
    ).value,
  ).toBe("新名称:202610");
});
it("detects combined formula, arithmetic and default-link dependency cycles", () => {
  const f = fixture(),
    workspace = data(),
    source = newForm("oa", "来源");
  source.schema.fields = [createField("number", { id: "value" })];
  source.published = {
    version: 1,
    schema: copy(source.schema),
    workflow: copy(source.workflow),
    extensions: copy(source.extensions),
    title: source.title,
    publishedAt: "2026-10-09",
  };
  workspace.forms = [source];
  f.quantity.defaultLink = {
    enabled: true,
    formId: source.id,
    fieldId: "value",
    match: "all",
    filters: [
      {
        id: "filter",
        sourceFieldId: "value",
        operator: "equals",
        source: "field",
        value: "total",
      },
    ],
  };
  expect(
    validateFieldConfiguration(f.schema, workspace).some((e) =>
      e.includes("循环引用"),
    ),
  ).toBe(true);
});
it("shows formula errors at the actual fill submission boundary", () => {
  const f = fixture();
  f.total.expression = "{{price}} / {{quantity}}";
  const values = runtimeDefaults(f.schema.fields, data());
  const next = applyFieldChange(f.schema.fields, values, "quantity", 0, data());
  expect(next.total).toBe("");
  expect(
    validateDynamicValues(f.schema, next, data()).find(
      (e) => e.fieldId === "total",
    )?.message,
  ).toContain("除数");
  expect(
    validateDynamicValues(f.schema, { ...values, quantity: 1 }, data()).find(
      (e) => e.fieldId === "total",
    ),
  ).toBeUndefined();
});
it("reuses the original default-source selector and retains dormant formula/custom values", async () => {
  const f = fixture(),
    field = reactive(f.total);
  field.defaultFormula = false;
  const host = await mount(
    FieldInspector,
    { field, schema: f.schema, formId: "x" },
    { onUpdate: (patch: Partial<FormField>) => Object.assign(field, patch) },
  );
  const select = host.querySelector<HTMLSelectElement>(
    '[aria-label="默认值来源"]',
  )!;
  await fill(select, "formula", "change");
  expect(field.defaultFormula).toBe(true);
  expect(button(host, "编辑公式")).toBeTruthy();
  await fill(select, "custom", "change");
  expect(field.expression).toContain("ROUND");
  expect(field.defaultValue).toBe(999);
  expect(
    host.querySelector<HTMLInputElement>('[aria-label="自定义默认值"]')!.value,
  ).toBe("999");
  await fill(select, "linked", "change");
  expect(field.defaultFormula).toBe(false);
  expect(field.defaultLink?.enabled).toBe(true);
});
it("edits field-name chips atomically and supports help, replacement, remarks, debug and discard", async () => {
  const f = fixture(),
    field = reactive(f.total),
    updates: unknown[] = [];
  const host = await mount(
    FormulaEditor,
    { field, schema: f.schema },
    {
      onUpdate: (patch: Partial<FormField>) => {
        updates.push(patch);
        Object.assign(field, patch);
      },
    },
  );
  button(host, "编辑公式").click();
  await nextTick();
  const dialog = document.querySelector<HTMLDialogElement>(
    'dialog[aria-label="公式编辑"]',
  )!;
  expect(dialog.querySelector(".formula-input")!.textContent).toContain("数量");
  expect(dialog.querySelector(".formula-input")!.textContent).not.toContain(
    "{{quantity}}",
  );
  expect(dialog.querySelector("details[open] summary")?.textContent).toBe(
    "常用函数",
  );
  expect(dialog.querySelector("details[open]")?.textContent).toContain(
    "DATEDIF",
  );
  await fill(
    dialog.querySelector<HTMLInputElement>('[aria-label="搜索函数"]')!,
    "ROUND",
  );
  expect(
    Array.from(dialog.querySelectorAll("summary")).map(
      (item) => item.textContent,
    ),
  ).toEqual(["数学函数"]);
  expect(dialog.querySelector("details")?.open).toBe(true);
  button(dialog, "调试").click();
  await nextTick();
  await fill(
    dialog.querySelector<HTMLInputElement>('[aria-label="调试 数量"]')!,
    "4",
  );
  expect(dialog.textContent).toContain("13");
  button(dialog, "替换变量").click();
  await nextTick();
  await fill(
    dialog.querySelector<HTMLSelectElement>("#formula-replace-from")!,
    "quantity",
    "change",
  );
  await fill(
    dialog.querySelector<HTMLSelectElement>("#formula-replace-to")!,
    "price",
    "change",
  );
  button(dialog, "替换").click();
  await nextTick();
  button(dialog, "备注").click();
  await nextTick();
  await fill(
    dialog.querySelector<HTMLTextAreaElement>("#formula-remark")! as any,
    "单价平方",
  );
  expect(field.expression).toContain("quantity");
  button(dialog, "确定").click();
  await nextTick();
  expect(updates).toHaveLength(1);
  expect(field.expression).toBe("ROUND({{price}} * {{price}}, 2)");
  expect(field.formulaRemark).toBe("单价平方");
  button(host, "编辑公式").click();
  await nextTick();
  const reopened = document.querySelector('dialog[aria-label="公式编辑"]')!;
  const input = reopened.querySelector<HTMLElement>('[aria-label="公式内容"]')!;
  input.textContent = "1 / 0";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await nextTick();
  button(reopened, "取消").click();
  await nextTick();
  expect(reopened.querySelector('[aria-label="放弃公式修改？"]')).toBeTruthy();
  button(reopened, "放弃修改").click();
  await nextTick();
  expect(field.expression).toBe("ROUND({{price}} * {{price}}, 2)");
});
it("rejects malformed edits without replacing the saved expression", async () => {
  const f = fixture(),
    field = reactive(f.total),
    update = vi.fn();
  const host = await mount(
    FormulaEditor,
    { field, schema: f.schema },
    { onUpdate: update },
  );
  button(host, "编辑公式").click();
  await nextTick();
  const dialog = document.querySelector('dialog[aria-label="公式编辑"]')!,
    input = dialog.querySelector<HTMLElement>('[aria-label="公式内容"]')!;
  input.textContent = "DATEDELTA(1)";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await nextTick();
  button(dialog, "确定").click();
  await nextTick();
  expect(dialog.querySelector('[role="alert"]')?.textContent).toContain(
    "参数个数",
  );
  expect(update).not.toHaveBeenCalled();
  expect(input.textContent).toBe("DATEDELTA(1)");
});
it("submits actual formula values while reopening stored records without automatic replacement", async () => {
  const f = fixture(),
    submit = vi.fn(),
    persist = vi.fn().mockResolvedValue(true);
  const host = await mount(
    FormRuntime,
    { schema: f.schema, formId: "x", preview: false, persistValues: persist },
    { onSubmit: submit },
  );
  const quantity = host.querySelector<HTMLInputElement>(
    '[data-field-id="quantity"] input',
  )!;
  await fill(quantity, "4");
  button(host, "提交").click();
  await nextTick();
  await nextTick();
  expect(persist).toHaveBeenCalledWith(
    expect.objectContaining({
      total: 13,
      note: "大额\n金额：13.00",
      date: "2026-10-13",
    }),
    false,
  );
  expect(submit).toHaveBeenCalled();
  const original = {
    quantity: 1,
    price: 99,
    total: 0,
    name: "原等级",
    note: "原说明",
    date: "2026-01-01",
  };
  const reopened = await mount(FormRuntime, {
    schema: f.schema,
    formId: "old",
    initialValues: original,
  });
  expect(
    reopened.querySelector<HTMLInputElement>('[data-field-id="total"] input')!
      .value,
  ).toBe("0");
  expect(
    reopened.querySelector<HTMLTextAreaElement>(
      '[data-field-id="note"] textarea',
    )!.value,
  ).toBe("原说明");
});
it("submits currency changes and preserves the existing currency text when reopening a record", async () => {
  const amount = createField("number", {
    id: "amount",
    label: "金额",
    defaultValue: 1001.019,
  });
  const capital = createField("text", {
    id: "capital",
    label: "金额大写",
    defaultFormula: true,
    expression: "RMBCAP({{amount}})",
  });
  const schema = emptySchema();
  const names = createField("text", {
    id: "names",
    label: "去重部门",
    defaultFormula: true,
    expression: 'UNION(["销售","仓库","销售"])',
  });
  schema.fields = [amount, capital, names];
  const persist = vi.fn().mockResolvedValue(true);
  const host = await mount(FormRuntime, {
    schema,
    formId: "currency",
    preview: false,
    persistValues: persist,
  });
  await fill(
    host.querySelector<HTMLInputElement>('[data-field-id="amount"] input')!,
    "错误",
  );
  button(host, "提交").click();
  await nextTick();
  expect(persist).not.toHaveBeenCalled();
  expect(host.textContent).toContain("引用字段需要有效数字");
  await fill(
    host.querySelector<HTMLInputElement>('[data-field-id="amount"] input')!,
    "1.13",
  );
  expect(host.textContent).not.toContain("引用字段需要有效数字");
  expect(
    host.querySelector<HTMLInputElement>('[data-field-id="capital"] input')!
      .value,
  ).toBe("人民币壹元壹角叁分");
  button(host, "提交").click();
  await nextTick();
  await nextTick();
  expect(persist).toHaveBeenCalledWith(
    { amount: 1.13, capital: "人民币壹元壹角叁分", names: "销售;仓库" },
    false,
  );
  const reopened = await mount(FormRuntime, {
    schema,
    formId: "currency",
    initialValues: { amount: 1.13, capital: "原大写内容" },
  });
  expect(
    reopened.querySelector<HTMLInputElement>('[data-field-id="capital"] input')!
      .value,
  ).toBe("原大写内容");
});
