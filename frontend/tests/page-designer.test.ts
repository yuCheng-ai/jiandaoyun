import { describe, it, expect } from "vitest";
import { separateFormSchema, type PageEditorData } from "@platform/contracts";
import { createField, emptySchema, copy } from "../src/domain/form";
import { adoptPageModel, pageEditingState, pageUpdate, modelFields, pageFieldConflicts, planFieldReuse } from "../src/domain/pageDesigner";

const schema = { ...emptySchema(), fields: [createField("text", { id: "name" }), createField("subform", { id: "lines", children: [createField("number", { id: "count" })] })] };
const split = separateFormSchema(schema);
const data: PageEditorData = {
  draft: { id: "page", title: "页面", definitionId: "object", definitionVersion: 1, revision: 2, latestVersion: 1, schema: split.page, additions: [], baseDefinitionRevision: null },
  model: split.model, object: { id: "object", title: "数据", revision: 3, latestVersion: 1, model: split.model },
};
describe("page designer draft operations", () => {
  it("an initial page adopts the first published data model without losing pending child columns or adding other controls", () => {
    const initial: PageEditorData = {
      ...copy(data), model: { version: 1, fields: [] },
      draft: { ...copy(data.draft), definitionVersion: 0, latestVersion: 0, schema: separateFormSchema(emptySchema()).page, additions: [] },
    };
    const state = pageEditingState(initial);
    state.schema.fields.push(createField("subform", { id: "inspection", label: "检验明细", children: [createField("text", { id: "result", label: "检验结论" })] }));
    state.schema.settings.layout = 2;
    const adopted = adoptPageModel(initial, state, { model: data.model, object: data.object });
    expect(adopted.data.draft.definitionVersion).toBe(1);
    expect(adopted.state.schema.fields.map(field => field.id)).toEqual(["inspection"]);
    expect(adopted.state.schema.settings.layout).toBe(2);
    expect(pageUpdate(adopted.data, adopted.state).additions[0]!.field.children[0]!.id).toBe("result");
    expect(initial.draft.definitionVersion).toBe(0);
  });
  it("unpublished model changes cannot be mistaken for an adopted published version", () => {
    const initial = copy(data); initial.draft.definitionVersion = 0;
    const state = pageEditingState(initial), before = JSON.stringify(state);
    expect(() => adoptPageModel(initial, state, { model: data.model, object: { ...data.object, latestVersion: 0 } })).toThrow("尚未发布");
    expect(JSON.stringify(state)).toBe(before);
  });
  it("removing an existing control retains the model and creates no field deletion", () => {
    const state = pageEditingState(data); state.schema.fields.shift();
    const command = pageUpdate(data, state);
    expect(command.additions).toEqual([]);
    expect(command.schema.controls.map(control => control.binding?.fieldId)).toEqual(["lines"]);
    expect(data.model.fields[0]!.id).toBe("name");
  });
  it("dragging a required new field creates one pending data field and a page-only requirement", () => {
    const state = pageEditingState(data); state.schema.fields.push(createField("text", { id: "new", label: "处理意见", required: true }));
    const command = pageUpdate(data, state);
    expect(command.additions[0]!.field.required).toBe(false);
    expect(command.schema.controls.at(-1)!.properties.required).toBe(true);
    expect(command.additions[0]!.field.id).toBe(command.schema.controls.at(-1)!.binding!.fieldId);
    expect(command.baseDefinitionRevision).toBe(3);
    state.schema.fields.pop();
    expect(pageUpdate(data, state).additions).toEqual([]);
  });
  it("new child fields belong to their stable parent, including a newly created parent", () => {
    const state = pageEditingState(data); state.schema.fields[1]!.children.push(createField("number", { id: "received" }));
    expect(pageUpdate(data, state).additions[0]!.parentId).toBe("lines");
    state.schema.fields.push(createField("subform", { id: "new_lines", children: [createField("text", { id: "new_item" })] }));
    expect(pageUpdate(data, state).additions[1]!.field.children[0]!.id).toBe("new_item");
  });
  it("page renaming and reorder preserve existing field bindings and data names", () => {
    const state = pageEditingState(data); state.schema.fields[0]!.label = "页面显示名称";
    state.schema.fields.reverse();
    const command = pageUpdate(data, state);
    expect(command.schema.controls[1]!.properties.label).toBe("页面显示名称");
    expect(command.schema.controls[1]!.binding!.fieldId).toBe("name");
    expect(command.additions).toEqual([]);
    expect(data.model.fields[0]!.name).toBe("单行文本");
  });
  it("resumes pending fields from a server draft and preserves the original model baseline", () => {
    const state = pageEditingState(data); state.schema.fields.push(createField("text", { id: "new" }));
    const command = pageUpdate(data, state), resumed = copy(data);
    resumed.draft = { ...resumed.draft, ...command, revision: 4 };
    resumed.object.revision = 7;
    const continued = pageEditingState(resumed);
    expect(continued.schema.fields.at(-1)!.id).toBe("new");
    expect(pageUpdate(resumed, continued).baseDefinitionRevision).toBe(3);
    continued.schema.fields.pop();
    expect(pageUpdate(resumed, continued).additions).toEqual([]);
  });
  it("rejects moving an existing field into a different data scope", () => {
    const state = pageEditingState(data), moved = state.schema.fields.shift()!;
    state.schema.fields[0]!.children.push(moved);
    expect(() => pageUpdate(data, state)).toThrow("所属数据");
  });
  it("adopts published fields without injecting controls or losing unsaved layout and additions", () => {
    const latest = copy({ model: data.model, object: data.object });
    const extra = separateFormSchema({ ...emptySchema(), fields: [createField("text", { id: "conclusion", label: "共享结论" })] }).model.fields[0]!;
    latest.model.fields.push(extra); latest.object.latestVersion = 2; latest.object.revision = 8;
    const state = pageEditingState(data); state.schema.fields[0]!.label = "本页别名"; state.schema.settings.layout = 2;
    state.schema.fields.push(createField("text", { id: "local", label: "本页待发布字段" }));
    const adopted = adoptPageModel(data, state, latest);
    expect(adopted.data.draft.definitionVersion).toBe(2);
    expect(adopted.state.schema.settings.layout).toBe(2);
    expect(adopted.state.schema.fields[0]!.label).toBe("本页别名");
    expect(adopted.state.schema.fields.some(f => f.id === "conclusion")).toBe(false);
    expect(modelFields(adopted.data.model).some(item => item.field.id === "conclusion")).toBe(true);
    expect(pageUpdate(adopted.data, adopted.state).additions[0]!.field.id).toBe("local");
    expect(pageUpdate(adopted.data, adopted.state).baseDefinitionRevision).toBe(8);
  });
  it("blocks removed bindings and name conflicts without mutating the original page draft", () => {
    const state = pageEditingState(data), before = JSON.stringify(state);
    const latest = copy({ model: data.model, object: data.object }); latest.model.fields.shift(); latest.object.latestVersion = 2;
    expect(() => adoptPageModel(data, state, latest)).toThrow("移除对应控件"); expect(JSON.stringify(state)).toBe(before);
    latest.model = copy(data.model);
    state.schema.fields.push(createField("text", { id: "duplicate", label: latest.model.fields[0]!.name }));
    expect(() => adoptPageModel(data, state, latest)).toThrow("已有字段复用");
  });
  it("detects conflicts within a data scope while ignoring page aliases and other subforms", () => {
    const state = pageEditingState(data); state.schema.fields[0]!.label = "页面别名";
    state.schema.fields.push(createField("text", { id: "pending", label: " 单行文本 " }));
    expect(pageFieldConflicts(data, state)[0]).toMatchObject({ existing: { id: "name" }, alreadyPlaced: true });
    state.schema.fields.at(-1)!.label = "页面别名";
    expect(pageFieldConflicts(data, state)).toEqual([]);
    state.schema.fields.push(createField("subform", { id: "other", label: "其他明细", children: [createField("number", { id: "other_count", label: "数字" })] }));
    expect(pageFieldConflicts(data, state)).toEqual([]);
    state.schema.fields[1]!.children.push(createField("number", { id: "duplicate_count", label: "数字" }));
    expect(pageFieldConflicts(data, state)[0]).toMatchObject({ parentId: "lines", existing: { id: "count" } });
  });
  it("explicit reuse preserves stable identity, model constraints and local page properties", () => {
    const input = copy(data); input.model.fields[0]!.settings.maxLength = 60;
    const state = pageEditingState(input); state.schema.fields.shift();
    state.schema.fields.push(createField("textarea", { id: "pending", label: "单行文本", required: true, width: 6, placeholder: "请填写", maxLength: 999 }));
    const before = JSON.stringify(state), plan = planFieldReuse(input, state, "pending", "name");
    expect(JSON.stringify(state)).toBe(before);
    expect(plan.replacement).toMatchObject({ id: "name", type: "textarea", required: true, width: 6, placeholder: "请填写", maxLength: 60 });
    state.schema.fields[state.schema.fields.length - 1] = plan.replacement;
    expect(pageUpdate(input, state).additions).toEqual([]);
  });
  it("reusing a subform explicitly maps matching columns and preserves genuinely new columns", () => {
    const state = pageEditingState(data); state.schema.fields.pop();
    state.schema.fields.push(createField("subform", { id: "pending_lines", label: "子表单", children: [createField("number", { id: "pending_count", label: "数字", width: 6 }), createField("text", { id: "new_note", label: "备注" })] }));
    const plan = planFieldReuse(data, state, "pending_lines", "lines");
    expect(plan.bindings.map(item => item.fieldId)).toEqual(["lines", "count"]); expect(plan.additions).toEqual(["备注"]);
    state.schema.fields[1] = plan.replacement;
    expect(pageUpdate(data, state).additions).toMatchObject([{ parentId: "lines", field: { id: "new_note" } }]);
    expect(state.schema.fields[1]!.children[0]!.width).toBe(6);
    state.schema.fields[1]!.id = "pending_lines";
    state.schema.fields[1]!.children.push(createField("number", { id: "duplicate", label: "数字" }));
    expect(() => planFieldReuse(data, state, "pending_lines", "lines")).toThrow("重复控件");
  });
  it("blocks incompatible and already placed reuse without losing any pending fields", () => {
    const state = pageEditingState(data); state.schema.fields.push(createField("number", { id: "pending", label: "单行文本" }));
    const before = JSON.stringify(state);
    expect(() => planFieldReuse(data, state, "pending", "name")).toThrow("已在本页"); expect(JSON.stringify(state)).toBe(before);
    state.schema.fields.shift(); const without = JSON.stringify(state);
    expect(() => planFieldReuse(data, state, "pending", "name")).toThrow("类型不同"); expect(JSON.stringify(state)).toBe(without);
  });
});
