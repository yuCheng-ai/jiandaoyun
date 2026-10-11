// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { createApp, nextTick, reactive } from "vue";
import { createPinia } from "pinia";
import FormSettingsInspector from "../src/features/forms/components/FormSettingsInspector.vue";
import { emptySchema, parseSchema } from "../src/domain/form";

let app: ReturnType<typeof createApp> | undefined;
afterEach(() => {
  app?.unmount();
  document.body.innerHTML = "";
});
const button = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (el) =>
      el.getAttribute("aria-label") === label ||
      el.textContent?.trim() === label,
  )!;
async function mount(schema = reactive(emptySchema())) {
  document.body.innerHTML = '<div id="mount"></div>';
  app = createApp(FormSettingsInspector, { schema });
  app.use(createPinia());
  app.mount("#mount");
  await nextTick();
  return schema;
}
async function label(value: string) {
  const input = document.querySelector<HTMLInputElement>("#operation-label")!;
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await nextTick();
}

it("button settings open in place, retain configuration through reload and return keyboard focus", async () => {
  const schema = await mount();
  expect(document.querySelector("#operation-label")).toBeNull();
  button("设置提交按钮").click();
  await nextTick();
  await label("确认登记");
  button("启用提交").click();
  button("完成").click();
  await nextTick();
  await nextTick();
  expect(button("设置提交按钮").textContent).toContain("已关闭");
  expect(document.activeElement).toBe(button("设置提交按钮"));
  const restored = parseSchema(JSON.parse(JSON.stringify(schema)));
  expect(restored.settings).toMatchObject({
    allowSubmit: false,
    submitLabel: "确认登记",
  });
  app!.unmount();
  await mount(reactive(restored));
  button("设置提交按钮").click();
  await nextTick();
  expect(
    document.querySelector<HTMLInputElement>("#operation-label")!.value,
  ).toBe("确认登记");
  expect(button("启用提交").getAttribute("aria-checked")).toBe("false");
});

it("draft settings preserve a custom label, toggle independently and restore only their own default", async () => {
  const schema = await mount();
  schema.settings.submitLabel = "确认登记";
  button("设置保存草稿按钮").click();
  await nextTick();
  await label("暂存");
  button("启用保存草稿").click();
  await nextTick();
  expect(schema.settings.allowSubmit).toBe(true);
  expect(schema.settings.allowDraft).toBe(false);
  expect(
    parseSchema(JSON.parse(JSON.stringify(schema))).settings.draftLabel,
  ).toBe("暂存");
  button("恢复默认按钮文字").click();
  await nextTick();
  expect(schema.settings.draftLabel).toBe("保存草稿");
  expect(schema.settings.submitLabel).toBe("确认登记");
});

it("layout details reuse the shared dialog while the compact list keeps the saved settings", async () => {
  const schema = await mount();
  expect(document.querySelector(".form-layout-dialog")).toBeNull();
  button("表单布局设置").click();
  await nextTick();
  button("左右").click();
  await nextTick();
  button("关闭").click();
  await nextTick();
  expect(schema.settings.labelPosition).toBe("left");
  expect(document.querySelector(".form-layout-dialog")).toBeNull();
});
