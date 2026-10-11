// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { createApp, h, nextTick } from "vue";
import { createPinia } from "pinia";
import { createMemoryHistory, createRouter } from "vue-router";
import RecordBatchDialog from "../src/features/forms/components/RecordBatchDialog.vue";
import FormulaEditor from "../src/features/forms/components/FormulaEditor.vue";
import { copy, createField } from "../src/domain/form";
import { useWorkspaceStore } from "../src/stores/workspace";

let app: ReturnType<typeof createApp> | undefined;
const settle = async () => {
  for (let i = 0; i < 10; i++) await nextTick();
};
const button = (root: ParentNode, label: string) =>
  Array.from(root.querySelectorAll<HTMLButtonElement>("button")).find(
    (item) => item.textContent?.trim() === label,
  )!;
afterEach(() => {
  app?.unmount();
  document.body.innerHTML = "";
  localStorage.clear();
  sessionStorage.clear();
});
async function fixture() {
  const pinia = createPinia(),
    store = useWorkspaceStore(pinia),
    form = (await store.createForm("oa", "批改控件", "form"))!,
    draft = store.openForm(form.id)!;
  draft.schema.fields = [
    createField("text", { id: "code", label: "唯一编号", unique: true }),
    createField("text", { id: "name", label: "名称", maxLength: 2 }),
    createField("number", { id: "quantity", label: "数量" }),
    createField("serial", { id: "serial", label: "流水号" }),
  ];
  expect(await store.publishForm(form.id)).toBe(true);
  const entries = [
    (await store.submitEntry(form.id, { code: "A", name: "甲", quantity: 2 }))!,
    (await store.submitEntry(form.id, { code: "B", name: "乙", quantity: 3 }))!,
  ];
  return { pinia, store, form, schema: copy(draft.schema), entries };
}
async function mount(
  component: any,
  props: Record<string, unknown>,
  pinia: ReturnType<typeof createPinia>,
) {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: "/", component: { render: () => null } }],
  });
  await router.push("/");
  document.body.innerHTML = '<div id="app"></div>';
  app = createApp({ render: () => h(component, props) });
  app.use(pinia);
  app.use(router);
  app.mount("#app");
  await settle();
}
async function choose(id: string, value: string) {
  const select = document.querySelector<HTMLSelectElement>(id)!;
  select.value = value;
  select.dispatchEvent(new Event("change", { bubbles: true }));
  await settle();
}
it("reuses real field controls without form length limits, excludes unique fields and preserves cancelled edits", async () => {
  const f = await fixture();
  let saved = 0,
    closed = 0;
  await mount(
    RecordBatchDialog,
    {
      formId: f.form.id,
      schema: f.schema,
      entries: copy(f.entries),
      onSaved: () => saved++,
      onClose: () => closed++,
    },
    f.pinia,
  );
  const dialog = document.querySelector('dialog[aria-label="批量修改"]')!;
  expect(
    dialog.querySelector("#record-batch-field")?.textContent,
  ).not.toContain("唯一编号");
  const input = dialog.querySelector<HTMLInputElement>(
    '[aria-label="批量修改值"]',
  )!;
  expect(input.getAttribute("maxlength")).toBeNull();
  input.value = "较长的批改值";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await settle();
  button(dialog, "取消").click();
  await settle();
  expect(closed).toBe(0);
  expect(dialog.textContent).toContain("修改尚未保存");
  expect(f.entries.map((entry) => entry.values.name)).toEqual(["甲", "乙"]);
  button(dialog, "继续编辑").click();
  await settle();
  button(dialog, "确定").click();
  await settle();
  expect(saved).toBe(1);
  expect(f.entries.map((entry) => entry.values.name)).toEqual([
    "较长的批改值",
    "较长的批改值",
  ]);
});
it("allows current-field chips in the batch formula editor and saves per-record results through the real dialog", async () => {
  const f = await fixture();
  let saved = 0;
  await mount(
    RecordBatchDialog,
    {
      formId: f.form.id,
      schema: f.schema,
      entries: copy(f.entries),
      onSaved: () => saved++,
    },
    f.pinia,
  );
  await choose("#record-batch-field", "quantity");
  await choose("#record-batch-mode", "formula");
  button(
    document.querySelector('dialog[aria-label="批量修改"]')!,
    "编辑公式",
  ).click();
  await settle();
  const formula = document.querySelector('dialog[aria-label="公式编辑"]')!;
  expect(
    formula.querySelector(".formula-fields")?.textContent ||
      formula.textContent,
  ).toContain("数量");
  const input = formula.querySelector<HTMLElement>('[aria-label="公式内容"]')!;
  input.textContent = "{{quantity}} * 1.1";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await settle();
  button(formula, "确定").click();
  await settle();
  expect(document.querySelector('dialog[aria-label="公式编辑"]')).toBeNull();
  button(
    document.querySelector('dialog[aria-label="批量修改"]')!,
    "确定",
  ).click();
  await settle();
  expect(saved).toBe(1);
  expect(f.entries.map((entry) => entry.values.quantity)).toEqual([
    2.2, 3.3000000000000003,
  ]);
});
it("keeps ordinary formula configuration's self-reference prohibition", async () => {
  const f = await fixture();
  let updates = 0;
  await mount(
    FormulaEditor,
    {
      field: f.schema.fields.find((field) => field.id === "quantity"),
      schema: f.schema,
      onUpdate: () => updates++,
    },
    f.pinia,
  );
  button(document.body, "编辑公式").click();
  await settle();
  const formula = document.querySelector('dialog[aria-label="公式编辑"]')!,
    input = formula.querySelector<HTMLElement>('[aria-label="公式内容"]')!;
  input.textContent = "{{quantity}} * 1.1";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await settle();
  button(formula, "确定").click();
  await settle();
  expect(updates).toBe(0);
  expect(document.querySelector('dialog[aria-label="公式编辑"]')).toBeTruthy();
  expect(formula.querySelector('[role="alert"]')?.textContent).toContain(
    "不能引用当前字段",
  );
});
