// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApp, h, nextTick } from "vue";
import { createPinia } from "pinia";
import { createMemoryHistory, createRouter, RouterView } from "vue-router";
import PageDesignerView from "../src/features/data/PageDesignerView.vue";
import { platformApi, PlatformError } from "../src/repositories/platformApi";
const designer = vi.hoisted(() => ({
  data: null,
  busy: false,
  error: "",
  load: vi.fn(),
}));
vi.mock("../src/stores/pageDesigner", () => ({
  usePageDesignerStore: () => designer,
}));
vi.mock("../src/repositories/platformApi", async (original) => ({
  ...(await original<typeof import("../src/repositories/platformApi")>()),
  platformApi: vi.fn(),
}));
let app: ReturnType<typeof createApp> | undefined;
const settle = async () => {
  for (let i = 0; i < 30; i++) await nextTick();
};
beforeEach(() => {
  designer.load.mockReset();
  let signedIn = false;
  vi.mocked(platformApi)
    .mockReset()
    .mockImplementation(async (path) => {
      const user = {
        id: "admin",
        username: "admin",
        role: "admin",
        name: "管理员",
      };
      if (path === "/auth/login") {
        signedIn = true;
        return user;
      }
      if (path === "/auth/me") {
        if (!signedIn) throw new PlatformError("请先登录", 401);
        return user;
      }
      if (path === "/applications") return [{ id: "app", title: "登录后应用" }];
      if (
        path.startsWith("/pages?") ||
        path.startsWith("/data-objects?") ||
        path.startsWith("/processes?") ||
        path.startsWith("/process-templates?")
      )
        return [];
      throw new Error(path);
    });
  document.body.innerHTML = '<div id="app"></div>';
});
afterEach(() => {
  app?.unmount();
  document.body.innerHTML = "";
  localStorage.clear();
  sessionStorage.clear();
});

for (const target of ["designer"] as const)
  it(`${target} loads its authorized content after the real session store changes identity during login`, async () => {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: "/", component: { template: "<div />" } },
        {
          path: "/admin/organization",
          component: { template: "<div>原通讯录</div>" },
        },
        {
          path: "/applications/:applicationId/pages/:pageId/design",
          component: PageDesignerView,
        },
      ],
    });
    await router.push(
      "/applications/app/pages/page/design",
    );
    await router.isReady();
    app = createApp({ render: () => h(RouterView) });
    app.use(createPinia());
    app.use(router);
    app.mount("#app");
    await settle();
    for (const [selector, value] of [
      ["[autocomplete=username]", "admin"],
      ["[type=password]", "Synthetic-login-password!"],
    ]) {
      const input = document.querySelector<HTMLInputElement>(selector!)!;
      input.value = value!;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
    await settle();
    document
      .querySelector("form.platform-login")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settle();
    expect(designer.load).toHaveBeenCalledWith("page");
    expect(
      document.querySelector<HTMLInputElement>("[type=password]")?.value || "",
    ).toBe("");
  });
