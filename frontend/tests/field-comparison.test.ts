import { seedWorkspace } from "./fixtures/workspace";
import { describe, expect, it } from "vitest";
import {
  createField,
  copy,
  emptySchema,
  fieldTypePatch,
} from "../src/domain/form";
import {
  newForm,
  type FormEntry,
} from "../src/domain/workspace";
import {
  applyFieldChange,
  linkedDefault,
  matchesFilters,
  relationCandidates,
  resolveChoices,
} from "../src/domain/relations";
import { validateDynamicValues } from "../src/domain/fieldValidation";
import { importFieldValue } from "../src/domain/recordImport";
import { quickFillValue } from "../src/domain/quickFill";
import { fieldConditionValues } from "@platform/contracts";

function fixture() {
  const data = seedWorkspace();
  const source = newForm("oa", "商品目录");
  const category = createField("select", {
    id: "category",
    options: [
      { id: "source-a", label: "甲" },
      { id: "source-b", label: "乙" },
    ],
  });
  const name = createField("text", { id: "name" });
  source.schema.fields = [category, name];
  const publish = () => {
    const version = {
      version: source.versions.length + 1,
      title: source.title,
      schema: copy(source.schema),
      workflow: copy(source.workflow),
      publishedAt: "2026-10-11",
    };
    source.versions.push(version);
    source.published = copy(version);
  };
  publish();
  data.forms = [source];
  const record = (id: string, value: string, version = 1): FormEntry => ({
    id,
    formId: source.id,
    definitionVersion: version,
    values: { category: value, name: id },
    status: "submitted",
    createdBy: "zhang",
    createdAt: "2026-10-11",
    history: [],
  });
  data.entries = [record("商品甲", "source-a"), record("商品乙", "source-b")];
  const input = createField("select", {
    id: "input",
    options: [
      { id: "local-a", label: "甲" },
      { id: "local-b", label: "乙" },
    ],
  });
  const filter = {
    id: "filter",
    sourceFieldId: category.id,
    operator: "equals" as const,
    source: "field" as const,
    value: input.id,
  };
  const choice = createField("select", { id: "product" });
  choice.choiceSource = {
    ...choice.choiceSource,
    mode: "form",
    formId: source.id,
    labelFieldId: name.id,
    filters: [filter],
  };
  const relation = createField("relation", {
    id: "relation",
    referenceFormId: source.id,
  });
  relation.reference.filters = [filter];
  const linked = createField("text", {
    id: "linked",
    defaultLink: {
      enabled: true,
      formId: source.id,
      fieldId: name.id,
      filters: [filter],
      match: "all",
    },
  });
  const schema = emptySchema();
  schema.fields = [input, choice, relation, linked];
  return {
    data,
    source,
    category,
    input,
    choice,
    relation,
    linked,
    schema,
    filter,
    publish,
    record,
  };
}

