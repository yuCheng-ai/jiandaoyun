// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApp, h, nextTick } from "vue";
import { createPinia } from "pinia";
import { createMemoryHistory, createRouter, RouterView } from "vue-router";
import { separateFormSchema, type PageEditorData } from "@platform/contracts";
import { createField, emptySchema, copy } from "../src/domain/form";
import { pageUpdate } from "../src/domain/pageDesigner";
import { usePageDesignerStore } from "../src/stores/pageDesigner";
import PageDesignerView from "../src/features/data/PageDesignerView.vue";
import { platformApi } from "../src/repositories/platformApi";

vi.mock("../src/stores/platformSession", () => ({
  usePlatformSession: () => ({
    user: { role: "admin", name: "管理员" },
    restore: async () => {},
  }),
}));
vi.mock("../src/repositories/platformApi", () => ({ platformApi: vi.fn() }));
let app: ReturnType<typeof createApp> | undefined;
let store: ReturnType<typeof usePageDesignerStore>;
let data: PageEditorData;
const originalScroll = HTMLElement.prototype.scrollIntoView;
const button = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => item.textContent?.trim() === label,
  )!;
const named = (label: string) =>
  document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
async function settle() {
  for (let i = 0; i < 30; i++) await nextTick();
}
async function click(label: string) {
  button(label).click();
  await settle();
}
async function mount() {
  const pinia = createPinia();
  store = usePageDesignerStore(pinia);
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      {
        path: "/applications/:applicationId/pages/:pageId/design",
        component: PageDesignerView,
      },
      { path: "/:pathMatch(.*)*", component: { render: () => null } },
    ],
  });
  await router.push("/applications/app/pages/page/design");
  await router.isReady();
  app = createApp({ render: () => h(RouterView) });
  app.use(pinia);
  app.use(router);
  app.mount("#mount");
  await settle();
}
beforeEach(() => {
  document.body.innerHTML = '<div id="mount"></div>';
  vi.stubGlobal("CSS", { escape: (id: string) => id });
  HTMLElement.prototype.scrollIntoView = vi.fn();
  const split = separateFormSchema({
    ...emptySchema(),
    fields: [
      createField("text", { id: "name", label: "业务名称" }),
      createField("textarea", { id: "note", label: "备注" }),
      createField("subform", {
        id: "lines",
        label: "交付明细",
        children: [
          createField("number", { id: "count", label: "计划数量" }),
          createField("number", { id: "received", label: "实收数量" }),
        ],
      }),
    ],
  });
  split.page.controls.splice(1, 1);
  split.page.controls[0]!.properties.label = "本页事项名称";
  split.page.controls[1]!.children.pop();
  data = {
    draft: {
      id: "page",
      applicationId: "app",
      title: "登记页面",
      definitionId: "object",
      definitionVersion: 1,
      revision: 2,
      latestVersion: 1,
      schema: split.page,
      additions: [],
      baseDefinitionRevision: null,
    },
    model: split.model,
    object: {
      id: "object",
      title: "交付业务",
      revision: 3,
      latestVersion: 1,
      model: split.model,
    },
  };
  vi.mocked(platformApi)
    .mockReset()
    .mockImplementation(async (path, method, payload: any) => {
      if (path === "/pages/page/editor") return copy(data);
      if (path === "/pages/page" && method === "PUT")
        return { ...copy(data.draft), ...payload, revision: 3 };
      throw new Error(path);
    });
});
afterEach(() => {
  app?.unmount();
  HTMLElement.prototype.scrollIntoView = originalScroll;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});
it("real model fields remain visible under page aliases; locating and reusing never duplicate data fields", async () => {
  await mount();
  await click("已有字段");
  expect(named("定位业务名称").textContent).toContain("已在本页");
  named("定位业务名称").click();
  await settle();
  expect(
    document.querySelector<HTMLInputElement>("#page-control-label")?.value,
  ).toBe("本页事项名称");
  named("使用备注").click();
  await settle();
  expect(store.state.schema.fields.at(-1)?.id).toBe("note");
  expect(named("定位备注").textContent).toContain("已在本页");
  expect(document.body.textContent).toContain("已将「备注」放入本页");
  expect(pageUpdate(store.data!, store.state).additions).toEqual([]);
});
it("subform reuse stays in the selected detail structure and retains the existing column ID", async () => {
  await mount();
  document
    .querySelector<HTMLElement>('.field-design-card[data-field-id="count"]')!
    .click();
  await settle();
  await click("已有字段");
  expect(named("使用实收数量")).toBeTruthy();
  expect(named("使用备注")).toBeNull();
  named("使用实收数量").click();
  await settle();
  expect(
    store.state.schema.fields
      .find((field) => field.id === "lines")!
      .children.map((field) => field.id),
  ).toEqual(["count", "received"]);
  expect(document.querySelector(".page-binding-note")?.textContent).toContain(
    "交付业务 / 交付明细",
  );
  expect(pageUpdate(store.data!, store.state).additions).toEqual([]);
});
it("an unmatched search says no match and does not invent recommendations or alter the schema", async () => {
  await mount();
  await click("已有字段");
  const before = JSON.stringify(store.state);
  const input = document.querySelector<HTMLInputElement>(
    '[aria-label="搜索字段"]',
  )!;
  input.value = "不存在字段";
  input.dispatchEvent(new Event("input"));
  await settle();
  expect(document.body.textContent).toContain("没有找到匹配的已有字段");
  expect(JSON.stringify(store.state)).toBe(before);
});
it("a newly added input saves one pending data field and its binding together, leaving the published model intact", async () => {
  await mount();
  named("添加数字").click();
  await settle();
  const field = store.state.schema.fields.at(-1)!;
  field.label = "核对数量";
  await click("保存草稿");
  const command = vi
    .mocked(platformApi)
    .mock.calls.find((call) => call[1] === "PUT")![2] as any;
  expect(command.additions).toHaveLength(1);
  expect(command.additions[0].field).toMatchObject({
    id: field.id,
    name: "核对数量",
  });
  expect(command.schema.controls.at(-1).binding.fieldId).toBe(field.id);
  expect(store.data!.model.fields.some((item) => item.id === field.id)).toBe(
    false,
  );
  expect(document.body.textContent).toContain("发布后可供其他页面使用");
});
it("mobile reuse leads straight to field properties and live width changes restore both panels", async () => {
  await mount();
  const palette = document.querySelector<HTMLElement>(".field-palette")!;
  const inspector = document.querySelector<HTMLElement>(
    ".form-property-panel",
  )!;
  vi.stubGlobal("innerWidth", 390);
  window.dispatchEvent(new Event("resize"));
  await settle();
  expect(palette.style.display).toBe("none");
  expect(inspector.style.display).toBe("none");
  named("切换字段库").click();
  await click("已有字段");
  named("使用备注").click();
  await settle();
  expect(palette.style.display).toBe("none");
  expect(inspector.style.display).not.toBe("none");
  expect(inspector.textContent).toContain("数据字段：备注");
  vi.stubGlobal("innerWidth", 1024);
  window.dispatchEvent(new Event("resize"));
  await settle();
  expect(palette.style.display).not.toBe("none");
  expect(inspector.style.display).not.toBe("none");
  expect(pageUpdate(store.data!, store.state).additions).toEqual([]);
});
