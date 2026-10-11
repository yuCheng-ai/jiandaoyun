import {
  validateFieldConfiguration,
  validateDynamicValues,
} from "../src/domain/fieldValidation";
import { describe, it, expect } from "vitest";
import {
  createField,
  emptySchema,
  parseSchema,
  copy,
  duplicateField,
  prepareSubmission,
  validateValues,
} from "../src/domain/form";
import { seedWorkspace } from "../src/domain/workspace";
import { createRelationDemo } from "../src/domain/relationDemo";
import {
  applyFieldChange,
  resolveChoices,
  relationCandidates,
  runtimeDefaults,
  displayValue,
} from "../src/domain/relations";
import { emptyChoiceSource, emptyReference } from "../src/domain/fieldConfig";
function fixture() {
  const data = seedWorkspace(),
    demo = createRelationDemo("oa");
  data.forms.push(...demo.forms);
  data.entries.push(...demo.entries);
  const customer = demo.forms[0]!,
    order = demo.forms[1]!,
    fields = order.schema.fields;
  const byLabel = (label: string) => fields.find((f) => f.label === label)!;
  return { data, customer, order, byLabel, fields };
}
describe("cross-form runtime", () => {
  it("round-trips advanced schema configuration and migrates old field definitions", () => {
    const { order } = fixture();
    expect(parseSchema(copy(order.schema))).toEqual(order.schema);
    const raw = copy(order.schema);
    delete (raw.fields[0] as any).choiceSource;
    expect(parseSchema(raw).fields[0]!.choiceSource.mode).toBe("manual");
  });
  it("filters dynamic options by stable field values and excludes drafts", () => {
    const { data, byLabel, fields } = fixture(),
      field = byLabel("客户简称（动态选项）"),
      region = byLabel("业务区域");
    expect(resolveChoices(field, data, {})).toEqual([]);
    expect(
      resolveChoices(field, data, { [region.id]: "east" }, fields).map((o) => o.label),
    ).toEqual(["青禾设计", "星河制造"]);
    data.entries[0]!.status = "draft";
    expect(
      resolveChoices(field, data, { [region.id]: "east" }, fields).map((o) => o.label),
    ).toEqual(["星河制造"]);
  });
  it("updates options when source records change and supports sort and deduplication", () => {
    const { data, byLabel, fields } = fixture(),
      field = byLabel("客户简称（动态选项）"),
      region = byLabel("业务区域");
    data.entries.push({ ...copy(data.entries[0]!), id: "duplicate" });
    expect(resolveChoices(field, data, { [region.id]: "east" }, fields)).toHaveLength(
      2,
    );
    field.choiceSource.valueFieldId = "";
    field.choiceSource.deduplicate = false;
    expect(resolveChoices(field, data, { [region.id]: "east" }, fields)).toHaveLength(
      3,
    );
  });
  it("selects a record, maps multiple fields, and clears them when upstream selection changes", () => {
    const { data, byLabel, fields } = fixture(),
      region = byLabel("业务区域"),
      relation = byLabel("签约客户"),
      contact = byLabel("联系人"),
      phone = byLabel("联系电话"),
      dynamic = byLabel("客户简称（动态选项）");
    let values = runtimeDefaults(fields, data);
    values = applyFieldChange(fields, values, region.id, "east", data);
    values = applyFieldChange(
      fields,
      values,
      relation.id,
      data.entries[0]!.id,
      data,
    );
    values = applyFieldChange(fields, values, dynamic.id, "青禾设计", data);
    expect(values[contact.id]).toBe("林小禾");
    expect(values[phone.id]).toBe("13800000001");
    values = applyFieldChange(fields, values, region.id, "south", data);
    expect(values[relation.id]).toBe("");
    expect(values[contact.id]).toBe("");
    expect(values[phone.id]).toBe("");
    expect(values[dynamic.id]).toBe("");
  });
  it("clears mapped output when a relation is explicitly removed", () => {
    const { data, byLabel, fields } = fixture();
    const r = byLabel("签约客户");
    const values = applyFieldChange(
      fields,
      { [r.id]: data.entries[0]!.id, [byLabel("联系人").id]: "林小禾" },
      r.id,
      "",
      data,
    );
    expect(values[byLabel("联系人").id]).toBe("");
  });
  it("defaults scoped personnel and clears them on department changes", () => {
    const { data, fields, byLabel } = fixture();
    const values = runtimeDefaults(fields, data);
    expect(values[byLabel("业务负责人").id]).toBe("zhang");
    expect(
      applyFieldChange(fields, values, byLabel("负责部门").id, "finance", data)[
        byLabel("业务负责人").id
      ],
    ).toBe("");
  });
  it("returns related details and reverse records only for the target entry", () => {
    const { data, fields, customer, order, byLabel } = fixture();
    const reverse = customer.schema.fields.find(
      (f) => f.type === "relationTable",
    )!;
    const entry = {
      id: "order1",
      formId: order.id,
      definitionVersion: 1,
      values: { [byLabel("签约客户").id]: data.entries[0]!.id },
      createdAt: "now",
      status: "submitted" as const,
      history: [],
    };
    data.entries.push(entry);
    expect(
      relationCandidates(reverse, data, {}, data.entries[0]!.id).map(
        (e) => e.id,
      ),
    ).toEqual(["order1"]);
    expect(relationCandidates(reverse, data, {}, data.entries[1]!.id)).toEqual(
      [],
    );
    expect(relationCandidates(reverse, data, {})).toEqual([]);
    expect(displayValue(byLabel("签约客户"), data.entries[0]!.id, data)).toBe(
      "青禾设计",
    );
  });
  it("does not require or store derived reverse relationships", () => {
    const { customer } = fixture();
    const reverse = customer.schema.fields.find(
      (f) => f.type === "relationTable",
    )!;
    reverse.required = true;
    expect(
      validateValues(customer.schema, {}).some((e) => e.fieldId === reverse.id),
    ).toBe(false);
    expect(
      prepareSubmission(customer.schema, { [reverse.id]: ["stale"] }),
    ).not.toHaveProperty(reverse.id);
  });
  it("keeps subform row mappings isolated and reevaluates parent dependencies", () => {
    const { data, byLabel } = fixture();
    const region = byLabel("业务区域"),
      relation = byLabel("签约客户"),
      contact = byLabel("联系人");
    relation.reference.mappings = relation.reference.mappings.filter(
      (m) => m.targetFieldId === contact.id,
    );
    const sub = createField("subform", {
      id: "items",
      children: [relation, contact],
    });
    const rows = [
      { [relation.id]: data.entries[0]!.id, [contact.id]: "林小禾" },
      { [relation.id]: "", [contact.id]: "手动填写" },
    ];
    const result = applyFieldChange(
      [region, sub],
      { [region.id]: "east", items: rows },
      region.id,
      "south",
      data,
    );
    expect((result.items as any)[0][relation.id]).toBe("");
    expect((result.items as any)[0][contact.id]).toBe("");
    expect((result.items as any)[1][contact.id]).toBe("手动填写");
    expect((result.items as any)[0]).not.toHaveProperty(region.id);
  });
  it("remaps dependencies and local mappings when duplicating a container", () => {
    const a = createField("department"),
      b = createField("member");
    b.organization.scope.mode = "fieldDepartment";
    b.organization.scope.fieldId = a.id;
    const target = createField("text"),
      relation = createField("relation");
    relation.reference.filters = [
      {
        id: "filter",
        sourceFieldId: "remote",
        operator: "equals",
        source: "field",
        value: a.id,
      },
    ];
    relation.reference.mappings = [
      { sourceFieldId: "remote", targetFieldId: target.id },
    ];
    const container = createField("tabs", {
      children: [a, b, target, relation],
    });
    const cloned = duplicateField(container);
    expect(cloned.children[1]!.organization.scope.fieldId).toBe(
      cloned.children[0]!.id,
    );
    expect(cloned.children[3]!.reference.filters[0]!.value).toBe(
      cloned.children[0]!.id,
    );
    expect(cloned.children[3]!.reference.mappings[0]!.targetFieldId).toBe(
      cloned.children[2]!.id,
    );
  });
  it("preserves published source configurations when designers change the draft", () => {
    const { order } = fixture();
    const old = copy(order.published!.schema);
    order.schema.fields.find((f) => f.type === "relation")!.reference.mappings =
      [];
    expect(order.published!.schema).toEqual(old);
  });
});

