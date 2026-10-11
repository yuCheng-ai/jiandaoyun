// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApp, defineComponent, h, nextTick } from "vue";
import { createMemoryHistory, createRouter, RouterView } from "vue-router";
import DataWorkspaceView from "../src/features/data/DataWorkspaceView.vue";
import { platformApi } from "../src/repositories/platformApi";

vi.mock("../src/stores/platformSession", () => ({
  usePlatformSession: () => ({
    user: { role: "admin", name: "管理员" },
    restore: async () => {},
  }),
}));
vi.mock("../src/repositories/platformApi", () => ({ platformApi: vi.fn() }));
vi.mock("../src/features/data/PendingPageFields.vue", () => ({
  default: defineComponent({ render: () => null }),
}));
vi.mock("../src/features/data/RelationManager.vue", () => ({
  default: defineComponent({ render: () => null }),
}));

let app: ReturnType<typeof createApp> | undefined;
let router: ReturnType<typeof createRouter>;
const object = (id: string) => ({
  id,
  title: id === "orders" ? "订单数据" : "客户数据",
  revision: 2,
  latestVersion: 1,
  model: {
    version: 1,
    fields: [
      {
        id: `${id}_name`,
        name: `${id}共享名称`,
        kind: "text",
        required: false,
        children: [],
        settings: {},
      },
    ],
  },
});
async function settle() {
  for (let i = 0; i < 30; i++) await nextTick();
  await new Promise((resolve) => setTimeout(resolve, 0));
}
async function mount(path: string) {
  document.body.innerHTML = '<div id="mount"></div>';
  router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/applications/:applicationId?", component: DataWorkspaceView },
      { path: "/:pathMatch(.*)*", component: { render: () => null } },
    ],
  });
  await router.push(path);
  await router.isReady();
  app = createApp({ render: () => h(RouterView) });
  app.use(router);
  app.mount("#mount");
  await settle();
}
beforeEach(() => {
  document.body.innerHTML = '<div id="mount"></div>';
  vi.mocked(platformApi)
    .mockReset()
    .mockImplementation(async (path) => {
      if (path === "/applications")
        return [
          { id: "app", title: "业务应用" },
          { id: "other", title: "另一应用" },
        ];
      if (path.startsWith("/data-objects?applicationId="))
        return path.endsWith("=app")
          ? [object("orders"), object("customers")]
          : [];
      if (path.startsWith("/pages?")) return [];
      if (path === "/data-objects/orders/draft") return object("orders");
      if (path === "/data-objects/customers/draft") return object("customers");
      throw new Error(path);
    });
});
afterEach(() => {
  app?.unmount();
  document.body.innerHTML = "";
});
it("opens the exact shared object from a page link and retains that context after reload", async () => {
  await mount("/applications/app?tab=objects&object=orders");
  expect(document.body.textContent).toContain("orders共享名称");
  expect(document.body.textContent).not.toContain("customers共享名称");
  expect(
    document.querySelector(".data-resource-tabs .active")?.textContent?.trim(),
  ).toBe("数据管理");
  const savedPath = router.currentRoute.value.fullPath;
  app!.unmount();
  await mount(savedPath);
  expect(document.body.textContent).toContain("orders共享名称");
  expect(
    vi.mocked(platformApi).mock.calls.every((call) => call[1] === undefined),
  ).toBe(true);
});
it("object selection and browser back follow the address without carrying another object's fields", async () => {
  await mount("/applications/app?tab=objects&object=orders");
  [
    ...document.querySelectorAll<HTMLButtonElement>(
      ".data-object-grid aside button",
    ),
  ]
    .find((button) => button.textContent?.includes("客户数据"))!
    .click();
  await settle();
  expect(router.currentRoute.value.query.object).toBe("customers");
  expect(document.body.textContent).toContain("customers共享名称");
  router.back();
  await settle();
  expect(router.currentRoute.value.query.object).toBe("orders");
  expect(document.body.textContent).toContain("orders共享名称");
  expect(document.body.textContent).not.toContain("customers共享名称");
});
it("an object from another application is rejected before fetching its draft", async () => {
  await mount("/applications/other?tab=objects&object=orders");
  expect(document.body.textContent).toContain("此数据对象不属于当前应用");
  expect(
    vi
      .mocked(platformApi)
      .mock.calls.some((call) => call[0] === "/data-objects/orders/draft"),
  ).toBe(false);
  expect(document.body.textContent).not.toContain("orders共享名称");
});
it("a late object response never replaces the newly selected resource", async () => {
  const implementation = vi.mocked(platformApi).getMockImplementation()!;
  let resolve!: (value: any) => void;
  vi.mocked(platformApi).mockImplementation((path) =>
    path === "/data-objects/orders/draft"
      ? new Promise((done) => {
          resolve = done;
        })
      : implementation(path),
  );
  await mount("/applications/app?tab=objects&object=orders");
  await router.push("/applications/app?tab=objects&object=customers");
  await settle();
  resolve(object("orders"));
  await settle();
  expect(document.body.textContent).toContain("customers共享名称");
  expect(document.body.textContent).not.toContain("orders共享名称");
});
it("a failed read can retry the same resource without losing its route or issuing writes", async () => {
  vi.mocked(platformApi).mockRejectedValueOnce(new Error("暂时无法读取"));
  await mount("/applications/app?tab=objects&object=orders");
  expect(document.querySelector('[role="alert"]')?.textContent).toContain(
    "暂时无法读取",
  );
  [...document.querySelectorAll<HTMLButtonElement>("button")]
    .find((button) => button.textContent === "重试")!
    .click();
  await settle();
  expect(document.body.textContent).toContain("orders共享名称");
  expect(router.currentRoute.value.query.object).toBe("orders");
  expect(
    vi.mocked(platformApi).mock.calls.every((call) => call[1] === undefined),
  ).toBe(true);
});
it("changing resource tabs rereads published fields while keeping object selection in the address", async () => {
  await mount("/applications/app?tab=objects&object=orders");
  const implementation = vi.mocked(platformApi).getMockImplementation()!;
  vi.mocked(platformApi).mockImplementation((path) =>
    path === "/data-objects/orders/draft"
      ? Promise.resolve({
          ...object("orders"),
          title: "已更新的共享数据",
          latestVersion: 2,
        })
      : implementation(path),
  );
  [
    ...document.querySelectorAll<HTMLButtonElement>(
      ".data-resource-tabs button",
    ),
  ]
    .find((button) => button.textContent?.trim() === "表单页面")!
    .click();
  await settle();
  [
    ...document.querySelectorAll<HTMLButtonElement>(
      ".data-resource-tabs button",
    ),
  ]
    .find((button) => button.textContent?.trim() === "数据管理")!
    .click();
  await settle();
  expect(document.body.textContent).toContain("已更新的共享数据");
  expect(router.currentRoute.value.query.object).toBe("orders");
  expect(
    vi.mocked(platformApi).mock.calls.every((call) => call[1] === undefined),
  ).toBe(true);
});
