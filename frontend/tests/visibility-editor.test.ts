// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { createApp, h, nextTick, reactive, shallowRef } from "vue";
import { createPinia } from "pinia";
import { createField, emptySchema, copy, isFieldVisible, parseSchema } from "../src/domain/form";
import { newForm } from "../src/domain/workspace";
import { useFormDesigner } from "../src/features/forms/useFormDesigner";
import VisibilityRules from "../src/features/forms/components/VisibilityRules.vue";
import ChoiceFieldInspector from "../src/features/forms/components/ChoiceFieldInspector.vue";
import FormSettingsInspector from "../src/features/forms/components/FormSettingsInspector.vue";

let app: ReturnType<typeof createApp> | undefined;
const settle = async () => { for (let i = 0; i < 10; i++) await nextTick(); };
const control = <T extends HTMLElement = HTMLElement>(label: string) => document.querySelector<T>(`[aria-label="${label}"]`)!;
const button = (name: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find(el => el.textContent?.trim() === name)!;
async function mount(render: Parameters<typeof createApp>[0]) {
  document.body.innerHTML = '<div id="app"></div>';
  app = createApp(render); app.use(createPinia()); app.mount("#app"); await settle();
}
function sample() {
  const schema = reactive(emptySchema());
  schema.fields = [createField("radio", { id: "kind", label: "仓库", options: [{ id: "sh", label: "上海仓" }, { id: "gz", label: "广州仓" }, { id: "other", label: "其他", other: true }] }), createField("text", { id: "detail", label: "办理说明" }), createField("text", { id: "note", label: "备注" })];
  return schema;
}
async function choose(label: string, text: string) {
  control(label).click(); await settle();
  [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(el => el.textContent?.trim() === text)!.click(); await settle();
}
async function target(label: string, text: string) {
  control(label).click(); await settle(); control(`${label} ${text}`).click(); await settle();
  control(`${label}搜索选项`).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await settle();
}
async function select(label: string, value: string) {
  const el = control<HTMLSelectElement>(label); el.value = value; el.dispatchEvent(new Event("change", { bubbles: true })); await settle();
}
afterEach(() => { app?.unmount(); document.body.innerHTML = ""; localStorage.clear(); });

it("the field shortcut writes one shared configuration, supports overlapping targets and retains Other identity", async () => {
  const schema = sample();
  await mount({ render: () => h("div", [h(ChoiceFieldInspector, { schema, field: schema.fields[0]!, formId: "form" }), h(FormSettingsInspector, { schema })]) });
  button("设置").click(); await settle();
  button("显隐规则").click(); await settle();
  await choose("条件选项 1", "上海仓"); await target("显示字段 1", "办理说明");
  button("显隐规则").click(); await settle();
  await choose("条件选项 2", "其他");
  expect(control("条件选项 2其他说明")).toBeNull();
  await target("显示字段 2", "办理说明");
  const pendingIds = [...document.querySelectorAll('.visibility-shortcut-row')].length;
  expect(pendingIds).toBe(2);
  expect(schema.settings.rules).toEqual([]);
  button("确定").click(); await settle();
  expect(schema.settings.rules).toHaveLength(2);
  expect(isFieldVisible(schema.fields[1]!, schema, { kind: { optionId: "other", text: "临时仓库" } })).toBe(true);
  expect(isFieldVisible(schema.fields[1]!, schema, { kind: "sh" })).toBe(true);
  expect(isFieldVisible(schema.fields[1]!, schema, { kind: "gz" })).toBe(false);
  expect(document.querySelectorAll('.visibility-rule-item')).toHaveLength(2);
  const original = copy(schema);
  button("已设置显隐规则").click(); await settle(); control("删除显隐规则 1").click(); await settle();
  button("取消").click(); await settle(); expect(schema).toEqual(original);
});

it("general conditions edit in a buffer and cancellation/close/Escape preserve legacy semantics and focus", async () => {
  const schema = sample();
  schema.settings.rules = [{ id: "old1", sourceId: "kind", operator: "equals", value: "sh", targetIds: ["detail", "note"] }, { id: "old2", sourceId: "note", operator: "equals", value: "ok", targetIds: ["detail"] }];
  const original = copy(schema);
  await mount({ render: () => h(FormSettingsInspector, { schema }) });
  const edit = document.querySelector<HTMLButtonElement>('.visibility-rule-item button')!;
  edit.focus(); edit.click(); await settle();
  expect(control<HTMLSelectElement>("条件关系").value).toBe("all");
  expect(document.querySelectorAll('.visibility-condition-row')).toHaveLength(2);
  await select("条件关系", "any");
  control("关闭").click(); await settle(); expect(schema).toEqual(original); expect(document.activeElement).toBe(edit);
  edit.click(); await settle(); document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await settle(); expect(schema).toEqual(original);
  edit.click(); await settle(); await select("条件关系", "any"); button("确定").click(); await settle();
  expect(isFieldVisible(schema.fields[1]!, schema, { kind: "sh", note: "no" })).toBe(true);
  expect(isFieldVisible(schema.fields[2]!, schema, { kind: "gz", note: "ok" })).toBe(false);
  expect(parseSchema(schema).settings.rules).toEqual(schema.settings.rules);
});

it("new main and subform rule pickers only show fields in their value scope; invalid input stays editable", async () => {
  const schema = sample();
  schema.fields.push(createField("subform", { id: "rows", label: "明细", children: [createField("radio", { id: "rowKind", label: "行类型" }), createField("text", { id: "rowDetail", label: "行说明" })] }));
  await mount({ render: () => h(VisibilityRules, { schema }) });
  button("添加显隐规则").click(); await settle(); button("确定").click(); await settle();
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("请选择");
  button("添加条件").click(); await settle();
  expect([...control<HTMLSelectElement>("条件字段 1").options].map(option => option.value)).not.toContain("rowKind");
  button("取消").click(); await settle(); expect(schema.settings.rules).toEqual([]);
  app!.unmount(); await mount({ render: () => h(VisibilityRules, { schema, scopeId: "rows" }) });
  button("添加显隐规则").click(); await settle(); button("添加条件").click(); await settle();
  expect([...control<HTMLSelectElement>("条件字段 1").options].map(option => option.value)).toEqual(["", "rowKind", "rowDetail"]);
});

it("confirmed deletion of a compiled legacy target preserves overlapping targets' predicates", async () => {
  const schema = sample();
  schema.settings.rules = [{ id: "old1", sourceId: "kind", operator: "equals", value: "sh", targetIds: ["detail", "note"] }, { id: "old2", sourceId: "note", operator: "equals", value: "ok", targetIds: ["detail"] }];
  await mount({ render: () => h(FormSettingsInspector, { schema }) });
  document.querySelector<HTMLButtonElement>('.visibility-rule-item .icon-button')!.click(); await settle();
  expect(isFieldVisible(schema.fields[1]!, schema, { kind: "gz", note: "no" })).toBe(true);
  expect(isFieldVisible(schema.fields[2]!, schema, { kind: "gz" })).toBe(false);
  expect(isFieldVisible(schema.fields[2]!, schema, { kind: "sh" })).toBe(true);
});

it("field deletion, trash restore and undo preserve rule identities and immutable publication", async () => {
  const record = newForm("oa", "验收"); record.schema = sample();
  record.schema.settings.rules = [{ id: "r", conditions: [{ sourceId: "kind", operator: "equals", value: "sh" }], match: "all", targetIds: ["detail", "note"] }];
  record.published = { version: 1, title: record.title, schema: copy(record.schema), workflow: copy(record.workflow), publishedAt: "2026-10-09" };
  const original = copy(record.schema), published = copy(record.published), form = shallowRef(record);
  let editor!: ReturnType<typeof useFormDesigner>;
  await mount({ setup() { editor = useFormDesigner(form); return () => h("div"); } });
  editor.remove(["detail"]); await settle(); expect(form.value.schema.settings.rules[0]!.targetIds).toEqual(["note"]); expect(() => parseSchema(form.value.schema)).not.toThrow();
  editor.restore(0); await settle();
  expect(form.value.schema.fields.map(field => field.id)).toEqual(["kind", "note", "detail"]);
  expect(form.value.schema.fields.find(field => field.id === "detail")).toEqual(original.fields[1]);
  expect(form.value.schema.settings).toEqual(original.settings);
  editor.remove(["kind"]); editor.remove(["detail", "note"]); await settle();
  expect(form.value.schema.settings.rules).toEqual([]);
  editor.restore(2); await settle(); editor.restore(1); await settle(); editor.restore(0); await settle();
  expect(form.value.schema.settings.rules).toEqual(original.settings.rules);
  editor.remove(["kind"]); await settle(); await editor.undo(); await settle(); expect(form.value.schema.settings.rules).toEqual(original.settings.rules);
  expect(form.value.published).toEqual(published);
});