describe("configuration validation", () => {
  it("resolves member defaults even when dependent department appears later", () => {
    const { data, fields, byLabel } = fixture();
    const reordered = [
      byLabel("业务负责人"),
      ...fields.filter((f) => f !== byLabel("业务负责人")),
    ];
    expect(runtimeDefaults(reordered, data)[byLabel("业务负责人").id]).toBe(
      "zhang",
    );
  });
  it("keeps dynamic record-ID labels readable without current filter context", () => {
    const { data, byLabel } = fixture();
    const field = byLabel("客户简称（动态选项）");
    field.choiceSource.valueFieldId = "";
    expect(displayValue(field, data.entries[0]!.id, data)).toBe("青禾设计");
  });
});

it("rejects missing source fields and circular cascading dependencies", () => {
  const { data, order, byLabel } = fixture();
  expect(validateFieldConfiguration(order.schema, data)).toEqual([]);
  const relation = byLabel("签约客户");
  relation.reference.filters[0]!.value = byLabel("联系人").id;
  expect(validateFieldConfiguration(order.schema, data).join()).toContain(
    "循环引用",
  );
  relation.reference.filters = [];
  relation.referenceFieldId = "deleted";
  expect(validateFieldConfiguration(order.schema, data).join()).toContain(
    "显示字段已失效",
  );
});
it("validates stale organization and relation values when submitting a resumed draft", () => {
  const { data, order, byLabel } = fixture();
  const values = runtimeDefaults(order.schema.fields, data);
  values[byLabel("业务区域").id] = "south";
  values[byLabel("签约客户").id] = data.entries[0]!.id;
  data.organization.employees.find((e) => e.id === "zhang")!.status =
    "inactive";
  const errors = validateDynamicValues(order.schema, values, data);
  expect(errors.map((e) => e.fieldId)).toContain(byLabel("业务负责人").id);
  expect(errors.map((e) => e.fieldId)).toContain(byLabel("签约客户").id);
});
