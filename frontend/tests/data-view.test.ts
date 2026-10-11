import { describe, expect, it } from "vitest";
import { reactive } from "vue";
import { composeFormSchema, separateFormSchema, pageForModel, modelFormSchema } from "@platform/contracts";
import { createField, emptySchema, fieldRegistry } from "../src/domain/form";

describe("independent data objects and page controls", () => {
  it("roundtrips every existing field kind, configuration and stable identity", () => {
    const schema = emptySchema();
    schema.fields = fieldRegistry.map((item, index) => createField(item.type, { id: `field_${index}`, label: `${item.label} 示例`, width: 6, description: "保留说明", required: true }));
    const reverse = createField("relationTable", { id: "reverse", referenceFormId: "source" });
    reverse.reference.mode = "reverse";
    reverse.reference.reverseFieldId = "forward";
    schema.fields.push(reverse);
    const original = structuredClone(schema), split = separateFormSchema(schema);
    expect(composeFormSchema(split.model, split.page)).toEqual(original);
    expect(schema).toEqual(original);
    const displayIds = schema.fields.filter(field => ["divider", "tabs", "button"].includes(field.type) || field.id === "reverse").map(field => field.id);
    expect(split.model.fields.some(field => displayIds.includes(field.id))).toBe(false);
    expect(JSON.stringify(split.model)).not.toContain('"width"');
  });
  it("flattens layout containers but preserves child-row scope and tab references", () => {
    const schema = emptySchema();
    const text = createField("text", { id: "name" });
    const child = createField("number", { id: "quantity", min: 0, defaultValue: 2 });
    const rows = createField("subform", { id: "lines", children: [child] });
    const tabs = createField("tabs", { id: "tabs", children: [text, rows] });
    text.tabId = tabs.tabs[0]!.id; rows.tabId = tabs.tabs[1]!.id;
    schema.fields = [tabs];
    const split = separateFormSchema(schema);
    expect(split.model.fields.map(field => field.id)).toEqual(["name", "lines"]);
    expect(split.model.fields[1]!.children[0]!.id).toBe("quantity");
    expect(composeFormSchema(split.model, split.page)).toEqual(schema);
  });
  it("removing and relabeling a control affects neither its field nor another page", () => {
    const schema = { ...emptySchema(), fields: [createField("text", { id: "name" }), createField("number", { id: "quantity" })] };
    const { model, page } = separateFormSchema(schema), original = structuredClone(model), second = structuredClone(page);
    second.controls.splice(0, 1);
    second.controls[0]!.properties.label = "实收数量";
    second.controls[0]!.properties.width = 6;
    expect(composeFormSchema(model, second).fields.map(field => field.id)).toEqual(["quantity"]);
    expect(composeFormSchema(model, page)).toEqual(schema);
    expect(model).toEqual(original);
    expect(modelFormSchema(model).fields).toHaveLength(2);
  });
  it("page completion requirements remain independent of permanent model requirements", () => {
    const { model } = separateFormSchema({ ...emptySchema(), fields: [createField("text", { id: "conclusion" })] });
    const page = pageForModel(model); page.controls[0]!.properties.required = true;
    expect(composeFormSchema(model, page).fields[0]!.required).toBe(true);
    expect(modelFormSchema(model).fields[0]!.required).toBe(false);
    model.fields[0]!.required = true; page.controls[0]!.properties.required = false;
    expect(composeFormSchema(model, page).fields[0]!.required).toBe(true);
  });
  it("detects deleted fields, mismatched types, duplicate bindings and wrong child scopes", () => {
    const { model, page } = separateFormSchema({ ...emptySchema(), fields: [createField("subform", { id: "lines", children: [createField("number", { id: "quantity" })] })] });
    const wrongScope = structuredClone(page); wrongScope.controls = [wrongScope.controls[0]!.children[0]!];
    expect(() => composeFormSchema(model, wrongScope)).toThrow("当前明细");
    const wrongType = structuredClone(page); wrongType.controls[0]!.children[0]!.type = "text";
    expect(() => composeFormSchema(model, wrongType)).toThrow("不兼容");
    const duplicate = structuredClone(page.controls[0]!); duplicate.id = "other";
    expect(() => composeFormSchema(model, { ...page, controls: [...page.controls, duplicate] })).toThrow("重复使用");
    model.fields = [];
    expect(() => composeFormSchema(model, page)).toThrow("不存在");
  });
  it("accepts reactive editor schemas and leaves them untouched", () => {
    const schema = reactive({ ...emptySchema(), fields: [createField("text", { id: "reactive_field" })] });
    const split = separateFormSchema(schema);
    split.page.controls[0]!.properties.label = "仅当前页面";
    expect(composeFormSchema(split.model, split.page).fields[0]!.label).toBe("仅当前页面");
    expect(schema.fields[0]!.label).toBe("单行文本");
  });
});