describe("field comparisons use each side's business value", () => {
  it("compares independently identified choices through options, relations and linked defaults", () => {
    const f = fixture(),
      values = { input: "local-a" };
    expect(
      resolveChoices(f.choice, f.data, values, f.schema.fields).map(
        (o) => o.id,
      ),
    ).toEqual(["商品甲"]);
    expect(
      relationCandidates(f.relation, f.data, values, "", f.schema.fields).map(
        (e) => e.id,
      ),
    ).toEqual(["商品甲"]);
    expect(linkedDefault(f.linked, f.data, values, f.schema.fields)).toBe(
      "商品甲",
    );
  });

  it("keeps old choice versions and new text versions in the same source filter", () => {
    const f = fixture();
    Object.assign(f.category, fieldTypePatch(f.category, "text"));
    f.publish();
    f.data.entries.push(
      f.record("新商品甲", "甲", 2),
      f.record("新商品乙", "乙", 2),
    );
    const values = { input: "local-a" };
    expect(
      resolveChoices(f.choice, f.data, values, f.schema.fields).map(
        (o) => o.id,
      ),
    ).toEqual(["商品甲", "新商品甲"]);
    Object.assign(f.input, fieldTypePatch(f.input, "text"));
    expect(
      relationCandidates(
        f.relation,
        f.data,
        { input: "甲" },
        "",
        f.schema.fields,
      ).map((e) => e.id),
    ).toEqual(["商品甲", "新商品甲"]);
    expect(
      relationCandidates(
        f.relation,
        f.data,
        { input: "source-a" },
        "",
        f.schema.fields,
      ),
    ).toEqual([]);
    expect(f.source.versions[0]!.schema.fields[0]!.type).toBe("select");
    expect(f.data.entries[0]!.values.category).toBe("source-a");
  });

  it("does not turn a missing choice, field or pinned version into a passing negative filter", () => {
    const f = fixture();
    f.relation.reference.filters[0]!.operator = "notEquals";
    expect(
      relationCandidates(
        f.relation,
        f.data,
        { input: "missing" },
        "",
        f.schema.fields,
      ),
    ).toEqual([]);
    expect(
      relationCandidates(f.relation, f.data, { input: "local-a" }, "", []),
    ).toEqual([]);
    f.data.entries[1]!.definitionVersion = 999;
    expect(
      relationCandidates(
        f.relation,
        f.data,
        { input: "local-a" },
        "",
        f.schema.fields,
      ),
    ).toEqual([]);
    Object.assign(f.input, fieldTypePatch(f.input, "text"));
    expect(
      relationCandidates(
        f.relation,
        f.data,
        { input: "甲" },
        "",
        f.schema.fields,
      ),
    ).toEqual([]);
  });

  it("preserves identity within one field and compares multiple choices and other text across fields", () => {
    const f = fixture();
    f.input.options = [
      { id: "one", label: "同名" },
      { id: "two", label: "同名" },
    ];
    const resolve = (field: typeof f.input) => field.options;
    expect(
      fieldConditionValues(f.input, f.input, "one", "two", resolve),
    ).toEqual({ actual: "one", expected: "two" });
    const multi = createField("checkbox", {
      id: "multi",
      options: [{ id: "m-a", label: "甲" }],
    });
    expect(
      matchesFilters(
        [f.filter],
        { category: "source-a" },
        { input: ["m-a"] },
        f.data,
        "all",
        [f.category],
        [f.category],
        [{ ...multi, id: "input" }],
      ),
    ).toBe(true);
    f.category.options.push({ id: "other", label: "其他", other: true });
    expect(
      matchesFilters(
        [f.filter],
        { category: { optionId: "other", text: "任意说明" } },
        { input: "任意说明" },
        f.data,
        "all",
        [f.category],
        [f.category],
        [createField("text", { id: "input" })],
      ),
    ).toBe(true);
  });

  it("uses only readable dynamic source values and rejects unresolved negative comparisons", () => {
    const f = fixture();
    f.input.choiceSource = {
      ...f.input.choiceSource,
      mode: "form",
      formId: f.source.id,
      labelFieldId: "name",
    };
    f.category.options = [
      { id: "source-a", label: "商品甲" },
      { id: "source-b", label: "商品乙" },
    ];
    f.source.versions[0]!.schema.fields[0]!.options = copy(f.category.options);
    expect(
      relationCandidates(
        f.relation,
        f.data,
        { input: "商品甲" },
        "",
        f.schema.fields,
      ).map((e) => e.id),
    ).toEqual(["商品甲"]);
    f.data.entries[0]!.readableFieldIds = ["category"];
    f.relation.reference.filters[0]!.operator = "notEquals";
    expect(
      relationCandidates(
        f.relation,
        f.data,
        { input: "商品甲" },
        "",
        f.schema.fields,
      ),
    ).toEqual([]);
    expect(
      resolveChoices(
        { ...f.input, choiceSource: { ...f.input.choiceSource, filters: [] } },
        f.data,
        {},
      ).map((o) => o.id),
    ).toEqual(["商品乙"]);
  });

  it("clears dependent values after a change and uses the same comparison for import and quick fill", () => {
    const f = fixture();
    const initial = { input: "local-a", product: "商品甲", relation: "商品甲" };
    expect(validateDynamicValues(f.schema, initial, f.data)).toEqual([]);
    expect(
      importFieldValue(
        f.choice,
        "商品甲",
        initial,
        f.data,
        true,
        undefined,
        f.schema.fields,
      ),
    ).toBe("商品甲");
    expect(
      quickFillValue(f.choice, "商品甲", initial, f.data, f.schema.fields),
    ).toBe("商品甲");
    const next = applyFieldChange(
      f.schema.fields,
      initial,
      "input",
      "local-b",
      f.data,
    );
    expect(next.product).toBe("");
    expect(next.relation).toBe("");
    expect(next.linked).toBe("商品乙");
    expect(
      validateDynamicValues(
        f.schema,
        { ...next, product: "商品甲" },
        f.data,
      ).some((e) => e.fieldId === "product"),
    ).toBe(true);
  });

  it("evaluates each subform row against its own input without borrowing sibling values", () => {
    const f = fixture();
    const detail = createField("subform", {
      id: "detail",
      children: f.schema.fields,
    });
    const schema = { ...f.schema, fields: [detail] };
    const values = {
      detail: [
        { input: "local-a", product: "商品甲" },
        { input: "local-b", product: "商品乙" },
      ],
    };
    expect(validateDynamicValues(schema, values, f.data)).toEqual([]);
    values.detail[1]!.product = "商品甲";
    expect(
      validateDynamicValues(schema, values, f.data).map((e) => e.path),
    ).toEqual(["detail.1.product"]);
  });
});
