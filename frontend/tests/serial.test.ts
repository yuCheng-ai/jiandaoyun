import { afterEach, describe, expect, it, vi } from "vitest";

import {
  formatSerialDate,
  parseSerialSettings,
  serialDateFormats,
  serialSettingsErrors,
} from "@platform/contracts";
import {
  createField,
  emptySchema,
  parseSchema,
  prepareSubmission,
  copy,
} from "../src/domain/form";
import {
  allocateSerialValues,
  parseSerialCounters,
  serialConfigurationErrors,
} from "../src/domain/serial";
import { validateFieldConfiguration } from "../src/domain/fieldValidation";

import { seedWorkspace } from "../src/domain/workspace";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("serial rules and numbering", () => {
  it("preserves old definitions and generates nothing during new form preview/preparation", () => {
    const schema = emptySchema();
    schema.fields = [createField("serial", { id: "serial" })];
    expect(prepareSubmission(schema, {}).serial).toBe("");
    const legacy = copy(schema);
    delete legacy.fields[0]!.serial;
    expect(parseSchema(legacy).fields[0]!.serial).toBeUndefined();
    expect(prepareSubmission(parseSchema(legacy), {}).serial).toMatch(/^SN/);
    expect(
      prepareSubmission(parseSchema(legacy), { serial: "旧号" }).serial,
    ).toBe("旧号");
    expect(parseSchema(schema).fields[0]!.serial).toEqual(
      schema.fields[0]!.serial,
    );
  });
  it("combines all four ordered rules, choice labels, zero and post-generation calculations without mutating input", () => {
    const schema = emptySchema(),
      data = seedWorkspace(),
      serial = createField("serial", { id: "serial" });
    serial.serial!.rules = [
      { id: "text", type: "text", value: "JDY-" },
      { id: "date", type: "date", mode: "preset", format: "yyyyMMdd" },
      { id: "c", type: "counter" },
      { id: "f", type: "field", fieldId: "kind" },
      { id: "n", type: "field", fieldId: "zero" },
    ];
    schema.fields = [
      serial,
      createField("select", {
        id: "kind",
        options: [{ id: "a", label: "销售" }],
      }),
      createField("number", { id: "zero" }),
      createField("calculated", {
        id: "length",
        expression: "LEN({{serial}})",
      }),
    ];
    const values = { kind: "a", zero: 0 };
    const result = allocateSerialValues(
      schema,
      values,
      data,
      "f",
      new Date("2026-10-10T17:00:00Z"),
    );
    expect(result.values.serial).toBe("JDY-2026101100001销售0");
    expect(result.values.length).toBe(20);
    expect(data.serialCounters).toBeUndefined();
    expect(values).toEqual({ kind: "a", zero: 0 });
    expect(
      allocateSerialValues(
        schema,
        values,
        { ...data, serialCounters: result.counters },
        "f",
        new Date("2026-10-10T17:00:00Z"),
      ).values.serial,
    ).toContain("00002");
  });
  it("wraps to zero, honors nonfixed widths and Beijing day/month/year boundaries with independent cycle counters", () => {
    const schema = emptySchema(),
      serial = createField("serial", { id: "serial" }),
      data = seedWorkspace();
    schema.fields = [serial];
    Object.assign(serial.serial!, { digits: 2, initial: 99, fixed: false });
    const issue = (time: string) => {
      const result = allocateSerialValues(
        schema,
        {},
        data,
        "f",
        new Date(time),
      );
      data.serialCounters = result.counters;
      return result.values.serial;
    };
    expect(issue("2026-12-31T15:59:59Z")).toBe("99");
    expect(issue("2026-12-31T15:59:59Z")).toBe("0");
    for (const cycle of ["day", "month", "year"] as const) {
      serial.serial!.reset = cycle;
      serial.serial!.initial = 7;
      expect(issue("2026-12-31T15:59:59Z")).toBe("7");
      expect(issue("2026-12-31T15:59:59Z")).toBe("8");
      expect(issue("2026-12-31T16:00:00Z")).toBe("7");
    }
    serial.serial!.reset = "day";
    expect(issue("2026-12-31T16:00:00Z")).toBe("8");
    serial.serial!.reset = "none";
    expect(issue("2026-12-31T16:00:00Z")).toBe("1");
    expect(
      allocateSerialValues(
        schema,
        {},
        data,
        "anotherForm",
        new Date("2027-01-01"),
      ).values.serial,
    ).toBe("7");
  });
  it("supports the ten source date presets and custom formats", () => {
    const time = new Date("2015-01-01T00:00:00+08:00");
    expect(serialDateFormats.map((f) => formatSerialDate(f, time))).toEqual([
      "2015",
      "201501",
      "2015-01",
      "2015/01",
      "20150101",
      "2015-01-01",
      "2015/01/01",
      "0101",
      "01-01",
      "01/01",
    ]);
    expect(formatSerialDate("yy年M月d日", time)).toBe("15年1月1日");
  });
  it("rejects invalid rules, missing or child sources and circular field dependencies at publication", () => {
    const schema = emptySchema(),
      serial = createField("serial", { id: "serial" });
    schema.fields = [serial];
    expect(
      serialSettingsErrors({
        ...serial.serial!,
        digits: 1,
        initial: -1,
        rules: [],
      }),
    ).toHaveLength(3);
    serial.serial!.rules.push({ id: "f", type: "field", fieldId: "name" });
    expect(serialConfigurationErrors(serial, schema)).toContain(
      "流水号引用字段已删除或不支持，请重新选择",
    );
    schema.fields.push(
      createField("text", {
        id: "name",
        defaultFormula: true,
        expression: "{{serial}}",
      }),
    );
    expect(
      validateFieldConfiguration(schema, seedWorkspace()).join(" "),
    ).toMatch(/循环/);
    schema.fields = [
      createField("subform", {
        id: "rows",
        children: [serial, createField("text", { id: "name" })],
      }),
    ];
    expect(serialConfigurationErrors(serial, schema)).toContain(
      "流水号只能添加在主表中",
    );
    expect(() =>
      parseSerialSettings({
        ...serial.serial,
        rules: [
          { id: "x", type: "counter" },
          { id: "x", type: "counter" },
        ],
      }),
    ).toThrow();
  });
  it("does not silently restart corrupt persisted counters", () => {
    for (const raw of [
      [],
      null,
      { f: { s: { none: { period: "all", next: -1 } } } },
      { f: { s: { none: { period: "all", next: 1.5 } } } },
      { f: { s: { day: { period: "all", next: 2 } } } },
      { f: { s: { month: { period: "2026-13", next: 2 } } } },
      JSON.parse('{"__proto__":{}}'),
    ])
      expect(() => parseSerialCounters(raw)).toThrow();
  });
  it("preserves empty and zero historical numbers in their own subform rows", () => {
    const schema = emptySchema(),
      serial = createField("serial", { id: "serial" });
    delete serial.serial;
    schema.fields = [
      createField("subform", { id: "rows", children: [serial] }),
    ];
    expect(
      prepareSubmission(
        schema,
        { rows: [{ serial: "" }, { serial: 0 }] },
        { rows: [{ serial: "旧号一" }, { serial: "旧号二" }] },
      ),
    ).toEqual({ rows: [{ serial: "" }, { serial: 0 }] });
  });
});
