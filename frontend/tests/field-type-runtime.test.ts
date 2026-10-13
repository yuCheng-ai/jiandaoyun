import { describe, expect, it } from "vitest";
import { copy, createField, fieldTypePatch, isFieldVisible, parseSchema } from "../src/domain/form";
import { newForm, seedWorkspace, type FormEntry } from "../src/domain/workspace";
import { defaultAccess, groupsForEntry, newAccessGroup } from "../src/domain/access";
import { conditionValues } from "@platform/contracts";
import { matchesFilters, relationCandidates } from "../src/domain/relations";
import { parseFilters } from "../src/domain/fieldConfig";
import { parseWorkspace } from "../src/repositories/workspaceRepository";

function fixture() {
  const data = seedWorkspace();
  const form = newForm("oa", "类型与权限");
  const field = createField("select", { id: "category", options: [{ id: "a", label: "甲" }, { id: "b", label: "乙" }] });
  form.schema.fields = [field, createField("text", { id: "detail" })];
  const publish = () => {
    const version = { version: form.versions.length + 1, title: form.title, schema: copy(form.schema), workflow: copy(form.workflow), publishedAt: "2026-10-11" };
    form.versions.push(version); form.published = copy(version);
  };
  publish();
  const entry = (id: string, version: number, value: unknown): FormEntry => ({ id, formId: form.id, definitionVersion: version, values: { category: value }, createdAt: "2026-10-11", createdBy: "zhang", status: "submitted", history: [] });
  data.forms = [form];
  data.entries = [entry("old-a", 1, "a"), entry("old-b", 1, "b")];
  const filter = { id: "condition", sourceFieldId: field.id, source: "constant" as const, operator: "equals" as const, value: "a" };
  const group = newAccessGroup(form.schema, "read");
  group.identities = ["zhang"]; group.scope = "custom"; group.filters = [filter];
  data.formAccess = { [form.id]: { ...defaultAccess(), membersEnabled: true, groups: [group] } };
  return { data, form, field, entry, publish, filter, group };
}

