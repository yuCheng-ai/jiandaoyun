// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { createApp, h, nextTick } from "vue";
import { createPinia } from "pinia";
import { createMemoryHistory, createRouter } from "vue-router";
import FormulaEditor from "../src/features/forms/components/FormulaEditor.vue";
import { createField, emptySchema } from "../src/domain/form";

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
it("keeps ordinary formula configuration's self-reference prohibition", async () => {
  const schema = emptySchema();
  const field = createField("number", { id: "quantity", label: "数量" });
  schema.fields = [field];
  let updates = 0;
  await mount(
    FormulaEditor,
    {
      field,
      schema,
      onUpdate: () => updates++,
    },
    createPinia(),
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
