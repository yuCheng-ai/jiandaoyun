import { seedWorkspace } from "./fixtures/workspace";
import { describe, expect, it } from "vitest";
import { createField, emptySchema, isFieldVisible, prepareSubmission, parseSchema, validateValues, copy } from "../src/domain/form";
import { editableVisibilityRules, visibilityScopes } from "@platform/contracts";
import { buildRecordBlocks, defaultDetailSettings } from "../src/domain/presentation";

import type { ConditionalVisibilityRule, VisibilityCondition } from "@platform/contracts";

const condition = (sourceId: string, value: string, operator: VisibilityCondition["operator"] = "equals"): VisibilityCondition => ({ sourceId, operator, value });
const rule = (id: string, conditions: VisibilityCondition[], targetIds: string[], match: "all" | "any" = "all"): ConditionalVisibilityRule => ({ id, conditions, targetIds, match });
function sample() {
  const schema = emptySchema();
  schema.fields = [createField("text", { id: "a" }), createField("text", { id: "b" }), createField("text", { id: "detail", required: true }), createField("text", { id: "extra" })];
  const shown = (id: string, values: Record<string, unknown>) => isFieldVisible(schema.fields.find(field => field.id === id)!, schema, values);
  return { schema, shown };
}

describe("shared visibility rules", () => {
  it("ORs independent rules, supports all/any within one rule and keeps zero values", () => {
    const { schema, shown } = sample();
    schema.settings.rules = [rule("r1", [condition("a", "yes"), condition("b", "0")], ["detail"]), rule("r2", [condition("a", "alternate")], ["detail"])];
    expect(shown("detail", { a: "yes", b: 0 })).toBe(true);
    expect(shown("detail", { a: "alternate", b: 3 })).toBe(true);
    expect(shown("detail", { a: "yes", b: 3 })).toBe(false);
    schema.settings.rules = [rule("r3", [condition("a", "yes"), condition("b", "0")], ["detail"], "any")];
    expect(shown("detail", { a: "no", b: 0 })).toBe(true);
    expect(shown("detail", { a: "no", b: 1 })).toBe(false);
  });
  it("preserves historical overlapping AND rules on parse and exact conversion", () => {
    const { schema, shown } = sample();
    schema.settings.rules = [
      { id: "old1", ...condition("a", "yes"), targetIds: ["detail", "extra"] },
      { id: "old2", ...condition("b", "yes"), targetIds: ["detail"] },
    ];
    const original = copy(schema);
    expect(parseSchema(schema).settings.rules).toEqual(original.settings.rules);
    const compiled = editableVisibilityRules(schema.settings.rules);
    expect(compiled.find(rule => rule.targetIds.includes("detail"))?.conditions).toHaveLength(2);
    const cases = [{ a: "yes", b: "yes" }, { a: "yes", b: "no" }, { a: "no", b: "yes" }];
    const before = cases.map(values => [shown("detail", values), shown("extra", values)]);
    schema.settings.rules = compiled;
    expect(cases.map(values => [shown("detail", values), shown("extra", values)])).toEqual(before);
    expect(parseSchema(schema).settings.rules).toEqual(compiled);
    expect(original.settings.rules[0]).not.toHaveProperty("conditions");
  });
  it("keeps the legacy bundle conjunctive when modern rules are added", () => {
    const { schema, shown } = sample();
    schema.settings.rules = [
      { id: "old1", ...condition("a", "yes"), targetIds: ["detail"] },
      { id: "old2", ...condition("b", "yes"), targetIds: ["detail"] },
      rule("new", [condition("a", "new")], ["detail"]),
    ];
    expect(shown("detail", { a: "yes", b: "no" })).toBe(false);
    expect(shown("detail", { a: "new", b: "no" })).toBe(true);
  });
  it("cascades rule-hidden sources while permission-hidden values still participate", () => {
    const { schema, shown } = sample();
    schema.settings.rules = [rule("r1", [condition("a", "yes")], ["b"]), rule("r2", [condition("b", "retained")], ["detail"])];
    expect(shown("detail", { a: "no", b: "retained" })).toBe(false);
    schema.fields[1]!.visible = false;
    expect(shown("b", { a: "yes", b: "retained" })).toBe(false);
    expect(shown("detail", { a: "yes", b: "retained" })).toBe(true);
    schema.settings.rules = [
      { id: "old1", ...condition("a", "yes"), targetIds: ["b"] },
      { id: "old2", ...condition("b", "retained"), targetIds: ["detail"] },
    ];
    expect(shown("detail", { a: "no", b: "retained" })).toBe(true);
    schema.settings.rules = editableVisibilityRules(schema.settings.rules);
    expect(shown("detail", { a: "no", b: "retained" })).toBe(true);
  });
  it("handles circular chains without recursion failures; an independent matching branch can show a field", () => {
    const { schema, shown } = sample();
    schema.settings.rules = [rule("cycle1", [condition("a", "yes")], ["b"]), rule("cycle2", [condition("b", "yes")], ["a"])];
    expect(shown("a", { a: "yes", b: "yes" })).toBe(false);
    schema.settings.rules.push(rule("independent", [condition("extra", "yes")], ["a"]));
    expect(shown("b", { a: "yes", b: "yes", extra: "yes" })).toBe(true);
  });
  it("uses Other identity and multi-choice identities for conditions", () => {
    const { schema, shown } = sample();
    schema.settings.rules = [rule("other", [condition("a", "other")], ["detail"]), rule("multi", [condition("b", "selected", "contains")], ["extra"])];
    expect(shown("detail", { a: { optionId: "other", text: "原因" } })).toBe(true);
    expect(shown("extra", { b: ["selected", { text: "自定义" }] })).toBe(true);
    expect(shown("extra", { b: [{ text: "selected" }] })).toBe(true);
  });
  it("rejects invalid grouped conditions as a whole without silently broadening rules", () => {
    const { schema } = sample();
    for (const bad of [
      rule("missing", [condition("a", "yes"), condition("missing", "yes")], ["detail"]),
      rule("empty", [], ["detail"]),
      rule("self", [condition("detail", "yes")], ["detail"]),
      { ...rule("operator", [condition("a", "yes")], ["detail"]), conditions: [{ ...condition("a", "yes"), operator: "execute" }] },
      { ...rule("value", [condition("a", "yes")], ["detail"]), conditions: [{ ...condition("a", "yes"), value: {} }] },
    ]) {
      schema.settings.rules = [bad as ConditionalVisibilityRule];
      expect(() => parseSchema(schema)).toThrow();
    }
  });
  it("keeps tab fields in the main scope and subform fields within their own rows", () => {
    const { schema } = sample();
    const rows = createField("subform", { id: "rows", children: [createField("text", { id: "rowFlag" }), createField("text", { id: "rowDetail", required: true })] });
    schema.fields.push(createField("tabs", { id: "tabs", children: [createField("text", { id: "tabFlag" })] }), rows);
    expect(visibilityScopes(schema.fields).map(scope => [scope.id, scope.fields.map(field => field.id)])).toEqual([
      ["", ["a", "b", "detail", "extra", "tabs", "tabFlag", "rows"]], ["rows", ["rowFlag", "rowDetail"]],
    ]);
    schema.settings.rules = [rule("row", [condition("rowFlag", "yes")], ["rowDetail"])];
    const values = { detail: "ok", rows: [{ rowFlag: "no", rowDetail: "retained" }, { rowFlag: "yes", rowDetail: "" }] };
    expect(validateValues(schema, values).map(error => error.path)).toEqual(["rows.1.rowDetail"]);
    schema.settings.hiddenValues = "clear";
    expect(prepareSubmission(schema, values).rows).toEqual([{ rowFlag: "no" }, { rowFlag: "yes", rowDetail: "" }]);
    const blocks = buildRecordBlocks(schema, { ...values, rows: [values.rows[0], { rowFlag: "yes", rowDetail: "已填写" }] }, defaultDetailSettings(), seedWorkspace());
    expect(blocks.find(block => block.id === "rows")?.rows).toEqual([["no", "—"], ["yes", "已填写"]]);
    schema.settings.rules = [rule("cross", [condition("a", "yes")], ["rowDetail"])];
    expect(() => parseSchema(schema)).toThrow("同一子表单");
    schema.settings.rules = [rule("main", [condition("tabFlag", "yes")], ["rows"])];
    expect(parseSchema(schema).settings.rules).toEqual(schema.settings.rules);
  });
});
