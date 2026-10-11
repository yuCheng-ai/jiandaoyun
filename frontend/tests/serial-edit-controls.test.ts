// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { createApp, h, nextTick, reactive } from "vue";
import { createPinia } from "pinia";
import { createMemoryHistory, createRouter } from "vue-router";
import FormRuntime from "../src/features/forms/components/FormRuntime.vue";
import { createField, emptySchema } from "../src/domain/form";

let app: ReturnType<typeof createApp> | undefined;
const settle = async () => {
  for (let i = 0; i < 8; i++) await nextTick();
};
afterEach(() => {
  app?.unmount();
  document.body.innerHTML = "";
  localStorage.clear();
  sessionStorage.clear();
});

it("ordinary filling keeps serials readonly while the explicit record edit context supports manual values through tabs", async () => {
  const schema = emptySchema(),
    serial = createField("serial", {
      id: "serial",
      label: "流水号",
      editable: true,
    }),
    tabs = createField("tabs", { id: "tabs" });
  serial.tabId = tabs.tabs[0]!.id;
  tabs.children = [serial];
  schema.fields = [tabs];
  schema.settings.cacheDraft = false;
  schema.settings.allowDraft = false;
  const state = reactive({ editSerial: false, readonly: false }),
    initialValues = { serial: "00001" },
    save = vi.fn(() => true),
    router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: "/:pathMatch(.*)*", component: { render: () => null } }],
    });
  await router.push("/records");
  document.body.innerHTML = '<div id="app"></div>';
  app = createApp({
    render: () =>
      h(FormRuntime, {
        schema,
        formId: "serial-control",
        initialValues,
        preview: false,
        persistValues: save,
        ...state,
      }),
  });
  app.use(createPinia());
  app.use(router);
  app.mount("#app");
  await settle();
  const input = () =>
    document.querySelector<HTMLInputElement>('[aria-label="流水号"]')!;
  expect(input().readOnly).toBe(true);
  state.editSerial = true;
  await settle();
  expect(input().disabled).toBe(false);
  expect(input().readOnly).toBe(false);
  input().value = "人工-0";
  input().dispatchEvent(new Event("input", { bubbles: true }));
  await settle();
  expect(input().value).toBe("人工-0");
  state.readonly = true;
  state.editSerial = false;
  await settle();
  expect(input().disabled).toBe(true);
  expect(input().placeholder).toBe("");
  state.readonly = false;
  state.editSerial = true;
  await settle();
  document
    .querySelector<HTMLButtonElement>(".runtime-footer .primary")!
    .click();
  await settle();
  expect(save).toHaveBeenCalledWith({ serial: "人工-0" }, false);
});