describe("converted fields retain condition and record meaning", () => {
  it("keeps existing member scopes across old choice records and new text records, including not-equals", () => {
    const { data, form, field, entry, publish, group } = fixture();
    const original = copy(form.versions[0]);
    Object.assign(field, fieldTypePatch(field, "text"));
    publish();
    data.entries.push(entry("new-a", 2, "甲"), entry("new-b", 2, "乙"));
    const readable = () => data.entries.filter(entry => groupsForEntry(data, entry, "zhang").length).map(entry => entry.id);
    expect(readable()).toEqual(["old-a", "new-a"]);
    group.filters[0]!.operator = "notEquals";
    expect(readable()).toEqual(["old-b", "new-b"]);
    expect(form.versions[0]).toEqual(original);
    expect(data.entries[0]!.values.category).toBe("a");
    const parsed = parseWorkspace(JSON.stringify(data));
    expect(parsed.entries.filter(entry => groupsForEntry(parsed, entry, "zhang").length).map(entry => entry.id)).toEqual(["old-b", "new-b"]);
  });

  it("does not widen negative scopes when the old identity cannot be resolved", () => {
    const { data, field, entry, publish, group } = fixture();
    Object.assign(field, fieldTypePatch(field, "text")); publish();
    const record = entry("new", 2, "任意文字");
    group.filters[0]!.value = "missing-option";
    group.filters[0]!.operator = "notEquals";
    expect(groupsForEntry(data, record, "zhang")).toEqual([]);
    record.definitionVersion = 999;
    expect(groupsForEntry(data, record, "zhang")).toEqual([]);
  });

  it("distinguishes a newly entered literal ID from the old option identity", () => {
    const { data, field, entry, publish, group } = fixture();
    Object.assign(field, fieldTypePatch(field, "text")); publish();
    group.filters = parseFilters([{ ...group.filters[0], value: "a", valueType: "text" }]);
    expect(groupsForEntry(data, entry("literal", 2, "a"), "zhang")).toHaveLength(1);
    expect(groupsForEntry(data, entry("label", 2, "甲"), "zhang")).toEqual([]);
    expect(groupsForEntry(data, data.entries[0]!, "zhang")).toEqual([]);
  });

  it("supports a text-to-choice-to-text round trip without confusing new choice conditions with legacy text conditions", () => {
    const { data, form, field, entry, publish, group } = fixture();
    field.type = "text"; field.options = []; form.versions = []; publish();
    group.filters[0]!.value = "甲";
    Object.assign(field, fieldTypePatch(field, "radio"));
    field.options = [{ id: "new-a", label: "甲" }, { id: "new-b", label: "乙" }]; publish();
    expect(groupsForEntry(data, entry("new", 2, "new-a"), "zhang")).toHaveLength(1);
    group.filters[0] = { ...group.filters[0]!, value: "new-a", valueType: "choice" };
    expect(groupsForEntry(data, entry("old-text", 1, "甲"), "zhang")).toHaveLength(1);
    Object.assign(field, fieldTypePatch(field, "text")); publish();
    expect(groupsForEntry(data, entry("latest", 3, "甲"), "zhang")).toHaveLength(1);
    expect(groupsForEntry(data, entry("wrong", 3, "new-a"), "zhang")).toEqual([]);
  });

  it("preserves choice identity when equal labels coexist, even after a round trip", () => {
    const { field } = fixture();
    Object.assign(field, fieldTypePatch(field, "text"));
    Object.assign(field, fieldTypePatch(field, "select"));
    field.options = [{ id: "one", label: "同名" }, { id: "two", label: "同名" }];
    const pair = conditionValues(field, field, "two", "one", "choice")!;
    expect(pair.actual).not.toEqual(pair.expected);
  });

  it("retains main and subform visibility conditions, including a negative condition", () => {
    const { form, field } = fixture();
    form.schema.settings.rules = [{ id: "show", sourceId: field.id, operator: "notEquals", value: "a", targetIds: ["detail"] }];
    const original = copy(form.schema);
    Object.assign(field, fieldTypePatch(field, "text"));
    const schema = parseSchema(form.schema);
    expect(isFieldVisible(schema.fields[1]!, schema, { category: "甲" })).toBe(false);
    expect(isFieldVisible(schema.fields[1]!, schema, { category: "乙" })).toBe(true);
    expect(isFieldVisible(original.fields[1]!, original, { category: "a" })).toBe(false);
    schema.fields = [createField("subform", { children: schema.fields })];
    expect(isFieldVisible(schema.fields[0]!.children[1]!, schema, { category: "乙" })).toBe(true);
  });

  it("uses each related record's version rather than treating old option IDs as new text", () => {
    const { data, form, field, filter, entry, publish } = fixture();
    Object.assign(field, fieldTypePatch(field, "text")); publish();
    data.entries.push(entry("new-a", 2, "甲"), entry("new-b", 2, "乙"));
    const relation = createField("relation", { referenceFormId: form.id });
    relation.reference.filters = [filter];
    expect(relationCandidates(relation, data, {}).map(entry => entry.id)).toEqual(["old-a", "new-a"]);
    relation.reference.filters[0]!.operator = "notEquals";
    expect(relationCandidates(relation, data, {}).map(entry => entry.id)).toEqual(["old-b", "new-b"]);
  });

  it("cannot turn an unresolvable 'other' category into an allow-all negative filter", () => {
    const { data, field, filter } = fixture();
    field.options = [{ id: "other", label: "其他", other: true }];
    Object.assign(field, fieldTypePatch(field, "text"));
    expect(matchesFilters([{ ...filter, operator: "notEquals", value: "other" }], { category: "任意文字" }, {}, data, "all", [field])).toBe(false);
  });

  it("compares independent Other selections by their displayed content and does not treat a blank supplement as an empty answer", () => {
    const { data, field, filter } = fixture();
    field.options.push({ id: "other", label: "其他", other: true });
    const input = createField("text", { id: "input" });
    const match = (actual: unknown, expected: unknown, negative = false) => matchesFilters(
      [{ ...filter, source: "field", value: input.id, operator: negative ? "notEquals" : "equals" }],
      { category: actual }, { input: expected }, data, "all", [field], [field], [input],
    );
    expect(match({ optionId: "other", text: "成都仓" }, "成都仓")).toBe(true);
    expect(match({ optionId: "other", text: "成都仓" }, "北京仓")).toBe(false);
    expect(match({ optionId: "other", text: "" }, "其他")).toBe(true);
    expect(match("other", "其他")).toBe(true);
    expect(match({ optionId: "missing", text: "成都仓" }, "北京仓", true)).toBe(false);
    const reverse = { ...filter, sourceFieldId: input.id, source: "field" as const, value: field.id };
    expect(matchesFilters([reverse], { input: "" }, { category: { optionId: "other", text: "" } }, data, "all", [input], [input], [field])).toBe(false);
    expect(matchesFilters([reverse], { input: "其他" }, { category: { optionId: "other", text: "" } }, data, "all", [input], [input], [field])).toBe(true);
  });

  it("keeps historical Other categories separate from new text while text filters search the original supplementary content", () => {
    const { data, form, field, entry, publish, group } = fixture();
    field.options.push({ id: "other", label: "其他", other: true });
    form.versions = []; publish();
    data.entries.push(entry("old-detail", 1, { optionId: "other", text: "成都仓" }), entry("old-empty", 1, { optionId: "other", text: "" }), entry("old-default", 1, "other"));
    const original = copy(data.entries);
    Object.assign(field, fieldTypePatch(field, "text")); publish();
    data.entries.push(entry("new-detail", 2, "成都仓"), entry("new-other", 2, "其他"), entry("new-empty", 2, ""));
    const visible = () => data.entries.filter(record => groupsForEntry(data, record, "zhang").length).map(record => record.id);
    group.filters[0]!.value = "other";
    expect(visible()).toEqual(["old-detail", "old-empty", "old-default"]);
    group.filters[0]!.operator = "notEquals";
    expect(visible()).toEqual(["old-a", "old-b"]);
    group.filters[0] = { ...group.filters[0]!, operator: "equals", value: "成都仓", valueType: "text" };
    expect(visible()).toEqual(["old-detail", "new-detail"]);
    group.filters[0]!.value = "其他";
    expect(visible()).toEqual(["old-empty", "old-default", "new-other"]);
    expect(conditionValues(field, field, "", "其他", "text")).toEqual({ actual: "", expected: "其他" });
    expect(parseWorkspace(JSON.stringify(data)).entries.slice(0, original.length)).toMatchObject(original);
  });

  it("never snapshots dynamic-source business values and preserves the old version's identity comparison", () => {
    const { data, field, filter } = fixture();
    field.choiceSource.mode = "form";
    field.options = [{ id: "unused", label: "不能当作动态数据快照" }];
    const original = copy(field);
    Object.assign(field, fieldTypePatch(field, "text"));
    expect(field.choiceConversion!.options).toEqual([]);
    const negative = { ...filter, operator: "notEquals" as const, value: "dynamic-a" };
    expect(matchesFilters([negative], { category: "dynamic-b" }, {}, data, "all", [field], [original])).toBe(true);
    expect(matchesFilters([negative], { category: "新文字" }, {}, data, "all", [field], [field])).toBe(false);
  });

  it("rejects corrupt conversion metadata or condition kinds rather than losing their semantics on reload", () => {
    const { form, field } = fixture();
    Object.assign(field, fieldTypePatch(field, "text"));
    field.choiceConversion!.options.push(copy(field.choiceConversion!.options[0]!));
    expect(() => parseSchema(form.schema)).toThrow("转换");
    expect(() => parseFilters([{ id: "f", source: "constant", operator: "equals", valueType: "unexpected" }])).toThrow("条件值类型");
  });
});
