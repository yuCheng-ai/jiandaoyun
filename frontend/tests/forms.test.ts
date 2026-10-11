// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import {
  createField,
  emptySchema,
  parseSchema,
  duplicateField,
  moveField,
  defaultValues,
  validateValues,
  resolveCalculations,
  calculate,
  prepareSubmission,
} from "../src/domain/form";

describe("form schema and runtime", () => {
  it("migrates submission settings and rejects unknown display modes", () => {
    const legacy = emptySchema() as any;
    delete legacy.settings.successMode;
    delete legacy.settings.allowAnotherSubmission;
    delete legacy.settings.allowSubmit;
    delete legacy.settings.draftLabel;
    expect(parseSchema(legacy).settings).toMatchObject({
      successMode: "inline",
      allowAnotherSubmission: true,
      allowSubmit: true,
      draftLabel: "保存草稿",
    });
    legacy.settings.successMode = "redirect-script";
    expect(parseSchema(legacy).settings.successMode).toBe("inline");
    legacy.settings.successMode = "page";
    legacy.settings.allowAnotherSubmission = false;
    legacy.settings.allowSubmit = false;
    legacy.settings.draftLabel = "暂存";
    expect(parseSchema(legacy).settings).toMatchObject({
      successMode: "page",
      allowAnotherSubmission: false,
      allowSubmit: false,
      draftLabel: "暂存",
    });
  });
  it("roundtrips numeric defaults, options, nested fields and stable ids", () => {
    const schema = emptySchema();
    const number = createField("number", { defaultValue: 42, min: 0 });
    const tabs = createField("tabs", { children: [number] });
    number.tabId = tabs.tabs[0]!.id;
    schema.fields = [tabs, createField("checkbox", { defaultValue: ["one"] })];
    const restored = parseSchema(JSON.parse(JSON.stringify(schema)));
    expect(restored).toEqual(schema);
    expect(defaultValues(restored.fields)[number.id]).toBe(42);
  });
  it("rejects duplicate ids, unsupported types, prototype keys and invalid nesting", () => {
    const schema = emptySchema();
    const field = createField("text");
    schema.fields = [field, field];
    expect(() => parseSchema(schema)).toThrow();
    schema.fields = [{ ...field, id: "__proto__" }];
    expect(() => parseSchema(schema)).toThrow();
    schema.fields = [
      createField("subform", { children: [createField("tabs")] }),
    ];
    expect(() => parseSchema(schema)).toThrow();
  });
  it("copies containers with remapped field ids, tab ids and formula references", () => {
    const n = createField("number");
    const c = createField("calculated", { expression: `{{${n.id}}}*2` });
    const container = createField("tabs", { children: [n, c] });
    n.tabId = container.tabs[0]!.id;
    const duplicate = duplicateField(container);
    expect(duplicate.id).not.toBe(container.id);
    expect(duplicate.children[0]!.tabId).toBe(duplicate.tabs[0]!.id);
    expect(duplicate.children[1]!.expression).toBe(
      `{{${duplicate.children[0]!.id}}}*2`,
    );
    expect(container.children[1]!.expression).toContain(n.id);
  });
  it("moves between containers without cycles or duplicate references", () => {
    const a = createField("text");
    const b = createField("number");
    const tab = createField("tabs");
    const fields = [a, b, tab];
    expect(moveField(fields, a.id, tab.id, 0, tab.tabs[0]!.id)).toBe(true);
    expect(fields).toHaveLength(2);
    expect(tab.children[0]).toBe(a);
    expect(moveField(fields, tab.id, tab.id, 0)).toBe(false);
    const nested = createField("tabs");
    tab.children.push(nested);
    expect(moveField(fields, tab.id, nested.id, 0)).toBe(false);
  });
  it("validates visible fields, uniqueness and precise child error paths", () => {
    const schema = emptySchema();
    const kind = createField("text");
    const detail = createField("text", { required: true });
    const n = createField("number", { min: 1, required: true });
    const rows = createField("subform", { children: [n] });
    const unique = createField("text", { unique: true });
    schema.fields = [kind, detail, rows, unique];
    schema.settings.rules = [
      {
        id: "rule",
        sourceId: kind.id,
        operator: "equals",
        value: "yes",
        targetIds: [detail.id],
      },
    ];
    expect(validateValues(schema, { [kind.id]: "no" })).toEqual([]);
    const errors = validateValues(
      schema,
      { [kind.id]: "yes", [rows.id]: [{ [n.id]: 0 }], [unique.id]: "A" },
      [{ [unique.id]: "A" }],
    );
    expect(errors.map((e) => e.path)).toEqual([
      detail.id,
      `${rows.id}.0.${n.id}`,
      unique.id,
    ]);
  });
  it("rejects empty address and empty rich text as required values", () => {
    const schema = emptySchema();
    const address = createField("address", { required: true });
    const rich = createField("richtext", { required: true });
    schema.fields = [address, rich];
    expect(
      validateValues(schema, {
        [address.id]: { province: "", city: "" },
        [rich.id]: "<p><br></p>",
      }),
    ).toHaveLength(2);
  });
  it("evaluates arithmetic dependencies safely and keeps subform rows isolated", () => {
    const n = createField("number");
    const a = createField("calculated", { expression: `{{${n.id}}}*2` });
    const b = createField("calculated", { expression: `{{${a.id}}}+3` });
    const rows = createField("subform", { children: [b, n, a] });
    const values = resolveCalculations([rows], {
      [rows.id]: [{ [n.id]: 4 }, { [n.id]: 10 }],
    });
    expect(values[a.id]).toBeUndefined();
    expect((values[rows.id] as any[]).map((r) => r[b.id])).toEqual([11, 23]);
    expect(calculate("globalThis.alert(1)", {})).toBeNull();
    expect(calculate("1/0", {})).toBeNull();
    a.expression = `{{${b.id}}}`;
    expect(resolveCalculations([a, b], {})[a.id]).toBeNull();
  });
  it("clears hidden nested values, strips unknown fields and preserves legacy serial generation", () => {
    const hidden = createField("text", { visible: false });
    const tabs = createField("tabs", {
      visible: false,
      children: [createField("text")],
    });
    const rows = createField("subform", { children: [hidden] });
    const serial = createField("serial", { serial: undefined });
    const schema = emptySchema();
    schema.fields = [tabs, rows, serial];
    schema.settings.hiddenValues = "clear";
    const result = prepareSubmission(schema, {
      [tabs.children[0]!.id]: "secret",
      [rows.id]: [{ [hidden.id]: "hidden", unknown: "drop" }],
      unknown: "drop",
    });
    expect(result[tabs.children[0]!.id]).toBeUndefined();
    expect(result[rows.id]).toEqual([{}]);
    expect(result.unknown).toBeUndefined();
    expect(String(result[serial.id])).toMatch(/^SN/);
  });
});
